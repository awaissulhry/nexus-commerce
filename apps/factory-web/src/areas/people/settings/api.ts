import { z } from 'zod'
import { ABSENCE_CATEGORIES } from '@nexus/factory-domain/people/attendance/absences'
import { RULE_ACTIONS, RULE_KINDS, RULE_SOURCES } from '@nexus/factory-domain/people/limits/rules'
import { MISSING_CODES } from '@nexus/factory-domain/people/privacy/gate'
import { GATE_PURPOSES } from '@nexus/factory-domain/people/privacy/purposes'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › People settings (SCR-265; B-W2b-65 on the API of B-W2b-37 rounding and absence codes, B-W2b-42
 * working-time limits, B-W2b-27 privacy), with the answer's shape checked (zod; unknown fields are dropped). No answer
 * here holds a figure about a person. The API's English is never drawn: the screens say their own words from codes.
 */

export type AbsenceCategory = (typeof ABSENCE_CATEGORIES)[number]
export type RuleKind = (typeof RULE_KINDS)[number]
export type RuleAction = (typeof RULE_ACTIONS)[number]
export type RuleSource = (typeof RULE_SOURCES)[number]
export type GatePurpose = (typeof GATE_PURPOSES)[number]
export type MonitoringBasis = (typeof MONITORING_BASES)[number]

const seg = (value: string) => encodeURIComponent(value)
const clean = <T extends Record<string, string | null | undefined>>(query: T) => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Record<string, string>

// ---- rounding, tolerance and grace ------------------------------------------------------------------------------------------

const roundingSchema = z.object({
  companyId: z.string(),
  version: z.number().nullable(),
  earlyClockInFromShiftStart: z.boolean(),
  lateGraceMinutes: z.number(),
  overtimeUnitMinutes: z.number(),
  roundingMinutes: z.number(),
  autoClockOutAfterMinutes: z.number().nullable(),
  fixedBreaks: z.boolean(),
})
export type Rounding = z.infer<typeof roundingSchema>

export const getRounding = (api: ApiClient, companyId: string) => api.get('/people/attendance/settings', { query: { companyId }, schema: roundingSchema })
export const saveRounding = (api: ApiClient, body: Rounding) => api.request('PUT', '/people/attendance/settings', { body, schema: roundingSchema, idempotencyKey: newIdempotencyKey() })

// ---- absence codes ----------------------------------------------------------------------------------------------------------

const codeSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  category: z.enum(ABSENCE_CATEGORIES),
  lulCode: z.string().nullable(),
  paid: z.boolean(),
  documentRequired: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  inUse: z.number(),
  version: z.number(),
})
export type AbsenceCode = z.infer<typeof codeSchema>

export const listCodes = (api: ApiClient, companyId: string | null) =>
  api.get('/people/attendance/absence-codes', { query: clean({ companyId, status: 'ALL' }), schema: z.object({ codes: z.array(codeSchema), standardMissing: z.array(z.string()) }) })

export interface CodeFields {
  labelI18n: Record<string, string>
  category: AbsenceCategory
  lulCode: string | null
  paid: boolean
  documentRequired: boolean
}

export const createCode = (api: ApiClient, body: CodeFields & { companyId: string | null; code: string }) => api.post('/people/attendance/absence-codes', { body, schema: codeSchema, idempotencyKey: newIdempotencyKey() })
export const editCode = (api: ApiClient, id: string, body: CodeFields & { version: number }) => api.request('PATCH', `/people/attendance/absence-codes/${seg(id)}`, { body, schema: codeSchema, idempotencyKey: newIdempotencyKey() })
export const setCodeState = (api: ApiClient, id: string, to: 'archive' | 'restore', version: number) => api.post(`/people/attendance/absence-codes/${seg(id)}/${to}`, { body: { version }, schema: codeSchema, idempotencyKey: newIdempotencyKey() })
export const addStandardCodes = (api: ApiClient, companyId: string | null) =>
  api.post('/people/attendance/absence-codes/standard', { body: { companyId }, schema: z.object({ added: z.array(codeSchema), skipped: z.array(z.string()) }), idempotencyKey: newIdempotencyKey() })

// ---- working-time limits ----------------------------------------------------------------------------------------------------

const ruleSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  kind: z.enum(RULE_KINDS),
  limitMinutes: z.number(),
  breakMinutes: z.number().nullable(),
  referenceMonths: z.number().nullable(),
  action: z.enum(RULE_ACTIONS),
  alertRoles: z.array(z.string()),
  source: z.enum(RULE_SOURCES),
  legalReference: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
})
export type LimitRule = z.infer<typeof ruleSchema>

const limitsSchema = z.object({
  companyId: z.string().nullable(),
  siteId: z.string().nullable(),
  limits: z.array(
    z.object({
      kind: z.enum(RULE_KINDS),
      inForce: ruleSchema.nullable(),
      own: ruleSchema.nullable(),
      law: z.object({ limitMinutes: z.number(), breakMinutes: z.number().nullable(), referenceMonths: z.number().nullable(), legalReference: z.string() }),
    }),
  ),
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
  canManage: z.boolean(),
})
export type Limits = z.infer<typeof limitsSchema>
export type LimitEntry = Limits['limits'][number]

export const getLimits = (api: ApiClient, query: { companyId: string | null; siteId: string | null }) => api.get('/people/limits', { query: clean(query), schema: limitsSchema })

export interface LimitBody {
  companyId: string | null
  siteId: string | null
  kind: RuleKind
  version: number | null
  limitMinutes: number
  breakMinutes: number | null
  referenceMonths: number | null
  action: RuleAction
  alertRoles: string[]
  source: RuleSource
  legalReference: string
}

export const saveLimit = (api: ApiClient, body: LimitBody) => api.request('PUT', '/people/limits', { body, schema: ruleSchema, idempotencyKey: newIdempotencyKey() })
export const archiveLimit = (api: ApiClient, ruleId: string, version: number) => api.post(`/people/limits/${seg(ruleId)}/archive`, { body: { version }, schema: ruleSchema, idempotencyKey: newIdempotencyKey() })

// ---- the privacy of people data ---------------------------------------------------------------------------------------------

const basis = z.object({ kind: z.enum(MONITORING_BASES), reference: z.string() })
const dpia = z.object({ id: z.string(), versionNo: z.number(), status: z.string(), signedByName: z.string().nullable(), signedOn: z.string().nullable(), reviewDueOn: z.string().nullable() })

const gateSchema = z.object({
  id: z.string(),
  purpose: z.enum(GATE_PURPOSES),
  basis,
  basisCoversLeads: z.boolean(),
  leadsSeeFigures: z.boolean(),
  notice: z.object({ id: z.string(), label: z.string(), status: z.string() }),
  dpia,
  switchedOnAt: z.string(),
  switchedOnByName: z.string().nullable(),
  switchedOffAt: z.string().nullable(),
  switchedOffByName: z.string().nullable(),
  switchOffReason: z.string().nullable(),
  version: z.number(),
})
export type Gate = z.infer<typeof gateSchema>

const purposeSchema = z.object({
  purpose: z.enum(GATE_PURPOSES),
  open: z.boolean(),
  gate: gateSchema.nullable(),
  readiness: z.object({ canSwitchOn: z.boolean(), missing: z.array(z.object({ code: z.enum(MISSING_CODES) })), notes: z.array(z.string()) }),
  notes: z.array(z.string()),
})
export type PurposeView = z.infer<typeof purposeSchema>

const siteDetail = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  scanSubject: z.enum(SCAN_SUBJECTS),
  siteBasis: basis.nullable(),
  workerNotice: z.object({ id: z.string(), label: z.string() }).nullable(),
  dpia: dpia.nullable(),
  purposes: z.array(purposeSchema),
  history: z.array(gateSchema),
})
export type SitePrivacy = z.infer<typeof siteDetail>

const settings = z.object({ minimumGroupSize: z.number(), figureRoleKeys: z.array(z.string()), version: z.number().nullable() })
const overviewSchema = z.object({ sites: z.array(z.object({ site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }) })), companies: z.array(z.object({ company: z.object({ id: z.string(), code: z.string(), name: z.string() }), settings })) })

export const getPrivacy = (api: ApiClient, companyId: string | null) => api.get('/people/privacy', { query: clean({ companyId }), schema: overviewSchema })
export const getSitePrivacy = (api: ApiClient, siteId: string) => api.get(`/people/privacy/sites/${seg(siteId)}`, { schema: siteDetail })

const companySchema = z.object({
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  settings,
  named: z.array(z.object({ key: z.string(), name: z.string().nullable() })),
  roles: z.array(z.object({ key: z.string(), name: z.string(), system: z.boolean() })),
})
export type CompanyPrivacy = z.infer<typeof companySchema>

export const getCompanyPrivacy = (api: ApiClient, companyId: string) => api.get(`/people/privacy/companies/${seg(companyId)}`, { schema: companySchema })
export const saveCompanyPrivacy = (api: ApiClient, companyId: string, body: { minimumGroupSize: number; figureRoleKeys: string[]; reason?: string | null; version?: number }, idempotencyKey: string) =>
  api.post(`/people/privacy/companies/${seg(companyId)}`, { body, schema: companySchema.extend({ changed: z.boolean() }), idempotencyKey })

const changeResult = siteDetail.extend({ changed: z.boolean() })
const gatePath = (siteId: string, purpose: GatePurpose, verb: string) => `/people/privacy/sites/${seg(siteId)}/purposes/${seg(purpose)}/${verb}`

export const switchOn = (api: ApiClient, siteId: string, purpose: GatePurpose, body: { basis?: { kind: string; reference: string }; basisCoversLeads?: boolean; leadsSeeFigures?: boolean; reason: string }, idempotencyKey: string) =>
  api.post(gatePath(siteId, purpose, 'switch-on'), { body, schema: changeResult, idempotencyKey })
export const switchOff = (api: ApiClient, siteId: string, purpose: GatePurpose, body: { version: number; reason: string }) => api.post(gatePath(siteId, purpose, 'switch-off'), { body, schema: changeResult, idempotencyKey: newIdempotencyKey() })
export const changeLeads = (api: ApiClient, siteId: string, purpose: GatePurpose, body: { version: number; leadsSeeFigures: boolean; reason?: string | null }, idempotencyKey: string) =>
  api.post(gatePath(siteId, purpose, 'leads'), { body, schema: changeResult, idempotencyKey })

// ---- history ----------------------------------------------------------------------------------------------------------------

const auditEntry = z.object({ id: z.string(), at: z.string(), action: z.string(), actorName: z.string().nullable(), recordType: z.string(), reason: z.string().nullable() })
export type HistoryEntry = z.infer<typeof auditEntry>

/** The record types these settings write (audit.read); each is read on its own, newest first. */
export const HISTORY_TYPES = ['PeopleSettings', 'AbsenceCode', 'WorkingTimeRule', 'PeopleLegalGate'] as const

export const settingsHistory = async (api: ApiClient): Promise<HistoryEntry[]> => {
  const pages = await Promise.all(HISTORY_TYPES.map((recordType) => api.get('/audit', { query: { recordType, limit: 100 }, schema: z.object({ entries: z.array(auditEntry) }) })))
  return pages.flatMap((page) => page.entries).sort((a, b) => b.at.localeCompare(a.at))
}
