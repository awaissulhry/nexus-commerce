/**
 * PES.2 — the master sheet's pure COLUMN decisions, in a `.ts` so the node suite can reach them.
 *
 * 🔴 Why this file exists, and why it is not the whole of `buildMasterColumns`.
 *
 * FE.1's set-scan (hub #348) named `buildMasterColumns()` — weight 268, module scope, no test — as
 * "the largest single unit that becomes testable purely by moving to a `.ts` sibling". It is not:
 * that function returns column definitions whose `cellRenderer`s **are JSX**, so it cannot leave a
 * `.tsx` wholesale. What CAN leave are the decisions it makes before it renders anything, and those
 * are the ones worth testing — a renderer's output is checked by looking at the screen, but a cap,
 * an editability predicate and a source label are silent when wrong.
 *
 * **Nothing here may import `@/design-system/grid`.** That barrel re-exports `NexusGrid.tsx`, and a
 * node test importing anything downstream of a `.tsx` dies at PARSE, before a single test runs.
 * This module depends only on `./types` and `@nexus/shared`. Same constraint that produced
 * `masterWrite.ts` and `design-system/grid/renderers/emptyValue.ts`.
 */
import { refusalWords } from '@/design-system/grid/editors/refusalWords'

import { columnApplies, columnRequiredByAny, isProductRelationshipColumn } from '@nexus/shared/master-sheet'

import type { SheetColumn, StudioCellValue, StudioRow } from './types'

export const cellOf = (row: StudioRow, key: string): StudioCellValue | undefined => row.values[key]

/**
 * Can this cell be edited?
 *
 * Three independent vetoes, and the row-level one is the subtle one: a column can be editable in
 * general and still not apply to THIS row (a variation axis a row does not vary by), in which case
 * the cell holds nothing and offering an editor invites a write that has nowhere to land.
 */
export function cellIsEditable(col: SheetColumn, row: StudioRow | undefined): boolean {
  if (!row) return false
  if (!col.editable) return false
  if (!columnApplies(col, row)) return false
  // 🔴 `!== false`, not a truthy test: the server states editability per cell, and a cell that
  // simply does not carry the flag is editable. Reading `undefined` as "not editable" would lock
  // most of the sheet on any response that omits it.
  return cellOf(row, col.key)?.editable !== false
}

/**
 * 🔴 WHY A REFUSED CELL MUST SAY SO — the second half of the Owner's ruling on the 2026-09-03 P0:
 * *"If an editor genuinely cannot open (cell not editable), the sheet SAYS so in the cell's own
 * words — never silence."*
 *
 * MEASURED BEFORE THIS EXISTED, on `condition_type` (`editable: false` on the wire, made visible
 * through Customise), master·DE: double-click, Enter, F2 and typing a character each produced
 * **0 editors, 0 toasts, no `title`, and nothing new on screen**. Four gestures, four silences. An
 * operator cannot tell that from a broken sheet — which is exactly how the fill-handle defect went
 * two days without being called a defect.
 *
 * This is the same class the repo already guards in `scripts/check-silent-disabled.mjs` ("a control
 * that refuses must be able to say why"; 28 rule toggles refusing in total silence on prod), and
 * the house remedy stated there is *a handler that answers*.
 *
 * 🔴 IT IS DERIVED FROM `cellIsEditable`, NOT RE-STATED BESIDE IT. A second predicate one line away
 * diverges on the first caller that omits a clause, and then the sheet either refuses silently
 * again (reason `null` where the cell is locked) or explains a refusal that never happened. The
 * test that matters holds the two together: this returns a reason for EXACTLY the cells
 * `cellIsEditable` rejects, over every combination.
 *
 * The words are the CELL's, not a generic apology: each branch names the specific veto, because
 * "cannot edit" tells an operator nothing they had not already worked out.
 */
export function editRefusalReason(col: SheetColumn, row: StudioRow | undefined): string | null {
  // No row means no cell: an empty grid area has nothing to explain, and a toast there would be
  // noise fired by clicks that were never aimed at a cell.
  if (!row) return null
  if (cellIsEditable(col, row)) return null
  if (isProductRelationshipColumn(col.key)) return col.helpText ?? null
  const label = col.label || col.key
  /* 🔴 This function picks WHICH veto; `refusalWords` owns HOW IT IS SAID, so master and the channel
     cannot drift into two sentences for the same refusal. The two scopes genuinely do not share an
     editability predicate — the channel has a `writable` veto master has no concept of — so the
     seam is the reason, not the rule. */
  if (!col.editable) return refusalWords(label, { kind: 'column-read-only' })
  /* The two ways `columnApplies` can say no, told apart, because the remedies differ completely:
     one says "go to a variation row", the other says "this field is not part of this product type".
     Collapsing them into one sentence would send an operator looking for a row that does not exist. */
  if (row.isParent && col.scope === 'per_variant') return refusalWords(label, { kind: 'per-variant-on-parent' })
  if (!columnApplies(col, row)) return refusalWords(label, { kind: 'not-applicable', productType: row.productType })
  // The remaining veto is the per-CELL one: the column is editable and applies, and the server
  // still marked this particular cell locked.
  return refusalWords(label, { kind: 'cell-locked' })
}

/** Whether a cell should be validated at all — a column that does not apply cannot be wrong. */
export function validationApplies(col: SheetColumn, row: StudioRow): boolean {
  return columnApplies(col, row)
}

/** Whether THIS row must fill this column — required is per row, never per column. */
export function requiredOnRow(col: SheetColumn, row: StudioRow): boolean {
  return columnApplies(col, row) && columnRequiredByAny(col, row)
}

/**
 * What the ✎ / 🔗 tooltip names as the source.
 *
 * `inheritedFrom` is an id and an operator reads SKUs, so it is resolved against the rows on screen
 * rather than printed as a cuid. `null` when the value is the row's own, and `null` — not the raw
 * id — when the parent is not among the rows: a cuid on screen is not a source label, it is noise
 * that looks like one.
 */
export function sourceLabel(row: StudioRow, key: string, rows: readonly StudioRow[]): string | null {
  const cell = cellOf(row, key)
  // ⚠ EQUIVALENT MUTANT, recorded so nobody reads the green suite as covering it: weakening this to
  // `if (!cell) return null` changes no observable behaviour, because a null `inheritedFrom` matches
  // no row's id and the lookup returns null anyway. The guard stays for intent and for the fast
  // path — but it is not load-bearing, and no test can make it so without inventing a row with a
  // null id, which the contract does not produce.
  if (!cell?.inheritedFrom) return null
  return rows.find((r) => r.id === cell.inheritedFrom)?.sku ?? null
}

/**
 * The column's width.
 *
 * Was `SPEC_WIDTHS` — a one-key override forcing `name` to 220 while the contract served 380.
 * **Deleted**: PES.5 now serves 220 on every scope (§9.3c), so the override would be a client
 * re-asserting a value the server already states, and the next person would have to check both
 * places to learn one number. The fallback stays because a column with no declared width still
 * needs one.
 */
export function widthFor(col: SheetColumn, fallback: number): number {
  return col.width ?? fallback
}
