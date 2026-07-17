# FS5 — Retention & archival stance

One page, because the policy is one sentence: **nothing is ever deleted — append-only forever, with streamed full-table exports as the archival path.** (FS-FC-PROPOSAL §2 FS5; FD8 unchanged.)

## The policy

- **MovementLedger and AuditLog are append-only, forever.** Corrections are compensating entries (the FD8 rule); there is no deletion or windowing path, and none is planned. SQLite at the design targets carries this comfortably: FS0 measured the harness DB at ~1.2 GB for 3.4M+ rows, and the FS1 covering indexes keep every hot fold index-only regardless of ledger age.
- **Archival = export, not purge.** `/api/exports/ledger` (full movement ledger) and `/api/exports/audit` (full audit trail, new in FS5) are STREAMED full-table CSVs — id-cursor batches of 1,000, memory-flat at 1.2M+ rows (FS1's streamed-export pattern in its PK-keyset shape; insertion order = cuid id order, so no in-memory id spine). Both are linked from Settings → Import/Export, both are Owner/exports-gated, and each run is itself audited (EPF1 D-15-audit). `/api/exports/orders` (EPO-owned) already streams business slices.
- **Snapshots are disaster-recovery COPIES, not the archive.** The worker's nightly `VACUUM INTO` writes `.snapshots/factory-YYYY-MM-DD.db` and rotates old copies out; rotation deletes copies of data that still lives, in full, in the live file. Hour and retention are configurable via AppSetting `snapshot.config` (`{"hour": 0-23, "keep": 1-365}`, defaults 3 / 14); each run logs + stamps duration and sizes on AppSetting `snapshot.last`.

## Measured budgets (1.2 GB harness clone, 2026-07-17, Owner-class machine)

| Operation | Measured |
|---|---|
| `wal_checkpoint(TRUNCATE)` before the copy | ~10 ms idle (folds the day's WAL so VACUUM INTO reads one compact source) |
| `VACUUM INTO` (1.26 GB live → 1.22 GB snapshot, FTS included) | **~5.5 s** |
| `fs5_fts` migration incl. full backfill (60k conversations · 1.4M messages · 60k quotes · 50k orders · 830 parties) | ~3.9 s |
| FTS `MATCH` lookups (message body → conversations, zero-hit and hit cases) | 0.02–0.3 ms (vs 128–173 ms LIKE correlated scan) |

## Restoring a snapshot (the one caveat)

The four external-content FTS indexes (conversation/message/quote/order) key on implicit rowids, and VACUUM may renumber those in the copy. The LIVE file is never VACUUMed in place, so the running indexes are always consistent — but **after restoring a `.snapshots/` file, run `npm run fts:rebuild -w @nexus/factory`** (or per table: `INSERT INTO conversation_fts(conversation_fts) VALUES('rebuild');` …). `party_fts` is self-contained and survives restore untouched. Search degrades to the LIKE fallback rather than breaking if the FTS tables are ever missing entirely.
