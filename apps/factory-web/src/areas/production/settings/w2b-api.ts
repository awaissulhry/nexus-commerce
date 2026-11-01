import { z } from 'zod'
import { CALL_KINDS, type CallKind } from '@nexus/factory-domain/production/calls/rules'
import { OFF_STANDARD_KINDS, PAY_RULES, type OffStandardKind, type PayRule } from '@nexus/factory-domain/production/offstandard/rules'
import { BUNDLE_CODE_MODES, FLOOR_RULE_MODES, type BundleCodeMode, type FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import { FLOOR_REASON_LISTS } from '@nexus/factory-domain/production/settings/reason-lists'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The calls of the W2b sections of Floor rules & codes (B-W2b-58), each answer checked by its schema (zod drops what the
 * page does not read; the API's English words are never drawn):
 *  - Floor rules per site (B-W2b-53, MES-294): `GET|POST /production/settings/:siteId/floor-rules` (production.settings
 *    .view / .manage) — the sequence, the quantity guard and the scrap approval limit (pieces) are changed here; the fixed
 *    rules and idle sign-out are read.
 *  - Bundle codes (B-W2b-41, MES-067, MES-168): `GET|POST /production/bundles/sites/:siteId/rules` — one code at every
 *    operation or a coupon per operation; the hours after which a bundle with no scan is stuck.
 *  - The full reason lists (B-W2b-53, MES-293): `GET /production/settings/reasons`, `POST …/reasons/full`.
 *  - Off-standard codes (B-W2b-29, MES-155): `GET|POST /production/offstandard/codes`, `PATCH …/codes/:id`.
 *  - Help-call routing (B-W2b-35, MES-144): `GET|POST /production/calls/types`, `PATCH …/types/:id`; the site's teams
 *    (`GET /people/teams?siteId`, people.view; only id, code, name, line and status are read — never who is in them) and
 *    the help-call reason codes (`GET /reasons?list=HELP_CALL`).
 * The four parts of a site's floor rules share ONE version (ProductionSettings): every write sends the latest one read.
 */

const seg = (value: string) => encodeURIComponent(value)
const mode = z.enum(FLOOR_RULE_MODES)

// ---- floor rules per site -------------------------------------------------------------------------------------------------

export const floorRulesSchema = z.object({
  site: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  checks: z.object({ quantityGuard: mode, skippedOperationRule: mode, scrapApprovalLimit: z.number().nullable(), bundleCodeMode: z.enum(BUNDLE_CODE_MODES), stuckBundleHours: z.number() }),
  isDefault: z.boolean(),
  fixed: z.object({ undoWindowSeconds: z.number(), clockOffSeconds: z.number(), clockFlagSeconds: z.number(), offlineMaxHours: z.number().nullable(), offlineMaxActions: z.number().nullable(), onlineOnly: z.array(z.string()) }),
  idleSignOut: z.object({ idleMinutes: z.number(), shiftEnds: z.array(z.string()), badgeOnlySignIn: z.boolean(), isDefault: z.boolean() }),
  version: z.number().nullable(),
  updatedAt: z.string().nullable(),
  canManage: z.boolean(),
})
export type FloorRules = z.infer<typeof floorRulesSchema>

export const getFloorRules = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/production/settings/${seg(siteId)}/floor-rules`, { schema: floorRulesSchema, signal })

export interface FloorRulesBody {
  quantityGuard?: FloorRuleMode
  skippedOperationRule?: FloorRuleMode
  scrapApprovalLimit?: number | null
  reason?: string
  version?: number
}

/** production.settings.manage: the site's floor checks from now on (audited before → after with the reason). */
export const changeFloorRules = (api: ApiClient, siteId: string, body: FloorRulesBody, idempotencyKey: string) =>
  api.post(`/production/settings/${seg(siteId)}/floor-rules`, { body, schema: floorRulesSchema.extend({ changed: z.boolean() }), idempotencyKey })

// ---- bundle codes ---------------------------------------------------------------------------------------------------------

export const bundleRulesSchema = z.object({ site: z.object({ id: z.string(), code: z.string(), name: z.string() }), bundleCodeMode: z.enum(BUNDLE_CODE_MODES), stuckBundleHours: z.number(), version: z.number().nullable(), updatedAt: z.string().nullable(), changed: z.boolean() })
export type BundleRules = z.infer<typeof bundleRulesSchema>

export const getBundleRules = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/production/bundles/sites/${seg(siteId)}/rules`, { schema: bundleRulesSchema, signal })

/** production.settings.manage: one bundle code, or a coupon per operation; the stuck limit in working hours. */
export const changeBundleRules = (api: ApiClient, siteId: string, body: { bundleCodeMode?: BundleCodeMode; stuckBundleHours?: number; version?: number }, idempotencyKey: string) =>
  api.post(`/production/bundles/sites/${seg(siteId)}/rules`, { body, schema: bundleRulesSchema, idempotencyKey })

// ---- the full reason lists ------------------------------------------------------------------------------------------------

const listView = z.object({ list: z.enum(FLOOR_REASON_LISTS), active: z.number(), inactive: z.number(), fullMissing: z.array(z.string()) })
export const fullListsSchema = z.object({ lists: z.array(listView), canManage: z.boolean() })
export type FullLists = z.infer<typeof fullListsSchema>

export const getFullLists = (api: ApiClient, signal?: AbortSignal) => api.get('/production/settings/reasons', { schema: fullListsSchema, signal })

/** reasons.manage: adds the codes of the full floor lists each list lacks (at the end; never twice). */
export const addFullLists = (api: ApiClient, idempotencyKey: string) =>
  api.post('/production/settings/reasons/full', { body: {}, schema: fullListsSchema.extend({ added: z.array(z.object({ list: z.enum(FLOOR_REASON_LISTS), codes: z.array(z.string()) })) }), idempotencyKey })

// ---- off-standard codes ---------------------------------------------------------------------------------------------------

export const offCodeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  kind: z.enum(OFF_STANDARD_KINDS),
  payRule: z.enum(PAY_RULES),
  needsApproval: z.boolean(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  sortOrder: z.number(),
  active: z.boolean(),
  usedCount: z.number(),
  callTypes: z.array(z.string()),
  version: z.number(),
})
export type OffCode = z.infer<typeof offCodeSchema>

const offCodesSchema = z.object({ codes: z.array(offCodeSchema), languages: z.array(z.string()), canManage: z.boolean() })
export type OffCodes = z.infer<typeof offCodesSchema>

export const listOffCodes = (api: ApiClient, companyId: string | null, signal?: AbortSignal) => api.get('/production/offstandard/codes', { query: { companyId: companyId ?? undefined }, schema: offCodesSchema, signal })

export interface OffCodeEdit {
  labelIt?: string
  labelEn?: string
  labelI18n?: Record<string, string | null>
  payRule?: PayRule
  needsApproval?: boolean
  active?: boolean
  sortOrder?: number
}

/** production.offstandard.codes: one cell saved at the version read. */
export const editOffCode = async (api: ApiClient, id: string, body: OffCodeEdit & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/production/offstandard/codes/${seg(id)}`, { body, schema: z.object({ code: offCodeSchema }), idempotencyKey })).code

export interface NewOffCode {
  companyId: string
  code: string
  kind: OffStandardKind
  payRule: PayRule
  needsApproval: boolean
  labelIt: string
  labelEn: string
}

export const createOffCode = async (api: ApiClient, body: NewOffCode, idempotencyKey: string) => (await api.post('/production/offstandard/codes', { body, schema: z.object({ code: offCodeSchema }), idempotencyKey })).code

// ---- help-call routing ----------------------------------------------------------------------------------------------------

export const routeSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  code: z.string(),
  kind: z.enum(CALL_KINDS),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  codeListed: z.boolean(),
  responder: z.object({ kind: z.enum(['TEAM', 'TEAM_LEADERS']), team: z.object({ id: z.string(), code: z.string(), name: z.string(), active: z.boolean() }).nullable(), members: z.number() }),
  escalateAfterMinutes: z.number().nullable(),
  waitingCode: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }).nullable(),
  sortOrder: z.number(),
  active: z.boolean(),
  version: z.number(),
  usedCount: z.number(),
  openCount: z.number(),
})
export type Route = z.infer<typeof routeSchema>

const routesSchema = z.object({ site: z.object({ id: z.string(), code: z.string(), name: z.string() }), types: z.array(routeSchema), canManage: z.boolean() })
export type Routes = z.infer<typeof routesSchema>

export const listRoutes = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get('/production/calls/types', { query: { siteId }, schema: routesSchema, signal })

export interface RouteEdit {
  responderTeamId?: string | null
  escalateAfterMinutes?: number | null
  offStandardCodeId?: string | null
  sortOrder?: number
  active?: boolean
}

/** production.calls.manage: one cell of the routing saved at the version read (a type keeps its kind). */
export const editRoute = async (api: ApiClient, id: string, body: RouteEdit & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/production/calls/types/${seg(id)}`, { body, schema: z.object({ type: routeSchema }), idempotencyKey })).type

export interface NewRoute {
  siteId: string
  code: string
  kind: CallKind
  responderTeamId?: string | null
  escalateAfterMinutes?: number | null
}

export const createRoute = async (api: ApiClient, body: NewRoute, idempotencyKey: string) => (await api.post('/production/calls/types', { body, schema: z.object({ type: routeSchema }), idempotencyKey })).type

const teamSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']), line: z.object({ id: z.string(), code: z.string() }).nullable() })
export type SiteTeam = z.infer<typeof teamSchema>

/** The site's active teams (people.view): the routing's groups. Who is in a team is never read here. */
export const listTeams = async (api: ApiClient, siteId: string, signal?: AbortSignal) => (await api.get('/people/teams', { query: { siteId }, schema: z.object({ teams: z.array(teamSchema) }), signal })).teams

const helpCodeSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() })
export type HelpCode = z.infer<typeof helpCodeSchema>

/** The active codes of the help-call reason list (a new type is one of them). */
export const listHelpCodes = async (api: ApiClient, signal?: AbortSignal) => (await api.get('/reasons', { query: { list: 'HELP_CALL' }, schema: z.object({ reasons: z.array(helpCodeSchema) }), signal })).reasons
