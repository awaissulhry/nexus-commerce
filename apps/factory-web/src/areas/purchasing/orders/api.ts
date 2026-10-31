import { z } from 'zod'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { LINE_ANSWERS, LINE_CHANGES } from '@nexus/factory-domain/purchasing/confirm/answer'
import { PURCHASE_ORDER_STATUSES, SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'
import { REACH_ACTIONS } from '@nexus/factory-domain/purchasing/orders/changes'
import { DELIVERY_STATES } from '@nexus/factory-domain/purchasing/orders/delivery'
import { LINE_DIFF_KINDS, REVISION_ANSWERS } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Purchase orders (SCR-058) and the PO studio (SCR-059), with the answer's shape checked (zod; unknown
 * fields are dropped). The shapes mirror apps/factory-api modules/purchasing/contract.ts and confirm/contract.ts; the
 * enum lists are factory-domain's. Prices and amounts are the cost grain: absent for a person without it (the screen
 * then draws no price column, never a "—"). The API's English (check messages, the answer's words, the proposal
 * summary) is never drawn: the screens say their own words from the codes.
 */

const uom = z.enum(UOMS)
export const PO_STATUSES = PURCHASE_ORDER_STATUSES
export type PoStatus = (typeof PURCHASE_ORDER_STATUSES)[number]
const status = z.enum(PURCHASE_ORDER_STATUSES)

const linkState = z.object({
  id: z.string(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: z.string(),
  uses: z.number(),
  maxUses: z.number(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type LinkState = z.infer<typeof linkState>

const checkSchema = z.object({ code: z.enum(SEND_CHECK_CODES), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string() })
export type SendCheck = z.infer<typeof checkSchema>

export const poLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  itemId: z.string(),
  item: z.object({ code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom }),
  itemColourId: z.string().nullable(),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  description: z.string().nullable(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  baseUom: uom,
  unitPrice: z.string().optional(),
  netAmount: z.number().optional(),
  needDate: z.string(),
  grade: z.string().nullable(),
  thicknessMinMm: z.string().nullable(),
  thicknessMaxMm: z.string().nullable(),
  oneDyeBatch: z.boolean(),
  areaTolerancePct: z.string().nullable(),
  estimatedHides: z.number().nullable(),
  requiresCrViTest: z.boolean(),
  note: z.string().nullable(),
  confirmedQuantity: z.string().nullable(),
  confirmedDate: z.string().nullable(),
  receivedBaseQuantity: z.string(),
  plan: z.array(z.object({ requirementId: z.string(), runId: z.string(), runStatus: z.string(), decision: z.string() })),
  /** B-W2a-52: cancelled (nothing more of it is wanted) or closed short (the rest will not come); null while open. */
  ended: z.object({ kind: z.enum(['CANCELLED', 'CLOSED_SHORT']), at: z.string(), byId: z.string().nullable(), reason: z.string().nullable() }).nullable().optional(),
  version: z.number(),
})
export type PoLine = z.infer<typeof poLineSchema>

export const orderSchema = z.object({
  id: z.string(),
  number: z.string(),
  documentNumber: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  site: z.object({ code: z.string(), name: z.string() }),
  partyId: z.string(),
  supplier: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  contactId: z.string().nullable(),
  contact: z.object({ name: z.string(), email: z.string().nullable(), roles: z.array(z.string()) }).nullable(),
  status,
  revision: z.number(),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  incoterms: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  note: z.string().nullable(),
  internalNote: z.string().nullable(),
  netAmount: z.number().optional(),
  /** B-W2a-52: the lines not cancelled (cost grain). */
  openNetAmount: z.number().optional(),
  lineCount: z.number(),
  earliestNeedDate: z.string().nullable(),
  sentAt: z.string().nullable(),
  sentById: z.string().nullable(),
  /** B-W2a-52 (SCM-087): when the supplier is asked to answer by (set at the send; the office may move it). */
  confirmBy: z.string().nullable().optional(),
  confirmedAt: z.string().nullable(),
  confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
  confirmedByName: z.string().nullable(),
  supplierRef: z.string().nullable(),
  confirmNote: z.string().nullable(),
  declinedAt: z.string().nullable(),
  declineReason: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(poLineSchema),
  send: z.object({ ready: z.boolean(), checks: z.array(checkSchema) }).nullable(),
  confirmLinks: z.array(linkState),
})
export type PurchaseOrder = z.infer<typeof orderSchema>
const one = z.object({ order: orderSchema })

export const orderRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  partyId: z.string(),
  supplierName: z.string(),
  status,
  revision: z.number(),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  earliestNeedDate: z.string().nullable(),
  latestConfirmedDate: z.string().nullable(),
  lineCount: z.number(),
  netAmount: z.number().optional(),
  sentAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  confirmedVia: z.enum(['LINK', 'OFFICE']).nullable(),
  confirmedByName: z.string().nullable(),
  declinedAt: z.string().nullable(),
  /** B-W2a-52: the confirm-by time, the next open line's expected day and where the deliveries stand. */
  confirmBy: z.string().nullable().optional(),
  nextExpectedDate: z.string().nullable().optional(),
  delivery: z.enum(DELIVERY_STATES).nullable().optional(),
  updatedAt: z.string(),
  version: z.number(),
})
export type OrderRow = z.infer<typeof orderRowSchema>

const summarySchema = z.object({
  drafts: z.number(),
  waiting: z.number(),
  notConfirmedAfter48h: z.number(),
  changesProposed: z.number(),
  declined: z.number(),
  /** B-W2a-52: orders with an open line expected this week / late; null when not every open line could be read ('—'). */
  dueThisWeek: z.number().nullable().optional(),
  late: z.number().nullable().optional(),
  pastConfirmBy: z.number().optional(),
})
export type OrderSummary = z.infer<typeof summarySchema>
const listSchema = z.object({ summary: summarySchema, orders: z.array(orderRowSchema), nextCursor: z.string().nullable() })
export type OrderPage = z.infer<typeof listSchema>

export interface OrderQuery {
  status?: PoStatus | null
  waitingOver48h?: boolean
  /** B-W2a-52: an open line expected late (before today) or this week. */
  due?: 'LATE' | 'THIS_WEEK' | null
  /** B-W2a-52: still waiting for the supplier after the confirm-by time. */
  pastConfirmBy?: boolean
  q?: string
  siteId?: string
  partyId?: string
  cursor?: string | null
  limit?: number
}

export function listOrders(api: ApiClient, query: OrderQuery, signal?: AbortSignal): Promise<OrderPage> {
  return api.get('/purchasing/orders', {
    query: {
      status: query.status ?? undefined,
      waitingOver48h: query.waitingOver48h ? 'true' : undefined,
      due: query.due ?? undefined,
      pastConfirmBy: query.pastConfirmBy ? 'true' : undefined,
      q: query.q?.trim() || undefined,
      siteId: query.siteId,
      partyId: query.partyId,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 50,
    },
    schema: listSchema,
    signal,
  })
}

const orderUrl = (id: string) => `/purchasing/orders/${encodeURIComponent(id)}`

export async function getOrder(api: ApiClient, id: string, signal?: AbortSignal): Promise<PurchaseOrder> {
  return (await api.get(orderUrl(id), { schema: one, signal })).order
}

export interface HeaderFields {
  contactId?: string | null
  requestedDate?: string | null
  incoterms?: string | null
  paymentTerms?: string | null
  note?: string | null
  internalNote?: string | null
}

export async function createOrder(api: ApiClient, body: { companyId: string; siteId: string; partyId: string } & HeaderFields): Promise<PurchaseOrder> {
  return (await api.post('/purchasing/orders', { body, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

export async function updateOrder(api: ApiClient, id: string, version: number, fields: HeaderFields): Promise<PurchaseOrder> {
  return (await api.request('PATCH', orderUrl(id), { body: { version, ...fields }, schema: one })).order
}

export interface LineFields {
  itemColourId?: string | null
  quantity?: string
  uom?: string
  unitPrice?: string
  needDate?: string
  description?: string | null
  supplierArticleCode?: string | null
  supplierColourCode?: string | null
  grade?: string | null
  thicknessMinMm?: string | null
  thicknessMaxMm?: string | null
  oneDyeBatch?: boolean
  areaTolerancePct?: string | null
  note?: string | null
}

export async function addLine(api: ApiClient, id: string, version: number, body: { itemId: string; quantity: string; needDate: string } & LineFields): Promise<PurchaseOrder> {
  return (await api.post(`${orderUrl(id)}/lines`, { body: { version, ...body }, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

export async function editLine(api: ApiClient, id: string, lineId: string, version: number, fields: LineFields): Promise<PurchaseOrder> {
  return (await api.request('PATCH', `${orderUrl(id)}/lines/${encodeURIComponent(lineId)}`, { body: { version, ...fields }, schema: one })).order
}

export async function removeLine(api: ApiClient, id: string, lineId: string, version: number): Promise<PurchaseOrder> {
  return (await api.request('DELETE', `${orderUrl(id)}/lines/${encodeURIComponent(lineId)}`, { query: { version }, schema: one })).order
}

/** The order's PDF before the send, for a new tab (the browser's own GET through this app's /api; the cost grain; no language = the supplier's). */
export const previewHref = (id: string, language?: 'it' | 'en'): string => `/api${orderUrl(id)}/preview${language ? `?language=${language}` : ''}`

/** The same PDF's bytes, for the send dialog's viewer (a 409 says the letterhead is not complete; 403 without the cost grain). */
export function previewBytes(api: ApiClient, id: string, language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${orderUrl(id)}/preview`, { query: { language }, signal })
}

const sendCheckSchema = z.object({
  ready: z.boolean(),
  checks: z.array(checkSchema),
  recipient: z.object({ contactId: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  documentNumber: z.string(),
  language: z.enum(['it', 'en']),
  linkExpiresAt: z.string(),
  subject: z.string(),
  /** B-W2a-52: the confirm-by time the send sets unless one is given; the revision; what a later one changes (the supplier's words). */
  confirmBy: z.string().optional(),
  revision: z.number().optional(),
  changes: z.array(z.string()).nullable().optional(),
})
export type SendCheckAnswer = z.infer<typeof sendCheckSchema>

export function sendCheck(api: ApiClient, id: string, signal?: AbortSignal): Promise<SendCheckAnswer> {
  return api.get(`${orderUrl(id)}/send-check`, { schema: sendCheckSchema, signal })
}

const delivery = z.enum(['sent', 'failed', 'retry', 'settled']).nullable()
const sentView = z.object({
  revision: z.number(),
  sentAt: z.string(),
  documentFileId: z.string(),
  to: z.string(),
  link: z.object({ id: z.string(), expiresAt: z.string() }),
  emailId: z.string(),
  confirmBy: z.string().optional(),
  revisionId: z.string().optional(),
  changes: z.array(z.string()).nullable().optional(),
})
const sentSchema = z.object({ order: orderSchema, sent: sentView, delivery })
export type SendAnswer = z.infer<typeof sentSchema>

export function sendOrder(
  api: ApiClient,
  id: string,
  body: { version: number; cc?: string[]; subject?: string | null; message?: string | null; confirmBy?: string | null; changeNote?: string | null },
  idempotencyKey: string,
): Promise<SendAnswer> {
  return api.post(`${orderUrl(id)}/send`, { body, schema: sentSchema, idempotencyKey })
}

const linkSentSchema = z.object({ order: orderSchema, link: z.object({ id: z.string(), expiresAt: z.string(), to: z.string(), revokedLinkIds: z.array(z.string()), emailId: z.string() }), delivery })
export type LinkSentAnswer = z.infer<typeof linkSentSchema>

export function sendNewLink(api: ApiClient, id: string, body: { version: number; cc?: string[]; message?: string | null }): Promise<LinkSentAnswer> {
  return api.post(`${orderUrl(id)}/send-link`, { body, schema: linkSentSchema, idempotencyKey: newIdempotencyKey() })
}

export async function cancelOrder(api: ApiClient, id: string, body: { version: number; reason: string; message?: string | null }): Promise<{ order: PurchaseOrder; supplierTold: boolean }> {
  return api.post(`${orderUrl(id)}/cancel`, { body, schema: z.object({ order: orderSchema, supplierTold: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}

const documentsSchema = z.object({
  revision: z.number(),
  status,
  sentAt: z.string().nullable(),
  documents: z.array(z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), sizeBytes: z.number(), status: z.string(), createdAt: z.string() })),
  links: z.array(linkState),
  mails: z.array(
    z.object({
      id: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      subject: z.string(),
      status: z.string(),
      queuedAt: z.string(),
      sentAt: z.string().nullable(),
      deliveredAt: z.string().nullable(),
      failedAt: z.string().nullable(),
    }),
  ),
})
export type OrderDocuments = z.infer<typeof documentsSchema>

export function getDocuments(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderDocuments> {
  return api.get(`${orderUrl(id)}/documents`, { schema: documentsSchema, signal })
}

const supplierViewSchema = z.object({
  order: z.object({ number: z.string(), documentNumber: z.string(), status, orderDate: z.string(), requestedDate: z.string().nullable(), note: z.string().nullable() }),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      code: z.string().nullable(),
      name: z.string().nullable(),
      colour: z.object({ name: z.string().nullable(), supplierCode: z.string().nullable() }).nullable(),
      quantity: z.string(),
      uom,
      baseQuantity: z.string(),
      baseUom: uom.nullable(),
      needDate: z.string(),
      grade: z.string().nullable(),
      thicknessMinMm: z.string().nullable(),
      thicknessMaxMm: z.string().nullable(),
      oneDyeBatch: z.boolean(),
      areaTolerancePct: z.string().nullable(),
      estimatedHides: z.number().nullable(),
      requiresCrViTest: z.boolean(),
      confirmedQuantity: z.string().nullable(),
      confirmedDate: z.string().nullable(),
    }),
  ),
})
export type SupplierView = z.infer<typeof supplierViewSchema>

export function getSupplierView(api: ApiClient, id: string, signal?: AbortSignal): Promise<SupplierView> {
  return api.get(`${orderUrl(id)}/supplier-view`, { schema: supplierViewSchema, signal })
}

const deliverySchema = z.object({ quantity: z.string(), date: z.string().nullable() })
const answerSchema = z.object({
  purchaseOrderId: z.string(),
  number: z.string(),
  status,
  answer: z.enum(['NOT_SENT', 'WAITING', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'CLOSED']),
  confirmation: z.object({ at: z.string(), via: z.enum(['LINK', 'OFFICE']), linkId: z.string().nullable(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable() }).nullable(),
  decline: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  proposal: z
    .object({
      at: z.string(),
      linkId: z.string().nullable(),
      byName: z.string().nullable(),
      supplierRef: z.string().nullable(),
      note: z.string().nullable(),
      decision: z.enum(['ACCEPTED', 'REFUSED']).nullable(),
      decidedAt: z.string().nullable(),
      decidedById: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      item: z.object({ code: z.string(), name: z.string() }),
      colour: z.string().nullable(),
      asked: z.object({ quantity: z.string(), uom, needDate: z.string() }),
      proposed: z.object({ kind: z.enum(LINE_ANSWERS), quantity: z.string(), date: z.string().nullable(), deliveries: z.array(deliverySchema), reason: z.string().nullable(), changes: z.array(z.enum(LINE_CHANGES)) }).nullable(),
      confirmed: deliverySchema.nullable(),
      changes: z.array(z.enum(LINE_CHANGES)),
    }),
  ),
  evidence: z.array(z.object({ linkId: z.string(), action: z.string(), at: z.string(), useNumber: z.number().nullable(), typedName: z.string().nullable() })),
  links: z.array(linkState),
})
export type SupplierAnswer = z.infer<typeof answerSchema>

export function getAnswer(api: ApiClient, id: string, signal?: AbortSignal): Promise<SupplierAnswer> {
  return api.get(`${orderUrl(id)}/answer`, { schema: answerSchema, signal })
}

export async function acceptProposal(api: ApiClient, id: string, version: number, message: string | null): Promise<{ order: PurchaseOrder; supplierTold: boolean }> {
  return api.post(`${orderUrl(id)}/proposal/accept`, { body: { version, ...(message?.trim() ? { message: message.trim() } : {}) }, schema: z.object({ order: orderSchema, supplierTold: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}

export async function refuseProposal(api: ApiClient, id: string, version: number, note: string | null): Promise<{ order: PurchaseOrder }> {
  return api.post(`${orderUrl(id)}/proposal/refuse`, { body: { version, ...(note?.trim() ? { note: note.trim() } : {}) }, schema: z.object({ order: orderSchema }), idempotencyKey: newIdempotencyKey() })
}

// ---- the receipts against the order (Warehouse) ------------------------------------------------------------------------------

const receiptRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(['OPEN', 'POSTED', 'REVERSED', 'CANCELLED']),
  supplierDdtNumber: z.string().nullable(),
  supplierDdtDate: z.string().nullable(),
  receivedAt: z.string(),
  lines: z.number(),
  lots: z.number(),
  lotsReleased: z.number(),
  hides: z.number(),
  quantities: z.array(z.object({ uom, baseQuantity: z.string() })),
  postedAt: z.string().nullable(),
})
export type OrderReceipt = z.infer<typeof receiptRowSchema>

export async function receiptsOf(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderReceipt[]> {
  return (await api.get('/inventory/receipts', { query: { purchaseOrderId: orderId, limit: 200 }, schema: z.object({ receipts: z.array(receiptRowSchema) }), signal })).receipts
}

// ---- B-W2a-52: changes after the send (B-W2a-69 screens) ---------------------------------------------------------------------

const peggedSchema = z.object({
  kind: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string().nullable() }).nullable(),
  salesOrder: z.object({ id: z.string(), number: z.string().nullable() }).nullable(),
  size: z.string().nullable(),
  demandDate: z.string(),
  quantity: z.string(),
})
const reachShape = {
  runId: z.string().nullable(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      seq: z.number(),
      baseUom: z.string(),
      orderedBase: z.string(),
      receivedBase: z.string(),
      outstandingBase: z.string(),
      planLineIds: z.array(z.string()),
      pegged: z.array(peggedSchema),
    }),
  ),
  workOrders: z.array(z.object({ id: z.string(), number: z.string().nullable() })),
  salesOrders: z.array(z.object({ id: z.string(), number: z.string().nullable() })),
}
const reachSchema = z.object({
  action: z.enum(REACH_ACTIONS),
  status,
  allowed: z.boolean(),
  /** The API's sentences (English): never drawn; the screen says its own words from the facts. */
  problems: z.array(z.string()),
  mayDo: z.boolean(),
  supplierTold: z.boolean(),
  confirmed: z.boolean(),
  ...reachShape,
})
export type OrderReach = z.infer<typeof reachSchema>
export type ReachAction = (typeof REACH_ACTIONS)[number]

/** What a cancel or a close short reaches, read before the dialog's Confirm (per line, the plan lines, pegged work and sales orders). */
export function getReach(api: ApiClient, id: string, action: ReachAction, lineIds: readonly string[] = [], signal?: AbortSignal): Promise<OrderReach> {
  return api.get(`${orderUrl(id)}/reach`, { query: { action, lineIds: lineIds.length ? lineIds.join(',') : undefined }, schema: reachSchema, signal })
}

const endedSchema = z.object({ order: orderSchema, reach: z.object(reachShape), supplierTold: z.boolean() })

/** Cancel lines (nothing more of them is wanted) or close them short (the rest will not come); the plan lines open again. */
export function endLines(api: ApiClient, id: string, kind: 'cancel' | 'close-short', body: { version: number; lineIds: readonly string[]; reason: string; message?: string | null }, idempotencyKey: string): Promise<{ order: PurchaseOrder; supplierTold: boolean }> {
  return api.post(`${orderUrl(id)}/lines/${kind}`, { body: { ...body, lineIds: [...body.lineIds] }, schema: endedSchema, idempotencyKey })
}

/** Change a sent, declined or confirmed order: it becomes the draft of the next revision (its links stop). */
export function changeOrder(api: ApiClient, id: string, body: { version: number; note?: string | null }, idempotencyKey: string): Promise<{ order: PurchaseOrder; revision: number; revokedLinkIds: string[] }> {
  return api.post(`${orderUrl(id)}/change`, { body, schema: z.object({ order: orderSchema, revision: z.number(), revokedLinkIds: z.array(z.string()) }), idempotencyKey })
}

/** Counter-propose: the supplier's proposal is refused and the order becomes the draft of the next revision, from what was asked. */
export function counterPropose(api: ApiClient, id: string, body: { version: number; note?: string | null }, idempotencyKey: string): Promise<{ order: PurchaseOrder }> {
  return api.post(`${orderUrl(id)}/proposal/counter`, { body, schema: z.object({ order: orderSchema }).passthrough(), idempotencyKey })
}

/** Move the time by which the supplier is asked to answer (a sent order). */
export async function moveConfirmBy(api: ApiClient, id: string, version: number, confirmBy: string): Promise<PurchaseOrder> {
  return (await api.post(`${orderUrl(id)}/confirm-by`, { body: { version, confirmBy }, schema: one, idempotencyKey: newIdempotencyKey() })).order
}

/** A reminder to confirm, by hand (a sent order; the mail carries no link). */
export function remind(api: ApiClient, id: string, body: { version: number; message?: string | null }, idempotencyKey: string): Promise<{ order: PurchaseOrder; reminder: { id: string; revision: number; sentAt: string; to: string; emailId: string; automatic: boolean } }> {
  return api.post(`${orderUrl(id)}/remind`, {
    body,
    schema: z.object({ order: orderSchema, reminder: z.object({ id: z.string(), revision: z.number(), sentAt: z.string(), to: z.string(), emailId: z.string(), automatic: z.boolean() }) }),
    idempotencyKey,
  })
}

const remindersSchema = z.object({
  purchaseOrderId: z.string(),
  number: z.string(),
  status,
  revision: z.number(),
  /** The company's automatic reminders (the Owner's switch; off until a setting holds it). */
  automatic: z.boolean(),
  confirmBy: z.string().nullable(),
  overdue: z.boolean(),
  sentForRevision: z.number(),
  nextAutomaticAt: z.string().nullable(),
  reminders: z.array(
    z.object({
      id: z.string(),
      revision: z.number(),
      kind: z.string(),
      sentAt: z.string(),
      automatic: z.boolean(),
      sentById: z.string().nullable(),
      sentByName: z.string().nullable(),
      to: z.string().nullable(),
      emailId: z.string().nullable(),
      mailStatus: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
})
export type OrderReminders = z.infer<typeof remindersSchema>

export function getReminders(api: ApiClient, id: string, signal?: AbortSignal): Promise<OrderReminders> {
  return api.get(`${orderUrl(id)}/reminders`, { schema: remindersSchema, signal })
}

const fieldChange = z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })
const diffSchema = z.object({
  header: z.array(fieldChange),
  lines: z.array(z.object({ lineId: z.string(), seq: z.number(), itemId: z.string(), kind: z.enum(LINE_DIFF_KINDS), changes: z.array(fieldChange) })),
  count: z.number(),
})
export type RevisionChanges = z.infer<typeof diffSchema>
const pricesSchema = z.object({ currency: z.string(), netAmount: z.number().optional(), lines: z.array(z.object({ id: z.string(), seq: z.number(), unitPrice: z.string().optional(), netAmount: z.number().optional() })) })
const revisionsSchema = z.object({
  purchaseOrderId: z.string(),
  number: z.string(),
  revision: z.number(),
  status,
  /** The draft of the next revision: what changed so far (and the same in words, the language asked). */
  draft: z.object({ revision: z.number(), documentNumber: z.string(), changes: diffSchema, words: z.array(z.string()) }).nullable(),
  revisions: z.array(
    z.object({
      id: z.string(),
      revision: z.number(),
      documentNumber: z.string(),
      sentAt: z.string(),
      sentById: z.string().nullable(),
      sentByName: z.string().nullable(),
      changeNote: z.string().nullable(),
      documentFileId: z.string().nullable(),
      changes: diffSchema,
      words: z.array(z.string()),
      answer: z.enum(REVISION_ANSWERS),
      confirmation: z.object({ at: z.string(), via: z.string().nullable(), byName: z.string().nullable(), supplierRef: z.string().nullable() }).nullable(),
      lines: z.number(),
      /** The cost grain only: absent without it. */
      prices: z
        .object({
          before: pricesSchema.nullable(),
          after: pricesSchema,
          changed: z.object({
            netAmount: z.object({ before: z.number(), after: z.number() }).nullable().optional(),
            lines: z.array(z.object({ lineId: z.string(), seq: z.number(), unitPrice: z.object({ before: z.string().nullable(), after: z.string().nullable() }).nullable().optional(), netAmount: z.object({ before: z.number().nullable(), after: z.number().nullable() }).optional() })),
          }),
        })
        .optional(),
    }),
  ),
})
export type OrderRevisions = z.infer<typeof revisionsSchema>
export type OrderRevision = OrderRevisions['revisions'][number]

export function getRevisions(api: ApiClient, id: string, language: 'it' | 'en', signal?: AbortSignal): Promise<OrderRevisions> {
  return api.get(`${orderUrl(id)}/revisions`, { query: { language }, schema: revisionsSchema, signal })
}

const refusedSchema = z.object({ code: z.string(), message: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })) })
const sendCardSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  partyId: z.string().nullable(),
  status: status.nullable(),
  version: z.number().nullable(),
  ready: z.boolean(),
  checks: z.array(checkSchema),
  recipient: z.object({ contactId: z.string(), name: z.string(), email: z.string().nullable() }).nullable(),
  documentNumber: z.string().nullable(),
  language: z.enum(['it', 'en']).nullable(),
  linkExpiresAt: z.string().nullable(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
  confirmBy: z.string().nullable(),
  revision: z.number().nullable(),
  changes: z.array(z.string()).nullable(),
  /** The API's refusal of the read (its English is never drawn: the code is). */
  refused: refusedSchema.nullable(),
})
export type SendCard = z.infer<typeof sendCardSchema>

/** Send n: each order's checks, recipient, language, confirm-by and revision — one card each. */
export async function sendChecks(api: ApiClient, orderIds: readonly string[], signal?: AbortSignal): Promise<SendCard[]> {
  return (await api.post('/purchasing/orders/send-checks', { body: { orderIds: [...orderIds] }, schema: z.object({ ready: z.number(), cards: z.array(sendCardSchema) }), signal })).cards
}

const outcomeSchema = z.object({ id: z.string(), number: z.string().nullable(), outcome: z.enum(['SENT', 'REFUSED']), sent: sentView.nullable(), delivery, refused: refusedSchema.nullable() })
export type SendOutcome = z.infer<typeof outcomeSchema>

/** Send n: each order its own send (and key); a refused one keeps its code. */
export async function sendMany(api: ApiClient, body: { orders: readonly { id: string; version: number; confirmBy?: string | null }[]; message?: string | null }, idempotencyKey: string): Promise<SendOutcome[]> {
  return (await api.post('/purchasing/orders/send-many', { body: { ...body, orders: [...body.orders] }, schema: z.object({ sent: z.number(), refused: z.number(), outcomes: z.array(outcomeSchema) }), idempotencyKey })).outcomes
}
