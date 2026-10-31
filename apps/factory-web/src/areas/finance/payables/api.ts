import { z } from 'zod'
import { LINE_KINDS, MATCH_BASES, MATCH_STATUSES } from '@nexus/factory-domain/payables/match'
import { INVOICE_KINDS, INVOICE_SOURCES, INVOICE_STATUSES, TILES } from '@nexus/factory-domain/payables/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Finance › Supplier invoices (SCR-153, design finance.payables; B-W2a-62's API, apps/factory-api
 * modules/payables) and of the PO studio's Invoices tab, each answer checked with a zod shape that mirrors the API's
 * contract (unknown fields are dropped). What a supplier charges is a COST: every amount and price is optional here —
 * the API drops it for a reader without the cost grain (a planner, the warehouse) and the screen then draws no column for
 * it (never '—'). The enum lists are factory-domain's own.
 */

export { INVOICE_KINDS, INVOICE_SOURCES, INVOICE_STATUSES, LINE_KINDS, MATCH_BASES, MATCH_STATUSES, TILES }
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]
export type InvoiceSource = (typeof INVOICE_SOURCES)[number]
export type InvoiceKind = (typeof INVOICE_KINDS)[number]
export type MatchStatus = (typeof MATCH_STATUSES)[number]
export type LineKind = (typeof LINE_KINDS)[number]
export type Tile = (typeof TILES)[number]
export const VERDICTS = ['WITHIN', 'DIFFERENCE', 'WAITING'] as const
export type Verdict = (typeof VERDICTS)[number]

/** A cost figure: absent for a reader without the cost grain. */
const cost = <T extends z.ZodTypeAny>(schema: T) => schema.optional()
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const person = z.object({ id: z.string(), name: z.string().nullable() })
const words = z.object({ en: z.string(), it: z.string() })
const refusal = z.object({ code: z.string(), message: z.string() })

const summaryShape = {
  id: z.string(),
  company: named,
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), country: z.string() }),
  source: z.enum(INVOICE_SOURCES),
  kind: z.enum(INVOICE_KINDS),
  docType: z.string().nullable(),
  number: z.string(),
  issueDate: z.string(),
  receivedOn: z.string(),
  currency: z.string(),
  netTotal: cost(z.number()),
  vatTotal: cost(z.number()),
  grossTotal: cost(z.number()),
  status: z.enum(INVOICE_STATUSES),
  matchStatus: z.enum(MATCH_STATUSES),
  differencesToCheck: z.number(),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
  paidOn: z.string().nullable(),
  lines: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
}
export const invoiceRowSchema = z.object(summaryShape)
export type InvoiceRow = z.infer<typeof invoiceRowSchema>

const fileRef = z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number(), status: z.string(), kind: z.string() })

export const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(LINE_KINDS),
  description: z.string(),
  itemCode: z.string().nullable(),
  quantity: z.string().nullable(),
  uom: z.string().nullable(),
  unitPrice: cost(z.string().nullable()),
  discountPct: z.string().nullable(),
  netAmount: cost(z.number()),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  siteId: z.string().nullable(),
  purchaseOrderLine: z
    .object({ id: z.string(), orderId: z.string(), orderNumber: z.string(), seq: z.number(), item: z.object({ code: z.string(), name: z.string() }), quantity: z.string(), uom: z.string() })
    .nullable(),
  subcontractOrder: z.object({ id: z.string(), number: z.string(), workOrderId: z.string() }).nullable(),
  version: z.number(),
})
export type InvoiceLine = z.infer<typeof lineSchema>

export const matchSchema = z.object({
  id: z.string(),
  invoiceLineId: z.string(),
  lineSeq: z.number(),
  purchaseOrderLineId: z.string().nullable(),
  subcontractOrderId: z.string().nullable(),
  order: z
    .object({
      kind: z.enum(['PURCHASE_ORDER', 'SUBCONTRACT_ORDER']),
      id: z.string(),
      number: z.string(),
      lineSeq: z.number().nullable(),
      item: z.object({ code: z.string(), name: z.string() }).nullable(),
    })
    .nullable(),
  receipt: z.object({ receiptLineId: z.string(), receiptId: z.string(), number: z.string(), supplierDdtNumber: z.string().nullable(), supplierDdtDate: z.string().nullable() }).nullable(),
  unit: z.string(),
  orderedQuantity: z.string().nullable(),
  orderedUnitPrice: cost(z.string()),
  receivedQuantity: z.string(),
  invoicedQuantity: z.string(),
  invoicedUnitPrice: cost(z.string()),
  differenceAmount: cost(z.number()),
  quantityTolerancePct: z.string(),
  priceTolerancePct: z.string(),
  withinTolerance: z.boolean(),
  verdict: z.enum(VERDICTS),
  words,
  stale: z.boolean(),
  accepted: z.object({ at: z.string(), by: person, note: z.string() }).nullable(),
  version: z.number(),
})
export type InvoiceMatch = z.infer<typeof matchSchema>

const held = z.object({
  edit: z.string().nullable(),
  map: z.string().nullable(),
  dispute: z.string().nullable(),
  reopen: z.string().nullable(),
  withdraw: z.string().nullable(),
  pay: z.string().nullable(),
  void: z.string().nullable(),
})
export type HeldActions = z.infer<typeof held>

export const invoiceSchema = z.object({
  ...summaryShape,
  sdiIdentifier: z.string().nullable(),
  sdiFileName: z.string().nullable(),
  withholdingAmount: cost(z.number().nullable()),
  stampDutyAmount: cost(z.number().nullable()),
  vatSummary: cost(z.array(z.object({ rate: z.string().nullable(), nature: z.string().nullable(), taxable: z.number(), vat: z.number() }))),
  paymentTerms: z
    .object({
      condition: z.string().nullable(),
      installments: z.array(z.object({ method: z.string().nullable(), amount: cost(z.number().nullable()), dueDate: z.string().nullable(), iban: z.string().nullable() })),
    })
    .nullable(),
  creditOf: z.object({ id: z.string(), number: z.string(), issueDate: z.string() }).nullable(),
  credits: z.array(z.object({ id: z.string(), number: z.string(), issueDate: z.string(), status: z.enum(INVOICE_STATUSES) })),
  files: z.object({ xml: fileRef.nullable(), pdf: fileRef.nullable() }),
  registeredBy: person.nullable(),
  lines: z.array(lineSchema),
  matches: z.array(matchSchema),
  tolerance: z.object({ basis: z.enum(MATCH_BASES), quantityTolerancePct: z.string(), priceTolerancePct: z.string(), decided: z.boolean(), words }),
  approval: z.object({ approvedAt: z.string().nullable(), approvedBy: person.nullable(), note: z.string().nullable(), ready: z.boolean(), problems: z.array(refusal) }),
  dispute: z.object({ at: z.string(), by: person.nullable(), reason: z.string() }).nullable(),
  payment: z.object({ dueDate: z.string().nullable(), paidOn: z.string().nullable(), paymentRef: z.string().nullable() }),
  voided: z.object({ at: z.string(), reason: z.string() }).nullable(),
  internalNote: z.string().nullable(),
  actions: held,
})
export type SupplierInvoice = z.infer<typeof invoiceSchema>

const one = z.object({ invoice: invoiceSchema })

export const listSchema = z.object({ items: z.array(invoiceRowSchema), nextCursor: z.string().nullable(), count: z.number() })
export type InvoicePage = z.infer<typeof listSchema>

export const countsSchema = z.object({ newFromSdi: z.number(), differences: z.number(), toApprove: z.number(), dueThisWeek: z.number(), weekEnds: z.string(), readAt: z.string() })
export type InvoiceCounts = z.infer<typeof countsSchema>

const waitingSchema = z.object({ sdiIdentifier: z.string(), fileName: z.string(), receivedAt: z.string(), problem: z.string() })
export const sdiStatusSchema = z.object({
  companies: z.array(
    z.object({
      company: named,
      account: z.object({ id: z.string(), mode: z.string(), status: z.string() }).nullable(),
      picksUp: z.boolean(),
      lastPickup: z.object({ at: z.string(), byPerson: z.boolean(), listed: z.number(), recorded: z.number(), waiting: z.array(waitingSchema) }).nullable(),
    }),
  ),
})
export type SdiStatus = z.infer<typeof sdiStatusSchema>

export const pickupSchema = z.object({
  companyId: z.string(),
  accountId: z.string(),
  listed: z.number(),
  known: z.number(),
  recorded: z.array(z.object({ invoiceId: z.string(), number: z.string(), sdiIdentifier: z.string(), matchStatus: z.string() })),
  waiting: z.array(waitingSchema),
  at: z.string(),
})
export type PickupAnswer = z.infer<typeof pickupSchema>

export const xmlSchema = z.object({
  fileName: z.string(),
  fileId: z.string(),
  xml: cost(z.string()),
  read: z
    .object({
      format: z.string().nullable(),
      supplier: z.object({ vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), name: z.string().nullable() }),
      buyer: z.object({ vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), name: z.string().nullable() }),
      documents: z.array(
        z.object({
          docType: z.string(),
          number: z.string(),
          issueDate: z.string(),
          causale: z.array(z.string()),
          orders: z.array(z.object({ document: z.string().nullable(), date: z.string().nullable(), lines: z.array(z.number()) })),
          ddts: z.array(z.object({ number: z.string(), date: z.string().nullable(), lines: z.array(z.number()) })),
          lines: z.number(),
          attachments: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
})
export type InvoiceXml = z.infer<typeof xmlSchema>

export const candidatesSchema = z.object({
  purchaseOrderLines: z.array(
    z.object({
      id: z.string(),
      orderId: z.string(),
      orderNumber: z.string(),
      orderStatus: z.string(),
      seq: z.number(),
      siteId: z.string(),
      item: z.object({ code: z.string(), name: z.string() }),
      supplierArticleCode: z.string().nullable(),
      quantity: z.string(),
      uom: z.string(),
    }),
  ),
  subcontractOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), workOrderId: z.string() })),
})
export type Candidates = z.infer<typeof candidatesSchema>

export const bulkApproveSchema = z.object({
  results: z.array(z.object({ id: z.string(), approved: z.boolean(), status: z.enum(INVOICE_STATUSES).nullable(), version: z.number().nullable(), refusals: z.array(refusal) })),
  approved: z.number(),
  refused: z.number(),
})
export type BulkApproveAnswer = z.infer<typeof bulkApproveSchema>

export const supplierSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), country: z.string(), currency: z.string() })
export type SupplierOption = z.infer<typeof supplierSchema>

// ---- reads ------------------------------------------------------------------------------------------------------------------

export interface InvoiceQuery {
  readonly companyId?: string | null
  readonly partyId?: string | null
  readonly purchaseOrderId?: string | null
  readonly tile?: Tile | null
  readonly status?: InvoiceStatus | null
  readonly matchStatus?: MatchStatus | null
  readonly source?: InvoiceSource | null
  readonly q?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

const clean = (query: Readonly<Record<string, string | number | null | undefined>>) =>
  Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))
const seg = (value: string) => encodeURIComponent(value)
const at = (invoiceId: string, rest = '') => `/payables/invoices/${seg(invoiceId)}${rest}`

/** GET /payables/invoices: a page of 50, newest first, with how many match. */
export function listInvoices(api: ApiClient, query: InvoiceQuery, signal?: AbortSignal): Promise<InvoicePage> {
  return api.get('/payables/invoices', {
    query: clean({
      companyId: query.companyId,
      partyId: query.partyId,
      purchaseOrderId: query.purchaseOrderId,
      tile: query.tile,
      status: query.status,
      matchStatus: query.matchStatus,
      source: query.source,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit ?? 50,
    }),
    schema: listSchema,
    signal,
  })
}

/** GET /payables/invoices/counts: the four "To handle" tiles. */
export function getCounts(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<InvoiceCounts> {
  return api.get('/payables/invoices/counts', { query: clean({ companyId }), schema: countsSchema, signal })
}

/** GET /payables/sdi: per company its SDI account and the last pickup. */
export function getSdiStatus(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SdiStatus> {
  return api.get('/payables/sdi', { query: clean({ companyId }), schema: sdiStatusSchema, signal })
}

export async function getInvoice(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<SupplierInvoice> {
  return (await api.get(at(invoiceId), { schema: one, signal })).invoice
}

export function getXml(api: ApiClient, invoiceId: string, signal?: AbortSignal): Promise<InvoiceXml> {
  return api.get(at(invoiceId, '/xml'), { schema: xmlSchema, signal })
}

export function getCandidates(api: ApiClient, invoiceId: string, q: string | null = null, signal?: AbortSignal): Promise<Candidates> {
  return api.get(at(invoiceId, '/candidates'), { query: clean({ q }), schema: candidatesSchema, signal })
}

/** The suppliers (and workshops) a foreign invoice can be typed for: GET /parties by role. */
export async function findSuppliers(api: ApiClient, q: string, signal?: AbortSignal): Promise<SupplierOption[]> {
  const answer = await api.get('/parties', { query: clean({ role: 'SUPPLIER,SUBCONTRACTOR', q: q.trim() || null, limit: 20 }), schema: z.object({ parties: z.array(supplierSchema) }), signal })
  return answer.parties
}

// ---- writes (each with its own idempotency key; the invoice's version as read) ------------------------------------------------

const write = async (api: ApiClient, method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, key: string = newIdempotencyKey()): Promise<SupplierInvoice> =>
  (await api.request(method, path, { body, schema: one, idempotencyKey: key })).invoice

export interface MappingInput {
  readonly kind?: LineKind
  readonly purchaseOrderLineId?: string | null
  readonly subcontractOrderId?: string | null
}

/** PATCH …/lines/:lineId: the line's mapping (any open invoice) or a typed line's figures. */
export const patchLine = (api: ApiClient, invoiceId: string, lineId: string, body: { version: number } & MappingInput & Partial<LineFigures>, key?: string) =>
  write(api, 'PATCH', at(invoiceId, `/lines/${seg(lineId)}`), body, key)

export interface LineFigures {
  readonly description: string
  readonly itemCode: string | null
  readonly quantity: string | null
  readonly uom: string | null
  readonly unitPrice: string | null
  readonly netAmount: number
  readonly vatRatePct: string
  readonly vatNature: string | null
}

export const addLine = (api: ApiClient, invoiceId: string, version: number, line: LineFigures & { kind?: LineKind }, key?: string) =>
  write(api, 'POST', at(invoiceId, '/lines'), { version, ...line }, key)
export const removeLine = (api: ApiClient, invoiceId: string, lineId: string, version: number, key?: string) => write(api, 'DELETE', at(invoiceId, `/lines/${seg(lineId)}`), { version }, key)
export const withoutOrder = (api: ApiClient, invoiceId: string, version: number, key?: string) => write(api, 'POST', at(invoiceId, '/without-order'), { version }, key)
export const matchAgain = (api: ApiClient, invoiceId: string, version: number, key?: string) => write(api, 'POST', at(invoiceId, '/match'), { version }, key)
export const acceptDifference = (api: ApiClient, invoiceId: string, matchId: string, version: number, note: string, key?: string) =>
  write(api, 'POST', at(invoiceId, `/matches/${seg(matchId)}/accept`), { version, note }, key)
export const approveInvoice = (api: ApiClient, invoiceId: string, version: number, note: string | null, key?: string) => write(api, 'POST', at(invoiceId, '/approve'), { version, note }, key)
export const withdrawApproval = (api: ApiClient, invoiceId: string, version: number, reason: string, key?: string) => write(api, 'POST', at(invoiceId, '/withdraw-approval'), { version, reason }, key)
export const disputeInvoice = (api: ApiClient, invoiceId: string, version: number, reason: string, key?: string) => write(api, 'POST', at(invoiceId, '/dispute'), { version, reason }, key)
export const reopenInvoice = (api: ApiClient, invoiceId: string, version: number, reason: string | null, key?: string) =>
  write(api, 'POST', at(invoiceId, '/reopen'), { version, ...(reason ? { reason } : {}) }, key)
export const voidInvoice = (api: ApiClient, invoiceId: string, version: number, reason: string, key?: string) => write(api, 'POST', at(invoiceId, '/void'), { version, reason }, key)
export const payInvoice = (api: ApiClient, invoiceId: string, version: number, paidOn: string, paymentRef: string, key?: string) =>
  write(api, 'POST', at(invoiceId, '/pay'), { version, paidOn, paymentRef }, key)

/** POST …/send-to-buyer: an internal note on the invoice's thread naming each line outside the tolerance. */
export async function sendToBuyer(
  api: ApiClient,
  invoiceId: string,
  version: number,
  message: string | null,
  key: string = newIdempotencyKey(),
): Promise<{ invoice: SupplierInvoice; mentioned: string[]; notReached: string[] }> {
  return api.post(at(invoiceId, '/send-to-buyer'), {
    body: { version, message },
    schema: z.object({ invoice: invoiceSchema, mentioned: z.array(z.string()), notReached: z.array(z.string()) }),
    idempotencyKey: key,
  })
}

/** POST /payables/invoices/approve: each its own command; the answer says per row. */
export function approveMany(api: ApiClient, items: readonly { id: string; version: number }[], key: string = newIdempotencyKey()): Promise<BulkApproveAnswer> {
  return api.post('/payables/invoices/approve', { body: { items }, schema: bulkApproveSchema, idempotencyKey: key })
}

/** POST /payables/sdi/pickup: ask the intermediary now. */
export function pickUpNow(api: ApiClient, companyId: string, key: string = newIdempotencyKey()): Promise<PickupAnswer> {
  return api.post('/payables/sdi/pickup', { body: { companyId }, schema: pickupSchema, idempotencyKey: key })
}

export interface ForeignInvoiceInput {
  readonly companyId: string
  readonly partyId: string
  readonly kind: InvoiceKind
  readonly number: string
  readonly issueDate: string
  readonly currency: string
  readonly dueDate: string | null
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly fileId: string | null
  readonly internalNote: string | null
  readonly lines: readonly (LineFigures & { kind: LineKind })[]
}

/** POST /payables/invoices (source MANUAL): "Add foreign invoice", its PDF copied onto it. */
export async function createForeign(api: ApiClient, input: ForeignInvoiceInput, key: string = newIdempotencyKey()): Promise<SupplierInvoice> {
  return (await api.post('/payables/invoices', { body: { ...input, source: 'MANUAL' }, schema: one, idempotencyKey: key })).invoice
}

/** The foreign invoice's PDF onto the supplier's record (files.upload): announce, send the bytes, confirm; its id. */
export async function uploadInvoicePdf(api: ApiClient, target: { companyId: string; partyId: string }, file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: target.companyId,
    record: { type: 'Party', id: target.partyId },
    kind: 'DOCUMENT',
    name: file.name || 'invoice.pdf',
    contentType: file.type || 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
  return stored.id
}
