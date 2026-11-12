-- RIC-157 B2b2b: isolated one-shot import rehearsal. NOT a production migration.
BEGIN;
DO $guard$
BEGIN
  IF current_database() <> 'ppo_authority_ci' THEN
    RAISE EXCEPTION 'isolated authority database required';
  END IF;
END
$guard$;
CREATE ROLE ppo_authority_importer NOLOGIN;
GRANT USAGE ON SCHEMA ppo_authority TO ppo_authority_importer;
SET LOCAL ROLE ppo_authority_owner;

CREATE TABLE ppo_authority.synthetic_import_batch (
  inventory_hash text PRIMARY KEY CHECK (inventory_hash ~ '^[a-f0-9]{64}$'),
  singleton boolean NOT NULL UNIQUE CHECK (singleton)
);
CREATE TABLE ppo_authority.synthetic_import_files (
  inventory_hash text NOT NULL REFERENCES ppo_authority.synthetic_import_batch(inventory_hash),
  path text NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 131072),
  path_hash text NOT NULL CHECK (path_hash = encode(sha256(convert_to(path,'UTF8')),'hex')),
  content_hash text NOT NULL CHECK (content_hash = encode(sha256(bytes),'hex')),
  PRIMARY KEY (inventory_hash,path)
);
CREATE TRIGGER immutable_import_batch BEFORE UPDATE OR DELETE OR TRUNCATE
ON ppo_authority.synthetic_import_batch FOR EACH STATEMENT
EXECUTE FUNCTION ppo_authority.refuse_history_mutation();
CREATE TRIGGER immutable_import_files BEFORE UPDATE OR DELETE OR TRUNCATE
ON ppo_authority.synthetic_import_files FOR EACH STATEMENT
EXECUTE FUNCTION ppo_authority.refuse_history_mutation();

-- Trusted isolated importer: complete JS semantic validation and source
-- normalization parity precede this call. Re-check path/bytes/manifest,
-- completeness, CAS and final WIP inside the single database transaction.
CREATE FUNCTION ppo_authority.import_synthetic_snapshot(p_hash text,p_payload text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  entries jsonb;
  item jsonb;
  p text;
  raw bytea;
  total bigint := 0;
  digest text;
  run_row record;
  marker_row record;
  prior_hash text;
  expected integer;
  current_record jsonb;
  final_record jsonb;
  source_text text;
  run_count integer;
BEGIN
  IF current_database() <> 'ppo_authority_ci' OR p_hash IS NULL OR
    length(p_hash)<>64 OR p_hash !~ '^[a-f0-9]{64}$' OR
    p_payload IS NULL OR octet_length(p_payload)>48*1024*1024 THEN RETURN false; END IF;
  entries := p_payload::jsonb;
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(entries) NOT BETWEEN 1 AND 10100 THEN RETURN false; END IF;

  -- Same gate as ordinary canonical writes. A competing writer either
  -- precedes this import (nonempty target, deny) or follows its commit.
  UPDATE ppo_authority.gate SET revision=revision+1 WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'authority gate missing'; END IF;
  IF EXISTS(SELECT 1 FROM ppo_authority.run_versions) OR
     EXISTS(SELECT 1 FROM ppo_authority.synthetic_import_batch) THEN RETURN false; END IF;
  INSERT INTO ppo_authority.synthetic_import_batch VALUES(p_hash,true);
  FOR item IN SELECT value FROM jsonb_array_elements(entries) LOOP
    p := item->>'path';
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR
       jsonb_typeof(item->'path') IS DISTINCT FROM 'string' OR
       jsonb_typeof(item->'bytesBase64') IS DISTINCT FROM 'string' OR
       (item - 'path' - 'bytesBase64') <> '{}'::jsonb OR
       p IS NULL OR NOT (
         (length(p)=56 AND p ~ '^records/[A-Za-z0-9_-]{43}\.json$') OR
         (length(p)=64 AND p ~ '^versions/[A-Za-z0-9_-]{43}/[0-9]{6}\.json$')
       ) OR length(item->>'bytesBase64')>174764 THEN
      RAISE EXCEPTION 'invalid synthetic archive entry';
    END IF;
    raw := decode(item->>'bytesBase64','base64');
    IF replace(encode(raw,'base64'),chr(10),'') IS DISTINCT FROM item->>'bytesBase64'
       OR octet_length(raw) NOT BETWEEN 1 AND 131072 THEN
      RAISE EXCEPTION 'invalid synthetic archive bytes';
    END IF;
    total := total+octet_length(raw);
    IF total>32*1024*1024 THEN RAISE EXCEPTION 'synthetic archive exceeds bound'; END IF;
    INSERT INTO ppo_authority.synthetic_import_files VALUES
      (p_hash,p,raw,encode(sha256(convert_to(p,'UTF8')),'hex'),encode(sha256(raw),'hex'));
  END LOOP;
  -- Exact compact JSON digest used by the source preflight, with fixed
  -- field order and ASCII hex/decimal values. Locale-independent ordering.
  SELECT encode(sha256(convert_to('['||string_agg(
    '{"pathHash":"'||path_hash||'","sha256":"'||content_hash||'","byteLength":'||octet_length(bytes)||'}',
    ',' ORDER BY path_hash COLLATE "C",content_hash COLLATE "C",octet_length(bytes))||']','UTF8')),'hex')
    INTO digest FROM ppo_authority.synthetic_import_files WHERE inventory_hash=p_hash;
  IF digest IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'synthetic archive digest mismatch'; END IF;
  SELECT count(*) INTO run_count FROM ppo_authority.synthetic_import_files
    WHERE inventory_hash=p_hash AND path LIKE 'records/%';
  IF run_count NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'synthetic catalog bound'; END IF;
  IF EXISTS(
    SELECT 1 FROM ppo_authority.synthetic_import_files f
    WHERE f.inventory_hash=p_hash AND f.path LIKE 'versions/%'
      AND NOT EXISTS(SELECT 1 FROM ppo_authority.synthetic_import_files c
        WHERE c.inventory_hash=p_hash AND c.path='records/'||split_part(f.path,'/',2)||'.json')
  ) THEN RAISE EXCEPTION 'orphan synthetic marker'; END IF;

  -- Replay complete per-run histories in a deterministic rehearsal order:
  -- final non-WIP runs first, then final WIP consumers. This is NOT a claim
  -- about actual cross-run historical ordering or prior admission validity.
  FOR run_row IN
    SELECT substring(path from 9 for 43) AS id,convert_from(bytes,'UTF8')::jsonb AS final
    FROM ppo_authority.synthetic_import_files WHERE inventory_hash=p_hash AND path LIKE 'records/%'
    ORDER BY CASE WHEN convert_from(bytes,'UTF8')::jsonb->>'status' IN
      ('merged','deploy_in_progress','deploy_failed','deployed','verification_in_progress','verification_failed','rollback_in_progress','rollback_failed','rolled_back','verified','cancelled','failed')
      THEN 0 ELSE 1 END, path COLLATE "C"
  LOOP
    prior_hash := NULL;
    expected := -1;
    final_record := run_row.final;
    FOR marker_row IN
      SELECT path,bytes FROM ppo_authority.synthetic_import_files
      WHERE inventory_hash=p_hash AND path LIKE 'versions/%' AND split_part(path,'/',2)=run_row.id
      ORDER BY path COLLATE "C"
    LOOP
      -- Avoid SQL LIKE wildcard interpretation of underscores in run IDs.
      IF split_part(marker_row.path,'/',2)<>run_row.id THEN CONTINUE; END IF;
      source_text := convert_from(marker_row.bytes,'UTF8');
      current_record := source_text::jsonb;
      IF split_part(marker_row.path,'/',3)<>lpad((expected+1)::text,6,'0')||'.json'
         OR ppo_authority.commit_run(run_row.id,expected,prior_hash,source_text) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'synthetic history import rejected';
      END IF;
      expected := expected+1;
      prior_hash := current_record->>'historyHash';
    END LOOP;
    IF expected<0 OR ppo_authority.read_run(run_row.id) IS DISTINCT FROM final_record THEN
      RAISE EXCEPTION 'synthetic canonical parity failed';
    END IF;
  END LOOP;
  -- A marker cannot be silently skipped; archive and target version counts
  -- and exact JSONB canonical values must match before COMMIT.
  IF (SELECT count(*) FROM ppo_authority.run_versions) <>
     (SELECT count(*) FROM ppo_authority.synthetic_import_files WHERE inventory_hash=p_hash AND path LIKE 'versions/%')
     OR (SELECT count(*) FROM ppo_authority.current_runs)<>run_count
     OR EXISTS(
       SELECT 1 FROM ppo_authority.synthetic_import_files f
       LEFT JOIN ppo_authority.run_versions v
         ON v.run_id=split_part(f.path,'/',2)
         AND lpad(v.version::text,6,'0')||'.json'=split_part(f.path,'/',3)
       WHERE f.inventory_hash=p_hash AND f.path LIKE 'versions/%'
         AND v.record IS DISTINCT FROM convert_from(f.bytes,'UTF8')::jsonb
     ) THEN RAISE EXCEPTION 'synthetic version parity failed'; END IF;
  RETURN true;
END
$body$;

CREATE FUNCTION ppo_authority.read_synthetic_archive(p_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
  SELECT jsonb_agg(jsonb_build_object('path',path,'bytesBase64',replace(encode(bytes,'base64'),chr(10),'')) ORDER BY path COLLATE "C")
  FROM ppo_authority.synthetic_import_files WHERE inventory_hash=p_hash
$body$;

REVOKE ALL ON ppo_authority.synthetic_import_batch,ppo_authority.synthetic_import_files FROM PUBLIC,ppo_authority_writer,ppo_authority_reader,ppo_authority_importer;
REVOKE ALL ON FUNCTION ppo_authority.import_synthetic_snapshot(text,text),ppo_authority.read_synthetic_archive(text) FROM PUBLIC,ppo_authority_reader,ppo_authority_writer;
GRANT EXECUTE ON FUNCTION ppo_authority.import_synthetic_snapshot(text,text),ppo_authority.read_synthetic_archive(text) TO ppo_authority_importer;
COMMIT;
