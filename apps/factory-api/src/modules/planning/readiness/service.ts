import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { planRequirements, type PlanResult } from '@nexus/factory-domain/planning/explode'
import { readinessOf, type ReadinessMaterial, type WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { serverClock } from '../../../core/time'
import { latestDoneRun, readPlanInputs, type PlanInputs } from '../inputs'
import { OPEN_WORK_ORDER_STATUSES } from '@nexus/factory-domain/planning/explode'
import type { Reader, SiteRow } from '../store'

/**
 * THE place readiness and the shortage list come from (B-W2a-22; PLN-086, PLN-085): the site's plan computed NOW, read
 * only — the same inputs and the same netting as a run (../inputs, factory-domain planning/explode), the latest plan's
 * firm planned orders as planned supply — so a reservation made, a receipt posted or a purchase order sent this morning
 * shows at once (a run's numbers are its snapshot). Pass your own client (a command's `tx` or `caller.withClient`); no
 * permission is checked here: B-W2a-46 (release blockers), B-W2a-58 (picking) and the planning routes check their own.
 * One query after another.
 *
 *   readinessFor(db, site, workOrderIds)   one word per work order (factory-domain planning/readiness)
 *   livePlanOf(db, site)                   the plan itself, for the shortage list
 */

export interface LivePlan {
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly inputs: PlanInputs
  readonly plan: PlanResult
  /** The latest DONE run (the one whose firm planned orders count, and whose lines a Buy fix points to). */
  readonly latestRun: { readonly id: string; readonly finishedAt: Date | null } | null
  readonly colourCodes: ReadonlyMap<string, string>
}

export async function livePlanOf(db: Reader, site: SiteRow, today: BusinessDate = businessDate(serverClock.now(), site.timezone)): Promise<LivePlan> {
  const latest = await latestDoneRun(db, site.id)
  const inputs = await readPlanInputs(db, site, today, latest?.id ?? null)
  const plan = planRequirements(inputs.input)
  const colourIds = [...new Set(plan.requirements.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })
  return { site, today, inputs, plan, latestRun: latest ? { id: latest.id, finishedAt: latest.finishedAt } : null, colourCodes: new Map(colours.map((colour) => [colour.id, colour.code])) }
}

/** The materials of a live plan as readiness reads them. */
export function readinessMaterialsOf(live: LivePlan): ReadinessMaterial[] {
  return live.plan.requirements.map((line, index) => {
    const item = live.inputs.items.find((entry) => entry.id === line.itemId)
    return {
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      label: [item?.code ?? 'A material', line.itemColourId ? live.colourCodes.get(line.itemColourId) : null].filter(Boolean).join(' '),
      uom: line.uom,
      pegging: live.plan.netting[index]!.pegging,
    }
  })
}

/** What readiness reads of the plan's open purchase order lines. */
export const purchaseFactsOf = (live: LivePlan) => {
  const byId = new Map(live.inputs.purchases.map((line) => [line.purchaseOrderLineId, line]))
  return (id: string) => {
    const line = byId.get(id)
    return line ? { purchaseOrderNumber: line.purchaseOrderNumber, purchaseOrderStatus: line.purchaseOrderStatus, dueDate: line.dueDate } : undefined
  }
}

/** One word per work order (PLN-086), computed now. A work order the plan has no demand for is NOT_PLANNED. */
export async function readinessFor(db: Reader, site: SiteRow, workOrderIds: readonly string[], live?: LivePlan): Promise<WorkOrderReadiness[]> {
  const plan = live ?? (await livePlanOf(db, site))
  return readinessOf(workOrderIds, readinessMaterialsOf(plan), purchaseFactsOf(plan), plan.today)
}

/** The site's open work orders (the ones readiness answers by default), by number. */
export const openWorkOrdersOf = (db: Reader, siteId: string, ids?: readonly string[]) =>
  db.workOrder.findMany({
    where: { siteId, status: { in: [...OPEN_WORK_ORDER_STATUSES] }, ...(ids ? { id: { in: [...ids] } } : {}) },
    select: { id: true, number: true, status: true, kind: true, dueDate: true, startedAt: true, style: { select: { id: true, code: true, name: true } } },
    orderBy: { number: 'asc' },
    take: 500,
  })

export const isPositive = (value: string): boolean => decimalOf(value).gt(0)
