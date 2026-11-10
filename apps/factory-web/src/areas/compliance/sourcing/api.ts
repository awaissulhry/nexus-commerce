import { z } from 'zod'
import { BLOCK_CAUSES, CLAIM_KINDS, CLAIM_SCOPES, CLAIM_STATES, CLAIM_STATUSES, FINDING_CODES, USE_KINDS, type ClaimKind, type ClaimScope, type UseKind } from '@nexus/factory-domain/compliance/claims/rules'
import type { ApiClient } from '../../../lib/api/client'
import { completeUpload, presignedSchema, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Compliance › Sustainability › Sourcing & claims (SCR-215; B-W2b-264 on the API of the same step, apps/factory-api
 * modules/compliance/claims): the claims and their tiles, one claim with its uses and activity, the dialog's choices, and the
 * writes (draft, change a draft, approve, withdraw, record and end a use), plus an evidence file uploaded onto a claim through the
 * generic files routes. Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). Reading
 * is compliance.certificates.view; the writes compliance.claims.manage, approving compliance.claims.approve with a fresh code.
 * The API's English is never shown: the screens say their own words from the codes. No money.
 */

const seg = (value: string) => encodeURIComponent(value)
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const evidenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  contentType: z.string(),
  sizeBytes: z.number(),
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED', 'MISSING']),
  expiresOn: z.string().nullable(),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  availableAt: z.string().nullable(),
})
export type Evidence = z.infer<typeof evidenceSchema>

const validitySchema = z.object({ state: z.enum(['NONE', 'OK', 'SOON', 'EXPIRED']), daysLeft: z.number().nullable(), threshold: z.number().nullable() })
export type ValidityRead = z.infer<typeof validitySchema>

export const claimSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  kind: z.enum(CLAIM_KINDS),
  wording: z.record(z.string(), z.string()),
  phraseKey: z.string().nullable(),
  scope: z.enum(CLAIM_SCOPES),
  style: ref.nullable(),
  material: ref.nullable(),
  scopeNote: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  validUntil: z.string().nullable(),
  validity: validitySchema,
  status: z.enum(CLAIM_STATUSES),
  state: z.enum(CLAIM_STATES),
  blockReasons: z.array(z.object({ cause: z.enum(BLOCK_CAUSES), fileId: z.string().nullable(), day: z.string().nullable() })),
  approvedAt: z.string().nullable(),
  approvedBy: person,
  withdrawnAt: z.string().nullable(),
  withdrawnBy: person,
  withdrawReason: z.string().nullable(),
  supersedes: z.object({ id: z.string(), code: z.string(), status: z.enum(CLAIM_STATUSES) }).nullable(),
  supersededBy: z.object({ id: z.string(), code: z.string(), status: z.enum(CLAIM_STATUSES) }).nullable(),
  uses: z.object({ live: z.number(), ended: z.number(), kinds: z.array(z.enum(USE_KINDS)) }),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: person,
  version: z.number(),
  canManage: z.boolean(),
  canApprove: z.boolean(),
})
export type Claim = z.infer<typeof claimSchema>

export const useSchema = z.object({
  id: z.string(),
  kind: z.enum(USE_KINDS),
  recordType: z.string(),
  recordId: z.string(),
  record: z.object({ code: z.string(), name: z.string() }).nullable(),
  label: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdBy: person,
  endedAt: z.string().nullable(),
  endedBy: person,
  version: z.number(),
})
export type ClaimUse = z.infer<typeof useSchema>

export const activitySchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  by: person,
  reason: z.string().nullable(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])),
})
export type Activity = z.infer<typeof activitySchema>

const findingSchema = z.object({ code: z.enum(FINDING_CODES), severity: z.enum(['refuse', 'advise']), words: z.string(), law: z.string(), suggestion: z.string().nullable() })
const lawSchema = z.object({ claims: z.string(), generic: z.string(), offset: z.string(), label: z.string() })
export type Law = z.infer<typeof lawSchema>

const listAnswer = z.object({ claims: z.array(claimSchema), complete: z.boolean(), canManage: z.boolean(), canApprove: z.boolean(), today: z.string(), law: lawSchema, labelCheck: z.enum(['ON', 'OFF', 'NONE']) })
export type ListAnswer = z.infer<typeof listAnswer>

const countsAnswer = z.object({ approved: z.number(), blocked: z.number(), drafts: z.number(), retired: z.number() })
export type CountsAnswer = z.infer<typeof countsAnswer>

const recordAnswer = z.object({ claim: claimSchema, uses: z.array(useSchema), activity: z.array(activitySchema), findings: z.record(z.string(), z.array(findingSchema)), today: z.string(), law: lawSchema })
export type ClaimRecord = z.infer<typeof recordAnswer>

const choicesAnswer = z.object({
  files: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), category: z.string().nullable(), recordType: z.string(), recordId: z.string(), expiresOn: z.string().nullable(), availableAt: z.string().nullable() })),
  styles: z.array(ref),
  materials: z.array(ref),
  labels: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), styleId: z.string().nullable() })),
  phrases: z.array(z.object({ key: z.string(), text: z.string(), language: z.string() })),
  nextCode: z.string(),
})
export type Choices = z.infer<typeof choicesAnswer>
export type ChoiceFile = Choices['files'][number]

export interface ListQuery {
  readonly state: string
  readonly kind: ClaimKind | null
  readonly scope: ClaimScope | null
  readonly q: string
}

/** GET /compliance/claims: the list's filters are the API's own (the export reads the same terms). */
export const listClaims = (api: ApiClient, query: ListQuery, signal?: AbortSignal) =>
  api.get('/compliance/claims', { query: { ...(query.state !== 'current' ? { state: query.state } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.scope ? { scope: query.scope } : {}), ...(query.q ? { q: query.q } : {}) }, schema: listAnswer, signal })

/** GET /compliance/claims/counts: the tiles. */
export const readCounts = (api: ApiClient, signal?: AbortSignal) => api.get('/compliance/claims/counts', { schema: countsAnswer, signal })

/** GET /compliance/claims/:id: the claim, its uses, its activity, the checker's findings. */
export const readClaim = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/compliance/claims/${seg(id)}`, { schema: recordAnswer, signal })

/** GET /compliance/claims/choices (compliance.claims.manage): evidence files, styles, materials, labels, phrases, the next code. */
export const readChoices = (api: ApiClient, signal?: AbortSignal) => api.get('/compliance/claims/choices', { schema: choicesAnswer, signal })

export interface ClaimBody {
  kind: ClaimKind
  wording: Record<string, string>
  phraseKey: string | null
  scope: ClaimScope
  styleId: string | null
  itemId: string | null
  scopeNote: string | null
  evidenceFileIds: string[]
  validUntil: string | null
  note: string | null
}

const claimAnswer = z.object({ claim: claimSchema })

/** POST /compliance/claims: a draft (and, with `supersedesId`, the replacement of an approved or withdrawn claim). */
export const createClaim = async (api: ApiClient, body: ClaimBody & { companyId: string; code: string; supersedesId: string | null }, idempotencyKey: string) =>
  (await api.post('/compliance/claims', { body, schema: claimAnswer, idempotencyKey })).claim

/** PATCH /compliance/claims/:id: a draft, at the version read. */
export const editClaim = async (api: ApiClient, id: string, body: ClaimBody & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/compliance/claims/${seg(id)}`, { body, schema: claimAnswer, idempotencyKey })).claim

const approveAnswer = z.object({ claim: claimSchema, replaced: z.object({ id: z.string(), code: z.string(), usesMoved: z.number() }).nullable() })
export type ApproveAnswer = z.infer<typeof approveAnswer>

/** POST /compliance/claims/:id/approve (a fresh code: the caller's step-up guard asks for it on a 403 stepUp). */
export const approveClaim = (api: ApiClient, id: string, body: { version: number }, idempotencyKey: string) => api.post(`/compliance/claims/${seg(id)}/approve`, { body, schema: approveAnswer, idempotencyKey })

const withdrawAnswer = z.object({ claim: claimSchema, usesEnded: z.number() })

/** POST /compliance/claims/:id/withdraw: with the reason; its live uses end with it. */
export const withdrawClaim = (api: ApiClient, id: string, body: { version: number; reason: string }, idempotencyKey: string) => api.post(`/compliance/claims/${seg(id)}/withdraw`, { body, schema: withdrawAnswer, idempotencyKey })

const useAnswer = z.object({ use: useSchema })

/** POST /compliance/claims/:id/uses: where an approved claim that holds is used. */
export const addUse = async (api: ApiClient, id: string, body: { kind: UseKind; recordId: string; label: string | null; note: string | null }, idempotencyKey: string) =>
  (await api.post(`/compliance/claims/${seg(id)}/uses`, { body, schema: useAnswer, idempotencyKey })).use

/** POST /compliance/claims/:id/uses/:useId/end. */
export const endUse = async (api: ApiClient, id: string, useId: string, body: { version: number }, idempotencyKey: string) =>
  (await api.post(`/compliance/claims/${seg(id)}/uses/${seg(useId)}/end`, { body, schema: useAnswer, idempotencyKey })).use

/** The content types an evidence file may have (the generic files' CERTIFICATE kind: a PDF, or a photo of the paper). */
export const EVIDENCE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

/**
 * An evidence file uploaded onto a claim through the generic files routes (POST /files with record type SustainabilityClaim,
 * kind CERTIFICATE: a PDF or a photo of the paper; files.upload): announce with the SHA-256 worked out here, send the bytes to
 * the store with the presigned request, confirm. The answer is the file's id, for the claim's evidence list.
 */
export async function uploadEvidence(api: ApiClient, input: { companyId: string; claimId: string; file: File }): Promise<string> {
  const bytes = await input.file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const announced = await requestUpload(api, {
    companyId: input.companyId,
    record: { type: 'SustainabilityClaim', id: input.claimId },
    kind: 'CERTIFICATE',
    name: input.file.name,
    contentType: input.file.type || 'application/pdf',
    sizeBytes: input.file.size,
    sha256,
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(presignedSchema.parse(announced.upload), bytes)
  await completeUpload(api, announced.file.id)
  return announced.file.id
}

/** A 60-second download address of an evidence file, as this browser reaches it (GET /files/:id/download, files.read). */
export async function evidenceAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}
