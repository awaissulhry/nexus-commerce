import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import {
  demandOf,
  inHouseDays,
  keptByRun,
  needDateOf,
  openCells,
  outsideWorkOf,
  proposalKey,
  proposeWork,
  SIZE_RUN_RULES,
  type OutsideWork,
  type PeggedDemand,
  type Proposal,
  type SizeRunRule,
} from '@nexus/factory-domain/planning/planned-orders/rules'
// B-W2b-306 (PLN-076, PLN-083): a protected row follows its demand; nothing planned before today.
import { claimProposals, mergeWithPlan, overlapOf, planValuesOf, type PlanFields } from '@nexus/factory-domain/planning/actions/protect'
import type { ActionPlanned } from '@nexus/factory-domain/planning/actions/messages'
import type { ProtectedPlan } from '@nexus/factory-domain/planning/run-log/inputs'
import { columnsOf, fieldsOfRow, kitAtFor } from '../actions/fields'
import type { CommandTools } from '../../../core/command'
import { addWorkingDaysFor } from '../../../platform/calendars/service'
import type { PlanInputs } from '../inputs'
import { dayOf, type SiteRow } from '../store'
import { readOpenPlanned, type PlannedRow } from './store'

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
 *               service), and the outside steps' transit days on the clock; B-W2b-306 (PLN-083): never before the
 *               run's day: late demand starts today and is due on the earliest day it can be ready (forward by the same
 *               lead time), never before its need; a workshop's kit leaves at 08:00 of the start day, the site's time
 *   rows        a plain PLANNED row of the same key (its demand's need day, not its due date) moves on to this run with the
 *               new sizes, demand and dates; a new key adds a row; a plain row nothing needs is removed; a firm row only
 *               moves on (it is never changed by a run); B-W2b-306 (PLN-076): a row a planner protected fields of follows
 *               its demand (the proposal that pegs most of its pieces) and gets the plan's values of the fields NOT
 *               protected; one nothing in the plan needs moves on as it is (never removed by a run); a CONVERTED one is
 *               history and is not read
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
  /** B-W2b-306 (PLN-076): protected rows the run rewrote in their fields not protected, and those nothing claimed. */
  readonly followed: readonly string[]
  readonly unclaimed: readonly string[]
  /** B-W2b-306 (PLN-095): the plan's value of each protected field (the run log keeps it for Reset to plan). */
  readonly protectedPlan: readonly ProtectedPlan[]
  /** B-W2b-306 (PLN-073): the protected rows as the action messages read them. */
  readonly protectedRows: readonly ActionPlanned[]
  /** B-W2b-306 (PLN-083): order lines whose planned work is ready after their date (the run's LATE warning). */
  readonly late: readonly { readonly orderLineId: string; readonly readyDate: BusinessDate }[]
  /** B-W2b-306 (PLN-095): rows by kind, for the run log. */
  readonly firm: number
  readonly guarded: number
  readonly plain: number
}

const day = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const json = (value: unknown) => value as Prisma.InputJsonValue

/** The size-run rule of the site (its settings; none: one grid). */
async function sizeRunOf(tools: CommandTools, siteId: string): Promise<{ rule: SizeRunRule; groups: string[][] }> {
  const row = await tools.tx.planningSettings.findUnique({ where: { id: siteId }, select: { sizeRunRule: true, sizeGroups: true } })
  const rule = row && (SIZE_RUN_RULES as readonly string[]).includes(row.sizeRunRule) ? (row.sizeRunRule as SizeRunRule) : 'ONE_GRID'
  const groups = Array.isArray(row?.sizeGroups) ? (row!.sizeGroups as unknown[]).filter((group): group is string[] => Array.isArray(group) && group.every((code) => typeof code === 'string')) : []
  return { rule, groups }
}

/** The routing of each revision planned: its steps, and its outside work. */
async function routingsOf(tools: CommandTools, revisionIds: readonly string[]) {
  const steps = revisionIds.length === 0 ? [] : await tools.tx.routingOperation.findMany({ where: { revisionId: { in: [...revisionIds] } }, select: { revisionId: true, seq: true, supplierId: true, transitDays: true, standardMinutes: true }, orderBy: [{ revisionId: 'asc' }, { seq: 'asc' }] })
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
  const outside = new Map<string, OutsideWork | null>()
  for (const revisionId of revisionIds) outside.set(revisionId, outsideWorkOf(byRevision.get(revisionId) ?? [], workshop))
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

/**
 * The planned order's start and due dates (and a workshop's kit time) from its lead time, backward from the day its demand
 * needs it. B-W2b-306 (PLN-083): never before the run's day: when the backward start falls before today, it starts today
 * and is due on the earliest day it can be ready (the same lead time forward), never before its need.
 */
async function datesOf(tools: CommandTools, site: SiteRow, proposal: Proposal, steps: readonly { seq: number; supplierId: string | null; transitDays: number | null; standardMinutes: { toString(): string } }[], runDate: BusinessDate, cache: Map<string, BusinessDate>) {
  const inHouse = inHouseDays(steps.map((step) => ({ standardMinutes: step.standardMinutes.toString(), outside: step.supplierId !== null })), proposal.quantity)
  const transit = steps.filter((step) => step.supplierId !== null).reduce((sum, step) => sum + (step.transitDays ?? 0), 0)
  const backward = plusDays(await workingDaysBefore(tools, site, proposal.dueDate, inHouse, cache), -transit)
  let startDate = backward
  let dueDate = proposal.dueDate
  if (backward < runDate) {
    startDate = runDate
    const earliest = plusDays(await workingDaysBefore(tools, site, runDate, -inHouse, cache), transit)
    if (earliest > dueDate) dueDate = earliest
  }
  const kitDueAt = proposal.kind === 'SUBCONTRACT' ? new Date(kitAtFor(site.timezone)(startDate)) : null
  return { startDate, dueDate, kitDueAt }
}

/** Bring the site's planned orders to this run's plan (called by ../run in the run's command). */
export async function planWork(tools: CommandTools, site: SiteRow, runId: string, inputs: PlanInputs, runDate: BusinessDate): Promise<PassResult> {
  const { tx, now, context } = tools
  const actorId = context.audience === 'office' ? context.actorId : null
  const open = await readOpenPlanned(tx, site.id)
  const kept = open.filter((row) => keptByRun({ status: row.status, firm: row.firm, protectedFields: row.protectedFields }))
  // B-W2b-306 (PLN-076): rows a planner protected fields of (not firm) follow their demand; the rest are plain.
  const guarded = open.filter((row) => !kept.includes(row) && row.protectedFields.length > 0)
  const plain = open.filter((row) => !kept.includes(row) && !guarded.includes(row))
  const lines = inputs.input.orderLines
  const own = lines.length === 0 ? [] : await tx.salesOrderLine.findMany({ where: { id: { in: lines.map((line) => line.orderLineId) } }, select: { id: true, styleRevisionId: true } })
  const ownOf = new Map(own.map((row) => [row.id, row.styleRevisionId]))
  const cellsWith = (taken: readonly PeggedDemand[]) => openCells(lines, (orderLineId) => ownOf.get(orderLineId) ?? null, inputs.input.workOrderCells, [...kept.flatMap((row) => demandOf(row.demand)), ...taken])
  let cells = cellsWith([])
  const revisionIds = [...new Set(cells.map((cell) => cell.line.revisionId!))].sort()
  const routings = await routingsOf(tools, revisionIds)
  const styleIds = [...new Set([...cells.map((cell) => cell.line.styleId), ...guarded.map((row) => row.styleId)])]
  const styles = styleIds.length === 0 ? [] : await tx.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, sizes: true } })
  const sizesOfStyle = new Map(styles.map((style) => [style.id, style.sizes]))
  const { rule, groups } = await sizeRunOf(tools, site.id)
  const propose = () => proposeWork({ cells, runDate, rule, groups, sizesOf: (styleId) => sizesOfStyle.get(styleId) ?? [], outsideOf: routings.outsideOf })
  let proposals = propose()
  // B-W2b-306 (PLN-076): each protected row claims the proposal that pegs most of its pieces. A row nothing claims keeps
  // its demand as covered (planned again without it), as before.
  const claimOf = (row: PlannedRow) => ({ id: row.id, kind: row.kind, styleId: row.styleId, colourwayId: row.colourwayId, demand: demandOf(row.demand) })
  let claims = claimProposals(guarded.map(claimOf), proposals)
  const lost = guarded.filter((row) => !claims.has(row.id))
  if (lost.length > 0) {
    cells = cellsWith(lost.flatMap((row) => demandOf(row.demand)))
    proposals = propose()
    claims = claimProposals(guarded.filter((row) => !lost.includes(row)).map(claimOf), proposals)
  }
  const claimedBy = new Map<number, PlannedRow>()
  for (const [rowId, index] of claims) claimedBy.set(index, guarded.find((row) => row.id === rowId)!)

  const byKey = new Map<string, PlannedRow>()
  for (const row of plain) {
    // B-W2b-306 (PLN-083): a row's key day is its demand's need, not its (maybe later) due date.
    const key = proposalKey({ kind: row.kind, styleId: row.styleId, colourwayId: row.colourwayId, styleRevisionId: row.styleRevisionId, sizeGroup: row.sizeGroup, dueDate: needDateOf(demandOf(row.demand), dayOf(row.dueDate)) })
    if (!byKey.has(key)) byKey.set(key, row)
  }
  const cache = new Map<string, BusinessDate>()
  const kitAt = kitAtFor(site.timezone)
  const added: string[] = []
  const moved: string[] = []
  const followed: string[] = []
  const protectedPlan: ProtectedPlan[] = []
  const protectedRows: ActionPlanned[] = []
  const late: { orderLineId: string; readyDate: BusinessDate }[] = []
  const used = new Set<string>()
  const colourways = guarded.length === 0 ? [] : await tx.colourway.findMany({ where: { id: { in: [...new Set(guarded.map((row) => row.colourwayId))] } }, select: { id: true, code: true } })
  const labelOf = (row: PlannedRow) => [styles.find((style) => style.id === row.styleId)?.code ?? 'A style', colourways.find((colourway) => colourway.id === row.colourwayId)?.code].filter(Boolean).join(' ')
  for (const [index, proposal] of proposals.entries()) {
    const { startDate, dueDate, kitDueAt } = await datesOf(tools, site, proposal, routings.stepsOf(proposal.planRevisionId), runDate, cache)
    // B-W2b-306 (PLN-083): late planned work: the run's LATE warning names its order lines.
    if (dueDate > proposal.dueDate) for (const entry of proposal.demand) late.push({ orderLineId: entry.orderLineId, readyDate: dueDate })
    const fields = {
      runId,
      sizes: json(proposal.sizes),
      quantity: proposal.quantity,
      startDate: day(startDate),
      dueDate: day(dueDate),
      demand: json(proposal.demand),
      partyId: proposal.partyId,
      operationSeqs: [...proposal.operationSeqs],
      kitDueAt,
    }
    // B-W2b-306 (PLN-076): a protected row gets the plan's values of the fields it does not protect.
    const guard = claimedBy.get(index)
    if (guard) {
      const plan: PlanFields = { sizes: proposal.sizes, startDate, dueDate, lineId: null, partyId: proposal.partyId, operationSeqs: proposal.operationSeqs, kitDueAt: kitDueAt ? kitDueAt.toISOString() : null, styleRevisionId: proposal.styleRevisionId }
      const merged = mergeWithPlan(fieldsOfRow(guard), plan, guard.protectedFields, guard.kind, kitAt, runDate)
      const { count } = await tx.plannedWorkOrder.updateMany({
        where: { id: guard.id, status: 'PLANNED', firm: false, version: guard.version, protectedFields: { equals: guard.protectedFields } },
        data: { runId, ...columnsOf(merged), demand: json(proposal.demand), sizeGroup: proposal.sizeGroup, version: guard.version + 1, updatedAt: now },
      })
      if (count === 1) followed.push(guard.id)
      protectedPlan.push({ plannedWorkOrderId: guard.id, fields: planValuesOf(plan, guard.protectedFields) })
      protectedRows.push({ id: guard.id, label: labelOf(guard), protectedFields: [...guard.protectedFields], dueDate: merged.dueDate, quantity: merged.sizes.reduce((sum, row) => sum + row.quantity, 0), planDueDate: dueDate, planQuantity: proposal.quantity, needed: true })
      continue
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
  // B-W2b-306 (PLN-076): a protected row no proposal claims moves on as it is (a run never removes it); whether anything open
  // still needs its pieces is for its action message.
  const unclaimed = guarded.filter((row) => !followed.includes(row.id) && ![...claims.keys()].includes(row.id))
  const openDemand = cellsWith([]).map((cell) => ({ orderId: cell.line.orderId, orderLineId: cell.line.orderLineId, size: cell.size, pieces: cell.pieces }))
  const keptIds: string[] = []
  for (const row of [...kept, ...unclaimed]) {
    const { count } = await tx.plannedWorkOrder.updateMany({ where: { id: row.id, status: 'PLANNED', version: row.version }, data: { runId, version: row.version + 1, updatedAt: now } })
    if (count === 1) keptIds.push(row.id)
    if (unclaimed.includes(row)) {
      const stored = fieldsOfRow(row)
      protectedRows.push({ id: row.id, label: labelOf(row), protectedFields: [...row.protectedFields], dueDate: stored.dueDate, quantity: row.quantity, planDueDate: null, planQuantity: null, needed: overlapOf(demandOf(row.demand), openDemand) > 0 || demandOf(row.demand).some((entry) => lines.some((line) => line.orderLineId === entry.orderLineId && line.revisionId === null)) })
    }
  }
  const subcontract = await tx.plannedWorkOrder.count({ where: { siteId: site.id, status: 'PLANNED', kind: 'SUBCONTRACT' } })
  tools.emit({
    type: 'planned_work_orders.planned',
    subject: runId,
    companyId: site.companyId,
    siteId: site.id,
    payload: { runId, siteId: site.id, added: added.length, moved: moved.length + followed.length, removed: removed.length, kept: keptIds.length, subcontract },
  })
  return { added, moved, removed, kept: keptIds, sizeRunRule: rule, subcontract, followed, unclaimed: unclaimed.map((row) => row.id), protectedPlan, protectedRows, late, firm: kept.length, guarded: guarded.length, plain: plain.length }
}
