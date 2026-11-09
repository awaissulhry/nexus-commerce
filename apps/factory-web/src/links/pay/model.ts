import type { PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { fakeScenariosFor, failureKeyOf, paymentStateOf, providerRuns, unavailableKeyOf, type FakeScenario, type PayPhase, type PaymentIntent, type PaymentMethod } from '../../lib/payments/online'
import type { DepositFacts, PayPage } from './api'

/**
 * SCR-199 — Pay online (design links.pay; B-W2b-199): what the page shows, from the container (Pay.tsx). The link's own
 * states first (it did not open: used, expired, withdrawn — one answer from the API), then the record's (to pay, paid,
 * closed), then the card step's. The view fetches nothing. No cost or margin: the party's own document only.
 */

/** The link purposes this page serves: PAYMENT (an invoice or a deposit request to pay) and W1's DEPOSIT_INFO. */
export type PayPurpose = 'PAYMENT' | 'DEPOSIT_INFO'

/** Where the card and SEPA step stands (the client secret stays in the container's memory, never in the model). */
export interface CardStepModel {
  method: PaymentMethod | null
  phase: PayPhase
  /** This page's payment (started here, or a payment of this link under way when the page opened). */
  intent: PaymentIntent | null
  /** The FAKE provider's fields can be used (the page holds the client secret). */
  fields: boolean
  /** The bank asked to confirm (3-D Secure): its window's buttons are shown. */
  confirming: boolean
  /** A FAKE provider's button was pressed and its answer is awaited. */
  sending: boolean
  /** The start took up a payment of the same payer again (a reload, a double click). */
  resumed: boolean
  /** A refused start or confirm, as a message key of `link-pay`. */
  problem: string | null
}

export const IDLE_CARD: CardStepModel = { method: null, phase: 'idle', intent: null, fields: false, confirming: false, sending: false, resumed: false, problem: null }

export interface PayViewModel {
  /** The link: `valid` once it opened (then `page` says the record's state); `unavailable` = the frame's dead link. */
  link: 'loading' | 'valid' | 'unavailable' | 'error'
  purpose: PayPurpose
  page: PayPage | null
  /** W1's deposit facts (DEPOSIT_INFO): acconto or caparra and its share; null when not read. */
  deposit: DepositFacts | null
  /** The page could not be read (a message key): Try again. */
  problem: string | null
  /** The field just copied (the page says so once). */
  copied: string | null
  card: CardStepModel
  /** No connection: the card step waits. */
  offline?: boolean
  /** The site's zone for dates (default Europe/Rome). */
  timeZone?: string
}

export interface PayActions {
  onRetry?: () => void
  onCopy?: (what: string, text: string) => void
  onMethod?: (method: PaymentMethod) => void
  onStart?: () => void
  onScenario?: (scenario: FakeScenario) => void
  /** Open the FAKE provider's fields again for a payment under way (the start takes it up again). */
  onResume?: () => void
  /** After a failed payment: choose again. */
  onAgain?: () => void
}

/** An IBAN in groups of four, as people read it aloud ("IT60 X054 …"). */
export const groupedIban = (iban: string): string => iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()

/** The page's title: the deposit of an order or a quote, or the invoice. */
export function titleOf(page: PayPage): { key: string; params?: Record<string, string> } {
  const what = page.what
  if (what.target === 'INVOICE') return { key: 'title.invoice', params: { number: what.number ?? '' } }
  if (what.orderNumber) return { key: 'title.depositOrder', params: { order: what.orderNumber } }
  if (what.quoteDocument) return { key: 'title.depositQuote', params: { quote: what.quoteDocument } }
  return { key: 'title.deposit' }
}

/** What the payment is for: the order and its quote, the order, the quote — or nothing to add. */
export function forOf(page: PayPage): { key: string; params?: Record<string, string> } | null {
  const { orderNumber, quoteDocument } = page.what
  if (orderNumber && quoteDocument) return { key: 'what.forOrderQuote', params: { order: orderNumber, quote: quoteDocument } }
  if (orderNumber) return { key: 'what.forOrder', params: { order: orderNumber } }
  if (quoteDocument) return { key: 'what.forQuote', params: { quote: quoteDocument } }
  return null
}

/** The status pill: To pay, Paid, Nothing to pay. */
export const STATUS_TONE = { TO_PAY: 'warning', PAID: 'success', CLOSED: 'neutral' } as const

/** A payment of this link still decided by the provider when the page opened: the card step follows it. */
export const underWay = (intent: PaymentIntent | null): boolean => intent !== null && (intent.status === 'WAITING' || intent.status === 'CREATED')

/** The card step of a page just read: a payment under way is followed (waiting), anything else starts idle. */
export function cardFromPage(page: PayPage, current: CardStepModel = IDLE_CARD): CardStepModel {
  if (page.status !== 'TO_PAY') return IDLE_CARD
  if (current.intent && !underWay(current.intent) && current.phase !== 'idle') return current
  if (underWay(page.intent)) {
    const same = current.intent?.id === page.intent!.id
    return { ...IDLE_CARD, method: page.intent!.method, phase: same && current.phase === 'ready' ? 'ready' : 'paying', intent: page.intent, fields: same && current.fields, confirming: same && current.confirming }
  }
  return current.phase === 'idle' ? current : IDLE_CARD
}

/** Why the card step cannot be used now (a message key of `link-pay`), or null. GATE-SPEND: only the FAKE provider runs. */
export function cardHeld(page: PayPage, offline: boolean): string | null {
  if (!page.card.available) return `card.unavailable.${unavailableKeyOf(page.card.reason)}`
  if (!providerRuns(page.card)) return 'card.unavailable.GATE_SPEND'
  if (page.what.currency !== 'EUR') return 'card.refusal.CURRENCY'
  if (page.what.open === undefined || page.what.open <= 0) return 'card.refusal.NOT_OPEN'
  if (offline) return 'card.offline'
  return null
}

/** Where the payment stands, for the DS PaymentPanel. */
export const cardState = (card: CardStepModel): PaymentState => paymentStateOf(card.phase, card.intent)

/** The FAKE provider's buttons the panel shows now, or none (no secret, a card payment the bank decides, an end). */
export function fakeButtons(card: CardStepModel, state: PaymentState = cardState(card)): readonly FakeScenario[] {
  if (!card.method || !card.fields) return []
  if (state === 'ready' || state === 'paying') return fakeScenariosFor(card.method, card.confirming ? 'confirm' : 'first')
  if (state === 'waiting' && card.method === 'SEPA_DEBIT') return fakeScenariosFor(card.method, 'processing')
  return []
}

/** The failed payment's reason, as a key of `link-pay` (the provider's code in our words; never the API's text). */
export const failureKey = (intent: PaymentIntent | null): string => `card.failure.${failureKeyOf(intent?.failureCode)}`

/** The receipt of a payment made online from this link (the done state), or null when it was paid another way. */
export const paidOnline = (page: PayPage): PaymentIntent | null => (page.intent?.status === 'SUCCEEDED' ? page.intent : null)
