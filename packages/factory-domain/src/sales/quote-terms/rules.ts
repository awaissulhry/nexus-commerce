import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import { addDays, type QuoteVersionStatus } from '../quotes/quotes'
import { quoteDocumentNumber } from '../quotes/document'

/**
 * A quote's delivery terms, its delivery schedule per line and its validity (B-W2b-294; SAL-145, SAL-151, SAL-162; design
 * sales.quotes quote.terms.delivery "Incoterm and place · Ship complete / ship as ready · Delivery schedule per line",
 * quote.terms.validity "Acceptance mode: sign · sign and pay deposit"), pure. apps/factory-api's modules/sales/quote-terms
 * writes them on the DRAFT version, copies them to a new version and to the order, and runs the validity job; the database
 * (…_sales_pricing_w2b_guards) checks the same shapes last.
 */

// ---- Incoterms 2020 and delivery terms ----------------------------------------------------------------------------------

/** The Incoterms 2020 rules (ICC): seven for any mode of transport, four for sea and inland waterway only. */
export const INCOTERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'] as const
export type Incoterm = (typeof INCOTERMS)[number]

export const INCOTERM_WORDS: Readonly<Record<Incoterm, { readonly en: string; readonly it: string; readonly seaOnly: boolean }>> = Object.freeze({
  EXW: { en: 'Ex Works', it: 'Franco fabbrica', seaOnly: false },
  FCA: { en: 'Free Carrier', it: 'Franco vettore', seaOnly: false },
  CPT: { en: 'Carriage Paid To', it: 'Trasporto pagato fino a', seaOnly: false },
  CIP: { en: 'Carriage and Insurance Paid To', it: 'Trasporto e assicurazione pagati fino a', seaOnly: false },
  DAP: { en: 'Delivered at Place', it: 'Reso al luogo di destinazione', seaOnly: false },
  DPU: { en: 'Delivered at Place Unloaded', it: 'Reso al luogo di destinazione scaricato', seaOnly: false },
  DDP: { en: 'Delivered Duty Paid', it: 'Reso sdoganato', seaOnly: false },
  FAS: { en: 'Free Alongside Ship', it: 'Franco lungo bordo', seaOnly: true },
  FOB: { en: 'Free On Board', it: 'Franco a bordo', seaOnly: true },
  CFR: { en: 'Cost and Freight', it: 'Costo e nolo', seaOnly: true },
  CIF: { en: 'Cost, Insurance and Freight', it: 'Costo, assicurazione e nolo', seaOnly: true },
})

export const isIncoterm = (value: string): value is Incoterm => (INCOTERMS as readonly string[]).includes(value)

/** The named place of an Incoterm: one line, 1 to 120 characters (the database's limit). */
export const PLACE_MAX = 120

/**
 * How the customer accepts a quote (design quote.terms.validity "sign · sign and pay deposit"): SIGN (W1's typed name) or
 * SIGN_AND_PAY (the name and the deposit, which the version must ask). The database also knows PAY (the payment alone is the
 * acceptance): it needs an online payment the accept page does not take, so it is refused in words here.
 */
export const ACCEPTANCE_MODES = ['SIGN', 'SIGN_AND_PAY'] as const
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number]
export const STORED_ACCEPTANCE_MODES = ['SIGN', 'PAY', 'SIGN_AND_PAY'] as const
export type StoredAcceptanceMode = (typeof STORED_ACCEPTANCE_MODES)[number]

const ONE_LINE = /^[^\x00-\x1f\x7f]+$/

export interface DeliveryTerms {
  readonly incoterm: string | null
  readonly incotermPlace: string | null
  readonly shipComplete: boolean
  readonly acceptanceMode: StoredAcceptanceMode
  /** The deposit the version asks (percent), or null. */
  readonly depositPct: string | null
}

/** What is wrong with a version's (or a template's) delivery terms, in words; `at` prefixes each path ("body"). */
export function deliveryTermsProblems(terms: DeliveryTerms, at = 'body'): Issue[] {
  const issues: Issue[] = []
  const place = terms.incotermPlace?.trim() ?? ''
  if (terms.incoterm !== null && !isIncoterm(terms.incoterm)) issues.push({ path: `${at}/incoterm`, message: `${terms.incoterm} is not an Incoterms 2020 rule: one of ${INCOTERMS.join(', ')}.` })
  if (terms.incoterm !== null && place === '') issues.push({ path: `${at}/incotermPlace`, message: `${terms.incoterm} names its place ("${terms.incoterm} Milano"): type the place.` })
  if (terms.incoterm === null && place !== '') issues.push({ path: `${at}/incoterm`, message: 'A place without an Incoterm: choose the rule it belongs to, or clear the place.' })
  if (place !== '' && (place.length > PLACE_MAX || !ONE_LINE.test(place))) issues.push({ path: `${at}/incotermPlace`, message: `The place is one line of at most ${PLACE_MAX} characters.` })
  if (terms.acceptanceMode === 'PAY') issues.push({ path: `${at}/acceptanceMode`, message: 'Accepting by paying alone needs an online payment the accept page does not take yet: choose sign, or sign and pay the deposit.' })
  if (terms.acceptanceMode !== 'SIGN' && terms.depositPct === null) issues.push({ path: `${at}/acceptanceMode`, message: 'Sign and pay the deposit: the quote must ask a deposit first.' })
  return issues
}

/** "EXW Seedville (Ex Works)" in the document's language; null without an Incoterm. */
export function incotermWords(incoterm: string | null, place: string | null, language: 'it' | 'en'): string | null {
  if (incoterm === null) return null
  const words = isIncoterm(incoterm) ? INCOTERM_WORDS[incoterm][language] : null
  return `${incoterm}${place ? ` ${place}` : ''}${words ? ` (${words})` : ''}`
}

export const SHIP_WORDS = Object.freeze({
  en: { complete: 'Ship complete: everything leaves together.', asReady: 'Ship as ready: each delivery leaves when it is ready.' },
  it: { complete: 'Spedizione completa: tutto parte insieme.', asReady: 'Spedizione al pronto: ogni consegna parte quando è pronta.' },
})

// ---- a delivery schedule per line ---------------------------------------------------------------------------------------

/** At most this many deliveries on one line. */
export const MAX_DELIVERIES = 24
export const DELIVERY_NOTE_MAX = 500

export interface ScheduleLine {
  readonly seq: number
  readonly kind: string
  /** Pieces per size of the line (QuoteLineSize / SalesOrderLineSize). */
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
}

export interface DeliveryInput {
  readonly deliveryDate: string
  /** SIZE_GRID: pieces per size of the line; MADE_TO_MEASURE: none. */
  readonly sizes?: Readonly<Record<string, number>> | null | undefined
  readonly note?: string | null | undefined
}

/** A delivery as stored (QuoteLineDelivery / SalesOrderLineDelivery). */
export interface Delivery {
  readonly deliveryDate: BusinessDate
  readonly sizeQuantities: Readonly<Record<string, number>> | null
  readonly quantity: number
  readonly note: string | null
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/**
 * A line's whole schedule as asked (the screen sends every delivery; none: no schedule, every piece at the promise date),
 * checked in words, and as it is stored: dates from today, each once, in order; on a size grid line each delivery brings
 * pieces of the line's sizes and, per size, the deliveries never more than the line has (the rest goes at the promise date);
 * a made-to-measure unit has one delivery of its one unit; a fee line none.
 */
export function planSchedule(line: ScheduleLine, input: readonly DeliveryInput[], today: BusinessDate, at = 'body/deliveries'): { readonly deliveries: Delivery[]; readonly issues: Issue[] } {
  const issues: Issue[] = []
  if (line.kind === 'FEE') return { deliveries: [], issues: input.length === 0 ? [] : [{ path: at, message: `Line ${line.seq} is a fee: it has no delivery schedule.` }] }
  if (input.length > MAX_DELIVERIES) issues.push({ path: at, message: `A line has at most ${MAX_DELIVERIES} deliveries.` })
  if (line.kind === 'MADE_TO_MEASURE' && input.length > 1) issues.push({ path: at, message: `Line ${line.seq} is a made-to-measure unit: it has one delivery.` })
  const have = new Map(line.sizes.map((row) => [row.size, row.quantity]))
  const planned = new Map<string, number>()
  const seen = new Set<string>()
  const deliveries: Delivery[] = []
  input.forEach((entry, index) => {
    const path = `${at}/${index}`
    const day = entry.deliveryDate
    if (!isBusinessDate(day)) issues.push({ path: `${path}/deliveryDate`, message: 'A delivery day written YYYY-MM-DD.' })
    else if (day < today) issues.push({ path: `${path}/deliveryDate`, message: `${day} has passed: a delivery is planned from today on.` })
    else if (seen.has(day)) issues.push({ path: `${path}/deliveryDate`, message: `${day} is named twice: one delivery per day, with every size it brings.` })
    seen.add(day)
    const note = blank(entry.note)
    if (note !== null && note.length > DELIVERY_NOTE_MAX) issues.push({ path: `${path}/note`, message: `A note of at most ${DELIVERY_NOTE_MAX} characters.` })
    if (line.kind === 'MADE_TO_MEASURE') {
      if (entry.sizes && Object.keys(entry.sizes).length > 0) issues.push({ path: `${path}/sizes`, message: 'A made-to-measure unit has no sizes: its delivery brings the one unit.' })
      deliveries.push({ deliveryDate: day, sizeQuantities: null, quantity: 1, note })
      return
    }
    const sizes = Object.entries(entry.sizes ?? {}).filter(([, pieces]) => pieces !== 0)
    if (sizes.length === 0) issues.push({ path: `${path}/sizes`, message: `The delivery of ${day} brings no pieces: give the pieces of each size it brings.` })
    for (const [size, pieces] of sizes) {
      if (!Number.isInteger(pieces) || pieces < 1) issues.push({ path: `${path}/sizes/${size}`, message: `Size ${size}: whole pieces from 1.` })
      else if (!have.has(size)) issues.push({ path: `${path}/sizes/${size}`, message: `Line ${line.seq} has no size ${size}.` })
      else planned.set(size, (planned.get(size) ?? 0) + pieces)
    }
    const sizeQuantities = Object.fromEntries(sizes.filter(([, pieces]) => Number.isInteger(pieces) && pieces >= 1))
    deliveries.push({ deliveryDate: day, sizeQuantities, quantity: Object.values(sizeQuantities).reduce((sum, pieces) => sum + pieces, 0), note })
  })
  for (const [size, pieces] of planned) {
    const most = have.get(size) ?? 0
    if (pieces > most) issues.push({ path: `${at}`, message: `Size ${size}: the deliveries bring ${pieces} pieces, the line has ${most}.` })
  }
  return { deliveries: [...deliveries].sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : a.deliveryDate > b.deliveryDate ? 1 : 0)), issues }
}

/** What the schedule leaves for the promise date, per size (a size grid line); empty: everything is scheduled. */
export function remainderOf(line: ScheduleLine, deliveries: readonly Pick<Delivery, 'sizeQuantities'>[]): Record<string, number> {
  const left: Record<string, number> = {}
  for (const row of line.sizes) {
    const planned = deliveries.reduce((sum, delivery) => sum + (delivery.sizeQuantities?.[row.size] ?? 0), 0)
    if (row.quantity - planned > 0) left[row.size] = row.quantity - planned
  }
  return left
}

/**
 * A line's sizes are about to change (W1's PATCH line): the schedule it has must still fit (a size it brings still there,
 * never more of a size than the line will have). Null: it fits; else the words that refuse the change.
 */
export function scheduleFitProblem(line: Pick<ScheduleLine, 'seq'>, nextSizes: readonly { readonly size: string; readonly quantity: number }[], deliveries: readonly Pick<Delivery, 'deliveryDate' | 'sizeQuantities'>[]): string | null {
  if (deliveries.length === 0) return null
  const next = new Map(nextSizes.map((row) => [row.size, row.quantity]))
  const planned = new Map<string, number>()
  for (const delivery of deliveries) for (const [size, pieces] of Object.entries(delivery.sizeQuantities ?? {})) planned.set(size, (planned.get(size) ?? 0) + pieces)
  for (const [size, pieces] of planned) {
    const most = next.get(size) ?? 0
    if (pieces > most) return `Line ${line.seq}: its delivery schedule brings ${pieces} pieces of size ${size}, the line would have ${most}. Change the schedule first (Terms & delivery), then the sizes.`
  }
  return null
}

/** The deliveries a copy carries (a new version, the order): those still ahead; the ones that passed are left out. */
export const carriedDeliveries = <D extends Pick<Delivery, 'deliveryDate'>>(deliveries: readonly D[], today: BusinessDate): { readonly kept: D[]; readonly passed: D[] } => ({
  kept: deliveries.filter((delivery) => delivery.deliveryDate >= today),
  passed: deliveries.filter((delivery) => delivery.deliveryDate < today),
})

// ---- validity: the reminder before the end, EXPIRED after -------------------------------------------------------------

/** The reminder goes this many days before the last day (SAL-145), once per version. */
export const REMINDER_DAYS_BEFORE = 3
/** …and only to a version sent at least this many days before: a short offer just received is not reminded. */
export const REMINDER_MIN_DAYS_SENT = 2

const dayNumber = (day: BusinessDate): number => Math.round(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000)
export const daysFrom = (from: BusinessDate, to: BusinessDate): number => dayNumber(to) - dayNumber(from)

export const VALIDITY_STATES = ['NOT_SENT', 'OPEN', 'ENDS_SOON', 'LAST_DAY', 'ENDED', 'EXPIRED', 'CLOSED'] as const
export type ValidityState = (typeof VALIDITY_STATES)[number]

export interface ValidityFacts {
  readonly status: QuoteVersionStatus
  readonly validUntil: BusinessDate | null
  /** The day it was sent (null: not sent). */
  readonly sentOn: BusinessDate | null
  readonly reminderSentAt: Date | null
  /** It is the quote's current version (a newer DRAFT means it is being revised: no reminder). */
  readonly current: boolean
}

export interface Validity {
  readonly state: ValidityState
  /** Days to its last day (0: today is the last day; negative: ended); null without a validity. */
  readonly daysLeft: number | null
  /** The day its reminder is due (null: none will go: not sent, reminded, too short, revised, closed). */
  readonly reminderOn: BusinessDate | null
  /** The reminder is due now (the job sends it on its next run). */
  readonly reminderDue: boolean
  /** It is SENT past its last day: the job marks it EXPIRED on its next run. */
  readonly expiryDue: boolean
}

/** Where a version's offer stands today, and what the validity job will do with it. */
export function validityOf(facts: ValidityFacts, today: BusinessDate): Validity {
  const daysLeft = facts.validUntil === null ? null : daysFrom(today, facts.validUntil)
  if (facts.status === 'EXPIRED') return { state: 'EXPIRED', daysLeft, reminderOn: null, reminderDue: false, expiryDue: false }
  if (facts.status !== 'SENT') {
    const open = facts.status === 'DRAFT' || facts.status === 'PENDING_APPROVAL' || facts.status === 'APPROVED'
    return { state: open ? 'NOT_SENT' : 'CLOSED', daysLeft: open ? daysLeft : null, reminderOn: null, reminderDue: false, expiryDue: false }
  }
  if (facts.validUntil === null || daysLeft === null) return { state: 'OPEN', daysLeft: null, reminderOn: null, reminderDue: false, expiryDue: false }
  if (daysLeft < 0) return { state: 'ENDED', daysLeft, reminderOn: null, reminderDue: false, expiryDue: true }
  const reminderDay = addDays(facts.validUntil, -REMINDER_DAYS_BEFORE)
  const firstDay = facts.sentOn === null ? reminderDay : addDays(facts.sentOn, REMINDER_MIN_DAYS_SENT)
  const reminderOn = facts.reminderSentAt === null && facts.current ? (reminderDay > firstDay ? reminderDay : firstDay) : null
  const reminds = reminderOn !== null && reminderOn <= facts.validUntil
  return {
    state: daysLeft === 0 ? 'LAST_DAY' : daysLeft <= REMINDER_DAYS_BEFORE ? 'ENDS_SOON' : 'OPEN',
    daysLeft,
    reminderOn: reminds ? reminderOn : null,
    reminderDue: reminds && reminderOn! <= today,
    expiryDue: false,
  }
}

const REMINDER_WORDS = {
  it: {
    subject: (number: string) => `Promemoria: il preventivo ${number} scade presto`,
    hello: 'Buongiorno,',
    body: (number: string, until: string, sent: string) => `le ricordiamo che il nostro preventivo ${number}, inviato il ${sent}, è valido fino al ${until} compreso.`,
    // B-W2b-385 (NT1:05): the reminder carries its own accept link (a new one, to the same address, until the same day).
    linkStored: (until: string) => `Per accettarlo o rifiutarlo usi il link personale di questa email (valido fino al ${until}).`,
    link: (until: string) => `Per accettarlo o rifiutarlo apra questo link personale (valido fino al ${until}); le chiederemo di scrivere nome e cognome:`,
    firm: 'Fino a quel giorno l’offerta è irrevocabile (art. 1329 c.c.).',
    close: 'Restiamo a disposizione per qualsiasi domanda.',
  },
  en: {
    subject: (number: string) => `Reminder: quote ${number} ends soon`,
    hello: 'Hello,',
    body: (number: string, until: string, sent: string) => `a reminder that our quote ${number}, sent on ${sent}, stands until ${until} included.`,
    linkStored: (until: string) => `To accept or decline it, use the personal link in this e-mail (valid until ${until}).`,
    link: (until: string) => `To accept or decline it, open this personal link (valid until ${until}); we will ask you to type your full name:`,
    firm: 'Until that day it is a firm offer (Italian Civil Code art. 1329).',
    close: 'We are glad to answer any question.',
  },
} as const

export interface ReminderMail {
  readonly subject: string
  /** What the thread keeps: the reminder WITHOUT its link (a bearer token is never stored). No amount. */
  readonly stored: string
  /** The reminder with its accept link, made in memory just before it is sent (B-W2b-385, NT1:05). */
  withLink(url: string): string
}

/** The reminder to the customer (on the quote's thread, the record's mail): the thread keeps it without the link; no amount. */
export function reminderMail(input: { readonly language: 'it' | 'en'; readonly number: string; readonly revision: number; readonly validUntil: BusinessDate; readonly sentOn: BusinessDate; readonly firmOffer: boolean; /** The new link's last day. */ readonly linkUntil: BusinessDate }): ReminderMail {
  const words = REMINDER_WORDS[input.language]
  const number = quoteDocumentNumber(input.number, input.revision)
  const linkUntil = formatDate(input.linkUntil, input.language)
  const opening = [words.hello, words.body(number, formatDate(input.validUntil, input.language), formatDate(input.sentOn, input.language))].join('\n\n')
  const closing = [...(input.firmOffer ? [words.firm] : []), words.close].join('\n\n')
  return {
    subject: words.subject(number),
    stored: [opening, words.linkStored(linkUntil), closing].join('\n\n'),
    withLink: (url) => [opening, `${words.link(linkUntil)}\n${url}`, closing].join('\n\n'),
  }
}
