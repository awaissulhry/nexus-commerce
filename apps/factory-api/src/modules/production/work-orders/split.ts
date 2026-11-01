import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { WORKORDERS_MANAGE } from '@nexus/factory-domain/production/work-orders/permissions'
import { splitPlan, splitProblems, splitRefusal, type SplitAsk, type SplitCell, type SplitPlan } from '@nexus/factory-domain/production/work-orders/split'
import type { PlannedMaterial } from '@nexus/factory-domain/production/work-orders/spec'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { officeContextOf } from './access'
import { planSpec, readBasics, readSpecParts, type SpecParts } from './facts'
import { asDay, cellLabel, clearDraftMaterials, dayOrNull, hasSeries, lockOrderLines, readCells, readWorkOrder, STYLE_COLUMNS, type CellRow, type Header } from './store'
import { workOrderView, type WorkOrderView } from './views'
import { actorIdOf, blankToNull, changedEvent, numberPreview, officeWorkOrder, todayOfCommand } from './work-orders'

/**
 * Split a work order (B-W2b-51; MES-010 "Split a work order"; design production.workorders pop wo-split "sizes or
 * quantity to move into a child work order with its own due date; genealogy kept"; rules factory-domain
 * production/work-orders/split):
 *
 *   POST /production/work-orders/:id/split/preview   workorders.manage: what each side keeps and gets — its cells and the
 *                                                    materials planned from them — and why not; nothing is written
 *   POST /production/work-orders/:id/split           workorders.manage: ONE command on the parent (its version bump locks
 *                                                    its row; the order lines' advisory locks then serialise it with
 *                                                    every other draft of those lines): the parent's cells lowered or
 *                                                    removed, its drafted materials removed (the release plans them from
 *                                                    the cells it keeps), the new DRAFT numbered from the company's
 *                                                    WORK_ORDER series with `splitFromId`, its cells, its own due date,
 *                                                    priority, rush flag and note; audited on both; workorder.created
 *                                                    (with splitFromId) and workorder.changed (cells, split).
 *
 * Only a DRAFT size grid is split (the WorkOrderSize guard freezes a work order's cells at its release); the order
 * lines' pieces stay the same, on two work orders. Stock reserved for the parent, its kit and its operations on the
 * planning board stay with the parent; the new one is on no line until the planner allocates it.
 */

export interface SplitInput {
  readonly version?: number | undefined
  readonly cells: readonly SplitAsk[]
  readonly dueDate?: BusinessDate | null | undefined
  readonly priority?: number | undefined
  readonly rush?: boolean | undefined
  readonly note?: string | null | undefined
}

const splitCellOf = (cell: CellRow): SplitCell => ({ id: cell.id, label: cellLabel(cell), quantity: cell.quantity })

/** Each side's cells after the plan: the parent's kept ones (lowered or whole), and the new one's from the parent's. */
function sidesOf(cells: readonly CellRow[], plan: SplitPlan) {
  const byId = new Map(cells.map((cell) => [cell.id, cell]))
  const kept = new Map(plan.keep.map((entry) => [entry.cellId, entry.quantity]))
  const removed = new Set(plan.remove)
  const parent = cells.filter((cell) => !removed.has(cell.id)).map((cell) => ({ ...cell, quantity: kept.get(cell.id) ?? cell.quantity }))
  // The new one's cells carry their parent cell's id until they are made (planned materials key by cell only).
  const child = plan.move.map((entry) => ({ ...byId.get(entry.fromCellId)!, quantity: entry.quantity }))
  return { parent, child }
}

/** The materials planned from these cells, per material and colour, in the base unit (no cost). */
function materialsOf(parts: SpecParts, cells: readonly CellRow[]) {
  const { materials } = planSpec(parts, cells)
  const groups = new Map<string, { first: PlannedMaterial; planned: Decimal }>()
  for (const row of materials) {
    const key = `${row.itemId}|${row.itemColourId ?? '-'}`
    const entry = groups.get(key) ?? { first: row, planned: ZERO }
    groups.set(key, { first: entry.first, planned: entry.planned.plus(row.baseQuantity) })
  }
  return [...groups.values()]
    .sort((a, b) => a.first.lineSeq - b.first.lineSeq)
    .map(({ first, planned }) => ({
      itemId: first.itemId,
      itemCode: parts.materials.get(first.itemId)?.code ?? '',
      itemName: parts.materials.get(first.itemId)?.name ?? '',
      itemColourId: first.itemColourId,
      colourCode: first.itemColourId ? (parts.itemColours.get(first.itemColourId)?.code ?? null) : null,
      baseUom: first.baseUom,
      planned: decimalText(planned),
    }))
}

function sideView(parts: SpecParts, cells: readonly CellRow[], own: boolean) {
  return {
    pieces: cells.reduce((sum, cell) => sum + cell.quantity, 0),
    cells: cells.map((cell) => ({
      cellId: own ? cell.id : null,
      fromCellId: cell.id,
      colourwayCode: cell.colourwayCode,
      colourwayName: cell.colourwayName,
      size: cell.size,
      salesOrderLineId: cell.salesOrderLineId,
      quantity: cell.quantity,
    })),
    materials: materialsOf(parts, cells),
  }
}

/** POST …/split/preview: what the split would do now, or why not (refusal, problems); nothing is written. */
export async function previewSplit(caller: CommandCaller, workOrderId: string, body: { readonly cells: readonly SplitAsk[] }) {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  return caller.withClient(async (client) => {
    const basics = await readBasics(client, workOrder)
    const refusal = splitRefusal(workOrder)
    const problems = refusal ? [] : splitProblems(basics.cells.map(splitCellOf), body.cells)
    const answer = {
      workOrderId: workOrder.id,
      number: workOrder.number,
      status: workOrder.status,
      version: workOrder.version,
      refusal,
      problems,
      numberPreview: await numberPreview(client, workOrder.companyId),
    }
    if (refusal || problems.length > 0) return { ...answer, parent: null, child: null }
    const sides = sidesOf(basics.cells, splitPlan(basics.cells.map(splitCellOf), body.cells))
    const parts = await readSpecParts(client, basics.revision?.id ?? null, workOrder.siteId)
    return { ...answer, parent: sideView(parts, sides.parent, true), child: sideView(parts, sides.child, false) }
  })
}

/** POST …/split: the new DRAFT work order with the asked pieces, split from this one (201: both records). */
export async function splitWorkOrder(caller: CommandCaller, workOrderId: string, body: SplitInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView; parent: WorkOrderView }> {
  const context = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  const refused = splitRefusal(workOrder)
  if (refused) throw new InvalidStateError(refused)

  const { result } = await command(
    caller,
    { name: 'workorders.split', idempotencyKey, input: { workOrderId, ...body }, record: { type: 'WorkOrder', id: workOrder.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const parent: Header = (await readWorkOrder(tx, workOrder.id))!
      const again = splitRefusal(parent)
      if (again) throw new InvalidStateError(again)
      const style = await tx.style.findUniqueOrThrow({ where: { id: parent.styleId }, select: STYLE_COLUMNS })
      const cells = await readCells(tx, parent.id, style.sizes)
      const problems = splitProblems(cells.map(splitCellOf), body.cells)
      if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These sizes cannot be split off.', problems)
      const plan = splitPlan(cells.map(splitCellOf), body.cells)
      const byId = new Map(cells.map((cell) => [cell.id, cell]))
      // The order lines' locks, as every draft of these lines takes them (their pieces only move between two work orders).
      await lockOrderLines(tx, context.tenantId, plan.move.map((entry) => byId.get(entry.fromCellId)!.salesOrderLineId))
      if (!(await hasSeries(tx, parent.companyId, 'WORK_ORDER'))) {
        throw new InvalidStateError('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
      }

      // The parent: cells lowered or removed; its drafted materials go (planned per cell: the release writes them again).
      for (const entry of plan.keep) await tx.workOrderSize.update({ where: { id: entry.cellId }, data: { quantity: entry.quantity, version: { increment: 1 } }, select: { id: true } })
      if (plan.remove.length > 0) await tx.workOrderSize.deleteMany({ where: { id: { in: [...plan.remove] } } })
      const materials = await clearDraftMaterials(tx, parent.id)

      // The new work order: the parent's style, revision, site and kind, its own dates and urgency, split from it.
      const id = newId()
      const number = await allocateNumber(tools, { companyId: parent.companyId, kind: 'WORK_ORDER' }, { type: 'WorkOrder', id })
      const dueDate = body.dueDate === undefined ? dayOrNull(parent.dueDate) : body.dueDate
      const priority = body.priority ?? parent.priority
      const rush = body.rush ?? parent.rush
      await tx.workOrder.create({
        data: {
          id,
          companyId: parent.companyId,
          siteId: parent.siteId,
          number: number.formatted,
          kind: parent.kind,
          styleId: parent.styleId,
          styleRevisionId: parent.styleRevisionId,
          dueDate: dueDate ? asDay(dueDate) : null,
          priority,
          rush,
          note: blankToNull(body.note),
          splitFromId: parent.id,
          createdById: actorIdOf(tools),
        },
        select: { id: true },
      })
      const childCells = plan.move.map((entry) => {
        const from = byId.get(entry.fromCellId)!
        return { id: newId(), siteId: parent.siteId, workOrderId: id, styleId: parent.styleId, colourwayId: from.colourwayId, size: from.size, quantity: entry.quantity, salesOrderLineId: from.salesOrderLineId, partyId: from.partyId, createdById: actorIdOf(tools) }
      })
      await tx.workOrderSize.createMany({ data: childCells })

      const moved = plan.move.map((entry) => {
        const from = byId.get(entry.fromCellId)!
        return { fromCellId: from.id, size: from.size, colourwayId: from.colourwayId, salesOrderLineId: from.salesOrderLineId, before: from.quantity, moved: entry.quantity }
      })
      const splitTo = { id, number: number.formatted }
      tools.audit({
        recordType: 'WorkOrder',
        recordId: parent.id,
        companyId: parent.companyId,
        siteId: parent.siteId,
        before: { cells: moved.map((entry) => ({ id: entry.fromCellId, quantity: entry.before })) },
        after: { splitTo, cells: moved.map((entry) => ({ id: entry.fromCellId, quantity: entry.before - entry.moved })), pieces: { moved: plan.moved, kept: plan.kept }, draftSpecCleared: { materials } },
      })
      tools.audit({
        recordType: 'WorkOrder',
        recordId: id,
        companyId: parent.companyId,
        siteId: parent.siteId,
        after: {
          number: number.formatted,
          status: 'DRAFT',
          kind: parent.kind,
          styleId: parent.styleId,
          styleRevisionId: parent.styleRevisionId,
          splitFromId: parent.id,
          dueDate,
          priority,
          rush,
          cells: childCells.map((cell) => ({ id: cell.id, salesOrderLineId: cell.salesOrderLineId, colourwayId: cell.colourwayId, size: cell.size, quantity: cell.quantity })),
        },
      })
      const salesOrderIds = [...new Set(moved.map((entry) => byId.get(entry.fromCellId)!.salesOrderId))]
      tools.emit({
        type: 'workorder.created',
        subject: id,
        companyId: parent.companyId,
        siteId: parent.siteId,
        payload: { workOrderId: id, number: number.formatted, siteId: parent.siteId, styleId: parent.styleId, salesOrderIds, cells: childCells.length, pieces: plan.moved, splitFromId: parent.id },
      })
      const left = await tx.workOrderSize.findMany({ where: { workOrderId: parent.id }, select: { quantity: true } })
      changedEvent(tools, parent, ['cells', 'split'], left)
      const today = todayOfCommand(tools)
      return {
        workOrder: await workOrderView(tx, (await readWorkOrder(tx, id))!, today),
        parent: await workOrderView(tx, (await readWorkOrder(tx, parent.id))!, today),
      }
    },
  )
  return result
}
