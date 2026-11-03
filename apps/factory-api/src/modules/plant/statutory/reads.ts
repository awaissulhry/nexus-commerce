import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { MachineStatus } from '@nexus/factory-domain/plant/rules'
import { PLANT_CHECKS_MANAGE } from '@nexus/factory-domain/plant/statutory/permissions'
import { CHECK_LIMITS, dateOf, dayOf, daysBetween, dueStateOf, projectedDates, type CheckIntervalUnit, type CheckOutcome, type CheckPlanStatus } from '@nexus/factory-domain/plant/statutory/rules'
import { holds } from '@nexus/factory-domain/core/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeOf, scopeOf } from '../access'
import { cursorOf, dueWhere } from './plans'
import { PLAN_COLUMNS, planViews, reportOnFile, RESULT_COLUMNS, resultViews, todayOf } from './store'

/**
 * The page's reads (B-W2b-124; QHS-205; design plant.preventive "Tiles", "Calendar", "Check register", tab "Check register
 * (print)": any period up to three years, for an inspector). Office, plant.view over the plans' and results' sites.
 *
 *   GET /plant/checks/counts[?siteId]                 the tiles: checks overdue, due in 30 days, reports missing
 *   GET /plant/checks/calendar?from&to[&siteId]       chips on days: a plan's next due date (overdue / due soon / planned),
 *                                                     its later checks projected by the interval, and the checks done
 *   GET /plant/checks/results[?…]                     the register, newest check first (a cursor of `<day>|<id>`)
 *
 * "Reports missing": a result in force (no later result corrects it) with no AVAILABLE CHECK_REPORT file of its own or of a
 * result it corrects. No money, no worker anywhere.
 */

const siteFilter = (siteId: string | undefined) => (siteId ? { siteId } : {})

/** The results in force with no report on file, among those the caller sees (at most CHECK_LIMITS.page × 4 read). */
async function missingReports(client: Parameters<Parameters<CommandCaller['withClient']>[0]>[0], where: Prisma.MachineCheckResultWhereInput): Promise<string[]> {
  const rows = await client.machineCheckResult.findMany({ where: { AND: [where, { correctedBy: { none: {} } }] }, orderBy: [{ performedOn: 'desc' }, { id: 'desc' }], take: CHECK_LIMITS.page * 4, select: { id: true, correctsId: true } })
  const onFile = await reportOnFile(client, rows)
  return rows.filter((row) => !onFile.get(row.id)).map((row) => row.id)
}

/** GET /plant/checks/counts. */
export async function checkCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const today = todayOf(new Date())
  const plans: Prisma.MachineCheckPlanWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineCheckPlanWhereInput, siteFilter(query.siteId)] }
  const results: Prisma.MachineCheckResultWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineCheckResultWhereInput, siteFilter(query.siteId)] }
  return caller.withClient(async (client) => {
    const overdue = await client.machineCheckPlan.count({ where: { AND: [plans, dueWhere('OVERDUE', today)] } })
    const soon = await client.machineCheckPlan.count({ where: { AND: [plans, dueWhere('DUE_SOON', today)] } })
    const missing = await missingReports(client, results)
    return { tiles: { OVERDUE: overdue, DUE_SOON: soon, REPORTS_MISSING: missing.length }, today }
  })
}

/** GET /plant/checks/calendar. */
export async function checkCalendar(caller: CommandCaller, query: { readonly from: BusinessDate; readonly to: BusinessDate; readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  if (query.to < query.from) throw queryIssue('to', 'The calendar ends on or after its first day.')
  if (daysBetween(query.from, query.to) > CHECK_LIMITS.calendarDays) throw queryIssue('to', `The calendar shows at most ${CHECK_LIMITS.calendarDays} days at once.`)
  const now = new Date()
  const today = todayOf(now)
  const scope = scopeOf(context, PLANT_VIEW)
  return caller.withClient(async (client) => {
    // Every ACTIVE plan due by the window's end: its next due date when inside, its later checks projected inside.
    const planRows = await client.machineCheckPlan.findMany({
      where: { AND: [scope as Prisma.MachineCheckPlanWhereInput, siteFilter(query.siteId), { status: 'ACTIVE', nextDueOn: { lte: dateOf(query.to) } }] },
      orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
      take: CHECK_LIMITS.page * 4,
      select: PLAN_COLUMNS,
    })
    const plans = await planViews(client, planRows, now)
    const chips: {
      kind: 'DUE' | 'PROJECTED' | 'DONE'
      date: BusinessDate
      state: 'OVERDUE' | 'DUE_SOON' | 'PLANNED' | 'DONE'
      planId: string | null
      resultId: string | null
      site: (typeof plans)[number]['site']
      machine: { id: string; assetNumber: string; status: MachineStatus; locked: boolean }
      checkType: (typeof plans)[number]['checkType']
      outsideBody: string | null
      outcome: CheckOutcome | null
    }[] = []
    for (const plan of plans) {
      const machine = { id: plan.machine.id, assetNumber: plan.machine.assetNumber, status: plan.machine.status, locked: plan.machine.locked }
      const base = { planId: plan.id, resultId: null, site: plan.site, machine, checkType: plan.checkType, outsideBody: plan.outsideBody?.name ?? null, outcome: null }
      if (plan.nextDueOn >= query.from) {
        const state = plan.due.state === 'ENDED' ? 'PLANNED' : plan.due.state
        chips.push({ kind: 'DUE', date: plan.nextDueOn, state, ...base })
      }
      for (const date of projectedDates({ nextDueOn: plan.nextDueOn, interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit }, query.from, query.to)) {
        const state = dueStateOf({ status: plan.status as CheckPlanStatus, nextDueOn: date }, today).state
        chips.push({ kind: 'PROJECTED', date, state: state === 'OVERDUE' || state === 'ENDED' ? 'PLANNED' : state, ...base })
      }
    }
    // The checks done in the window (in force: a corrected result shows as its correction).
    const doneRows = await client.machineCheckResult.findMany({
      where: { AND: [scope as Prisma.MachineCheckResultWhereInput, siteFilter(query.siteId), { performedOn: { gte: dateOf(query.from), lte: dateOf(query.to) }, correctedBy: { none: {} } }] },
      orderBy: [{ performedOn: 'asc' }, { id: 'asc' }],
      take: CHECK_LIMITS.page * 4,
      select: RESULT_COLUMNS,
    })
    const done = await resultViews(client, doneRows)
    const locked = new Map(plans.map((plan) => [plan.machine.id, plan.machine.locked]))
    for (const result of done) {
      chips.push({
        kind: 'DONE',
        date: result.performedOn,
        state: 'DONE',
        planId: result.planId,
        resultId: result.id,
        site: result.site,
        machine: { id: result.machine.id, assetNumber: result.machine.assetNumber, status: result.machine.status, locked: locked.get(result.machine.id) ?? false },
        checkType: result.checkType,
        outsideBody: result.outsideBody?.name ?? null,
        outcome: result.outcome,
      })
    }
    chips.sort((a, b) => a.date.localeCompare(b.date) || a.machine.assetNumber.localeCompare(b.machine.assetNumber) || a.checkType.code.localeCompare(b.checkType.code))
    return { from: query.from, to: query.to, today, chips, canManage: canManageAnywhere(context) }
  })
}

/** A 400 naming one query field. */
const queryIssue = (field: string, message: string): ValidationError => new ValidationError(message, [{ path: `query/${field}`, message }])

/** Whether the caller keeps the checks of some site (the page's New plan and Record a check result; each write asks its site). */
const canManageAnywhere = (context: ReturnType<typeof officeOf>): boolean => holds(actorOf(context), PLANT_CHECKS_MANAGE)

export interface RegisterQuery {
  readonly siteId?: string | undefined
  readonly machineId?: string | undefined
  readonly checkTypeId?: string | undefined
  readonly planId?: string | undefined
  readonly outcome?: CheckOutcome | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  /** Only results in force (no later result corrects them). */
  readonly inForce?: boolean | undefined
  /** Only results in force with no report on file (the tile "Reports missing"). */
  readonly reportMissing?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /plant/checks/results: the check register. */
export async function listResults(caller: CommandCaller, query: RegisterQuery) {
  const context = officeOf(caller)
  if (query.from && query.to && query.to < query.from) throw queryIssue('to', 'The period ends on or after its first day.')
  const filters: Prisma.MachineCheckResultWhereInput[] = [scopeOf(context, PLANT_VIEW) as Prisma.MachineCheckResultWhereInput, siteFilter(query.siteId)]
  if (query.machineId) filters.push({ machineId: query.machineId })
  if (query.checkTypeId) filters.push({ checkTypeId: query.checkTypeId })
  if (query.planId) filters.push({ planId: query.planId })
  if (query.outcome) filters.push({ outcome: query.outcome })
  if (query.from) filters.push({ performedOn: { gte: dateOf(query.from) } })
  if (query.to) filters.push({ performedOn: { lte: dateOf(query.to) } })
  if (query.inForce || query.reportMissing) filters.push({ correctedBy: { none: {} } })
  return caller.withClient(async (client) => {
    if (query.reportMissing) filters.push({ id: { in: await missingReports(client, { AND: filters }) } })
    const cursor = cursorOf(query.cursor)
    if (cursor) filters.push({ OR: [{ performedOn: { lt: dateOf(cursor.day) } }, { performedOn: dateOf(cursor.day), id: { lt: cursor.id } }] })
    const rows = await client.machineCheckResult.findMany({ where: { AND: filters }, orderBy: [{ performedOn: 'desc' }, { id: 'desc' }], take: query.limit + 1, select: RESULT_COLUMNS })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return { results: await resultViews(client, page), nextCursor: rows.length > query.limit && last ? `${dayOf(last.performedOn)}|${last.id}` : null, today: todayOf(new Date()), from: query.from ?? null, to: query.to ?? null }
  })
}
