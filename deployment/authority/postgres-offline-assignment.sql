-- RIC-194 standalone disposable authority profile. Install after D1.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'ppo_authority_ci'
     OR to_regclass('ppo_authority.admission_identity') IS NULL
     OR to_regclass('ppo_authority.rehearsal_owner') IS NOT NULL
     OR to_regclass('ppo_authority.gateway_profile') IS NOT NULL
  THEN RAISE EXCEPTION 'standalone disposable D1 authority required'; END IF;
END
$guard$;

CREATE ROLE ppo_offline_assignment_binder NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_offline_assignment_binder;
SET LOCAL ROLE ppo_authority_owner;

-- Trusted lab bootstrap pins the coordinator before the first operation.
CREATE TABLE ppo_authority.offline_assignment_policy (
  singleton boolean PRIMARY KEY CHECK(singleton),
  coordinator_key_hash text NOT NULL CHECK(coordinator_key_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE ppo_authority.offline_assignment_reservations (
  run_id text NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version BETWEEN 3 AND 98),
  bound_version integer GENERATED ALWAYS AS (expected_version + 1) STORED,
  request_hash text NOT NULL UNIQUE CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL UNIQUE CHECK(request_id ~ '^[a-f0-9]{32}$'),
  nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[a-f0-9]{32}$'),
  idempotency_key text NOT NULL UNIQUE CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
  approval_id text NOT NULL UNIQUE CHECK(approval_id ~ '^[a-f0-9]{32}$'),
  candidate_hash text NOT NULL CHECK(candidate_hash ~ '^[a-f0-9]{64}$'),
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(run_id, expected_version),
  CHECK(reserved_at < expires_at),
  FOREIGN KEY(run_id, expected_version) REFERENCES ppo_authority.run_versions(run_id, version),
  FOREIGN KEY(run_id, bound_version) REFERENCES ppo_authority.run_versions(run_id, version)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER immutable_offline_assignment_policy BEFORE UPDATE OR DELETE OR TRUNCATE
  ON ppo_authority.offline_assignment_policy FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_offline_assignment_reservations BEFORE UPDATE OR DELETE OR TRUNCATE
  ON ppo_authority.offline_assignment_reservations FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();

CREATE FUNCTION ppo_authority.offline_assignment_authority_matches(p_authority uuid, p_key_hash text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $body$
  SELECT current_database() = 'ppo_authority_ci'
     AND to_regclass('ppo_authority.rehearsal_owner') IS NULL
     AND to_regclass('ppo_authority.gateway_profile') IS NULL
     AND EXISTS(SELECT 1 FROM ppo_authority.admission_identity WHERE singleton AND id = p_authority)
     AND EXISTS(SELECT 1 FROM ppo_authority.offline_assignment_policy WHERE singleton AND coordinator_key_hash = p_key_hash)
$body$;

-- A read-only optimization. The binder still enforces replay uniqueness in
-- its transaction because another transaction can reserve after this read.
CREATE FUNCTION ppo_authority.offline_assignment_replay_conflict(p_authority uuid, p_key_hash text, p_request text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER STRICT SET search_path = pg_catalog, pg_temp AS $body$
DECLARE request jsonb;
BEGIN
  IF NOT ppo_authority.offline_assignment_authority_matches(p_authority, p_key_hash)
     OR octet_length(p_request) > 8192
  THEN RAISE EXCEPTION 'offline assignment admission observation unavailable'; END IF;
  request := p_request::jsonb;
  RETURN EXISTS (
    SELECT 1 FROM ppo_authority.offline_assignment_reservations r
    WHERE (r.run_id = request->>'runId' AND r.expected_version::text = request->>'expectedVersion')
       OR r.request_id = request->>'requestId' OR r.nonce = request->>'nonce'
       OR r.idempotency_key = request->>'idempotencyKey' OR r.approval_id = request->'approval'->>'approvalId'
  );
END
$body$;

-- The D1 verifier can certify the binding candidate like any other proposed
-- canonical record. Publication of this reserved event requires its exact
-- reservation in the same transaction. Ordinary events retain existing D1.
CREATE FUNCTION ppo_authority.require_offline_assignment_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE event jsonb := NEW.record->'history'->NEW.version;
BEGIN
  IF event->>'actor' = 'postgres-offline-assignment-bind' THEN
    IF NOT EXISTS (
      SELECT 1 FROM ppo_authority.offline_assignment_reservations r
      WHERE r.run_id = NEW.run_id AND r.expected_version = NEW.version - 1
        AND r.candidate_hash = encode(sha256(convert_to(NEW.record::text, 'UTF8')), 'hex')
    ) THEN RAISE EXCEPTION 'offline assignment reservation required' USING ERRCODE = '42501'; END IF;
  ELSIF event->'evidence' @> '[{"source":"postgres-offline-assignment-bind"}]'::jsonb THEN
    RAISE EXCEPTION 'offline assignment event required' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER require_offline_assignment_reservation BEFORE INSERT
  ON ppo_authority.run_versions FOR EACH ROW EXECUTE FUNCTION ppo_authority.require_offline_assignment_reservation();

CREATE FUNCTION ppo_authority.offline_assignment_commit_freshness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE checked_at timestamptz := clock_timestamp();
BEGIN
  IF checked_at < NEW.reserved_at OR checked_at >= NEW.expires_at THEN
    RAISE EXCEPTION 'offline assignment expired before commit' USING ERRCODE = 'P1941';
  END IF;
  RETURN NEW;
END
$body$;
CREATE CONSTRAINT TRIGGER offline_assignment_precommit AFTER INSERT
  ON ppo_authority.offline_assignment_reservations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ppo_authority.offline_assignment_commit_freshness();

-- Only the trusted, fixed autocommit transport may assume the binder role.
-- The lab application authenticates the envelope and verifies owner approval
-- before its independent D1 verifier certifies the exact candidate.
CREATE FUNCTION ppo_authority.bind_offline_assignment(
  p_authority uuid, p_signer text, p_key_hash text, p_request text, p_scope text,
  p_expected_hash text, p_serialized text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STRICT SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  request jsonb;
  candidate jsonb;
  event jsonb;
  evidence jsonb;
  current ppo_authority.run_versions%ROWTYPE;
  id text;
  expected integer;
  request_hash text;
  scope_hash text;
  issued timestamptz;
  expires timestamptz;
  checked_at timestamptz;
BEGIN
  IF octet_length(p_request) > 8192 OR octet_length(p_scope) > 8192
     OR octet_length(p_serialized) > 131072 OR p_signer <> 'ppo-control-plane'
     OR p_expected_hash !~ '^[a-f0-9]{64}$'
  THEN RETURN false; END IF;
  request := p_request::jsonb;
  candidate := p_serialized::jsonb;
  id := request->>'runId';
  IF request->>'kind' IS DISTINCT FROM 'dispatch-request' OR request->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR id IS NULL OR id !~ '^[A-Za-z0-9_-]{43}$'
     OR jsonb_typeof(request->'expectedVersion') IS DISTINCT FROM 'number'
     OR coalesce(request->>'expectedVersion', '') !~ '^[0-9]{1,2}$'
     OR request->'scope' IS DISTINCT FROM p_scope::jsonb
     OR request->'scope'->>'mode' IS DISTINCT FROM 'implementation'
     OR NOT coalesce((request->>'capability', request->>'workerId') IN
          (('implementation.backend','codex'),('implementation.frontend','antigravity')), false)
  THEN RETURN false; END IF;
  expected := (request->>'expectedVersion')::integer;
  IF expected NOT BETWEEN 3 AND 98 THEN RETURN false; END IF;
  issued := (request->>'issuedAt')::timestamptz;
  expires := (request->>'expiresAt')::timestamptz;
  IF issued IS NULL OR expires IS NULL OR NOT isfinite(issued) OR NOT isfinite(expires)
     OR expires <= issued OR expires - issued > interval '15 minutes'
  THEN RETURN false; END IF;
  request_hash := encode(sha256(convert_to(p_request, 'UTF8')), 'hex');
  scope_hash := encode(sha256(convert_to(p_scope, 'UTF8')), 'hex');
  event := candidate->'history'->(expected + 1);
  evidence := event->'evidence'->0;

  -- Same lock order as D1 and canonical mutation. Recheck the current run
  -- after waiting, then use the real D1 wrapper and canonical CAS below.
  PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;
  IF NOT FOUND OR NOT ppo_authority.offline_assignment_authority_matches(p_authority, p_key_hash) THEN RETURN false; END IF;
  SELECT * INTO current FROM ppo_authority.current_runs WHERE run_id = id;
  IF NOT FOUND OR current.version <> expected OR current.history_hash <> p_expected_hash
     OR current.record->>'status' IS DISTINCT FROM 'implementation_in_progress'
     OR current.record->'project'->'id' IS DISTINCT FROM request->'projectId'
     OR current.record->'branch' IS DISTINCT FROM request->'branch'
     OR current.record->'baseSha' IS DISTINCT FROM request->'baseSha'
     OR current.record->'headSha' IS DISTINCT FROM request->'headSha'
     OR candidate->'branch' IS DISTINCT FROM current.record->'branch'
     OR candidate->'headSha' IS DISTINCT FROM current.record->'headSha'
     OR candidate->'status' IS DISTINCT FROM current.record->'status'
     OR candidate->'attempts' IS DISTINCT FROM current.record->'attempts'
     OR event->>'actor' IS DISTINCT FROM 'postgres-offline-assignment-bind'
     OR event->'evidence' IS DISTINCT FROM jsonb_build_array(evidence)
     OR evidence->>'kind' IS DISTINCT FROM 'planning'
     OR evidence->>'source' IS DISTINCT FROM 'postgres-offline-assignment-bind'
     OR evidence->'sha' IS DISTINCT FROM request->'headSha'
     OR evidence->'metadata' IS DISTINCT FROM jsonb_build_object(
       'requestHash', request_hash, 'scopeHash', scope_hash, 'signerId', p_signer,
       'coordinatorKeyHash', p_key_hash, 'ownerId', request->'approval'->>'ownerId',
       'approvalId', request->'approval'->>'approvalId',
       'issueRevisionHash', request->'taskSource'->>'revisionHash', 'reservedVersion', expected)
  THEN RETURN false; END IF;

  -- Purpose-separated attestation from the existing trusted verifier role.
  -- An ordinary D1 catalog certificate says nothing about signer or approval.
  IF NOT EXISTS (
    SELECT 1 FROM ppo_authority.admission_certificates WHERE token =
      encode(sha256(convert_to(concat_ws(':', 'ppo-offline-assignment-auth-v1',
        p_authority::text, p_signer, p_key_hash, request_hash, scope_hash,
        p_expected_hash, encode(sha256(convert_to(p_serialized, 'UTF8')), 'hex')), 'UTF8')), 'hex')
  ) THEN RETURN false; END IF;
  checked_at := clock_timestamp();
  IF checked_at < issued OR checked_at >= expires THEN RETURN false; END IF;
  BEGIN
    INSERT INTO ppo_authority.offline_assignment_reservations
      (run_id, expected_version, request_hash, request_id, nonce, idempotency_key, approval_id, candidate_hash, reserved_at, expires_at)
    VALUES (id, expected, request_hash, request->>'requestId', request->>'nonce',
      request->>'idempotencyKey', request->'approval'->>'approvalId',
      encode(sha256(convert_to(candidate::text, 'UTF8')), 'hex'), checked_at, expires)
    ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN false; END IF;
    IF ppo_authority.commit_run(id, expected, p_expected_hash, p_serialized) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'canonical admission denied' USING ERRCODE = 'P1940';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P1940' THEN
    -- Roll back the reservation, replay keys, and any tentative gate update.
    RETURN false;
  END;
  RETURN true;
END
$body$;

CREATE FUNCTION ppo_authority.read_offline_assignment(
  p_authority uuid, p_key_hash text, p_run_id text, p_version integer, p_request_hash text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER STRICT SET search_path = pg_catalog, pg_temp AS $body$
DECLARE result jsonb;
BEGIN
  IF NOT ppo_authority.offline_assignment_authority_matches(p_authority, p_key_hash)
     OR p_run_id !~ '^[A-Za-z0-9_-]{43}$' OR p_request_hash !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'offline assignment observation unavailable'; END IF;
  SELECT jsonb_build_object('version', v.version, 'historyHash', v.history_hash) INTO result
  FROM ppo_authority.offline_assignment_reservations r
  LEFT JOIN ppo_authority.run_versions v ON v.run_id = r.run_id AND v.version = r.bound_version
    AND r.candidate_hash = encode(sha256(convert_to(v.record::text, 'UTF8')), 'hex')
    AND v.record->'history'->v.version->>'actor' = 'postgres-offline-assignment-bind'
    AND v.record->'history'->v.version->'evidence'->0->'metadata'->>'requestHash' = r.request_hash
  WHERE r.run_id = p_run_id AND r.expected_version = p_version AND r.request_hash = p_request_hash;
  IF FOUND AND result->>'historyHash' IS NULL THEN
    RAISE EXCEPTION 'offline assignment observation inconsistent';
  END IF;
  RETURN result;
END
$body$;

REVOKE ALL ON FUNCTION ppo_authority.offline_assignment_authority_matches(uuid,text),
  ppo_authority.offline_assignment_replay_conflict(uuid,text,text),
  ppo_authority.require_offline_assignment_reservation(), ppo_authority.offline_assignment_commit_freshness(),
  ppo_authority.bind_offline_assignment(uuid,text,text,text,text,text,text),
  ppo_authority.read_offline_assignment(uuid,text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ppo_authority.bind_offline_assignment(uuid,text,text,text,text,text,text)
  TO ppo_offline_assignment_binder;
GRANT EXECUTE ON FUNCTION ppo_authority.read_offline_assignment(uuid,text,text,integer,text)
  TO ppo_authority_reader;
GRANT EXECUTE ON FUNCTION ppo_authority.offline_assignment_replay_conflict(uuid,text,text)
  TO ppo_authority_reader;
COMMIT;
