-- Mandatory integrity profile for the isolated integrated authority. No routing.
BEGIN;
DO $g$ BEGIN IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated database required'; END IF; END $g$;
CREATE ROLE ppo_admission_verifier NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_admission_verifier;
SET LOCAL ROLE ppo_authority_owner;
CREATE TABLE ppo_authority.admission_identity(singleton boolean PRIMARY KEY CHECK(singleton),id uuid NOT NULL DEFAULT gen_random_uuid(),cert_count integer NOT NULL DEFAULT 0 CHECK(cert_count BETWEEN 0 AND 10000));
INSERT INTO ppo_authority.admission_identity(singleton) VALUES(true);
CREATE TABLE ppo_authority.admission_certificates(token text PRIMARY KEY CHECK(token ~ '^[a-f0-9]{64}$'));
CREATE TRIGGER immutable_admission_certificates BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.admission_certificates FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE FUNCTION ppo_authority.admission_entries(p_source boolean) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE e jsonb; runs bigint; versions bigint; bytes bigint;
BEGIN
 IF p_source THEN
  EXECUTE $q$SELECT count(*) FILTER(WHERE path LIKE 'records/%'),count(*) FILTER(WHERE path LIKE 'versions/%'),coalesce(sum(octet_length(normalized)),0) FROM ppo_authority.rehearsal_source_files$q$ INTO runs,versions,bytes;
  IF runs>20 OR versions>2000 OR bytes>33554432 THEN RETURN NULL; END IF;
  EXECUTE $q$SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'serialized',(normalized::jsonb)::text) ORDER BY path COLLATE "C"),'[]'::jsonb) FROM ppo_authority.rehearsal_source_files$q$ INTO e;
 ELSE
  SELECT count(*) INTO runs FROM (SELECT 1 FROM ppo_authority.current_runs LIMIT 21) x;
  SELECT count(*) INTO versions FROM (SELECT 1 FROM ppo_authority.run_versions LIMIT 2001) x;
  IF runs>20 OR versions>2000 THEN RETURN NULL; END IF;
  SELECT coalesce(sum(octet_length(to_json(record::text)::text)+128),0) INTO bytes FROM (SELECT record FROM ppo_authority.current_runs UNION ALL SELECT record FROM ppo_authority.run_versions) x;
  IF bytes>33554432 THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'serialized',record::text) ORDER BY path COLLATE "C"),'[]'::jsonb) INTO e FROM (
   SELECT 'records/'||run_id||'.json' path,record FROM ppo_authority.current_runs UNION ALL
   SELECT 'versions/'||run_id||'/'||lpad(version::text,6,'0')||'.json',record FROM ppo_authority.run_versions) r;
 END IF; RETURN e;
END $b$;
CREATE FUNCTION ppo_authority.admission_pack(e jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $b$
 SELECT jsonb_build_object('revision','0','code',CASE WHEN
 e IS NULL OR (SELECT count(*) FROM jsonb_array_elements(e) x WHERE x->>'path' LIKE 'records/%')>20 OR
 (SELECT count(*) FROM jsonb_array_elements(e) x WHERE x->>'path' LIKE 'versions/%')>2000 OR
 EXISTS(SELECT 1 FROM jsonb_array_elements(e) x WHERE x->>'path' LIKE 'versions/%' AND
 CASE WHEN split_part(x->>'path','/',3) ~ '^[0-9]{6}\.json$' THEN split_part(split_part(x->>'path','/',3),'.',1)::integer>99 ELSE true END) OR
 octet_length(e::text)+256>33554432 OR (SELECT coalesce(sum(octet_length(x->>'serialized')),0) FROM jsonb_array_elements(e) x)>33554432
 THEN 'catalog_truncated' ELSE 'ok' END,'entries',coalesce(e,'[]'))
$b$;
CREATE FUNCTION ppo_authority.prepare_admission(p_kind text,p_payload text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE r jsonb;c jsonb;prior jsonb;before_entries jsonb;after_entries jsonb;owner_binding jsonb;source boolean; id text;v integer;expected integer;h text; token text; native_revision text; item jsonb; norm text; n bigint:=0;
BEGIN
 IF p_kind NOT IN ('direct','source_commit','target_commit','seed','import','held_import') OR p_payload IS NULL OR octet_length(p_payload)>100663296 THEN RAISE EXCEPTION 'invalid admission'; END IF;
 r:=p_payload::jsonb;source:=p_kind IN ('source_commit','seed');before_entries:=ppo_authority.admission_entries(source);after_entries:=before_entries;
 IF p_kind IN ('direct','source_commit','target_commit') THEN
  c:=(r->>'serialized')::jsonb;id:=c->>'runId';v:=(c->>'version')::integer;expected:=(r->>'expectedVersion')::integer;h:=r->>'expectedHash';
  SELECT (x->>'serialized')::jsonb INTO prior FROM jsonb_array_elements(before_entries) x WHERE x->>'path'='records/'||id||'.json';
  -- Preserve known SQL CAS rejection without certifying a fictitious new state.
  IF (expected=-1 AND prior IS NULL) OR (prior->'version'=to_jsonb(expected) AND prior->>'historyHash'=h) THEN
   SELECT coalesce(jsonb_agg(x),'[]') INTO after_entries FROM jsonb_array_elements(before_entries) x WHERE x->>'path' NOT IN ('records/'||id||'.json','versions/'||id||'/'||lpad(v::text,6,'0')||'.json');
   after_entries:=after_entries||jsonb_build_array(jsonb_build_object('path','records/'||id||'.json','serialized',c::text),jsonb_build_object('path','versions/'||id||'/'||lpad(v::text,6,'0')||'.json','serialized',c::text));
  END IF;
 ELSIF p_kind='held_import' THEN after_entries:=ppo_authority.admission_entries(true);
 ELSE
  after_entries:='[]';
  IF jsonb_typeof(r->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'files')>2020 THEN after_entries:=NULL;
  ELSE FOR item IN SELECT value FROM jsonb_array_elements(r->'files') LOOP
   norm:=convert_from(decode(item->>'normalizedBase64','base64'),'UTF8');
   IF octet_length(norm)>131072 THEN after_entries:=NULL;EXIT; END IF;
   norm:=(norm::jsonb)::text;n:=n+octet_length(to_json(norm)::text)+length(item->>'path')+128;
   IF octet_length(norm)>8388608 OR n>33554432 THEN after_entries:=NULL;EXIT; END IF;
   after_entries:=after_entries||jsonb_build_array(jsonb_build_object('path',item->>'path','serialized',norm));
  END LOOP; END IF;
 END IF;
 IF after_entries IS NOT NULL THEN SELECT coalesce(jsonb_agg(x ORDER BY x->>'path' COLLATE "C"),'[]') INTO after_entries FROM jsonb_array_elements(after_entries) x; END IF;
 IF to_regclass('ppo_authority.rehearsal_owner') IS NOT NULL THEN EXECUTE 'SELECT to_jsonb(o)-''source_key''-''target_key'' FROM ppo_authority.rehearsal_owner o' INTO owner_binding; END IF;
 SELECT revision::text INTO STRICT native_revision FROM ppo_authority.gate WHERE singleton;
 token:=encode(sha256(convert_to(jsonb_build_array(native_revision,(SELECT i.id FROM ppo_authority.admission_identity i),p_kind,r,before_entries,after_entries,owner_binding)::text,'UTF8')),'hex');
 RETURN jsonb_build_object('before',ppo_authority.admission_pack(before_entries)||jsonb_build_object('revision',native_revision),'after',ppo_authority.admission_pack(after_entries)||jsonb_build_object('revision',native_revision),'token',token);
END $b$;
CREATE FUNCTION ppo_authority.certify_admission(p_token text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM ppo_authority.admission_certificates WHERE token=p_token) THEN RETURN true; END IF;
 UPDATE ppo_authority.admission_identity SET cert_count=cert_count+1 WHERE singleton AND cert_count<10000;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO ppo_authority.admission_certificates VALUES(p_token) ON CONFLICT DO NOTHING;RETURN true;
END $b$;
CREATE FUNCTION ppo_authority.require_admission(p_kind text,p_payload text) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$
DECLARE p jsonb;
BEGIN
 p:=ppo_authority.prepare_admission(p_kind,p_payload);
 IF p->'before'->>'code' IS DISTINCT FROM 'ok' OR p->'after'->>'code' IS DISTINCT FROM 'ok' OR NOT EXISTS(SELECT 1 FROM ppo_authority.admission_certificates WHERE token=p->>'token') THEN RETURN false; END IF;
 RETURN true;
END $b$;
ALTER FUNCTION ppo_authority.commit_run(text,integer,text,text) RENAME TO admission_commit_core;
ALTER FUNCTION ppo_authority.import_synthetic_snapshot(text,text) RENAME TO admission_import_core;

-- Fixed private batch implementations retain CAS/archive/history/permit rules.
DO $m$ DECLARE f text; BEGIN
 SELECT pg_get_functiondef('ppo_authority.admission_import_core(text,text)'::regprocedure) INTO f;
 EXECUTE replace(f,'ppo_authority.commit_run(','ppo_authority.admission_commit_core(');
END $m$;
CREATE FUNCTION ppo_authority.commit_run(p_id text,p_expected integer,p_hash text,p_serialized text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 IF NOT ppo_authority.require_admission('direct',jsonb_build_object('serialized',p_serialized,'expectedVersion',p_expected,'expectedHash',p_hash)::text) THEN RETURN false; END IF;
 RETURN ppo_authority.admission_commit_core(p_id,p_expected,p_hash,p_serialized);
END $b$;
CREATE FUNCTION ppo_authority.import_synthetic_snapshot(p_hash text,p_files text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 IF NOT ppo_authority.require_admission('import',jsonb_build_object('inventoryHash',p_hash,'files',p_files::jsonb)::text) THEN RETURN false; END IF;
 RETURN ppo_authority.admission_import_core(p_hash,p_files);
END $b$;
REVOKE ALL ON FUNCTION ppo_authority.admission_commit_core(text,integer,text,text),ppo_authority.admission_import_core(text,text) FROM PUBLIC,ppo_authority_writer,ppo_authority_importer;
GRANT EXECUTE ON FUNCTION ppo_authority.prepare_admission(text,text) TO ppo_authority_reader,ppo_authority_writer,ppo_authority_importer;
GRANT EXECUTE ON FUNCTION ppo_authority.certify_admission(text) TO ppo_admission_verifier;
DO $grant$ BEGIN
 IF to_regclass('ppo_authority.rehearsal_owner') IS NULL THEN
  GRANT EXECUTE ON FUNCTION ppo_authority.commit_run(text,integer,text,text) TO ppo_authority_writer;
  GRANT EXECUTE ON FUNCTION ppo_authority.import_synthetic_snapshot(text,text) TO ppo_authority_importer;
 END IF;
END $grant$;
COMMIT;
