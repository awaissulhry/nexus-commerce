import { Decimal } from 'decimal.js'
import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { daysLater } from '../po-depth/dates'
import { dayDistance } from '../orders/delivery'

/**
 * The expediting worklist (B-W2b-305; SCM-068 "Expediting worklist is daily running"; SCM-064 the demand each line serves;
 * design purchasing.orders "What it blocks (W2b)", "Chase (W2b)", purchasing.reports "Late lines and what they block":
 * "Late lines are ranked by the customer orders they put at risk, not by days late alone"). An open line of a sent order
 * (waiting, confirmed, with changes proposed, partly received; not cancelled, closed short or received) is on the list for
 * one or more reasons:
 *
 *   LATE             it is expected before today (its next delivery not yet received: the supplier's day, else the day asked)
 *   NOT_CONFIRMED    the order still waits for the supplier's answer after its confirm-by time
 *   CONFIRMED_LATE   the supplier confirmed it (or one of its deliveries) later than it was asked for
 *
 * What it blocks: the demand the site's latest plan pegs on it (work orders, customer order lines), each late by the days
 * the line is expected after the day that demand needs it. The rank: customer orders put at risk first (how many, then
 * the earliest promise among them), then work orders put at risk, then days late, then the day expected. No money.
 */

export const EXPEDITE_REASONS = ['LATE', 'NOT_CONFIRMED', 'CONFIRMED_LATE'] as const
export type ExpediteReason = (typeof EXPEDITE_REASONS)[number]

/** The order states that wait for the supplier's answer (B-W2a-52: a reminder goes to them). */
const ANSWER_PENDING = ['SENT', 'CHANGES_PROPOSED']

export interface LineDeliveryFacts {
  readonly seq: number
  readonly baseQuantity: string
  readonly needDate: BusinessDate
  readonly confirmedDate: BusinessDate | null
}

/**
 * The delivery a scheduled line waits for next: the first one what came so far does not cover (in order, by base
 * quantity). Null when it has no schedule, or all its deliveries came.
 */
export function nextDeliveryOf(deliveries: readonly LineDeliveryFacts[], receivedBase: string): LineDeliveryFacts | null {
  let covered = new Decimal(receivedBase)
  for (const delivery of [...deliveries].sort((a, b) => a.seq - b.seq)) {
    const need = new Decimal(delivery.baseQuantity)
    if (covered.lt(need)) return delivery
    covered = covered.minus(need)
  }
  return null
}

/** The day an open line is expected: its next delivery's (the supplier's day, else the day asked), else the line's. */
export function expectedDayOf(line: { readonly needDate: BusinessDate; readonly confirmedDate: BusinessDate | null }, next: LineDeliveryFacts | null): BusinessDate {
  if (next) return next.confirmedDate ?? next.needDate
  return line.confirmedDate ?? line.needDate
}

export interface ReasonFacts {
  readonly orderStatus: string
  readonly needDate: BusinessDate
  readonly confirmedDate: BusinessDate | null
  readonly expectedDate: BusinessDate
  readonly deliveries: readonly LineDeliveryFacts[]
  readonly confirmBy: Date | null
  readonly today: BusinessDate
  readonly now: Date
}

/** The most days a line (or one of its deliveries) was confirmed later than asked (0: none later). */
export function confirmedLaterByOf(facts: Pick<ReasonFacts, 'needDate' | 'confirmedDate' | 'deliveries'>): number {
  const days = [daysLater(facts.needDate, facts.confirmedDate), ...facts.deliveries.map((delivery) => daysLater(delivery.needDate, delivery.confirmedDate))]
  return Math.max(0, ...days)
}

/** Why an open line is on the worklist (none: it is not). */
export function expediteReasonsOf(facts: ReasonFacts): ExpediteReason[] {
  const reasons: ExpediteReason[] = []
  if (facts.expectedDate < facts.today) reasons.push('LATE')
  if (ANSWER_PENDING.includes(facts.orderStatus) && facts.confirmBy !== null && facts.confirmBy.getTime() <= facts.now.getTime()) reasons.push('NOT_CONFIRMED')
  if (confirmedLaterByOf(facts) > 0) reasons.push('CONFIRMED_LATE')
  return reasons
}

/** Days a demand is put late by the line: the line expected after the day the demand needs it (0: in time). */
export const lateByOf = (expectedDate: BusinessDate, demandDate: BusinessDate): number => Math.max(0, dayDistance(demandDate, expectedDate))

export interface RankFacts {
  /** Customer orders put at risk (a pegged order line late by the line). */
  readonly salesOrdersAtRisk: number
  /** The earliest promise (or need) day among them; null: none at risk. */
  readonly earliestPromise: BusinessDate | null
  readonly workOrdersAtRisk: number
  readonly daysLate: number
  readonly expectedDate: BusinessDate
  readonly number: string
  readonly seq: number
}

/** The worklist's order (see the module comment): the line that puts the most customer orders at risk first. */
export function expediteOrder(a: RankFacts, b: RankFacts): number {
  return (
    b.salesOrdersAtRisk - a.salesOrdersAtRisk ||
    (a.earliestPromise ?? '9999-12-31').localeCompare(b.earliestPromise ?? '9999-12-31') ||
    b.workOrdersAtRisk - a.workOrdersAtRisk ||
    b.daysLate - a.daysLate ||
    a.expectedDate.localeCompare(b.expectedDate) ||
    a.number.localeCompare(b.number) ||
    a.seq - b.seq
  )
}

// ---- the chase (design purchasing.orders pop "Chase Conceria Alfa": lines late or unconfirmed, the mail in their language) --

export const MAX_CHASE_MESSAGE = 4000

export interface ChaseLine {
  /** "Line 10 · ART-100 Leather black". */
  readonly label: string
  readonly needDate: BusinessDate
  readonly confirmedDate: BusinessDate | null
  readonly reasons: readonly ExpediteReason[]
}

const CHASE = {
  it: {
    subject: (number: string) => `Sollecito: ordine di acquisto ${number}`,
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    intro: (number: string) => `le scriviamo per le righe del nostro ordine di acquisto ${number} qui sotto:`,
    late: (day: string) => `in ritardo: attesa per il ${day}`,
    unconfirmed: 'non ancora confermata',
    later: (asked: string, confirmed: string) => `confermata per il ${confirmed}, richiesta per il ${asked}`,
    ask: "Ci può dire quando arriveranno? Se le date confermate non sono più valide, risponda a questa e-mail con le nuove date. Per l'ordine non ancora confermato, usi il link personale dell'e-mail con cui le abbiamo inviato l'ordine.",
    asked: (day: string) => `richiesta per il ${day}`,
  },
  en: {
    subject: (number: string) => `Chasing purchase order ${number}`,
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    intro: (number: string) => `we are writing about the lines of our purchase order ${number} below:`,
    late: (day: string) => `late: expected on ${day}`,
    unconfirmed: 'not confirmed yet',
    later: (asked: string, confirmed: string) => `confirmed for ${confirmed}, asked for ${asked}`,
    ask: 'Could you tell us when they will arrive? If the confirmed dates no longer hold, reply to this e-mail with the new ones. For an order not confirmed yet, use the personal link in the e-mail that brought you the order.',
    asked: (day: string) => `asked for ${day}`,
  },
} as const

/** One line of the chase in words: why it is chased, with its days. */
function chaseLineWords(line: ChaseLine, language: DocumentLanguage): string {
  const words = CHASE[language]
  const day = (date: BusinessDate) => formatDate(date, language)
  const parts: string[] = []
  if (line.reasons.includes('LATE')) parts.push(words.late(day(line.confirmedDate ?? line.needDate)))
  if (line.reasons.includes('CONFIRMED_LATE') && line.confirmedDate) parts.push(words.later(day(line.needDate), day(line.confirmedDate)))
  if (line.reasons.includes('NOT_CONFIRMED')) parts.push(words.unconfirmed)
  if (parts.length === 0) parts.push(words.asked(day(line.needDate)))
  return `- ${line.label}: ${parts.join('; ')}`
}

/** The chase mail (no link: a link is a bearer token kept nowhere; no price). */
export function chaseMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly lines: readonly ChaseLine[]; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  const words = CHASE[input.language]
  const body = [words.hello(input.recipientName), words.intro(input.number), input.lines.map((line) => chaseLineWords(line, input.language)).join('\n'), ...(input.message?.trim() ? [input.message.trim()] : []), words.ask].join('\n\n')
  return { subject: words.subject(input.number), body }
}

/** A chase goes to an order whose goods are still expected, for its lines on the worklist. */
export function chaseProblem(status: string, chasedLines: number): string | null {
  if (!['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'].includes(status)) return 'The order does not wait for goods from its supplier: there is nothing to chase.'
  if (chasedLines === 0) return 'No line of this order is late, unconfirmed or confirmed later than needed: there is nothing to chase.'
  return null
}
