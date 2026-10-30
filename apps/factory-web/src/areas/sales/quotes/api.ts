import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * The quotes screens' calls to the factory API (apps/factory-api modules/sales/quotes; B-W1-21, B-W1-24), through the
 * ONE client. Every answer is checked against its shape; a field the caller's money grains do not reach is simply absent
 * (the API drops it), so every money field here is optional: absent = not shown, never 0. Every write sends the quote's
 * `version` as read (a quote moved meanwhile is a 409, never overwritten) and an Idempotency-Key.
 *
 * Also the parties (customer picker, contacts, addresses) and product styles (the style picker) reads a quote needs.
 */

export const QUOTE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const
export type QuoteStatus = (typeof QUOTE_STATUSES)[number]
export const VERSION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export const APPROVAL_REASONS = ['MARGIN_FLOOR', 'DISCOUNT_LIMIT', 'AMOUNT_LIMIT', 'SPECIAL_ITEM'] as const
export type ApprovalReason = (typeof APPROVAL_REASONS)[number]
export const DEPOSIT_KINDS = ['ACCONTO', 'CAPARRA'] as const
export type DepositKind = (typeof DEPOSIT_KINDS)[number]
export const ISSUE_SEVERITIES = ['BLOCKS', 'BLOCKS_SEND', 'WARNING', 'INFO'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]
export const DECIDE_HELD = ['OWN_REQUEST', 'NO_RIGHT', 'NEEDS_MARGIN', 'NOT_WAITING'] as const
export type DecideHeld = (typeof DECIDE_HELD)[number]

const instant = z.string()
const certificateSchema = z.object({ outcome: z.enum(['covered', 'not_required', 'refused']), certificateNumber: z.string().nullable(), reasons: z.array(z.string()) })

export const lineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.string(),
  styleId: z.string(),
  style: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  styleRevisionId: z.string().nullable(),
  styleRevision: z.object({ revision: z.number(), status: z.string() }).nullable(),
  colourwayId: z.string(),
  colourway: z.object({ code: z.string(), name: z.string() }),
  description: z.string().nullable(),
  note: z.string().nullable(),
  quantity: z.number(),
  listUnitPrice: z.string().nullable().optional(),
  unitPrice: z.string().optional(),
  discountPct: z.string().nullable(),
  netAmount: z.number().optional(),
  vatRatePct: z.string(),
  vatNature: z.string().nullable(),
  vatAmount: z.number().optional(),
  unitCost: z.string().nullable().optional(),
  costAmount: z.number().nullable().optional(),
  costComplete: z.boolean(),
  costMissing: z.array(z.object({ code: z.string(), message: z.string() })),
  marginAmount: z.number().nullable().optional(),
  marginPct: z.string().nullable().optional(),
  belowFloor: z.boolean().optional(),
  sizes: z.array(z.object({ size: z.string(), quantity: z.number(), unitPrice: z.string().nullable().optional(), certificate: certificateSchema })),
  version: z.number(),
})
export type QuoteLine = z.infer<typeof lineSchema>

const vatEntrySchema = z.object({ rate: z.string().nullable(), nature: z.string().nullable(), taxable: z.number(), vat: z.number() })

export const currentSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.enum(VERSION_STATUSES),
  currency: z.string(),
  language: z.string(),
  taxMode: z.string(),
  priceBasis: z.enum(['NET', 'GROSS']),
  billToAddressId: z.string().nullable(),
  shipToAddressId: z.string().nullable(),
  validUntil: z.string().nullable(),
  firmOffer: z.boolean(),
  promiseDate: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  /** B-W2a-19/49: the library's terms (FIN-075), the price list version the quote keeps (SAL-165), the customer's minimum order (price grain). */
  paymentTermsId: z.string().nullable().optional(),
  priceList: z.object({ listId: z.string(), code: z.string(), name: z.string(), versionId: z.string(), revision: z.number() }).nullable().optional(),
  belowMinimum: z.object({ minimum: z.number(), short: z.number() }).nullable().optional(),
  termsText: z.string().nullable(),
  termsVersion: z.string().nullable(),
  depositPct: z.string().nullable(),
  depositKind: z.enum(DEPOSIT_KINDS).nullable(),
  depositAmount: z.number().nullable().optional(),
  noWithdrawal: z.boolean(),
  netAmount: z.number().optional(),
  vatAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  vat: z.array(vatEntrySchema).optional(),
  costAmount: z.number().nullable().optional(),
  costComplete: z.boolean(),
  marginAmount: z.number().nullable().optional(),
  marginPct: z.string().nullable().optional(),
  marginFloorPct: z.string().nullable().optional(),
  marginFloorBreached: z.boolean().optional(),
  changeNote: z.string().nullable(),
  version: z.number(),
  createdAt: instant,
  updatedAt: instant,
})
export type QuoteCurrent = z.infer<typeof currentSchema>

export const issueSchema = z.object({ code: z.string(), severity: z.enum(ISSUE_SEVERITIES), path: z.string(), message: z.string(), lineId: z.string().nullable(), size: z.string().nullable() })
export type QuoteIssue = z.infer<typeof issueSchema>

const approvalRequestSchema = z.object({
  id: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  reasons: z.array(z.enum(APPROVAL_REASONS)),
  requestNote: z.string().nullable(),
  createdById: z.string().nullable(),
  createdAt: instant,
  decidedById: z.string().nullable(),
  decidedAt: instant.nullable(),
  decisionNote: z.string().nullable(),
})

export const quoteSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string(), status: z.string() }),
  contactId: z.string().nullable(),
  contact: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  customerRef: z.string().nullable(),
  status: z.enum(QUOTE_STATUSES),
  currentRevision: z.number(),
  internalNote: z.string().nullable(),
  version: z.number(),
  createdById: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
  current: currentSchema,
  lines: z.array(lineSchema),
  approval: z.object({
    needed: z.boolean(),
    marginFloorPct: z.string().optional(),
    discountLimitPct: z.string(),
    rules: z.array(z.object({ reason: z.enum(APPROVAL_REASONS), known: z.boolean(), broken: z.boolean(), message: z.string(), lines: z.array(z.number()) })),
    requests: z.array(approvalRequestSchema),
  }),
  issues: z.array(issueSchema),
  canAskApproval: z.boolean(),
  sendBlockers: z.array(issueSchema),
})
export type QuoteDetail = z.infer<typeof quoteSchema>
const oneQuote = z.object({ quote: quoteSchema })

export const listRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  customerRef: z.string().nullable(),
  status: z.enum(QUOTE_STATUSES),
  revision: z.number(),
  lineCount: z.number(),
  units: z.number(),
  currency: z.string(),
  netAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  marginPct: z.string().nullable().optional(),
  marginFloorBreached: z.boolean().optional(),
  approval: z.enum(APPROVAL_STATUSES).nullable(),
  validUntil: z.string().nullable(),
  promiseDate: z.string().nullable(),
  createdById: z.string().nullable(),
  updatedAt: instant,
  version: z.number(),
})
export type QuoteListRow = z.infer<typeof listRowSchema>

const personRef = z.object({ id: z.string(), name: z.string().nullable(), you: z.boolean() })
export const approvalRowSchema = z.object({
  id: z.string(),
  quoteId: z.string(),
  number: z.string(),
  companyId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  quoteVersion: z.number(),
  revision: z.number(),
  current: z.boolean(),
  status: z.enum(APPROVAL_STATUSES),
  reasons: z.array(z.enum(APPROVAL_REASONS)),
  requestNote: z.string().nullable(),
  askedBy: personRef.nullable(),
  askedAt: instant,
  decidedBy: personRef.nullable(),
  decidedAt: instant.nullable(),
  decisionNote: z.string().nullable(),
  currency: z.string(),
  netAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  marginPct: z.string().nullable().optional(),
  marginFloorPct: z.string().nullable().optional(),
  validUntil: z.string().nullable(),
  mayDecide: z.boolean(),
  held: z.enum(DECIDE_HELD).nullable(),
})
export type ApprovalRow = z.infer<typeof approvalRowSchema>
const approvalsSchema = z.object({
  approvals: z.array(approvalRowSchema),
  counts: z.object({ waiting: z.number(), mine: z.number(), decided: z.number(), capped: z.boolean() }),
  at: instant,
})
export type ApprovalsAnswer = z.infer<typeof approvalsSchema>

const linkStateSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  state: z.enum(['LIVE', 'REVOKED', 'USED_UP', 'EXPIRED']),
  expiresAt: instant,
  uses: z.number(),
  maxUses: z.number(),
  lastUsedAt: instant.nullable(),
  revokedAt: instant.nullable(),
  createdAt: instant,
})
const depositSchema = z.object({
  id: z.string(),
  kind: z.enum(DEPOSIT_KINDS),
  depositPct: z.string().nullable(),
  currency: z.string(),
  amount: z.number().optional(),
  dueDate: z.string(),
  fiscalDocument: z.enum(['TD02', 'NONE']),
  fiscalRule: z.string(),
  status: z.enum(['OPEN', 'PAID', 'WAIVED', 'CANCELLED']),
  paidAt: instant.nullable(),
  createdAt: instant,
})
export const versionSchema = z.object({
  id: z.string(),
  revision: z.number(),
  documentNumber: z.string(),
  status: z.enum(VERSION_STATUSES),
  currency: z.string(),
  netAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  depositAmount: z.number().nullable().optional(),
  validUntil: z.string().nullable(),
  firmOffer: z.boolean(),
  changeNote: z.string().nullable(),
  createdAt: instant,
  createdById: z.string().nullable(),
  sentAt: instant.nullable(),
  sentById: z.string().nullable(),
  closedAt: instant.nullable(),
  decisionNote: z.string().nullable(),
  documentSha256: z.string().nullable(),
  termsVersion: z.string().nullable(),
  document: z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), sizeBytes: z.number(), status: z.string() }).nullable(),
  links: z.array(linkStateSchema),
  acceptance: z
    .object({
      id: z.string(),
      channel: z.enum(['LINK', 'OFFICE']),
      signerName: z.string(),
      emailCheck: z.enum(['MATCHED', 'NOT_KNOWN', 'NOT_ASKED']).nullable(),
      documentSha256: z.string(),
      documentMatches: z.boolean(),
      termsVersion: z.string().nullable(),
      noWithdrawalAccepted: z.boolean(),
      acceptedAt: instant,
    })
    .nullable(),
  deposit: depositSchema.nullable(),
})
export type QuoteVersionRow = z.infer<typeof versionSchema>
const versionsSchema = z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })).default([]), versions: z.array(versionSchema) })
export type VersionsAnswer = z.infer<typeof versionsSchema>

export const sendCheckSchema = z.object({
  ready: z.boolean(),
  checks: z.array(z.object({ code: z.string(), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string(), message: z.string(), lineId: z.string().nullable(), size: z.string().nullable() })),
  recipient: z.object({ contactId: z.string().nullable(), name: z.string(), email: z.string().nullable() }).nullable(),
  documentNumber: z.string(),
  language: z.enum(['it', 'en']),
  validUntil: z.string().nullable(),
  linkExpiresAt: instant.nullable(),
  subject: z.string().nullable(),
  message: z.string().nullable(),
})
export type SendCheck = z.infer<typeof sendCheckSchema>
const sendSchema = z.object({
  quote: quoteSchema,
  sent: z.object({ versionId: z.string(), revision: z.number(), sentAt: instant, documentFileId: z.string(), documentSha256: z.string(), termsVersion: z.string(), to: z.string(), link: z.object({ id: z.string(), expiresAt: instant }), emailId: z.string() }),
  delivery: z.enum(['sent', 'failed', 'retry', 'settled']).nullable(),
})
export type SendAnswer = z.infer<typeof sendSchema>
const sendLinkSchema = z.object({
  quote: quoteSchema,
  link: z.object({ id: z.string(), expiresAt: instant, to: z.string() }),
  delivery: z.enum(['sent', 'failed', 'retry', 'settled']).nullable(),
})

// ---- parties and styles (pickers) -----------------------------------------------------------------------------------

export const partyRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  status: z.string(),
  country: z.string(),
  taxMode: z.string().nullable(),
  vatNumber: z.string().nullable(),
  city: z.string().nullable(),
  vies: z.object({ state: z.string() }),
})
export type PartyRow = z.infer<typeof partyRowSchema>
export const addressSchema = z.object({
  id: z.string(),
  kinds: z.array(z.string()),
  name: z.string().nullable(),
  line1: z.string(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  isDefaultBillTo: z.boolean(),
  isDefaultShipTo: z.boolean(),
  status: z.string(),
})
export type PartyAddress = z.infer<typeof addressSchema>
export const contactSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), roles: z.array(z.string()), status: z.string() })
export type PartyContact = z.infer<typeof contactSchema>
const partyDetailSchema = partyRowSchema.extend({
  paymentTerms: z.string().nullable(),
  addresses: z.array(addressSchema),
  contacts: z.array(contactSchema),
  taxIdentities: z.array(z.object({ id: z.string(), taxMode: z.string(), vatNumber: z.string().nullable(), fiscalCode: z.string().nullable(), sdiRecipientCode: z.string().nullable(), pec: z.string().nullable(), current: z.boolean() })),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
})
export type PartyDetail = z.infer<typeof partyDetailSchema>

export const styleRowSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  season: z.string().nullable(),
  sizes: z.array(z.string()),
  ppeClass: z.string().nullable(),
  ppeCategory: z.string(),
  mtmAllowed: z.boolean(),
  status: z.string(),
  revisionState: z.enum(['RELEASED', 'DRAFT', 'NONE']),
})
export type StyleRow = z.infer<typeof styleRowSchema>
const styleDetailSchema = styleRowSchema.extend({
  colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), colour: z.object({ hex: z.string().nullable() }).nullable(), status: z.string(), offeredSizes: z.array(z.string()) })),
  matrix: z.object({ sizes: z.array(z.object({ code: z.string(), label: z.string() })) }),
})
export type StyleDetail = z.infer<typeof styleDetailSchema>

// ---- reads ------------------------------------------------------------------------------------------------------------

const enc = encodeURIComponent
const quotePath = (id: string) => `/sales/quotes/${enc(id)}`

export interface ListFilter {
  status?: QuoteStatus
  mine?: boolean
  q?: string
  /** One customer's quotes (New quote › Start from a past quote). */
  partyId?: string
}

export async function listQuotes(api: ApiClient, filter: ListFilter, cursor?: string | null, signal?: AbortSignal): Promise<{ quotes: QuoteListRow[]; nextCursor: string | null }> {
  return api.get('/sales/quotes', {
    query: { status: filter.status, mine: filter.mine ? 'true' : undefined, q: filter.q?.trim() || undefined, partyId: filter.partyId, cursor: cursor ?? undefined, limit: 50 },
    schema: z.object({ quotes: z.array(listRowSchema), nextCursor: z.string().nullable() }),
    signal,
  })
}

export async function getQuote(api: ApiClient, id: string, signal?: AbortSignal): Promise<QuoteDetail> {
  return (await api.get(quotePath(id), { schema: oneQuote, signal })).quote
}

export function listVersions(api: ApiClient, id: string, signal?: AbortSignal): Promise<VersionsAnswer> {
  return api.get(`${quotePath(id)}/versions`, { schema: versionsSchema, signal })
}

export function sendCheck(api: ApiClient, id: string, signal?: AbortSignal): Promise<SendCheck> {
  return api.get(`${quotePath(id)}/send-check`, { schema: sendCheckSchema, signal })
}

export function listApprovals(api: ApiClient, view: 'waiting' | 'mine' | 'decided' | 'all', quoteId?: string, signal?: AbortSignal): Promise<ApprovalsAnswer> {
  return api.get('/sales/quote-approvals', { query: { view, quoteId }, schema: approvalsSchema, signal })
}

export async function nextNumber(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<string | null> {
  return (await api.get('/sales/quote-numbers/next', { query: { companyId }, schema: z.object({ number: z.string().nullable() }), signal })).number
}

/** The PDF of the current version as the customer would get it (inline; this app's `/api` reaches it, cookies only). */
export const previewHref = (id: string, language: 'it' | 'en'): string => `/api${quotePath(id)}/preview?language=${language}`

/** The same PDF's bytes, for the viewer (a 409 says what the document still needs). */
export function previewBytes(api: ApiClient, id: string, language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${quotePath(id)}/preview`, { query: { language }, signal })
}

export async function findCustomers(api: ApiClient, query: string, companyId: string | null, signal?: AbortSignal): Promise<PartyRow[]> {
  const answer = await api.get('/parties', {
    query: { q: query.trim() || undefined, role: 'CUSTOMER', companyId: companyId ?? undefined, limit: 20 },
    schema: z.object({ parties: z.array(partyRowSchema) }),
    signal,
  })
  return answer.parties
}

export async function getParty(api: ApiClient, id: string, signal?: AbortSignal): Promise<PartyDetail> {
  return (await api.get(`/parties/${enc(id)}`, { schema: z.object({ party: partyDetailSchema }), signal })).party
}

export async function findStyles(api: ApiClient, query: string, companyId: string | null, signal?: AbortSignal): Promise<StyleRow[]> {
  const answer = await api.get('/product/styles', {
    query: { q: query.trim() || undefined, companyId: companyId ?? undefined, limit: 20 },
    schema: z.object({ styles: z.array(styleRowSchema) }),
    signal,
  })
  return answer.styles
}

export async function getStyle(api: ApiClient, id: string, signal?: AbortSignal): Promise<StyleDetail> {
  return (await api.get(`/product/styles/${enc(id)}`, { schema: z.object({ style: styleDetailSchema }), signal })).style
}

// ---- writes (each with the quote's version as read) ------------------------------------------------------------------

const write = (api: ApiClient, path: string, body: Record<string, unknown>) => api.post(path, { body, schema: oneQuote, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.quote)

export function createQuote(api: ApiClient, body: { companyId: string; partyId: string; contactId?: string | null; customerRef?: string | null }): Promise<QuoteDetail> {
  return write(api, '/sales/quotes', body)
}

export interface HeaderPatch {
  contactId?: string | null
  customerRef?: string | null
  validUntil?: string | null
  firmOffer?: boolean
  promiseDate?: string | null
  paymentTerms?: string | null
  /** B-W2a-49: terms from the library (their printed name follows); null: none. */
  paymentTermsId?: string | null
  depositPct?: string | null
  depositKind?: DepositKind | null
  billToAddressId?: string | null
  shipToAddressId?: string | null
  language?: 'it' | 'en'
  changeNote?: string | null
  internalNote?: string | null
}

export async function updateQuote(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, patch: HeaderPatch): Promise<QuoteDetail> {
  return (await api.request('PATCH', quotePath(quote.id), { body: { version: quote.version, ...patch }, schema: oneQuote, idempotencyKey: newIdempotencyKey() })).quote
}

export interface SizeEntry {
  size: string
  quantity: number
}

export function addLine(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, line: { styleId: string; colourwayId: string; sizes: SizeEntry[]; unitPrice?: string | null }): Promise<QuoteDetail> {
  return write(api, `${quotePath(quote.id)}/lines`, { version: quote.version, kind: 'SIZE_GRID', ...line })
}

export async function editLine(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, lineId: string, patch: { sizes?: SizeEntry[]; unitPrice?: string | null; description?: string | null; note?: string | null }): Promise<QuoteDetail> {
  return (await api.request('PATCH', `${quotePath(quote.id)}/lines/${enc(lineId)}`, { body: { version: quote.version, ...patch }, schema: oneQuote, idempotencyKey: newIdempotencyKey() })).quote
}

export async function removeLine(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, lineId: string): Promise<QuoteDetail> {
  return (await api.request('DELETE', `${quotePath(quote.id)}/lines/${enc(lineId)}`, { query: { version: quote.version }, schema: oneQuote, idempotencyKey: newIdempotencyKey() })).quote
}

export const recompute = (api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>) => write(api, `${quotePath(quote.id)}/recompute`, { version: quote.version })
export const askApproval = (api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, note: string | null) => write(api, `${quotePath(quote.id)}/approval`, { version: quote.version, note: note?.trim() || null })
export const reopen = (api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, reason: string | null) => write(api, `${quotePath(quote.id)}/reopen`, { version: quote.version, reason: reason?.trim() || null })
export const cancelQuote = (api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, reason: string | null) => write(api, `${quotePath(quote.id)}/cancel`, { version: quote.version, reason: reason?.trim() || null })
export const reviseQuote = (api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, changeNote: string | null) => write(api, `${quotePath(quote.id)}/revise`, { version: quote.version, changeNote: changeNote?.trim() || null })

const decisionSchema = z.object({ quote: quoteSchema })
export async function approveQuote(api: ApiClient, quote: { id: string; version: number }, note: string | null): Promise<QuoteDetail> {
  return (await api.post(`${quotePath(quote.id)}/approval/approve`, { body: { version: quote.version, note: note?.trim() || null }, schema: decisionSchema, idempotencyKey: newIdempotencyKey() })).quote
}
export async function rejectQuote(api: ApiClient, quote: { id: string; version: number }, reason: string): Promise<QuoteDetail> {
  return (await api.post(`${quotePath(quote.id)}/approval/reject`, { body: { version: quote.version, reason: reason.trim() }, schema: decisionSchema, idempotencyKey: newIdempotencyKey() })).quote
}

export function sendQuote(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, body: { cc: string[]; subject: string | null; message: string | null }): Promise<SendAnswer> {
  return api.post(`${quotePath(quote.id)}/send`, {
    body: { version: quote.version, ...(body.cc.length > 0 ? { cc: body.cc } : {}), subject: body.subject?.trim() || null, message: body.message?.trim() || null },
    schema: sendSchema,
    idempotencyKey: newIdempotencyKey(),
  })
}

export function sendNewLink(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>): Promise<z.infer<typeof sendLinkSchema>> {
  return api.post(`${quotePath(quote.id)}/send-link`, { body: { version: quote.version }, schema: sendLinkSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- B-W2a-49: duplicate a quote (B-W2a-30's POST /sales/quotes/:id/duplicate; SAL-155) -----------------------------------

/** What the copy left out, as the API says it (its reason in English: the screens say their own words, quotes/model.ts). */
const droppedSchema = z.object({ seq: z.number(), size: z.string().nullable(), reason: z.string() })
export type DroppedLine = z.infer<typeof droppedSchema>
const copySchema = z.object({ quote: quoteSchema, dropped: z.array(droppedSchema), warnings: z.array(z.string()) })
export type CopyAnswer = z.infer<typeof copySchema>

/** A new draft quote copied from a quote's version (none: its current one), for the same customer or another one. */
export function duplicateQuote(api: ApiClient, quoteId: string, body: { versionId?: string; partyId?: string; contactId?: string | null; customerRef?: string | null }): Promise<CopyAnswer> {
  return api.post(`${quotePath(quoteId)}/duplicate`, { body, schema: copySchema, idempotencyKey: newIdempotencyKey() })
}
