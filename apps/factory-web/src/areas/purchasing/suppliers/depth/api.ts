import { z } from 'zod'
import { BANK_ACCOUNT_STATUSES, BANK_PILLS, BANK_SOURCES } from '@nexus/factory-domain/purchasing/bank/rules'
import { DECISIONS, EVIDENCE_TYPES, QUALIFICATION_STATUSES, STANDINGS } from '@nexus/factory-domain/purchasing/qualification/rules'
import { VAULT_CATEGORIES } from '@nexus/factory-domain/purchasing/qualification/vault'
import { SUPPLIER_KINDS, SUPPLIER_STATUSES } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { CONTACT_RECEIVES } from '@nexus/factory-domain/purchasing/suppliers-depth/routing'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { downloadLink, type Presigned } from '../../../../record-panels/api'

/**
 * Suppliers in depth on screen (B-W2b-334), the calls of B-W2b-311's and B-W2b-315's API (apps/factory-api modules/purchasing/
 * suppliers-depth, bank, qualification; B-W2b-189's office review in portal-profile) with their answers checked (zod; unknown
 * fields dropped): the supplier's kinds, status, origin, closures and what each contact receives; its document vault, the
 * office review of what it sent, its qualifications; its bank details with the call-back and the second check; the list's
 * documents summary; and, for Quality & rating, its receipts and claims (W1/W2a reads filtered to the supplier). Every
 * write names the version it read and carries an Idempotency-Key. The API's English sentences (`words`, `sentence`,
 * `pillWords`, `heldWhy`, `emptyWords`, `nextStep`, `gateSentences`, `unlocks`) are read only to know WHETHER: the screen
 * says WHY in its own words from the codes and figures (./model.ts). No IBAN in any answer but the reveal's.
 */

const enc = encodeURIComponent
const supplier = (partyId: string) => `/purchasing/suppliers/${enc(partyId)}`
const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {})

export const KINDS = SUPPLIER_KINDS
export type SupplierKind = (typeof SUPPLIER_KINDS)[number]
export const STATUSES = SUPPLIER_STATUSES
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]
export const RECEIVES = CONTACT_RECEIVES
export type Receives = (typeof CONTACT_RECEIVES)[number]
export const TANNAGE_CODES = TANNAGES
export type TannageCode = (typeof TANNAGES)[number]
export const CATEGORIES = VAULT_CATEGORIES
export type VaultCategory = (typeof VAULT_CATEGORIES)[number]
export const PILLS = BANK_PILLS
export type BankPill = (typeof BANK_PILLS)[number]
export const STANDING_CODES = STANDINGS
export type StandingCode = (typeof STANDINGS)[number]
export const DECISION_CODES = DECISIONS
export type Decision = (typeof DECISIONS)[number]

// ---- the profile: kinds, status, origin, closures, contacts (B-W2b-311) ----------------------------------------------------

const span = z.object({ from: z.string(), to: z.string(), kind: z.string(), name: z.string(), days: z.number() })

const profileContact = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.string()),
  receives: z.array(z.enum(CONTACT_RECEIVES)),
  language: z.string().nullable(),
  status: z.string(),
  version: z.number(),
})
export type ProfileContact = z.infer<typeof profileContact>

const profileSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  legalName: z.string(),
  roles: z.array(z.string()),
  partyStatus: z.string(),
  kinds: z.array(z.enum(SUPPLIER_KINDS)),
  standing: z.object({
    status: z.enum(SUPPLIER_STATUSES),
    source: z.enum(['PARTY', 'SUPPLIER']),
    supplierStatus: z.enum(SUPPLIER_STATUSES).nullable(),
    reason: z.string().nullable(),
    changedAt: z.string().nullable(),
    changedBy: z.string().nullable(),
  }),
  /** Read only for WHETHER a new purchase order may go (the words are the API's English). */
  newOrderProblem: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  origin: z.object({ country: z.string().nullable(), region: z.string().nullable(), note: z.string().nullable(), hideCountries: z.array(z.string()), tannages: z.array(z.enum(TANNAGES)) }),
  closures: z.object({
    calendarId: z.string().nullable(),
    weeklyDaysOff: z.array(z.number()),
    ahead: z.array(span),
    orderedToday: z.object({ orderDate: z.string(), leadTimeDays: z.number(), arrives: z.string(), skipped: z.array(span), capped: z.boolean() }).nullable(),
  }),
  contacts: z.array(profileContact),
  routing: z.array(z.object({ kind: z.enum(CONTACT_RECEIVES), by: z.enum(['RECEIVES', 'ROLE', 'NONE']), contactIds: z.array(z.string()) })),
  version: z.number(),
})
export type SupplierProfile = z.infer<typeof profileSchema>
const profileAnswer = z.object({ supplier: profileSchema })

export const readProfile = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get(`${supplier(partyId)}/profile`, { schema: profileAnswer, ...signalOf(signal) }).then((answer) => answer.supplier)

export interface ProfileBody {
  version: number
  kinds?: SupplierKind[]
  leadTimeDays?: number | null
  originCountry?: string | null
  originRegion?: string | null
  originNote?: string | null
  hideOriginCountries?: string[]
  tannages?: TannageCode[]
}

export const saveProfile = (api: ApiClient, partyId: string, body: ProfileBody, idempotencyKey: string) =>
  api.request('PATCH', `${supplier(partyId)}/profile`, { body, idempotencyKey, schema: profileAnswer }).then((answer) => answer.supplier)

export const setStatus = (api: ApiClient, partyId: string, body: { version: number; status: SupplierStatus; reason: string | null }, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/status`, { body, idempotencyKey, schema: profileAnswer }).then((answer) => answer.supplier)

const reachSchema = z.object({ reach: z.object({ status: z.enum(SUPPLIER_STATUSES), draftsHeld: z.number(), openUnchanged: z.number() }) })
export type StatusReach = z.infer<typeof reachSchema>['reach']
export const statusReach = (api: ApiClient, partyId: string, status: SupplierStatus) => api.get(`${supplier(partyId)}/status-reach`, { query: { status }, schema: reachSchema }).then((answer) => answer.reach)

export const setReceives = (api: ApiClient, partyId: string, contactId: string, body: { version: number; receives: Receives[] }, idempotencyKey: string) =>
  api.request('PUT', `${supplier(partyId)}/contacts/${enc(contactId)}/receives`, { body, idempotencyKey, schema: profileAnswer }).then((answer) => answer.supplier)

// ---- the vault and the office review (B-W2b-315, B-W2b-189) ---------------------------------------------------------------

const askState = z.enum(['MET', 'EXPIRING', 'EXPIRED', 'MISSING'])
export type AskState = z.infer<typeof askState>

const vaultSchema = z.object({
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), kinds: z.array(z.enum(SUPPLIER_KINDS)), roles: z.array(z.string()) }),
  asked: z.array(z.object({ category: z.enum(VAULT_CATEGORIES), required: z.boolean(), codes: z.array(z.string()), laws: z.array(z.string()), state: askState, fileId: z.string().nullable(), expiresOn: z.string().nullable(), waiting: z.boolean() })),
  materials: z.array(
    z.object({
      itemId: z.string(),
      code: z.string(),
      name: z.string(),
      kind: z.string(),
      needs: z.enum(['CR_VI_TEST_REPORT', 'PPE_CERTIFICATE']),
      law: z.string(),
      state: askState,
      fileId: z.string().nullable(),
      certificate: z.object({ id: z.string(), number: z.string(), standard: z.string() }).nullable(),
      expiresOn: z.string().nullable(),
      checkedAtSend: z.boolean(),
      heldAtSend: z.boolean(),
    }),
  ),
  documents: z.array(
    z.object({
      fileId: z.string(),
      category: z.enum(VAULT_CATEGORIES),
      /** B-W2b-382 (B-W2b-377): a SUPPLIER_DOCUMENT_TYPE code, null when nobody said what it is. */
      documentTypeCode: z.string().nullable().optional(),
      name: z.string(),
      issuer: z.string().nullable(),
      number: z.string().nullable(),
      issuedOn: z.string().nullable(),
      expiresOn: z.string().nullable(),
      daysLeft: z.number().nullable(),
      state: z.enum(['VALID', 'EXPIRING', 'EXPIRED']),
      source: z.enum(['PORTAL', 'QUESTIONNAIRE', 'OFFICE']),
      uploadId: z.string().nullable(),
      articleCodes: z.array(z.string()),
      addedAt: z.string(),
      /** B-W2b-383 (B-W2b-382's gap): the file's row version, the one "say what it is" sends (no GET /files/:id first). */
      version: z.number(),
    }),
  ),
  nextExpiry: z.string().nullable(),
  review: z.object({
    uploads: z.array(
      z.object({
        uploadId: z.string(),
        fileId: z.string(),
        companyId: z.string(),
        record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
        category: z.string(),
        issuer: z.string().nullable(),
        number: z.string().nullable(),
        issuedOn: z.string().nullable(),
        expiresOn: z.string().nullable(),
        articleCodes: z.array(z.string()),
        lotCodes: z.array(z.string()),
        note: z.string().nullable(),
        replacesFileId: z.string().nullable(),
        uploadedByName: z.string(),
        receivedAt: z.string().nullable(),
        version: z.number(),
      }),
    ),
    changes: z.array(z.object({ requestId: z.string(), companyId: z.string(), requestedByName: z.string(), sentAt: z.string() })),
  }),
  questionnaire: z.array(z.object({ responseId: z.string(), companyId: z.string(), decision: z.string().nullable(), submittedAt: z.string(), reviewedAt: z.string().nullable() })),
  may: z.object({ review: z.boolean(), decideChanges: z.boolean(), upload: z.boolean(), qualify: z.boolean() }),
})
export type Vault = z.infer<typeof vaultSchema>
export type VaultDocument = Vault['documents'][number]
export type VaultUpload = Vault['review']['uploads'][number]

export const readVault = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get(`${supplier(partyId)}/documents`, { schema: vaultSchema, ...signalOf(signal) })

/** One change of a profile change request, as the API plans it (its English sentence is not drawn). */
const changeSchema = z.object({
  target: z.enum(['ADDRESS', 'CONTACT', 'COMPANY']),
  op: z.enum(['ADD', 'CHANGE', 'REMOVE']),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changed: z.array(z.string()),
})
export type PlannedChange = z.infer<typeof changeSchema>
const changeRequestSchema = z.object({ requestId: z.string(), state: z.string(), sentAt: z.string(), sentBy: z.string().nullable(), note: z.string().nullable(), changes: z.array(changeSchema) })
export type ChangeRequest = z.infer<typeof changeRequestSchema>
const changesSchema = z.object({ requests: z.array(changeRequestSchema), counts: z.object({ open: z.number() }) })

export const readChanges = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get('/purchasing/supplier-changes', { query: { partyId, state: 'OPEN' }, schema: changesSchema, ...signalOf(signal) })

export const acceptUpload = (api: ApiClient, fileId: string, body: { category: VaultCategory; expiresOn: string | null; replacesFileId: string | null; version: number }, idempotencyKey: string) =>
  api.post(`/purchasing/supplier-documents/${enc(fileId)}/accept`, { body, idempotencyKey, schema: z.object({ fileId: z.string(), documentFileId: z.string() }) })

export const refuseUpload = (api: ApiClient, fileId: string, body: { reason: string; version: number }, idempotencyKey: string) =>
  api.post(`/purchasing/supplier-documents/${enc(fileId)}/refuse`, { body, idempotencyKey, schema: z.object({ fileId: z.string(), taskId: z.string() }) })

export const approveChange = (api: ApiClient, requestId: string, idempotencyKey: string) =>
  api.post(`/purchasing/supplier-changes/${enc(requestId)}/approve`, { body: {}, idempotencyKey, schema: z.object({ request: z.object({ id: z.string(), status: z.string() }) }) })

export const refuseChange = (api: ApiClient, requestId: string, reason: string, idempotencyKey: string) =>
  api.post(`/purchasing/supplier-changes/${enc(requestId)}/refuse`, { body: { reason }, idempotencyKey, schema: z.object({ request: z.object({ id: z.string(), status: z.string() }) }) })

/** A document's file: a presigned GET that lives a minute (files.read). */
export const fileLink = (api: ApiClient, fileId: string): Promise<Presigned> => downloadLink(api, fileId).then((answer) => answer.download)

// ---- qualifications (B-W2b-315, SCM-027) ----------------------------------------------------------------------------------

const qualificationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  status: z.enum(QUALIFICATION_STATUSES),
  scope: z.object({ workCentreKinds: z.array(z.string()), materialKinds: z.array(z.string()), operations: z.array(z.object({ id: z.string(), code: z.string().nullable(), name: z.string().nullable() })) }),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  evidence: z.array(z.object({ recordType: z.enum(EVIDENCE_TYPES), recordId: z.string(), label: z.string(), documents: z.array(z.object({ fileId: z.string(), expiresOn: z.string().nullable(), expired: z.boolean() })) })),
  decided: z.object({ at: z.string(), by: z.object({ id: z.string(), name: z.string().nullable() }).nullable() }).nullable(),
  conditions: z.string().nullable(),
  refuseReason: z.string().nullable(),
  suspended: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  withdrawn: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  standing: z.object({ standing: z.enum(STANDINGS) }),
  version: z.number(),
  may: z.object({ change: z.boolean(), decide: z.boolean(), suspend: z.boolean(), lift: z.boolean(), withdraw: z.boolean() }),
})
export type Qualification = z.infer<typeof qualificationSchema>

const qualificationsSchema = z.object({
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), roles: z.array(z.string()), kinds: z.array(z.string()) }),
  qualifications: z.array(qualificationSchema),
  work: z.array(z.object({ companyId: z.string(), workCentreKind: z.string(), qualified: z.boolean(), standing: z.enum(STANDINGS), qualificationId: z.string().nullable() })),
  may: z.object({ create: z.boolean() }),
})
export type Qualifications = z.infer<typeof qualificationsSchema>

export const readQualifications = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get(`${supplier(partyId)}/qualifications`, { schema: qualificationsSchema, ...signalOf(signal) })

export interface QualificationScope {
  workCentreKinds?: string[]
  materialKinds?: string[]
  validFrom?: string | null
  validUntil?: string | null
}

export const askQualification = (api: ApiClient, partyId: string, body: QualificationScope & { companyId: string }, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/qualifications`, { body, idempotencyKey, schema: qualificationsSchema })

export type QualificationMove = 'decide' | 'suspend' | 'lift' | 'withdraw'
export interface MoveBody {
  version: number
  decision?: Decision
  conditions?: string | null
  refuseReason?: string | null
  validFrom?: string | null
  validUntil?: string | null
  reason?: string
}

export const moveQualification = (api: ApiClient, partyId: string, qualificationId: string, move: QualificationMove, body: MoveBody, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/qualifications/${enc(qualificationId)}/${move}`, { body, idempotencyKey, schema: qualificationsSchema })

// ---- bank details (B-W2b-315, SCM-007) ------------------------------------------------------------------------------------

const person = z.object({ id: z.string(), name: z.string().nullable() }).nullable()
const onFile = z.object({ kind: z.enum(['CONTACT', 'ADDRESS']), id: z.string(), label: z.string(), phone: z.string().nullable() })

const accountSchema = z.object({
  id: z.string(),
  masked: z.string(),
  ibanCountry: z.string(),
  ibanLast4: z.string(),
  bic: z.string().nullable(),
  bankName: z.string().nullable(),
  holder: z.string(),
  currency: z.string(),
  status: z.enum(BANK_ACCOUNT_STATUSES),
  pill: z.enum(BANK_PILLS),
  source: z.enum(BANK_SOURCES),
  replacesId: z.string().nullable(),
  proposedAt: z.string(),
  proposedBy: person,
  callBack: z.object({ at: z.string(), by: person, kind: z.enum(['CONTACT', 'ADDRESS']), onFileId: z.string(), label: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  verified: z.object({ at: z.string(), by: person }).nullable(),
  activatedAt: z.string().nullable(),
  refused: z.object({ at: z.string(), by: person, reason: z.string().nullable() }).nullable(),
  retired: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  files: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  approval: z.object({ taskId: z.string(), status: z.string(), requestedAt: z.string(), dueAt: z.string().nullable() }).nullable(),
  callBackCandidates: z.object({ usable: z.array(onFile), held: z.array(onFile.extend({ hold: z.string() })) }).nullable(),
  may: z.object({ callBack: z.boolean(), verify: z.boolean(), refuse: z.boolean(), retire: z.boolean(), reveal: z.boolean() }),
  /** Read only for WHETHER the step is held for this person (the API's English is not drawn). */
  heldWhy: z.object({ callBack: z.string().nullable(), verify: z.string().nullable() }),
  version: z.number(),
})
export type BankAccount = z.infer<typeof accountSchema>
export type OnFile = z.infer<typeof onFile>

const bankSchema = z.object({
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable() }),
  accounts: z.array(accountSchema),
  payable: z.array(z.object({ currency: z.string(), accountId: z.string() })),
  may: z.object({ propose: z.boolean() }),
})
export type BankView = z.infer<typeof bankSchema>

export const readBank = (api: ApiClient, partyId: string, signal?: AbortSignal) => api.get(`${supplier(partyId)}/bank`, { schema: bankSchema, ...signalOf(signal) })

export interface ProposeBody {
  iban: string
  holder: string
  bankName: string | null
  bic: string | null
  currency: string
}

export const proposeBank = (api: ApiClient, partyId: string, body: ProposeBody, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank`, { body, idempotencyKey, schema: bankSchema.extend({ accountId: z.string() }) })

export const callBack = (api: ApiClient, partyId: string, accountId: string, body: { version: number; contactId?: string; addressId?: string; phone: string }, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank/${enc(accountId)}/call-back`, { body, idempotencyKey, schema: bankSchema })

const approvalAsked = z.object({ taskId: z.string(), dueAt: z.string().nullable() }).nullable()
export const verifyBank = (api: ApiClient, partyId: string, accountId: string, version: number, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank/${enc(accountId)}/verify`, { body: { version }, idempotencyKey, schema: bankSchema.extend({ approval: approvalAsked.optional() }) })

export const refuseBank = (api: ApiClient, partyId: string, accountId: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank/${enc(accountId)}/refuse`, { body, idempotencyKey, schema: bankSchema })

export const retireBank = (api: ApiClient, partyId: string, accountId: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank/${enc(accountId)}/retire`, { body, idempotencyKey, schema: bankSchema })

/** The only answer with the whole IBAN (audited): shown once, never kept beyond the dialog. */
export const revealBank = (api: ApiClient, partyId: string, accountId: string, idempotencyKey: string) =>
  api.post(`${supplier(partyId)}/bank/${enc(accountId)}/reveal`, { body: {}, idempotencyKey, schema: z.object({ accountId: z.string(), grouped: z.string() }) })

// ---- Quality & rating: the supplier's receipts and claims ----------------------------------------------------------------

const receiptRow = z.object({
  id: z.string(),
  number: z.string(),
  status: z.string(),
  purchaseOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  supplierDdtNumber: z.string().nullable(),
  receivedAt: z.string(),
  postedAt: z.string().nullable(),
  lines: z.number(),
  lots: z.number(),
  lotsReleased: z.number(),
  discrepancies: z.object({ count: z.number(), open: z.number() }),
})
export type ReceiptRow = z.infer<typeof receiptRow>
export const readReceipts = (api: ApiClient, partyId: string, signal?: AbortSignal) =>
  api.get('/inventory/receipts', { query: { supplierId: partyId, limit: 50 }, schema: z.object({ receipts: z.array(receiptRow), nextCursor: z.string().nullable() }), ...signalOf(signal) })

const claimRow = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.string(),
  status: z.string(),
  lots: z.array(z.object({ id: z.string(), code: z.string() })),
  materials: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  quantity: z.object({ quantity: z.string(), uom: z.string() }).nullable(),
  lines: z.number(),
  returned: z.number(),
  ageDays: z.number(),
})
export type ClaimRow = z.infer<typeof claimRow>
export const readClaims = (api: ApiClient, partyId: string, signal?: AbortSignal) =>
  api.get('/purchasing/claims', { query: { partyId, open: 'false', limit: 50 }, schema: z.object({ items: z.array(claimRow), nextCursor: z.string().nullable() }), ...signalOf(signal) })

// ---- the list: the documents column and tile, Request documents ---------------------------------------------------------

const summarySchema = z.object({
  suppliers: z.array(z.object({ partyId: z.string(), code: z.string(), valid: z.number(), expiring: z.number(), expired: z.number(), missing: z.number() })),
  expiringIn30Days: z.number(),
})
export type DocumentsSummary = z.infer<typeof summarySchema>
export type SupplierDocuments = DocumentsSummary['suppliers'][number]
export const readDocumentsSummary = (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  api.get('/purchasing/suppliers/documents-summary', { query: companyId ? { companyId } : {}, schema: summarySchema, ...signalOf(signal) })

const supplierRow = z.object({ id: z.string(), code: z.string(), name: z.string(), kinds: z.array(z.enum(SUPPLIER_KINDS)), status: z.enum(SUPPLIER_STATUSES), country: z.string() })
export type SupplierRow = z.infer<typeof supplierRow>
export const readSuppliers = (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  api.get('/purchasing/suppliers', { query: { limit: 200, ...(companyId ? { companyId } : {}) }, schema: z.object({ suppliers: z.array(supplierRow), nextCursor: z.string().nullable() }), ...signalOf(signal) })

/** "Request documents": an UPLOAD_DOCUMENT request on the supplier itself (its portal's Home; `made` false: one waits already). */
export const askForDocuments = (api: ApiClient, partyId: string, body: { dueAt: string | null; companyId?: string }, idempotencyKey: string) =>
  api.post(`/partners/${enc(partyId)}/tasks`, { body: { kind: 'UPLOAD_DOCUMENT', recordType: 'Party', recordId: partyId, ...body }, idempotencyKey, schema: z.object({ made: z.boolean() }) })
