import type { Department } from '../../../../../lib/department/model'
import type { DeptLook } from '../../routing/route/model'
import type { Words } from '../now/model'
import type { CostingSettings, CreateRate, RateRow, SaveSettings, SettingsRow } from './api'

/**
 * owb-pd5b step 5.4 (S4; design plan § 5zh; prototype cost.js costRates, crFields, crLim, costModal, costRatesSave) — the factory's rates,
 * ONE window for every product, its pure side: the cost of one minute in each department (the department's own rate wins over its
 * kind's; the kind's is shown as the fallback), the planned efficiency, the overhead in force, and the company switch "One person may
 * keep a cost" (only for the person who may change the costing settings: costing.rates.manage). What is sent: only what changed. No
 * React, no API.
 */

export const RATES_RIGHT = 'costing.rates.manage'

/** The fields change (and the switch shows) only for the person who may change the costing settings today. */
export const mayChangeRates = (can: (permission: string) => boolean): boolean => can(RATES_RIGHT)

export interface DeptRate {
  readonly departmentId: string
  readonly dept: Department
  readonly kind: string | null
  /** The department's own rate in force. */
  readonly own: RateRow | null
  /** Its kind's rate in force (the fallback). */
  readonly kindRate: RateRow | null
  /** Which one the cost sheet uses today. */
  readonly from: 'DEPARTMENT' | 'KIND' | 'NONE'
}

const inForce = (rate: RateRow) => rate.inForce && rate.status === 'ACTIVE'
/** Of two rates in force for the same thing, the company's own wins over the tenant-wide one. */
const best = (rates: readonly RateRow[]): RateRow | null => rates.find((rate) => rate.companyId !== null) ?? rates[0] ?? null

/** One row per open department, in the factory's order: its own rate, its kind's, and which one counts. */
export function deptRatesOf(looks: readonly DeptLook[], rates: readonly RateRow[]): DeptRate[] {
  return looks
    .filter((look) => !look.closed)
    .map((look): DeptRate => {
      const own = best(rates.filter((rate) => inForce(rate) && rate.departmentId === look.id))
      const kindRate = look.kind ? best(rates.filter((rate) => inForce(rate) && !rate.departmentId && rate.workCentreKind === look.kind)) : null
      return { departmentId: look.id, dept: look.dept, kind: look.kind, own, kindRate, from: own ? 'DEPARTMENT' : kindRate ? 'KIND' : 'NONE' }
    })
}

/** What is typed for a department ('' = keep what is there). */
export interface RateDraft {
  readonly cpm: string
  readonly eff: string
}

export interface RatesDraft {
  readonly depts: Readonly<Record<string, RateDraft>>
  readonly overhead: string
  readonly oneKeeper: boolean
  readonly reason: string
}

const DECIMAL = /^\d{1,6}(?:\.\d{1,6})?$/
const norm = (text: string): string => text.trim().replace(',', '.')
export const CPM_MAX = 5
export const EFF_MIN = 20
export const EFF_MAX = 100
export const OVERHEAD_MAX = 300

/**
 * The cost of one minute the window counts with for a department (its preview): what is typed, else the department's own rate, else
 * its kind's — the department's rate wins over the kind's. null: none known (or no cost grain).
 */
export function previewOf(row: DeptRate, draft: RateDraft | undefined): { readonly cpm: string | null; readonly eff: string | null; readonly from: 'TYPED' | 'DEPARTMENT' | 'KIND' | 'NONE' } {
  const typed = draft && DECIMAL.test(norm(draft.cpm)) ? norm(draft.cpm) : null
  if (typed) return { cpm: typed, eff: draft && DECIMAL.test(norm(draft.eff)) ? norm(draft.eff) : (row.own ?? row.kindRate)?.plannedEfficiencyPct ?? '100', from: 'TYPED' }
  if (row.own) return { cpm: row.own.costPerMinute ?? null, eff: row.own.plannedEfficiencyPct, from: 'DEPARTMENT' }
  if (row.kindRate) return { cpm: row.kindRate.costPerMinute ?? null, eff: row.kindRate.plannedEfficiencyPct, from: 'KIND' }
  return { cpm: null, eff: null, from: 'NONE' }
}

/** The overhead row in force (the company's own, else the tenant-wide one), and the company's switch. */
export function settingsInForce(settings: CostingSettings): { readonly row: SettingsRow | null; readonly oneKeeper: boolean } {
  const rows = [settings.settings.company, settings.settings.tenant]
  const row = rows.find((entry) => entry !== null && entry.id === settings.settings.inForce) ?? null
  const oneKeeper = settings.oneKeeperAllowed ?? settings.settings.company?.oneKeeperAllowed ?? settings.settings.tenant?.oneKeeperAllowed ?? false
  return { row, oneKeeper }
}

/** The draft the window opens with: nothing typed for the departments, the overhead and the switch as they are. */
export function draftOf(settings: CostingSettings): RatesDraft {
  const { row, oneKeeper } = settingsInForce(settings)
  return { depts: {}, overhead: row ? String(Number(row.overheadPct)) : '', oneKeeper, reason: '' }
}

/** Every field the window refuses, in words (the field's own; the cursor goes to the first). */
export function draftProblems(rows: readonly DeptRate[], draft: RatesDraft, settings: CostingSettings): Readonly<Record<string, Words>> {
  const problems: Record<string, Words> = {}
  for (const row of rows) {
    const typed = draft.depts[row.departmentId]
    if (!typed) continue
    const cpm = norm(typed.cpm)
    const eff = norm(typed.eff)
    if (cpm !== '' && (!DECIMAL.test(cpm) || Number(cpm) <= 0 || Number(cpm) > CPM_MAX)) problems[`cpm.${row.departmentId}`] = { key: 'rates.bad.cpm', params: { max: CPM_MAX } }
    if (eff !== '' && (!DECIMAL.test(eff) || Number(eff) < EFF_MIN || Number(eff) > EFF_MAX)) problems[`eff.${row.departmentId}`] = { key: 'rates.bad.eff', params: { min: EFF_MIN, max: EFF_MAX } }
    if (eff !== '' && cpm === '' && !row.own && !row.kindRate) problems[`cpm.${row.departmentId}`] = { key: 'rates.bad.cpmFirst' }
  }
  const overhead = norm(draft.overhead)
  if (overhead !== '' && (!DECIMAL.test(overhead) || Number(overhead) > OVERHEAD_MAX)) problems.overhead = { key: 'rates.bad.overhead', params: { max: OVERHEAD_MAX } }
  if (draft.oneKeeper !== settingsInForce(settings).oneKeeper && !draft.reason.trim()) problems.reason = { key: 'rates.bad.reason' }
  return problems
}

export type RateWrite = { readonly kind: 'create'; readonly body: CreateRate } | { readonly kind: 'update'; readonly rate: RateRow; readonly body: { costPerMinute: string; plannedEfficiencyPct: string } } | { readonly kind: 'settings'; readonly body: SaveSettings }

/**
 * What Save sends — only what changed: a department with its own rate is corrected (PATCH, its version); one that follows its kind gets
 * its own rate from today (POST with `departmentId`); the overhead and the switch in ONE settings write (the row in force; none: the
 * company's own), the switch with its reason.
 */
export function writesOf(rows: readonly DeptRate[], draft: RatesDraft, settings: CostingSettings, companyId: string | null, today: string): RateWrite[] {
  const writes: RateWrite[] = []
  for (const row of rows) {
    const typed = draft.depts[row.departmentId]
    if (!typed) continue
    const base = row.own ?? row.kindRate
    const cpm = norm(typed.cpm) || row.own?.costPerMinute || ''
    const eff = norm(typed.eff) || base?.plannedEfficiencyPct || '100'
    if (!cpm) continue
    if (row.own) {
      if (Number(cpm) === Number(row.own.costPerMinute ?? NaN) && Number(eff) === Number(row.own.plannedEfficiencyPct)) continue
      writes.push({ kind: 'update', rate: row.own, body: { costPerMinute: cpm, plannedEfficiencyPct: eff } })
    } else if (norm(typed.cpm) !== '' && row.kind) {
      writes.push({ kind: 'create', body: { companyId, workCentreKind: row.kind, departmentId: row.departmentId, costPerMinute: cpm, plannedEfficiencyPct: eff, validFrom: today } })
    }
  }
  const { row, oneKeeper } = settingsInForce(settings)
  const overhead = norm(draft.overhead)
  const overheadChanged = overhead !== '' && (row === null || Number(overhead) !== Number(row.overheadPct))
  const keeperChanged = draft.oneKeeper !== oneKeeper
  if (overheadChanged || keeperChanged) {
    const target = row ?? null
    writes.push({
      kind: 'settings',
      body: {
        companyId: target ? target.companyId : companyId,
        overheadPct: overhead !== '' ? overhead : (target?.overheadPct ?? '0'),
        ...(target ? { version: target.version } : {}),
        ...(keeperChanged ? { oneKeeperAllowed: draft.oneKeeper, reason: draft.reason.trim() } : {}),
      },
    })
  }
  return writes
}

/** Why Save waits: a field refused (its words), nothing changed, a write running; null: it saves. */
export function ratesHeldOf(problems: Readonly<Record<string, Words>>, writes: readonly RateWrite[], busy: boolean): Words | null {
  if (busy) return { key: 'rates.held.busy' }
  const first = Object.values(problems)[0]
  if (first) return first
  if (writes.length === 0) return { key: 'rates.held.same' }
  return null
}
