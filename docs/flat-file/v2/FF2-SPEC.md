# FF2 — Import Engine v2 (design spec)

> Phase FF2. **Design spec — awaiting Owner approval at the FF2 gate.** No code until approved; on approval this converts to a task-by-task implementation plan (writing-plans), then subagent-driven build like FF1. Built on the FF1 substrate (shared registry, resolver, ArtifactStore, `ExportJob.snapshotId/marketList`) and the proven `parse → diff → gated-apply` idiom. Honours every FF0 Fidelity Contract clause.

---

## 1. Goal

Take a workbook a human edited in Excel and apply *only their intended changes* to the catalog — safely, transactionally, reversibly — defaulting to the **channel + market they're working in**, never the whole file unless they ask.

## 2. The defining decision: scoped-by-default import (Owner-approved)

The export is the **complete picture** (all channels × markets in one file). The import is a **controlled projection** of it. Rationale: a full import re-diffs columns for markets the operator never refreshed, so *stale-but-non-blank* cells could overwrite fresher DB data. Per-cell diffing + "blank = no change" stop *accidental* edits; **scope** is the second guardrail that stops *stale* ones.

- **Scope = (channel, market).** Default = the channel+market the import was launched from (e.g. `Amazon · IT`). Matches the grid's single-market focus.
- **Widen-on-demand:** a scope selector in the import dialog — `This market (Amazon · IT)` · `This channel, all markets (Amazon · IT/DE/FR/ES/UK)` · `Everything in file`. Default is the narrowest.
- **Transparency, not blindness:** the dry-run computes the **whole** diff but marks out-of-scope changes greyed — *"142 cells differ outside Amazon · IT — not imported (widen scope to include)"*. You always *see* the full delta; you only *apply* your lane.
- **Master/shared data is its own bucket.** The `Products` sheet (title, brand, EAN, base price…) is channel-agnostic and affects *all* channels, so it can't ride along silently with a market-scoped price import. The dry-run surfaces it separately — *"7 master-data changes (affect all channels)"* — as an explicit opt-in checkbox, off by default.

**Contract-preserving:** a full-scope import of an untouched exported file still yields **zero diffs** (round-trip identity, Contract §2). Scope narrows *what you apply by default*, it doesn't weaken the guarantee.

## 3. Pipeline (5 stages, extends the proven idiom)

`ebay-ads-csv.service.ts` proved `parse(pure) → diff(vs live) → gated-apply(audited, dryRun default-true)`. FF2 generalises it to per-cell over `Product + ChannelListing`, adding scope + staleness + rollback.

```
upload .xlsx
  │
  ├─1 PARSE      xlsx → in-memory sheets; tolerant to Excel mutations (§4). Pure, unit-testable.
  ├─2 VALIDATE   structure → registry rules (required/enum/maxLen/UTF-8 bytes/strict) → business rules.
  │              Reuses the FF1 shared registry — grid and file validate identically (Contract §8).
  ├─3 DIFF       per-cell vs current DB + fingerprints. Classifies each cell:
  │              add / update / delete / conflict / no-change / out-of-scope. Resolver-aware (§6).
  ├─4 DRY-RUN    preview: adds/updates/deletes/conflicts/warnings navigable; deletions red;
  │              out-of-scope greyed; master-data bucket separate. dryRun defaults TRUE.
  └─5 APPLY      transactional, batched, with progress. Writes ONLY in-scope, non-conflicting
                 (or resolved) cells. Records the inverse diff for rollback. Per-row results.
```

## 4. Excel-mutation tolerance (Contract §5, the parser's job)

The parser normalises what Excel silently does and **flags anything ambiguous as a warning, never guesses destructively**: scientific-notation identifiers (`8.05E+12` → recover EAN), stripped leading zeros (flag — unrecoverable without the source, warn), auto-date coercion (a SKU that looks like a date), float drift, curly quotes, trailing whitespace, BOM, locale decimals (IT comma vs dot). FF3 fuzzes all of these.

## 5. Action + blank semantics (Part IV, exact)

First column on every editable sheet:

| `Action` | meaning |
|---|---|
| *(blank)* | update in-scope cells that differ |
| `ADD` | create the product / listing |
| `DELETE` | delete — **typed confirmation required** (`DELETE N PRODUCTS`); dry-run shows the full cascade (e.g. a parent's children) |
| `IGNORE` | skip the row |

Cell-level: **blank = no change**; **`__CLEAR__` = set empty**. A missing row NEVER means delete (Contract §4). These close the FF0 findings F4/F7 (silent detach / blank-overwrite) by construction.

## 6. Resolver write-back (the FFD10 inverse — the subtle part)

FF1 *exported* per-market values as `value + follows_master@MKT`. FF2 *imports* them by writing the correct resolver layer, atomically:

- Editing `price@IT` while `price_follows_master@IT` is `true` → on apply, write `priceOverride` **and** set `followMasterPrice=false` in one transaction, so the edit actually takes effect (kills the FF0 F2 silent-no-op).
- Setting `price_follows_master@IT` back to `true` → clear the override, re-attach to master.
- The diff engine reads the same `resolveEffective` FF1 uses, so "changed vs current" compares like-for-like.

## 7. Conflict / staleness (Contract §6, uses FF1's snapshot)

Every exported file carries `snapshotId` + per-row fingerprints (`_meta`) and the `ExportJob.snapshotId/marketList` FF1 persisted. On import:

- A cell changed **in the file** AND changed **in the DB since `snapshotId`** ⇒ **conflict**, shown in the dry-run with both values + timestamps.
- Default resolution **file-wins** (source-of-truth doctrine, FFD5), always displayed, per-field override to pick DB-wins.
- If the file's market set ≠ current live markets (a market appeared/left since export), that's surfaced, never silently dropped.

## 8. Persistence, report, rollback (Contract §9)

- **`ImportJob` / `ImportJobRow`** (FF1 audited these exist): extend to store the **uploaded file bytes** (via `ArtifactStore` — FF1's), the **pre-apply diff**, who/when, per-row results, and the **inverse diff**.
- **Processing report:** an annotated copy of the uploaded file — original columns + `Status` + `Errors` — downloadable for the fix-and-reimport loop.
- **One-click rollback:** replay the recorded inverse diff in a transaction. (FF1 finding F6: today's "abort" doesn't roll back — FF2 apply is genuinely transactional in batches.)
- **One import at a time** (lock); grid edits mid-import defined; snapshot isolation.

## 9. Surface (respects the untouchable constraint)

The untouchable editors (`products/amazon-flat-file`, `products/ebay-flat-file`) already host the proven `ImportWizardModal` / `PullDiffModal` dry-run UI. FF2 does **not** modify those pages. It builds the import on the **editable shared substrate** (`components/flat-file/*`, `_shared/*`) + a new server pipeline, and exposes it where the workbook export lives (the `ExportJob`/bulk-operations surface) — with the dry-run modal reusing the established `PlanCell` diff pattern. Scope is a first-class control in that dialog, seeded from the launch context.

## 10. File structure (all server code under `apps/api/src/services/flat-file/import/`)

| file | responsibility |
|---|---|
| `parse.ts` | xlsx → sheets; Excel-mutation normalisation + ambiguity warnings |
| `validate.ts` | registry-driven validation (reuses FF1 registry) |
| `scope.ts` | resolve (channel, market) scope; classify each cell in/out of scope |
| `diff.ts` | per-cell diff vs DB + fingerprints; resolver-aware; conflict detection |
| `apply.ts` | transactional batched apply; resolver write-back; inverse-diff capture |
| `report.ts` | processing-report generator (annotated workbook) |
| `import.service.ts` | orchestrator: `previewImport` (dry-run) + `applyImport` (gated) |
| `rollback.ts` | replay inverse diff |
| (extend) `ImportJob`/`ImportJobRow` schema | file bytes, diff, inverse diff — reversible migration |

## 11. Phased task outline (detailed task-by-task plan follows on approval, via writing-plans)

1. **Parser + Excel-mutation normalisation** (pure, fuzz-ready).
2. **Registry-driven validation** (shared with grid).
3. **Scope resolver** (channel+market; in/out classification; master-bucket split).
4. **Diff engine** (per-cell vs DB + fingerprints, resolver-aware, conflicts).
5. **Dry-run preview API** (`previewImport` → adds/updates/deletes/conflicts/warnings + scope + master-bucket).
6. **Transactional apply** (batched, resolver write-back, inverse-diff capture, DELETE typed-confirm).
7. **Conflict/staleness** (snapshotId + fingerprints; file-wins default + per-field override).
8. **ImportJob persistence + processing report** (store file/diff/results; annotated report).
9. **One-click rollback** (inverse diff replay).
10. **Dry-run + scope UI** (shared substrate; reuse `PlanCell`; scope selector; greyed out-of-scope; master opt-in).
11. **CI round-trip + fuzz suite** (export→import(untouched)→zero diffs; export→import→export→identity; Excel-mutation fuzz — proves Contract §2/§5).

Each ships with its tests, `.js` ESM imports (FF1 lesson), and per-task review — same rhythm as FF1.

## 12. Verification (FF2 gate)

- **Round-trip identity:** export a scoped set → import untouched → **zero diffs** (CI).
- **Scope safety:** an import scoped to `Amazon · IT` with divergent `DE` columns applies **nothing** to DE; the dry-run shows DE as out-of-scope.
- **Resolver write-back:** editing a `follows_master` value flips the flag + writes the override (unit + live).
- **Destructive guard:** `DELETE` requires the typed phrase; missing/blank rows never delete.
- **Rollback:** apply → rollback → DB back to pre-import state (verified by fingerprint).
- Live smoke: real edited workbook → import → apply → export → files identical except the intended edits (the Owner's literal acceptance test).

## 13. Risks / open items

- **R1 — Full-file scope + master data blast radius:** mitigated by scoped-default + separate master bucket + typed DELETE. The one place to watch is `ADD` of a new parent+children family (structural) — dry-run must show the whole family it will create.
- **R2 — Conflict UX complexity:** per-field override could overwhelm on a big diff; default file-wins + a bulk "accept all file / all DB" keeps it manageable.
- **R3 — Depends on FF1 in prod:** FF2 apply reads `ExportJob.snapshotId` (shipped) and the `_meta` fingerprints. Confirm FF1 export is exercised before FF2 import relies on it.
- **R4 — Storage (FF1 I1):** the processing report + stored upload use `ArtifactStore`; durable large-file handling wants `STORAGE_PROVIDER=S3/R2` in prod (Owner decision, carried from FF1).
- **R5 — Untouchable editors:** the import surface must not modify `products/*-flat-file`; reuse the shared substrate + a new surface.

---

**Gate ask:** approve this design (or adjust) → I convert it to a task-by-task implementation plan (writing-plans) and build it subagent-driven, exactly as FF1. Scope model, resolver write-back, and the transactional/reversible apply are the load-bearing decisions to confirm.
