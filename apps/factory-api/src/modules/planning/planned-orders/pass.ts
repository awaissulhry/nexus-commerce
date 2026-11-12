import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  demandOf,
  inHouseDays,
  keptByRun,
  openCells,
  outsideWorkOf,
  proposalKey,
  proposeWork,
  SIZE_RUN_RULES,
  type OutsideWork,
  type Proposal,
  type SizeRunRule,
} from '@nexus/factory-domain/planning/planned-orders/rules'
import type { CommandTools } from '../../../core/command'
import { addWorkingDaysFor } from '../../../platform/calendars/service'
import type { PlanInputs } from '../inputs'
import { dayOf, type SiteRow } from '../store'
import { readOpenPlanned, type PlannedRow } from './store'
// B-W2b-321: only approved workshops get planned work.
import { unqualifiedWorkshops } from '../subcontract-capacity/planned'

/**
 * The run's make and subcontract pass (B-W2b-293; PLN-067, PLN-068, PLN-069, PLN-089; design planning.mrp "To make"):
 * after the material lines, in the run's own transaction (the site's planning lock is held), the site's planned work
 * orders and planned subcontract orders are brought to this plan (factory-domain planning/planned-orders rules):
 *
 *   to make     the order lines' pieces no work order makes and no kept planned order pegs, grouped by style, the
 *               revision the line names, colourway and due date, split by the site's size-run rule (PlanningSettings
 *               sizeRunRule, sizeGroups; none: one grid)
 *   kind        SUBCONTRACT when the planned revision's routing sends steps to an ACTIVE workshop, else MAKE
 *   dates       due: the lines' date (none: the run's day); start: backward from it by the routing's in-house standard
 *               minutes for its garments (a day of DAY_MINUTES; at least one) in the site's working days (the calendars
 *               service), and the outside steps' transit days on the clock; never before the run's day unless the due
 *               date is (late demand starts on its due date: B-W2b-306 says late); a workshop's kit leaves at 08:00 of
 *               the start day, the site's time
 *   rows        a plain PLANNED row of the same key moves on to this run with the new sizes, demand and dates; a new key
 *               adds a row; a plain row nothing needs is removed; a firm or protected row only moves on (it is never
 *               changed by a run); a CONVERTED one is history and is not read
 *
 * Writes are compare-and-set on each row's version and state, so a planned order made real while the run went is left as
 * it is (the next run sees its work order). The rows added, moved, removed and kept go into the run's own audit row
 * (../run: `plannedWorkOrders`); event `planned_work_orders.planned`.
 */

export interface PassResult {
  /** The rows the pass wrote, for the run's audit row (ids). */
  readonly added: readonly string[]
  readonly moved: readonly string[]
  readonly removed: readonly string[]
  readonly kept: readonly string[]
  readonly sizeRunRule: SizeRunRule
  /** Of the planned orders now open at the site, those for a workshop. */
  readonly subcontract: number
}

const day = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const KIT_HOUR_MS = 8 * 60 * 60 * 1000
const json = (value: unknown) => value as Prisma.InputJsonValue

/** The size-run rule of the site (its settings; none: one grid). */
async function sizeRunOf(tools: CommandTools, siteId: string): Promise<{ rule: SizeRunRule; groups: string[][] }> {
  const row = await tools.tx.planningSettings.findUnique({ where: { id: siteId }, select: { sizeRunRule: true, sizeGroups: true } })
  const rule = row && (SIZE_RUN_RULES as readonly string[]).includes(row.sizeRunRule) ? (row.sizeRunRule as SizeRunRule) : 'ONE_GRID'
  const groups = Array.isArray(row?.sizeGroups) ? (row!.sizeGroups as unknown[]).filter((group): group is string[] => Array.isArray(group) && group.every((code) => typeof code === 'string')) : []
  return { rule, groups }
}

/** The routing of each revision planned: its steps, and its outside work. */
async function routingsOf(tools: CommandTools, revisionIds: readonly string[], qualifiedAt: { readonly companyId: string; readonly today: BusinessDate }) {
  // B-W2b-321: the steps' kind of work and library operation (the workshop's qualification is asked for them).
  const steps = revisionIds.length === 0 ? [] : await tools.tx.routingOperation.findMany({ where: { revisionId: { in: [...revisionIds] } }, select: { revisionId: true, seq: true, supplierId: true, transitDays: true, standardMinutes: true, workCentreKind: true, operationId: true }, orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }] })
  const partyIds = [...new Set(steps.flatMap((step) => (step.supplierId ? [step.supplierId] : [])))]
  const parties = partyIds.length === 0 ? [] : await tools.tx.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, roles: true, status: true } })
  const partyOf = new Map(parties.map((party) => [party.id, party]))
  const workshop = (partyId: string) => {
    const party = partyOf.get(partyId)
    if (!party) return { usable: false, why: 'The routing names a workshop this plan cannot read.' }
    if (!party.roles.includes('SUBCONTRACTOR')) return { usable: false, why: `${party.code} has no SUBCONTRACTOR role.` }
    if (party.status !== 'ACTIVE') return { usable: false, why: `${party.code} is ${party.status.toLowerCase()}.` }
    return { usable: true, why: null }
  }
  const byRevision = new Map<string, typeof steps>()
  for (const step of steps) byRevision.set(step.revisionId, [...(byRevision.get(step.revisionId) ?? []), step])
  // B-W2b-321 (PLN-162): only a workshop qualified for its steps gets planned work; the others stay MAKE with why.
  const unqualified = await unqualifiedWorkshops(tools.tx, qualifiedAt.companyId, steps, qualifiedAt.today)
  const outside = new Map<string, OutsideWork | null>()
  for (const revisionId of revisionIds) outside.set(revisionId, outsideWorkOf(byRevision.get(revisionId) ?? [], (partyId) => { const base = workshop(partyId); const why = unqualified.get(`${revisionId}|${partyId}`); return base.usable && why ? { usable: false, why } : base }))
  return { stepsOf: (revisionId: string) => byRevision.get(revisionId) ?? [], outsideOf: (revisionId: string) => outside.get(revisionId) ?? null }
}

/** `days` working days before `date` at the site (its calendars); calendar days when it has none to read. */
async function workingDaysBefore(tools: CommandTools, site: SiteRow, date: BusinessDate, days: number, cache: Map<string, BusinessDate>): Promise<BusinessDate> {
  const key = `${date}|${days}`
  const known = cache.get(key)
  if (known) return known
  let found: BusinessDate | null = null
  try {
    found = (await addWorkingDaysFor(tools.tx as never, { scope: 'SITE', id: site.id }, date, -days)).date
  } catch {
    found = null
  }
  const value = found ?? plusDays(date, -days)
  cache.set(key, value)
  return value
}

/** The planned order's start (and a workshop's kit time) from its lead time, backward from its due date. */
async function datesOf(tools: CommandTools, site: SiteRow, proposal: Proposal, steps: readonly { seq: number; supplierId: string | null; transitDays: number | null; standardMinutes: { toString(): string } }[], runDate: BusinessDate, cache: Map<string, BusinessDate>) {
  const inHouse = inHouseDays(steps.map((step) => ({ standardMinutes: step.standardMinutes.toString(), outside: step.supplierId !== null })), proposal.quantity)
  const transit = steps.filter((step) => step.supplierId !== null).reduce((sum, step) => sum + (step.transitDays ?? 0), 0)
  const backward = plusDays(await workingDaysBefore(tools, site, proposal.dueDate, inHouse, cache), -transit)
  const startDate = proposal.dueDate < runDate ? proposal.dueDate : backward < runDate ? runDate : backward
  const kitDueAt = proposal.kind === 'SUBCONTRACT' ? new Date(businessDayStart(startDate, site.timezone).getTime() + KIT_HOUR_MS) : null
  return { startDate, kitDueAt }
}

/** Bring the site's planned orders to this run's plan (called by ../run in the run's command). */
export async function planWork(tools: CommandTools, site: SiteRow, runId: string, inputs: PlanInputs, runDate: BusinessDate): Promise<PassResult> {
  const { tx, now, context } = tools
  const actorId = context.audience === 'office' ? context.actorId : null
  const open = await readOpenPlanned(tx, site.id)
  const kept = open.filter((row) => keptByRun({ status: row.status, firm: row.firm, protectedFields: row.protectedFields }))
  const plain = open.filter((row) => !kept.includes(row))
  const lines = inputs.input.orderLines
  const own = lines.length === 0 ? [] : await tx.salesOrderLine.findMany({ where: { id: { in: lines.map((line) => line.orderLineId) } }, select: { id: true, styleRevisionId: true } })
  const ownOf = new Map(own.map((row) => [row.id, row.styleRevisionId]))
  const cells = openCells(lines, (orderLineId) => ownOf.get(orderLineId) ?? null, inputs.input.workOrderCells, kept.flatMap((row) => demandOf(row.demand)))
  const revisionIds = [...new Set(cells.map((cell) => cell.line.revisionId!))].sort()
  const routings = await routingsOf(tools, revisionIds, { companyId: site.companyId, today: runDate })
  const styleIds = [...new Set(cells.map((cell) => cell.line.styleId))]
  const styles = styleIds.length === 0 ? [] : await tx.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, sizes: true } })
  const sizesOfStyle = new Map(styles.map((style) => [style.id, style.sizes]))
  const { rule, groups } = await sizeRunOf(tools, site.id)
  const proposals = proposeWork({ cells, runDate, rule, groups, sizesOf: (styleId) => sizesOfStyle.get(styleId) ?? [], outsideOf: routings.outsideOf })

  const byKey = new Map<string, PlannedRow>()
  for (const row of plain) {
    const key = proposalKey({ kind: row.kind, styleId: row.styleId, colourwayId: row.colourwayId, styleRevisionId: row.styleRevisionId, sizeGroup: row.sizeGroup, dueDate: dayOf(row.dueDate) })
    if (!byKey.has(key)) byKey.set(key, row)
  }
  const cache = new Map<string, BusinessDate>()
  const added: string[] = []
  const moved: string[] = []
  const used = new Set<string>()
  for (const proposal of proposals) {
    const { startDate, kitDueAt } = await datesOf(tools, site, proposal, routings.stepsOf(proposal.planRevisionId), runDate, cache)
    const fields = {
      runId,
      sizes: json(proposal.sizes),
      quantity: proposal.quantity,
      startDate: day(startDate),
      dueDate: day(proposal.dueDate),
      demand: json(proposal.demand),
      partyId: proposal.partyId,
      operationSeqs: [...proposal.operationSeqs],
      kitDueAt,
    }
    const match = byKey.get(proposal.key)
    if (match && !used.has(match.id)) {
      used.add(match.id)
      const { count } = await tx.plannedWorkOrder.updateMany({ where: { id: match.id, status: 'PLANNED', firm: false, protectedFields: { isEmpty: true }, version: match.version }, data: { ...fields, version: match.version + 1, updatedAt: now } })
      if (count === 1) moved.push(match.id)
      continue
    }
    const id = newId()
    await tx.plannedWorkOrder.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        kind: proposal.kind,
        styleId: proposal.styleId,
        colourwayId: proposal.colourwayId,
        styleRevisionId: proposal.styleRevisionId,
        sizeGroup: proposal.sizeGroup,
        ...fields,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    added.push(id)
  }
  // A plain row nothing needs any more goes; a kept one moves on to this run unchanged.
  const removed: string[] = []
  for (const row of plain) {
    if (used.has(row.id)) continue
    const { count } = await tx.plannedWorkOrder.deleteMany({ where: { id: row.id, status: 'PLANNED', firm: false, protectedFields: { isEmpty: true }, version: row.version } })
    if (count === 1) removed.push(row.id)
  }
  const keptIds: string[] = []
  for (const row of kept) {
    const { count } = await tx.plannedWorkOrder.updateMany({ where: { id: row.id, status: 'PLANNED', version: row.version }, data: { runId, version: row.version + 1, updatedAt: now } })
    if (count === 1) keptIds.push(row.id)
  }
  const subcontract = await tx.plannedWorkOrder.count({ where: { siteId: site.id, status: 'PLANNED', kind: 'SUBCONTRACT' } })
  tools.emit({
    type: 'planned_work_orders.planned',
    subject: runId,
    companyId: site.companyId,
    siteId: site.id,
    payload: { runId, siteId: site.id, added: added.length, moved: moved.length, removed: removed.length, kept: keptIds.length, subcontract },
  })
  return { added, moved, removed, kept: keptIds, sizeRunRule: rule, subcontract }
}
