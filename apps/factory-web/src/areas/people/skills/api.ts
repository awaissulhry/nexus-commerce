import { z } from 'zod'
import { AUTHORISATION_STATES, SKILL_KINDS, SKILL_LEVELS, SKILL_STATUSES, TRAINEE_STATES, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › Skills & training and the employee's Skills tab (B-W2b-65 on the API of B-W2b-39), with the
 * answer's shape checked (zod; unknown fields are dropped). A level is a qualification a person judged, never a figure
 * about one person's work: no answer read here holds a score, a count per person or a rank (Statuto dei Lavoratori art. 4;
 * AI Act Annex III 4(b)). Every write is one command with its own Idempotency-Key and the version the screen read; the
 * API's English is never drawn, the screens say their own words from codes (`refusal/<CODE>`).
 */

export type { SkillLevel }
export type SkillKind = (typeof SKILL_KINDS)[number]
export type TraineeState = (typeof TRAINEE_STATES)[number]
export type AuthorisationState = (typeof AUTHORISATION_STATES)[number]

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const machineClass = z.object({ id: z.string(), code: z.string(), labelEn: z.string(), labelIt: z.string() })
export type MachineClass = z.infer<typeof machineClass>

const skillSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  kind: z.enum(SKILL_KINDS),
  operation: ref.nullable(),
  machineClass: machineClass.nullable(),
  sortOrder: z.number(),
  status: z.enum(SKILL_STATUSES),
  version: z.number(),
})
export type Skill = z.infer<typeof skillSchema>

const levelSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  skill: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(SKILL_KINDS), status: z.enum(SKILL_STATUSES) }),
  level: z.enum(SKILL_LEVELS),
  since: z.string(),
  assessedAt: z.string(),
  assessedBy: z.string().nullable(),
  traineeUntil: z.string().nullable(),
  trainee: z.enum(TRAINEE_STATES),
  signedOffOn: z.string().nullable(),
  signedOffBy: z.string().nullable(),
  trainer: z.object({ employeeId: z.string(), name: z.string() }).nullable(),
  removedAt: z.string().nullable(),
  removedBy: z.string().nullable(),
  removeReason: z.string().nullable(),
  version: z.number(),
})
export type EmployeeLevel = z.infer<typeof levelSchema>

const authorisationSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  machineClass,
  authorisedOn: z.string(),
  validUntil: z.string().nullable(),
  state: z.enum(AUTHORISATION_STATES),
  authorisedBy: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: z.string().nullable(),
  version: z.number(),
})
export type Authorisation = z.infer<typeof authorisationSchema>

// ---- the matrix -----------------------------------------------------------------------------------------------------------

const levelCell = z.object({ skillId: z.string(), levelId: z.string(), level: z.enum(SKILL_LEVELS), since: z.string(), traineeUntil: z.string().nullable(), trainee: z.enum(TRAINEE_STATES), signedOffOn: z.string().nullable(), version: z.number() })
export type LevelCell = z.infer<typeof levelCell>
const authorisationCell = z.object({ machineClassId: z.string(), authorisationId: z.string(), state: z.enum(AUTHORISATION_STATES), authorisedOn: z.string(), validUntil: z.string().nullable(), ending: z.boolean(), version: z.number() })
export type AuthorisationCell = z.infer<typeof authorisationCell>

const matrixRow = z.object({
  employeeId: z.string(),
  name: z.string(),
  displayName: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  line: ref.nullable(),
  team: ref.nullable(),
  levels: z.array(levelCell),
  authorisations: z.array(authorisationCell),
  canManage: z.boolean(),
  canAuthorise: z.boolean(),
})
export type MatrixRow = z.infer<typeof matrixRow>

const matrixSchema = z.object({
  rows: z.array(matrixRow),
  complete: z.boolean(),
  skills: z.array(skillSchema),
  machineClasses: z.array(machineClass.extend({ active: z.boolean(), keptAtSites: z.array(z.string()) })),
  sites: z.array(ref),
  tiles: z.object({ trainees: z.number(), traineesOverdue: z.number(), authorisationsEnding: z.number() }),
  today: z.string(),
})
export type Matrix = z.infer<typeof matrixSchema>
export type MatrixClass = Matrix['machineClasses'][number]

export interface MatrixQuery {
  siteId?: string | null
  show?: 'ALL' | 'SKILLS' | 'MACHINES'
  tile?: 'TRAINEES' | 'AUTHORISATIONS_ENDING' | null
  sort?: 'TEAM' | 'NAME'
  q?: string | null
}

export const getMatrix = (api: ApiClient, query: MatrixQuery) =>
  api.get('/people/skills/matrix', { query: clean({ siteId: query.siteId, show: query.show, tile: query.tile, sort: query.sort, q: query.q?.trim() }), schema: matrixSchema })

const employeeSkillsSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string(), companyId: z.string(), siteId: z.string(), status: z.enum(['ACTIVE', 'LEFT']) }),
  levels: z.array(levelSchema),
  authorisations: z.array(authorisationSchema),
  history: z.object({ levels: z.array(levelSchema), authorisations: z.array(authorisationSchema) }),
  canManage: z.boolean(),
  canAuthorise: z.boolean(),
  today: z.string(),
})
export type EmployeeSkills = z.infer<typeof employeeSkillsSchema>

export const getEmployeeSkills = (api: ApiClient, employeeId: string) => api.get(`/people/employees/${seg(employeeId)}/skills`, { schema: employeeSkillsSchema })

const cellSchema = z.object({
  employee: z.object({ id: z.string(), name: z.string() }),
  levels: z.array(levelSchema),
  authorisations: z.array(authorisationSchema),
  history: z.array(z.object({ id: z.string(), at: z.string(), action: z.string(), recordId: z.string(), by: z.string().nullable(), before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()).nullable(), reason: z.string().nullable() })),
  canManage: z.boolean(),
  canAuthorise: z.boolean(),
  today: z.string(),
})
export type CellDetail = z.infer<typeof cellSchema>
export type CellHistory = CellDetail['history'][number]

export const getCell = (api: ApiClient, query: { employeeId: string; skillId?: string; machineClassId?: string }) => api.get('/people/skills/cell', { query: clean({ ...query }), schema: cellSchema })

// ---- the catalogue --------------------------------------------------------------------------------------------------------

export const listSkills = (api: ApiClient, query: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; companyId?: string | null } = {}) =>
  api.get('/people/skills', { query: clean({ status: query.status, companyId: query.companyId }), schema: z.object({ skills: z.array(skillSchema), canManage: z.boolean() }) })

/** The operations of the library (product.routing.view) a skill can be about. */
export const listOperations = (api: ApiClient) =>
  api.get('/product/operations', { query: { status: 'ACTIVE', limit: 100 }, schema: z.object({ operations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })) }) }).then((answer) => answer.operations.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` })))

export const createSkill = (api: ApiClient, body: { companyId: string; code: string; name: string; nameI18n?: Record<string, string>; kind: SkillKind; operationId?: string | null; machineClassId?: string | null }) =>
  api.post('/people/skills', { body, schema: z.object({ skill: skillSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.skill)

export const setSkillStatus = (api: ApiClient, skillId: string, to: 'archive' | 'restore', version: number) =>
  api.post(`/people/skills/${seg(skillId)}/${to}`, { body: { version }, schema: z.object({ skill: skillSchema, changed: z.boolean() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.skill)

// ---- levels and trainees --------------------------------------------------------------------------------------------------

/** A level of one person on one skill; `version` = of the level in force (left out for a new one). */
export interface LevelBody {
  employeeId: string
  skillId: string
  level: SkillLevel
  since?: string
  traineeUntil?: string | null
  version?: number
}

export const setLevel = (api: ApiClient, body: LevelBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/people/skills/levels', { body, schema: z.object({ level: levelSchema, changed: z.boolean() }), idempotencyKey })

/** A signing act: the API answers 403 `stepUp` until a fresh code is given. */
export const signOffTrainee = (api: ApiClient, levelId: string, body: { version: number; signedOffOn?: string; trainerEmployeeId?: string | null; level?: SkillLevel }, idempotencyKey: string) =>
  api.post(`/people/skills/levels/${seg(levelId)}/sign-off`, { body, schema: z.object({ level: levelSchema }), idempotencyKey }).then((answer) => answer.level)

export const removeLevel = (api: ApiClient, levelId: string, body: { version: number; reason: string }) =>
  api.post(`/people/skills/levels/${seg(levelId)}/remove`, { body, schema: z.object({ level: levelSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.level)

// ---- machine authorisations -----------------------------------------------------------------------------------------------

export const authoriseMachine = (api: ApiClient, body: { employeeId: string; machineClassId: string; authorisedOn?: string; validUntil?: string | null }) =>
  api.post('/people/skills/authorisations', { body, schema: z.object({ authorisation: authorisationSchema, words: z.string() }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.authorisation)

export const changeValidUntil = (api: ApiClient, id: string, body: { version: number; validUntil: string | null }) =>
  api.post(`/people/skills/authorisations/${seg(id)}/valid-until`, { body, schema: z.object({ authorisation: authorisationSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.authorisation)

export const revokeAuthorisation = (api: ApiClient, id: string, body: { version: number; reason: string }) =>
  api.post(`/people/skills/authorisations/${seg(id)}/revoke`, { body, schema: z.object({ authorisation: authorisationSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.authorisation)
