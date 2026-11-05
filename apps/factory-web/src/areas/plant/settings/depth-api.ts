import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Plant settings' W2b sections (SCR-241; B-W2b-141 on the merged API of B-W2b-96, B-W2b-124 and B-W2b-125),
 * with the answer's shape checked (zod; unknown fields are dropped):
 *
 *   Request routing and escalation  GET /plant/settings/routing?siteId · /preview · POST · PATCH …/:ruleId · POST
 *                                   …/:ruleId/remove · POST …/order (plant.view to read; plant.settings.manage at the site
 *                                   to write; `canManage` says which)
 *   Unsafe lock                     GET|PUT /plant/settings/lock (version null: the site has no row yet, Owner answer H1's
 *                                   defaults; switching the hazard report off answers 403 `stepUp` once)
 *   Statutory check types           GET|POST /plant/checks/types · PATCH …/:checkTypeId (plant.view; the whole group's list,
 *                                   kept with plant.checks.manage over every company)
 *   Incidents                       GET /safety/incidents/rules (safety.incidents.view; the law's numbers, read only)
 *   Pickers                         GET /people/teams?siteId · GET /people/employees (people.view)
 *   Audit log                       GET /audit per record type (audit.read)
 *
 * Every write carries the version read and its own Idempotency-Key (the same key when a write is sent again after the
 * fresh code). The API's English `words` are dropped: the screens say the worked example in their own language.
 */

const seg = (value: string) => encodeURIComponent(value)
const named = z.object({ id: z.string(), name: z.string(), active: z.boolean() })
const classBrief = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() })

// ---- request routing and escalation -----------------------------------------------------------------------------------------

export const ruleSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  seq: z.number(),
  machineClass: classBrief.nullable(),
  target: z.object({ kind: z.enum(['TEAM', 'TECHNICIAN']), id: z.string(), name: z.string(), active: z.boolean() }),
  push: z.boolean(),
  escalateAfterMinutes: z.number().nullable(),
  escalateTo: named.nullable(),
  escalateAgainAfterMinutes: z.number().nullable(),
  escalateAgainTo: named.nullable(),
  active: z.boolean(),
  /** How many requests it routed (a rule that routed any is switched off, never deleted). */
  requests: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type RoutingRule = z.infer<typeof ruleSchema>

const routingAnswer = z.object({ siteId: z.string(), rules: z.array(ruleSchema), canManage: z.boolean() })
export type RoutingRead = z.infer<typeof routingAnswer>
const rulesAnswer = z.object({ rules: z.array(ruleSchema) })

/** GET /plant/settings/routing?siteId (plant.view): the site's rules in their order, each with how many requests it routed. */
export const readRouting = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/plant/settings/routing', { query: { siteId }, schema: routingAnswer, signal })

const previewAnswer = z.object({
  rule: z
    .object({
      id: z.string(),
      target: ruleSchema.shape.target,
      escalateAfterMinutes: z.number().nullable(),
      escalateTo: named.nullable(),
      escalateAgainAfterMinutes: z.number().nullable(),
      escalateAgainTo: named.nullable(),
    })
    .nullable(),
})
export type RoutingPreview = z.infer<typeof previewAnswer>

/** GET /plant/settings/routing/preview (plant.view): the rule a request of a machine of this class follows now (null: none). */
export const previewRouting = (api: ApiClient, siteId: string, machineClassId: string, signal?: AbortSignal) =>
  api.get('/plant/settings/routing/preview', { query: { siteId, machineClassId }, schema: previewAnswer, signal })

/** The fields of a rule a write sends (null clears; left out: unchanged). Exactly one of team and technician. */
export interface RuleFields {
  machineClassId?: string | null
  teamId?: string | null
  technicianId?: string | null
  push?: boolean
  escalateAfterMinutes?: number | null
  escalateToId?: string | null
  escalateAgainAfterMinutes?: number | null
  escalateAgainToId?: string | null
  active?: boolean
}

/** POST /plant/settings/routing (plant.settings.manage): a rule at the end of the site's list; every rule back. */
export const addRule = async (api: ApiClient, body: RuleFields & { siteId: string }, idempotencyKey: string) => (await api.post('/plant/settings/routing', { body, schema: rulesAnswer, idempotencyKey })).rules

/** PATCH /plant/settings/routing/:ruleId: a change of one rule at the version read. */
export const changeRule = async (api: ApiClient, ruleId: string, body: RuleFields & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/plant/settings/routing/${seg(ruleId)}`, { body, schema: rulesAnswer, idempotencyKey })).rules

/** POST /plant/settings/routing/:ruleId/remove: deleted when no request names it, else switched off (it stays). */
export const removeRule = (api: ApiClient, ruleId: string, version: number, idempotencyKey: string) =>
  api.post(`/plant/settings/routing/${seg(ruleId)}/remove`, { body: { version }, schema: z.object({ outcome: z.enum(['DELETED', 'SWITCHED_OFF']), rules: z.array(ruleSchema) }), idempotencyKey })

/** POST /plant/settings/routing/order: every rule of the site, in its new order, each at the version read. */
export const orderRules = async (api: ApiClient, siteId: string, rules: readonly { id: string; version: number }[], idempotencyKey: string) =>
  (await api.post('/plant/settings/routing/order', { body: { siteId, rules }, schema: rulesAnswer, idempotencyKey })).rules

// ---- the unsafe lock --------------------------------------------------------------------------------------------------------

export const LOCK_BY = ['ANYONE_AT_STATION', 'LEADS_AND_TECHNICIANS'] as const
export const SIGN_SAFE_BY = ['TECHNICIANS', 'TECHNICIANS_AND_SAFETY_OFFICER'] as const
export type LockBy = (typeof LOCK_BY)[number]
export type SignSafeBy = (typeof SIGN_SAFE_BY)[number]

const lockAnswer = z.object({
  siteId: z.string(),
  lockBy: z.enum(LOCK_BY),
  signSafeBy: z.enum(SIGN_SAFE_BY),
  hazardReportOnLock: z.boolean(),
  /** null: the site has no row yet (Owner answer H1's defaults); a save sends null to make it. */
  version: z.number().nullable(),
  canManage: z.boolean(),
})
export type LockRead = z.infer<typeof lockAnswer>

/** GET /plant/settings/lock?siteId (plant.view). */
export const readLock = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/plant/settings/lock', { query: { siteId }, schema: lockAnswer, signal })

export interface LockBody {
  siteId: string
  version: number | null
  lockBy?: LockBy
  signSafeBy?: SignSafeBy
  hazardReportOnLock?: boolean
}

/** PUT /plant/settings/lock (plant.settings.manage): H1 held (other choices 409 refusal/H1_HELD); a loosening asks the code. */
export const saveLock = (api: ApiClient, body: LockBody, idempotencyKey: string) => api.request('PUT', '/plant/settings/lock', { body, schema: lockAnswer, idempotencyKey })

// ---- statutory check types ----------------------------------------------------------------------------------------------------

export const INTERVAL_UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const
export type IntervalUnit = (typeof INTERVAL_UNITS)[number]

export const checkTypeSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  /** The law or standard it rests on, in the office's words (LawRef). */
  legalBasis: z.string(),
  machineClass: classBrief.nullable(),
  defaultInterval: z.number(),
  defaultIntervalUnit: z.enum(INTERVAL_UNITS),
  outsideBody: z.boolean(),
  retentionYears: z.number(),
  /** How long its results are kept: the type's years, at least the law's. */
  keptYears: z.number(),
  sortOrder: z.number(),
  active: z.boolean(),
  /** Its ACTIVE plans and every result recorded. */
  plans: z.number(),
  results: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type CheckType = z.infer<typeof checkTypeSchema>

const typesAnswer = z.object({ types: z.array(checkTypeSchema), canManage: z.boolean(), leastRetentionYears: z.number() })
export type CheckTypesRead = z.infer<typeof typesAnswer>

/** GET /plant/checks/types (plant.view): the group's types in order, retired ones too. */
export const readCheckTypes = (api: ApiClient, signal?: AbortSignal) => api.get('/plant/checks/types', { schema: typesAnswer, signal })

export interface CheckTypeFields {
  labelIt?: string
  labelEn?: string
  legalBasis?: string
  defaultInterval?: number
  defaultIntervalUnit?: IntervalUnit
  outsideBody?: boolean
  retentionYears?: number
  active?: boolean
}

/** POST /plant/checks/types (plant.checks.manage over every company): code and class never change after. */
export const createCheckType = async (api: ApiClient, body: Required<Omit<CheckTypeFields, 'active'>> & { code: string; classId: string | null }, idempotencyKey: string) =>
  (await api.post('/plant/checks/types', { body, schema: z.object({ type: checkTypeSchema }), idempotencyKey })).type

/** PATCH /plant/checks/types/:checkTypeId: a change at the version read; `active: false` retires it, `true` restores it. */
export const updateCheckType = async (api: ApiClient, checkTypeId: string, body: CheckTypeFields & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/plant/checks/types/${seg(checkTypeId)}`, { body, schema: z.object({ type: checkTypeSchema }), idempotencyKey })).type

// ---- incidents (read only) -----------------------------------------------------------------------------------------------------

export const INCIDENT_KINDS = ['INJURY', 'NEAR_MISS', 'HAZARD'] as const
export type IncidentKind = (typeof INCIDENT_KINDS)[number]

const incidentRulesAnswer = z.object({
  rule: z.object({
    law: z.string(),
    statisticalFromDays: z.number(),
    insuranceAboveDays: z.number(),
    hoursAfterCertificate: z.number(),
    words: z.object({ en: z.array(z.string()), it: z.array(z.string()) }),
  }),
  reminders: z.object({ hoursBefore: z.array(z.number()) }),
  floor: z.object({ anonymousKinds: z.array(z.enum(INCIDENT_KINDS)), photos: z.number(), photoMinutes: z.number(), emergencyNumber: z.string() }),
  law: z.object({ incident: z.string(), people: z.string() }),
})
export type IncidentRules = z.infer<typeof incidentRulesAnswer>

/** GET /safety/incidents/rules (safety.incidents.view): the INAIL rule with its law, Nexus's reminder hours, the tablet's limits. */
export const readIncidentRules = (api: ApiClient, signal?: AbortSignal) => api.get('/safety/incidents/rules', { schema: incidentRulesAnswer, signal })

// ---- pickers (people.view) -----------------------------------------------------------------------------------------------------

const teamSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type TeamPick = z.infer<typeof teamSchema>
const employeeSchema = z.object({ id: z.string(), displayName: z.string(), status: z.string(), site: z.object({ id: z.string(), code: z.string().optional(), name: z.string().optional() }).passthrough().nullable().optional() })
export type EmployeePick = z.infer<typeof employeeSchema>

/** GET /people/teams?siteId (people.view): the site's active teams. */
export const readTeams = async (api: ApiClient, siteId: string, signal?: AbortSignal) => (await api.get('/people/teams', { query: { siteId }, schema: z.object({ teams: z.array(teamSchema) }), signal })).teams

/** GET /people/employees (people.view): the company's people not left (first 500 by name); the rule names an active one. */
export const readEmployees = async (api: ApiClient, signal?: AbortSignal) =>
  (await api.get('/people/employees', { query: { limit: 500 }, schema: z.object({ employees: z.array(employeeSchema) }), signal })).employees.filter((entry) => entry.status === 'ACTIVE')

// ---- audit log (audit.read) ----------------------------------------------------------------------------------------------------

const auditEntry = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  actorName: z.string().nullable(),
  recordType: z.string(),
  recordId: z.string(),
  siteId: z.string().nullable(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().nullable(),
})
export type AuditEntry = z.infer<typeof auditEntry>

/** The record types these settings write (each read on its own, newest first); the routing order is written on the Site. */
export const HISTORY_TYPES = ['RequestRoutingRule', 'PlantSettings', 'MachineCheckType', 'MachineSymptom', 'MachineClass'] as const

/** Every change of Plant settings the person may read (audit.read), newest first, at most 100 of each kind. */
export async function readHistory(api: ApiClient, signal?: AbortSignal): Promise<AuditEntry[]> {
  const page = z.object({ entries: z.array(auditEntry) })
  const pages = await Promise.all([
    ...HISTORY_TYPES.map((recordType) => api.get('/audit', { query: { recordType, limit: 100 }, schema: page, signal })),
    api.get('/audit', { query: { action: 'plant.orderRoutingRules', limit: 100 }, schema: page, signal }),
  ])
  const seen = new Set<string>()
  return pages
    .flatMap((entry) => entry.entries)
    .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
    .sort((a, b) => b.at.localeCompare(a.at))
}
