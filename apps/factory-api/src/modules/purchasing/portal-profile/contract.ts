import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ADDRESS_KINDS } from '@nexus/factory-domain/parties/addresses'
import { CONTACT_ROLES } from '@nexus/factory-domain/parties/contacts'
import { DOCUMENT_LIMITS, SUPPLIER_DOCUMENT_CATEGORIES, SUPPLIER_DOCUMENT_RECORD_TYPES, SUPPLIER_DOCUMENT_STATES } from '@nexus/factory-domain/purchasing/portal-profile/documents'
import { MAX_PROFILE_CHANGES, PROFILE_NOTE_MAX, PROFILE_REQUEST_STATES } from '@nexus/factory-domain/purchasing/portal-profile/profile'

/**
 * A supplier's documents and profile in the portal, and the office's check of them (B-W2b-189; SCM-096, SCM-097). NOTHING
 * here is money. Dates are calendar days, times UTC instants; the API's sentences are English (the portal screens say their
 * own, B-W2b-193); states and kinds are codes.
 */

const version = z.number().int().min(1)
const live = output({ events: z.array(z.string()) })
const recordRef = output({ type: z.string(), id: id(), label: z.string() })
const category = z.enum(SUPPLIER_DOCUMENT_CATEGORIES)
const docState = z.enum(SUPPLIER_DOCUMENT_STATES)
const presigned = output({ method: z.enum(['PUT', 'GET']), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() })
const fileParams = input({ fileId: id() })
const requestParams = input({ requestId: id() })
const short = (max: number) => z.string().max(max)
const optional = (max: number) => z.string().max(max).nullable().optional()

// ---- the supplier's documents --------------------------------------------------------------------------------------------

const askedRow = output({
  key: z.string(),
  source: z.enum(['RULE', 'EXPIRY', 'ASKED', 'REFUSED']),
  category: z.string().nullable(),
  record: recordRef,
  forRecords: z.array(recordRef),
  dueOn: businessDate().nullable(),
  level: z.enum(['BLOCK', 'WARN']).nullable(),
  state: z.enum(['MISSING', 'EXPIRED']).nullable(),
  reason: z.string(),
  taskId: id().nullable(),
  askedBy: z.string().nullable(),
  /** A document of this kind for it waits for our check already. */
  waiting: z.boolean(),
})

const documentRow = output({
  fileId: id(),
  uploadFileId: id().nullable(),
  state: docState,
  category: z.string().nullable(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  record: recordRef,
  issuer: z.string().nullable(),
  number: z.string().nullable(),
  issuedOn: businessDate().nullable(),
  expiresOn: businessDate().nullable(),
  daysLeft: z.number().int().nullable(),
  articles: z.array(z.string()),
  lots: z.array(z.string()),
  sentAt: instant().nullable(),
  decidedAt: instant().nullable(),
  reason: z.string().nullable(),
  canReplace: z.boolean(),
})

export const supplierDocumentsContract = defineContract({
  response: {
    200: output({
      today: businessDate(),
      mayUpload: z.boolean(),
      categories: z.array(category),
      requested: z.array(askedRow),
      documents: z.array(documentRow),
      counts: output({ requested: z.number().int(), waiting: z.number().int(), expiring: z.number().int(), refused: z.number().int() }),
      live,
    }),
  },
})

export const announceDocumentContract = defineContract({
  body: input({
    category: z.string().max(40),
    issuer: optional(DOCUMENT_LIMITS.issuer),
    number: optional(DOCUMENT_LIMITS.number),
    issuedOn: optional(10),
    expiresOn: optional(10),
    articles: z.array(short(200)).max(50).optional(),
    lots: z.array(short(200)).max(50).optional(),
    note: optional(DOCUMENT_LIMITS.note),
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().max(64),
    taskId: id().nullable().optional(),
    recordType: z.enum(SUPPLIER_DOCUMENT_RECORD_TYPES).nullable().optional(),
    recordId: id().nullable().optional(),
    replacesFileId: id().nullable().optional(),
  }),
  response: { 201: output({ file: output({ id: id(), status: z.string() }), record: recordRef, upload: presigned }) },
})

export const completeDocumentContract = defineContract({
  params: fileParams,
  response: { 200: output({ file: output({ id: id(), status: z.string() }), state: docState }) },
})

// ---- the office's check of documents --------------------------------------------------------------------------------------

export const listSupplierDocumentsContract = defineContract({
  querystring: input({ partyId: id().optional(), state: z.enum(['WAITING', 'ALL']).optional() }),
  response: {
    200: output({
      rows: z.array(
        output({
          fileId: id(),
          party: output({ id: id(), code: z.string(), name: z.string() }),
          companyId: id().nullable(),
          record: recordRef,
          category: z.string(),
          name: z.string(),
          contentType: z.string(),
          sizeBytes: z.number().int(),
          issuer: z.string().nullable(),
          number: z.string().nullable(),
          issuedOn: businessDate().nullable(),
          expiresOn: businessDate().nullable(),
          articles: z.array(z.string()),
          lots: z.array(z.string()),
          note: z.string().nullable(),
          state: docState,
          sentAt: instant().nullable(),
          sentBy: z.string().nullable(),
          replaces: output({ fileId: id(), name: z.string(), expiresOn: businessDate().nullable(), current: z.boolean() }).nullable(),
          decision: output({
            kind: z.enum(['ACCEPTED', 'REFUSED']),
            at: instant(),
            byName: z.string().nullable(),
            reason: z.string().nullable(),
            documentFileId: id().nullable(),
            category: z.string().nullable(),
            expiresOn: businessDate().nullable(),
          }).nullable(),
          version: z.number().int(),
          mayDecide: z.boolean(),
        }),
      ),
      counts: output({ waiting: z.number().int() }),
    }),
  },
})

export const acceptDocumentContract = defineContract({
  params: fileParams,
  body: input({ category: z.string().max(40), expiresOn: z.string().max(10).nullable(), replacesFileId: id().nullable().optional(), version }),
  response: { 200: output({ fileId: id(), documentFileId: id(), state: z.literal('ACCEPTED'), category: z.string(), expiresOn: businessDate().nullable() }) },
})

export const refuseDocumentContract = defineContract({
  params: fileParams,
  body: input({ reason: z.string().max(DOCUMENT_LIMITS.reason + 100), version }),
  response: { 200: output({ fileId: id(), state: z.literal('REJECTED'), reason: z.string(), taskId: id() }) },
})

// ---- the supplier's profile -----------------------------------------------------------------------------------------------

const addressInput = {
  name: optional(80),
  line1: short(60),
  line2: optional(60),
  postalCode: short(12),
  city: short(60),
  province: optional(40),
  country: short(2),
  contactName: optional(100),
  phone: optional(30),
  deliveryNotes: optional(500),
}
const contactInput = {
  name: short(120),
  email: optional(254),
  phone: optional(30),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).optional(),
  language: optional(8),
}
const addressChange = z.discriminatedUnion('op', [
  input({ op: z.literal('ADD'), address: input({ ...addressInput, kinds: z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length) }) }),
  input({ op: z.literal('CHANGE'), addressId: id(), version, address: input(addressInput).partial() }),
  input({ op: z.literal('REMOVE'), addressId: id(), version }),
])
const contactChange = z.discriminatedUnion('op', [
  input({ op: z.literal('ADD'), contact: input(contactInput) }),
  input({ op: z.literal('CHANGE'), contactId: id(), version, contact: input(contactInput).partial() }),
  input({ op: z.literal('REMOVE'), contactId: id(), version }),
])

const addressFields = {
  kinds: z.array(z.string()),
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  deliveryNotes: z.string().nullable(),
}
const contactFields = { name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), roles: z.array(z.string()), language: z.string().nullable() }
const plannedChange = output({
  /** COMPANY (W2b wave 23): the party's own website. */
  target: z.enum(['ADDRESS', 'CONTACT', 'COMPANY']),
  op: z.enum(['ADD', 'CHANGE', 'REMOVE']),
  id: id().nullable(),
  version: z.number().int().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changed: z.array(z.string()),
  sentence: z.string(),
})
const requestView = output({
  requestId: id(),
  state: z.enum(PROFILE_REQUEST_STATES),
  sentAt: instant(),
  sentBy: z.string().nullable(),
  summary: z.string(),
  note: z.string().nullable(),
  changes: z.array(plannedChange),
  decidedAt: instant().nullable(),
  decidedBy: z.string().nullable(),
  reason: z.string().nullable(),
})

export const supplierProfileContract = defineContract({
  response: {
    200: output({
      company: output({
        code: z.string(),
        legalName: z.string(),
        tradeName: z.string().nullable(),
        country: z.string(),
        vatNumber: z.string().nullable(),
        fiscalCode: z.string().nullable(),
        /** W2b wave 23: the supplier's website, and whether a change of it waits for our check. */
        website: z.string().nullable(),
        waiting: z.boolean(),
      }),
      addresses: z.array(output({ id: id(), version: z.number().int(), ...addressFields, isDefaultBillTo: z.boolean(), isDefaultShipTo: z.boolean(), waiting: z.boolean() })),
      contacts: z.array(output({ id: id(), version: z.number().int(), ...contactFields, waiting: z.boolean() })),
      pending: z.array(requestView),
      decided: z.array(requestView),
      mayChange: z.boolean(),
      limits: output({ changes: z.number().int(), addressKinds: z.array(z.string()), contactRoles: z.array(z.string()) }),
      live,
    }),
  },
})

export const requestProfileChangeContract = defineContract({
  body: input({
    addresses: z.array(addressChange).max(MAX_PROFILE_CHANGES).optional(),
    contacts: z.array(contactChange).max(MAX_PROFILE_CHANGES).optional(),
    /** W2b wave 23: the company's website (null or blank: none); checked against the one the supplier saw at approval. */
    company: input({ website: z.string().max(300).nullable() }).optional(),
    note: optional(PROFILE_NOTE_MAX),
  }),
  response: { 201: output({ request: requestView }) },
})

export const withdrawProfileChangeContract = defineContract({ params: requestParams, response: { 200: output({ request: requestView }) } })

// ---- the office's check of profile changes ---------------------------------------------------------------------------------

export const listSupplierChangesContract = defineContract({
  querystring: input({ partyId: id().optional(), state: z.enum(['OPEN', 'ALL']).optional() }),
  response: {
    200: output({
      requests: z.array(requestView.extend({ party: output({ id: id(), code: z.string(), name: z.string() }), companyId: id().nullable() })),
      counts: output({ open: z.number().int() }),
    }),
  },
})

export const approveSupplierChangeContract = defineContract({ params: requestParams, response: { 200: output({ request: requestView }) } })

export const refuseSupplierChangeContract = defineContract({ params: requestParams, body: input({ reason: z.string().max(600) }), response: { 200: output({ request: requestView }) } })
