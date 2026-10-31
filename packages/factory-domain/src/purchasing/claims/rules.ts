import type { Issue } from '../../core/errors'
import { isCurrencyCode, toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import { Dec } from '../../tax/decimal'

/**
 * Supplier claims and returns to the supplier (B-W2a-44; SCM-134; design purchasing.claims SCR-131; factory-db
 * claims.prisma SupplierClaim, SupplierClaimLine), pure.
 *
 *   claim     to ONE supplier from ONE site of a company, numbered from the company's CLAIM series (CLM-…): a RETURN
 *             sends the goods back (each line's stock out and the return DDT), a CLAIM keeps them (an area of leather
 *             found bad at cutting) and asks for a credit or a replacement. DRAFT while it is prepared → SENT (to the
 *             supplier, waiting for its answer) → ACCEPTED or REJECTED → CLOSED (settled, or given up); REJECTED → SENT
 *             again with more evidence; a DRAFT is CANCELLED. The …_supply_w2a_guards trigger holds the same moves.
 *   reason    a code of the tenant's CLAIM reason list (B-W2b-14: its own column SupplierClaim.reasonCode, fixed once
 *             sent) and the person's words in `reason` (the code itself when there are none: the column is required).
 *             W2a wrote the code at the head of the text (`QUALITY: holes near the belly`): `claimReasonOf` reads both.
 *   lines     what the claim is about: a lot, a hide or untracked material, how much (in its unit and the item's base
 *             unit), the discrepancy of a receipt it pursues; what is in them is fixed once the claim is sent. A RETURN
 *             line goes back once: its stock move out and its return DDT are each set once.
 *   credit    each line's value = its cost per base unit × base quantity (the lot's cost, or what its stock left at),
 *             rounded once to minor units; the credit asked = the lines' sum when a credit is the remedy (none for a
 *             replacement), or the amount agreed with the supplier. Costs: money.cost, office only.
 *
 * Nothing here reads or writes the database.
 */

export const CLAIM_KINDS = ['RETURN', 'CLAIM'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

export const CLAIM_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CLOSED', 'CANCELLED'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

export const CLAIM_FOUND_AT = ['RECEIPT', 'STOCK', 'CUTTING', 'PRODUCTION', 'INSPECTION'] as const
export type ClaimFoundAt = (typeof CLAIM_FOUND_AT)[number]

export const CLAIM_REMEDIES = ['CREDIT', 'REPLACEMENT'] as const
export type ClaimRemedy = (typeof CLAIM_REMEDIES)[number]

/** The answers the supplier gives a sent claim. */
export const CLAIM_OUTCOMES = ['ACCEPTED', 'REJECTED'] as const
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number]

/** The reason list of platform/reasons whose codes lead a claim's reason. */
export const CLAIM_REASON_LIST = 'CLAIM' as const

/** Not settled yet: the list's "open" ones (the Open tile). */
export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = Object.freeze(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'])
/** The goods of a return claim go back once it was sent, until it is closed (the DDT trigger's states). */
export const RETURN_STATUSES: readonly ClaimStatus[] = Object.freeze(['SENT', 'ACCEPTED'])

export const SEQ_STEP = 10
export const CLAIM_LIMITS = Object.freeze({ lines: 100, recipients: 10, reasonNote: 500, answer: 2000, note: 1000, photos: 20 })

const MOVES: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'REJECTED', 'CLOSED'],
  ACCEPTED: ['CLOSED'],
  REJECTED: ['SENT', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
}

/** The claim may move from `from` to `to` (the trigger's list). */
export const canMove = (from: ClaimStatus, to: ClaimStatus): boolean => MOVES[from].includes(to)

const STATUS_WORDS: Readonly<Record<ClaimStatus, string>> = {
  DRAFT: 'a draft',
  SENT: 'sent, waiting for the supplier',
  ACCEPTED: 'accepted by the supplier',
  REJECTED: 'rejected by the supplier',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
}

/** The claim's state in words ("CLM-2026-0004 is closed"). */
export const statusWords = (status: ClaimStatus): string => STATUS_WORDS[status]

// ---- the reason ---------------------------------------------------------------------------------------------------------

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/

/** The claim's reason as stored: the code of the CLAIM list first, then the person's words. */
export function claimReasonText(code: string, note: string | null | undefined): string {
  const words = note?.trim() ?? ''
  return words === '' ? code : `${code}: ${words}`
}

/** A stored reason read back: its code (null for a reason typed before the list) and the words after it. */
export function readClaimReason(text: string): { readonly code: string | null; readonly note: string | null } {
  const at = text.indexOf(':')
  const head = (at === -1 ? text : text.slice(0, at)).trim()
  if (!CODE.test(head)) return { code: null, note: text.trim() || null }
  const note = at === -1 ? '' : text.slice(at + 1).trim()
  return { code: head, note: note === '' ? null : note }
}

/**
 * The claim's reason as written (B-W2b-14): the code in its own column, the person's words in `reason` — the code itself
 * when there are none (the column is required and never blank).
 */
export function claimReasonColumns(code: string, note: string | null | undefined): { readonly reasonCode: string; readonly reason: string } {
  const words = note?.trim() ?? ''
  return { reasonCode: code, reason: words === '' ? code : words }
}

/**
 * A stored claim's reason read back: the reasonCode column and the words in `reason` (none when it holds only the code);
 * a claim made before W2b (no column value): the code at the head of the text (readClaimReason).
 */
export function claimReasonOf(row: { readonly reasonCode: string | null; readonly reason: string }): { readonly code: string | null; readonly note: string | null } {
  if (row.reasonCode === null) return readClaimReason(row.reason)
  const words = row.reason.trim()
  return { code: row.reasonCode, note: words === '' || words === row.reasonCode ? null : words }
}

/** The CLAIM reason code a person chose, checked against the tenant's list (paths under `prefix`). */
export function reasonProblems(row: { readonly active: boolean; readonly needsDetail: boolean } | null, code: string, note: string | null | undefined, prefix = 'body'): Issue[] {
  if (!row) return [{ path: `${prefix}/reasonCode`, message: `${code} is not a reason of the claim list.` }]
  if (!row.active) return [{ path: `${prefix}/reasonCode`, message: `${code} is no longer in use: choose another reason.` }]
  if (row.needsDetail && !(note?.trim())) return [{ path: `${prefix}/reasonNote`, message: 'This reason needs a few words: say what is wrong.' }]
  if ((note?.trim().length ?? 0) > CLAIM_LIMITS.reasonNote) return [{ path: `${prefix}/reasonNote`, message: `At most ${CLAIM_LIMITS.reasonNote} characters.` }]
  return []
}

/** Where the problem was found, when nobody says: a lot still in quarantine at receiving, a rejected or blocked one at inspection, else in stock. */
export function foundAtFor(lotStatus: string | null | undefined): ClaimFoundAt {
  if (lotStatus === 'QUARANTINE') return 'RECEIPT'
  if (lotStatus === 'REJECTED' || lotStatus === 'BLOCKED') return 'INSPECTION'
  return 'STOCK'
}

// ---- what may be done now (409 words) -------------------------------------------------------------------------------------

export interface ClaimFacts {
  readonly number: string
  readonly kind: ClaimKind
  readonly status: ClaimStatus
  readonly remedy: ClaimRemedy | null
  /** Its lines: their place and whether their goods went back (a stock move out). */
  readonly lines: readonly { readonly id: string; readonly seq: number; readonly moved: boolean }[]
}

const named = (facts: Pick<ClaimFacts, 'number' | 'status'>) => `Claim ${facts.number} is ${statusWords(facts.status)}`

/** Its content (header, reason, lines) changes only while it is a draft. */
export function editProblems(facts: Pick<ClaimFacts, 'number' | 'status'>, what = 'its lines change'): string[] {
  return facts.status === 'DRAFT' ? [] : [`${named(facts)}; ${what} only while it is a draft.`]
}

/** A draft (or a rejected claim, again with more evidence) goes to the supplier: with a line and a remedy. */
export function sendProblems(facts: ClaimFacts): string[] {
  if (facts.status !== 'DRAFT' && facts.status !== 'REJECTED') return [`${named(facts)}; only a draft, or a claim the supplier rejected, is sent.`]
  const problems: string[] = []
  if (facts.lines.length === 0) problems.push(`Claim ${facts.number} has no line: say what it is about first.`)
  if (facts.remedy === null) problems.push(`Claim ${facts.number} asks for nothing yet: choose a credit or a replacement.`)
  return problems
}

/** The supplier answers a sent claim. */
export function answerProblems(facts: Pick<ClaimFacts, 'number' | 'status'>): string[] {
  return facts.status === 'SENT' ? [] : [`${named(facts)}; only a sent claim gets the supplier's answer.`]
}

/** A sent, accepted or rejected claim is closed, with how it was settled. */
export function closeProblems(facts: Pick<ClaimFacts, 'number' | 'status'>): string[] {
  return canMove(facts.status, 'CLOSED') ? [] : [`${named(facts)}; ${facts.status === 'DRAFT' ? 'cancel a draft instead' : 'it changes no more'}.`]
}

/** Only a draft is cancelled (a sent one is closed). */
export function cancelProblems(facts: Pick<ClaimFacts, 'number' | 'status'>): string[] {
  return facts.status === 'DRAFT' ? [] : [`${named(facts)}; only a draft is cancelled${canMove(facts.status, 'CLOSED') ? ' (close it instead)' : ''}.`]
}

/**
 * The goods of a return claim go back: a RETURN, sent or accepted, and lines whose goods are still here (`lineIds`: the
 * ones named, else every one not gone yet).
 */
export function returnProblems(facts: ClaimFacts, lineIds?: readonly string[]): string[] {
  if (facts.kind !== 'RETURN') return [`Claim ${facts.number} keeps the goods (a claim for credit or replacement): only a return claim sends goods back.`]
  if (!RETURN_STATUSES.includes(facts.status)) {
    return [facts.status === 'DRAFT' ? `Claim ${facts.number} is a draft: send it to the supplier first (its goods go back once it is sent).` : `${named(facts)}; its goods go back only while it is sent or accepted.`]
  }
  const chosen = lineIds ? facts.lines.filter((line) => lineIds.includes(line.id)) : facts.lines.filter((line) => !line.moved)
  if (chosen.length === 0) return [`Every line of claim ${facts.number} went back already.`]
  const gone = chosen.filter((line) => line.moved)
  return gone.length === 0 ? [] : [`${gone.length === 1 ? `Line ${gone[0]!.seq} went` : `Lines ${gone.map((line) => line.seq).join(', ')} went`} back already.`]
}

/**
 * Photos of what is wrong (B-W2b-14; design purchasing.claims rec "Claim" photos): added while the claim is not settled
 * (a rejected claim goes again with more evidence), at most CLAIM_LIMITS.photos; removed only while it is a draft (once
 * sent, the supplier may have seen them in the claim letter's count).
 */
export function photoProblems(facts: Pick<ClaimFacts, 'number' | 'status'>, what: 'add' | 'remove', held = 0): string[] {
  if (what === 'remove') return facts.status === 'DRAFT' ? [] : [`${named(facts)}; its photos are removed only while it is a draft.`]
  if (facts.status === 'CLOSED' || facts.status === 'CANCELLED') return [`${named(facts)}; it takes no more photos.`]
  return held >= CLAIM_LIMITS.photos ? [`Claim ${facts.number} holds ${CLAIM_LIMITS.photos} photos already.`] : []
}

export const CLAIM_ACTIONS = ['edit', 'send', 'answer', 'close', 'cancel', 'returnGoods'] as const
export type ClaimAction = (typeof CLAIM_ACTIONS)[number]

/** What may be done to the claim now: null = allowed, else why not, in words (the record's band holds the action). */
export function claimActions(facts: ClaimFacts): Record<ClaimAction, string | null> {
  const first = (problems: readonly string[]) => (problems.length === 0 ? null : problems.join(' '))
  return {
    edit: first(editProblems(facts)),
    send: first(sendProblems(facts)),
    answer: first(answerProblems(facts)),
    close: first(closeProblems(facts)),
    cancel: first(cancelProblems(facts)),
    returnGoods: first(returnProblems(facts)),
  }
}

// ---- the credit -----------------------------------------------------------------------------------------------------------

/** A line's value in minor units of the claim's currency: cost per base unit × base quantity, rounded once (null: no cost). */
export function lineCredit(unitCost: string | null | undefined, baseQuantity: string, currency: CurrencyCode): MinorUnits | null {
  if (unitCost === null || unitCost === undefined || !isCurrencyCode(currency)) return null
  const amount = toMinorUnits(new Dec(unitCost).times(baseQuantity), currency)
  return amount === 0 ? 0 : amount
}

/** The value of the goods the claim is about: the sum of its lines' (null when no line has a cost). */
export function linesValue(lines: readonly { readonly creditAmount: number | null }[]): MinorUnits | null {
  const valued = lines.filter((line) => line.creditAmount !== null)
  return valued.length === 0 ? null : valued.reduce((sum, line) => sum + line.creditAmount!, 0)
}

/** The credit asked, kept on the claim: the lines' value when a credit is the remedy (or not chosen yet); none for a replacement. */
export function expectedCredit(remedy: ClaimRemedy | null, lines: readonly { readonly creditAmount: number | null }[]): MinorUnits | null {
  return remedy === 'REPLACEMENT' ? null : linesValue(lines)
}

/** Whole days since it was made (the list's age). */
export const ageDays = (since: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000))

/** The next line's place: 10, 20, 30 … */
export const nextSeq = (seqs: readonly number[]): number => (seqs.length === 0 ? SEQ_STEP : Math.max(...seqs) + SEQ_STEP)
