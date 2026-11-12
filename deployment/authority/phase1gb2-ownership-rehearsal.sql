-- Synthetic DB-source lab ONLY, installed after canonical/import/catalog in CI.
BEGIN;
DO $guard$ BEGIN
  IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated authority database required'; END IF;
END $guard$;
CREATE ROLE ppo_rehearsal_controller NOLOGIN;
CREATE ROLE ppo_rehearsal_source NOLOGIN;
CREATE ROLE ppo_rehearsal_target NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target;
SET LOCAL ROLE ppo_authority_owner;
CREATE TABLE ppo_authority.rehearsal_owner (
  singleton boolean PRIMARY KEY CHECK(singleton),
  target_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  source_id uuid UNIQUE,
  generation bigint NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 1000000000),
  phase text NOT NULL DEFAULT 'empty' CHECK(phase IN ('empty','source','held','target','aborted')),
  source_key uuid, target_key uuid, fence uuid, attempt uuid, manifest text,
  imported boolean NOT NULL DEFAULT false,
  CHECK(manifest IS NULL OR manifest ~ '^[a-f0-9]{64}$'),
  CHECK(source_id IS NULL OR source_id<>target_id),
  CHECK((phase='empty')=(source_id IS NULL)),
  CHECK((fence IS NULL)=(attempt IS NULL)),
  CHECK(phase NOT IN ('empty','source') OR NOT imported),
  CHECK(phase<>'target' OR imported),
  CHECK((phase IN ('source','aborted'))=(source_key IS NOT NULL)),
  CHECK((phase='target')=(target_key IS NOT NULL)),
  CHECK((phase IN ('held','target','aborted'))=(fence IS NOT NULL AND attempt IS NOT NULL))
);
INSERT INTO ppo_authority.rehearsal_owner(singleton) VALUES(true);
CREATE TABLE ppo_authority.rehearsal_source_files (
  path text PRIMARY KEY CHECK(
    (length(path)=56 AND path ~ '^records/[A-Za-z0-9_-]{43}\.json$') OR
    (length(path)=64 AND path ~ '^versions/[A-Za-z0-9_-]{43}/[0-9]{6}\.json$')),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 131072),
  normalized text NOT NULL CHECK(octet_length(normalized) BETWEEN 1 AND 131072),
  CHECK(convert_from(bytes,'UTF8')::jsonb=normalized::jsonb)
);
CREATE FUNCTION ppo_authority.rehearsal_immutable_marker() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$ BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'source history is append-only'; END IF;
  IF OLD.path LIKE 'versions/%' THEN RAISE EXCEPTION 'source history is append-only'; END IF;
  RETURN NEW;
END $b$;
CREATE TRIGGER immutable_source_markers BEFORE UPDATE OR DELETE ON ppo_authority.rehearsal_source_files
FOR EACH ROW EXECUTE FUNCTION ppo_authority.rehearsal_immutable_marker();
CREATE TRIGGER immutable_source_truncate BEFORE TRUNCATE ON ppo_authority.rehearsal_source_files
FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.rehearsal_immutable_marker();
CREATE TABLE ppo_authority.rehearsal_receipts (
  operation_id uuid PRIMARY KEY, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK(octet_length(evidence::text)<=4096),
  CHECK(evidence->>'operationId' IS NOT DISTINCT FROM operation_id::text),
  CHECK(evidence->>'requestHash' IS NOT DISTINCT FROM request_hash)
);
CREATE TRIGGER immutable_rehearsal_receipts BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.rehearsal_receipts
FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE FUNCTION ppo_authority.rehearsal_source_digest() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $b$
 SELECT encode(sha256(convert_to('['||string_agg(
  '{"pathHash":"'||encode(sha256(convert_to(path,'UTF8')),'hex')||'","sha256":"'||encode(sha256(bytes),'hex')||'","byteLength":'||octet_length(bytes)||'}',
  ',' ORDER BY encode(sha256(convert_to(path,'UTF8')),'hex') COLLATE "C",encode(sha256(bytes),'hex') COLLATE "C",octet_length(bytes))||']','UTF8')),'hex')
 FROM ppo_authority.rehearsal_source_files
$b$;
CREATE FUNCTION ppo_authority.rehearsal_parity() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $b$
 SELECT EXISTS(SELECT 1 FROM ppo_authority.synthetic_import_batch b JOIN ppo_authority.rehearsal_owner o ON b.inventory_hash=o.manifest)
 AND NOT EXISTS(
  SELECT 1 FROM ppo_authority.rehearsal_source_files s FULL JOIN ppo_authority.synthetic_import_files a USING(path)
  WHERE s.path IS NULL OR a.path IS NULL OR s.bytes IS DISTINCT FROM a.bytes)
 AND NOT EXISTS(
  SELECT 1 FROM (SELECT split_part(path,'/',2) AS run_id,split_part(split_part(path,'/',3),'.',1)::integer AS version,convert_from(bytes,'UTF8')::jsonb AS record
    FROM ppo_authority.rehearsal_source_files WHERE path LIKE 'versions/%') s
  FULL JOIN ppo_authority.run_versions v USING(run_id,version)
  WHERE s.run_id IS NULL OR v.run_id IS NULL OR s.record IS DISTINCT FROM v.record)
 AND NOT EXISTS(
  SELECT 1 FROM (SELECT substring(path from 9 for 43) AS run_id,convert_from(bytes,'UTF8')::jsonb AS record
    FROM ppo_authority.rehearsal_source_files WHERE path LIKE 'records/%') s
  FULL JOIN ppo_authority.current_runs v USING(run_id)
  WHERE s.run_id IS NULL OR v.run_id IS NULL OR s.record IS DISTINCT FROM v.record)
$b$;
-- One mutation domain: wrappers acquire the existing canonical gate BEFORE
-- inspecting ownership/capability or mutating source/target/receipts.
CREATE FUNCTION ppo_authority.rehearsal_apply(p_request text,p_channel text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE
 r jsonb; o ppo_authority.rehearsal_owner%ROWTYPE; old_revision bigint; op uuid; h text;
 action text; accepted boolean:=true; item jsonb; raw bytea; norm text; candidate jsonb;
 prior jsonb; id text; expected integer; active_count integer; projects integer; evidence jsonb;
BEGIN
 IF p_request IS NULL OR octet_length(p_request)>12*1024*1024 THEN RETURN '{"accepted":false}'; END IF;
 r:=p_request::jsonb; action:=r->>'action'; op:=(r->>'operationId')::uuid;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR op IS NULL OR action IS NULL OR p_channel IS NULL OR
    (p_channel='control' AND action NOT IN ('seed','freeze','import','activate','abort')) OR
    (p_channel='source' AND action<>'source_commit') OR (p_channel='target' AND action<>'target_commit') OR
    p_channel NOT IN ('control','source','target') THEN RETURN '{"accepted":false}'; END IF;
 h:=encode(sha256(convert_to(p_request,'UTF8')),'hex');
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton RETURNING revision-1 INTO old_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'authority gate missing'; END IF;
 SELECT * INTO STRICT o FROM ppo_authority.rehearsal_owner WHERE singleton;
 IF EXISTS(SELECT 1 FROM ppo_authority.rehearsal_receipts WHERE operation_id=op) OR
   (SELECT count(*) FROM ppo_authority.rehearsal_receipts)>=1000 OR
   (action<>'abort' AND (SELECT count(*) FROM ppo_authority.rehearsal_receipts)>=999) THEN RETURN '{"accepted":false}'; END IF;
 IF action='seed' THEN
  IF o.phase<>'empty' OR (r->>'generation')::bigint IS DISTINCT FROM o.generation OR (r->>'targetId')::uuid IS DISTINCT FROM o.target_id OR (r->>'revision')::bigint IS DISTINCT FROM old_revision OR EXISTS(SELECT 1 FROM ppo_authority.run_versions) OR
     jsonb_typeof(r->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'files') NOT BETWEEN 1 AND 2100 THEN RETURN '{"accepted":false}'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(r->'files') LOOP
   raw:=decode(item->>'bytesBase64','base64'); norm:=convert_from(decode(item->>'normalizedBase64','base64'),'UTF8');
   IF replace(encode(raw,'base64'),chr(10),'') IS DISTINCT FROM item->>'bytesBase64' THEN RAISE EXCEPTION 'noncanonical source bytes'; END IF;
   INSERT INTO ppo_authority.rehearsal_source_files VALUES(item->>'path',raw,norm);
  END LOOP;
  IF (SELECT count(*) FROM ppo_authority.rehearsal_source_files WHERE path LIKE 'records/%') NOT BETWEEN 1 AND 20 OR
    (SELECT sum(octet_length(bytes)) FROM ppo_authority.rehearsal_source_files)>4*1024*1024 OR
    (SELECT sum(octet_length(normalized)) FROM ppo_authority.rehearsal_source_files)>4*1024*1024 OR
    ppo_authority.rehearsal_source_digest() IS DISTINCT FROM r->>'manifest' THEN RAISE EXCEPTION 'source manifest or bound mismatch'; END IF;
  UPDATE ppo_authority.rehearsal_owner SET source_id=gen_random_uuid(),source_key=gen_random_uuid(),phase='source',manifest=r->>'manifest' WHERE singleton;
 ELSE
  IF (r->>'sourceId')::uuid IS DISTINCT FROM o.source_id OR (r->>'targetId')::uuid IS DISTINCT FROM o.target_id OR
    (r->>'generation')::bigint IS DISTINCT FROM o.generation OR r->>'manifest' IS DISTINCT FROM o.manifest THEN RETURN '{"accepted":false}'; END IF;
  IF action='source_commit' THEN
   IF o.phase NOT IN ('source','aborted') OR (r->>'key')::uuid IS DISTINCT FROM o.source_key THEN RETURN '{"accepted":false}'; END IF;
   id:=r->>'runId'; expected:=(r->>'expectedVersion')::integer; norm:=r->>'serialized'; candidate:=norm::jsonb;
   SELECT normalized::jsonb INTO prior FROM ppo_authority.rehearsal_source_files WHERE path='records/'||id||'.json';
   IF expected IS NULL OR expected NOT BETWEEN -1 AND 98 OR norm IS NULL OR octet_length(norm)>131072 OR jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR
      octet_length(candidate::text)>8388608 OR candidate->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
      candidate->>'historyHash' IS NULL OR candidate->>'historyHash' !~ '^[a-f0-9]{64}$' OR
      candidate->>'status' IS NULL OR candidate->>'status' NOT IN ('created','planning_in_progress','planned','implementation_in_progress','implementation_ready','tests_in_progress','tests_failed','tests_passed','review_in_progress','review_changes_requested','review_passed','merge_ready','merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed') OR
      candidate->'project'->>'id' IS NULL OR candidate->'project'->>'id' NOT IN ('khlim-assist','ledgerpilot-ai','spy-market-agent','portfolio','rbl-content-engine','khlim-digital-ecosystem','kynexa','rivora','axiom-quantum') OR
      jsonb_typeof(candidate->'history') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'history')<>expected+2 OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'history') e WHERE e->>'project' IS DISTINCT FROM candidate->'project'->>'id' OR e->>'repo' IS DISTINCT FROM candidate->'project'->>'fullName') OR
      candidate->>'runId' IS DISTINCT FROM id OR
      candidate->'version' IS DISTINCT FROM to_jsonb(expected+1) OR
      coalesce(candidate->>'task','') NOT LIKE 'RIC-157 shared authority synthetic:%' OR
      candidate->'history'->(expected+1)->>'eventHash' IS DISTINCT FROM candidate->>'historyHash' OR
      candidate->'history'->(expected+1)->>'toStatus' IS DISTINCT FROM candidate->>'status' OR
      candidate->'history'->(expected+1)->'branch' IS DISTINCT FROM candidate->'branch' OR
      candidate->'history'->(expected+1)->'headSha' IS DISTINCT FROM candidate->'headSha' OR
      (expected=-1 AND (prior IS NOT NULL OR r->>'expectedHash' IS NOT NULL OR candidate->>'status'<>'created' OR candidate->'history'->0->'previousHistoryHash' IS DISTINCT FROM 'null'::jsonb)) OR
      (expected>=0 AND (prior IS NULL OR prior->'version' IS DISTINCT FROM to_jsonb(expected) OR prior->>'historyHash' IS DISTINCT FROM r->>'expectedHash' OR
        candidate->'history'->(expected+1)->>'previousHistoryHash' IS DISTINCT FROM prior->>'historyHash' OR
        ((candidate->'history')-(expected+1)) IS DISTINCT FROM prior->'history' OR candidate->'project' IS DISTINCT FROM prior->'project' OR
        candidate->'task' IS DISTINCT FROM prior->'task' OR candidate->'baseSha' IS DISTINCT FROM prior->'baseSha')) THEN accepted:=false;
   ELSE
    WITH prospective AS (
      SELECT normalized::jsonb AS record FROM ppo_authority.rehearsal_source_files WHERE path LIKE 'records/%' AND path<>'records/'||id||'.json'
      UNION ALL SELECT candidate
    ), active AS (SELECT record->'project'->>'id' AS project FROM prospective WHERE record->>'status' NOT IN
      ('merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed'))
    SELECT count(*),count(DISTINCT project) INTO active_count,projects FROM active;
    IF projects>2 OR projects<>active_count THEN accepted:=false;
    ELSE
     INSERT INTO ppo_authority.rehearsal_source_files VALUES('versions/'||id||'/'||lpad((expected+1)::text,6,'0')||'.json',convert_to(norm,'UTF8'),norm);
     INSERT INTO ppo_authority.rehearsal_source_files VALUES('records/'||id||'.json',convert_to(norm,'UTF8'),norm)
      ON CONFLICT(path) DO UPDATE SET bytes=EXCLUDED.bytes,normalized=EXCLUDED.normalized;
     IF (SELECT count(*) FROM ppo_authority.rehearsal_source_files)>2100 OR
       (SELECT count(*) FROM ppo_authority.rehearsal_source_files WHERE path LIKE 'records/%')>20 OR
       (SELECT sum(octet_length(bytes)) FROM ppo_authority.rehearsal_source_files)>4*1024*1024 OR
       (SELECT sum(octet_length(normalized)) FROM ppo_authority.rehearsal_source_files)>4*1024*1024 THEN RAISE EXCEPTION 'source bound'; END IF;
    END IF;
   END IF;
   UPDATE ppo_authority.rehearsal_owner SET source_key=gen_random_uuid(),manifest=ppo_authority.rehearsal_source_digest() WHERE singleton;
  ELSIF action='target_commit' THEN
   IF o.phase<>'target' OR (r->>'key')::uuid IS DISTINCT FROM o.target_key THEN RETURN '{"accepted":false}'; END IF;
   accepted:=ppo_authority.commit_run(r->>'runId',(r->>'expectedVersion')::integer,r->>'expectedHash',r->>'serialized');
   UPDATE ppo_authority.rehearsal_owner SET target_key=gen_random_uuid() WHERE singleton;
  ELSIF action='freeze' THEN
   IF o.phase<>'source' OR o.attempt IS NOT NULL OR (r->>'revision')::bigint IS DISTINCT FROM old_revision OR
     r->>'manifest' IS DISTINCT FROM ppo_authority.rehearsal_source_digest() THEN RETURN '{"accepted":false}'; END IF;
   UPDATE ppo_authority.rehearsal_owner SET phase='held',generation=generation+1,source_key=NULL,fence=gen_random_uuid(),attempt=op WHERE singleton;
  ELSE
   IF o.phase<>'held' OR (r->>'attempt')::uuid IS DISTINCT FROM o.attempt OR (r->>'fence')::uuid IS DISTINCT FROM o.fence OR
     r->>'manifest' IS DISTINCT FROM o.manifest OR o.manifest IS DISTINCT FROM ppo_authority.rehearsal_source_digest() OR
     (r->>'revision')::bigint IS DISTINCT FROM old_revision THEN RETURN '{"accepted":false}'; END IF;
   IF action='import' THEN
    IF o.imported THEN RETURN '{"accepted":false}'; END IF;
    SELECT jsonb_agg(jsonb_build_object('path',path,'bytesBase64',replace(encode(bytes,'base64'),chr(10),''),'normalizedBase64',replace(encode(convert_to(normalized,'UTF8'),'base64'),chr(10),'')) ORDER BY path COLLATE "C")::text INTO norm FROM ppo_authority.rehearsal_source_files;
    -- Separate SPI commands are intentional: a STABLE parity read in the
    -- same expression as the mutating import would see its pre-import snapshot.
    accepted:=ppo_authority.import_synthetic_snapshot(o.manifest,norm);
    IF accepted IS DISTINCT FROM true THEN RAISE EXCEPTION 'held import rejected'; END IF;
    IF ppo_authority.rehearsal_parity() IS DISTINCT FROM true THEN RAISE EXCEPTION 'held import parity rejected'; END IF;
    UPDATE ppo_authority.rehearsal_owner SET imported=true WHERE singleton;
   ELSIF action='activate' THEN
    IF NOT o.imported OR ppo_authority.rehearsal_parity() IS DISTINCT FROM true THEN RETURN '{"accepted":false}'; END IF;
    UPDATE ppo_authority.rehearsal_owner SET phase='target',generation=generation+1,target_key=gen_random_uuid() WHERE singleton;
   ELSIF action='abort' THEN
    IF EXISTS(SELECT 1 FROM ppo_authority.rehearsal_receipts AS activation WHERE activation.evidence->>'action'='activate' AND activation.evidence->'accepted'='true'::jsonb) THEN RETURN '{"accepted":false}'; END IF;
    -- The gate settles in-flight mutations; advancing generation fences even
    -- delayed requests that have not yet reached the gate. No target reset.
    UPDATE ppo_authority.rehearsal_owner SET phase='aborted',generation=generation+1,source_key=gen_random_uuid() WHERE singleton;
   END IF;
  END IF;
 END IF;
 SELECT * INTO STRICT o FROM ppo_authority.rehearsal_owner WHERE singleton;
 evidence:=jsonb_build_object('operationId',op,'requestHash',h,'action',action,'accepted',accepted,
  'sourceId',o.source_id,'targetId',o.target_id,'generation',o.generation::text,'phase',o.phase,'fence',o.fence,'attempt',o.attempt,
  'manifest',o.manifest,'imported',o.imported,'key',coalesce(o.source_key,o.target_key),
  'revision',(SELECT revision::text FROM ppo_authority.gate WHERE singleton));
 INSERT INTO ppo_authority.rehearsal_receipts VALUES(op,h,evidence);
 RETURN evidence;
END $b$;
CREATE FUNCTION ppo_authority.rehearsal_control(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT ppo_authority.rehearsal_apply(p_request,'control') $b$;
CREATE FUNCTION ppo_authority.rehearsal_source_commit(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT ppo_authority.rehearsal_apply(p_request,'source') $b$;
CREATE FUNCTION ppo_authority.rehearsal_target_commit(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT ppo_authority.rehearsal_apply(p_request,'target') $b$;
CREATE FUNCTION ppo_authority.rehearsal_observation(p_target boolean) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE files jsonb; owner jsonb;
BEGIN
 SELECT to_jsonb(o)-'source_key'-'target_key'-'singleton' INTO owner FROM ppo_authority.rehearsal_owner o WHERE singleton;
 IF owner IS NULL THEN RAISE EXCEPTION 'authority identity missing'; END IF;
 IF (SELECT count(*) FROM ppo_authority.rehearsal_source_files)>2100 OR
    (SELECT coalesce(sum(octet_length(bytes)),0) FROM ppo_authority.rehearsal_source_files)>4*1024*1024 THEN RAISE EXCEPTION 'source bound'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'bytesBase64',replace(encode(bytes,'base64'),chr(10),'')) ORDER BY path COLLATE "C"),'[]') INTO files FROM ppo_authority.rehearsal_source_files;
 IF p_target THEN
  RETURN jsonb_build_object('owner',owner||jsonb_build_object('generation',owner->>'generation'),'revision',(SELECT revision::text FROM ppo_authority.gate WHERE singleton),
   'files',files,'digest',ppo_authority.rehearsal_source_digest(),'catalog',ppo_authority.read_catalog_snapshot(),'parity',ppo_authority.rehearsal_parity());
 END IF;
 -- Abort/source resumption must not inspect or parse a quarantined target.
 -- This remains one bounded owner/source snapshot with all fence/revision pins.
 RETURN jsonb_build_object('owner',owner||jsonb_build_object('generation',owner->>'generation'),'revision',(SELECT revision::text FROM ppo_authority.gate WHERE singleton),
  'files',files,'digest',ppo_authority.rehearsal_source_digest(),'catalog',NULL,'parity',NULL);
END $b$;
CREATE FUNCTION ppo_authority.read_rehearsal() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT ppo_authority.rehearsal_observation(true) $b$;
CREATE FUNCTION ppo_authority.read_rehearsal_source() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT ppo_authority.rehearsal_observation(false) $b$;
CREATE FUNCTION ppo_authority.read_rehearsal_receipt(p_id uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE e jsonb; o ppo_authority.rehearsal_owner%ROWTYPE;
BEGIN
 SELECT evidence INTO e FROM ppo_authority.rehearsal_receipts WHERE operation_id=p_id AND request_hash=p_hash;
 IF e IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT o FROM ppo_authority.rehearsal_owner WHERE singleton;
 IF e->>'sourceId' IS DISTINCT FROM o.source_id::text OR e->>'targetId' IS DISTINCT FROM o.target_id::text OR
   e->>'generation' IS DISTINCT FROM o.generation::text OR e->>'phase' IS DISTINCT FROM o.phase OR
   e->>'key' IS DISTINCT FROM coalesce(o.source_key,o.target_key)::text OR e->>'fence' IS DISTINCT FROM o.fence::text OR
   e->>'attempt' IS DISTINCT FROM o.attempt::text OR e->>'manifest' IS DISTINCT FROM o.manifest OR e->'imported' IS DISTINCT FROM to_jsonb(o.imported) THEN RETURN NULL; END IF;
 RETURN e;
END $b$;
-- Installing this optional lab module makes the new boundary exclusive.
-- Old direct writers/importers cannot bypass ownership, before or after handoff.
REVOKE EXECUTE ON FUNCTION ppo_authority.commit_run(text,integer,text,text) FROM ppo_authority_writer;
REVOKE EXECUTE ON FUNCTION ppo_authority.import_synthetic_snapshot(text,text) FROM ppo_authority_importer;
REVOKE ALL ON ALL TABLES IN SCHEMA ppo_authority FROM ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target;
REVOKE ALL ON FUNCTION ppo_authority.rehearsal_apply(text,text),ppo_authority.rehearsal_source_digest(),ppo_authority.rehearsal_parity(),ppo_authority.rehearsal_immutable_marker(),ppo_authority.rehearsal_observation(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ppo_authority.rehearsal_control(text),ppo_authority.read_rehearsal_receipt(uuid,text) TO ppo_rehearsal_controller;
GRANT EXECUTE ON FUNCTION ppo_authority.rehearsal_source_commit(text) TO ppo_rehearsal_source;
GRANT EXECUTE ON FUNCTION ppo_authority.rehearsal_target_commit(text) TO ppo_rehearsal_target;
GRANT EXECUTE ON FUNCTION ppo_authority.read_rehearsal(),ppo_authority.read_rehearsal_source() TO ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target,ppo_authority_reader;
COMMIT;
