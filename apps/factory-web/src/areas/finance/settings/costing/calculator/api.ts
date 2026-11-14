import { z } from 'zod'
import { applyCalcAnswer, calcRecordView, calcView, prefillView, type CalcRecordView, type CalcView, type PrefillView } from '@nexus/factory-domain/costing/cost-per-minute/contracts'
import { overheadRulesAnswer, type OverheadRuleView } from '@nexus/factory-domain/costing/overhead-rules/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The cost-per-minute calculator's calls (B-W2b-430 on B-W2b-419's routes; design finance.settings sec:costing
 * "Cost-per-minute calculator (W2b): labour ÷ available minutes + overhead"): the company's calculations, the minutes of a
 * department for a period (the calendars × the planned seats; never a headcount), a calculation kept, one applied as the
 * department's labour rate from a day, one removed while not applied, and the overhead rules in force. Reads costing.view,
 * writes costing.rates.manage; every figure money.cost (dropped without the grain). The API's English words are not drawn.
 */

const enc = encodeURIComponent

export type { CalcRecordView, CalcView, OverheadRuleView, PrefillView }

export async function listCalcs(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<CalcView[]> {
  return (await api.get('/costing/cost-per-minute', { query: { companyId, limit: 50 }, schema: z.object({ calcs: z.array(calcView), nextCursor: z.string().nullable() }), signal })).calcs
}

export async function prefill(api: ApiClient, query: { companyId: string; workCentreKind: string; workCentreId?: string; periodStart: string; periodEnd: string }, signal?: AbortSignal): Promise<PrefillView> {
  return (await api.get('/costing/cost-per-minute/prefill', { query, schema: z.object({ prefill: prefillView }), signal })).prefill
}

export interface NewCalc {
  companyId: string
  workCentreKind: string
  workCentreId?: string
  periodStart: string
  periodEnd: string
  directLabourCost: string
  availableMinutes: string
  indirectPerMinute?: string
  overheadPerMinute?: string
  minutesBasis?: Record<string, unknown>
  note?: string
}

export async function createCalc(api: ApiClient, body: NewCalc, idempotencyKey: string): Promise<CalcRecordView> {
  return (await api.post('/costing/cost-per-minute', { body, schema: z.object({ calc: calcRecordView }), idempotencyKey })).calc
}

export async function applyCalc(api: ApiClient, calc: Pick<CalcView, 'id' | 'version'>, body: { validFrom: string; plannedEfficiencyPct?: string; note?: string }, idempotencyKey: string): Promise<void> {
  await api.post(`/costing/cost-per-minute/${enc(calc.id)}/apply`, { body: { version: calc.version, ...body }, schema: applyCalcAnswer, idempotencyKey })
}

export async function removeCalc(api: ApiClient, calc: Pick<CalcView, 'id' | 'version'>): Promise<void> {
  await api.request('DELETE', `/costing/cost-per-minute/${enc(calc.id)}`, { query: { version: calc.version }, idempotencyKey: newIdempotencyKey() })
}

/** The company's own rules and every company's, active (in force today or later). */
export async function listOverheadRules(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<OverheadRuleView[]> {
  return (await api.get('/costing/overhead-rules', { query: { companyId, status: 'ACTIVE' }, schema: overheadRulesAnswer, signal })).rules
}
