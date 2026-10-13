/**
 * Field stamps (2026-10-13) — what a Matrix cell SHOWED when the person edited it: the value of exactly the field(s) its
 * write changes. ONE function for the page (it stamps each write) and for the door (it compares), so the two can never
 * read a cell differently.
 *
 * Why: `ChannelListing.version` is one number for the whole listing, and a sale, a stock cascade, a master price change or
 * another cell's write moves it. A moved version says that SOMETHING on the listing changed, not that THIS field did, so a
 * version-only check refused edits whose field nobody had touched ("Changed elsewhere — reloaded"). The door now asks the
 * field (as JSON Patch `test`, DynamoDB condition expressions and Shopify's `compareQuantity` do):
 *   - the version matches               → the write goes ahead, as before;
 *   - the version moved, the stamp holds → the write goes ahead at the fresh version;
 *   - the stamped field moved           → refused, `changedElsewhere`, with the current value.
 *
 * The stamp per kind (`undefined` = this cell has none: the version alone decides, as for an older client):
 *   syncMode       { mode }
 *   syncQty        Follow: { mode } — Owner 4A: a number typed into a Follow cell pins AT that number, whatever the
 *                  follow number did since (a sale moves it all day). Pinned: { mode, qty } — the pinned number.
 *   syncBuffer     { buffer }
 *   fulfilment     { method, set }
 *   price          { own } — the listing's OWN price: the override, or null while it follows the master (the master's
 *                  number moving under a following cell is not this field). A clamped or formula price has no stamp.
 *   salePrice      { sale }
 *   businessPrice  { business } — the whole setting (rule, percent, exact price, tiers); null = no business offer. The
 *   businessTiers  numbers worked out from the normal price (the price a percent gives, each tier's unit price) are not in it.
 *   source         { codes } — this listing's own "Sells from" list, in sale order.
 *
 * Pure: no React, no Prisma — reachable from both apps' node tests and the API's services.
 */
import type { MatrixCells, MatrixCellStamp, MatrixDoorKind } from './matrix-contract.js'

export function matrixCellStamp(kind: MatrixDoorKind, cells: MatrixCells | null | undefined): MatrixCellStamp | undefined {
  if (!cells) return undefined
  switch (kind) {
    case 'syncMode':
      return cells.sync ? { mode: cells.sync.mode } : undefined
    case 'syncQty': {
      const s = cells.sync
      if (!s) return undefined
      return s.mode === 'PINNED' ? { mode: 'PINNED', qty: s.intended ?? s.held } : { mode: 'FOLLOW' }
    }
    case 'syncBuffer':
      return cells.sync ? { buffer: cells.sync.buffer } : undefined
    case 'fulfilment':
      return cells.fulfilment ? { method: cells.fulfilment.method, set: cells.fulfilment.source === 'set' } : undefined
    case 'price': {
      const p = cells.price
      if (!p || p.clamped) return undefined
      return p.source === 'override' ? { own: p.value } : p.source === 'master' ? { own: null } : undefined
    }
    case 'salePrice':
      return cells.sale ? { sale: { value: cells.sale.value, start: cells.sale.start, end: cells.sale.end } } : undefined
    case 'businessPrice':
    case 'businessTiers': {
      const b = cells.business
      if (!b) return undefined
      if (!b.rule) return { business: null }
      return {
        business: {
          rule: b.rule,
          percent: b.rule === 'PERCENT_OFF' ? b.percent : null,
          exact: b.rule === 'FIXED' ? b.exact : null,
          tiers: b.tiers ? { type: b.tiers.type, levels: b.tiers.levels.map((l) => ({ minQty: l.minQty, value: l.value })) } : null,
        },
      }
    }
    case 'source':
      return cells.source ? { codes: [...cells.source.own] } : undefined
  }
}

/** One stamp as text: keys in order, absent and `undefined` alike — so `{}` read back from JSON equals what was sent. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/**
 * Does the stamp a write carries still hold on these cells — is every field it names what the person saw? A missing
 * stamp, or a cell that has no stamp of this kind now, never holds (the version decides).
 */
export function matrixStampHolds(kind: MatrixDoorKind, expected: MatrixCellStamp | null | undefined, cells: MatrixCells | null | undefined): boolean {
  if (!expected || typeof expected !== 'object') return false
  const now = matrixCellStamp(kind, cells)
  return now !== undefined && canonical(now) === canonical(expected)
}
