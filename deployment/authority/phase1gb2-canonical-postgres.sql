-- RIC-157: disposable PostgreSQL canonical-authority candidate.
-- Install only in the isolated CI database; no production migration.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'ppo_authority_ci' THEN
    RAISE EXCEPTION 'isolated authority database required';
  END IF;
END
$guard$;
CREATE ROLE ppo_authority_owner NOLOGIN;
CREATE ROLE ppo_authority_writer NOLOGIN;
CREATE ROLE ppo_authority_reader NOLOGIN;
CREATE SCHEMA ppo_authority AUTHORIZATION ppo_authority_owner;
REVOKE ALL ON SCHEMA ppo_authority FROM PUBLIC;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_authority_writer, ppo_authority_reader;
SET LOCAL ROLE ppo_authority_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- A changed singleton row serializes all canonical/admission writers. Merely
-- locking currently visible active rows cannot prevent phantom admissions.
CREATE TABLE ppo_authority.gate (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0)
);
INSERT INTO ppo_authority.gate VALUES (true, 0);
CREATE TABLE ppo_authority.run_versions (
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9_-]{43}$'),
  version integer NOT NULL CHECK (version BETWEEN 0 AND 99),
  history_hash text NOT NULL CHECK (history_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL,
  PRIMARY KEY (run_id, version),
  CHECK (jsonb_typeof(record) = 'object'),
  CHECK (record->>'runId' IS NOT DISTINCT FROM run_id),
  CHECK (record->'version' IS NOT DISTINCT FROM to_jsonb(version)),
  CHECK (record->>'historyHash' IS NOT DISTINCT FROM history_hash)
);
CREATE FUNCTION ppo_authority.refuse_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  RAISE EXCEPTION 'canonical history is append-only';
END
$body$;
CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE OR TRUNCATE
ON ppo_authority.run_versions FOR EACH STATEMENT
EXECUTE FUNCTION ppo_authority.refuse_history_mutation();

CREATE VIEW ppo_authority.current_runs AS
SELECT DISTINCT ON (run_id) run_id, version, history_hash, record
FROM ppo_authority.run_versions ORDER BY run_id, version DESC;

-- Fixed server operation. The trusted PPO writer validates the complete record
-- using the existing JS state-machine validator before invoking this function.
-- SQL additionally binds identity, immutable history prefix and expected hash.
-- It is not a substitute for that semantic validator or authenticated routing.
CREATE FUNCTION ppo_authority.commit_run(
  p_id text, p_expected integer, p_expected_hash text, p_serialized text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  prior ppo_authority.run_versions%ROWTYPE;
  p_record jsonb;
  v integer;
  h text;
  status text;
  project text;
  active_projects integer;
  active_count integer;
BEGIN
  -- Logical byte limit is on compact serialized input, not JSONB's expanded
  -- decimal/whitespace representation. Physical cap is independent.
  IF p_serialized IS NULL OR octet_length(p_serialized) > 131072 THEN RETURN false; END IF;
  p_record := p_serialized::jsonb;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9_-]{43}$'
     OR p_expected IS NULL OR p_expected NOT BETWEEN -1 AND 98
     OR p_record IS NULL OR jsonb_typeof(p_record) IS DISTINCT FROM 'object'
     OR octet_length(p_record::text) > 8388608
     OR p_record->>'runId' IS DISTINCT FROM p_id
     OR p_record->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR p_record->'version' IS DISTINCT FROM to_jsonb(p_expected + 1)
     OR coalesce(p_record->>'task','') NOT LIKE 'RIC-157 shared authority synthetic:%'
     OR jsonb_typeof(p_record->'history') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  v := p_expected + 1;
  h := p_record->>'historyHash';
  status := p_record->>'status';
  project := p_record->'project'->>'id';
  IF h IS NULL OR h !~ '^[a-f0-9]{64}$'
     OR project IS NULL OR project NOT IN ('khlim-assist','ledgerpilot-ai','spy-market-agent','portfolio','rbl-content-engine','khlim-digital-ecosystem','kynexa','rivora','axiom-quantum')
     OR status IS NULL OR status NOT IN ('created','planning_in_progress','planned','implementation_in_progress','implementation_ready','tests_in_progress','tests_failed','tests_passed','review_in_progress','review_changes_requested','review_passed','merge_ready','merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed')
     OR jsonb_array_length(p_record->'history') <> v+1
     OR p_record->'history'->v->>'eventHash' IS DISTINCT FROM h
     OR p_record->'history'->v->>'toStatus' IS DISTINCT FROM status
     OR p_record->'history'->v->'branch' IS DISTINCT FROM p_record->'branch'
     OR p_record->'history'->v->'headSha' IS DISTINCT FROM p_record->'headSha'
  THEN RETURN false; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_record->'history') AS event
    WHERE event->>'project' IS DISTINCT FROM project OR
          event->>'repo' IS DISTINCT FROM p_record->'project'->>'fullName')
  THEN RETURN false; END IF;

  -- Updating (not only locking) forces stale repeatable-read/serializable
  -- transactions to abort on a concurrent writer instead of using old lanes.
  UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'authority gate missing'; END IF;
  SELECT * INTO prior FROM ppo_authority.current_runs WHERE run_id=p_id;
  IF p_expected = -1 THEN
    IF FOUND OR p_expected_hash IS NOT NULL OR status <> 'created'
       OR p_record->'history'->0->'previousHistoryHash' IS DISTINCT FROM 'null'::jsonb
    THEN RETURN false; END IF;
  ELSE
    IF NOT FOUND OR prior.version IS DISTINCT FROM p_expected
       OR p_expected_hash IS NULL OR prior.history_hash IS DISTINCT FROM p_expected_hash
       OR p_record->'history'->v->>'previousHistoryHash' IS DISTINCT FROM prior.history_hash
       OR ((p_record->'history') - v) IS DISTINCT FROM prior.record->'history'
       OR p_record->'project' IS DISTINCT FROM prior.record->'project'
       OR p_record->'task' IS DISTINCT FROM prior.record->'task'
       OR p_record->'baseSha' IS DISTINCT FROM prior.record->'baseSha'
    THEN RETURN false; END IF;
  END IF;

  -- Evaluate prospective WIP membership from the authoritative full current
  -- set, not a paginated catalog. All mutations share the gate above.
  WITH prospective AS (
    SELECT record FROM ppo_authority.current_runs WHERE run_id <> p_id
    UNION ALL SELECT p_record
  ), active AS (
    SELECT record->'project'->>'id' AS project_id FROM prospective
    WHERE record->>'status' NOT IN ('merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed')
  )
  SELECT count(DISTINCT project_id), count(*) INTO active_projects, active_count FROM active;
  IF active_projects > 2 OR active_count <> active_projects THEN RETURN false; END IF;

  INSERT INTO ppo_authority.run_versions VALUES (p_id,v,h,p_record);
  RETURN true;
END
$body$;

CREATE FUNCTION ppo_authority.read_run(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
  SELECT record FROM ppo_authority.current_runs WHERE run_id=p_id
$body$;
CREATE FUNCTION ppo_authority.read_versions(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
  SELECT coalesce(jsonb_agg(record ORDER BY version),'[]'::jsonb)
  FROM ppo_authority.run_versions WHERE run_id=p_id
$body$;
REVOKE ALL ON ALL TABLES IN SCHEMA ppo_authority FROM PUBLIC, ppo_authority_writer, ppo_authority_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ppo_authority FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ppo_authority.commit_run(text,integer,text,text) TO ppo_authority_writer;
GRANT EXECUTE ON FUNCTION ppo_authority.read_run(text), ppo_authority.read_versions(text)
TO ppo_authority_writer, ppo_authority_reader;
COMMIT;
