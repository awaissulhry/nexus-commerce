/**
 * GDS — WHAT A REFUSED CELL SAYS. One vocabulary, both scopes.
 *
 * Owner's ruling, 2026-09-03: *"If an editor genuinely cannot open (cell not editable), the sheet
 * SAYS so in the cell's own words — never silence."*
 *
 * ## Why the WORDS live here and the PREDICATE does not
 *
 * The two sheets do not share an editability rule and should not be forced to. Master has four
 * vetoes (`columnRules.cellIsEditable`: the column, whether it applies to the row, the per-variant
 * scope on a parent, the cell itself); the channel has two (`channel/rows.isCellEditable`:
 * `cell.editable` and `cell.writable`), and `writable` is a concept master does not have at all.
 * Forcing one predicate on both would either invent a veto for one scope or drop a real one from
 * the other.
 *
 * What must NOT differ is what the operator reads. Two sheets refusing the same cell in two
 * different sentences is exactly the "shared = exactly the same" drift the Owner has ruled on, and
 * it is the kind that never shows up in a diff. So: **each sheet decides WHICH reason applies —
 * it alone knows its own vetoes — and this module decides HOW IT IS SAID.**
 *
 * MEASURED BEFORE THIS EXISTED (2026-09-03): master said nothing at all on a locked cell for any of
 * double-click, Enter, F2 or typing; the channel's own code documents the same behaviour in a
 * comment — *"A non-editable cell drops the editor silently"* (`ChannelSheet.tsx:941`). The
 * contract gate now asserts `none+say` on both scopes and fails on one miss.
 */

/**
 * Why a cell will not open. Each member is a veto some sheet actually applies — there are no
 * speculative members, because a reason nothing can produce is a sentence nobody will ever read and
 * a branch no test can cover.
 */
export type RefusalReason =
  /** The column is read-only on this sheet (`column.editable === false`). Both scopes. */
  | { kind: 'column-read-only' }
  /** The column is editable, applies, and the SERVER locked this particular cell. Both scopes. */
  | { kind: 'cell-locked' }
  /** The column does not apply to this row's product type. Master only. */
  | { kind: 'not-applicable'; productType?: string | null }
  /** A per-variation column on the parent row. Master only. */
  | { kind: 'per-variant-on-parent' }
  /** The channel says this cell is not writable here (`cell.writable === false`). Channel only. */
  | { kind: 'channel-not-writable' }

/**
 * The sentence.
 *
 * 🔴 Each branch names the SPECIFIC veto, because "cannot edit" tells an operator nothing they had
 * not already worked out from the editor failing to open. The two `not-applicable` branches differ
 * because the remedies differ completely: one sends the operator to a variation row, the other says
 * the field is not part of this product type. Collapsing them would send someone looking for a row
 * that does not exist.
 *
 * `label` falls back to the column key at the call site; a sentence beginning " is read-only" reads
 * as a rendering bug, so it is never allowed to start empty.
 */
export function refusalWords(label: string, reason: RefusalReason): string {
  switch (reason.kind) {
    case 'column-read-only':
      return `${label} is read-only on this sheet — it cannot be edited here.`
    case 'per-variant-on-parent':
      return `${label} is set per variation — open a variation row to edit it, not the parent.`
    case 'not-applicable':
      return reason.productType
        ? `${label} does not apply to ${reason.productType} products.`
        : `${label} does not apply to this product.`
    case 'channel-not-writable':
      return `${label} is not writable on this channel — edit it on the master sheet.`
    case 'cell-locked':
      return `${label} cannot be edited on this row.`
  }
}
