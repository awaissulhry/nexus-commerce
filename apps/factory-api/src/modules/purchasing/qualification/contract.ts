import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'
import { OVERRIDE_LIMITS, REQUIREMENT_KINDS, REQUIREMENT_STATES } from '@nexus/factory-domain/purchasing/qualification/gate'
import { DECISIONS, EVIDENCE_TYPES, QUALIFICATION_LIMITS, QUALIFICATION_STATUSES, STANDINGS } from '@nexus/factory-domain/purchasing/qualification/rules'
import { VAULT_CATEGORIES } from '@nexus/factory-domain/purchasing/qualification/vault'
import { SUPPLIER_KINDS } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'

/**
 * The vault, the qualifications and the compliance gate on a PO (B-W2b-315; SCM-020, SCM-022, SCM-027). Office only. Each
 * write of a qualification names its `version`; an override request names the order's `version` it read (the order's own
 * version does not move). No money here.
 */

const version = z.number().int().min(1)
const partyParams = input({ partyId: id() })
const qualificationParams = input({ partyId: id(), qualificationId: id() })
const orderParams = input({ purchaseOrderId: id() })
const words = z.string().max(QUALIFICATION_LIMITS.words)

// ---- the vault -----------------------------------------------------------------------------------------------------

const documentState = z.enum(['VALID', 'EXPIRING', 'EXPIRED'])
const askState = z.enum(['MET', 'EXPIRING', 'EXPIRED', 'MISSING'])

const vaultView = output({
  supplier: output({ id: id(), code: z.string(), name: z.string(), kinds: z.array(z.enum(SUPPLIER_KINDS)), roles: z.array(z.string()) }),
  /** What we ask of it by kind (one row per category), with its state and what it unlocks. */
  asked: z.array(output({ category: z.enum(VAULT_CATEGORIES), required: z.boolean(), codes: z.array(z.string()), words: z.string(), laws: z.array(z.string()), state: askState, fileId: id().nullable(), expiresOn: businessDate().nullable(), waiting: z.boolean(), unlocks: z.string().nullable() })),
  /** What the materials it sells us need (a leather's chromium VI test report, a protector's certificate), and whether a PO of it is held at Send. */
  materials: z.array(output({ itemId: id(), code: z.string(), name: z.string(), kind: z.string(), needs: z.enum(['CR_VI_TEST_REPORT', 'PPE_CERTIFICATE']), law: z.string(), state: askState, fileId: id().nullable(), certificate: output({ id: id(), number: z.string(), standard: z.string() }).nullable(), expiresOn: businessDate().nullable(), checkedAtSend: z.boolean(), heldAtSend: z.boolean() })),
  documents: z.array(output({ fileId: id(), category: z.enum(VAULT_CATEGORIES), /** B-W2b-377: a SUPPLIER_DOCUMENT_TYPE code, null when nobody said. */ documentTypeCode: z.string().nullable(), name: z.string(), issuer: z.string().nullable(), number: z.string().nullable(), issuedOn: z.string().nullable(), expiresOn: businessDate().nullable(), daysLeft: z.number().int().nullable(), state: documentState, source: z.enum(['PORTAL', 'QUESTIONNAIRE', 'OFFICE']), uploadId: id().nullable(), articleCodes: z.array(z.string()), addedAt: instant() })),
  /** "POs for A12 and A14 need a valid chromium VI test report in force to be sent." */
  gateSentences: z.array(z.string()),
  nextStep: z.string(),
  nextExpiry: businessDate().nullable(),
  emptyWords: z.string().nullable(),
  review: output({
    uploads: z.array(output({ uploadId: id(), fileId: id(), companyId: id(), record: output({ type: z.string(), id: id(), label: z.string() }), category: z.string(), issuer: z.string().nullable(), number: z.string().nullable(), issuedOn: businessDate().nullable(), expiresOn: businessDate().nullable(), articleCodes: z.array(z.string()), lotCodes: z.array(z.string()), note: z.string().nullable(), replacesFileId: id().nullable(), uploadedByName: z.string(), receivedAt: instant().nullable(), version: z.number().int() })),
    changes: z.array(output({ requestId: id(), companyId: id(), summary: z.string(), requestedByName: z.string(), sentAt: instant() })),
    routes: output({ accept: z.string(), refuse: z.string(), approveChange: z.string(), refuseChange: z.string() }),
  }),
  questionnaire: z.array(output({ responseId: id(), companyId: id(), decision: z.string().nullable(), submittedAt: instant(), reviewedAt: instant().nullable() })),
  may: output({ review: z.boolean(), decideChanges: z.boolean(), upload: z.boolean(), qualify: z.boolean() }),
})

export const vaultContract = defineContract({ params: partyParams, response: { 200: vaultView } })

export const vaultSummaryContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ suppliers: z.array(output({ partyId: id(), code: z.string(), valid: z.number().int(), expiring: z.number().int(), expired: z.number().int(), missing: z.number().int() })), expiringIn30Days: z.number().int() }) },
})

// ---- qualifications ------------------------------------------------------------------------------------------------

const evidence = output({ recordType: z.enum(EVIDENCE_TYPES), recordId: id() })
const evidenceInput = input({ recordType: z.enum(EVIDENCE_TYPES), recordId: id() })

const qualificationView = output({
  id: id(),
  companyId: id(),
  status: z.enum(QUALIFICATION_STATUSES),
  scope: output({ workCentreKinds: z.array(z.enum(WORK_CENTRE_KINDS)), materialKinds: z.array(z.enum(ITEM_KINDS)), operations: z.array(output({ id: id(), code: z.string().nullable(), name: z.string().nullable() })) }),
  validFrom: businessDate().nullable(),
  validUntil: businessDate().nullable(),
  evidence: z.array(evidence.extend({ label: z.string(), documents: z.array(output({ fileId: id(), expiresOn: businessDate().nullable(), expired: z.boolean() })) })),
  decided: output({ at: instant(), by: output({ id: id(), name: z.string().nullable() }).nullable() }).nullable(),
  conditions: z.string().nullable(),
  refuseReason: z.string().nullable(),
  suspended: output({ at: instant(), reason: z.string().nullable() }).nullable(),
  withdrawn: output({ at: instant(), reason: z.string().nullable() }).nullable(),
  standing: output({ standing: z.enum(STANDINGS), words: z.string() }),
  version: z.number().int(),
  may: output({ change: z.boolean(), decide: z.boolean(), suspend: z.boolean(), lift: z.boolean(), withdraw: z.boolean() }),
})

const qualificationsView = output({
  supplier: output({ id: id(), code: z.string(), name: z.string(), roles: z.array(z.string()), kinds: z.array(z.string()) }),
  qualifications: z.array(qualificationView),
  work: z.array(output({ companyId: id(), workCentreKind: z.enum(WORK_CENTRE_KINDS), qualified: z.boolean(), standing: z.enum(STANDINGS), qualificationId: id().nullable(), words: z.string() })),
  suggestions: output({
    questionnaires: z.array(evidence.extend({ companyId: id(), submittedAt: instant(), reviewedAt: instant().nullable(), documents: z.array(output({ fileId: id(), key: z.string() })) })),
    uploads: z.array(evidence.extend({ companyId: id(), category: z.string(), issuer: z.string().nullable(), number: z.string().nullable(), expiresOn: businessDate().nullable() })),
    files: z.array(evidence.extend({ category: z.string(), name: z.string(), expiresOn: businessDate().nullable() })),
  }),
  may: output({ create: z.boolean() }),
})

export const listQualificationsContract = defineContract({ params: partyParams, response: { 200: qualificationsView } })

const scopeInput = {
  workCentreKinds: z.array(z.enum(WORK_CENTRE_KINDS)).max(WORK_CENTRE_KINDS.length).optional(),
  operationIds: z.array(id()).max(QUALIFICATION_LIMITS.operations).optional(),
  materialKinds: z.array(z.enum(ITEM_KINDS)).max(ITEM_KINDS.length).optional(),
  validFrom: businessDate().nullable().optional(),
  validUntil: businessDate().nullable().optional(),
  /** What it rests on; none named at creation: the newest accepted questionnaire of the company and the documents it put in force. */
  evidence: z.array(evidenceInput).max(QUALIFICATION_LIMITS.evidence).optional(),
}

export const createQualificationContract = defineContract({
  params: partyParams,
  body: input({ companyId: id(), ...scopeInput }),
  response: { 201: qualificationsView.extend({ qualificationId: id() }) },
})

export const updateQualificationContract = defineContract({ params: qualificationParams, body: input({ version, ...scopeInput }), response: { 200: qualificationsView } })

export const decideQualificationContract = defineContract({
  params: qualificationParams,
  body: input({ version, decision: z.enum(DECISIONS), conditions: words.nullable().optional(), refuseReason: words.nullable().optional(), validFrom: businessDate().nullable().optional(), validUntil: businessDate().nullable().optional() }),
  response: { 200: qualificationsView },
})

export const suspendQualificationContract = defineContract({ params: qualificationParams, body: input({ version, reason: words.min(1) }), response: { 200: qualificationsView } })
export const liftQualificationContract = defineContract({ params: qualificationParams, body: input({ version }), response: { 200: qualificationsView } })
export const withdrawQualificationContract = defineContract({ params: qualificationParams, body: input({ version, reason: words.min(1) }), response: { 200: qualificationsView } })

// ---- the compliance gate on a PO -----------------------------------------------------------------------------------

const requirementView = output({
  kind: z.enum(REQUIREMENT_KINDS),
  state: z.enum(REQUIREMENT_STATES),
  severity: z.enum(['BLOCKS', 'WARNING']).nullable(),
  lineIds: z.array(id()),
  seqs: z.array(z.number().int()),
  itemIds: z.array(id()),
  itemCodes: z.array(z.string()),
  documentFileId: id().nullable(),
  certificateId: id().nullable(),
  ruleId: id().nullable(),
  expiresOn: businessDate().nullable(),
  law: z.string().nullable(),
  words: z.string(),
})

const requestView = output({
  lineId: id(),
  /** B-W2b-377: the approval engine's request (Home › Approvals), null for one asked before it. */
  taskId: id().nullable(),
  state: z.enum(['WAITING', 'APPROVED', 'REJECTED', 'WITHDRAWN']),
  reason: z.string(),
  askedBy: output({ id: id(), name: z.string().nullable(), me: z.boolean() }),
  askedAt: instant(),
  decidedBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  decidedAt: instant().nullable(),
  words: z.string().nullable(),
  current: z.boolean(),
})

const complianceView = output({
  order: output({ id: id(), number: z.string(), status: z.string(), partyId: id(), version: z.number().int() }),
  requirements: z.array(requirementView),
  /** Each line's held compliance mark ("Chromium VI test for A12 expired 2 Oct — this PO can't be sent"). */
  lines: z.array(output({ lineId: id(), seq: z.number().int(), held: z.boolean(), kinds: z.array(z.enum(REQUIREMENT_KINDS)), words: z.array(z.string()) })),
  checks: z.array(output({ code: z.enum(SEND_CHECK_CODES), severity: z.enum(['BLOCKS', 'WARNING']), path: z.string(), message: z.string() })),
  ready: z.boolean(),
  overridden: z.boolean(),
  /** Lines the gate could not check: the supplier's kinds do not say it is a tannery or a protector maker. */
  notChecked: z.array(z.string()),
  request: requestView.nullable(),
  may: output({ ask: z.boolean(), decide: z.boolean(), withdraw: z.boolean() }),
  heldWhy: output({ decide: z.string().nullable() }),
})

export const complianceContract = defineContract({ params: orderParams, response: { 200: complianceView } })

export const askOverrideContract = defineContract({
  params: orderParams,
  body: input({ version, reason: z.string().min(1).max(OVERRIDE_LIMITS.reason) }),
  response: { 200: complianceView },
})

export const decideOverrideContract = defineContract({
  params: orderParams,
  body: input({
    decision: z.enum(['APPROVED', 'REJECTED']),
    words: z.string().max(OVERRIDE_LIMITS.words).nullable().optional(),
    /** B-W2b-377: a no's reason code of the APPROVAL_REJECT list (left out: OTHER). */
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/).optional(),
  }),
  response: { 200: complianceView },
})

export const withdrawOverrideContract = defineContract({ params: orderParams, response: { 200: complianceView } })

export const listOverridesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      requests: z.array(output({ order: output({ id: id(), number: z.string(), status: z.string(), partyId: id() }), supplier: output({ code: z.string(), name: z.string() }).nullable(), request: requestView, held: z.array(z.string()), mayDecide: z.boolean() })),
    }),
  },
})
