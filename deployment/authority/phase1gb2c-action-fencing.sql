-- B2c1: optional, synthetic-only, after canonical/import/catalog/ownership.
BEGIN;
DO $g$ BEGIN
 IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated database required'; END IF;
END $g$;
CREATE ROLE ppo_action_admin NOLOGIN;
CREATE ROLE ppo_action_verifier NOLOGIN;
CREATE ROLE ppo_action_consumer NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_action_admin,ppo_action_verifier,ppo_action_consumer;
SET LOCAL ROLE ppo_authority_owner;
CREATE TABLE ppo_authority.action_hosts(
 host_id text PRIMARY KEY CHECK(host_id ~ '^lab-[a-z0-9-]{1,59}$'),
 epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 1000000000),
 policy jsonb NOT NULL CHECK(octet_length(policy::text)<=4096)
);
CREATE TABLE ppo_authority.action_contexts(
 ticket uuid PRIMARY KEY, context jsonb NOT NULL CHECK(octet_length(context::text)<=32768),
 proof_hash text NOT NULL UNIQUE CHECK(proof_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE ppo_authority.action_revocations(
 kind text NOT NULL CHECK(kind IN ('request','claim')), digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(kind,digest)
);
CREATE TABLE ppo_authority.action_tombstones(
 host_id text NOT NULL, action_id text NOT NULL CHECK(action_id ~ '^[a-f0-9]{32}$'),
 operation_id uuid NOT NULL UNIQUE, ticket uuid NOT NULL UNIQUE REFERENCES ppo_authority.action_contexts,
 context_hash text NOT NULL, target_id uuid NOT NULL, generation bigint NOT NULL,
 host_epoch bigint NOT NULL, consumed_at timestamptz NOT NULL,
 not_before timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 transaction_id xid8 NOT NULL,
 PRIMARY KEY(host_id,action_id), CHECK(not_before<=consumed_at AND consumed_at<expires_at)
);
CREATE TRIGGER immutable_action_contexts BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.action_contexts FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_action_revocations BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.action_revocations FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_action_tombstones BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.action_tombstones FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
-- Host lifecycle changes and request/claim revocation use the SAME first lock
-- as canonical commits, imports, source/target commits and ownership changes.
CREATE FUNCTION ppo_authority.configure_action_host(p_id text,p_expected bigint,p_policy text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE p jsonb; old_epoch bigint;
BEGIN
 IF p_id IS NULL OR p_id !~ '^lab-[a-z0-9-]{1,59}$' OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 999999999
 OR p_policy IS NULL OR octet_length(p_policy)>4096 THEN RAISE EXCEPTION 'invalid synthetic policy'; END IF;
 p:=p_policy::jsonb;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('active','revoked')
 OR jsonb_typeof(p->'workerId') IS DISTINCT FROM 'string' OR p->>'workerId' NOT IN ('codex','antigravity')
 OR coalesce(p->>'keyFingerprint','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p->>'workerFingerprint','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p->>'coordinatorFingerprint','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p->>'claimHash','') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(p->'projects') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'projects') NOT BETWEEN 1 AND 9
 OR jsonb_typeof(p->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'capabilities') NOT BETWEEN 1 AND 2
 THEN RAISE EXCEPTION 'invalid synthetic policy'; END IF;
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT epoch INTO old_epoch FROM ppo_authority.action_hosts WHERE host_id=p_id;
 IF coalesce(old_epoch,0)<>p_expected THEN RAISE EXCEPTION 'host CAS conflict'; END IF;
 IF old_epoch IS NULL AND (SELECT count(*) FROM ppo_authority.action_hosts)>=20 THEN RAISE EXCEPTION 'host bound'; END IF;
 INSERT INTO ppo_authority.action_hosts VALUES(p_id,p_expected+1,p)
 ON CONFLICT(host_id) DO UPDATE SET epoch=excluded.epoch,policy=excluded.policy;
 RETURN p_expected+1;
END $b$;
CREATE FUNCTION ppo_authority.revoke_action_context(p_kind text,p_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 IF (SELECT count(*) FROM ppo_authority.action_revocations)>=2000 THEN RAISE EXCEPTION 'revocation bound'; END IF;
 INSERT INTO ppo_authority.action_revocations VALUES(p_kind,p_hash);
END $b$;
-- One snapshot, native text retained for exact digest certification by the
-- trusted semantic verifier. This table stores no canonical run mirror.
CREATE FUNCTION ppo_authority.read_action_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT jsonb_build_object('targetId',target_id::text,'sourceId',source_id::text,
 'generation',generation::text,'phase',phase,'catalogText',ppo_authority.read_catalog_snapshot()::text,
 'entriesText',(ppo_authority.read_catalog_snapshot()->'entries')::text)
 FROM ppo_authority.rehearsal_owner WHERE singleton
$b$;
-- Only the server-side verifier role can attest signatures/full JS history
-- semantics. Consumer cannot submit a digest/certificate or arbitrary fields.
CREATE FUNCTION ppo_authority.register_action_context(p_ticket uuid,p_context text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE c jsonb; snap jsonb; cat jsonb;
BEGIN
 IF p_context IS NULL OR octet_length(p_context)>32768 THEN RETURN false; END IF;
 c:=p_context::jsonb;
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 snap:=ppo_authority.read_action_snapshot(); cat:=(snap->>'catalogText')::jsonb;
 IF snap->>'phase' IS DISTINCT FROM 'target' OR snap->>'targetId' IS DISTINCT FROM c->>'targetId'
 OR snap->>'sourceId' IS DISTINCT FROM c->>'sourceId' OR snap->>'generation' IS DISTINCT FROM c->>'generation'
 OR cat->>'code' IS DISTINCT FROM 'ok'
 OR encode(sha256(convert_to((cat->'entries')::text,'UTF8')),'hex') IS DISTINCT FROM c->>'catalogDigest'
 OR (SELECT count(*) FROM ppo_authority.action_contexts)>=1000 THEN RETURN false; END IF;
 INSERT INTO ppo_authority.action_contexts VALUES(p_ticket,c,c->>'proofHash');
 RETURN true;
END $b$;
CREATE FUNCTION ppo_authority.action_bindings_valid(c jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $b$
DECLARE o ppo_authority.rehearsal_owner%ROWTYPE; h ppo_authority.action_hosts%ROWTYPE;
 r jsonb:=c->'request'; l jsonb:=c->'claim'; p jsonb:=c->'proof'; run jsonb; cat jsonb;
 projects integer; active_count integer;
BEGIN
 SELECT * INTO o FROM ppo_authority.rehearsal_owner WHERE singleton;
 SELECT * INTO h FROM ppo_authority.action_hosts WHERE host_id=p->>'hostId';
 IF o.phase IS DISTINCT FROM 'target' OR o.target_id::text IS DISTINCT FROM c->>'targetId'
 OR o.source_id::text IS DISTINCT FROM c->>'sourceId' OR o.generation::text IS DISTINCT FROM c->>'generation'
 OR h.policy->>'status' IS DISTINCT FROM 'active' OR h.epoch::text IS DISTINCT FROM p->>'hostEpoch'
 OR h.policy->>'workerId' IS DISTINCT FROM p->>'workerId'
 OR h.policy->>'keyFingerprint' IS DISTINCT FROM c->>'hostFingerprint'
 OR h.policy->>'workerFingerprint' IS DISTINCT FROM c->>'workerFingerprint'
 OR h.policy->>'coordinatorFingerprint' IS DISTINCT FROM c->>'coordinatorFingerprint'
 OR h.policy->>'claimHash' IS DISTINCT FROM c->>'claimHash'
 OR NOT coalesce(h.policy->'projects' @> jsonb_build_array(r->>'projectId'),false)
 OR NOT coalesce(h.policy->'capabilities' @> jsonb_build_array(r->>'capability'),false)
 OR p->>'workerId' IS DISTINCT FROM r->>'workerId' OR l->>'workerId' IS DISTINCT FROM r->>'workerId'
 OR r->>'workerId' IS DISTINCT FROM (CASE r->>'capability' WHEN 'implementation.backend' THEN 'codex' WHEN 'implementation.frontend' THEN 'antigravity' ELSE '' END)
 OR l->>'hostId' IS DISTINCT FROM p->>'hostId' OR l->>'requestId' IS DISTINCT FROM r->>'requestId'
 OR p->>'requestHash' IS DISTINCT FROM c->>'requestHash' OR l->>'requestHash' IS DISTINCT FROM c->>'requestHash'
 OR p->>'claimHash' IS DISTINCT FROM c->>'claimHash'
 OR p->>'runId' IS DISTINCT FROM r->>'runId' OR l->>'runId' IS DISTINCT FROM r->>'runId'
 OR p->'expectedVersion' IS DISTINCT FROM r->'expectedVersion' OR l->'expectedVersion' IS DISTINCT FROM r->'expectedVersion'
 OR p->>'actionType' NOT IN ('workspace.read','workspace.write','tests.local')
 OR coalesce(p->>'actionPath','') !~ '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,119}$'
 OR right(p->>'actionPath',2)='/.' OR p->>'actionPath' LIKE '%..%' OR p->>'actionPath' LIKE '%//%' OR p->>'actionPath' LIKE '%/./%'
 OR NOT coalesce(r->'scope'->'permits' @> jsonb_build_array(p->>'actionType'),false)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r->'scope'->'allowedPaths') a(path)
 WHERE p->>'actionPath'=path OR starts_with(p->>'actionPath',rtrim(path,'/')||'/'))
 OR EXISTS(SELECT 1 FROM ppo_authority.action_revocations WHERE (kind='request' AND digest=c->>'requestHash') OR (kind='claim' AND digest=c->>'claimHash'))
 THEN RETURN false; END IF;
 SELECT record INTO run FROM ppo_authority.current_runs WHERE run_id=r->>'runId';
 IF run IS NULL OR run->'version' IS DISTINCT FROM r->'expectedVersion' OR run->>'status' IS DISTINCT FROM 'implementation_in_progress'
 OR run->'project'->>'id' IS DISTINCT FROM r->>'projectId' OR run->'branch' IS DISTINCT FROM r->'branch'
 OR run->'baseSha' IS DISTINCT FROM r->'baseSha' OR run->'headSha' IS DISTINCT FROM r->'headSha' THEN RETURN false; END IF;
 cat:=ppo_authority.read_catalog_snapshot();
 IF cat->>'code' IS DISTINCT FROM 'ok' OR encode(sha256(convert_to((cat->'entries')::text,'UTF8')),'hex') IS DISTINCT FROM c->>'catalogDigest' THEN RETURN false; END IF;
 SELECT count(DISTINCT record->'project'->>'id'),count(*) INTO projects,active_count FROM ppo_authority.current_runs
 WHERE record->>'status' NOT IN ('merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed');
 RETURN projects<=2 AND projects=active_count; -- implementing target itself proves its active lane
END $b$;
CREATE FUNCTION ppo_authority.consume_action(p_ticket uuid,p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE c jsonb; n timestamptz; lo timestamptz; hi timestamptz;
BEGIN
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 n:=clock_timestamp(); -- after obtaining gate, never transaction_timestamp()
 SELECT context INTO c FROM ppo_authority.action_contexts WHERE ticket=p_ticket;
 IF c IS NULL OR NOT ppo_authority.action_bindings_valid(c) THEN RETURN jsonb_build_object('consumed',false); END IF;
 lo:=greatest((c->'request'->>'issuedAt')::timestamptz,(c->'claim'->>'claimedAt')::timestamptz,(c->'proof'->>'issuedAt')::timestamptz);
 hi:=least((c->'request'->>'expiresAt')::timestamptz,(c->'claim'->>'leaseExpiresAt')::timestamptz,(c->'proof'->>'expiresAt')::timestamptz);
 IF n<lo OR n>=hi OR (SELECT count(*) FROM ppo_authority.action_tombstones)>=1000 THEN RETURN jsonb_build_object('consumed',false); END IF;
 -- An INSERT-time predicate covers time spent validating, and a final clock
 -- check covers INSERT/constraint waits. Deferred check observes pre-COMMIT.
 INSERT INTO ppo_authority.action_tombstones
 SELECT c->'proof'->>'hostId',c->'proof'->>'actionId',p_operation,p_ticket,
 encode(sha256(convert_to(c::text,'UTF8')),'hex'),(c->>'targetId')::uuid,(c->>'generation')::bigint,
 (c->'proof'->>'hostEpoch')::bigint,clock_timestamp(),lo,hi,pg_current_xact_id()
 WHERE clock_timestamp()>=greatest(n,lo) AND clock_timestamp()<hi
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN jsonb_build_object('consumed',false); END IF;
 IF clock_timestamp()<n OR clock_timestamp()>=hi THEN RAISE EXCEPTION 'action expired'; END IF;
 RETURN jsonb_build_object('consumed',true,'operationId',p_operation::text,'ticket',p_ticket::text);
END $b$;
CREATE FUNCTION ppo_authority.action_commit_freshness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 IF NOT ppo_authority.action_bindings_valid((SELECT context FROM ppo_authority.action_contexts WHERE ticket=NEW.ticket)) THEN RAISE EXCEPTION 'action bindings changed before commit'; END IF;
 IF clock_timestamp()<NEW.consumed_at OR clock_timestamp()>=NEW.expires_at THEN RAISE EXCEPTION 'action expired before commit'; END IF;
 RETURN NEW;
END $b$;
CREATE CONSTRAINT TRIGGER action_precommit_freshness AFTER INSERT ON ppo_authority.action_tombstones
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ppo_authority.action_commit_freshness();
CREATE FUNCTION ppo_authority.check_action(p_ticket uuid,p_operation uuid,p_precommit boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE t ppo_authority.action_tombstones%ROWTYPE; n timestamptz; c jsonb; valid boolean;
BEGIN
 SELECT * INTO t FROM ppo_authority.action_tombstones WHERE ticket=p_ticket AND operation_id=p_operation;
 IF NOT FOUND THEN RETURN jsonb_build_object('consumed',false,'fresh',false); END IF;
 SELECT context INTO c FROM ppo_authority.action_contexts WHERE ticket=p_ticket;
 valid:=ppo_authority.action_bindings_valid(c);
 n:=clock_timestamp(); -- after potentially expensive complete catalog comparison
 RETURN jsonb_build_object('consumed',true,'ticket',p_ticket::text,'operationId',p_operation::text,
 'targetId',t.target_id::text,'generation',t.generation::text,'contextHash',t.context_hash,
 'observedMicros',(extract(epoch FROM n)*1000000)::bigint::text,
 'fresh', n>=t.consumed_at AND n<t.expires_at AND valid
 AND (NOT p_precommit OR t.transaction_id=pg_current_xact_id()));
END $b$;
REVOKE ALL ON ALL TABLES IN SCHEMA ppo_authority FROM ppo_action_admin,ppo_action_verifier,ppo_action_consumer;
REVOKE ALL ON FUNCTION ppo_authority.action_bindings_valid(jsonb),ppo_authority.action_commit_freshness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ppo_authority.configure_action_host(text,bigint,text),ppo_authority.revoke_action_context(text,text) TO ppo_action_admin;
GRANT EXECUTE ON FUNCTION ppo_authority.read_action_snapshot(),ppo_authority.register_action_context(uuid,text) TO ppo_action_verifier;
GRANT EXECUTE ON FUNCTION ppo_authority.consume_action(uuid,uuid),ppo_authority.check_action(uuid,uuid,boolean) TO ppo_action_consumer;
COMMIT;
