import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { demandOf, needDateOf, PROTECTABLE_FIELDS, sizesOf } from '@nexus/factory-domain/planning/planned-orders/rules'
import { inputsSentence, readRunInputs, warningCounts } from '@nexus/factory-domain/planning/run-log/inputs'
import { plannedOrderReason, requirementReason } from '@nexus/factory-domain/planning/run-log/reasons'
import type { CommandCaller } from '../../../core/command'
import { assertMayAt, officeContextOf } from '../access'
import { PLANNED_COLUMNS } from '../planned-orders/store'
import { dayOf } from '../store'
import { quantityOf, REQUIREMENT_COLUMNS, RUN_COLUMNS, runCounts, runViewOf, sourcesOf, warningsOf } from '../views'
import type { RunLogView } from './contract'

/**
 * The run log (B-W2b-306; PLN-095 "MRP run log with plain reasons"; design planning.mrp run-log "Per run: inputs snapshot
 * and warnings (W2b)"): GET /planning/runs/:runId/log answers one run of a site with what it read (PlanningRun.inputs, in
 * numbers and one sentence; null for a run before W2b-5), its warnings (each in words, and counted per code), and why each
 * proposal exists: every requirement line of the run and every planned work or subcontract order it last proposed or moved
 * on, each in one sentence; and how many action messages it raised and how they were decided. planning.view over the run's
 * site. No money (the sentences carry quantities and days), no person.
 */
export async function runLog(caller: CommandCaller, runId: string): Promise<RunLogView> {
  const office = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const run = isUuid(runId) ? await db.planningRun.findUnique({ where: { id: runId }, select: { ...RUN_COLUMNS, inputs: true } }) : null
    assertMayAt(office, PLANNING_VIEW, run, 'Run')
    if (!run) throw new NotFoundError('Run not found.')
    const counts = (await runCounts(db, [run.id])).get(run.id) ?? { requirements: 0, short: 0 }
    const inputs = readRunInputs(run.inputs)
    const warnings = warningsOf(run.warnings)
    const lines = await db.materialRequirement.findMany({ where: { runId: run.id }, select: { ...REQUIREMENT_COLUMNS }, orderBy: [{ seq: 'asc' }], take: 2000 })
    const itemIds = [...new Set(lines.map((line) => line.itemId))]
    const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true } })
    const colourIds = [...new Set(lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
    const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true } })
    const codeOf = (itemId: string) => items.find((item) => item.id === itemId)?.code ?? 'A material'
    const colourOf = (colourId: string | null) => (colourId ? (colours.find((colour) => colour.id === colourId)?.code ?? null) : null)
    const requirements = lines.map((line) => {
      const sources = sourcesOf(line.sources)
      const reserved = line.orderSpecific && line.reservedForLineId ? sources.find((source) => source.orderLineId === line.reservedForLineId) : undefined
      const label = [codeOf(line.itemId), colourOf(line.itemColourId)].filter(Boolean).join(' ')
      const firm = line.firmedAt !== null && line.firmQuantity !== null && line.firmDate !== null
      return {
        id: line.id,
        seq: line.seq,
        action: line.action,
        item: { id: line.itemId, code: codeOf(line.itemId) },
        colour: line.itemColourId ? { id: line.itemColourId, code: colourOf(line.itemColourId) ?? '' } : null,
        netQuantity: quantityOf(line.netQuantity),
        uom: line.uom,
        needDate: dayOf(line.needDate),
        decision: line.decision,
        firm,
        orderSpecific: reserved ? { orderLineId: reserved.orderLineId, orderNumber: reserved.orderNumber, lineSeq: reserved.lineSeq } : null,
        reason: requirementReason({
          action: line.action,
          label,
          uom: line.uom,
          grossQuantity: quantityOf(line.grossQuantity),
          usableStock: quantityOf(line.usableStock),
          onOrder: quantityOf(line.onOrder),
          netQuantity: quantityOf(line.netQuantity),
          suggestedQuantity: quantityOf(line.suggestedQuantity),
          suggestedUom: line.suggestedUom,
          needDate: dayOf(line.needDate),
          orders: [...new Set(sources.map((source) => source.orderNumber).filter((number) => number !== ''))],
          firm: firm ? { quantity: quantityOf(line.firmQuantity!), uom: line.suggestedUom, date: dayOf(line.firmDate!), carried: line.firmCarriedFromId !== null || line.version === 1 } : null,
          reservedFor: reserved ? { orderNumber: reserved.orderNumber, lineSeq: reserved.lineSeq } : null,
        }),
      }
    })
    // The planned work and subcontract orders this run last proposed or moved on (a later run moves them on).
    const planned = await db.plannedWorkOrder.findMany({ where: { runId: run.id }, select: PLANNED_COLUMNS, orderBy: [{ startDate: 'asc' }, { id: 'asc' }], take: 1000 })
    const styleIds = [...new Set(planned.map((row) => row.styleId))]
    const styles = styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } })
    const colourwayIds = [...new Set(planned.map((row) => row.colourwayId))]
    const colourways = colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })
    const partyIds = [...new Set(planned.flatMap((row) => (row.partyId ? [row.partyId] : [])))]
    const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true } })
    const orderLineIds = [...new Set(planned.flatMap((row) => demandOf(row.demand).map((entry) => entry.orderLineId)))]
    const orderLines = orderLineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, seq: true, order: { select: { number: true } } } })
    const plannedOrders = planned.map((row) => {
      const demand = demandOf(row.demand)
      const label = [styles.find((style) => style.id === row.styleId)?.code ?? 'A style', colourways.find((colourway) => colourway.id === row.colourwayId)?.code].filter(Boolean).join(' ')
      const due = dayOf(row.dueDate)
      const needDate = needDateOf(demand, due)
      const words = [...new Set(demand.map((entry) => { const line = orderLines.find((candidate) => candidate.id === entry.orderLineId); return line ? `${line.order.number} line ${line.seq}` : 'an order line' }))]
      return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        label,
        quantity: row.quantity,
        startDate: dayOf(row.startDate),
        dueDate: due,
        needDate,
        firm: row.firm,
        protectedFields: row.protectedFields.filter((field): field is (typeof PROTECTABLE_FIELDS)[number] => (PROTECTABLE_FIELDS as readonly string[]).includes(field)),
        reason: plannedOrderReason({ kind: row.kind, label, sizes: sizesOf(row.sizes), quantity: row.quantity, startDate: dayOf(row.startDate), dueDate: due, needDate, orderLines: words, workshop: row.partyId ? (parties.find((party) => party.id === row.partyId)?.code ?? null) : null, operationSeqs: row.operationSeqs, firm: row.firm, protectedFields: row.protectedFields }),
      }
    })
    const decided = await db.mrpActionMessage.groupBy({ by: ['status'], where: { runId: run.id }, _count: { _all: true } })
    const of = (status: string) => decided.find((row) => row.status === status)?._count._all ?? 0
    return {
      run: runViewOf(run, counts),
      inputs: inputs ? { ...inputs, counts: { ...inputs.counts }, protectedPlan: inputs.protectedPlan.map((entry) => ({ plannedWorkOrderId: entry.plannedWorkOrderId, fields: { ...entry.fields } })) } : null,
      sentence: inputs ? inputsSentence(inputs) : null,
      warnings,
      warningCounts: warningCounts(warnings),
      proposals: { requirements, plannedOrders },
      actionMessages: { open: of('OPEN'), done: of('DONE'), ignored: of('IGNORED') },
    }
  })
}
