# RIC-157 — Phase 1G-B2b2a: synthetic migration source preflight

**Scope:** read-only in-memory verification of a supplied synthetic file inventory. No live source capture, import, database mutation, authority cutover or repair. Independent of PR #155's direct-writer changes; based on merged B2a.

## What this slice establishes

The existing filesystem persists a canonical JSON record and immutable version markers. An ordinary read may repair a stale/missing canonical record, while the catalog is a bounded presentation. Neither is a lossless migration inventory. The preflight takes an explicit array of relative file names and exact byte buffers from an isolated synthetic snapshot, not a root path, environment setting, database or credential. The synthetic tests generate the source through PPO's real filesystem writer, capture its actual bytes, and verify the source remains unchanged.

For every supplied file, compute SHA-256 over the exact bytes and a separate hash of its relative path. A deterministic sorted inventory digest binds the supplied file identities and contents, including unknown entries and duplicates. Parse bounded UTF-8 with fatal decoding, validate each record with PPO's existing parser and additional PostgreSQL candidate identity and encoding restrictions, and retain bounded diagnostic metadata instead of raw record content. Every run must have a contiguous marker sequence from version zero through its latest version. Each successive marker must extend the same complete history prefix and immutable project, task, base SHA and creation time. The canonical record must match the corresponding marker's normalized record, not merely its claimed history hash.

Missing/behind canonical records, missing marker directories as represented by absent files, invalid or unsupported records, divergent history, mismatched versions, duplicate paths and unrecognized entries all block readiness. Unknown entries are hashed, not ignored. Out-of-scope records and unpaired surrogates remain explicit blockers; no silent normalization or repair. Exact source hashes are separate from normalized JSON/history hashes. A digest is not a signature or proof of authenticity.

For complete valid supplied histories, calculate WIP using PPO's existing status policy; block duplicate active projects and more than two active projects. Preserve the current 20-summary legacy catalog truncation hold even though the preflight scans all supplied runs up to 100. Do not silently change the live catalog/admission policy. Empty inventories are not considered ready. Bounds: 100 runs, 100 versions/run in valid histories, 10,100 files, 128 KiB per file and 32 MiB total; oversized/invalid input fails as a whole, not a partial successful manifest. Relative paths are represented as well-formed UTF-8 strings; non-representable filesystem names require a separately reviewed capture format.

## Important limitations

- A caller can omit files, mislabel source identity or supply a forged snapshot. The preflight is a trusted synthetic test seam and does not attest completeness, quiescence, actual directory topology, file identity or filesystem acquisition safety. It never opens paths; no live capture API is introduced. Actual capture must bind directory listings, marker identity and exact source bytes under a reviewed held quiescence boundary.
- The manifest is a digest and diagnostics, not a byte archive, migration authorization, transaction order or target import plan. The original source bytes must be preserved in a separately verified immutable archive. It does not establish how cross-run historical WIP interleavings should be replayed or whether every historical state is admissible.
- `readyForRehearsal` means only the supplied synthetic input meets these conservative source checks. `importAuthorized` and `cutoverAuthorized` are always false. No data is written to PostgreSQL by this slice. The existing filesystem remains the only production authority.

## Verification and next step

The normal regression gates discover the new test. Tests exercise actual synthetic version-marker bytes and unchanged source, order-independent digest, changed whitespace provenance, missing/behind/conflicting canonical records, missing/gapped markers, a separately generated valid divergent history, malformed/unsupported content, unknown paths, duplicate files, WIP limits and legacy catalog truncation.

After this preflight and the direct writer PR are both reviewed, integrate a verified synthetic source capture and bounded target migration rehearsal with exact source archive, full normalized record/version/hash parity, transaction-safe import and recovery-required classification. Do not import existing real records or switch authority. Real writer inventory, held cutover, backup/restore, external workflow integrity and B2c host/claim/nonce integration remain outstanding. RIC-59 and RIC-61 remain held.
