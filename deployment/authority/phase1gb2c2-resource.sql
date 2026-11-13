-- Optional disposable single-database synthetic resource only.
BEGIN;
DO $g$ BEGIN IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated database required'; END IF; END $g$;
CREATE ROLE ppo_resource_verifier NOLOGIN;
CREATE ROLE ppo_resource_consumer NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_resource_verifier,ppo_resource_consumer;
SET LOCAL ROLE ppo_authority_owner;
CREATE TABLE ppo_authority.resource_versions(resource_id uuid NOT NULL,version integer NOT NULL CHECK(version BETWEEN 0 AND 999),project text NOT NULL,path text NOT NULL CHECK(path='src/synthetic.mjs'),ref text NOT NULL,value text NOT NULL CHECK(octet_length(value)<=4096),PRIMARY KEY(resource_id,version),CHECK(ref=encode(sha256(convert_to(value,'UTF8')),'hex')));
CREATE VIEW ppo_authority.current_resource AS SELECT DISTINCT ON(resource_id) * FROM ppo_authority.resource_versions ORDER BY resource_id,version DESC;
CREATE TABLE ppo_authority.resource_operations(operation_id uuid PRIMARY KEY,ticket uuid NOT NULL REFERENCES ppo_authority.action_contexts,descriptor jsonb NOT NULL,payload text NOT NULL CHECK(octet_length(payload)<=4096),descriptor_hash text NOT NULL UNIQUE);
CREATE TABLE ppo_authority.resource_receipts(operation_id uuid PRIMARY KEY REFERENCES ppo_authority.resource_operations,ticket uuid NOT NULL UNIQUE,before_state jsonb NOT NULL,after_state jsonb NOT NULL,descriptor_hash text NOT NULL);
CREATE UNIQUE INDEX resource_effect_once ON ppo_authority.resource_receipts((after_state->>'resource_id'),(after_state->>'version'));
CREATE TRIGGER immutable_resource_versions BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.resource_versions FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_resource_operations BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.resource_operations FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_resource_receipts BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.resource_receipts FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE FUNCTION ppo_authority.initialize_resource() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE id uuid:=gen_random_uuid(); project_id text;
BEGIN
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 IF EXISTS(SELECT 1 FROM ppo_authority.resource_versions) THEN RAISE EXCEPTION 'already initialized'; END IF;
 SELECT record->'project'->>'id' INTO STRICT project_id FROM ppo_authority.current_runs WHERE record->>'status'='implementation_in_progress';
 INSERT INTO ppo_authority.resource_versions VALUES(id,0,project_id,'src/synthetic.mjs',encode(sha256(''::bytea),'hex'),''); RETURN id;
END $b$;
CREATE FUNCTION ppo_authority.read_resource_context(p_ticket uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT jsonb_build_object('context',context,'contextHash',encode(sha256(convert_to(context::text,'UTF8')),'hex'),'resource',to_jsonb(r)) FROM ppo_authority.action_contexts c CROSS JOIN ppo_authority.current_resource r WHERE ticket=p_ticket
$b$;
CREATE FUNCTION ppo_authority.resource_bindings_valid(d jsonb,c jsonb,r jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $b$
 SELECT coalesce(d->>'sourceId'=c->>'sourceId' AND d->>'targetId'=c->>'targetId' AND d->>'generation'=c->>'generation'
 AND d->>'contextHash'=encode(sha256(convert_to(c::text,'UTF8')),'hex')
 AND d->>'ticketHash'=encode(sha256(convert_to(d->>'ticket','UTF8')),'hex')
 AND d->>'hostId'=c->'proof'->>'hostId' AND d->>'hostFingerprint'=c->>'hostFingerprint' AND d->'hostEpoch'=c->'proof'->'hostEpoch'
 AND d->>'workerId'=c->'request'->>'workerId' AND d->>'capability'=c->'request'->>'capability'
 AND d->>'requestHash'=c->>'requestHash' AND d->>'claimHash'=c->>'claimHash' AND d->>'proofHash'=c->>'proofHash'
 AND d->>'runId'=c->'request'->>'runId' AND d->'runVersion'=c->'request'->'expectedVersion' AND d->>'status'='implementation_in_progress'
 AND d->>'branch'=c->'request'->>'branch' AND d->>'baseSha'=c->'request'->>'baseSha' AND d->>'headSha'=c->'request'->>'headSha'
 AND d->>'action'='workspace.write' AND d->>'action'=c->'proof'->>'actionType' AND d->>'path'=c->'proof'->>'actionPath'
 AND d->>'resourceId'=r->>'resource_id' AND d->'expectedVersion'=r->'version' AND d->>'expectedRef'=r->>'ref'
 AND d->>'path'=r->>'path' AND r->>'project'=c->'request'->>'projectId',false)
$b$;
CREATE FUNCTION ppo_authority.register_resource_operation(p_text text,p_payload text,p_fingerprint text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE d jsonb;c jsonb;r jsonb;
BEGIN
 IF p_text IS NULL OR octet_length(p_text)>8192 OR p_payload IS NULL OR octet_length(p_payload)>4096 THEN RETURN false; END IF;
 d:=p_text::jsonb;
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT context INTO c FROM ppo_authority.action_contexts WHERE ticket=(d->>'ticket')::uuid;
 SELECT to_jsonb(x) INTO r FROM ppo_authority.current_resource x WHERE resource_id=(d->>'resourceId')::uuid;
 IF c IS NULL OR r IS NULL OR p_fingerprint IS DISTINCT FROM c->>'coordinatorFingerprint' OR NOT ppo_authority.resource_bindings_valid(d,c,r)
 OR d->>'payloadHash' IS DISTINCT FROM encode(sha256(convert_to(p_payload,'UTF8')),'hex') OR NOT ppo_authority.action_bindings_valid(c)
 OR (SELECT count(*) FROM ppo_authority.resource_operations)>=1000 THEN RETURN false; END IF;
 INSERT INTO ppo_authority.resource_operations VALUES((d->>'operationId')::uuid,(d->>'ticket')::uuid,d,p_payload,encode(sha256(convert_to(p_text,'UTF8')),'hex')); RETURN true;
END $b$;
CREATE FUNCTION ppo_authority.apply_resource_operation(p_operation uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE o ppo_authority.resource_operations%ROWTYPE;c jsonb;r ppo_authority.resource_versions%ROWTYPE; e jsonb; next_state jsonb;
BEGIN
 UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT * INTO o FROM ppo_authority.resource_operations WHERE operation_id=p_operation;
 IF NOT FOUND OR o.descriptor_hash IS DISTINCT FROM p_hash OR EXISTS(SELECT 1 FROM ppo_authority.resource_receipts WHERE operation_id=p_operation) THEN RETURN '{"applied":false}'; END IF;
 SELECT context INTO c FROM ppo_authority.action_contexts WHERE ticket=o.ticket;
 SELECT * INTO r FROM ppo_authority.current_resource WHERE resource_id=(o.descriptor->>'resourceId')::uuid;
 IF NOT FOUND OR r.version>=999 OR NOT ppo_authority.resource_bindings_valid(o.descriptor,c,to_jsonb(r)) OR NOT ppo_authority.action_bindings_valid(c) THEN RETURN '{"applied":false}'; END IF;
 -- Fresh consumption occurs HERE, never from an old diagnostic receipt.
 e:=ppo_authority.consume_action(o.ticket,p_operation);
 IF e->'consumed' IS DISTINCT FROM 'true'::jsonb THEN RETURN '{"applied":false}'; END IF;
 INSERT INTO ppo_authority.resource_versions VALUES(r.resource_id,r.version+1,r.project,r.path,encode(sha256(convert_to(o.payload,'UTF8')),'hex'),o.payload) RETURNING to_jsonb(resource_versions.*) INTO next_state;
 INSERT INTO ppo_authority.resource_receipts VALUES(p_operation,o.ticket,to_jsonb(r),next_state,o.descriptor_hash);
 IF (ppo_authority.check_action(o.ticket,p_operation,true))->'fresh' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'resource action expired'; END IF;
 RETURN jsonb_build_object('applied',true,'operationId',p_operation::text,'descriptorHash',p_hash,'ticket',o.ticket::text);
END $b$;
CREATE FUNCTION ppo_authority.read_resource_receipt(p_operation uuid,p_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 SELECT to_jsonb(r) FROM ppo_authority.resource_receipts r JOIN ppo_authority.action_tombstones t ON t.operation_id=r.operation_id AND t.ticket=r.ticket WHERE r.operation_id=p_operation AND r.descriptor_hash=p_hash
$b$;
GRANT EXECUTE ON FUNCTION ppo_authority.initialize_resource() TO ppo_action_admin;
GRANT EXECUTE ON FUNCTION ppo_authority.read_resource_context(uuid),ppo_authority.register_resource_operation(text,text,text) TO ppo_resource_verifier;
GRANT EXECUTE ON FUNCTION ppo_authority.apply_resource_operation(uuid,text),ppo_authority.read_resource_receipt(uuid,text),ppo_authority.check_action(uuid,uuid,boolean) TO ppo_resource_consumer;
COMMIT;
