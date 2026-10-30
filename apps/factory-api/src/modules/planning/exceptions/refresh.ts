import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { pegMaterial } from '@nexus/factory-domain/planning/mrp/net'
import type { PlanResult } from '@nexus/factory-domain/planning/explode'
import { EVALUATED_KINDS, type DetectMaterial, type ExceptionCondition, type LaneOverload, type SafetyOnly } from '@nexus/factory-domain/planning/exceptions/detect'
import { refreshOf, type OpenException } from '@nexus/factory-domain/planning/exceptions/lifecycle'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { sourceFor, sourceRules } from '@nexus/factory-domain/purchasing/sources/sources'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandTools } from '../../../core/command'
import { capacityAnswer, capacityWorld } from '../capacity/service'
import type { PlanInputs } from '../inputs'
import type { SiteRow } from '../store'

/**
 * The exception list a run refreshes (B-W2a-22; PLN-193), inside the run's own command: what the plan found
 * (factory-domain planning/exceptions/detect) against the site's unresolved exceptions (…/lifecycle `refreshOf`):
 * a condition found again updates its row (facts, impact, the latest run; a snooze "until the next run" ends), a new one
 * is inserted NEW with the next occurrence of its key, one no longer found is RESOLVED as CLEARED. Only the kinds the
 * run evaluates are cleared. Lane overloads read THE capacity service (B-W2a-16) for the next four weeks.
 */

export const OPEN_COLUMNS = { id: true, kind: true, dedupeKey: true, status: true, snoozedAt: true, snoozedUntil: true, version: true, lastSeenAt: true } as const satisfies Prisma.PlanningExceptionSelect

export interface RefreshCounts {
  readonly raised: number
  readonly stillOpen: number
  readonly cleared: number
}

const labelOf = (inputs: PlanInputs, itemId: string, itemColourId: string | null, colours: ReadonlyMap<string, string>): string => {
  const item = inputs.items.find((entry) => entry.id === itemId)
  return [item?.code ?? 'A material', itemColourId ? colours.get(itemColourId) : null].filter(Boolean).join(' ')
}

/** What detection reads of each requirement of the plan, and of materials with a safety stock and no demand. */
export async function detectInputs(tools: Pick<CommandTools, 'tx'>, site: SiteRow, inputs: PlanInputs, plan: PlanResult, runDate: BusinessDate): Promise<{ materials: DetectMaterial[]; safetyOnly: SafetyOnly[]; overloads: LaneOverload[] }> {
  const { tx } = tools
  const colourIds = [...new Set([...plan.requirements.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])), ...inputs.itemPlanning.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])), ...inputs.input.stock.flatMap((entry) => (entry.itemColourId && inputs.safetyOnlyItemIds.includes(entry.itemId) ? [entry.itemColourId] : []))])]
  const colours = new Map((colourIds.length === 0 ? [] : await tx.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })).map((colour) => [colour.id, colour.code]))
  const materials: DetectMaterial[] = plan.requirements.map((line, index) => {
    const netting = plan.netting[index]!
    const rule = itemPlanningFor(inputs.itemPlanning.filter((row) => row.itemId === line.itemId), line.itemColourId)
    let lead: number | null
    if (line.action === 'MAKE') lead = rule?.makeLeadTimeDays ?? null
    else {
      const source = line.supplierId ? sourceFor(inputs.sources, { companyId: site.companyId, itemId: line.itemId, itemColourId: line.itemColourId }, line.supplierId) : null
      lead = rule?.buyLeadTimeDays ?? (source ? sourceRules(source, inputs.supplierLeadTimes.get(line.supplierId!) ?? null).leadTimeDays : (inputs.input.supplyRulesOf?.(line.itemId, line.supplierId).leadTimeDays ?? null))
    }
    const safety = rule?.safetyStock && rule.safetyStock.gt(0) ? rule.safetyStock.toFixed(4) : null
    return {
      seq: line.seq,
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      action: line.action,
      label: labelOf(inputs, line.itemId, line.itemColourId, colours),
      uom: line.uom,
      pegging: netting.pegging,
      leadTimeDays: lead === null ? null : lead + (rule?.safetyLeadTimeDays ?? 0),
      keptInStock: rule !== null && (rule.method === 'REORDER_POINT' || rule.method === 'MIN_MAX' || safety !== null),
      safetyStock: safety,
    }
  })
  // Materials with a safety stock the plan has no demand for: their usable stock (less what others reserved) and arrivals.
  const safetyOnly: SafetyOnly[] = []
  const lots = new Map(inputs.input.lots.map((lot) => [lot.id, lot]))
  for (const row of inputs.itemPlanning) {
    if (!inputs.safetyOnlyItemIds.includes(row.itemId) || row.safetyStock === null || !row.safetyStock.gt(0)) continue
    const item = inputs.items.find((entry) => entry.id === row.itemId)
    if (!item) continue
    const keys = row.itemColourId !== null ? [row.itemColourId] : [...new Set([...inputs.input.stock.filter((entry) => entry.itemId === row.itemId).map((entry) => entry.itemColourId), ...inputs.purchases.filter((line) => line.itemId === row.itemId).map((line) => line.itemColourId)])]
    for (const colour of keys.length === 0 ? [null] : keys) {
      const netting = pegMaterial({
        itemColourId: colour,
        parts: [],
        stock: inputs.input.stock.filter((entry) => entry.itemId === row.itemId),
        lotOf: (lotId) => lots.get(lotId),
        reservations: inputs.reservations.filter((reservation) => reservation.itemId === row.itemId),
        purchases: inputs.purchases.filter((line) => line.itemId === row.itemId && line.itemColourId === colour),
        runDate,
      })
      // No demand: every usable unit not held for another demand is free.
      const free = netting.stock.filter((line) => line.notCounted === null).reduce((sum, line) => sum.plus(decimalOf(line.entry.quantity)), decimalOf('0')).minus(decimalOf(netting.reservedForOthers))
      safetyOnly.push({
        itemId: row.itemId,
        itemColourId: colour,
        label: labelOf(inputs, row.itemId, colour, colours),
        uom: item.baseUom as Uom,
        safetyStock: row.safetyStock.toFixed(4),
        usable: (free.isNegative() ? decimalOf('0') : free).toFixed(4),
        arrivals: netting.purchases.map((purchase) => ({ date: purchase.line.dueDate, quantity: decimalOf(purchase.line.openQuantity).toFixed(4) })),
      })
    }
  }
  // Lanes booked above capacity in the next four weeks (by week).
  const overloads: LaneOverload[] = []
  const to = plusDays(runDate, 27)
  const world = await capacityWorld(tx, site, { from: runDate, to }, runDate)
  const answer = capacityAnswer(world, { from: runDate, to, buckets: uniformBuckets(runDate, to, 'WEEK') })
  for (const lane of answer.lanes) {
    for (const cell of lane.cells) {
      if (!decimalOf(cell.overMinutes).gt(0)) continue
      overloads.push({ laneKind: lane.kind, laneId: lane.id, laneCode: lane.code, bucketKey: cell.key, from: cell.from, to: cell.to, loadPct: cell.loadPct ?? '—', availableMinutes: cell.availableMinutes, bookedMinutes: cell.bookedMinutes })
    }
  }
  return { materials, safetyOnly, overloads }
}

/** Refreshes the site's exception list with what the run found (inside the run's command). */
export async function refreshExceptions(tools: CommandTools, site: SiteRow, runId: string, conditions: readonly ExceptionCondition[], requirementIdOf: (seq: number | null) => string | null): Promise<RefreshCounts> {
  const { tx, now } = tools
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const open = (await tx.planningException.findMany({ where: { siteId: site.id, status: { not: 'RESOLVED' } }, select: OPEN_COLUMNS, orderBy: { id: 'asc' } })) as (OpenException & { version: number; lastSeenAt: Date })[]
  const refresh = refreshOf(open, conditions, EVALUATED_KINDS)
  for (const { row, condition, endSnooze } of refresh.found) {
    await tx.planningException.update({
      where: { id: row.id },
      data: {
        lastRunId: runId,
        lastSeenAt: now.getTime() < row.lastSeenAt.getTime() ? row.lastSeenAt : now,
        facts: { ...condition.facts, sentence: condition.sentence } as Prisma.InputJsonValue,
        requirementId: requirementIdOf(condition.requirementSeq),
        ordersAffected: condition.ordersAffected,
        daysLate: condition.daysLate,
        ...(endSnooze ? { snoozedAt: null, snoozedById: null, snoozedUntil: null } : {}),
        version: row.version + 1,
      },
      select: { id: true },
    })
  }
  if (refresh.raised.length > 0) {
    const keys = refresh.raised.map((condition) => condition.key)
    const earlier = await tx.planningException.groupBy({ by: ['dedupeKey'], where: { siteId: site.id, dedupeKey: { in: keys } }, _max: { occurrence: true } })
    const lastOf = new Map(earlier.map((row) => [row.dedupeKey, row._max.occurrence ?? 0]))
    await tx.planningException.createMany({
      data: refresh.raised.map((condition) => ({
        id: newId(),
        companyId: site.companyId,
        siteId: site.id,
        kind: condition.kind,
        dedupeKey: condition.key,
        occurrence: (lastOf.get(condition.key) ?? 0) + 1,
        firstRunId: runId,
        lastRunId: runId,
        firstSeenAt: now,
        lastSeenAt: now,
        itemId: condition.itemId,
        itemColourId: condition.itemColourId,
        requirementId: requirementIdOf(condition.requirementSeq),
        recordType: condition.record?.type ?? null,
        recordId: condition.record?.id ?? null,
        facts: { ...condition.facts, sentence: condition.sentence } as Prisma.InputJsonValue,
        ordersAffected: condition.ordersAffected,
        daysLate: condition.daysLate,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      })),
    })
  }
  for (const row of refresh.cleared) {
    await tx.planningException.update({ where: { id: row.id }, data: { status: 'RESOLVED', resolvedAt: now, resolution: 'CLEARED', version: row.version + 1 }, select: { id: true } })
  }
  return { raised: refresh.raised.length, stillOpen: refresh.found.length, cleared: refresh.cleared.length }
}
