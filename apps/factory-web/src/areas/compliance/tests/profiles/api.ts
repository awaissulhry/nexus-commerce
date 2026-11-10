import { z } from 'zod'
import { INNOCUOUSNESS_PARAMETERS } from '@nexus/factory-domain/compliance/material-profiles/rules'
import { DECLARATION_KINDS, SUBSTANCE_TESTS } from '@nexus/factory-domain/compliance/substances/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Every call of Compliance › Tests & substances › Material profiles (B-W2b-267 on B-W2b-256's API, apps/factory-api
 * modules/compliance/material-profiles, and B-W2b-250's evaluator, modules/compliance/substances): the list with its tiles,
 * one profile with its evidence, the confirmations and the origin (the evaluator runs in the same command: the screens never
 * set a state), the evaluator's verdicts per rule, and Evaluate again. Each answer's shape is checked (zod mirrors of the API's
 * contracts). The API's English (`stateReason`, `gaps`, `words`, `explanation`) is read but never shown: the screens say their
 * own words from the codes and flags. No money.
 */

const seg = (value: string) => encodeURIComponent(value)
const state = z.enum(['INCOMPLETE', 'COMPLETE', 'BLOCKED'])
const parameter = z.enum(INNOCUOUSNESS_PARAMETERS)
const parameterStatus = z.enum(['MET', 'FAILED', 'FILE', 'MISSING'])
const declarationKind = z.enum(DECLARATION_KINDS)
const person = z.object({ id: z.string(), name: z.string() }).nullable()

export const profileRowSchema = z.object({
  material: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), companyId: z.string().nullable(), status: z.string() }),
  composition: z.string().nullable(),
  tannage: z.string().nullable(),
  animalSpecies: z.string().nullable(),
  originCountry: z.string().nullable(),
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  state: state.nullable(),
  stateReason: z.string().nullable(),
  evaluatedAt: z.string().nullable(),
  testsNeeded: z.array(z.enum(SUBSTANCE_TESTS)),
  declarations: z.object({ needed: z.array(declarationKind), present: z.array(declarationKind), missing: z.array(declarationKind), asked: z.array(declarationKind) }),
  compositionConfirmed: z.boolean(),
  tannageConfirmed: z.boolean().nullable(),
  innocuousness: z.object({ required: z.boolean(), complete: z.boolean(), parameters: z.array(z.object({ parameter, status: parameterStatus })) }),
  svhcAboveThreshold: z.boolean().nullable(),
  version: z.number().int().nullable(),
})
export type ProfileRow = z.infer<typeof profileRowSchema>
export type ProfileState = z.infer<typeof state>
export type ParameterStatus = z.infer<typeof parameterStatus>

const countsSchema = z.object({ materials: z.number().int(), none: z.number().int(), incomplete: z.number().int(), complete: z.number().int(), blocked: z.number().int() })
export type ProfileCounts = z.infer<typeof countsSchema>
const listSchema = z.object({ profiles: z.array(profileRowSchema), more: z.boolean(), counts: countsSchema, mayEdit: z.boolean(), asOf: z.string() })
export type ProfileList = z.infer<typeof listSchema>

export interface ProfileQuery {
  readonly state?: 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' | 'NONE' | null
  readonly kind?: string | null
  readonly q?: string | null
}

/** GET /compliance/material-profiles (compliance.certificates.view): every active material read (≤ 500) with the tiles. */
export const listProfiles = (api: ApiClient, query: ProfileQuery, signal?: AbortSignal): Promise<ProfileList> =>
  api.get('/compliance/material-profiles', { query: { state: query.state ?? undefined, kind: query.kind ?? undefined, q: query.q?.trim() || undefined }, schema: listSchema, signal })

export const profileRecordSchema = profileRowSchema.extend({
  compositionList: z.array(z.object({ fibre: z.string(), percent: z.string() })),
  isPpeComponent: z.boolean(),
  requiresCrViTest: z.boolean(),
  compositionConfirmedAt: z.string().nullable(),
  compositionConfirmedBy: person,
  tannageConfirmedAt: z.string().nullable(),
  tannageConfirmedBy: person,
  note: z.string().nullable(),
  innocuousnessDetail: z.object({
    required: z.boolean(),
    ppeStyles: z.array(z.string()),
    complete: z.boolean(),
    parameters: z.array(
      z.object({
        parameter,
        status: parameterStatus,
        result: z.object({ resultId: z.string(), lotId: z.string(), test: z.string(), verdict: z.enum(['PASS', 'FAIL']), testedOn: z.string() }).nullable(),
        files: z.array(z.string()),
      }),
    ),
  }),
  evidenceFiles: z.array(z.object({ fileId: z.string(), name: z.string(), category: z.string().nullable(), expiresOn: z.string().nullable() })),
  declarationRequests: z.array(
    z.object({
      requestId: z.string(),
      number: z.string(),
      kind: declarationKind,
      status: z.string(),
      party: z.object({ id: z.string().nullable(), code: z.string() }),
      dueOn: z.string(),
      validTo: z.string().nullable(),
    }),
  ),
  labResults: z.array(
    z.object({
      resultId: z.string(),
      lot: z.object({ id: z.string(), code: z.string() }),
      test: z.string(),
      verdict: z.string(),
      testedOn: z.string(),
      value: z.string().nullable(),
      belowDetectionLimit: z.boolean(),
      unit: z.string(),
      limit: z.string(),
      method: z.string(),
      lab: z.string(),
      current: z.boolean(),
    }),
  ),
  mayEdit: z.boolean(),
})
export type ProfileRecord = z.infer<typeof profileRecordSchema>

/** GET /compliance/material-profiles/:itemId: the profile with its evidence (results, declarations, files). */
export const getProfile = (api: ApiClient, itemId: string, signal?: AbortSignal): Promise<{ profile: ProfileRecord; asOf: string }> =>
  api.get(`/compliance/material-profiles/${seg(itemId)}`, { schema: z.object({ profile: profileRecordSchema, asOf: z.string() }), signal })

export interface ProfileEdit {
  readonly compositionConfirmed?: boolean
  readonly tannageConfirmed?: boolean
  readonly originCountry?: string | null
  readonly note?: string | null
}

/** PATCH /compliance/material-profiles/:itemId (compliance.substances.manage): ONE command, the evaluator runs in it. */
export const editProfile = (api: ApiClient, itemId: string, version: number | null, edit: ProfileEdit, idempotencyKey: string): Promise<{ profile: ProfileRecord }> =>
  api.request('PATCH', `/compliance/material-profiles/${seg(itemId)}`, { body: { ...(version !== null ? { version } : {}), ...edit }, schema: z.object({ profile: profileRecordSchema }), idempotencyKey })

const verdictSchema = z.object({
  ruleId: z.string(),
  key: z.string(),
  code: z.string(),
  name: z.string(),
  legalReference: z.string(),
  limit: z.string(),
  status: z.enum(['MET', 'FAILED', 'MISSING', 'NOT_APPLICABLE']),
  why: z.string().nullable(),
  evidence: z.enum(['TEST', 'DECLARATION', 'EITHER']),
  needs: z.object({ test: z.string().nullable(), declaration: z.string().nullable() }),
  metBy: z.enum(['TEST', 'DECLARATION']).nullable(),
  asked: z.object({ requestId: z.string(), number: z.string(), dueOn: z.string(), status: z.string() }).nullable(),
})
export type RuleVerdict = z.infer<typeof verdictSchema>

const evaluationSchema = z.object({
  rules: z.array(verdictSchema),
  svhc: z.object({
    aboveThreshold: z.boolean().nullable(),
    substances: z.array(z.object({ id: z.string(), casNumber: z.string().nullable(), name: z.string() })),
    listVersion: z.object({ id: z.string(), publishedOn: z.string(), entryCount: z.number().int() }).nullable(),
    newestVersion: z.object({ id: z.string(), publishedOn: z.string(), entryCount: z.number().int() }).nullable(),
    current: z.boolean(),
    grewBy: z.number().int().nullable(),
    source: z.enum(['DECLARATION', 'PROFILE', 'NONE']),
  }),
  state,
  mayEvaluate: z.boolean(),
})
export type MaterialEvaluation = z.infer<typeof evaluationSchema>

/** GET /compliance/substances/materials/:id/evaluation: what the evaluator says now, per rule (nothing written). */
export const readEvaluation = (api: ApiClient, itemId: string, signal?: AbortSignal): Promise<MaterialEvaluation> =>
  api.get(`/compliance/substances/materials/${seg(itemId)}/evaluation`, { schema: evaluationSchema, signal })

const evaluatedSchema = z.object({
  profiles: z.array(z.object({ itemId: z.string(), code: z.string(), name: z.string(), state, previousState: state.nullable(), changed: z.boolean() })),
  evaluatedAt: z.string(),
})
export type Evaluated = z.infer<typeof evaluatedSchema>

/** POST /compliance/substances/materials/evaluate (compliance.substances.manage): the evaluator over ≤ 100 materials in ONE command. */
export const evaluateMaterials = (api: ApiClient, itemIds: readonly string[], idempotencyKey: string): Promise<Evaluated> =>
  api.post('/compliance/substances/materials/evaluate', { body: { itemIds: [...itemIds] }, schema: evaluatedSchema, idempotencyKey })
