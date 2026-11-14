import type { MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { foldWord } from '../../imports/cells'
import { normaliseBankReference } from '../payments'

/**
 * Matching bank lines (B-W2b-393; FIN-132; design finance.bank sec:match "Suggestion: invoice(s), confidence High ·
 * Medium · Low, reasons in words ('amount equal', 'invoice number in the reference', 'IBAN known')"), pure. For one line,
 * what it may be, each with how sure and why:
 *
 *   money in (above 0)   the customer's open items it pays — issued TD01/TD24 invoices (by number) and open deposit
 *                        requests (by their order's number) — or a payment already typed by hand that it is (the same
 *                        amount; its bank reference in the line)
 *   money out (below 0)  the supplier invoice it paid (the amount to pay: gross less withholding)
 *
 * The reasons: AMOUNT_EQUAL (what is open equals the line), AMOUNT_WITHIN_TOLERANCE (the difference is within the
 * company's write-off tolerance, money in only), NUMBER_IN_REFERENCE (the item's number is in the reference text, read as
 * its letters and digits: "FT 2026/00001" is FT-2026-00001), IBAN_KNOWN (the other side's IBAN is one we know for the
 * party: a line accepted for it before, or a supplier's bank account), NAME_MATCHES (the other side's name is the
 * party's, legal forms and punctuation left out). Points: number 3, amount equal 3, within tolerance 2, IBAN 2, name 1.
 * HIGH needs 5 points with an amount reason and the number or the IBAN; MEDIUM 3 points; LOW the rest. Two suggestions of
 * a line that tie at the top are each one step less sure (the person chooses). At most MAX_SUGGESTIONS per line. A person
 * accepts every one: nothing moves by a suggestion alone.
 */

export const MATCH_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number]

export const MATCH_REASONS = ['AMOUNT_EQUAL', 'AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES', 'CHOSEN_BY_PERSON'] as const
export type MatchReason = (typeof MATCH_REASONS)[number]

export const MATCH_REASON_WORDS: Readonly<Record<MatchReason, string>> = Object.freeze({
  AMOUNT_EQUAL: 'amount equal',
  AMOUNT_WITHIN_TOLERANCE: 'amount within the write-off tolerance',
  NUMBER_IN_REFERENCE: 'number in the reference',
  IBAN_KNOWN: 'IBAN known',
  NAME_MATCHES: 'name matches',
  CHOSEN_BY_PERSON: 'chosen by a person',
})

export const MATCH_CONFIDENCE_WORDS: Readonly<Record<MatchConfidence, string>> = Object.freeze({ HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' })

/** The most suggestions kept for one line, and the most items one suggestion names (the database's limit). */
export const MAX_SUGGESTIONS = 3
export const MAX_MATCH_ITEMS = 50

const POINTS: Readonly<Record<MatchReason, number>> = { NUMBER_IN_REFERENCE: 3, AMOUNT_EQUAL: 3, AMOUNT_WITHIN_TOLERANCE: 2, IBAN_KNOWN: 2, NAME_MATCHES: 1, CHOSEN_BY_PERSON: 0 }

export interface LineFacts {
  readonly id: string
  /** Minor units: above 0 money in, below 0 money out. */
  readonly amount: MinorUnits
  readonly currency: string
  readonly bankReference: string | null
  readonly referenceText: string | null
  readonly counterpartyName: string | null
  readonly counterpartyIban: string | null
}

export type ItemKind = 'INVOICE' | 'DEPOSIT_REQUEST'

export interface OpenItem {
  readonly kind: ItemKind
  readonly id: string
  readonly partyId: string
  /** The invoice's number; for a deposit request, its order's number (null when it has none). */
  readonly number: string | null
  readonly currency: string
  /** What is still open on it (minor units, above 0). */
  readonly open: MinorUnits
  /** Its day (issue day, the request's day): oldest first. */
  readonly date: BusinessDate
}

export interface HandPayment {
  readonly id: string
  readonly partyId: string
  readonly amount: MinorUnits
  readonly currency: string
  readonly externalRef: string
}

export interface SupplierItem {
  readonly id: string
  readonly partyId: string
  readonly number: string
  readonly currency: string
  /** What is paid to the supplier: gross less withholding (minor units, above 0). */
  readonly due: MinorUnits
}

export interface PartyFacts {
  readonly id: string
  /** Its legal and trade names. */
  readonly names: readonly string[]
  /** The IBANs known for it (upper case, no spaces). */
  readonly ibans: readonly string[]
}

export interface MatchFacts {
  readonly parties: readonly PartyFacts[]
  readonly items: readonly OpenItem[]
  readonly payments: readonly HandPayment[]
  readonly supplierInvoices: readonly SupplierItem[]
  /** The company's write-off tolerance (minor units), or null when none is set. */
  readonly tolerance: MinorUnits | null
}

export interface Suggestion {
  readonly partyId: string
  readonly invoiceIds: readonly string[]
  readonly depositRequestIds: readonly string[]
  readonly paymentId: string | null
  readonly supplierInvoiceId: string | null
  readonly confidence: MatchConfidence
  readonly reasons: readonly MatchReason[]
  readonly points: number
}

// ---- words in a line -------------------------------------------------------------------------------------------------

/** The letters-and-digits runs of a text, upper case. */
const tokensOf = (text: string): string[] => foldWord(text).toUpperCase().split(/[^A-Z0-9]+/).filter((token) => token !== '')

/**
 * The number (of an invoice, an order, a payment's reference) is in the text: its letters and digits equal one run of the
 * text's or several next to each other ("FT-2026-00001" in "saldo FT 2026 00001", "FT2026/00001" or "FT202600001"). A
 * number of fewer than 4 letters and digits, or with no digit, is never matched (it would match anything).
 */
export function numberInText(number: string | null, text: string | null): boolean {
  if (!number || !text) return false
  const wanted = tokensOf(number).join('')
  if (wanted.length < 4 || !/\d/.test(wanted)) return false
  const tokens = tokensOf(text)
  for (let start = 0; start < tokens.length; start++) {
    let joined = ''
    for (let end = start; end < tokens.length && joined.length < wanted.length; end++) {
      joined += tokens[end]
      if (joined === wanted) return true
    }
  }
  return false
}

const LEGAL_FORMS = new Set(['SRL', 'SRLS', 'SPA', 'SNC', 'SAS', 'SAPA', 'SS', 'SCARL', 'SCRL', 'LTD', 'LIMITED', 'PLC', 'LLC', 'INC', 'CO', 'GMBH', 'AG', 'KG', 'OHG', 'SA', 'SARL', 'SL', 'BV', 'NV', 'THE', 'DI', 'AND', 'DITTA'])

/** A name's words that tell it apart: dotted legal forms joined ("S.r.l." is SRL) and left out with one-letter words. */
function nameWords(name: string): string[] {
  const joined = foldWord(name).toUpperCase().replace(/\b([A-Z])\.(?=[A-Z]\.?)/g, '$1').replace(/\./g, ' ')
  return tokensOf(joined).filter((word) => word.length >= 2 && !LEGAL_FORMS.has(word))
}

/**
 * The other side's name is the party's: every word of the shorter is in the longer (the bank's last word may be cut:
 * "SEED CUSTOMER ON" is "Seed Customer One").
 */
export function namesMatch(lineName: string | null, partyName: string): boolean {
  if (!lineName) return false
  const ours = nameWords(partyName)
  const theirs = nameWords(lineName)
  if (ours.length === 0 || theirs.length === 0) return false
  const [shorter, longer] = theirs.length <= ours.length ? [theirs, ours] : [ours, theirs]
  return shorter.every((word, index) => longer.includes(word) || (shorter === theirs && index === shorter.length - 1 && word.length >= 3 && longer.some((other) => other.startsWith(word))))
}

// ---- how sure ---------------------------------------------------------------------------------------------------------

const pointsOf = (reasons: readonly MatchReason[]): number => reasons.reduce((sum, reason) => sum + POINTS[reason], 0)

/** How sure a set of reasons is (before ties). */
export function confidenceOf(reasons: readonly MatchReason[]): MatchConfidence {
  const points = pointsOf(reasons)
  const amount = reasons.includes('AMOUNT_EQUAL') || reasons.includes('AMOUNT_WITHIN_TOLERANCE')
  const who = reasons.includes('NUMBER_IN_REFERENCE') || reasons.includes('IBAN_KNOWN')
  if (points >= 5 && amount && who) return 'HIGH'
  if (points >= 3) return 'MEDIUM'
  return 'LOW'
}

const LOWER: Readonly<Record<MatchConfidence, MatchConfidence>> = { HIGH: 'MEDIUM', MEDIUM: 'LOW', LOW: 'LOW' }

/** The reasons in the catalogue's order, each once. */
const ordered = (reasons: Iterable<MatchReason>): MatchReason[] => {
  const set = new Set(reasons)
  return MATCH_REASONS.filter((reason) => set.has(reason))
}

/** The amount reason of what is open against the line (null: neither). */
function amountReason(line: MinorUnits, open: MinorUnits, tolerance: MinorUnits | null): MatchReason | null {
  if (open === line) return 'AMOUNT_EQUAL'
  if (tolerance !== null && tolerance > 0 && Math.abs(open - line) <= tolerance) return 'AMOUNT_WITHIN_TOLERANCE'
  return null
}

interface Candidate {
  partyId: string
  items: OpenItem[]
  paymentId: string | null
  supplierInvoiceId: string | null
  reasons: MatchReason[]
}

const keyOf = (candidate: Pick<Candidate, 'items' | 'paymentId' | 'supplierInvoiceId'>): string =>
  [...candidate.items.map((item) => item.id).sort(), candidate.paymentId ?? '', candidate.supplierInvoiceId ?? ''].join(',')

/** The clues a line gives about a party: its IBAN, its name. */
function partyClues(line: LineFacts, party: PartyFacts | undefined): MatchReason[] {
  if (!party) return []
  const clues: MatchReason[] = []
  if (line.counterpartyIban !== null && party.ibans.includes(line.counterpartyIban)) clues.push('IBAN_KNOWN')
  if (party.names.some((name) => namesMatch(line.counterpartyName, name))) clues.push('NAME_MATCHES')
  return clues
}

const byAge = (a: OpenItem, b: OpenItem): number => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)

/** Money in: the customers' open items and the payments typed by hand. */
function moneyIn(line: LineFacts, facts: MatchFacts): Candidate[] {
  const parties = new Map(facts.parties.map((party) => [party.id, party]))
  const text = [line.referenceText, line.bankReference].filter((value): value is string => value !== null).join(' ')
  const candidates: Candidate[] = []
  const itemsByParty = new Map<string, OpenItem[]>()
  for (const item of facts.items) {
    if (item.currency !== line.currency || item.open <= 0) continue
    itemsByParty.set(item.partyId, [...(itemsByParty.get(item.partyId) ?? []), item])
  }
  for (const [partyId, all] of itemsByParty) {
    const items = [...all].sort(byAge)
    const clues = partyClues(line, parties.get(partyId))
    const quoted = items.filter((item) => numberInText(item.number, text))
    // The items the reference names, together.
    if (quoted.length > 0) {
      const set = quoted.slice(0, MAX_MATCH_ITEMS)
      const amount = amountReason(line.amount, set.reduce((sum, item) => sum + item.open, 0), facts.tolerance)
      candidates.push({ partyId, items: set, paymentId: null, supplierInvoiceId: null, reasons: ordered(['NUMBER_IN_REFERENCE', ...(amount ? [amount] : []), ...clues]) })
    }
    // Each item whose open amount is the line's.
    for (const item of items) {
      const amount = amountReason(line.amount, item.open, facts.tolerance)
      if (amount) candidates.push({ partyId, items: [item], paymentId: null, supplierInvoiceId: null, reasons: ordered([amount, ...(numberInText(item.number, text) ? (['NUMBER_IN_REFERENCE'] as const) : []), ...clues]) })
    }
    if (clues.length > 0 && items.length > 1) {
      // Everything the customer has open, paid at once.
      const set = items.slice(0, MAX_MATCH_ITEMS)
      const amount = amountReason(line.amount, set.reduce((sum, item) => sum + item.open, 0), facts.tolerance)
      if (amount) candidates.push({ partyId, items: set, paymentId: null, supplierInvoiceId: null, reasons: ordered([amount, ...clues]) })
    }
    if (clues.length > 0 && quoted.length === 0) {
      // We know who paid, not what: the oldest items the money covers (at least one).
      const set: OpenItem[] = []
      let left = line.amount
      for (const item of items) {
        if (set.length > 0 && item.open > left) break
        set.push(item)
        left -= item.open
        if (left <= 0 || set.length === MAX_MATCH_ITEMS) break
      }
      const amount = amountReason(line.amount, set.reduce((sum, item) => sum + item.open, 0), facts.tolerance)
      candidates.push({ partyId, items: set, paymentId: null, supplierInvoiceId: null, reasons: ordered([...(amount ? [amount] : []), ...clues]) })
    }
  }
  // A payment typed by hand that this line is (the database wants the same amount).
  const reference = normaliseBankReference(line.bankReference)
  for (const payment of facts.payments) {
    if (payment.currency !== line.currency || payment.amount !== line.amount) continue
    const quoted = (reference !== null && reference === normaliseBankReference(payment.externalRef)) || numberInText(payment.externalRef, text)
    const clues = partyClues(line, parties.get(payment.partyId))
    if (!quoted && clues.length === 0) continue
    candidates.push({ partyId: payment.partyId, items: [], paymentId: payment.id, supplierInvoiceId: null, reasons: ordered(['AMOUNT_EQUAL', ...(quoted ? (['NUMBER_IN_REFERENCE'] as const) : []), ...clues]) })
  }
  return candidates
}

/** Money out: the supplier invoices the line paid. */
function moneyOut(line: LineFacts, facts: MatchFacts): Candidate[] {
  const parties = new Map(facts.parties.map((party) => [party.id, party]))
  const text = [line.referenceText, line.bankReference].filter((value): value is string => value !== null).join(' ')
  const paid = -line.amount
  const candidates: Candidate[] = []
  for (const invoice of facts.supplierInvoices) {
    if (invoice.currency !== line.currency) continue
    const reasons: MatchReason[] = [...(invoice.due === paid ? (['AMOUNT_EQUAL'] as const) : []), ...(numberInText(invoice.number, text) ? (['NUMBER_IN_REFERENCE'] as const) : []), ...partyClues(line, parties.get(invoice.partyId))]
    // A supplier's invoice is suggested by its amount or its number; a name or an IBAN alone says only who.
    if (!reasons.includes('AMOUNT_EQUAL') && !reasons.includes('NUMBER_IN_REFERENCE')) continue
    candidates.push({ partyId: invoice.partyId, items: [], paymentId: null, supplierInvoiceId: invoice.id, reasons: ordered(reasons) })
  }
  return candidates
}

/**
 * The suggestions for one line, surest first (at most MAX_SUGGESTIONS). An amount alone (no number, IBAN or name) is
 * suggested only when at most MAX_SUGGESTIONS candidates share it: otherwise it says nothing.
 */
export function suggest(line: LineFacts, facts: MatchFacts): Suggestion[] {
  if (line.amount === 0) return []
  const found = line.amount > 0 ? moneyIn(line, facts) : moneyOut(line, facts)
  const unique = new Map<string, Candidate>()
  for (const candidate of found) {
    const key = keyOf(candidate)
    const kept = unique.get(key)
    if (!kept || pointsOf(candidate.reasons) > pointsOf(kept.reasons)) unique.set(key, candidate)
  }
  let candidates = [...unique.values()]
  const amountOnly = candidates.filter((candidate) => candidate.reasons.every((reason) => reason === 'AMOUNT_EQUAL' || reason === 'AMOUNT_WITHIN_TOLERANCE'))
  if (amountOnly.length > MAX_SUGGESTIONS) candidates = candidates.filter((candidate) => !amountOnly.includes(candidate))
  const ranked = candidates
    .map((candidate) => ({ candidate, points: pointsOf(candidate.reasons), confidence: confidenceOf(candidate.reasons) }))
    .sort((a, b) => b.points - a.points || a.candidate.items.length - b.candidate.items.length || keyOf(a.candidate).localeCompare(keyOf(b.candidate)))
    .slice(0, MAX_SUGGESTIONS)
  const top = ranked[0]?.points
  const tied = ranked.filter((entry) => entry.points === top).length > 1
  return ranked.map(({ candidate, points, confidence }) => ({
    partyId: candidate.partyId,
    invoiceIds: candidate.items.filter((item) => item.kind === 'INVOICE').map((item) => item.id),
    depositRequestIds: candidate.items.filter((item) => item.kind === 'DEPOSIT_REQUEST').map((item) => item.id),
    paymentId: candidate.paymentId,
    supplierInvoiceId: candidate.supplierInvoiceId,
    confidence: tied && points === top ? LOWER[confidence] : confidence,
    reasons: candidate.reasons,
    points,
  }))
}

/** The same suggestion (what it names, how sure, why): kept as it is when a refresh finds it again. */
export function sameSuggestion(a: Omit<Suggestion, 'points'>, b: Omit<Suggestion, 'points'>): boolean {
  const list = (values: readonly string[]) => [...values].sort().join(',')
  return (
    a.partyId === b.partyId &&
    list(a.invoiceIds) === list(b.invoiceIds) &&
    list(a.depositRequestIds) === list(b.depositRequestIds) &&
    a.paymentId === b.paymentId &&
    a.supplierInvoiceId === b.supplierInvoiceId &&
    a.confidence === b.confidence &&
    list(a.reasons) === list(b.reasons)
  )
}

/** The reasons of a person's own choice: what the matcher sees in it, and that a person chose it. */
export function chosenReasons(line: LineFacts, chosen: { readonly partyId: string; readonly open: MinorUnits; readonly numbers: readonly (string | null)[] }, party: PartyFacts | undefined, tolerance: MinorUnits | null): { reasons: MatchReason[]; confidence: MatchConfidence } {
  const text = [line.referenceText, line.bankReference].filter((value): value is string => value !== null).join(' ')
  const amount = amountReason(Math.abs(line.amount), chosen.open, line.amount > 0 ? tolerance : null)
  const reasons = ordered([...(amount ? [amount] : []), ...(chosen.numbers.some((number) => numberInText(number, text)) ? (['NUMBER_IN_REFERENCE'] as const) : []), ...partyClues(line, party), 'CHOSEN_BY_PERSON'])
  return { reasons, confidence: confidenceOf(reasons) }
}
