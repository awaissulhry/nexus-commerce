import type { Issue } from '../../core/errors'
import { REASON_CODE } from '../../reasons/rules'
import { defineMachine } from '../../state/machine'
import { parseDecimal } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../ledger/moves'

/**
 * What was wrong with a delivery (B-W2a-31; SCM-118; design warehouse.receipts rec "Discrepancies", pop rc-disc-new and
 * rc-disc-send), pure. apps/factory-api's modules/inventory/receipts writes them through command(); the
 * …_supply_w2a_guards trigger holds the same states for every login (factory-db claims.prisma ReceiptDiscrepancy).
 *
 *   record   on an OPEN or POSTED receipt: its kind (short, over, damaged, the wrong item or colour, a missing document,
 *            other), the reason from the tenant's DISCREPANCY list (B-W2a-18; the standard SHORT, OVER, WRONG_ITEM and
 *            DAMAGED are also kinds, so one gives the other), the receipt line it is about (none: the delivery as a
 *            whole), how much with its unit (both or neither), the receiver's note and photos. Numbered 10, 20, 30 … on
 *            the receipt.
 *   change   only while OPEN (never sent); removed only while OPEN (recorded by mistake).
 *   report   the report to the supplier (a PDF, no price: Owner answer C2) moves every OPEN one it names to SENT, with
 *            when and who; one already SENT can be in a later report again (a reminder) and stays as it is.
 *   settle   SENT → AGREED (the supplier accepts it) → CREDITED (its credit arrived); CLOSED from any state but CLOSED,
 *            with what settled it (or why it is not pursued). CLOSED is final.
 *
 * The reason code has no column of its own on ReceiptDiscrepancy (W2a wave 3): it leads the note as `<CODE>: <note>`, as
 * a write-off's does (B-W2a-11); `discrepancyNote` writes it and `readDiscrepancyNote` reads it back for the codes the
 * list knows. A schema follow-up may give it a column.
 */

export const DISCREPANCY_KINDS = ['SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'WRONG_COLOUR', 'MISSING_DOCUMENT', 'OTHER'] as const
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number]

export const DISCREPANCY_STATUSES = ['OPEN', 'SENT', 'AGREED', 'CREDITED', 'CLOSED'] as const
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number]

/** The reason list a discrepancy's code is from (factory-domain reasons/lists). */
export const DISCREPANCY_REASON_LIST = 'DISCREPANCY' as const

export const DISCREPANCY_LIMITS = Object.freeze({ note: 1000, resolution: 500, perReceipt: 200, photos: 10, reportRecipients: 5, message: 4000 })

/** The moves the trigger allows; SENT is entered only by a report to the supplier. */
export const discrepancyMachine = defineMachine<DiscrepancyStatus>({
  name: 'receipt discrepancy',
  states: DISCREPANCY_STATUSES,
  transitions: {
    OPEN: ['SENT', 'CLOSED'],
    SENT: ['AGREED', 'CLOSED'],
    AGREED: ['CREDITED', 'CLOSED'],
    CREDITED: ['CLOSED'],
  },
})

/** The moves a person makes by hand (the report makes OPEN → SENT). */
export const SETTLE_STATUSES = ['AGREED', 'CREDITED', 'CLOSED'] as const satisfies readonly DiscrepancyStatus[]
export type SettleStatus = (typeof SETTLE_STATUSES)[number]

export const DISCREPANCY_KIND_WORDS: Readonly<Record<'it' | 'en', Readonly<Record<DiscrepancyKind, string>>>> = Object.freeze({
  en: Object.freeze({ SHORT: 'Short', OVER: 'Over', DAMAGED: 'Damaged', WRONG_ITEM: 'Wrong item', WRONG_COLOUR: 'Wrong colour', MISSING_DOCUMENT: 'Missing document', OTHER: 'Other' }),
  it: Object.freeze({ SHORT: 'Quantità mancante', OVER: 'Quantità in eccesso', DAMAGED: 'Danneggiato', WRONG_ITEM: 'Articolo errato', WRONG_COLOUR: 'Colore errato', MISSING_DOCUMENT: 'Documento mancante', OTHER: 'Altro' }),
})

export const DISCREPANCY_STATUS_WORDS: Readonly<Record<DiscrepancyStatus, string>> = Object.freeze({
  OPEN: 'open: recorded, not reported to the supplier yet',
  SENT: 'reported to the supplier, waiting for the answer',
  AGREED: 'the supplier agreed: waiting for the credit or the replacement',
  CREDITED: 'credited by the supplier',
  CLOSED: 'closed',
})

const isKind = (value: string): value is DiscrepancyKind => (DISCREPANCY_KINDS as readonly string[]).includes(value)

/**
 * The kind and the reason code of a new or changed discrepancy: either may give the other. A reason code that is also a
 * kind (the standard SHORT, OVER, WRONG_ITEM, DAMAGED) gives that kind; a kind that is also an active code of the list
 * gives that code. A code of the tenant's own (STAINS) needs the kind named. A code that is a kind and a different kind
 * named do not agree.
 */
export function kindAndReason(
  given: { readonly kind?: DiscrepancyKind | null | undefined; readonly reasonCode?: string | null | undefined },
  activeCodes: ReadonlySet<string>,
): { readonly kind: DiscrepancyKind; readonly reasonCode: string | null; readonly problems?: undefined } | { readonly problems: Issue[] } {
  const code = given.reasonCode?.trim() ? given.reasonCode.trim().toUpperCase() : null
  const kind = given.kind ?? null
  const problems: Issue[] = []
  if (code !== null && !REASON_CODE.test(code)) problems.push({ path: 'body/reasonCode', message: 'A reason code is upper-case letters, digits and underscores (SHORT).' })
  else if (code !== null && !activeCodes.has(code)) problems.push({ path: 'body/reasonCode', message: `${code} is not an active reason of the discrepancy list: pick one of ${[...activeCodes].sort().join(', ') || 'none (an admin adds them under the reason lists)'}.` })
  if (code !== null && kind !== null && isKind(code) && code !== kind) problems.push({ path: 'body/kind', message: `The reason ${code} is a ${DISCREPANCY_KIND_WORDS.en[code].toLowerCase()} delivery: its kind is ${code}, not ${kind}.` })
  if (kind === null && code === null) problems.push({ path: 'body/kind', message: 'Say what was wrong: the kind (short, over, damaged, the wrong item or colour, a missing document) or the reason.' })
  if (kind === null && code !== null && !isKind(code) && problems.length === 0) problems.push({ path: 'body/kind', message: `The reason ${code} is your own: name the kind of problem too (short, over, damaged, wrong item, wrong colour, missing document or other).` })
  if (problems.length > 0) return { problems }
  const resolvedKind = kind ?? (code as DiscrepancyKind)
  return { kind: resolvedKind, reasonCode: code ?? (activeCodes.has(resolvedKind) ? resolvedKind : null) }
}

/** The note as stored: the reason code first (`DAMAGED: two hides with holes`), then the receiver's words; null: nothing. */
export function discrepancyNote(reasonCode: string | null, note: string | null | undefined): string | null {
  const text = note?.trim() ? note.trim() : null
  if (reasonCode === null) return text
  return text === null ? reasonCode : `${reasonCode}: ${text}`
}

const LEAD = /^([A-Z][A-Z0-9_]{1,39})(?::\s?([\s\S]*))?$/

/** The stored note read back: its reason code (one the list knows) and the receiver's words. */
export function readDiscrepancyNote(stored: string | null, knownCodes: ReadonlySet<string>): { readonly reasonCode: string | null; readonly note: string | null } {
  if (stored === null) return { reasonCode: null, note: null }
  const match = LEAD.exec(stored)
  if (!match || !knownCodes.has(match[1]!)) return { reasonCode: null, note: stored }
  const rest = match[2]?.trim() ?? ''
  return { reasonCode: match[1]!, note: rest === '' ? null : rest }
}

/** A discrepancy's quantity: above 0, at most four decimals, with its unit; both or neither. */
export function discrepancyQuantityProblems(quantity: string | null | undefined, uom: string | null | undefined): Issue[] {
  const hasQuantity = quantity !== null && quantity !== undefined && quantity.trim() !== ''
  const hasUnit = uom !== null && uom !== undefined
  if (!hasQuantity && !hasUnit) return []
  if (hasQuantity !== hasUnit) return [{ path: hasQuantity ? 'body/uom' : 'body/quantity', message: 'Give the quantity and its unit together, or neither.' }]
  const value = parseDecimal(quantity)
  if (value === null) return [{ path: 'body/quantity', message: 'Expected a plain decimal such as 12.5.' }]
  if (value.lessThanOrEqualTo(0)) return [{ path: 'body/quantity', message: 'Above 0.' }]
  if (value.decimalPlaces() > QUANTITY_SCALE) return [{ path: 'body/quantity', message: `At most ${QUANTITY_SCALE} decimals.` }]
  return []
}

/** The next number on the receipt's list (10, 20, 30 …). */
export const nextDiscrepancySeq = (taken: readonly number[]): number => (taken.length === 0 ? 10 : Math.floor(Math.max(...taken) / 10) * 10 + 10)

/** Why a discrepancy cannot be changed or removed now, or null. */
export function discrepancyEditProblem(status: DiscrepancyStatus, what: 'change' | 'remove'): string | null {
  if (status === 'OPEN') return null
  return what === 'remove'
    ? `This discrepancy was ${status === 'CLOSED' ? 'closed' : 'reported to the supplier'}: it is never removed; close it with what settled it.`
    : `This discrepancy was ${status === 'CLOSED' ? 'closed' : 'reported to the supplier'}: what was found no longer changes. Record a new one if more was found.`
}

/** Why a settle move is refused, or null (a note is required to close). */
export function settleProblems(from: DiscrepancyStatus, to: SettleStatus, note: string | null | undefined): Issue[] {
  const allowed = discrepancyMachine.transitions[from] ?? []
  if (!allowed.includes(to)) {
    const words =
      from === 'CLOSED'
        ? 'It is closed: it changes no more.'
        : to === 'AGREED'
          ? 'Only a discrepancy reported to the supplier (SENT) is agreed: send the report first.'
          : to === 'CREDITED'
            ? 'Only a discrepancy the supplier agreed (AGREED) is credited.'
            : `It cannot move from ${from} to ${to}.`
    return [{ path: 'body/to', message: words }]
  }
  if (to === 'CLOSED' && !note?.trim()) return [{ path: 'body/note', message: 'Say what settled it, or why it is not pursued.' }]
  return []
}

/** Which of the discrepancies a report names: OPEN ones move to SENT, SENT ones go again as they are, the others are refused. */
export function reportSelection(rows: readonly { readonly id: string; readonly seq: number; readonly status: DiscrepancyStatus }[], ids: readonly string[] | null): { readonly chosen: string[]; readonly toSend: string[]; readonly problems: Issue[] } {
  const wanted = ids === null ? rows.filter((row) => row.status === 'OPEN').map((row) => row.id) : [...new Set(ids)]
  const problems: Issue[] = []
  const byId = new Map(rows.map((row) => [row.id, row]))
  wanted.forEach((id, index) => {
    const row = byId.get(id)
    if (!row) problems.push({ path: `body/discrepancyIds/${index}`, message: 'Not a discrepancy of this receipt.' })
    else if (row.status !== 'OPEN' && row.status !== 'SENT') problems.push({ path: `body/discrepancyIds/${index}`, message: `Discrepancy ${row.seq} is ${row.status.toLowerCase()}: the supplier answered it already.` })
  })
  if (wanted.length === 0) problems.push({ path: 'body/discrepancyIds', message: ids === null ? 'Nothing is open to report: every discrepancy of this receipt was reported or closed.' : 'Name at least one discrepancy.' })
  const chosen = wanted.filter((id) => byId.has(id))
  return { chosen, toSend: chosen.filter((id) => byId.get(id)!.status === 'OPEN'), problems }
}
