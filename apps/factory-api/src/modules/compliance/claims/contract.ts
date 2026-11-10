import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { BLOCK_CAUSES, CLAIM_KINDS, CLAIM_LIMITS, CLAIM_SCOPES, CLAIM_STATES, CLAIM_STATUSES, FINDING_CODES, USE_KINDS } from '@nexus/factory-domain/compliance/claims/rules'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; design compliance.sourcing, SCR-215: the tiles, the claims grid, pop-ups New claim
 * and Claim with its tabs Wording · Evidence · Where used · Activity). Office only. No person but the office people who
 * drafted, approved, withdrew or recorded (a record's history), no money.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const ref = output({ id: id(), code: z.string(), name: z.string() })

export const evidenceView = output({
  id: id(),
  name: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  /** MISSING: the id names no file the caller can read (deleted for good, or another company's). */
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED', 'MISSING']),
  expiresOn: businessDate().nullable(),
  /** The record the file belongs to (a certificate, a lot, this claim). */
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  availableAt: instant().nullable(),
})

const validity = output({ state: z.enum(['NONE', 'OK', 'SOON', 'EXPIRED']), daysLeft: z.number().int().nullable(), threshold: z.number().int().nullable() })
const blockReason = output({ cause: z.enum(BLOCK_CAUSES), fileId: id().nullable(), day: businessDate().nullable() })

export const claimView = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  kind: z.enum(CLAIM_KINDS),
  /** The words per language (BCP 47 → one line). */
  wording: z.record(z.string(), z.string()),
  phraseKey: z.string().nullable(),
  scope: z.enum(CLAIM_SCOPES),
  style: ref.nullable(),
  material: ref.nullable(),
  scopeNote: z.string().nullable(),
  evidence: z.array(evidenceView),
  validUntil: businessDate().nullable(),
  validity,
  status: z.enum(CLAIM_STATUSES),
  /** What a person reads: BLOCKED is APPROVED with evidence that no longer holds. */
  state: z.enum(CLAIM_STATES),
  blockReasons: z.array(blockReason),
  approvedAt: instant().nullable(),
  approvedBy: person,
  withdrawnAt: instant().nullable(),
  withdrawnBy: person,
  withdrawReason: z.string().nullable(),
  supersedes: output({ id: id(), code: z.string(), status: z.enum(CLAIM_STATUSES) }).nullable(),
  supersededBy: output({ id: id(), code: z.string(), status: z.enum(CLAIM_STATUSES) }).nullable(),
  /** Where it is used now (live uses per kind) and how many uses ended. */
  uses: output({ live: z.number().int(), ended: z.number().int(), kinds: z.array(z.enum(USE_KINDS)) }),
  note: z.string().nullable(),
  createdAt: instant(),
  createdBy: person,
  version: z.number().int(),
  canManage: z.boolean(),
  canApprove: z.boolean(),
})

export const useView = output({
  id: id(),
  kind: z.enum(USE_KINDS),
  recordType: z.string(),
  recordId: id(),
  /** The record in words (the style's or the label template's code and name; null when out of sight). */
  record: output({ code: z.string(), name: z.string() }).nullable(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdBy: person,
  endedAt: instant().nullable(),
  endedBy: person,
  version: z.number().int(),
})

export const activityView = output({
  id: id(),
  at: instant(),
  action: z.string(),
  by: person,
  reason: z.string().nullable(),
  /** The facts of the change, in codes (a use's kind and label, the status reached, the cause of an expiry). */
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])),
})

const finding = output({ code: z.enum(FINDING_CODES), severity: z.enum(['refuse', 'advise']), words: z.string(), law: z.string(), suggestion: z.string().nullable() })
const law = output({ claims: z.string(), generic: z.string(), offset: z.string(), label: z.string() })

const listQuery = {
  /** current: drafts, approved and blocked (the default); one state; or every claim. */
  state: z.enum(['current', 'all', ...CLAIM_STATES]).optional(),
  kind: z.enum(CLAIM_KINDS).optional(),
  scope: z.enum(CLAIM_SCOPES).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(CLAIM_LIMITS.list).optional(),
}

export const listContract = defineContract({
  querystring: input(listQuery),
  response: {
    200: output({
      claims: z.array(claimView),
      complete: z.boolean(),
      canManage: z.boolean(),
      canApprove: z.boolean(),
      today: businessDate(),
      law,
      /** Whether label print checks the claims (the requirement CLAIM-EVIDENCE: ON, OFF, or NONE when the tenant has no row). */
      labelCheck: z.enum(['ON', 'OFF', 'NONE']),
    }),
  },
})

export const countsContract = defineContract({
  response: { 200: output({ approved: z.number().int(), blocked: z.number().int(), drafts: z.number().int(), retired: z.number().int() }) },
})

export const recordContract = defineContract({
  params: input({ claimId: id() }),
  response: { 200: output({ claim: claimView, uses: z.array(useView), activity: z.array(activityView), findings: z.record(z.string(), z.array(finding)), today: businessDate(), law }) },
})

const choiceFile = output({ id: id(), name: z.string(), kind: z.string(), category: z.string().nullable(), recordType: z.string(), recordId: id(), expiresOn: businessDate().nullable(), availableAt: instant().nullable() })

export const choicesContract = defineContract({
  querystring: input({ q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      files: z.array(choiceFile),
      styles: z.array(ref),
      materials: z.array(ref),
      labels: z.array(output({ id: id(), code: z.string(), name: z.string(), styleId: id().nullable() })),
      phrases: z.array(output({ key: z.string(), text: z.string(), language: z.string() })),
      nextCode: z.string(),
    }),
  },
})

const wordingBody = z.record(z.string().trim().min(2).max(20), z.string().max(CLAIM_LIMITS.wording))
const claimBody = {
  kind: z.enum(CLAIM_KINDS),
  wording: wordingBody,
  phraseKey: z.string().trim().max(CLAIM_LIMITS.phraseKey).nullable().optional(),
  scope: z.enum(CLAIM_SCOPES),
  styleId: id().nullable().optional(),
  itemId: id().nullable().optional(),
  scopeNote: z.string().trim().max(CLAIM_LIMITS.scopeNote).nullable().optional(),
  evidenceFileIds: z.array(id()).max(CLAIM_LIMITS.evidence),
  validUntil: businessDate().nullable().optional(),
  note: z.string().trim().max(CLAIM_LIMITS.note).nullable().optional(),
}

const one = output({ claim: claimView })

export const createContract = defineContract({
  body: input({ companyId: id(), code: z.string().trim().min(1).max(CLAIM_LIMITS.code), supersedesId: id().nullable().optional(), ...claimBody }),
  response: { 201: output({ claim: claimView, replayed: z.boolean() }), 200: output({ claim: claimView, replayed: z.boolean() }) },
})

export const editContract = defineContract({
  params: input({ claimId: id() }),
  body: input({ version: version(), ...claimBody }),
  response: { 200: one },
})

export const approveContract = defineContract({
  params: input({ claimId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ claim: claimView, replaced: output({ id: id(), code: z.string(), usesMoved: z.number().int() }).nullable() }) },
})

export const withdrawContract = defineContract({
  params: input({ claimId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(CLAIM_LIMITS.reason) }),
  response: { 200: output({ claim: claimView, usesEnded: z.number().int() }) },
})

export const addUseContract = defineContract({
  params: input({ claimId: id() }),
  body: input({ kind: z.enum(USE_KINDS), recordId: id(), label: z.string().trim().max(CLAIM_LIMITS.label).nullable().optional(), note: z.string().trim().max(CLAIM_LIMITS.note).nullable().optional() }),
  response: { 201: output({ use: useView, replayed: z.boolean() }), 200: output({ use: useView, replayed: z.boolean() }) },
})

export const endUseContract = defineContract({
  params: input({ claimId: id(), useId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ use: useView }) },
})
