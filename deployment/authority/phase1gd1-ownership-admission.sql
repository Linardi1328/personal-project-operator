BEGIN;
DO $g$ BEGIN IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated database required'; END IF; END $g$;
SET LOCAL ROLE ppo_authority_owner;
ALTER FUNCTION ppo_authority.rehearsal_apply(text,text) RENAME TO admission_rehearsal_core;
DO $m$ DECLARE f text; BEGIN
 SELECT pg_get_functiondef('ppo_authority.admission_rehearsal_core(text,text)'::regprocedure) INTO f;
 EXECUTE replace(replace(f,'ppo_authority.commit_run(','ppo_authority.admission_commit_core('),'ppo_authority.import_synthetic_snapshot(','ppo_authority.admission_import_core(');
END $m$;
CREATE FUNCTION ppo_authority.rehearsal_apply(p_request text,p_channel text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE r jsonb:=p_request::jsonb; kind text;
BEGIN
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 kind:=r->>'action';IF kind='import' THEN kind:='held_import'; END IF;
 IF kind IN ('source_commit','target_commit','seed','held_import') AND NOT ppo_authority.require_admission(kind,p_request) THEN RETURN '{"accepted":false}'; END IF;
 RETURN ppo_authority.admission_rehearsal_core(p_request,p_channel);
END $b$;
CREATE OR REPLACE FUNCTION ppo_authority.rehearsal_control(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$ SELECT ppo_authority.rehearsal_apply(p_request,'control') $b$;
CREATE OR REPLACE FUNCTION ppo_authority.rehearsal_source_commit(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$ SELECT ppo_authority.rehearsal_apply(p_request,'source') $b$;
CREATE OR REPLACE FUNCTION ppo_authority.rehearsal_target_commit(p_request text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$ SELECT ppo_authority.rehearsal_apply(p_request,'target') $b$;
REVOKE ALL ON FUNCTION ppo_authority.admission_rehearsal_core(text,text) FROM PUBLIC,ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target;
GRANT EXECUTE ON FUNCTION ppo_authority.prepare_admission(text,text) TO ppo_rehearsal_controller,ppo_rehearsal_source,ppo_rehearsal_target;
REVOKE EXECUTE ON FUNCTION ppo_authority.commit_run(text,integer,text,text) FROM ppo_authority_writer;
REVOKE EXECUTE ON FUNCTION ppo_authority.import_synthetic_snapshot(text,text) FROM ppo_authority_importer;
COMMIT;
