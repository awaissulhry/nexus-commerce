import { z } from 'zod'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Production › Settings › Floor rules & codes (SCR-074), with the answer's shape checked (zod; unknown
 * fields are dropped). The shapes mirror apps/factory-api modules/production/settings/contract.ts and, for the reason
 * codes, modules/production/scans (`GET /production/scans/reasons`). The API's English (`status.notes`, `ifSwitched.words`,
 * `words`) is never drawn: the page says its own words from the codes and the counts. Notice acknowledgements are read
 * as COUNTS only (Owner answer W1): the names the API gives a manager are not read.
 */

const subject = z.enum(SCAN_SUBJECTS)
export type ScanSubject = z.infer<typeof subject>
const basisKind = z.enum(MONITORING_BASES)
export type BasisKind = z.infer<typeof basisKind>

const siteSchema = z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() })
export type RulesSite = z.infer<typeof siteSchema>
const rulesSchema = z.object({
  scanSubject: subject,
  isDefault: z.boolean(),
  legalBasis: z.object({ kind: basisKind, reference: z.string(), recordedAt: z.string(), recordedById: z.string().nullable(), recordedByName: z.string().nullable() }).nullable(),
  standardBundleSize: z.number(),
  version: z.number().nullable(),
  updatedAt: z.string().nullable(),
})
export type Rules = z.infer<typeof rulesSchema>
const statusSchema = z.object({ readyForFloor: z.boolean() })
const affectedSchema = z.object({ openWorkOrders: z.number(), workersActive: z.number(), workersNotAcknowledged: z.number(), devicesWithoutStation: z.number() })
export type Affected = z.infer<typeof affectedSchema>

const siteRulesSchema = z.object({ site: siteSchema, rules: rulesSchema, status: statusSchema })
export type SiteRules = z.infer<typeof siteRulesSchema>
const detailSchema = siteRulesSchema.extend({ affected: affectedSchema })
export type RulesDetail = z.infer<typeof detailSchema>
const changeSchema = detailSchema.extend({ changed: z.boolean(), change: z.enum(['WIDENED', 'NARROWED', 'BASIS_RECORDED', 'BASIS_REPLACED']).nullable() })
export type ChangeAnswer = z.infer<typeof changeSchema>

const seg = (value: string) => encodeURIComponent(value)

/** The sites in the person's scope with their floor rules (production.settings.view). */
export const listRules = async (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  (await api.get('/production/settings', { query: { companyId: companyId ?? undefined }, schema: z.object({ sites: z.array(siteRulesSchema) }), signal })).sites

/** One site's rules with the counts a change reaches. */
export const getRules = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/production/settings/${seg(siteId)}`, { schema: detailSchema, signal })

const acksSchema = z.object({
  workers: z.object({ active: z.number(), acknowledged: z.number(), notAcknowledged: z.number() }),
  versions: z.array(z.object({ noticeVersion: z.string(), workers: z.number() })),
})
export type NoticeAcks = z.infer<typeof acksSchema>
/** How many workers acknowledged the notice in force, and per version (counts only; names are never read here). */
export const noticeAcks = (api: ApiClient, siteId: string, signal?: AbortSignal) => api.get(`/production/settings/${seg(siteId)}/notice-acks`, { schema: acksSchema, signal })

export interface LegalBasisBody {
  kind: BasisKind
  reference: string
}

/** production.settings.manage: who floor records name from now on; widening asks a fresh code (403 `stepUp`). */
export const changeScanSubject = (api: ApiClient, siteId: string, body: { scanSubject: ScanSubject; reason?: string; legalBasis?: LegalBasisBody; version?: number }, idempotencyKey: string) =>
  api.post(`/production/settings/${seg(siteId)}/scan-subject`, { body, schema: changeSchema, idempotencyKey })

/** production.settings.manage: records or replaces the legal basis (never removes it; no code asked). */
export const recordLegalBasis = (api: ApiClient, siteId: string, body: LegalBasisBody & { version?: number }, idempotencyKey: string) =>
  api.post(`/production/settings/${seg(siteId)}/legal-basis`, { body, schema: changeSchema, idempotencyKey })

/** production.settings.manage: the site's standard bundle size (1–500, audited, no code asked). */
export const changeBundleSize = (api: ApiClient, siteId: string, body: { standardBundleSize: number; version?: number }, idempotencyKey: string) =>
  api.post(`/production/settings/${seg(siteId)}/bundle-size`, { body, schema: changeSchema, idempotencyKey })

const reasonSchema = z.object({ kind: z.enum(['SCRAP', 'REWORK']), code: z.string(), label: z.object({ it: z.string(), en: z.string() }), sortOrder: z.number() })
export type ScanReason = z.infer<typeof reasonSchema>
/** The tenant's scrap and rework reasons as the operation screen offers them (production.scan; read only in W1). */
export const listReasons = async (api: ApiClient, signal?: AbortSignal) => (await api.get('/production/scans/reasons', { schema: z.object({ reasons: z.array(reasonSchema) }), signal })).reasons

/** The step-up: a fresh authenticator code opens risky changes on this session for five minutes. */
export const stepUp = (api: ApiClient, code: string) => api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
