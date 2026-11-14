import { toUtcIso, businessDate } from '@nexus/factory-domain/core/time'
import { KIND_RULES, SEVERITIES, type AttentionKind, type Severity } from '@nexus/factory-domain/insights/attention'
import { NEEDS_ACTION_ROWS, ON_TIME_KPI, ON_TIME_TARGET, ON_TIME_WEEKS, WIP_KPI } from '@nexus/factory-domain/insights/dashboards/boards'
import { WIP_AGE_BUCKETS, type WipAgeBucket } from '@nexus/factory-domain/insights/kpis/wip'
import { kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import { periodsBack } from '@nexus/factory-domain/insights/periods/periods'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { wipDrill } from '../kpis/drills/wip'
import { kpiReading, markedValue, type KpiReading } from '../kpis/value'
import { today } from '../today'
import { checkScope, dashboardActor, type Scope } from './picker'

/**
 * A dashboard's other panels (B-W2b-434; design home.dashboards `needs-action` and `trends`), each read and failing on its own:
 *
 *   needs action   the exceptions on the person's Today in the scope (the ALERT rows: exception rules and the checks they
 *                  replace, ANA-036's sources), by kind, the worst first, at most five kinds, and how many in all ("See all N")
 *   trends         "Are we shipping on time?": the on-time KPI per week for 12 weeks, one line per company when no company is
 *                  chosen (shipments are kept per company), with the target line
 *   wip            "Is work piling up?": the garments waiting at each stage now with their age bands, from the work-in-progress
 *                  KPI's own records (kpis/drills/wip.ts, the same reader), a flow strip rather than a chart
 *
 * Read only; nothing here names a person.
 */

const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity)

/** GET /insights/dashboards/needs-action */
export async function needsActionAnswer(caller: CommandCaller, query: Scope) {
  const actor = dashboardActor(caller)
  const scope = await checkScope(caller, actor, query)
  const answer = await today(caller, { category: 'ALERT', include: ['ALERTS'], companyId: scope.companyId, siteId: scope.siteId, limit: 1000 })
  const worst = new Map<AttentionKind, { severity: Severity; oldestDays: number | null }>()
  for (const item of answer.items) {
    const before = worst.get(item.kind)
    const severity = before && severityRank(before.severity) <= severityRank(item.severity) ? before.severity : item.severity
    const oldestDays = Math.max(before?.oldestDays ?? -1, item.ageDays ?? -1)
    worst.set(item.kind, { severity, oldestDays: oldestDays < 0 ? null : oldestDays })
  }
  const kinds = answer.counts.byKind
    .filter((entry) => entry.count > 0 && KIND_RULES[entry.kind].category === 'ALERT')
    .map((entry) => ({ kind: entry.kind, count: entry.count, complete: entry.complete, severity: worst.get(entry.kind)?.severity ?? 'LOW', oldestDays: worst.get(entry.kind)?.oldestDays ?? null }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count || (a.kind < b.kind ? -1 : 1))
  const alerts = answer.counts.tiles.find((tile) => tile.tile === 'ALERT')
  return {
    asOf: answer.asOf,
    rows: kinds.slice(0, NEEDS_ACTION_ROWS),
    all: alerts?.count ?? 0,
    complete: alerts?.complete ?? true,
  }
}

const freshnessOf = (reading: KpiReading) => ({
  currency: reading.currency,
  converted: reading.converted,
  asOf: reading.asOf ? toUtcIso(reading.asOf) : null,
  stale: reading.stale,
  live: reading.live,
  missingDays: reading.missingDays,
  problem: reading.problem,
})

/** GET /insights/dashboards/trends */
export async function trendsAnswer(caller: CommandCaller, query: Scope) {
  const actor = dashboardActor(caller)
  const scope = await checkScope(caller, actor, query)
  const file = kpiFileOf(ON_TIME_KPI)!
  const weeks = periodsBack('WEEK', businessDate(serverClock.now()), ON_TIME_WEEKS)
  // The scope's own line (every company I reach, or the one chosen), then one per company when several are read.
  const overall = await kpiReading(caller, actor, file, weeks, { companyId: scope.companyId })
  const series = []
  if (!scope.companyId && scope.companies.length > 1) {
    for (const company of scope.companies) {
      const reading = await kpiReading(caller, actor, file, weeks, { companyId: company.id })
      series.push({ company: { id: company.id, code: company.code, name: company.name }, values: reading.values.map((value) => markedValue(file, value)) })
    }
  }
  return {
    kpi: { kpiKey: file.key, unit: file.unit, grain: file.grain, name: { it: file.words.nameIt, en: file.words.nameEn } },
    target: ON_TIME_TARGET,
    weeks: weeks.map((week) => ({ kind: week.kind, key: week.key, from: week.from, to: week.to })),
    values: overall.values.map((value) => markedValue(file, value)),
    series,
    ...freshnessOf(overall),
  }
}

/** GET /insights/dashboards/wip */
export async function wipAnswer(caller: CommandCaller, query: Scope) {
  const actor = dashboardActor(caller)
  const scope = await checkScope(caller, actor, query)
  const sites = scope.siteId ? [scope.siteId] : scope.companyId ? (scope.companies.find((company) => company.id === scope.companyId)?.sites ?? []).map((site) => site.id) : [undefined]
  const overall = { workOrders: 0, pieces: 0, waiting: 0 }
  const stages = new Map<string, { code: string; name: string; workOrders: number; waiting: number; ageing: Record<WipAgeBucket, number>; at: number }>()
  for (const siteId of sites) {
    const drill = await wipDrill(caller, { siteId })
    overall.workOrders += drill.overall.workOrders
    overall.pieces += drill.overall.pieces
    overall.waiting += drill.overall.waiting
    // The routing's order: the earliest place a stage takes in a work order's own operations.
    const at = new Map<string, number>()
    for (const row of drill.rows) row.stages.forEach((stage, index) => at.set(stage.code, Math.min(at.get(stage.code) ?? index, index)))
    for (const stage of drill.stages) {
      const entry = stages.get(stage.operation.code) ?? { code: stage.operation.code, name: stage.operation.name, workOrders: 0, waiting: 0, ageing: Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, 0])) as Record<WipAgeBucket, number>, at: Number.MAX_SAFE_INTEGER }
      entry.workOrders += stage.workOrders
      entry.waiting += stage.waiting
      for (const bucket of WIP_AGE_BUCKETS) entry.ageing[bucket] += stage.ageing[bucket]
      entry.at = Math.min(entry.at, at.get(stage.operation.code) ?? Number.MAX_SAFE_INTEGER)
      stages.set(stage.operation.code, entry)
    }
  }
  return {
    asOf: toUtcIso(serverClock.now()),
    kpiKey: WIP_KPI,
    overall,
    stages: [...stages.values()].sort((a, b) => a.at - b.at || a.code.localeCompare(b.code)).map(({ code, name, workOrders, waiting, ageing }) => ({ code, name, workOrders, waiting, ageing })),
  }
}
