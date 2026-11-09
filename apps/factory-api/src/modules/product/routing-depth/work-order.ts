import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { FloorSettingsView, WorkOrderRoutingView } from '@nexus/factory-domain/product/routing-depth/contracts'
import { checkpointWords, effectiveDays, effectivityWords, minutesInSize, revisionOn, stepIsFor, variantWords, type StepVariants } from '@nexus/factory-domain/product/routing-depth/rules'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { scanWorkOrder } from '../../production/scans/access'
import { planSpec, readBasics, readSpecParts, repairSpecOf } from '../../production/work-orders/facts'
import { stepsForWorkOrder } from '../../production/work-orders/routing-copy'
import { cellLabel } from '../../production/work-orders/store'
import { officeWorkOrder } from '../../production/work-orders/work-orders'
import {
  checkpointViewOf,
  readColourwaysOf,
  readDepthSteps,
  readMachineClasses,
  readPlans,
  readSettings,
  REVISION_DAY_COLUMNS,
  revisionDaysOf,
  settingViewOf,
  textOrNull,
  variantsOfRow,
  type Db,
  type DepthRow,
} from './store'

/**
 * A work order's routing copy in depth (B-W2b-225; PRD-118, PRD-119, PRD-124, PRD-128):
 *
 *   GET /production/work-orders/:workOrderId/routing        (office, workorders.view) every operation of the work order —
 *        its stored copy once released (frozen), else what its release would copy from its cells — with the cells it is
 *        done on, minutes per garment of each of its sizes (the step's run + the size's extra minutes), set-up / wait /
 *        move, the checkpoint and the machine settings of its revision's step; the revision's steps it does not take; the
 *        revision's effective days and the style's current revision ("a work order made before keeps its frozen copy").
 *   GET /production/work-orders/:workOrderId/operations/:operationId/settings   (floor + office, production.scan at the
 *        device's site) what the tablet shows with the instruction: the step's machine and stitch settings, its
 *        instructions, its checkpoint in words and the cells it is for.
 *
 * Reads only. The depth stays on the revision's step (frozen with the released revision) and is read through the
 * operation's (styleRevisionId, routingSeq); an operation added to a released work order (no step) has none.
 */

async function sizeTimesOf(db: Db, stepIds: readonly string[]): Promise<Map<string, { size: string; extraMinutes: string }[]>> {
  const out = new Map<string, { size: string; extraMinutes: string }[]>()
  if (stepIds.length === 0) return out
  const rows = await db.routingOperationSizeTime.findMany({ where: { routingOperationId: { in: [...stepIds] } }, select: { routingOperationId: true, size: true, extraMinutes: true } })
  for (const row of rows) out.set(row.routingOperationId, [...(out.get(row.routingOperationId) ?? []), { size: row.size, extraMinutes: decimalText(row.extraMinutes.toString()) }])
  return out
}

export async function getWorkOrderRouting(caller: CommandCaller, workOrderId: string): Promise<WorkOrderRoutingView> {
  const header = await officeWorkOrder(caller, workOrderId)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const basics = await readBasics(db, header)
    const { style, cells, revision } = basics
    const steps: DepthRow[] = revision ? await readDepthSteps(db, revision.id) : []
    const stepBySeq = new Map(steps.map((step) => [step.seq, step]))
    const variantsOf = new Map<string, StepVariants>(steps.map((step) => [step.id, variantsOfRow(step)]))
    const cellFacts = cells.map((cell) => ({ colourwayId: cell.colourwayId, size: cell.size }))
    // As the work order record (W1, B-W2a-46): a DRAFT put on hold keeps its draft spec; nothing is frozen before the release.
    const frozen = header.status !== 'DRAFT' && !(header.status === 'ON_HOLD' && header.heldFromStatus === 'DRAFT')

    // The operations: the frozen copy once released, else what the release would copy (a repair draft: its chosen steps).
    let operations: { id: string | null; seq: number; routingSeq: number | null; code: string; name: string; standardMinutes: string; scanRequired: boolean; operationId: string | null }[]
    if (frozen) {
      const stored = await db.workOrderOperation.findMany({
        where: { workOrderId },
        select: { id: true, seq: true, routingSeq: true, code: true, name: true, standardMinutes: true, scanRequired: true, operationId: true },
        orderBy: { seq: 'asc' },
      })
      operations = stored.map((row) => ({ ...row, standardMinutes: decimalText(row.standardMinutes.toString()) }))
    } else {
      const parts = await readSpecParts(db, revision?.styleId === style.id ? revision.id : null, header.siteId)
      const spec = header.kind === 'REPAIR' ? await repairSpecOf(db, header.id, parts) : planSpec(parts, cells)
      operations = spec.operations.map((op) => ({ id: null, seq: op.seq, routingSeq: op.routingSeq, code: op.code, name: op.name, standardMinutes: op.standardMinutes, scanRequired: op.scanRequired, operationId: null }))
    }
    const taken = new Set(operations.flatMap((op) => (op.routingSeq === null ? [] : [op.routingSeq])))
    const leftOutSteps = frozen || header.kind === 'REPAIR' ? steps.filter((step) => !taken.has(step.seq)) : stepsForWorkOrder(steps, variantsOf, cellFacts).leftOut.map((entry) => entry.step)

    const usedSteps = operations.flatMap((op) => (op.routingSeq === null ? [] : [stepBySeq.get(op.routingSeq)].filter((step): step is DepthRow => step !== undefined)))
    const settings = await readSettings(db, 'step', usedSteps.map((step) => step.id))
    const classes = await readMachineClasses(db, [...settings.values()].flat().map((row) => row.machineClassId))
    const plans = await readPlans(db, usedSteps.map((step) => step.inspectionPlanId))
    const extras = await sizeTimesOf(db, usedSteps.map((step) => step.id))
    const colourways = await readColourwaysOf(db, style.id)
    const codeOf = (id: string) => colourways.find((row) => row.id === id)?.code ?? '?'
    const sizes = [...new Set(cells.map((cell) => cell.size))].sort((a, b) => style.sizes.indexOf(a) - style.sizes.indexOf(b))
    const libraryInstructions = new Map(
      (await db.operation.findMany({ where: { id: { in: operations.flatMap((op) => (op.operationId ? [op.operationId] : [])) } }, select: { id: true, instructions: true } })).map((row) => [row.id, row.instructions]),
    )

    const rows = operations.map((op) => {
      const step = op.routingSeq === null ? undefined : stepBySeq.get(op.routingSeq)
      const variants = step ? variantsOfRow(step) : null
      const plan = step?.inspectionPlanId ? plans.get(step.inspectionPlanId) : undefined
      const words = variants ? variantWords(variants, codeOf) : null
      return {
        id: op.id,
        seq: op.seq,
        routingSeq: op.routingSeq,
        stepId: step?.id ?? null,
        code: op.code,
        name: op.name,
        standardMinutes: op.standardMinutes,
        scanRequired: op.scanRequired,
        unplanned: op.routingSeq === null,
        forCells: cells.filter((cell) => !variants || stepIsFor(variants, cell)).map(cellLabel),
        variants: words ? { ...words } : null,
        minutesBySize: sizes.map((size) => ({ size, minutes: minutesInSize(op.standardMinutes, step ? (extras.get(step.id) ?? []) : [], size) })),
        setupMinutes: step ? textOrNull(step.setupMinutes) : null,
        waitMinutes: step ? textOrNull(step.waitMinutes) : null,
        moveMinutes: step ? textOrNull(step.moveMinutes) : null,
        checkpoint: plan ? checkpointViewOf(plan) : null,
        settings: step ? (settings.get(step.id) ?? []).map((row) => settingViewOf(row, classes)) : [],
        instructions: step ? step.instructions : op.operationId ? (libraryInstructions.get(op.operationId) ?? null) : null,
      }
    })

    let revisionView: WorkOrderRoutingView['revision'] = null
    if (revision && revision.styleId === style.id) {
      const days = effectiveDays((await db.styleRevision.findMany({ where: { styleId: style.id }, select: REVISION_DAY_COLUMNS })).map(revisionDaysOf))
      const mine = days.find((entry) => entry.revision.id === revision.id)!
      const current = revisionOn(days, today) ?? days.find((entry) => entry.revision.status === 'RELEASED') ?? null
      const other = current && current.revision.id !== revision.id ? current : null
      const words = other
        ? frozen
          ? effectivityWords(other, [{ revision: revision.revision, workOrders: 1 }])
          : { it: `Questo ordine di lavoro è sulla revisione ${revision.revision}; i nuovi usano la ${other.revision.revision} dal ${other.from}: sceglila prima del rilascio.`, en: `This work order is on revision ${revision.revision}; new ones use revision ${other.revision.revision} since ${other.from}: choose it before the release.` }
        : frozen
          ? { it: `Copia congelata del ciclo della revisione ${revision.revision}, quella in vigore.`, en: `A frozen copy of revision ${revision.revision}'s routing, the one in effect.` }
          : { it: `Il rilascio copierà il ciclo della revisione ${revision.revision}.`, en: `The release will copy revision ${revision.revision}'s routing.` }
      revisionView = {
        id: revision.id,
        revision: revision.revision,
        status: revision.status as 'DRAFT' | 'RELEASED' | 'OBSOLETE',
        effectiveFrom: mine.from,
        effectiveTo: mine.to,
        fromSource: mine.fromSource,
        current: other ? { id: other.revision.id, revision: other.revision.revision, since: other.from } : null,
        words: { ...words },
      }
    }

    return {
      workOrder: { id: header.id, number: header.number, status: header.status, kind: header.kind },
      frozen,
      revision: revisionView,
      cells: cells.map((cell) => ({ id: cell.id, label: cellLabel(cell), colourwayId: cell.colourwayId, size: cell.size, quantity: cell.quantity })),
      operations: rows,
      leftOut: leftOutSteps.map((step) => {
        const words = variantWords(variantsOfRow(step), codeOf)
        return {
          stepId: step.id,
          seq: step.seq,
          code: step.code,
          name: step.name,
          words: words
            ? { it: `${words.it}: nessuna cella dell'ordine di lavoro.`, en: `${words.en}: no cell of the work order.` }
            : { it: 'Non nella copia di questo ordine di lavoro.', en: "Not in this work order's copy." },
        }
      }),
    }
  })
}

/** GET …/operations/:operationId/settings: what the tablet shows with the instruction (floor at its own site, or office). */
export async function getFloorSettings(caller: CommandCaller, workOrderId: string, operationId: string): Promise<FloorSettingsView> {
  const header = await scanWorkOrder(caller, workOrderId, PRODUCTION_SCAN)
  return caller.withClient(async (db) => {
    const op = isUuid(operationId)
      ? await db.workOrderOperation.findFirst({ where: { id: operationId, workOrderId }, select: { id: true, seq: true, code: true, name: true, styleRevisionId: true, routingSeq: true, operationId: true } })
      : null
    if (!op) throw new NotFoundError('Operation not found.')
    const step = op.routingSeq === null ? null : await db.routingOperation.findFirst({ where: { revisionId: op.styleRevisionId, seq: op.routingSeq }, select: { id: true, styleId: true, instructions: true, inspectionPlanId: true, appliesToSizes: true, appliesToColourwayIds: true, appliesToOptionValueIds: true } })
    const settings = step ? ((await readSettings(db, 'step', [step.id])).get(step.id) ?? []) : []
    const classes = await readMachineClasses(db, settings.map((row) => row.machineClassId))
    const plan = step?.inspectionPlanId ? (await readPlans(db, [step.inspectionPlanId])).get(step.inspectionPlanId) : undefined
    const library = !step && op.operationId ? await db.operation.findUnique({ where: { id: op.operationId }, select: { instructions: true } }) : null
    const colourways = step ? await readColourwaysOf(db, step.styleId) : []
    const words = step ? variantWords(variantsOfRow(step), (id) => colourways.find((row) => row.id === id)?.code ?? '?') : null
    const checkpoint = plan ? checkpointWords(plan) : null
    return {
      operation: { id: op.id, seq: op.seq, code: op.code, name: op.name },
      workOrder: { id: header.id, number: header.number },
      instructions: step ? step.instructions : (library?.instructions ?? null),
      settings: settings.map((row) => settingViewOf(row, classes)),
      checkpoint: plan && checkpoint ? { code: plan.code, name: plan.name, kind: checkpoint.kind, does: { ...checkpoint.does } } : null,
      variants: words ? { ...words } : null,
    }
  })
}
