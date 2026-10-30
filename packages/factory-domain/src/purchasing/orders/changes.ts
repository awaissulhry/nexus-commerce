import { Decimal } from 'decimal.js'
import type { DocumentLanguage } from '../../documents/model'
import { lineDifference } from '../../inventory/receipts/rules'
import { STATUS_WORDS, type PurchaseOrderStatus } from '../orders'

/**
 * A purchase order's changes after it was sent, line by line (B-W2a-52; SCM-059 "Cancel PO or line", SCM-060 "Close
 * short"; design purchasing.orders pop "Cancel PO-0093?" with its reach, record › Receipts "Close short a line: the rest
 * will not come; planning releases it"), pure. The …_supply_w2a_guards triggers hold the same rules for every login.
 *
 *   cancel the order   a draft, a sent order (waiting, declined) or a confirmed one: the supplier is told when it holds
 *                      the order (it was sent: SENT, DECLINED, CONFIRMED, or a draft of revision 2 and later). W1 refused
 *                      a confirmed order; with revisions a confirmed order may be cancelled too (it ends a contract: the
 *                      reach says so). With the supplier's changes waiting, the buyer decides first; goods received: the
 *                      order is closed, never cancelled (close the rest short).
 *   cancel a line      nothing more of it is wanted: on a sent order (waiting, confirmed, declined) or a partly received
 *                      one, never a line with goods received (close it short) or with goods at the dock (an open
 *                      receipt), never the last open line of an order nothing came for (cancel the order). On a draft only
 *                      a line an earlier revision sent (a new line is removed instead). The supplier is told when it holds
 *                      the order (not for a draft: the next revision's mail says it).
 *   close short        a line that came in part, on a partly received order: the rest will not come.
 *   after              both end the line for good (it takes no goods and changes no more); the order is RECEIVED once every
 *                      line left is received in full (inventory/receipts orderStatusAfter counts an ended line complete).
 */

/** What the reach read answers for (the dialogs: cancel the order, cancel lines, close lines short). */
export const REACH_ACTIONS = ['CANCEL_ORDER', 'CANCEL_LINES', 'CLOSE_SHORT'] as const
export type ReachAction = (typeof REACH_ACTIONS)[number]

/** Whether the office may cancel the whole order now (W2a); null when it may, else why not. */
export function cancelOrderProblem(status: PurchaseOrderStatus): string | null {
  switch (status) {
    case 'DRAFT':
    case 'SENT':
    case 'DECLINED':
    case 'CONFIRMED':
      return null
    case 'CHANGES_PROPOSED':
      return "The supplier proposed changes to this order: accept or refuse the supplier's changes first (refused, the order can be cancelled)."
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return 'Goods were received against this order: it is closed, never cancelled. Close the rest short instead.'
    case 'CLOSED':
    case 'CANCELLED':
      return `The order is ${STATUS_WORDS[status]} already.`
  }
}

/** The supplier holds the order: it was sent (and a draft of revision 2 or later replaces one it holds). */
export function supplierHolds(status: PurchaseOrderStatus, revision: number): boolean {
  return status !== 'DRAFT' ? status !== 'CANCELLED' && status !== 'CLOSED' : revision > 1
}

/** A change of this state is mailed to the supplier now (a draft's change goes with its next revision's mail). */
export const mailsSupplier = (status: PurchaseOrderStatus): boolean => status === 'SENT' || status === 'DECLINED' || status === 'CONFIRMED' || status === 'PARTLY_RECEIVED'

/** One line as the rules of a line's end read it. Quantities in the material's base unit. */
export interface EndLineFacts {
  readonly id: string
  readonly seq: number
  readonly label: string
  readonly cancelled: boolean
  readonly closedShort: boolean
  /** What the order expects of it: the confirmed quantity when the supplier confirmed one, else the ordered one. */
  readonly expectedBase: string
  readonly receivedBase: string
  readonly tolerancePct: string | null
  /** An OPEN receipt (goods at the dock) names it. */
  readonly atDock: boolean
  /** An earlier revision sent it (a draft's own new line is removed, not cancelled). */
  readonly sentBefore: boolean
}

const ZERO = new Decimal(0)
const received = (line: Pick<EndLineFacts, 'receivedBase'>) => new Decimal(line.receivedBase)
const ended = (line: Pick<EndLineFacts, 'cancelled' | 'closedShort'>) => line.cancelled || line.closedShort

/** The line is received in full (within its area tolerance below the expected quantity): the receipts' own rule. */
export function receivedInFull(line: Pick<EndLineFacts, 'expectedBase' | 'receivedBase' | 'tolerancePct'>): boolean {
  return lineDifference({ expected: line.expectedBase, receivedBefore: line.receivedBase, receiving: '0', tolerancePct: line.tolerancePct }).complete
}

/**
 * Why these lines of an order in this state cannot be cancelled (one sentence per refusal, the line's label first), or
 * an empty list. `others` are the order's other lines.
 */
export function cancelLinesProblems(order: { readonly status: PurchaseOrderStatus; readonly revision: number }, lines: readonly EndLineFacts[], others: readonly EndLineFacts[]): string[] {
  const problems: string[] = []
  switch (order.status) {
    case 'DRAFT':
      if (order.revision <= 1) return ['The order was never sent: remove the line instead.']
      break
    case 'SENT':
    case 'DECLINED':
    case 'CONFIRMED':
    case 'PARTLY_RECEIVED':
      break
    case 'CHANGES_PROPOSED':
      return ["The supplier proposed changes to this order: accept or refuse the supplier's changes first."]
    case 'RECEIVED':
      return ['Everything of this order was received: nothing is left to cancel.']
    case 'CLOSED':
    case 'CANCELLED':
      return [`The order is ${STATUS_WORDS[order.status]} already.`]
  }
  for (const line of lines) {
    if (ended(line)) problems.push(`${line.label}: it is ${line.cancelled ? 'cancelled' : 'closed short'} already.`)
    else if (order.status === 'DRAFT' && !line.sentBefore) problems.push(`${line.label}: it is new in this draft: remove it instead.`)
    else if (received(line).gt(0)) problems.push(`${line.label}: goods came for it: close it short instead.`)
    else if (line.atDock) problems.push(`${line.label}: goods for it are at the dock (an open receipt): post or reverse the receipt first.`)
  }
  if (problems.length > 0) return problems
  const anythingCame = [...lines, ...others].some((line) => received(line).gt(0))
  const left = others.filter((line) => !ended(line))
  if (left.length === 0 && !anythingCame) return ['These are the last open lines of the order: cancel the order instead.']
  return []
}

/** Why these lines cannot be closed short, or an empty list. */
export function closeShortProblems(order: { readonly status: PurchaseOrderStatus }, lines: readonly EndLineFacts[]): string[] {
  if (order.status !== 'PARTLY_RECEIVED') {
    if (order.status === 'RECEIVED') return ['Everything of this order was received: nothing is left to close short.']
    if (order.status === 'CLOSED' || order.status === 'CANCELLED') return [`The order is ${STATUS_WORDS[order.status]} already.`]
    return ['Nothing was received against this order yet: cancel the line instead (a line is closed short once part of it came).']
  }
  const problems: string[] = []
  for (const line of lines) {
    if (ended(line)) problems.push(`${line.label}: it is ${line.cancelled ? 'cancelled' : 'closed short'} already.`)
    else if (!received(line).gt(0)) problems.push(`${line.label}: nothing came for it yet: cancel it instead.`)
    else if (receivedInFull(line)) problems.push(`${line.label}: it was received in full: nothing is left to close.`)
    else if (line.atDock) problems.push(`${line.label}: goods for it are at the dock (an open receipt): post or reverse the receipt first.`)
  }
  return problems
}

/** What is still expected of a line, in its base unit (never below 0; an ended line: nothing). */
export function outstandingBase(line: Pick<EndLineFacts, 'expectedBase' | 'receivedBase' | 'cancelled' | 'closedShort'>): string {
  if (ended(line)) return '0.0000'
  const rest = new Decimal(line.expectedBase).minus(received(line))
  return (rest.gt(0) ? rest : ZERO).toFixed(4)
}

// ---- the supplier's mail ----------------------------------------------------------------------------------------------------

const MAIL = {
  it: {
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Buongiorno,'),
    cancelSubject: (number: string) => `Ordine di acquisto ${number}: righe annullate`,
    cancelled: (number: string) => `queste righe del nostro ordine di acquisto ${number} sono annullate: la preghiamo di non evaderle.`,
    shortSubject: (number: string) => `Ordine di acquisto ${number}: righe chiuse`,
    closedShort: (number: string) => `queste righe del nostro ordine di acquisto ${number} sono chiuse con quanto già ricevuto: la preghiamo di non inviare il resto.`,
    rest: 'Il resto dell’ordine non cambia.',
  },
  en: {
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Hello,'),
    cancelSubject: (number: string) => `Purchase order ${number}: lines cancelled`,
    cancelled: (number: string) => `these lines of our purchase order ${number} are cancelled: please do not deliver them.`,
    shortSubject: (number: string) => `Purchase order ${number}: lines closed`,
    closedShort: (number: string) => `these lines of our purchase order ${number} are closed with what we received already: please do not send the rest.`,
    rest: 'The rest of the order does not change.',
  },
} as const

/** The supplier is told which lines are cancelled or closed short (the office's own words last, when it wrote some). */
export function lineEndMail(input: { readonly kind: 'CANCELLED' | 'CLOSED_SHORT'; readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly lines: readonly string[]; readonly message: string | null }): { readonly subject: string; readonly body: string } {
  const words = MAIL[input.language]
  const cancelled = input.kind === 'CANCELLED'
  const body = [
    words.hello(input.recipientName),
    `${cancelled ? words.cancelled(input.number) : words.closedShort(input.number)}\n${input.lines.map((line) => `- ${line}`).join('\n')}`,
    words.rest,
    ...(input.message?.trim() ? [input.message.trim()] : []),
  ].join('\n\n')
  return { subject: cancelled ? words.cancelSubject(input.number) : words.shortSubject(input.number), body }
}
