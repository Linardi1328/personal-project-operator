-- B2b3 isolated read operation only. No routing or writer changes.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'ppo_authority_ci' THEN
    RAISE EXCEPTION 'isolated authority database required';
  END IF;
END
$guard$;
SET LOCAL ROLE ppo_authority_owner;
-- STABLE is essential: every internal SELECT uses the calling statement's
-- MVCC snapshot, including the revision, bounds and complete history payload.
CREATE FUNCTION ppo_authority.read_catalog_snapshot()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  revision text;
  runs bigint;
  versions bigint;
  physical_bytes bigint;
  entries jsonb;
BEGIN
  SELECT g.revision::text INTO revision FROM ppo_authority.gate g WHERE singleton;
  IF revision IS NULL THEN RAISE EXCEPTION 'authority gate missing'; END IF;
  -- Count only bounded prefixes; no unbounded aggregate of record bodies.
  SELECT count(*) INTO runs FROM (SELECT 1 FROM ppo_authority.current_runs LIMIT 21) r;
  SELECT count(*) INTO versions FROM (SELECT 1 FROM ppo_authority.run_versions LIMIT 2001) v;
  IF runs>20 OR versions>2000 THEN
    RETURN jsonb_build_object('revision',revision,'code','catalog_truncated','entries','[]'::jsonb);
  END IF;
  SELECT coalesce(sum(octet_length(to_json(record::text)::text)+128),0) INTO physical_bytes FROM (
    SELECT record FROM ppo_authority.current_runs
    UNION ALL SELECT record FROM ppo_authority.run_versions
  ) r;
  IF physical_bytes>32*1024*1024 THEN
    RETURN jsonb_build_object('revision',revision,'code','catalog_truncated','entries','[]'::jsonb);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'serialized',record::text) ORDER BY path COLLATE "C"),'[]'::jsonb)
    INTO entries FROM (
      SELECT 'records/'||run_id||'.json' AS path,record FROM ppo_authority.current_runs
      UNION ALL
      SELECT 'versions/'||run_id||'/'||lpad(version::text,6,'0')||'.json',record FROM ppo_authority.run_versions
    ) r;
  RETURN jsonb_build_object('revision',revision,'code','ok','entries',entries);
END
$body$;
REVOKE ALL ON FUNCTION ppo_authority.read_catalog_snapshot() FROM PUBLIC,ppo_authority_importer;
GRANT EXECUTE ON FUNCTION ppo_authority.read_catalog_snapshot() TO ppo_authority_reader,ppo_authority_writer;
COMMIT;
