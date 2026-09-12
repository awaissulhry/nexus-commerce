# Wave 4 design — formulas, import/export, scale & writability, chrome

Hub-authored under Owner directive #454 (2026-09-02 05:10: every design, UX and functional decision
is made in the hub; lanes measure, implement and verify). **Status: DRAFT for the Owner's approval.
Nothing in it is built until the Owner rules on it.** Each section names what was MEASURED before it
was designed, the decisions (numbered D16.x etc.), what is deliberately not in v1, and the lanes
that build it. Section 1 is complete; sections 2–4 follow in this file.

---

## 1. Formulas (Owner D16, ruling #442)

### 1.0 The Owner's words

> "I want to be able to set the formula directly in the mapping page or override it for a specific
> product, specific scope, specific market, or specific language… I'll write text in the title
> field. Let's say I write 'Gale Jacket', then I insert the formula inside the title attribute or
> title column. I'd simply write some formula that automatically fetches or gets whatever I wrote
> in the column Brand or Athlete Type… I'd simply write the formula in the title column, and it
> gets written. The UI has to be absolutely pinnacle, and also the UX. I would not compromise at
> all on it."

### 1.1 What was measured before designing (2026-09-02 06:05, hub, read-only)

- **A formula engine already exists and is the mapping engine's own:** `apps/api/src/services/pim/
  mapping/expr.ts` (PES.6.3) — Rithum's template-editor language, a hand-written tokenizer + Pratt
  parser + tree-walking evaluator (never `eval`), with `$brand`, `$foo.bar` and `{{ foo.bar }}`
  references, `+ − * / %`, comparisons, `&& ||`, string literals, and **34 functions**: `if`,
  `coalesce`, `isblank`, `notblank`, `contains`, `startswith`, `endswith`, `concat`, `text`,
  `upper`, `lower`, `title`, `trim`, `len`, `left`, `right`, `substr`, `replace`, `split`, `join`,
  `pad`, `number`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `margin`, `markup`, `discount`,
  `vat`, `exvat`, `rule("name")`. Exported API: `parseExpr`, `evaluateExpr(src, ctx)`,
  `validateExpr(src)` (message + position), `exprDependencies(src)` (attributes + rules referenced).
- **Failure model already ruled:** `evaluate()` never throws — `{ value: null, warnings, error }`;
  a broken formula reads as UNRESOLVED, never as a silently-empty success.
- **It is already one `TransformOp` (`{ type: 'expr' }`) beside `{ type: 'template', expr }`** in
  `Marketplace.schemaMapping` (`schema-mapping.service.ts:31–80`), so `resolveChannelField →
  payload-preview → publish-validator → mapping-simulate` all evaluate it: **what you preview is
  what ships.** Rule kinds on the field catalogue: `unmapped | attribute | constant | expression |
  businessRule`. Revisions exist (`MappingRevision`: channel, code, version, snapshot, changedBy,
  reason).
- **Scope of mapping rules today:** per marketplace (`Marketplace.schemaMapping`), i.e. channel ×
  market. There is no per-product, per-locale, or master-level formula today.
- **How a derived value reaches the sheet:** the `mapped` object on the wire (`status: 'mapped' |
  'unmapped'`, #367) and `productLevelOnly` on the run (#379); the grid marks it `mapped` /
  `mappedShared` (§9.6, `provenance.ts`). A per-market cell follows master unless pinned (FFD10).
- **How a cell is written:** master `commitMasterRow` (bulk PATCH, `Product.version` CAS, #201);
  channel `attr_<key>` into `overrideData` with the listing version bumped (#449). Every declared
  column now has a cell with its own `writable`/`writeVerb` (#458).
- **Every value is validated on the way in:** caps in both units with `capFrom` (#382–#418),
  closed lists (23 of 96 columns on GALE-JACKET), required.

**Consequence:** the Owner's feature is the EXPOSURE of one existing engine in two new places — a
cell, and a per-product override — not a second engine. Nothing below invents a language.

### 1.2 Decisions

**D16.1 — One language, the one that exists.** A formula is an `expr.ts` expression. The Owner's
example is written, in a cell:

```
="Gale Jacket " + $brand + " " + $athlete_type
```

No template dialect in cells (`{{brand}}` inside plain text is NOT interpreted — an operator who
types braces gets braces; the `template` transform stays available on the mapping page as it is
today, presented as the same language). The `=` prefix is the cell's mode switch, exactly as in
Excel; on the mapping page every field is a formula, so no prefix. An Excel-literate operator needs
no manual: `+` joins text, `if(...)`, `upper(...)`, `round(...)` read as they do in a spreadsheet.

**D16.2 — Three places a formula can live, one precedence chain, one mark.** Highest first:

| level | set where | applies to | stored as |
|---|---|---|---|
| **Cell override** | typed into a cell (`=…`) or the drawer's field | one product × scope × market × locale | on the product's own record (`overrideData` for a channel cell; a master formula field for master) |
| **Mapping rule** | the mapping page (exists) | every product of a channel × market (× product type where the field is per type) | `Marketplace.schemaMapping` (exists) |
| **Master rule** *(new, small)* | a "Master" tab on the mapping page | every product's master field (e.g. `name` = `$brand + " " + $product_type`) | the same rule shape, keyed `channel: 'master'` |

The precedence is the one the operator expects: what they typed on THIS cell beats the rule for the
channel, which beats the rule for master. A literal typed into a cell that has a rule behind it is
already the `pinned` state (FFD10); a formula typed into it is the new `formula` state. **The cell
shows ONE mark** (§9.6b's test: does the state change what the operator does next? Yes — editing a
formula cell edits the formula, not the text):

- `formula` — a cell-level formula (new §9.6 member, glyph `ƒ`). Precedence in the mark vocabulary:
  `ai` > **`formula`** > `mappedShared` > `mapped` > chain — a formula is an explicit operator
  instruction, so it outranks a channel mapping; an AI draft still outranks it because it is an
  unaccepted proposal awaiting a decision.
- Rules keep their existing marks (`mapped` / `mappedShared`); the tooltip names the rule.

**D16.3 — The cell shows the VALUE; the formula is one hover and one click away.** At rest a
formula cell renders its evaluated value with the `ƒ` mark; hover shows the formula and its source
cells; opening the editor shows the formula (not the value) in a monospace field with `$`
autocomplete of the row's column keys (English label beside each key), and a live preview line
under the field — the result the server would store, from the mapping engine's simulate service,
debounced. Enter commits; Esc cancels. The drawer's field shows value + formula + "Edit formula".

**D16.4 — Evaluation is server-side, on write, and materialised.** Typing `=…` sends the formula;
the server validates (`validateExpr`), evaluates against the row (`evaluateExpr` with the same
`lookup` the mapping engine uses), stores BOTH the formula and the evaluated value, and returns the
cell with `provenance: 'formula'`. The stored value is what publishes, exports, sorts and filters —
the grid never evaluates. A formula whose result would be refused by the field's validation (over a
cap in either unit, not in the closed list, empty where required) is stored as a formula with an
ERROR state: the cell shows `⚠ ƒ`, no value, the message in the tooltip — never a stale value, never
a silently invented one (#370).

**D16.5 — Re-evaluation follows dependencies, using what exists.** `exprDependencies()` lists the
attributes a formula reads. Each stored formula records its dependencies; a write to any of them
re-evaluates the formulas that depend on it — for a cell formula, on that product (and its aliases
if `productLevelOnly`); for a mapping/master rule, on every product of the channel × market as a
JOB with progress (the mapping propagation job that exists for rule changes today — same shape,
same console). A formula may not reference its own field (refused at save with the position); a
cycle across fields is refused at save by walking the dependency graph (≤ ~100 fields per product,
trivial). Evaluation order within a product is a topological order of that graph.

**D16.6 — Manual override of a formula.** Typing a literal into a formula cell replaces the formula
with a pinned literal (the operator's latest explicit act wins) and the formula becomes a restore
point (#366's restore points already carry per-field history) — "Restore formula" is one click in
the cell menu and in the drawer. Deleting the cell's content removes the override and the cell
falls back to the next level in the chain, marked accordingly.

**D16.7 — Import/export carries formulas.** Export writes the evaluated value in the field's column
and the formula in a sibling `<key>.formula` column, only for cells that have one; import of a
`=`-prefixed cell value sets a formula through the same write path (D16.4). (Detail in §2.)

**D16.8 — Scope, market, language.** A cell override is keyed to the coordinate it was typed on
(scope × market × locale); the studio already addresses every cell by that coordinate. A formula
typed on master applies to master; on Amazon·DE to that listing's DE fields; on a locale-specific
field to that locale. No "apply to all markets" magic in v1 — the mapping page is where a rule
spans markets, and it already does.

### 1.3 The UX, end to end (GALE-JACKET, master, `name`)

1. Operator clicks `name` on a child row, types `=` — the editor switches to formula mode (mono
   font, `ƒ` in the cell's left edge), the `$` key opens autocomplete: `$brand — Brand`,
   `$athlete_type — Athlete Type`, …, filtered as they type.
2. `="Gale Jacket " + $brand + " " + $athlete_type` — the preview line reads
   `Gale Jacket XAVIA Motorcyclist` (or `⚠ unknown attribute $athlete_typo at 26` in red).
3. Enter → the cell shows `Gale Jacket XAVIA Motorcyclist` with the `ƒ` mark; tooltip: the formula
   and `reads: brand, athlete_type`.
4. Operator edits `brand` on that row → `name` re-evaluates on the server and the cell updates
   (the sheet's live refresh already re-reads a written row).
5. Operator types `Custom title` into `name` → the cell is `pinned`, tooltip offers
   "Restore formula".
6. On the mapping page, "Master" tab, `name` rule = `$brand + " " + $product_type` → a job runs
   over every product; products with a cell formula or a pin keep theirs (precedence), shown as
   such.

### 1.4 Not in v1, and why

- Cross-product references (lookups into other products or tables) — a different engine and a
  different failure model; the Owner's cases are within a row.
- Aggregates over the family (`count`, `sum` across children) — the bulk arithmetic verb (Owner
  queue item 8) is the right home for "+5% on every child"; a per-row formula stays per row.
- AI inside formulas — no AI, zero spend (standing).
- A formula bar above the grid — the cell editor with a preview line is the simpler mechanism;
  revisit if operators ask for it (§14's rule: one way to do a thing).
- Formulas on read-only or system columns (`sku`, readiness, status of a listing) — not writable,
  so not formula-able; the editor does not offer `=` there.

### 1.6 Corrections from PES.6's read-back (2026-09-02 06:1x, file:line) — RATIFIED, they amend the decisions above

The Owner approved §1 as written at 06:12; PES.6's read-back arrived in the same minute with four
corrections and six facts. The corrections stand and amend D16.1–D16.5 as follows; the approved
design is §1 WITH this section.

- **(A) A cell formula is NEVER stored in `overrideData` as a string** (`attribute-resolver.ts:258`
  applies `overrideData` as a VALUE layer with provenance `channelOverride`; a formula string there
  would publish literally as the value and preflight would call it valid). **D16.2's "stored as"
  column is replaced:** the formula lives in its own per-product store — `CellFormula { productId,
  scope, channel?, marketplace?, locale?, fieldKey, expr, dependsOn[], lastValue, lastError,
  version, updatedBy }` — and the EVALUATED VALUE is written where values live today (the master
  field for master; `overrideData` for a channel cell) through the existing write path. Every
  reader keeps reading values; nothing is taught a wrapper; the resolver's precedence list does not
  change. Provenance `formula` comes from the `CellFormula` row's existence for that coordinate.
  A pinned literal (D16.6) deletes the `CellFormula` row (kept as a restore point) and the value
  stays where it is.
- **(B) `=` is a real operator in the language** (`expr.ts:187`, equality tier; `:421` `looseEq`).
  **The cell editor strips the leading `=` before the string reaches `parseExpr`/`validateExpr`;
  the server refuses a stored `expr` that begins with `=`.** Explicit requirement, tested.
- **(C) `channel: 'master'` would need a real `Marketplace` row** (`findUnique({ channel_code })`,
  `@@unique([channel, code])`, and it would leak into the channel picker and the coverage matrix).
  **Master rules get their own small store — `MasterFieldRule { productType?, fieldKey, expr,
  version, updatedBy }` with revisions mirroring `MappingRevision`** — evaluated on read via
  `resolveAttributes({ product, parent, locale })` (no listing; `sheet-rows.service.ts:397` already
  makes that call) plus `applyTransforms`, NOT through `resolveChannelField` (whose output shape is
  channel provenance). ~10 lines of composition; no `Marketplace` pseudo-row.
- **(D) `exprDependencies(src)` returns `null` on a parse failure** (since #258 — so "does not
  parse" and "depends on nothing" stop looking alike); and it lists DIRECT refs only (`expr.ts:722`
  walks one AST). **Transitive dependencies (a `rule()` referenced through another rule; a cell
  formula that reads a field which is itself a cell formula) are walked by the caller with the
  product's `CellFormula` set and the `expressions` map — PES.6 adds `exprDependenciesDeep(src,
  expressions)` with the evaluator's existing cycle guard (`expr.ts:596`).**
- **Facts that simplify D16.4/D16.5:** nothing re-resolves on a rule change today and there is no
  job — channel rule values are RECOMPUTED ON EVERY READ (`resolve-channel-field.ts:350` in
  `applyTransforms`, called at `:553`; never stored except by publish and `apply-mapping`). That is
  what keeps "what you preview is what ships" true. **So in v1: rules (channel and master) stay
  computed on read — no job, no materialisation, no propagation to build; CELL formulas are
  materialised (their value must be a real stored value for publish, export, sort) and
  re-evaluated SYNCHRONOUSLY inside the write that changes one of their dependencies on the same
  product (walk the product's own formula graph in topological order; ≤ ~100 fields).** D16.5's
  "job with progress" is struck for v1; it returns only if a rule change is ever materialised.
- **(E) One home for the value.** The value layer (master field / `overrideData`) is the ONLY
  authority for display, publish, export and sort; anything that writes it without the formula
  path (bulk PATCH, import, `apply-mapping`, a publish round-trip) would otherwise drift from a
  copy. *Correction of a correction (#485): #482 recorded that the applied table carries
  `lastValue` — it does NOT. PES.6 dropped it in migration `20260902b_pes6_wave4_cellformula_no_
  lastvalue` (06:18:23; the table was minutes old and at 0 rows, so not the destructive case the
  additive rule guards); PES.5's read seven seconds earlier saw the prior shape. The prod table
  matches (E) exactly: `id, productId, scope, channel, marketplace, locale, fieldKey, expr,
  dependsOn, lastError, version, updatedBy, createdAt, updatedAt, evaluatedAt` — 15 columns, one
  dropped, one added: a COUNT is not a SET.* `CellFormula` carries `expr`, `dependsOn[]`,
  `lastError`, `evaluatedAt`, `version`, `updatedBy` — and no `lastValue`.
- **(H) Restore points carry `restoreVia: 'master' | 'formula'`** (PES.4, #482): the record
  drawer has one restore verb today (`POST /products/:id/restore`, master scalars); a `formula`
  point with `restorable: true` and no discriminator would route down that path and appear to
  work. PES.5's restore-points service sets `restoreVia`; the pane routes on it and says so on the
  row. Never inferred from the action name.
- **(F) "Restore formula" needs an audit row, and a restore KIND of its own.** Restore points
  (PES.4's, ruling #364 — not #366 as D16.6 said; corrected) derive entirely from `AuditLog`
  entries whose `before`/`after` name a field; deleting a `CellFormula` row is not a `Product`
  field write. So the pin path WRITES an `AuditLog` entry — action `formula.pinned`, payload
  `{ fieldKey, expr, scope, channel?, marketplace?, locale?, dependsOn }` — and the restore-points
  endpoint lists it as kind `formula` with `restorable: true` through a dedicated restore action
  (re-create the `CellFormula` row and re-evaluate), NOT through `RESTORABLE_MASTER_FIELDS`, which
  stays master scalars only. The action name must not collide with the event-only actions PES.4's
  reader excludes (`create`, `imagePublish*`, `soft-delete`).
- **(G) An errored formula CLEARS the stored value.** The write path writes `null` to the value
  layer and sets `lastError`; it never leaves the previous good value under an error mark — that
  is the stale value D16.4 forbids. The contract distinguishes "errored" from "never had a value"
  by `formulaError` being present.
- **Preview line:** `simulateFieldForCandidate` (`mapping-simulate.service.ts:28`) is pure,
  synchronous, zero-DB — the caller hands it resolved attributes. The preview endpoint resolves
  the row's attributes once and calls it; cost = one `resolveChannelField` (`currentRule`
  undefined). The market-wide `simulateRuleChange` (`:59`) is NOT used by the cell editor.

### 1.5 Lanes and acceptance

- **PES.6 (mapping engine, API):** the cell-formula write path (validate → evaluate → store formula
  + value + dependencies → provenance `formula`), the master rule set (`channel: 'master'`), the
  dependency re-evaluation, the job for rule changes, the preview endpoint (simulate against one
  row). Facts to confirm first (a read-back, not a build): the `lookup` context available for a
  master row; whether `exprDependencies` covers `rule()` chains; the propagation job's shape.
- **PES.5 (contract):** the cell carries `formula?: string`, `formulaError?: string`,
  `dependsOn?: string[]`, and `provenance` gains `formula`; export/import shape (§2).
- **PES.2 / AG.1 (engine):** the `=`-mode cell editor (mono field, `$` autocomplete, preview line),
  the `ƒ` mark as a §9.6 member in `provenance.ts` / `provenanceMark.tsx`, the cell menu's "Restore
  formula". **PES.3:** the channel scope consumes the same editor and mark. **PES.4:** the drawer's
  field shows value + formula + "Edit formula". **DS.2:** the autocomplete popover is the DS
  `Combobox` (D18's geometry). **UX.1:** §9.6 gains `formula` with the precedence above; the probe
  gains a formula-cell witness.
- **Acceptance (on XAVIA, discard/re-read):** the six steps of §1.3 performed and seen; a formula
  over a cap shows `⚠ ƒ` and stores no value; a self-reference is refused with a position; a
  master rule change runs as a job and does not overwrite a pinned or cell-formula value; export →
  import round-trips a formula unchanged; the mark reads the same on master and Amazon·IT.

---

## 2. Import / export (Owner D15, ruling #442)

### 2.0 The Owner's words

> "We also need to build the complete export or import thing so that I'm able to import all the
> attributes in bulk or export them and make changes more quickly."

### 2.1 Measured before designing

- **Export exists for the result set** (AG.1-e, #216/#363): `exportGridCsv` writes the columns as
  displayed and ordered, the rows as filtered and sorted, each cell as rendered (labels, not codes
  — `country_of_origin` exports "Pakistan"), and marks the file `narrowed` when a search or chip has
  filtered it. It refuses under a server-side row model rather than write a silent subset.
- **The write paths an import must use** are the studio's own: master `commitMasterRow` (bulk
  PATCH, `Product.version` CAS, #201), channel `attr_<key>` into `overrideData` with the listing
  version bumped (#449), every declared column now a cell with its own `writable`/`writeVerb`
  (#458), preflight (`Check before listing`), restore points per field (#366). The old import and
  the flat-file editors are untouchable and unlinked (D9).
- **Scale today:** 37 families, largest 50 rows, ~100 columns; the target is thousands (#442).
- **Industry (research §3):** Akeneo's headers are `attribute-locale-scope` with a Codes/Labels
  toggle and export columns in the grid's order; Shopify: an OMITTED column leaves the field
  unchanged, a PRESENT-BUT-BLANK cell clears it; Amazon: `Update` wipes blanks, `PartialUpdate`
  reads only what you filled — the semantics that cost operators the most money. Akeneo's docs:
  bulk actions have no preview and no undo — the category's biggest hole.

### 2.2 Decisions

**D15.1 — One file, both ways.** The export file IS the import file. Same columns, same headers,
same value vocabulary, same scope semantics. The acceptance test is mechanical: export a view,
re-import it unmodified, **zero changes**.

**D15.2 — Headers.** Row 1: the English label (D10). Row 2: the key, as `key` on master and
`key@channel:market:locale` on a channel scope (Akeneo's `attribute-locale-scope`, in our
vocabulary). Import matches on row 2; row 1 is for humans and is ignored on the way in. Labels for
closed-list values (not codes), with the code accepted on import too — one rule, both directions.

**D15.3 — Scope is the coordinate the sheet was on.** An export from master carries master
columns; from Amazon·IT it carries that listing's fields keyed `@amazon:IT:it`. A file may carry
both (a master export with channel columns added by hand) — each column writes to the coordinate
its header names, through the write path that coordinate uses. No "apply to all markets" column
magic; the mapping page and formulas (§1) are where a value spans markets.

**D15.4 — Import is preflight-first and dry-run by default (GDS-4's rule).** Upload → parse →
DIFF → apply. The diff is the whole UI: per cell `unchanged / changed (before → after) / refused
(reason) / would-pin (this cell follows master today; writing it pins it)`, with counts on top
("412 cells change · 7 refused · 3 would pin"), the first 20 changed rows expanded, the rest on
demand. Nothing writes until the operator applies the diff they saw. Refusals use the sheet's own
validation (caps in both units, closed lists, required, `writable: false` with its reason) — one
validator, three surfaces.

**D15.5 — Blank-cell semantics are explicit, one option, default safe.** "Blank cells: **ignore**
(default) / clear." An omitted column is always ignored. The chosen option is echoed in the diff
summary. This is the one setting the research says costs operators the most, so it is the one
setting the import has.

**D15.6 — Every import is a JOB with a record, and the record is revertible.** The apply runs
server-side (streaming parse, batched writes through the existing paths, per-row outcomes) with
progress in the sync-queue console's honesty rules (#357); the job record stores `(job, entity,
field, scope, before, after)` for every cell it wrote; **"Revert this import"** restores the
befores through the same write path (a second job, recorded). Partial failure: rows that refused
are listed with reasons; rows that succeeded stay; the record says which. Re-uploading the same
file is idempotent (a no-change diff).

**D15.7 — Provenance.** An imported value is an ordinary write with a source: the cell's restore
point names the import job; no new §9.6 mark (the value is the operator's, delivered in bulk — it
is `own`/`pinned` by the existing rules).

**D15.8 — Formulas round-trip (§1).** A formula cell exports its VALUE in the field's column and
its formula in a sibling column `key.formula` (only present when any cell in the export has one);
importing a `=`-prefixed value, or a filled `key.formula` column, sets the formula through §1's
write path; a plain value over a formula cell pins it (D16.6) and the diff says so.

**D15.9 — Templates.** "Download template" for the current product type × scope: the header pair
(D15.2) for every declared column, required columns first, an empty data row, and the closed-list
options in a third sheet-less way — a `key.options` comment row is rejected as clutter; instead
the template's row 3 carries an example value for closed lists (the first option). Simplicity
over completeness: the option list is one hover away in the sheet.

**D15.10 — CSV, UTF-8, first.** CSV round-trips through Excel, Numbers and Sheets; XLSX adds a
parser dependency and formatting ambiguity (dates, leading zeros) that CSV does not have. XLSX
export only if operators ask; XLSX import not in v1.

**D15.13 — The diff and job contract (ruled #495 on IO.1's five questions; PES.5 builds to it,
IO.1 renders it — one shape, no drift):**
1. `would-pin` is a FLAG on a changed cell, not a fourth verdict: `verdict: 'unchanged' | 'changed'
   | 'refused'` plus `pins: boolean`; `counts.wouldPin` is a subset of `counts.changed`; the summary
   reads "412 change (3 of them pin) · 7 refused".
2. `before`/`after` are RAW and `beforeLabel`/`afterLabel` are RENDERED by the server with the
   sheet's own formatter (one formatter; the client never re-derives a label); the grid shows the
   label, the tooltip the raw.
3. Row identity on a channel scope is sent as COMPONENTS (`productId`, `aliasKey`, `aliasResolved`)
   and composed client-side as `${aliasKey || 'primary'}:${productId}` (#143); a row with
   `aliasResolved: false` renders as unmatched-with-a-reason, never guessed `primary`.
4. `counts` are server-stated and authoritative — never derived from `rows.length`; the server does
   not truncate a family diff today (≤ 50 × ~100), and a `truncated` block is rendered only if the
   server ever sends one (#357: a page must not report itself as a total).
5. Job poll shape: `{ jobId, state: 'queued' | 'running' | 'completed' | 'partial' | 'failed' |
   'reverted' | 'cancelled', processed, total, outcomes: [{ rowId, fieldKey, verdict: 'written' |
   'refused' | 'unchanged', reason? }], expiresAt? }`
   — **`partial` is its own state** (finished with refusals) and is never reported as `completed`;
   the client renders any state it does not recognise as unexplained, never as success. **(Amended
   #600:** the wire states are LOWERCASE and the route MAPS the DB enum to them — the DB's names are
   the API's own; an outcome `verdict` is `written | refused | unchanged`, `refused` carrying its
   `reason` (CAS "changed since the preview/import", or validation); and there is ONE name for the
   instant on the diff and the job — `expiresAt` — the state says what expires; `revertibleUntil` is
   struck. IO.1's case-sensitive unknown-state rendering caught `COMPLETED` on the wire and rendered
   it unexplained rather than as success — that strictness stays.**)

**D15.14 — Four constraints from PES.5's read (ruled #501):**
1. **`ImportJob` / `ImportJobRow` are UNTOUCHABLE** — they back the legacy import wizard
   (`/bulk-operations/imports`, `/api/import-jobs`, `import-wizard.service.ts`), which the Owner
   tested and froze ("do NOT make functional changes to it"). The studio import must not reuse,
   extend or share them, and nothing new is named `ImportJob`.
2. **The job record is `BulkOperation`, extended additively** — it already carries `changes:
   [{ id, field, oldValue, newValue }]`, `status: SUCCESS | PARTIAL | FAILED | PENDING_APPLY`,
   `errors`, `uploadFilename`, `expiresAt` (= `revertibleUntil`), counts. Additive gaps: `processed`/
   `total`, a per-change `scope` coordinate (`channel`, `marketplace`, `locale`) for channel cells,
   and states `QUEUED | RUNNING | REVERTED`. One store for imports AND §3's bulk verbs; D15.13's
   poll shape maps onto it.
3. **D15.13.2 is corrected: there is no server-side "sheet formatter."** The sheet returns raw values
   and `optionLabels` on the column; the client renders. So the diff carries RAW `before`/`after`
   plus the columns contract (with `optionLabels`), and the CLIENT renders labels with the ONE
   function the grid uses — `label()` in `columns.tsx`, hoisted to `_studio/sheet/` beside
   `flaggedColumnKeys` so sheet and diff are one renderer of one value. No `beforeLabel`/
   `afterLabel` on the wire.
4. **Revert is CAS per cell:** "Revert this import" writes a cell's `before` only if its CURRENT
   value still equals the `after` the job stored; otherwise the cell is skipped with outcome
   `changed since import` and reported — never a blind overwrite of a later edit (the #258 shape).

**D15.15 — The diff token is the job (ruled #531 on IO.1's gap).** D15.4's guarantee is not that
the operator saw *a* diff; it is that nothing writes but the one they saw. With only the file and
the blank-cell mode on the apply request, the server would re-parse — and a re-parse is a NEW diff:
anything that moved a cell between preview and apply (another lane's write, a sync job, a formula)
lands in it unseen. So:
1. **Dry-run persists the computed diff as the `BulkOperation` itself, in `QUEUED`** — per cell: the
   coordinate components (D15.13's row identity), RAW `before`/`after`, verdict. The job id is the
   token; it is returned with the diff and the drawer keeps it.
2. **Apply is `POST …/import/jobs/:id/apply` with NO file, NO mode — and NO query.** Blank-cell mode is
   a dry-run input and is already baked into the stored diff; an apply cannot change what it applies.
   **(Amended #600/#607:** the job stores its scope AND the market the sheet was opened on as two
   facts — a master scope's `marketplace` is null, so "the scope is stored" works on every channel
   scope and fails on every master one. A `?market=` on apply was what stranded IO.1's first
   preview. A job enters `running` only after every precondition is checked; any throw after that
   moves it to `failed` with the reason; a precondition failure leaves it `queued` and retryable.**)
3. **The server applies the STORED diff under the same per-cell CAS D15.14.4 gives revert:** a cell is
   written only if its current value still equals the stored `before`; otherwise it is skipped and
   recorded `refused` with reason `changed since the preview`. Counts are server-authoritative
   (D15.13); a job with any skipped cell is `partial`.
4. **An unapplied preview goes to `CANCELLED`** — when the drawer closes, or by the server's sweep
   after 24h (PES.5 picks the mechanism; the state name is fixed). The job panel lists a `QUEUED` job
   as "previewed, not applied".
5. The client's `applyBlockedReason` refuses to apply without a job id — the safe direction is the
   default, and the mirror field is `jobId`, never a separate token.

**D15.16 — The wire envelope, written down (ratified #577 by reference to IO.1's verifier; PES.5
flagged in #587 that a route "conforming to the approved design" could not be checked against this
document, because the names lived only in `_studio/import/contract.ts` + `verifyImportDiff`. That
was the hub's omission. The verifier stays the acceptance; this is the same shape in the design's
own words, so the next lane can build to the doc and pass the test.)**
1. **Request:** `POST /api/products/:id/import/diff`, `multipart/form-data` — the CSV file plus the
   scope coordinate (`kind: master | channel`, `channel?`, `marketplace?`, `locale?`) and the
   blank-cell mode (`ignore` default | `clear`; an OMITTED column is always ignored, not
   configurable). **The server parses the file** (row 1 English header, row 2 key, the label row
   ignored); the client never parses. The JSON `dry-run` (client-parsed `headerRow`/`rows`) is
   RETIRED.
2. **Response — one envelope, every name server-stated:**
   `{ jobId, file: { name, bytes?, rows?, columns? }, scope: { kind, channel?, marketplace?,
   locale?, label }, blankCells (the mode the server APPLIED, echoed — the summary is written from
   this field, never from local intent), columns: SheetColumn[] (the sheet's OWN column contract
   handed through unchanged — `key`, `label`, `options`, `optionLabels`, `kind`, `editable`,
   `writeTarget`, `writeField`, `writeVerb`), rows: [{ productId, aliasKey, aliasResolved, sku,
   name?, line?, cells: Record<columnKey, { before, after, verdict, pins, reason?, header? }>,
   counts? }], counts: { changed, unchanged, refused, wouldPin }, unmatchedRows?: [{ line, sku?,
   reason }], unmatchedColumns?: [{ header, key?, reason }], truncated?: { rowsReturned, rowsTotal,
   note }, expiresAt?, coverageNote? }`.
3. **`coverageNote` is rendered always** (#357's rule): what the diff cannot see, in the server's
   words — an empty panel reads as reassurance.
4. **The write destination is a property of the COLUMN, stated by the server.** The client reads
   `columns[].writeTarget` (`studio-sheet.service.ts` decides it once for sheet, drawer and diff);
   a column without it is a contract violation the verifier reports and `applyBlockedReason` refuses
   on. No client mirror of `CHANNEL_FIELD_MAP`, no prefix rule — a mirror of a server table drifts
   silently the day the table grows (ruled #588).
5. A field the verifier does not know is rendered as unexplained, never as data; a field the verifier
   requires and the route omits is a red the route owner fixes, never a default the client fills.

**D15.12 — Paste from Excel/Sheets is the small import (Owner's question, #482).** AG Grid has no
file import; it has CSV/Excel EXPORT (used) and, in Enterprise, clipboard RANGE PASTE. A block
pasted from a spreadsheet into the sheet is an import of that block: it must go through the same
per-cell write path (autosave via bulk PATCH, validation, CAS) and show the same per-cell
outcomes — a refused cell reads refused, a pin reads pinned — never a silent grid-only paste. **AG.1
measured (#485, traced statically, no write): paste AND the fill handle are live on the sheet
(`ClipboardModule` + `CellSelectionModule`, `cellSelection.handle: 'fill'`, header-matched paste
via `sheetPasteProcessor`), reach the autosave as first-class writes (`NON_EDIT_SOURCES` is a
deny-list of `['data']` only, deliberately), AND carry NO validation: `lengthValidation` /
`selectValidation` are advisory class rules and editor UI, so a value over a cap or off a closed
list that could not be TYPED is committed by paste or by a fill drag across a hundred rows.**
RULED: (1) validation moves into the write gate — one validator (caps in both units, closed lists,
required, `writable`) runs in `SheetWriter.set`/`writeGate` for every source (typed, paste, fill,
undo/redo, import), so no source can bypass what the editor enforces; (2) a refused cell is NOT
sent: it renders `refused` with the reason and KEEPS the pasted text visible as unsaved until the
operator fixes or reverts it (the errored-formula shape — never a silent revert, never a silent
send); (3) the server refuses the same values independently (PES.5 measures what the API does with
an over-cap value today — the client gate is a convenience, the server is the guard). The file
import (D15.4–D15.6) is for the whole-sheet and cross-session case and stays.

**D15.11 — Where it lives.** Export and Import are two controls in the shared `SheetToolbar`
(§14.1, `absent` with a reason is the only way a scope omits one); Import opens a DS drawer with
the three steps (file → diff → apply), never a page (extend, don't add pages).

### 2.3 Not in v1
- Scheduled/automated imports (a feed) — that is the sync engine's job, not the studio's.
- Images by URL in the file — the images surface has its own planner; a URL column would bypass
  its per-ASIN/per-listing rules.
- Cross-family files — an import addresses one family sheet; multi-family bulk is §3's list-level
  bulk verb.

### 2.4 Lanes and acceptance
- **PES.5:** the import endpoint (parse → diff → apply as a job; blank-cell option; per-row
  outcomes; the job record and revert), the header contract (`key@channel:market:locale`), the
  template endpoint. **AG.1:** export grows the key row and the `key.formula` sibling; the
  `narrowed` mark stays. *(Never landed by AG.1 — measured 2026-09-04: the Export button's file had
  one label header row and no `sku`, 0 of 102 headers importable. Landed by design V.5 the same
  night: `grid/export/*` + `_studio/sheet/sheetExport.ts`; the unmodified "all attributes" export
  re-imports 2142/2142 unchanged, 0 refused, on GALE-JACKET master·IT.)* **PES.2 (master) / PES.3 (channel):** the two toolbar controls and the
  import drawer (DS.2's `Drawer`, the diff as a `NexusGrid` with the sheet's own cell renderers so
  a refused cell looks refused). **UX.1:** a §-entry and a probe witness for "export → re-import →
  zero changes". **Acceptance (XAVIA):** export master, re-import → 0 changes; change one cell in
  the file → diff shows one change, apply, read back, Revert → read back byte-identical; a
  refused value (over cap) shows refused in the diff and is not written; blank-cell option in both
  modes; a channel export keyed `@amazon:IT:it` writes to the listing, not master.

## 3. Scale & writability (Owner D14 + the frame, ruling #442)

### 3.0 The Owner's words

> "We must think like we're managing hundreds of thousands of SKUs, or at least thousands… I'm
> unable to write a lot of attributes still, such as color… whether to have each and every column
> correctly mapped to the master unless I override it manually… go through the UI or the layout of
> the product edit page in case it needs any changing for better managing thousands of SKUs."

### 3.1 Measured before designing

- **The catalogue today:** 37 families, largest 50 rows (`xracing`), mean 9.1, none over 50 (#458).
  The target is thousands of SKUs per account; both numbers are design inputs — the second is what
  every mechanism must hold at, the first is what it holds today.
- **Writability, the cause found:** the sheet declared ~100 columns and rows carried 21 cells;
  76–81 declared columns had no cell on any row on either scope, so they were never attemptable
  (#449). Fixed at the contract: every declared column yields a cell with its own `writable`,
  `writeVerb`, `writeField` (#458, 44 KB/row on Amazon·IT, 2.2 MB at 50 rows). `color` is now
  editable on both scopes (#464); D14's acceptance write is in flight (PES.3).
- **The write paths:** master bulk PATCH (`Product.version` CAS); channel `attr_*` into
  `overrideData` (listing version bumped); routing on the COLUMN (#333); the six-field bulk-PATCH
  limit is a banked trap (memory) — everything else on a channel scope writes MASTER unless routed.
- **Per-market follows/pinned (FFD10)** exists: a per-market cell is a projection of master until
  pinned; the cell says which (`FollowsCell`). Provenance marks: `own · inherited ·
  inheritedOverride · pinned · ai · aiStale · mapped · mappedShared` (+ `formula`, §1).
- **The row model:** the studio's sheet is CLIENT-side (every row in memory — `GridSheet`);
  `/products/next` (the account-level list) is AG server-side (SSRM) with paging, saved views and a
  bulk-edit path. The family bar's cascade is serial per child (#465: 21 → 2 statements after the
  collapse; the channel path is still per child per marketplace, 98 at two contexts).
- **§9.1 does not survive a mixed sheet** (UX.1, #460): "identity + every required column fits at
  1440" holds because GALE-JACKET is one product type; a thousand SKUs span many types and the
  required set is their UNION, which fits at no width.
- **Industry (research §2, §5):** select-all-across-pages, preview-before-apply, per-row outcomes
  and a revertible job are the category's gaps; Plytix filters by provenance
  (Inheriting/Inherited/Overwritten + Resync).

### 3.2 Decisions

**D14.1 — The acceptance for writability is FFD10 on every attribute of every scope, measured
as a matrix.** For GALE-JACKET × {master, Amazon·DE, Amazon·IT, eBay·IT}: every column is one of
`writes and persists` / `refused: <reason shown in the cell>` / `follows master (projection; the
cell says so)`. The fourth category — "offered but never attemptable" — is closed (#458) and must
never return: a probe witness asserts `cells per row == declared columns` on both scopes. The
matrix is produced ONCE from the contract's `writable`/`writeVerb` plus ONE observed write per
distinct `writeVerb` (not per column — the verb is the path; XAVIA, discard/re-read), and kept as a
document the probe re-checks structurally.

**D14.2 — Mapped-to-master-unless-overridden is the default on every channel cell.** A channel
cell with no override and no channel rule shows master's value with `inherited` and writes as a PIN
(FFD10); the pinned cell offers "Follow master again" (Plytix's Resync) in its menu and the drawer.
No new mechanism — this is FFD10 stated as the acceptance and given its restore verb.

**D14.3 — Provenance is FILTERABLE, not only visible.** The view chips (#173's Missing required /
Warnings / Mapping errors) gain one chip per §9.6 family that is present on the sheet: `Pinned ·
Inherited · Mapped · Formula · AI` — counts from the server (the sheet already carries the facts
per cell), click to filter rows that have any such cell, the column-level mark on the header when
filtered. This is the research's one cheap adoption and the thing that makes "did I override this
anywhere?" answerable at a thousand SKUs.

**D14.4 — Bulk verbs preview and are revertible (Owner queue item 8, research's first item).**
A bulk verb (set / clear / find-and-replace / arithmetic on numeric fields — "+5% on every child")
runs as `commit=false` first: "412 cells will change" plus the first 20 before → after pairs, the
refusals with reasons, then Apply; the apply is a JOB with the same record as an import (§2, D15.6)
and one "Revert this job". The arithmetic verb is the bulk verb's `expr` mode — the same
expression language as §1 applied to the selection (`= $basePrice * 1.05`), which gives every
numeric bulk edit for free and no second syntax. Scope: the current selection on the sheet, or
the current filter on `/products/next` (select-all-across-pages = the filter, not the rendered
rows — stated in the preview as "all 1,204 rows matching the current filter").

**D14.5 — The sheet's row model at scale: SERVER-side rows above a threshold, same sheet.**
The family sheet stays client-side up to 500 rows (10× today's largest family; measured payload
2.2 MB at 50 → ~22 MB at 500 is the ceiling — the threshold is set from that measurement, not
chosen). Above it, the SAME `GridSheet` mounts AG's server-side row model (the engine already runs
SSRM on `/products/next`) with the contract paged; sort, filter and the view chips move server-side
for that family; export refuses under SSRM today (#216) and instead becomes a job (§2). Nothing in
the operator's UI changes across the threshold except that scrolling fetches. Selection semantics
under SSRM: the filter, as in D14.4. The threshold is one constant with the measurement beside it.
*Measured (#513, #537): `xracing` 50 rows — master 2,103 KB, Amazon·IT 2,762 KB; synthesised 500
rows 19.8 / 26.2 MB. Server build, profiled INSIDE the request on a quiet box (load 2.89, laptop →
Neon): Amazon·IT cold 4,155 ms (columns 1,787 · mapping 1,522 · family 409 · related 395 · ROWS 11),
warm 1,028 ms (mapping 654, columns 0); master cold 3,003 / warm 437. The row build is ~1% — the
cost is the per-market column build (cached after first read) and the channel mapping resolve. The
9,045 ms first quoted (06:55:06, inside the saturation window) did not reproduce and is WITHDRAWN by
its author; SC.1's re-take at load 4.2–5.0 corroborates: Amazon·IT cold 4,867 / warm 1,233–2,013,
master cold 5,360 / warm 909. Bytes on the 07:19:33 build (load-free): master IT 2,157 KB, Amazon·IT
2,808 KB at 50 rows; synthesised 200 → 8.19 / 10.70 MB, **500 → 20.36 / 26.63 MB**, 1000 → 40.63 /
53.16 MB. The paragraph above's "2.2 MB → ~22 MB" was a GALE-JACKET extrapolation; **the ceiling is
set from the real family: 26.6 MB at 500.** First paint NOT MEASURED. Re-measured on Railway before
any figure reaches the Owner.*

**D14.6 — The account level is `/products/next`, and its bulk edit is the studio's write path.**
"Managing thousands of SKUs for an account" is the list, not one family's sheet. `/products/next`
gains: the provenance chips (D14.3), the bulk verbs with preview + revert (D14.4), and "Open in
studio" per family — and its bulk-edit path is retired in favour of the studio's write path (one
validator, one CAS, one job record). No new page.

**D14.7 — §9.1 on a mixed sheet: the required set is per PRODUCT TYPE, and the sheet groups by
type when it has more than one.** A family (and a list) that spans product types renders one
required block per type as a collapsible band header (`OUTERWEAR — 7 required`, `GLOVES — 6
required`) with §9.1's invariant applied per band; the union is never asked to fit. UX.1's three
candidates were: per-type bands, a union with the "in this row's type" columns highlighted, and a
type selector. Bands are chosen because they preserve the invariant as a property of the visible
block, cost no width, and read as what the data is. Measured on one family today (1 of 37 has > 1
product type, #477) — the design holds for the list.

**D14.8 — The family bar's cascade at scale.** The plain-field cascade is 2 statements for any
family size (#465 landed). The channel cascade stays per child per marketplace until a bulk
upsert is written; it runs as a job above 50 children with progress and per-child outcomes, never
a silent partial. `apply-to-children` for images (PES.7) uses the same job shape.

**D14.9 — What does NOT change on the product edit page for thousands of SKUs.** The Owner asked
whether the layout needs changing; the measured answer is mostly no: the studio is a FAMILY
surface (≤ 50 rows today, ≤ 500 client-side by D14.5), the layout v2 budgets hold there, and the
account-scale work lands on the list (D14.6) and in the bulk/import jobs. The two layout changes
the frame does force are D14.7 (type bands) and D14.3 (provenance chips in the toolbar) — both
inside the existing chrome, no new band above the grid (§3.5a).

### 3.3 Not in v1
- A sheet across families ("all products as one grid") — that is `/products/next` with bulk
  verbs; a second cross-family grid is duplication.
- Per-cell approval workflows / roles on edits — a different product.
- Offline or optimistic multi-user editing — CAS refuses stale writes today; that stays.

### 3.4 Lanes and acceptance
- **SC.1 (audit lane, when launched) or PES.5:** the writability matrix (D14.1) as a document +
  the probe witness; the threshold measurement for D14.5 (payload at 500 rows, synthetic).
- **PES.5:** provenance counts per §9.6 family on the sheet contract (D14.3); the bulk-verb
  preview/apply/revert job (D14.4, sharing §2's job record); server-paged sheet contract (D14.5).
- **PES.2 / PES.3 / AG.1:** the provenance chips (D14.3) in the shared toolbar's chip slot; the
  bulk verb's preview drawer; SSRM mount above the threshold (D14.5; AG.1 owns the AG side); type
  bands (D14.7). **PES.4:** "Follow master again" in the drawer (D14.2). **UX.1:** §9.1 amended
  to per-type bands; the chips' §6 warning rules extended (a provenance chip is a FILTER, neutral
  tone — #362's rule); witnesses. **`/products/next` owner (per the claims table):** D14.6.
- **Acceptance:** the matrix shows no fourth category on any scope; a pinned cell offers "Follow
  master again" and it round-trips (XAVIA); the `Pinned` chip filters to exactly the rows with a
  pinned cell (count = server count); "+5%" on 3 selected children previews 3 pairs, applies,
  reverts byte-identical; a synthetic 600-row family mounts SSRM and sorts server-side with the
  same chrome; a two-type family shows two required bands each satisfying §9.1 at 1440.

---

## 4. App chrome (Owner D17 — PROPOSE FIRST, ruling #442)

### 4.0 The Owner's words

> "I was thinking whether extending the sidebar all the way up to the top left would be a better
> idea. We do have the header on all the pages, like we did previously, but as we scroll up the
> page, the header moves up and vanishes. Exactly how it is on Amazon, I would say. But UI and UX
> have to be perfect, and also I've noticed some inconsistencies in the centralization of some of
> the stuff. For example, the search bar and header must be properly aligned and all."

Asked whether to build or propose, the Owner chose **propose first**. So this section is the
hub's DESIGN OF THE PROPOSAL — what is measured, what the two options are, what decides between
them — and the chrome lane produces the measurements and the two mocks; the Owner picks; the hub
then writes the build ruling.

### 4.1 What is measured first (the chrome lane, read-only, both 1440 and 1728)

On five pages — the studio, `/products/next`, the mapping page, one ads page, the dashboard:
1. The chrome's geometry: sidebar width and height; top bar height; what is `position: fixed`/
   `sticky` and what scrolls; the vertical budget each page pays for chrome (the studio's §4.3b
   ledger is the model — a number per page).
2. Alignment: the search field's box vs the page title's baseline vs the sidebar's edge vs the
   content's left edge — the pixel offsets, per page. "Properly aligned" becomes a list of
   deltas, each with its cause (a different container, a different padding token, a one-off
   margin).
3. What global actions live in the header today and how often a page needs them while
   scrolled (search, account switcher, notifications, help).

### 4.2 The two options (mocked in the design lab on the DS, real tokens, both widths)

**Option A — full-height sidebar from the top-left; a per-page header that scrolls away
(the Owner's Amazon reference).** The sidebar owns the brand mark, navigation, account switcher
and global search at its top; each page has its own header (title, page actions, breadcrumbs)
that is part of the page and scrolls with it; the content area starts at y = 0 beside the
sidebar. Consequences to state with numbers: vertical space gained on every page (the whole top
bar — measure it); the studio's collapsing header (§3.5a) becomes the only sticky element and
its `R − C ≥ T` invariant is re-derived with the new `R` (UX.1 owns that ledger); global search
is always visible in the sidebar; keyboard focus order changes (sidebar first).

**Option B — the current top bar kept and fixed; alignment defects fixed.** The measured deltas
from 4.1 are removed by moving every page onto one layout grid (one content container, one
padding token, the search field on the same baseline as the title) with no structural change.
Consequence: zero vertical space gained; the least risk; every page changes only by its deltas.

For each option the mock shows: the studio at 906 tall with the sheet at max scroll; the list at
1440; one narrow page; dark mode; the focus ring order.

### 4.3 What decides it (the hub's recommendation, for the Owner)

The hub recommends **A** if 4.1 shows the top bar costs ≥ 48px on every page (it does on the
studio — the AppTopBar was removed there for exactly that, §2.3 — and the studio is the page the
Owner lives in), and if the sidebar can carry search without widening. Otherwise **B**. A is a
one-time chrome rebuild across every page (773 files still on Tailwind is the constraint the lane
must cost — memory `project_tailwind_legacy_migration`); B is a sweep. Either way, the alignment
defects are fixed — they are not the option, they are the floor.

### 4.4 Lanes
- **CH.1 (when launched, Opus):** 4.1's measurements and 4.2's two mocks in the design lab; no
  product file until the Owner picks. **UX.1:** the studio's budget re-derivation for A. **DS.2:**
  the one layout grid (tokens, container, padding) both options need.
