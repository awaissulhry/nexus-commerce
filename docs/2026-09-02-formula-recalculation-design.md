# Formula recalculation — short design for the Owner (draft, 2026-09-02 21:56)

**Status:** rules 1, 3, 5, 6, 7, 8 BUILT server-side 2026-09-03 (`cell-formula.service.ts` +
`products.routes.ts`); rule 1's queue clause refused by the Owner, see the ruling below. The client
repaint ("Cost" section) is NOT built. Owner item 51, step 2.

## What exists today
- A formula is stored per cell (`CellFormula`: product, scope, market, locale, field, `expr`, `dependsOn`, `lastError`).
- It is evaluated ONCE, when saved: the server evaluates `expr` against the product's current values and writes the result into the column (`writeValue`), bumping `Product.version`, and records a `formula.set` audit row (who, from where, value, version before/after).
- A manual edit on a formula cell **pins over** the formula: the CellFormula row is deleted, the typed value stays.
- The client shows the evaluated value with a `ƒ` mark at rest and the formula text only while editing.

## What "Excel-like" adds
When a source cell changes (for example `$brand`), every formula that depends on it re-evaluates and its result is written again — without anyone re-saving the formula.

## Proposed rules (each is a decision; the recommendation is marked)
1. **Trigger.** Re-evaluate when a product field a formula `dependsOn` changes through ANY write path (cell edit, bulk PATCH, import, cascade, another formula). *Recommended:* server-side, in the same request that wrote the source, so the result is consistent before the response returns; ~~fall back to a queue for large fan-outs (>50 dependants)~~.

   > 🔴 **OWNER RULING, 2026-09-03: synchronous, ALWAYS — the queue clause is refused.** No
   > threshold, no cap, no deferral: every dependant re-evaluates in the request that wrote the
   > source, whatever the fan-out. Reasons on the record: the walk's own premise is that a product
   > has ≤ ~100 fields and a job would break "the value you see is the value that was stored"; and
   > a queue-backed path is inert on the dev machine (no Redis), so a half-built fallback would be
   > indistinguishable from a working one while dropping the tail of the fan-out.
   > **As built** — `reevaluateDependents` has no cap, pinned by a >50-dependant test.
2. **Scope of dependency.** Same row only (`$field` references) in v1. Cross-row references (parent → children, sibling rows) are a later step with their own rules.
3. **Manual edits win.** A typed value on a formula cell pins over the formula (already the behaviour). Recalculation never touches a pinned cell.
4. **Push-path columns.** A recalculated value on a column with a push path (price, status, title) pushes to the marketplace exactly as a typed value would. *Recommended:* keep that behaviour but show the recalculation in the audit row (`formula.recalc`, with the source field that triggered it) so an unexpected push is traceable.
5. **Errors.** If a recalculation fails (unknown ref after a column is removed, a result outside a select's options), the cell keeps its LAST value, `lastError` is stored, and the cell shows the warning — no silent blank.
6. **Cycles.** `A = f(B)`, `B = f(A)` is refused at save time (dependency graph check), not discovered at recalculation.
7. **Ordering.** Dependants recalc in topological order within a row; a cell is evaluated after everything it depends on.
8. **Audit.** Every recalculated write records a `formula.recalc` audit row with ip/actor of the ORIGINAL write, the source field, expr, value written, version before/after (same shape as `formula.set`).

## Cost
- Server: a dependency index (field → formulas that depend on it, per product), a recalc pass after each product write, the audit row, tests. About one day of PES.5.
- Client: nothing new to draw — the `ƒ` cell re-reads. A small change so a recalculated cell repaints without a page reload (the sheet already re-reads formulas per family). Half a day of PES.2 including the screen reading.
- Verification: one rehearsal on the XAVIA family — change `brand` on a variant that carries `=upper($brand)` on a no-push column; read the recalculated value on two paths; restore.

## Not in this step
Cross-row references; formulas on the parent that fill children; scheduled recalculation; formulas in imports.
