-- RIC-177: disposable integrated authority-gateway profile. Fresh isolated CI
-- database only; not a live migration, client-selectable flag or production
-- authority. Installs inert gateway objects. Nothing changes existing grants
-- until the trusted bootstrap administrator explicitly seals the profile.
BEGIN;
DO $g$ BEGIN IF current_database()<>'ppo_authority_ci' THEN RAISE EXCEPTION 'isolated database required'; END IF; END $g$;
CREATE ROLE ppo_authority_gateway NOLOGIN NOINHERIT;
SET LOCAL ROLE ppo_authority_owner;
-- Sealed external trust domain and DB-side monotonic incarnation floor. A
-- restored copy can roll this back: it is defence in depth, never the
-- freshness anchor. The external witness checkpoint is the anchor.
CREATE TABLE ppo_authority.gateway_profile(
 singleton boolean PRIMARY KEY CHECK(singleton),
 profile text NOT NULL CHECK(profile='ric177-disposable-authority-gateway-v1'),
 anchor_id uuid NOT NULL, authority_id uuid NOT NULL, owner_id uuid NOT NULL,
 gateway_login text NOT NULL CHECK(gateway_login='ppo_transport_gateway'),
 attestation text NOT NULL CHECK(attestation ~ '^[a-f0-9]{64}$'),
 last_incarnation bigint NOT NULL CHECK(last_incarnation BETWEEN 0 AND 1000000000),
 last_instance uuid
);
CREATE TABLE ppo_authority.gateway_receipts(
 operation_id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('consume-action','revoke-host')),
 subject_hash text NOT NULL UNIQUE CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('consumed','revoked','denied')),
 incarnation bigint NOT NULL, instance_id uuid NOT NULL,
 before_checkpoint text NOT NULL CHECK(before_checkpoint ~ '^[a-f0-9]{64}$'),
 binding jsonb NOT NULL, evidence jsonb NOT NULL,
 transaction_id xid8 NOT NULL UNIQUE
);
CREATE TRIGGER immutable_gateway_receipts BEFORE UPDATE OR DELETE OR TRUNCATE ON ppo_authority.gateway_receipts FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE FUNCTION ppo_authority.gateway_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $b$
BEGIN
 IF (to_jsonb(NEW)-'last_incarnation'-'last_instance') IS DISTINCT FROM (to_jsonb(OLD)-'last_incarnation'-'last_instance')
 OR NEW.last_incarnation<=OLD.last_incarnation OR NEW.last_instance IS NULL THEN RAISE EXCEPTION 'gateway profile is monotonic'; END IF;
 RETURN NEW;
END $b$;
CREATE TRIGGER monotonic_gateway_profile BEFORE UPDATE ON ppo_authority.gateway_profile FOR EACH ROW EXECUTE FUNCTION ppo_authority.gateway_profile_guard();
CREATE TRIGGER immutable_gateway_profile BEFORE DELETE OR TRUNCATE ON ppo_authority.gateway_profile FOR EACH STATEMENT EXECUTE FUNCTION ppo_authority.refuse_history_mutation();

-- Native pre/post-state checkpoint over EVERY actual schema table in one
-- statement snapshot. Rendering is pinned (UTC, ISO, C collation) so it does
-- not depend on the calling session or the cluster's default collation.
CREATE FUNCTION ppo_authority.gateway_checkpoint() RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO, MDY' SET IntervalStyle='postgres' SET extra_float_digits=1 AS $b$
DECLARE parts text; out text;
BEGIN
 SELECT string_agg(format('SELECT %L::text AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),''[]'') AS rows FROM ppo_authority.%I t',tablename::text,tablename),' UNION ALL ' ORDER BY tablename)
 INTO STRICT parts FROM pg_tables WHERE schemaname='ppo_authority';
 EXECUTE 'SELECT jsonb_agg(q ORDER BY name COLLATE "C")::text FROM ('||parts||') q' INTO STRICT out;
 RETURN encode(sha256(convert_to(out,'UTF8')),'hex');
END $b$;

-- Schema/profile attestation: definitions, owners, ACLs, constraints,
-- non-internal triggers, indexes and every ppo_* role attribute/membership.
-- OID-free so an exact restore attests identically; any later grant, role
-- escalation or DDL change differs and denies the gateway.
CREATE FUNCTION ppo_authority.gateway_attestation() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
 WITH ns AS (SELECT 'ppo_authority'::regnamespace AS oid),
 fns AS (SELECT coalesce(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.prosecdef,p.provolatile,p.proconfig,p.proowner::regrole::text,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable) ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END) COLLATE "C",x.privilege_type COLLATE "C"),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x))
  ORDER BY p.oid::regprocedure::text COLLATE "C"),'[]'::jsonb) AS j FROM pg_proc p,ns WHERE p.pronamespace=ns.oid),
 rels AS (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname::text,c.relkind,c.relowner::regrole::text,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable) ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END) COLLATE "C",x.privilege_type COLLATE "C"),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))) x),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(a.attname::text,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attacl::text) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname::text,pg_get_constraintdef(k.oid)) ORDER BY k.conname::text COLLATE "C"),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(t.tgname::text,pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname::text COLLATE "C"),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
  (SELECT coalesce(jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid) COLLATE "C"),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),
  CASE WHEN c.relkind='v' THEN pg_get_viewdef(c.oid) END)
  ORDER BY c.relname::text COLLATE "C"),'[]'::jsonb) AS j FROM pg_class c,ns WHERE c.relnamespace=ns.oid AND c.relkind IN ('r','p','v','m','S','f')),
 sch AS (SELECT (SELECT coalesce(jsonb_agg(jsonb_build_array(CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable) ORDER BY (CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END) COLLATE "C",x.privilege_type COLLATE "C"),'[]'::jsonb) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x) AS j,n.nspowner::regrole::text AS owner FROM pg_namespace n,ns WHERE n.oid=ns.oid),
 rol AS (SELECT coalesce(jsonb_agg(jsonb_build_array(r.rolname::text,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls) ORDER BY r.rolname::text COLLATE "C"),'[]'::jsonb) AS j FROM pg_roles r WHERE r.rolname LIKE 'ppo\_%'),
 mem AS (SELECT coalesce(jsonb_agg(jsonb_build_array(m.roleid::regrole::text,m.member::regrole::text,m.admin_option,m.inherit_option,m.set_option) ORDER BY m.roleid::regrole::text COLLATE "C",m.member::regrole::text COLLATE "C"),'[]'::jsonb) AS j
  FROM pg_auth_members m WHERE m.roleid::regrole::text LIKE 'ppo\_%' OR m.member::regrole::text LIKE 'ppo\_%' OR m.roleid::regrole::text IN ('pg_write_all_data','pg_read_all_data')),
 -- Rules, row security, policies, per-role/database settings, default ACLs,
 -- schema types and operators: any later change differs.
 extra AS (SELECT jsonb_build_array(
  (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname::text,r.rulename::text,pg_get_ruledef(r.oid)) ORDER BY c.relname::text COLLATE "C",r.rulename::text COLLATE "C"),'[]'::jsonb) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class,ns WHERE c.relnamespace=ns.oid AND c.relkind<>'v'),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname::text,c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname::text COLLATE "C"),'[]'::jsonb) FROM pg_class c,ns WHERE c.relnamespace=ns.oid AND c.relkind IN ('r','p')),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname::text,p.polname::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY c.relname::text COLLATE "C",p.polname::text COLLATE "C"),'[]'::jsonb) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid,ns WHERE c.relnamespace=ns.oid),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(coalesce(d.datname::text,''),coalesce(r.rolname::text,''),s.setconfig) ORDER BY coalesce(d.datname::text,'') COLLATE "C",coalesce(r.rolname::text,'') COLLATE "C"),'[]'::jsonb) FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole WHERE (s.setdatabase=0 OR d.datname=current_database()) AND (s.setrole=0 OR r.rolname LIKE 'ppo\_%')),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(a.defaclrole::regrole::text,a.defaclnamespace<>0,a.defaclobjtype,a.defaclacl::text) ORDER BY a.defaclrole::regrole::text COLLATE "C",a.defaclnamespace<>0,a.defaclobjtype),'[]'::jsonb) FROM pg_default_acl a,ns WHERE a.defaclnamespace IN (0,ns.oid)),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(t.typname::text,t.typtype,t.typowner::regrole::text,t.typacl::text) ORDER BY t.typname::text COLLATE "C"),'[]'::jsonb) FROM pg_type t,ns WHERE t.typnamespace=ns.oid),
  (SELECT coalesce(jsonb_agg(o.oid::regoperator::text ORDER BY o.oid::regoperator::text COLLATE "C"),'[]'::jsonb) FROM pg_operator o,ns WHERE o.oprnamespace=ns.oid)) AS j)
 SELECT encode(sha256(convert_to(jsonb_build_array('ric177-attestation-v2',(SELECT j FROM fns),(SELECT j FROM rels),(SELECT jsonb_build_array(owner,j) FROM sch),(SELECT j FROM rol),(SELECT j FROM mem),(SELECT j FROM extra))::text,'UTF8')),'hex')
$b$;

-- Fails with SQLSTATE 42501 unless invoked by the one sealed gateway LOGIN,
-- after SET ROLE to its single gateway membership, without privileged
-- attributes or any additional direct/transitive membership.
CREATE FUNCTION ppo_authority.gateway_session_guard() RETURNS ppo_authority.gateway_profile LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE prof ppo_authority.gateway_profile%ROWTYPE; memberships text[];
BEGIN
 SELECT * INTO prof FROM ppo_authority.gateway_profile WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'authority gateway profile not sealed' USING ERRCODE='insufficient_privilege'; END IF;
 SELECT array_agg(p.rolname::text ORDER BY p.rolname::text COLLATE "C") INTO memberships FROM pg_roles p WHERE p.rolname<>session_user AND pg_has_role(session_user,p.oid,'MEMBER');
 IF session_user::text IS DISTINCT FROM prof.gateway_login OR current_setting('role') IS DISTINCT FROM 'ppo_authority_gateway'
 OR memberships IS DISTINCT FROM ARRAY['ppo_authority_gateway']
 OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN (session_user,'ppo_authority_gateway') AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls))
 THEN RAISE EXCEPTION 'authority gateway session denied' USING ERRCODE='insufficient_privilege'; END IF;
 RETURN prof;
END $b$;

CREATE FUNCTION ppo_authority.gateway_subject(p_kind text,p_key text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $b$
 SELECT encode(sha256(convert_to('ppo-ric177-gateway-subject-v1|'||p_kind||'|'||p_key,'UTF8')),'hex')
$b$;
-- Exact independently bound fields; no normalisation after authentication.
CREATE FUNCTION ppo_authority.gateway_binding(prof ppo_authority.gateway_profile,p_binding text,p_kind text,p_operation uuid,p_key text,p_detail text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $b$
DECLARE b jsonb; input text; u text:='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'; h text:='^[a-f0-9]{64}$'; n text:='^[1-9][0-9]{0,8}$';
BEGIN
 IF p_binding IS NULL OR octet_length(p_binding)>4096 OR p_operation IS NULL OR p_key IS NULL OR p_detail IS NULL THEN RAISE EXCEPTION 'gateway binding denied'; END IF;
 b:=p_binding::jsonb;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(b) k) IS DISTINCT FROM
  ARRAY['anchorId','authorityId','checkpoint','incarnation','inputHash','instanceId','ownerId','peerEpoch','peerFingerprint','peerIdentity','serviceEpoch','serviceIdentity','subjectHash']
 OR jsonb_typeof(b->'incarnation') IS DISTINCT FROM 'number' OR jsonb_typeof(b->'peerEpoch') IS DISTINCT FROM 'number' OR jsonb_typeof(b->'serviceEpoch') IS DISTINCT FROM 'number'
 OR coalesce(b->>'incarnation','') !~ n OR coalesce(b->>'peerEpoch','') !~ n OR coalesce(b->>'serviceEpoch','') !~ n
 OR coalesce(b->>'anchorId','') !~ u OR coalesce(b->>'authorityId','') !~ u OR coalesce(b->>'ownerId','') !~ u OR coalesce(b->>'instanceId','') !~ u
 OR coalesce(b->>'checkpoint','') !~ h OR coalesce(b->>'peerFingerprint','') !~ h OR coalesce(b->>'subjectHash','') !~ h OR coalesce(b->>'inputHash','') !~ h
 OR coalesce(b->>'peerIdentity','') !~ '^lab-[a-z0-9-]{1,60}$' OR coalesce(b->>'serviceIdentity','') !~ '^lab-[a-z0-9-]{1,60}$'
 THEN RAISE EXCEPTION 'gateway binding denied'; END IF;
 IF b->>'anchorId' IS DISTINCT FROM prof.anchor_id::text OR b->>'authorityId' IS DISTINCT FROM prof.authority_id::text OR b->>'ownerId' IS DISTINCT FROM prof.owner_id::text
 THEN RAISE EXCEPTION 'gateway external trust domain denied'; END IF;
 IF (b->>'incarnation')::bigint<=prof.last_incarnation THEN RAISE EXCEPTION 'gateway incarnation is not newer'; END IF;
 -- Revocation subject is host AND expected epoch: a denied stale-epoch
 -- attempt never burns the host's ability to be revoked at its real epoch.
 IF ppo_authority.gateway_subject(p_kind,CASE WHEN p_detail='' THEN p_key ELSE p_key||':'||p_detail END) IS DISTINCT FROM b->>'subjectHash' THEN RAISE EXCEPTION 'gateway subject denied'; END IF;
 input:='ppo-ric177-gateway-input-v1|'||p_kind||'|'||p_operation::text||'|'||p_key||'|'||p_detail||'|'||(b->>'anchorId')||'|'||(b->>'authorityId')||'|'||(b->>'ownerId')||'|'||
  (b->>'incarnation')||'|'||(b->>'instanceId')||'|'||(b->>'checkpoint')||'|'||(b->>'peerIdentity')||'|'||(b->>'peerEpoch')||'|'||(b->>'peerFingerprint')||'|'||(b->>'serviceIdentity')||'|'||(b->>'serviceEpoch');
 IF encode(sha256(convert_to(input,'UTF8')),'hex') IS DISTINCT FROM b->>'inputHash' THEN RAISE EXCEPTION 'gateway input digest denied'; END IF;
 RETURN b;
END $b$;

-- Actual mutation boundary prelude: the shared first gate lock (every
-- canonical/import/ownership/action/resource writer takes it), one mutation
-- per transaction, live attestation, exact binding and native checkpoint.
CREATE FUNCTION ppo_authority.gateway_boundary(p_binding text,p_kind text,p_operation uuid,p_key text,p_detail text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE prof ppo_authority.gateway_profile%ROWTYPE; b jsonb;
BEGIN
 prof:=ppo_authority.gateway_session_guard();
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT * INTO STRICT prof FROM ppo_authority.gateway_profile WHERE singleton FOR UPDATE;
 IF EXISTS(SELECT 1 FROM ppo_authority.gateway_receipts WHERE transaction_id=pg_current_xact_id()) THEN RAISE EXCEPTION 'one gateway mutation per transaction'; END IF;
 IF ppo_authority.gateway_attestation() IS DISTINCT FROM prof.attestation THEN RAISE EXCEPTION 'gateway schema/profile attestation changed'; END IF;
 b:=ppo_authority.gateway_binding(prof,p_binding,p_kind,p_operation,p_key,p_detail);
 IF EXISTS(SELECT 1 FROM ppo_authority.gateway_receipts WHERE operation_id=p_operation OR subject_hash=b->>'subjectHash') THEN RAISE EXCEPTION 'gateway operation or subject replay'; END IF;
 IF ppo_authority.gateway_checkpoint() IS DISTINCT FROM b->>'checkpoint' THEN RAISE EXCEPTION 'gateway native checkpoint is stale'; END IF;
 RETURN b;
END $b$;
CREATE FUNCTION ppo_authority.gateway_record(b jsonb,p_kind text,p_operation uuid,p_outcome text,p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE r jsonb;
BEGIN
 INSERT INTO ppo_authority.gateway_receipts VALUES(p_operation,p_kind,b->>'subjectHash',b->>'inputHash',p_outcome,(b->>'incarnation')::bigint,(b->>'instanceId')::uuid,b->>'checkpoint',b,p_evidence,pg_current_xact_id());
 UPDATE ppo_authority.gateway_profile SET last_incarnation=(b->>'incarnation')::bigint,last_instance=(b->>'instanceId')::uuid WHERE singleton;
 SELECT to_jsonb(g) INTO STRICT r FROM ppo_authority.gateway_receipts g WHERE operation_id=p_operation;
 RETURN r;
END $b$;
CREATE FUNCTION ppo_authority.gateway_consume_action(p_operation uuid,p_ticket uuid,p_binding text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE b jsonb; r jsonb; e jsonb;
BEGIN
 IF p_ticket IS NULL THEN RAISE EXCEPTION 'gateway ticket required'; END IF;
 b:=ppo_authority.gateway_boundary(p_binding,'consume-action',p_operation,p_ticket::text,'');
 r:=ppo_authority.consume_action(p_ticket,p_operation);
 IF r->>'consumed' IS DISTINCT FROM 'true' THEN RETURN ppo_authority.gateway_record(b,'consume-action',p_operation,'denied',jsonb_build_object('ticket',p_ticket::text,'core',r)); END IF;
 e:=ppo_authority.check_action(p_ticket,p_operation,true);
 IF e->>'fresh' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'gateway consumption not fresh before commit'; END IF;
 RETURN ppo_authority.gateway_record(b,'consume-action',p_operation,'consumed',jsonb_build_object('ticket',p_ticket::text,'core',r,'precommit',e));
END $b$;
-- Host revocation only: the new policy is derived natively from the current
-- active policy; a client cannot supply a policy, activation or rotation.
CREATE FUNCTION ppo_authority.gateway_revoke_host(p_operation uuid,p_host text,p_expected bigint,p_binding text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE b jsonb; h ppo_authority.action_hosts%ROWTYPE; epoch bigint; after jsonb;
BEGIN
 IF p_host IS NULL OR p_host !~ '^lab-[a-z0-9-]{1,59}$' OR p_expected IS NULL OR p_expected NOT BETWEEN 1 AND 999999999 THEN RAISE EXCEPTION 'gateway host input denied'; END IF;
 b:=ppo_authority.gateway_boundary(p_binding,'revoke-host',p_operation,p_host,p_expected::text);
 SELECT * INTO h FROM ppo_authority.action_hosts WHERE host_id=p_host;
 IF NOT FOUND OR h.epoch<>p_expected OR h.policy->>'status' IS DISTINCT FROM 'active' THEN
  RETURN ppo_authority.gateway_record(b,'revoke-host',p_operation,'denied',jsonb_build_object('hostId',p_host,'expectedEpoch',p_expected,'before',to_jsonb(h)));
 END IF;
 epoch:=ppo_authority.configure_action_host(p_host,p_expected,(h.policy||'{"status":"revoked"}'::jsonb)::text);
 SELECT to_jsonb(x) INTO STRICT after FROM ppo_authority.action_hosts x WHERE host_id=p_host;
 IF epoch<>p_expected+1 OR after->'policy'->>'status' IS DISTINCT FROM 'revoked' THEN RAISE EXCEPTION 'gateway revocation evidence mismatch'; END IF;
 RETURN ppo_authority.gateway_record(b,'revoke-host',p_operation,'revoked',jsonb_build_object('hostId',p_host,'expectedEpoch',p_expected,'before',to_jsonb(h),'after',after));
END $b$;
-- Read-only exact evidence. FOR SHARE on the gate serialises against every
-- gate writer while the receipt, native evidence and checkpoint are read.
CREATE FUNCTION ppo_authority.gateway_receipt(p_operation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE prof ppo_authority.gateway_profile%ROWTYPE; r jsonb; native jsonb;
BEGIN
 prof:=ppo_authority.gateway_session_guard();
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT to_jsonb(g) INTO r FROM ppo_authority.gateway_receipts g WHERE operation_id=p_operation;
 -- Only a receipt whose transaction is durably committed is evidence; one
 -- visible from this session's own open transaction is not.
 IF r IS NOT NULL AND pg_xact_status((r->>'transaction_id')::xid8) IS DISTINCT FROM 'committed' THEN r:=NULL; END IF;
 IF r->>'kind'='consume-action' THEN SELECT to_jsonb(t) INTO native FROM ppo_authority.action_tombstones t WHERE operation_id=p_operation;
 ELSIF r->>'kind'='revoke-host' THEN SELECT to_jsonb(x) INTO native FROM ppo_authority.action_hosts x WHERE host_id=r->'evidence'->>'hostId'; END IF;
 RETURN jsonb_build_object('receiptText',r::text,'receiptHash',CASE WHEN r IS NULL THEN NULL ELSE encode(sha256(convert_to(r::text,'UTF8')),'hex') END,'native',native,
  'checkpoint',ppo_authority.gateway_checkpoint(),'attestation',ppo_authority.gateway_attestation(),'sealedAttestation',prof.attestation);
END $b$;
CREATE FUNCTION ppo_authority.gateway_state() RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $b$
DECLARE prof ppo_authority.gateway_profile%ROWTYPE;
BEGIN
 prof:=ppo_authority.gateway_session_guard();
 PERFORM 1 FROM ppo_authority.gate WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'gate missing'; END IF;
 SELECT * INTO STRICT prof FROM ppo_authority.gateway_profile WHERE singleton;
 RETURN jsonb_build_object('profile',prof.profile,'anchorId',prof.anchor_id::text,'authorityId',prof.authority_id::text,'ownerId',prof.owner_id::text,
  'lastIncarnation',prof.last_incarnation,'sealedAttestation',prof.attestation,'attestation',ppo_authority.gateway_attestation(),'checkpoint',ppo_authority.gateway_checkpoint());
END $b$;

-- Trusted bootstrap administrator only (superuser in the disposable lab):
-- after fixture/context registration, revoke EVERY non-owner privilege on
-- every schema function, relation and the schema itself, then grant only the
-- four gateway entrypoints to the single gateway role. Not granted to anyone.
CREATE FUNCTION ppo_authority.seal_authority_gateway(p_anchor uuid,p_authority uuid,p_owner uuid) RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $b$
DECLARE r record; ns oid:='ppo_authority'::regnamespace; owner oid:='ppo_authority_owner'::regrole; gw oid:='ppo_authority_gateway'::regrole; login oid; a text;
 entry text[]:=ARRAY['ppo_authority.gateway_state()','ppo_authority.gateway_consume_action(uuid,uuid,text)','ppo_authority.gateway_revoke_host(uuid,text,bigint,text)','ppo_authority.gateway_receipt(uuid)'];
BEGIN
 IF current_database()<>'ppo_authority_ci' OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'trusted disposable bootstrap administrator required'; END IF;
 IF EXISTS(SELECT 1 FROM ppo_authority.gateway_profile) THEN RAISE EXCEPTION 'authority gateway already sealed'; END IF;
 IF p_anchor IS NULL OR p_authority IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION 'external trust domain required'; END IF;
 IF p_authority IS DISTINCT FROM (SELECT target_id FROM ppo_authority.rehearsal_owner WHERE singleton AND phase='target') THEN RAISE EXCEPTION 'authority is not the active target'; END IF;
 SELECT oid INTO login FROM pg_roles WHERE rolname='ppo_transport_gateway' AND rolcanlogin AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
 IF login IS NULL OR (SELECT array_agg(roleid) FROM pg_auth_members WHERE member=login) IS DISTINCT FROM ARRAY[gw]
 OR (SELECT array_agg(member) FROM pg_auth_members WHERE roleid=gw) IS DISTINCT FROM ARRAY[login]
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=gw OR roleid=owner)
 OR (SELECT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE oid=gw)
 THEN RAISE EXCEPTION 'gateway LOGIN must hold exactly one unprivileged gateway membership'; END IF;
 -- Cluster-global closure: no LOGIN keeps a membership in any ordinary
 -- ppo_* role, so even restoring a pre-seal schema image re-grants ACLs only
 -- to roles nobody can assume. Gateway and owner roles are checked above.
 -- Plain role names (not regrole text, which is already quoted) for %I.
 -- Grants made by a member that itself holds ADMIN OPTION are revoked first.
 FOR r IN SELECT g.rolname::text AS role,mm.rolname::text AS member,gg.rolname::text AS grantor FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid
  JOIN pg_roles mm ON mm.oid=m.member JOIN pg_roles gg ON gg.oid=m.grantor
  WHERE g.rolname LIKE 'ppo\_%' AND m.roleid NOT IN (owner,gw)
  ORDER BY (m.grantor=ANY(SELECT a.member FROM pg_auth_members a WHERE a.roleid=m.roleid AND a.admin_option)) DESC LOOP
  EXECUTE format('REVOKE %I FROM %I GRANTED BY %I',r.role,r.member,r.grantor);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE g.rolname LIKE 'ppo\_%' AND m.roleid NOT IN (owner,gw))
 THEN RAISE EXCEPTION 'ordinary role memberships remain'; END IF;
 -- Predefined roles bypass schema/table ACLs; only superusers may hold them.
 IF EXISTS(SELECT 1 FROM pg_roles pr WHERE NOT pr.rolsuper AND pr.rolname NOT LIKE 'pg\_%' AND pg_has_role(pr.oid,'pg_write_all_data','MEMBER'))
 THEN RAISE EXCEPTION 'ACL-bypassing predefined role membership present'; END IF;
 FOR r IN SELECT p.oid::regprocedure::text AS obj,x.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.pronamespace=ns AND x.grantee<>p.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',r.obj,CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(r.grantee::regrole::text) END);
 END LOOP;
 FOR r IN SELECT format('%I.%I','ppo_authority',c.relname) AS obj,x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))) x WHERE c.relnamespace=ns AND c.relkind IN ('r','p','v','m','S','f') AND x.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON %s FROM %s',r.obj,CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(r.grantee::regrole::text) END);
 END LOOP;
 FOR r IN SELECT x.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x WHERE n.oid=ns AND x.grantee<>n.nspowner LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA ppo_authority FROM %s',CASE WHEN r.grantee=0 THEN 'PUBLIC' ELSE quote_ident(r.grantee::regrole::text) END);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=ns AND a.attacl IS NOT NULL) THEN RAISE EXCEPTION 'column privileges are unsupported'; END IF;
 GRANT USAGE ON SCHEMA ppo_authority TO ppo_authority_gateway;
 GRANT EXECUTE ON FUNCTION ppo_authority.gateway_state(),ppo_authority.gateway_consume_action(uuid,uuid,text),ppo_authority.gateway_revoke_host(uuid,text,bigint,text),ppo_authority.gateway_receipt(uuid) TO ppo_authority_gateway;
 -- Read back the effective result rather than trusting the loop above.
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.pronamespace=ns AND x.grantee<>p.proowner AND NOT (x.grantee=gw AND x.privilege_type='EXECUTE' AND p.oid::regprocedure::text=ANY(entry)))
 OR (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.pronamespace=ns AND x.grantee=gw)<>4
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE c.relnamespace=ns AND x.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x WHERE n.oid=ns AND x.grantee<>n.nspowner AND NOT (x.grantee=gw AND x.privilege_type='USAGE'))
 THEN RAISE EXCEPTION 'authority gateway seal verification failed'; END IF;
 a:=ppo_authority.gateway_attestation();
 INSERT INTO ppo_authority.gateway_profile VALUES(true,'ric177-disposable-authority-gateway-v1',p_anchor,p_authority,p_owner,'ppo_transport_gateway',a,0,NULL);
 RETURN a;
END $b$;
REVOKE ALL ON FUNCTION ppo_authority.seal_authority_gateway(uuid,uuid,uuid),ppo_authority.gateway_checkpoint(),ppo_authority.gateway_attestation(),ppo_authority.gateway_session_guard(),
 ppo_authority.gateway_subject(text,text),ppo_authority.gateway_binding(ppo_authority.gateway_profile,text,text,uuid,text,text),ppo_authority.gateway_boundary(text,text,uuid,text,text),
 ppo_authority.gateway_record(jsonb,text,uuid,text,jsonb),ppo_authority.gateway_profile_guard(),ppo_authority.gateway_consume_action(uuid,uuid,text),
 ppo_authority.gateway_revoke_host(uuid,text,bigint,text),ppo_authority.gateway_receipt(uuid),ppo_authority.gateway_state() FROM PUBLIC;
COMMIT;
