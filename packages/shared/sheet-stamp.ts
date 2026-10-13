/**
 * Field stamps on the product sheet (the Information page, 2026-10-13) — what a sheet cell SHOWED when the person
 * edited it: its value and where that value came from. ONE function for the page (it stamps each write) and for the door
 * (it compares against the same cell read again), so the two can never read a cell differently. The Matrix twin is
 * `matrix-stamp.ts`.
 *
 * Why: the sheet's writes are guarded by ONE version per row — `Product.version` for the Shared product and its language
 * text, `ChannelListing.version` for a listing and its pinned text, plus the version of the translation row a text cell
 * writes. A sale, a cascade, another tab or another person editing ANOTHER field moves that version, so a version-only
 * check refused edits whose field nobody had touched ("N rows changed elsewhere — refresh"). The door now asks the field:
 *   - the version matches                → the write goes ahead, as before;
 *   - the version moved, every stamp holds → the write goes ahead at the fresh version (`writtenAt`);
 *   - a stamped field moved              → refused as before, with the field as it is now (`current`).
 * A write without a stamp (an older client, a reset of a whole list, a cell the page did not read) keeps the
 * version-only check.
 *
 * The stamp is conservative on purpose: it is the cell's value AND its provenance (`from`) — the text tier it came
 * from, whether it is inherited from the family, pinned on this layer, following the Shared product, and the layer.
 * So a cell that showed an inherited or followed value and is now the row's own (or the reverse) refuses even when
 * the value is the same, and a followed value that moved refuses the pin made over it.
 *
 * Pure: no React, no Prisma — reachable from both apps' node tests and the API's services.
 */

/** Where a cell's value came from, as the sheet read states it. */
export interface SheetStampSource {
  /** Text cells: the tier that supplied the value (`pin`, `language`, `source`, `computed`); null for every other cell. */
  tier: string | null
  /** The value is the family's (the parent's), not this row's. */
  inherited: boolean
  /** This layer stores the value (the listing's own, a variation's own). */
  pinned: boolean
  /** The listing follows the Shared product for this field (null: not a following field). */
  follows: boolean | null
  /** The layer that supplied the value (`master`, `variant`, `channel`, `alias`, `linked`, `default`). */
  layer: string | null
}

export interface SheetCellStamp {
  /** The value the cell showed, as JSON carries it. */
  value: unknown
  from: SheetStampSource
}

/** The part of a sheet cell (API `StudioCellValue`, web `StudioCellValue`) a stamp reads. */
export interface SheetStampCell {
  value?: unknown
  tier?: string | null
  inherited?: boolean | null
  pinned?: boolean | null
  follows?: boolean | null
  layer?: string | null
}

/** A value as the page received it: JSON's form (a Date as its ISO text, a Decimal as its text), `undefined` as null. */
function asJson(value: unknown): unknown {
  if (value === undefined) return null
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

/** The stamp of one cell as the sheet read sends it, or undefined when there is no cell. */
export function sheetCellStamp(cell: SheetStampCell | null | undefined): SheetCellStamp | undefined {
  if (!cell || typeof cell !== 'object') return undefined
  return {
    value: asJson(cell.value),
    from: {
      tier: typeof cell.tier === 'string' ? cell.tier : null,
      inherited: cell.inherited === true,
      pinned: cell.pinned === true,
      follows: typeof cell.follows === 'boolean' ? cell.follows : null,
      layer: typeof cell.layer === 'string' ? cell.layer : null,
    },
  }
}

/** One stamp as text: keys in order, absent and `undefined` alike — so a stamp read back from JSON equals what was sent. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/** Is this a stamp's shape (as a request carries it)? Anything else is no stamp: the version alone decides. */
export function isSheetCellStamp(value: unknown): value is SheetCellStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('value' in value)) return false
  const from = (value as { from?: unknown }).from
  return !!from && typeof from === 'object' && !Array.isArray(from)
}

/**
 * Does the stamp a write carries still hold on this cell — is it the value the person saw, from the same place? A
 * missing stamp, or no cell, never holds (the version decides).
 */
export function sheetStampHolds(expected: unknown, cell: SheetStampCell | null | undefined): boolean {
  if (!isSheetCellStamp(expected)) return false
  const now = sheetCellStamp(cell)
  return now !== undefined && canonical(asJson(now)) === canonical(asJson(expected))
}
