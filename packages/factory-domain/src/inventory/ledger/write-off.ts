import type { Issue } from '../../core/errors'

/**
 * Write-off (B-W2a-11; SCM-193; design warehouse.moves › Write off, warehouse.hides › Scrap N hides), pure. Stock that is
 * damaged, expired, obsolete or lost leaves the site as SCRAP moves (postMoves, valued at the lot's cost or the item's
 * standard cost, cost grain only), with a code of the tenant's WRITE_OFF reason list (ReasonCode, wave 1: DAMAGED,
 * EXPIRED, OBSOLETE, LOST, OTHER; a code that needs detail needs the note) and, after it, photos (PHOTO files of the
 * record `StockWriteOff` whose id is the write-off's: its first move's id). A hide goes whole, from wherever it lies,
 * and becomes SCRAPPED; a lot or untracked material goes by quantity from one location.
 *
 * StockMove has no reason-code column (schema need, named in the step notes): the move's note carries the code first,
 * `<CODE>: <note>` (a code has no spaces; the …_supply_guards trigger wants a SCRAP's note anyway), and its idempotency
 * key starts `inventory.writeOff:` (the command's key, one per write-off: `inventory.writeOff:<key>:<n>`). Both are
 * written only by the write-off command, so `writeOffOf` reads them back exactly.
 */

export const WRITE_OFF_COMMAND = 'inventory.writeOff'
/** The record type of a write-off's photos (StoredFile.recordType); the record id is the write-off's. */
export const WRITE_OFF_RECORD = 'StockWriteOff'
export const WRITE_OFF_REASON_LIST = 'WRITE_OFF'
export const MAX_WRITE_OFF_LINES = 200

/** The move note of a write-off: the reason code, then the person's words. */
export const writeOffNote = (reasonCode: string, note: string | null | undefined): string => {
  const text = (note ?? '').trim()
  return text ? `${reasonCode}: ${text}` : reasonCode
}

/** A SCRAP move posted by the write-off command, read back: its reason code and the person's words; else null. */
export function writeOffOf(move: { readonly reason: string; readonly idempotencyKey: string; readonly note: string | null }): { readonly reasonCode: string; readonly note: string | null } | null {
  if (move.reason !== 'SCRAP' || !move.idempotencyKey.startsWith(`${WRITE_OFF_COMMAND}:`)) return null
  const match = /^([^\s:]+)(?::\s?([\s\S]*))?$/.exec(move.note ?? '')
  if (!match) return null
  return { reasonCode: match[1]!, note: match[2]?.trim() || null }
}

/** The write-off a move belongs to: `inventory.writeOff:<key>` without its `:<n>`, or null. */
export function writeOffGroupOf(idempotencyKey: string): string | null {
  if (!idempotencyKey.startsWith(`${WRITE_OFF_COMMAND}:`)) return null
  const cut = idempotencyKey.lastIndexOf(':')
  return cut > WRITE_OFF_COMMAND.length && /^\d+$/.test(idempotencyKey.slice(cut + 1)) ? idempotencyKey.slice(0, cut) : null
}

/** One line of a write-off as the person names it. */
export interface WriteOffLineInput {
  readonly hideId?: string | null | undefined
  readonly fromLocationId?: string | null | undefined
  readonly quantity?: string | null | undefined
}

/** The shape problems of a write-off's lines (paths `lines/<i>/…`): a hide goes whole; anything else by quantity, from one location. */
export function writeOffLineProblems(lines: readonly WriteOffLineInput[]): Issue[] {
  const problems: Issue[] = []
  if (lines.length === 0) problems.push({ path: 'lines', message: 'Write off at least one line.' })
  if (lines.length > MAX_WRITE_OFF_LINES) problems.push({ path: 'lines', message: `At most ${MAX_WRITE_OFF_LINES} lines at once.` })
  const hides = new Set<string>()
  lines.forEach((line, index) => {
    if (line.hideId) {
      if (line.quantity !== undefined && line.quantity !== null) problems.push({ path: `lines/${index}/quantity`, message: 'A hide is written off whole: leave the quantity out.' })
      if (hides.has(line.hideId)) problems.push({ path: `lines/${index}/hideId`, message: 'This hide is named twice.' })
      hides.add(line.hideId)
    } else {
      if (line.quantity === undefined || line.quantity === null) problems.push({ path: `lines/${index}/quantity`, message: 'How much leaves stock?' })
      if (!line.fromLocationId) problems.push({ path: `lines/${index}/fromLocationId`, message: 'From which location?' })
    }
  })
  return problems
}

/** The reason code's problem for a write-off, or null: one of the tenant's active WRITE_OFF codes; one that needs detail needs the note. */
export function writeOffReasonProblem(code: { readonly active: boolean; readonly needsDetail: boolean } | null, note: string | null | undefined): Issue | null {
  if (!code || !code.active) return { path: 'reasonCode', message: 'Not an active write-off reason of this company.' }
  if (code.needsDetail && !(note ?? '').trim()) return { path: 'note', message: 'This reason needs a note: say what happened.' }
  return null
}
