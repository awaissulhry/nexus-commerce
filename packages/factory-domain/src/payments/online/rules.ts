import type { IntegrationMode, IntegrationProviderCode } from '../../ports/provider'
import type { ProviderState } from './port'

/**
 * Paying online (B-W2b-185; FIN-118 invoices and payment in the customer portal, FIN-123 card payments; design links.pay,
 * portal.customer.documents "To pay"). A customer pays one of its own deposit requests or issued invoices by card or SEPA
 * Direct Debit through the payment provider; bank transfer stays the default and is always shown (W1, Q12). Pure rules.
 *
 *   intent      portal-sales.prisma PaymentIntent: CREATED (made, the provider called) → WAITING (the provider made it;
 *               the customer confirms in the provider's fields, the bank may ask) → SUCCEEDED | FAILED | CANCELLED (final)
 *   payment     a SUCCEEDED intent records ONE Payment (method CARD or SEPA_DEBIT, the provider's id as its reference)
 *               through the payments module's insertPayment, allocated to what it pays (as much as is still open)
 *   gate        GATE-SPEND (plan §3, W2b-3 question 2): live card payments wait for the Owner's yes with the exact cost.
 *               Until then a LIVE Stripe account is not offered; FAKE (local, test) and SANDBOX work, and production has
 *               neither (the gateway refuses FAKE there)
 */

export const INTENT_METHODS = ['CARD', 'SEPA_DEBIT'] as const
export type IntentMethod = (typeof INTENT_METHODS)[number]

export const INTENT_STATUSES = ['CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]
export const LIVE_INTENT_STATUSES = ['CREATED', 'WAITING'] as const satisfies readonly IntentStatus[]
export const FINAL_INTENT_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const satisfies readonly IntentStatus[]
export type FinalIntentStatus = (typeof FINAL_INTENT_STATUSES)[number]
export const isFinalIntent = (status: IntentStatus): status is FinalIntentStatus => (FINAL_INTENT_STATUSES as readonly string[]).includes(status)

/** The moves the database allows (factory_payment_intent_guard): forward only; a final state never moves again. */
const MOVES: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  CREATED: ['WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  WAITING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
}
export const mayMove = (from: IntentStatus, to: IntentStatus): boolean => MOVES[from].includes(to)

/** What it pays: an OPEN deposit request or an issued TD01 / TD24 invoice of the paying party. */
export const INTENT_TARGETS = ['DEPOSIT_REQUEST', 'INVOICE'] as const
export type IntentTarget = (typeof INTENT_TARGETS)[number]

/**
 * The provider's own words we keep (providerRef, failureCode): letters, digits, `_` and `-`, 1-255, and never a run of
 * twelve digits (no card number can be kept: the same rule as the database's factory_payment_provider_text_ok).
 */
export function providerTextOk(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,255}$/.test(value) && !/[0-9]{12}/.test(value)
}

/** A provider's reason code as we keep it: cut to the allowed letters, else `failed`. */
export function failureCodeOf(code: string | null | undefined): string {
  const cleaned = (code ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return cleaned !== '' && providerTextOk(cleaned) ? cleaned : 'failed'
}

// ---- GATE-SPEND and the provider account --------------------------------------------------------------------------

/**
 * W2b-3 question 2 (recommended answer): build on the FAKE provider now, go live only when a customer asks, with the
 * provider and its exact fees named to the Owner. One line: true only on the Owner's yes.
 */
export const LIVE_CARD_PAYMENTS_ALLOWED = false

export const PAYMENT_PROVIDERS = ['PAYMENT_FAKE', 'STRIPE'] as const satisfies readonly IntegrationProviderCode[]
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]
export const isPaymentProvider = (provider: string): provider is PaymentProvider => (PAYMENT_PROVIDERS as readonly string[]).includes(provider)

export type AccountRefusal = 'NOT_A_PAYMENT_ACCOUNT' | 'NOT_ACTIVE' | 'GATE_SPEND' | 'FAKE_IN_PRODUCTION' | 'FAKE_PROVIDER_LIVE'

/** Whether an account may take card payments now (null: it may). */
export function accountRefusal(account: { readonly provider: string; readonly mode: IntegrationMode; readonly status: string }, environment: string): AccountRefusal | null {
  if (!isPaymentProvider(account.provider)) return 'NOT_A_PAYMENT_ACCOUNT'
  if (account.status !== 'ACTIVE') return 'NOT_ACTIVE'
  if (account.mode === 'FAKE' && environment === 'production') return 'FAKE_IN_PRODUCTION'
  if (account.provider === 'PAYMENT_FAKE' && account.mode !== 'FAKE') return 'FAKE_PROVIDER_LIVE'
  if (account.provider === 'STRIPE' && account.mode === 'LIVE' && !LIVE_CARD_PAYMENTS_ALLOWED) return 'GATE_SPEND'
  return null
}

/**
 * Which account a company's card payments use, among the payment accounts of its own and the tenant-wide ones: one that
 * may take payments (accountRefusal), the company's own first, then the oldest. Null: none (the reason of the first
 * refused one, when there is one).
 */
export function pickAccount<Account extends { readonly id: string; readonly companyId: string | null; readonly provider: string; readonly mode: IntegrationMode; readonly status: string; readonly createdAt: Date }>(
  accounts: readonly Account[],
  companyId: string,
  environment: string,
): { readonly account: Account | null; readonly refusal: AccountRefusal | 'NO_ACCOUNT' | null } {
  const mine = accounts.filter((account) => isPaymentProvider(account.provider) && (account.companyId === null || account.companyId === companyId))
  const ordered = [...mine].sort((a, b) => Number(b.companyId !== null) - Number(a.companyId !== null) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  const usable = ordered.find((account) => accountRefusal(account, environment) === null)
  if (usable) return { account: usable, refusal: null }
  const first = ordered[0]
  return { account: null, refusal: first ? accountRefusal(first, environment) : 'NO_ACCOUNT' }
}

// ---- the provider's states and events ------------------------------------------------------------------------------

/**
 * Our status for the provider's state of an intent (null: nothing to record). `requires_payment_method` after an attempt
 * is a decline (the webhook's payment_failed says so with its code); before one it is the intent waiting for the
 * customer, which is WAITING already.
 */
export function statusOfProviderState(state: ProviderState): IntentStatus | null {
  switch (state) {
    case 'succeeded':
      return 'SUCCEEDED'
    case 'canceled':
      return 'CANCELLED'
    case 'processing':
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
      return 'WAITING'
  }
}

/**
 * Our status for a webhook event (Stripe's `payment_intent.*`; the fake posts the same). A payment_failed is FAILED
 * (final): the customer tries again with a new intent, and the failed one is cancelled at the provider afterwards, so it
 * can never take money later. Events about other objects, or that change nothing we keep, answer null.
 */
export function statusOfEvent(type: string, state: ProviderState | null): IntentStatus | null {
  switch (type) {
    case 'payment_intent.succeeded':
      return 'SUCCEEDED'
    case 'payment_intent.payment_failed':
      return 'FAILED'
    case 'payment_intent.canceled':
      return 'CANCELLED'
    case 'payment_intent.processing':
    case 'payment_intent.requires_action':
      return 'WAITING'
    default:
      // payment_intent.created, .amount_capturable_updated, .partially_funded …: the intent's own state, when final.
      return state === 'succeeded' ? 'SUCCEEDED' : state === 'canceled' ? 'CANCELLED' : null
  }
}

// ---- words ---------------------------------------------------------------------------------------------------------

export type OnlineLocale = 'it' | 'en'

/** The provider's reason in our words (design links.pay "card" error: "Your bank declined the card. Try another card or pay by transfer."). */
const FAILURE_WORDS: Readonly<Record<string, { readonly it: string; readonly en: string }>> = {
  card_declined: { it: 'La banca ha rifiutato la carta. Prova con un’altra carta o paga con bonifico.', en: 'Your bank declined the card. Try another card or pay by transfer.' },
  insufficient_funds: { it: 'La carta non ha fondi sufficienti. Prova con un’altra carta o paga con bonifico.', en: 'The card has not enough funds. Try another card or pay by transfer.' },
  expired_card: { it: 'La carta è scaduta. Prova con un’altra carta o paga con bonifico.', en: 'The card has expired. Try another card or pay by transfer.' },
  incorrect_cvc: { it: 'Il codice di sicurezza non è corretto. Riprova.', en: 'The security code is not right. Try again.' },
  authentication_failed: { it: 'La banca non ha confermato il pagamento. Riprova o paga con bonifico.', en: 'Your bank did not confirm the payment. Try again or pay by transfer.' },
  payment_intent_authentication_failure: { it: 'La banca non ha confermato il pagamento. Riprova o paga con bonifico.', en: 'Your bank did not confirm the payment. Try again or pay by transfer.' },
  debit_not_authorized: { it: 'La banca non ha autorizzato l’addebito SEPA. Paga con bonifico o con carta.', en: 'Your bank did not authorise the SEPA debit. Pay by transfer or by card.' },
  insufficient_funds_sepa: { it: 'L’addebito SEPA è stato respinto. Paga con bonifico o con carta.', en: 'The SEPA debit was returned. Pay by transfer or by card.' },
  provider_unavailable: { it: 'Il servizio di pagamento non risponde. Riprova tra poco o paga con bonifico.', en: 'The payment service does not answer. Try again in a moment or pay by transfer.' },
  provider_refused: { it: 'Il servizio di pagamento ha rifiutato la richiesta. Paga con bonifico.', en: 'The payment service refused the request. Pay by transfer.' },
}
const FAILURE_DEFAULT = { it: 'Il pagamento non è andato a buon fine. Riprova o paga con bonifico.', en: 'The payment did not go through. Try again or pay by transfer.' } as const

export function failureWords(code: string | null, locale: OnlineLocale): string {
  return (code ? FAILURE_WORDS[code] : undefined)?.[locale] ?? FAILURE_DEFAULT[locale]
}

/** Why card payments are not offered, in words (the page shows bank transfer alone, with this line). */
const UNAVAILABLE_WORDS: Readonly<Record<AccountRefusal | 'NO_ACCOUNT', { readonly it: string; readonly en: string }>> = {
  NO_ACCOUNT: { it: 'Il pagamento con carta non è disponibile: paga con bonifico.', en: 'Card payment is not available: pay by bank transfer.' },
  NOT_A_PAYMENT_ACCOUNT: { it: 'Il pagamento con carta non è disponibile: paga con bonifico.', en: 'Card payment is not available: pay by bank transfer.' },
  NOT_ACTIVE: { it: 'Il pagamento con carta è sospeso: paga con bonifico.', en: 'Card payment is paused: pay by bank transfer.' },
  GATE_SPEND: { it: 'Il pagamento con carta non è ancora attivo: paga con bonifico.', en: 'Card payment is not switched on yet: pay by bank transfer.' },
  FAKE_IN_PRODUCTION: { it: 'Il pagamento con carta non è disponibile: paga con bonifico.', en: 'Card payment is not available: pay by bank transfer.' },
  FAKE_PROVIDER_LIVE: { it: 'Il pagamento con carta non è disponibile: paga con bonifico.', en: 'Card payment is not available: pay by bank transfer.' },
}
export const unavailableWords = (reason: AccountRefusal | 'NO_ACCOUNT', locale: OnlineLocale): string => UNAVAILABLE_WORDS[reason][locale]

/** The refusals of starting a payment (409 `payment/<CODE>`), in English (the API's message); the web words them itself. */
export const START_REFUSALS = {
  NOT_OPEN: 'There is nothing left to pay on this document.',
  NO_PROVIDER: 'Card and SEPA payments are not available for this company: pay by bank transfer.',
  CURRENCY: 'Card and SEPA payments are taken in euro only: pay by bank transfer.',
  NOT_PAYABLE: 'This document is not paid online: a deposit invoice is paid through its deposit request, a credit note is not paid.',
  PROVIDER: 'The payment service did not answer: try again in a moment, or pay by bank transfer.',
  IN_PROGRESS: 'A payment of this document is under way (being confirmed at the bank, or a SEPA debit on its way): wait for it, or pay by bank transfer.',
} as const

/** A live intent of someone else younger than this is a payment under way: a new one waits (IN_PROGRESS). */
export const IN_PROGRESS_MS = 30 * 60_000
/** A live intent of the same payer, method and amount younger than this is taken up again instead of a new one. */
export const RESUME_MS = 24 * 60 * 60_000
export type StartRefusal = keyof typeof START_REFUSALS

/** The receipt mail (design links.pay "Paid — thank you. Receipt sent to …"), pure: subject and text, no link. */
export function receiptMail(input: {
  readonly locale: OnlineLocale
  readonly what: string
  readonly amount: string
  readonly method: IntentMethod
  readonly paidOn: string
  readonly reference: string
  readonly companyName: string
  readonly depositInvoiceFollows: boolean
}): { readonly subject: string; readonly body: string } {
  const it = input.locale === 'it'
  const method = input.method === 'CARD' ? (it ? 'con carta' : 'by card') : it ? 'con addebito diretto SEPA' : 'by SEPA Direct Debit'
  const subject = it ? `Pagamento ricevuto: ${input.what}` : `Payment received: ${input.what}`
  const lines = it
    ? [
        'Buongiorno,',
        `grazie: abbiamo ricevuto ${input.amount} ${method} per ${input.what} il ${input.paidOn}.`,
        `Riferimento del pagamento: ${input.reference}.`,
        ...(input.depositInvoiceFollows ? ['La fattura di acconto segue per e-mail.'] : []),
        'Cordiali saluti,',
        input.companyName,
      ]
    : [
        'Hello,',
        `thank you: we received ${input.amount} ${method} for ${input.what} on ${input.paidOn}.`,
        `Payment reference: ${input.reference}.`,
        ...(input.depositInvoiceFollows ? ['The deposit invoice follows by e-mail.'] : []),
        'Kind regards,',
        input.companyName,
      ]
  return { subject, body: lines.join('\n\n') }
}

/** The PAYMENT link's mail (office: "send the payment page"), pure: the stored text has no link (`url` null). */
export function paymentLinkMail(input: { readonly locale: OnlineLocale; readonly what: string; readonly amount: string; readonly dueDate: string | null; readonly expiresOn: string; readonly message: string | null }, url: string | null): { readonly subject: string; readonly body: string } {
  const it = input.locale === 'it'
  const kept = it ? '[Link personale inviato solo per e-mail: non è conservato qui.]' : '[A personal link, sent by e-mail only: it is not kept here.]'
  const subject = it ? `${input.what}: paga online` : `${input.what}: pay online`
  const lead = it
    ? `ecco la pagina per pagare ${input.what} (${input.amount}${input.dueDate ? `, scadenza ${input.dueDate}` : ''}): con carta, addebito diretto SEPA o bonifico.`
    : `here is the page to pay ${input.what} (${input.amount}${input.dueDate ? `, due ${input.dueDate}` : ''}): by card, SEPA Direct Debit or bank transfer.`
  const note = input.message?.trim() ?? ''
  const body = [it ? 'Buongiorno,' : 'Hello,', `${lead}\n${url ?? kept}`, it ? `Il link funziona fino al ${input.expiresOn}.` : `The link works until ${input.expiresOn}.`, note].filter((part) => part !== '').join('\n\n')
  return { subject, body }
}

/** "714.00 EUR" from minor units (two decimals: the euro). */
export const amountText = (minor: number, currency: string): string => `${(minor / 100).toFixed(2)} ${currency}`
