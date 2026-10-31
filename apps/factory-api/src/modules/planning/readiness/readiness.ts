import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { READINESS_WORDS, type WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { decimalOf, QUANTITY_SCALE } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { dayOf, SITE_COLUMNS, type Reader } from '../store'
import { livePlanOf, openWorkOrdersOf, readinessFor, type LivePlan } from './service'

/**
 * GET /planning/readiness, GET /planning/work-orders/:workOrderId/readiness and GET /planning/shortages (B-W2a-22;
 * PLN-086, PLN-085; planning.view over the site): the readiness word of the site's open work orders (or the ones
 * asked), and the shortage list — every open work order × material that is not there in time, with the fix beside it:
 * Buy (the latest plan's line, for the Draft PO path), Expedite (the late or overdue purchase order line), Move the firm
 * planned order earlier. Swapping to another lot or an approved alternative is Later (design: "(Later)").
 */

type WorkOrderRow = Awaited<ReturnType<typeof openWorkOrdersOf>>[number]

const workOrderRef = (row: WorkOrderRow) => ({
  id: row.id,
  number: row.number,
  status: row.status,
  kind: row.kind,
  dueDate: row.dueDate ? dayOf(row.dueDate) : null,
  startedAt: row.startedAt ? toUtcIso(row.startedAt) : null,
  style: row.style,
})

const countsOf = (rows: readonly WorkOrderReadiness[]) => Object.fromEntries(READINESS_WORDS.map((word) => [word, rows.filter((row) => row.word === word).length])) as Record<(typeof READINESS_WORDS)[number], number>

export async function readiness(caller: CommandCaller, query: { readonly siteId: string; readonly workOrderIds?: string | undefined }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const ids = query.workOrderIds ? [...new Set(query.workOrderIds.split(',').map((value) => value.trim()).filter((value) => value !== ''))] : null
  if (ids && (ids.length > 100 || ids.some((value) => !isUuid(value)))) throw new ValidationError('Name at most 100 work orders by their ids.', [{ path: 'querystring/workOrderIds', message: 'Comma-separated work order ids, at most 100.' }])
  return caller.withClient(async (db) => {
    const workOrders = ids
      ? await db.workOrder.findMany({ where: { siteId: site.id, id: { in: ids } }, select: { id: true, number: true, status: true, kind: true, dueDate: true, startedAt: true, style: { select: { id: true, code: true, name: true } } }, orderBy: { number: 'asc' } })
      : await openWorkOrdersOf(db, site.id)
    const live = await livePlanOf(db, site)
    const answers = await readinessFor(db, site, workOrders.map((row) => row.id), live)
    const rows = answers.map((answer, index) => ({ workOrder: workOrderRef(workOrders[index]!), ...without(answer) }))
    return { siteId: site.id, asOf: live.today, latestRunId: live.latestRun?.id ?? null, counts: countsOf(answers), workOrders: rows }
  })
}

const without = ({ workOrderId: _id, materials, ...rest }: WorkOrderReadiness) => ({
  ...rest,
  materials: materials.map((material) => ({ ...material, purchaseOrderLineIds: [...material.purchaseOrderLineIds], arrivals: material.arrivals.map((arrival) => ({ ...arrival })) })),
})

export async function workOrderReadiness(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(workOrderId)
      ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, status: true, kind: true, dueDate: true, startedAt: true, companyId: true, siteId: true, style: { select: { id: true, code: true, name: true } } } })
      : null
    assertMayAt(context, PLANNING_VIEW, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
    const site = await db.site.findUnique({ where: { id: row!.siteId }, select: SITE_COLUMNS })
    if (!site) throw new NotFoundError('Work order not found.')
    const live = await livePlanOf(db, site)
    const [answer] = await readinessFor(db, site, [row!.id], live)
    return { siteId: site.id, asOf: live.today, latestRunId: live.latestRun?.id ?? null, readiness: { workOrder: workOrderRef(row!), ...without(answer!) } }
  })
}

// ---- the shortage list -----------------------------------------------------------------------------------------------------

const q = (value: { toFixed(scale: number): string }): string => value.toFixed(QUANTITY_SCALE)

async function shortageRows(db: Reader, live: LivePlan) {
  const workOrderIds = [...new Set(live.plan.netting.flatMap((entry) => entry.pegging.coverage.flatMap((coverage) => (coverage.part.workOrderId ? [coverage.part.workOrderId] : []))))]
  if (workOrderIds.length === 0) return []
  const workOrders = new Map((await openWorkOrdersOf(db, live.site.id, workOrderIds)).map((row) => [row.id, row]))
  const answers = await readinessFor(db, live.site, [...workOrders.keys()], live)
  const lines = live.latestRun ? await db.materialRequirement.findMany({ where: { runId: live.latestRun.id }, select: { id: true, itemId: true, itemColourId: true, action: true, decision: true, firmedAt: true } }) : []
  const purchases = new Map(live.inputs.purchases.map((line) => [line.purchaseOrderLineId, line]))
  const rows = []
  for (const answer of answers) {
    const workOrder = workOrders.get(answer.workOrderId)!
    for (const material of answer.materials) {
      if (material.word !== 'NOT_ENOUGH' && material.word !== 'DELAYED') continue
      const index = live.plan.requirements.findIndex((line) => line.itemId === material.itemId && line.itemColourId === material.itemColourId)
      const requirement = live.plan.requirements[index]!
      const pegging = live.plan.netting[index]!.pegging
      const coverages = pegging.coverage.filter((coverage) => coverage.part.workOrderId === answer.workOrderId)
      let short = decimalOf('0')
      const overdue = new Set<string>()
      let firmLate = false
      for (const coverage of coverages) {
        short = short.plus(decimalOf(coverage.uncovered))
        for (const supply of coverage.supplies) {
          if (supply.kind === 'FIRM' && supply.late) {
            short = short.plus(decimalOf(supply.quantity))
            firmLate = true
          }
          if (supply.kind === 'PURCHASE_ORDER' && supply.date && supply.date < live.today && supply.purchaseOrderLineId) {
            short = short.plus(decimalOf(supply.quantity))
            overdue.add(supply.purchaseOrderLineId)
          }
        }
      }
      const tooLate = pegging.purchases.filter((purchase) => purchase.why === 'TOO_LATE' && decimalOf(purchase.notCounted).gt(0))
      const chase = [...tooLate.map((purchase) => purchase.line.purchaseOrderLineId), ...overdue]
      const fixes: { kind: 'BUY' | 'EXPEDITE' | 'MOVE_FIRM'; requirementId: string | null; purchaseOrder: { id: string; number: string; lineId: string; dueDate: string } | null; words: string }[] = []
      const planLine = lines.find((line) => line.itemId === material.itemId && line.itemColourId === material.itemColourId && line.action === requirement.action)
      if (requirement.action === 'BUY' && coverages.some((coverage) => decimalOf(coverage.uncovered).gt(0)) && planLine && planLine.decision === 'OPEN') {
        fixes.push({ kind: 'BUY', requirementId: planLine.id, purchaseOrder: null, words: `Buy ${material.label}: draft a purchase order from the plan.` })
      }
      for (const lineId of [...new Set(chase)]) {
        const purchase = purchases.get(lineId)
        if (purchase) fixes.push({ kind: 'EXPEDITE', requirementId: null, purchaseOrder: { id: purchase.purchaseOrderId, number: purchase.purchaseOrderNumber, lineId, dueDate: purchase.dueDate }, words: `Expedite ${purchase.purchaseOrderNumber} (due ${purchase.dueDate}).` })
      }
      if (firmLate && planLine?.firmedAt) fixes.push({ kind: 'MOVE_FIRM', requirementId: planLine.id, purchaseOrder: null, words: `Move the firm planned order of ${material.label} earlier.` })
      const late = tooLate[0]
      rows.push({
        workOrder: workOrderRef(workOrder),
        material: { itemId: material.itemId, itemColourId: material.itemColourId, label: material.label, uom: material.uom },
        word: material.word,
        short: q(short),
        neededBy: coverages.map((coverage) => coverage.day).sort()[0] ?? live.today,
        expected: late ? { date: late.line.dueDate, purchaseOrderNumber: late.line.purchaseOrderNumber } : null,
        reason: material.reason,
        fixes,
      })
    }
  }
  return rows.sort((a, b) => (a.neededBy !== b.neededBy ? (a.neededBy < b.neededBy ? -1 : 1) : a.workOrder.number < b.workOrder.number ? -1 : a.workOrder.number > b.workOrder.number ? 1 : a.material.label < b.material.label ? -1 : 1))
}

export async function shortages(caller: CommandCaller, query: { readonly siteId: string }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const live = await livePlanOf(db, site)
    return { siteId: site.id, asOf: live.today, latestRunId: live.latestRun?.id ?? null, rows: await shortageRows(db, live) }
  })
}
