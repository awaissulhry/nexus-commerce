import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { documentSchema } from './preview/api'

/**
 * What the customer's Documents page reads and sends (B-W2b-195, SCR-186; design portal.customer.documents), every answer
 * checked and only what the page uses: the library (B-W2b-178: chips by the groups the role sees, every issued document in
 * its fixed versions), conformity per style received (B-W2b-178), the open items to pay and paying one online on the FAKE
 * provider (B-W2b-185), the statement of account (a new tab). Money comes only with the person's price grain (the API drops
 * those fields otherwise: optional here). The API's English words are never shown: kinds, groups and states are codes the
 * page words itself.
 */

const live = z.object({ events: z.array(z.string()) })

// ── the library ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const LIBRARY_CHIPS = ['ALL', 'DELIVERY', 'CONFORMITY', 'FINANCE', 'ORDERS', 'OTHER'] as const
export type LibraryChip = (typeof LIBRARY_CHIPS)[number]
export const isLibraryChip = (value: unknown): value is LibraryChip => typeof value === 'string' && (LIBRARY_CHIPS as readonly string[]).includes(value)

export const librarySchema = z.object({
  asOf: z.string(),
  seesPrices: z.boolean(),
  group: z.enum(LIBRARY_CHIPS).catch('ALL'),
  chips: z.array(z.object({ chip: z.enum(LIBRARY_CHIPS), count: z.number() })),
  count: z.number(),
  newCount: z.number(),
  lastVisitAt: z.string().nullable(),
  items: z.array(documentSchema),
  live,
})
export type LibraryRead = z.infer<typeof librarySchema>

export const PAGE_SIZE = 50

export interface LibraryQuery {
  group: LibraryChip
  q: string
  versions: 'current' | 'all'
  offset?: number
}

/** One page of the library, newest first (the chip's group, the search, earlier versions too or not). */
export const fetchLibrary = (api: ApiClient, query: LibraryQuery, signal?: AbortSignal): Promise<LibraryRead> =>
  api.get('/portal/customer-documents', {
    query: { group: query.group, versions: query.versions, limit: PAGE_SIZE, offset: query.offset ?? 0, ...(query.q.trim() ? { q: query.q.trim().slice(0, 80) } : {}) },
    schema: librarySchema,
    signal,
  })

// ── conformity per style received ─────────────────────────────────────────────────────────────────────────────────────
export const RECEIVED_STATES = ['COMPLETE', 'INCOMPLETE', 'NOT_REQUIRED'] as const
export type ReceivedState = (typeof RECEIVED_STATES)[number]

const words = z.object({ it: z.string(), en: z.string() })
export const docRefSchema = z.object({ id: z.string(), kind: z.string(), title: words, version: z.number(), language: z.string().nullable(), fingerprint: z.string(), new: z.boolean() })
export type DocRef = z.infer<typeof docRefSchema>

export const receivedSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string() }),
  order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable() }).nullable(),
  shippedOn: z.string(),
  revision: z.number().nullable(),
  pieces: z.number(),
  state: z.enum(RECEIVED_STATES).catch('INCOMPLETE'),
  declaration: docRefSchema.nullable(),
  userInformation: docRefSchema.nullable(),
  certificate: z
    .object({
      number: z.string(),
      standard: z.string(),
      ppeClass: z.string().nullable(),
      notifiedBody: z.object({ name: z.string(), number: z.string() }),
      validFrom: z.string(),
      validTo: z.string(),
      validOnShippingDate: z.boolean(),
    })
    .nullable(),
  reports: z.array(docRefSchema),
})
export type Received = z.infer<typeof receivedSchema>

export const conformitySchema = z.object({
  asOf: z.string(),
  count: z.number(),
  styles: z.array(
    z.object({
      style: z.object({ code: z.string(), name: z.string() }),
      ppe: z.boolean(),
      certificateRequired: z.boolean(),
      standard: z.string().nullable(),
      ppeClass: z.string().nullable(),
      received: z.array(receivedSchema),
    }),
  ),
  live,
})
export type ConformityRead = z.infer<typeof conformitySchema>
export type ConformityStyle = ConformityRead['styles'][number]

/** Per style received: per shipment, the declaration and leaflet that travelled and the certificate valid on that day. */
export const fetchConformity = (api: ApiClient, q: string, signal?: AbortSignal): Promise<ConformityRead> =>
  api.get('/portal/customer-documents/conformity', { query: q.trim() ? { q: q.trim().slice(0, 80) } : {}, schema: conformitySchema, signal })

// ── to pay (B-W2b-185) ───────────────────────────────────────────────────────────────────────────────────────────────
export const INTENT_STATUSES = ['CREATED', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]
export const PAY_METHODS = ['CARD', 'SEPA_DEBIT'] as const
export type PayMethod = (typeof PAY_METHODS)[number]

const price = z.number().optional()

export const intentSchema = z.object({
  id: z.string(),
  method: z.enum(PAY_METHODS).catch('CARD'),
  amount: price,
  currency: z.string(),
  status: z.enum(INTENT_STATUSES),
  providerRef: z.string().nullable(),
  failureCode: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type PaymentIntent = z.infer<typeof intentSchema>

export const openInvoiceSchema = z.object({
  invoiceId: z.string(),
  number: z.string(),
  docType: z.string(),
  issueDate: z.string(),
  dueDate: z.string(),
  dueDateKnown: z.boolean(),
  daysLate: z.number(),
  total: price,
  open: price,
  currency: z.string(),
  sdiStatus: z.string(),
  pdfFileId: z.string().nullable(),
  xmlFileId: z.string().nullable(),
  payment: intentSchema.nullable(),
  canPay: z.boolean(),
})
export type OpenInvoice = z.infer<typeof openInvoiceSchema>

export const openDepositSchema = z.object({
  depositRequestId: z.string(),
  orderNumber: z.string().nullable(),
  quoteDocument: z.string().nullable(),
  dueDate: z.string(),
  daysLate: z.number(),
  total: price,
  open: price,
  currency: z.string(),
  payment: intentSchema.nullable(),
  canPay: z.boolean(),
})
export type OpenDeposit = z.infer<typeof openDepositSchema>

export const cardSchema = z.object({ available: z.boolean(), methods: z.array(z.enum(PAY_METHODS).catch('CARD')), provider: z.string().nullable(), mode: z.string().nullable(), reason: z.string().nullable() })
export type CardOffer = z.infer<typeof cardSchema>

export const openItemsSchema = z.object({
  asOf: z.string(),
  invoices: z.array(openInvoiceSchema),
  deposits: z.array(openDepositSchema),
  byCurrency: z.array(z.object({ currency: z.string(), open: price, overdue: price })),
  counts: z.object({ invoices: z.number(), overdue: z.number(), deposits: z.number() }),
  card: cardSchema,
  mayPay: z.boolean(),
  live,
})
export type OpenItemsRead = z.infer<typeof openItemsSchema>

export const fetchOpenItems = (api: ApiClient, signal?: AbortSignal): Promise<OpenItemsRead> => api.get('/portal/payments/open-items', { schema: openItemsSchema, signal })

/** What a payment pays: an invoice or a deposit request. */
export type PayTarget = { kind: 'invoice'; id: string } | { kind: 'deposit'; id: string }

const startedSchema = z.object({
  intent: intentSchema,
  provider: z.object({ name: z.string(), mode: z.string(), clientSecret: z.string(), publishableKey: z.string().nullable() }).nullable(),
  resumed: z.boolean(),
})
export type StartedPayment = z.infer<typeof startedSchema>

/** Starts (or takes up again) a payment of the target as this person (one Idempotency-Key per start). */
export const startPayment = (api: ApiClient, target: PayTarget, method: PayMethod, idempotencyKey: string = newIdempotencyKey()): Promise<StartedPayment> =>
  api.post('/portal/payments/intents', { body: target.kind === 'invoice' ? { invoiceId: target.id, method } : { depositRequestId: target.id, method }, schema: startedSchema, idempotencyKey })

/** How a payment of the party stands (the page polls while the bank decides). */
export const fetchIntent = (api: ApiClient, intentId: string, signal?: AbortSignal): Promise<PaymentIntent> =>
  api.get(`/portal/payments/intents/${encodeURIComponent(intentId)}`, { schema: z.object({ intent: intentSchema }), signal }).then((read) => read.intent)

/**
 * The FAKE provider's own answers (local and test only; never card data): what the bank says. A card: paid, declined, not
 * enough funds, or the bank asks to confirm (then confirmed or not); a SEPA debit: the mandate sent (the bank decides
 * later), then the money settles or the debit is returned.
 */
export const FAKE_SCENARIOS = {
  CARD: ['succeed', 'decline', 'insufficient_funds', 'authenticate'],
  CARD_CONFIRM: ['succeed', 'fail_authentication'],
  SEPA_DEBIT: ['succeed'],
  SEPA_WAITING: ['settle', 'return'],
} as const
export type FakeStage = keyof typeof FAKE_SCENARIOS
export type FakeScenario = (typeof FAKE_SCENARIOS)[FakeStage][number]

/** The FAKE provider's fields: the page hands back the client secret with the answer the tester chose. */
export const confirmFake = (api: ApiClient, clientSecret: string, scenario: FakeScenario): Promise<{ state: string }> =>
  api.post('/payment-fake/confirm', { body: { clientSecret, scenario }, schema: z.object({ state: z.string() }), idempotencyKey: newIdempotencyKey() })

/** The statement of account as a PDF in a new tab (made on the fly, stored nowhere; B-W2b-185). */
export const statementHref = (language: 'it' | 'en'): string => `/api/portal/payments/statement/pdf?language=${language}`
