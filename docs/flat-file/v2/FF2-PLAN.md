# FF2 — Import Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task ends with an independently-testable deliverable; at execution every task runs red → green → commit.
>
> **Design:** `docs/flat-file/v2/FF2-SPEC.md` (Owner-approved). **⛔ HARD CHECKPOINT after Task 5:** Tasks 1-5 are read-only (parse/validate/scope/diff/preview). Tasks 6-11 mutate the live catalog (apply/rollback) — do NOT build them until the Owner approves the dry-run foundation.

**Goal:** Apply a human-edited workbook to the catalog safely — scoped by default to the current channel+market, transactional, reversible — via `parse → validate → scope → diff → dry-run → gated apply`.

**Architecture:** A new `apps/api/src/services/flat-file/import/` pipeline. Pure parse/validate/scope/diff stages feed a dry-run preview; a transactional apply writes only in-scope, non-conflicting cells through the FF1 resolver (override + follow-flag), recording an inverse diff for rollback. Reuses the FF1 registry, `resolveEffective`, `ArtifactStore`, and `ExportJob.snapshotId`/`_meta` fingerprints.

**Tech Stack:** TypeScript (Node ESM), Prisma, `exceljs`, Vitest, `node:crypto`.

## Global Constraints (verbatim, bind every task)

- **ESM:** every relative import ends in `.js` (repo is `type:module`; `moduleResolution:bundler` hides missing extensions from tsc/vitest but Node ESM boot-crashes — see the FF1 incident). Verify with `npx tsc` emit + `node --input-type=module -e "await import('./dist/…')"`.
- **Scope (Owner decision):** import scope = `(channel, market)`, default = launch context (e.g. `Amazon·IT`); widen selector = market / channel-all-markets / everything. Out-of-scope cells are **diffed but never applied**; shown greyed. Master/`Products` sheet = separate opt-in bucket (affects all channels), off by default.
- **Blank/clear (Contract §4):** blank cell = no change; `__CLEAR__` = set empty. A missing row NEVER deletes. `DELETE` action needs typed `DELETE N PRODUCTS` and shows the full cascade.
- **Resolver write-back (FFD10):** importing a governed per-market value writes `*Override` AND sets `followMaster*=false` atomically; setting `*_follows_master@MKT=true` clears the override.
- **Read-only until apply:** Tasks 1-5 issue zero catalog writes. Apply (Task 6+) is transactional, batched, records an inverse diff.
- **Untouchable:** no edits to `apps/web/src/app/products/amazon-flat-file/**` or `ebay-flat-file/**`.
- **Determinism/registry:** validation uses the FF1 shared registry so grid and file validate identically (Contract §8).
- Commit subjects: `feat(flat-file): FF2.N — …`; commit only your files by explicit path (concurrent sessions share main).

## File Structure

| file | responsibility |
|---|---|
| `import/parse.ts` | xlsx → `ParsedWorkbook`; Excel-mutation normalisation + ambiguity warnings |
| `import/validate.ts` | registry-driven cell validation (required/enum/maxLen/UTF-8/strict) |
| `import/scope.ts` | resolve `(channel, market)` scope; classify each cell in/out of scope; split master bucket |
| `import/diff.ts` | per-cell diff vs DB + fingerprints; resolver-aware; conflict detection |
| `import/import.service.ts` | orchestrator: `previewImport` (dry-run) then (Task 6) `applyImport` |
| `import/apply.ts` (Task 6) | transactional batched apply + resolver write-back + inverse-diff capture |
| `import/report.ts` (Task 8) | processing-report generator (annotated workbook) |
| `import/rollback.ts` (Task 9) | replay inverse diff |
| tests under `import/__tests__/` | per-task vitest + the CI round-trip/fuzz suite (Task 11) |

---

## Task 1: Parser + Excel-mutation normalisation

**Files:** Create `import/parse.ts`; Test `import/__tests__/parse.vitest.test.ts`.

**Interfaces — Produces:**
```ts
export interface ParsedCell { raw: unknown; value: string; warning?: string }
export interface ParsedRow { sheet: string; rowNumber: number; cells: Record<string, ParsedCell> } // keyed by header (e.g. 'price@IT')
export interface ParsedWorkbook { sheets: Record<string, { headers: string[]; rows: ParsedRow[] }>; meta: { snapshotId?: string; schemaVersion?: string; markets?: Record<string,string[]> }; parseWarnings: string[] }
export async function parseWorkbook(bytes: Uint8Array): Promise<ParsedWorkbook>
```

**Approach:** load with `exceljs`; read every visible sheet + the hidden `_meta`. For each cell, `normalizeCell(raw)` returns `{ value, warning? }`: numbers that look like coerced identifiers (scientific notation on an id column) → recover + warn; Excel date serials where a string was expected → warn; trim trailing whitespace; strip BOM; curly quotes → straight; leave `__CLEAR__` intact. Never guess destructively — ambiguous → keep raw + `warning`. Pull `snapshotId`/`markets` from `_meta`.

**Test (key cases):**
```ts
it('recovers a scientific-notation EAN and warns', () => { /* cell raw 8.05e12 on header 'ean' → value '8054323310123' (or flagged), warning set */ })
it('keeps __CLEAR__ and blank distinct', () => { /* '' → value '' no-op marker; '__CLEAR__' → value '__CLEAR__' */ })
it('reads _meta snapshotId + markets', () => { /* from a generated FF1 workbook fixture */ })
```
**Done when:** a real FF1-generated workbook parses to `ParsedWorkbook` with `_meta` populated and mutation warnings surfaced.

---

## Task 2: Registry-driven validation

**Files:** Create `import/validate.ts`; Test `import/__tests__/validate.vitest.test.ts`.

**Interfaces:**
- Consumes: `ParsedWorkbook` (T1); FF1 `MASTER_FIELDS`/`CHANNEL_MARKET_FIELDS` + `FieldDefinition` from `../registry/*`.
- Produces:
```ts
export interface ValidationIssue { sheet: string; rowNumber: number; column: string; level: 'error'|'warn'; message: string }
export function validateWorkbook(wb: ParsedWorkbook): ValidationIssue[]
```

**Approach:** map each header (`price@IT` → base field `price`) to its `FieldDefinition`; apply the SAME rules the grid enforces: `required` (error if blank on ADD), enum membership (`strict` → error, `open` → warn) honoring `enumOptions`, `maxLength`, `maxUtf8ByteLength` (`new TextEncoder().encode`), boolean coercion. Readonly columns present → informational warn ("ignored on import"). Reuse the FF1 registry so rules never drift.

**Test:** over-long UTF-8 title → error; non-enum `status` (strict) → error; readonly `buybox_price` populated → warn; valid row → no issues.
**Done when:** validation mirrors the grid's rule set, driven entirely by the shared registry.

---

## Task 3: Scope resolver (the Owner decision)

**Files:** Create `import/scope.ts`; Test `import/__tests__/scope.vitest.test.ts`.

**Interfaces:**
```ts
export type ImportScope = { channel: 'AMAZON'|'EBAY'|'SHOPIFY'; markets: string[] | 'ALL'; includeMaster: boolean }
export interface ScopedColumn { sheet: string; column: string; base: string; market?: string; inScope: boolean; isMaster: boolean }
export function classifyColumns(wb: ParsedWorkbook, scope: ImportScope): ScopedColumn[]
export function defaultScope(launch: { channel: 'AMAZON'|'EBAY'|'SHOPIFY'; market: string }): ImportScope // { channel, markets:[market], includeMaster:false }
```

**Approach:** parse each channel-sheet header into `(base, market)` (`price@IT` → base `price`, market `IT`); a `Products`-sheet column is `isMaster`. `inScope` = column's sheet channel === scope.channel AND (scope.markets==='ALL' || market ∈ scope.markets); master columns `inScope` only if `scope.includeMaster`. `defaultScope` = this-market-only, master off.

**Test:** `defaultScope({channel:'AMAZON',market:'IT'})` → `price@DE` out-of-scope, `price@IT` in-scope, `Products!brand` out-of-scope (master off); widening `includeMaster:true` → `brand` in-scope; `markets:'ALL'` → `price@DE` in-scope.
**Done when:** classification matches the scope model; default is this-market, master-off.

---

## Task 4: Diff engine (per-cell, resolver-aware, conflicts)

**Files:** Create `import/diff.ts`; Test `import/__tests__/diff.vitest.test.ts`.

**Interfaces:**
- Consumes: `ParsedWorkbook`, `ScopedColumn[]`, FF1 `resolveEffective` + registry; a prisma fetch of current rows (reuse FF1 `fetchCatalog` shape).
- Produces:
```ts
export type CellChange = { sku: string; channel?: string; market?: string; column: string; from: unknown; to: unknown; kind: 'add'|'update'|'delete'|'no-change'|'conflict'|'out-of-scope'; note?: string }
export interface ImportDiff { changes: CellChange[]; masterChanges: CellChange[]; stats: { adds:number; updates:number; deletes:number; conflicts:number; outOfScope:number }; actionRows: { sku:string; action:'ADD'|'DELETE'|'IGNORE'|'' }[] }
export function computeDiff(wb: ParsedWorkbook, scoped: ScopedColumn[], current: WorkbookData, opts: { snapshotId?: string; fingerprints?: Record<string,string> }): ImportDiff
```

**Approach:** for each in-scope editable cell: compute `to` (file value; `__CLEAR__`→empty; blank→skip=no-change) and `from` (current effective value via `resolveEffective` for governed fields, else the DB column). Equal → `no-change`; differ → `update` (or `add` if the row's `Action==='ADD'`/row is new). Out-of-scope cells → `out-of-scope` (recorded, not applied). Conflict: if a fingerprint shows the row changed in DB since `snapshotId` AND this cell differs in the file → `conflict` (carry both values). `DELETE` action rows → `delete` changes (+ expand cascade in Task 6's preview). Master-sheet changes go to `masterChanges`.

**Test:** untouched exported file → all `no-change` (round-trip identity, unit-level); a changed `price@IT` while `follows_master@IT=true` → `update` with `from`=master value; out-of-scope `price@DE` edit → `out-of-scope`; stale fingerprint + file edit → `conflict`.
**Done when:** the diff classifies every cell correctly, is resolver-aware, and an untouched file yields zero real changes.

---

## Task 5: Dry-run preview orchestrator (read-only) — ⛔ CHECKPOINT

**Files:** Create `import/import.service.ts`; Test `import/__tests__/preview.vitest.test.ts`.

**Interfaces:**
- Consumes: T1-T4 + prisma fetch.
- Produces:
```ts
export async function previewImport(prisma: any, bytes: Uint8Array, scope: ImportScope): Promise<{ validation: ValidationIssue[]; diff: ImportDiff; scope: ImportScope; meta: ParsedWorkbook['meta'] }>
```

**Approach:** `parseWorkbook` → `validateWorkbook` → `classifyColumns(scope)` → fetch current rows for the affected SKUs → load `_meta` fingerprints + reconcile `snapshotId` against `ExportJob` → `computeDiff`. Returns everything the dry-run UI needs; **writes nothing**. This is the safety gate for all destructive work.

**Test:** end-to-end with a mocked prisma + a real FF1 workbook fixture: untouched → zero changes; a scoped edit → exactly that change in-scope, siblings out-of-scope.
**Done when:** `previewImport` returns a complete, correct dry-run with zero DB writes.

> **⛔ STOP — Owner go-ahead required before Task 6.** Demonstrate the dry-run on a real edited workbook; only then build the mutating apply.

---

## Task 6: Transactional apply + resolver write-back (MUTATING)

**Files:** Create `import/apply.ts`; extend `import.service.ts` with `applyImport`; Test `import/__tests__/apply.vitest.test.ts`.

**Interfaces:**
```ts
export interface ApplyResult { applied: number; skipped: number; failed: number; rows: { sku:string; status:'SUCCESS'|'FAILED'|'SKIPPED'; error?:string }[]; inverseDiff: CellChange[] }
export async function applyImport(prisma: any, diff: ImportDiff, opts: { scope: ImportScope; deleteConfirmation?: string; conflictPolicy: 'file-wins'|'db-wins'|Record<string,'file'|'db'> }): Promise<ApplyResult>
```

**Approach:** batched `$transaction` (e.g. 100 rows/tx). Apply ONLY in-scope, non-conflicting (or resolved) `update`/`add` changes. Governed per-market value → write `*Override` + set `followMaster*=false`; `*_follows_master=true` → clear override. `add` → create Product/ChannelListing. `delete` → require `deleteConfirmation==='DELETE N PRODUCTS'`, soft-delete + cascade. Capture the inverse (`to`→`from`) per cell into `inverseDiff`. On mid-batch failure: that batch rolls back; already-committed batches stand; per-row status recorded (honest — no false "all rolled back").

**Test:** apply a `price@IT` override edit → DB has `priceOverride` set + `followMasterPrice=false`; apply→verify inverseDiff reverses it; DELETE without the phrase → throws; out-of-scope change is never written.
**Done when:** apply is transactional, resolver-correct, scope-bounded, and produces a replayable inverse diff.

---

## Task 7: Conflict / staleness resolution

**Files:** Extend `diff.ts`/`apply.ts`; Test `import/__tests__/conflict.vitest.test.ts`.

**Approach:** surface `conflict` cells with both values + timestamps; `conflictPolicy` default `file-wins`, with per-field override and bulk accept-all-file/all-db. A market-set mismatch (file markets ≠ live) is reported, never silently dropped.
**Test:** stale cell with `file-wins` → file value applied; `db-wins` → unchanged + noted; per-field override respected.
**Done when:** conflicts are always shown and resolved per policy, never silently.

---

## Task 8: ImportJob persistence + processing report

**Files:** Create `import/report.ts`; extend `import.service.ts`; migration extending `ImportJob`/`ImportJobRow` (store uploaded file handle via `ArtifactStore`, pre-apply diff, inverse diff); Test `import/__tests__/report.vitest.test.ts`.

**Approach:** persist the upload (ArtifactStore), the dry-run diff, per-row results, and the inverse diff on `ImportJob`. `generateReport(wb, result)` → annotated workbook copy: original columns + `Status` + `Errors` per row, downloadable for fix-and-reimport. Reversible migration (nullable columns / a child table).
**Test:** report has a Status+Errors column per input row; failed rows carry the error.
**Done when:** every import is auditable and produces a downloadable processing report. **(Migration = Owner approval gate.)**

---

## Task 9: One-click rollback

**Files:** Create `import/rollback.ts`; Test `import/__tests__/rollback.vitest.test.ts`.

**Approach:** `rollbackImport(prisma, jobId)` loads the stored `inverseDiff` and applies it via the same transactional `applyImport` path (as a new, linked ImportJob). Idempotent guard (can't roll back twice).
**Test:** apply → rollback → DB fingerprint matches pre-import; second rollback is a no-op.
**Done when:** any import fully reverses in one action.

---

## Task 10: Dry-run + scope UI (shared substrate, untouchable-safe)

**Files:** New components under `apps/web/src/components/flat-file/import/` (or `_shared/`); a route on the existing bulk-operations/export surface; Test (component/interaction).

**Approach:** reuse the proven `PlanCell` dry-run pattern (adds/updates/deletes/conflicts navigable, deletions red). Add the **scope selector** (default this-market, seeded from launch context), the greyed **out-of-scope** section with a "widen to include" affordance, and the separate **master-data opt-in** bucket. DELETE typed-confirmation modal. Wire to `previewImport`/`applyImport`. **No edits to the untouchable editor pages.**
**Test:** scope selector changes which cells show in-scope; out-of-scope greyed; master toggle moves master changes in/out; DELETE gated on the typed phrase.
**Done when:** an operator can upload → see a scoped dry-run → widen/confirm → apply, entirely on the shared substrate.

---

## Task 11: CI round-trip + Excel-mutation fuzz suite

**Files:** `import/__tests__/roundtrip.vitest.test.ts`, `import/__tests__/fuzz.vitest.test.ts`.

**Approach:** **export→import(untouched)→zero diffs** (generate a workbook via FF1 `buildCatalogWorkbook`, feed to `previewImport`, assert zero real changes). **export→import→export→identity.** Fuzz: feed the parser Excel-mutated variants (locale decimals, EAN scientific-notation/leading-zero, date coercion, whitespace/BOM, curly quotes) and assert normalisation + warnings. Wire into CI so any regression fails the build.
**Done when:** the round-trip identity + fuzz suites are green and gating.

---

## Verification (FF2 gate)

```bash
cd apps/api && npx vitest run src/services/flat-file/import      # all import tests
npx vitest run src/services/flat-file                            # nothing regressed
cd .. && npx tsc -p apps/api/tsconfig.json --noEmit              # types
# ESM boot guard (the FF1 lesson):
cd apps/api && npx tsc && node --input-type=module -e "await import('./dist/services/flat-file/import/import.service.js'); console.log('ESM ok')"
git diff --name-only | grep -E '^apps/web/src/app/products/(amazon|ebay)-flat-file/' && echo 'UNTOUCHABLE VIOLATED' || echo 'untouchable intact'
```
Plus the Owner's literal acceptance test (live): export → edit real cells (incl. a tricky EAN + an IT decimal) → import (scoped) → apply → export → files identical except the intended edits.

## Self-review

- **Spec coverage:** scope model (T3), Excel tolerance (T1), registry validation (T2), diff+conflict (T4/T7), dry-run (T5), transactional/reversible apply (T6/T9), report (T8), UI (T10), round-trip/fuzz (T11), untouchable + ESM constraints (global). ✓ Every FF2-SPEC section maps to a task.
- **Read-only/destructive split:** Tasks 1-5 write nothing; the checkpoint precedes Task 6. ✓
- **Type consistency:** `ParsedWorkbook`/`ScopedColumn`/`ImportScope`/`ImportDiff`/`CellChange`/`ApplyResult`/`previewImport`/`applyImport` consistent across tasks. ✓
- **Dependencies:** FF1 shipped (`resolveEffective`, registry, `ArtifactStore`, `ExportJob.snapshotId`). ✓
- **Migrations (Task 8) + apply (Task 6+) are Owner-gated.** ✓
