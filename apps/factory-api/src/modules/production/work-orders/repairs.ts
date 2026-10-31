import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { WORKORDERS_MANAGE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import {
  liveWorkOrderProblem,
  NO_GARMENT_WORDS,
  repairGarmentOf,
  repairLineProblems,
  repairSizeOf,
  repairStageProblem,
  repairStepPlan,
  type GarmentRef,
  type RepairFacts,
} from '@nexus/factory-domain/production/work-orders/repair'
import type { PlannedOperation } from '@nexus/factory-domain/production/work-orders/spec'
import { reworkRoundOf, type RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { readSteps } from '../../product/routing/read'
import { officeContextOf } from './access'
import { asDay, clearDraftMaterials, hasSeries, lockedStatus, readOrderLines, readReleasedRevision, readWorkOrder, REVISION_COLUMNS, SITE_COLUMNS, STYLE_COLUMNS, syncDraftOperations, type LineRow, type Reader, type RevisionRow } from './store'
import { workOrderView, type WorkOrderView } from './views'
import { officeWorkOrder, onWorkOrder, todayOfCommand } from './work-orders'

/**
 * Repair work orders (B-W2a-12; MES-019 "Repair work order from a return"; design sales.returns "Repair order" › Work ›
 * Repair stages "Make repair work order", "Repair work order (link)"): a WorkOrder of kind REPAIR at the repair order's
 * site for its one garment, with only the routing steps the repair needs; then the W1 release (./release: THE release
 * check with a repair's own answers, factory-domain production/work-orders/repair) and moves. B-W2a-57 (repairs) calls
 * these from the repair order's screens; the repair order's stages are its own.
 *
 *   make    ONE command on the RepairOrder (its version bump locks it, so two "Make repair work order" taps make one):
 *           the repair still before its repair is done and without a live repair work order (B-W2b-16: back into
 *           repair after it was repaired, a DONE one no longer counts: the new one is the rework's) → the garment's sold line
 *           (asked, its RMA line's, or its serial's cell) checked against the repair → the revision (asked, the line's,
 *           else the style's released one) and the chosen steps at the site's work centres → the number from the
 *           company's WORK_ORDER series → the DRAFT, its one cell (one garment; a made-to-measure one keeps its profile),
 *           its operations (stored on the draft; the release freezes them as they are) → RepairOrder.workOrderId (wave 2).
 *   steps   a repair DRAFT's steps chosen again (workorders.manage, its version).
 *   options what the "Make repair work order" dialog needs: the repair, the garment found, the revision and its routing
 *           steps (each with whether the site can run it), and what stops it, in words.
 */

export const REPAIR_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  number: true,
  kind: true,
  stage: true,
  returnLineId: true,
  serial: true,
  styleId: true,
  colourwayId: true,
  size: true,
  workOrderId: true,
  version: true,
} as const

type RepairRow = { id: string; companyId: string; siteId: string; partyId: string; number: string; kind: string; stage: string; returnLineId: string | null; serial: string | null; styleId: string | null; colourwayId: string | null; size: string | null; workOrderId: string | null; version: number }

async function readRepair(db: Reader, repairOrderId: string): Promise<RepairRow | null> {
  return isUuid(repairOrderId) ? db.repairOrder.findUnique({ where: { id: repairOrderId }, select: REPAIR_COLUMNS }) : null
}

/** The repair the office may see (else 404) and make a work order for with `permission` (else 403). */
async function officeRepair(caller: CommandCaller, repairOrderId: string, permission: Permission = WORKORDERS_MANAGE): Promise<RepairRow> {
  const context = officeContextOf(caller)
  const repair = await caller.withClient((client) => readRepair(client, repairOrderId))
  const scope = repair ? { companyId: repair.companyId, siteId: repair.siteId } : null
  if (!repair || !can(actorOf(context), WORKORDERS_VIEW, scope!)) throw new NotFoundError('Repair order not found.')
  if (!can(actorOf(context), permission, scope!)) throw new ForbiddenError()
  return repair
}

/** B-W2b-16: back into repair after it was repaired (its last stage move came from REPAIRED): a rework round. */
async function reworkRound(db: Reader, repair: Pick<RepairRow, 'id' | 'stage'>): Promise<boolean> {
  if (repair.stage !== 'IN_REPAIR') return false
  const last = await db.repairStageEvent.findFirst({ where: { repairId: repair.id }, select: { fromStage: true, stage: true }, orderBy: [{ repairVersion: 'desc' }, { at: 'desc' }] })
  return reworkRoundOf(repair.stage as RepairStage, last ? [{ from: last.fromStage as RepairStage | null, to: last.stage as RepairStage }] : [])
}

const repairFacts = (repair: RepairRow): RepairFacts => ({ number: repair.number, companyId: repair.companyId, partyId: repair.partyId, styleId: repair.styleId, colourwayId: repair.colourwayId, size: repair.size })

/** Where the garment was sold, from the repair's own records: its RMA line, else the cell its serial was made in. */
async function knownGarment(db: Reader, repair: RepairRow): Promise<{ returnLine: GarmentRef | null; serialCell: GarmentRef | null }> {
  const line = repair.returnLineId ? await db.returnLine.findUnique({ where: { id: repair.returnLineId }, select: { salesOrderLineId: true, size: true } }) : null
  const returnLine = line?.salesOrderLineId ? { salesOrderLineId: line.salesOrderLineId, size: line.size } : null
  if (returnLine || !repair.serial) return { returnLine, serialCell: null }
  const serial = await db.garmentSerial.findFirst({ where: { serial: repair.serial.trim() }, select: { workOrderSizeId: true } })
  const cell = serial ? await db.workOrderSize.findUnique({ where: { id: serial.workOrderSizeId }, select: { salesOrderLineId: true, size: true } }) : null
  return { returnLine: null, serialCell: cell ? { salesOrderLineId: cell.salesOrderLineId, size: cell.size } : null }
}

/** The revision a repair is made to: asked, else the one the line fixes, else the style's released one. */
async function repairRevision(db: Reader, styleId: string, asked: string | undefined, line: LineRow): Promise<RevisionRow | null> {
  const chosen = asked ?? line.styleRevisionId ?? null
  if (!chosen) return readReleasedRevision(db, styleId)
  const revision = await db.styleRevision.findUnique({ where: { id: chosen }, select: REVISION_COLUMNS })
  if (!revision || revision.styleId !== styleId) throw new ValidationError('Not a revision of the style.', [{ path: 'body/styleRevisionId', message: "Expected a revision of the garment's style." }])
  if (revision.status === 'OBSOLETE') throw new ValidationError(`Revision ${revision.revision} is OBSOLETE.`, [{ path: 'body/styleRevisionId', message: 'Expected the RELEASED revision (or a DRAFT one, released before the work order).' }])
  return revision
}

const operationRows = (operations: readonly PlannedOperation[], workOrder: { id: string; siteId: string }, revisionId: string, actorId: string | null) =>
  operations.map((op) => ({
    id: newId(),
    siteId: workOrder.siteId,
    workOrderId: workOrder.id,
    styleRevisionId: revisionId,
    seq: op.seq,
    routingSeq: op.routingSeq,
    code: op.code,
    name: op.name,
    standardMinutes: op.standardMinutes,
    scanRequired: op.scanRequired,
    workCentreId: op.workCentreId!,
    createdById: actorId,
  }))

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The chosen steps at the site's work centres (400 in words). */
async function plannedSteps(tx: CommandTx, revision: RevisionRow, siteId: string, seqs: readonly number[]): Promise<PlannedOperation[]> {
  const steps = await readSteps(tx, revision.id)
  const centres = await tx.workCentre.findMany({ where: { siteId }, select: { id: true, code: true, name: true, kind: true, status: true } })
  const plan = repairStepPlan(steps, seqs, centres, revision.revision, 'body/routingSeqs')
  if (plan.problems.length > 0) throw new ValidationError(plan.problems.length === 1 ? plan.problems[0]!.message : 'These steps cannot be the repair.', plan.problems)
  return plan.operations
}

// ---- make ------------------------------------------------------------------------------------------------------------

export interface RepairInput {
  readonly repairOrderId: string
  /** The repair order's version as read (the edit-conflict guard). */
  readonly version?: number | undefined
  /** The routing steps (their places in the revision's routing) the repair needs. */
  readonly routingSeqs: readonly number[]
  /** The sales order line the garment was sold on, when the repair names no RMA line or known serial. */
  readonly salesOrderLineId?: string | undefined
  readonly size?: string | undefined
  readonly styleRevisionId?: string | undefined
  readonly dueDate?: BusinessDate | undefined
  readonly priority?: number | undefined
  readonly note?: string | null | undefined
}

export async function createRepairWorkOrder(caller: CommandCaller, body: RepairInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const repair = await officeRepair(caller, body.repairOrderId)
  const { result } = await command(caller, { name: 'workorders.createRepair', idempotencyKey, input: body, record: { type: 'RepairOrder', id: repair.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await readRepair(tx, repair.id))!
    const stage = repairStageProblem(current.number, current.stage)
    if (stage) throw new InvalidStateError(stage)
    const existing = current.workOrderId ? await tx.workOrder.findUnique({ where: { id: current.workOrderId }, select: { number: true, status: true } }) : null
    const live = liveWorkOrderProblem(current.number, existing, await reworkRound(tx, current))
    if (live) throw new InvalidStateError(live)

    const known = await knownGarment(tx, current)
    const garment = repairGarmentOf({ asked: body.salesOrderLineId ? { salesOrderLineId: body.salesOrderLineId, size: body.size ?? null } : null, ...known })
    if (!garment) throw new ValidationError(NO_GARMENT_WORDS, [{ path: 'body/salesOrderLineId', message: NO_GARMENT_WORDS }])
    const lineAt = garment.from === 'ASKED' ? 'body/salesOrderLineId' : 'repair'
    const line = (await readOrderLines(tx, [garment.salesOrderLineId])).get(garment.salesOrderLineId)
    if (!line) throw new ValidationError('Not a sales order line.', [{ path: lineAt, message: 'Expected the sales order line the garment was sold on.' }])
    const size = repairSizeOf({ salesOrderLineId: line.id, size: body.size ?? garment.size }, repairFacts(current), line)
    const problems = repairLineProblems(repairFacts(current), line, size, lineAt)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : "The garment's sales order line does not fit the repair.", problems)

    const site = await tx.site.findUniqueOrThrow({ where: { id: current.siteId }, select: SITE_COLUMNS })
    if (site.kind !== 'PLANT' || site.status !== 'ACTIVE') throw new InvalidStateError(`Repair ${current.number}'s site ${site.code} is not an active plant: a work order is made at a plant.`)
    const style = await tx.style.findUniqueOrThrow({ where: { id: line.styleId }, select: STYLE_COLUMNS })
    const revision = await repairRevision(tx, style.id, body.styleRevisionId, line)
    if (!revision) throw new InvalidStateError(`Style ${style.code} has no released revision: release one (Product › Styles) before its repair work order.`)
    const operations = await plannedSteps(tx, revision, site.id, body.routingSeqs)
    if (!(await hasSeries(tx, site.companyId, 'WORK_ORDER'))) {
      throw new InvalidStateError('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
    }

    const id = newId()
    const actorId = actorIdOf(tools)
    const number = await allocateNumber(tools, { companyId: site.companyId, kind: 'WORK_ORDER' }, { type: 'WorkOrder', id })
    await tx.workOrder.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        number: number.formatted,
        kind: 'REPAIR',
        styleId: style.id,
        styleRevisionId: revision.id,
        dueDate: body.dueDate ? asDay(body.dueDate) : null,
        priority: body.priority ?? 0,
        note: body.note?.trim() || null,
        createdById: actorId,
      },
      select: { id: true },
    })
    const cell = {
      id: newId(),
      siteId: site.id,
      workOrderId: id,
      styleId: style.id,
      colourwayId: line.colourwayId,
      size: size!,
      quantity: 1,
      salesOrderLineId: line.id,
      partyId: line.partyId,
      measurementProfileId: line.measurementProfileId,
      createdById: actorId,
    }
    await tx.workOrderSize.create({ data: cell, select: { id: true } })
    await tx.workOrderOperation.createMany({ data: operationRows(operations, { id, siteId: site.id }, revision.id, actorId) })
    await tx.repairOrder.update({ where: { id: current.id }, data: { workOrderId: id }, select: { id: true } })
    tools.audit({
      recordType: 'WorkOrder',
      recordId: id,
      companyId: site.companyId,
      siteId: site.id,
      after: {
        number: number.formatted,
        status: 'DRAFT',
        kind: 'REPAIR',
        repairOrderId: current.id,
        styleId: style.id,
        styleRevisionId: revision.id,
        garmentFrom: garment.from,
        cells: [{ id: cell.id, salesOrderLineId: line.id, colourwayId: line.colourwayId, size: cell.size, quantity: 1, measurementProfileId: line.measurementProfileId }],
        steps: operations.map((op) => op.routingSeq),
      },
    })
    tools.audit({ recordType: 'RepairOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { workOrderId: current.workOrderId }, after: { workOrderId: id }, ...(existing && existing.status !== 'CANCELLED' ? { reason: `Rework after ${existing.number} (${existing.status}): the repair went back into repair.` } : {}) })
    tools.emit({
      type: 'workorder.created',
      subject: id,
      companyId: site.companyId,
      siteId: site.id,
      payload: { workOrderId: id, number: number.formatted, siteId: site.id, styleId: style.id, salesOrderIds: [line.orderId], cells: 1, pieces: 1, repairOrderId: current.id },
    })
    return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, id))!, todayOfCommand(tools)) }
  })
  return result
}

// ---- the steps of a repair DRAFT -------------------------------------------------------------------------------------------

export async function setRepairSteps(caller: CommandCaller, workOrderId: string, body: { readonly version?: number | undefined; readonly routingSeqs: readonly number[] }, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_MANAGE)
  if (workOrder.kind !== 'REPAIR') throw new InvalidStateError(`Work order ${workOrder.number} is a ${workOrder.kind === 'SIZE_GRID' ? 'size run' : 'made-to-measure unit'}: it takes its revision's whole routing at the release; only a repair chooses its steps.`)
  return onWorkOrder(caller, workOrder, { name: 'workorders.setRepairSteps', idempotencyKey, input: { workOrderId, ...body }, version: body.version }, async (tools) => {
    const { tx } = tools
    const current = await lockedStatus(tx, workOrder.id, ['DRAFT'], 'its steps change')
    const revision = current.styleRevisionId ? await tx.styleRevision.findUnique({ where: { id: current.styleRevisionId }, select: REVISION_COLUMNS }) : null
    if (!revision) throw new InvalidStateError(`Work order ${current.number} names no revision.`)
    const operations = await plannedSteps(tx, revision, current.siteId, body.routingSeqs)
    const before = await tx.workOrderOperation.findMany({ where: { workOrderId: current.id }, select: { routingSeq: true }, orderBy: { seq: 'asc' } })
    // B-W2a-F3: a step that stays keeps its operation's row (the planning board's bars that book it stay); a step left
    // out is refused while a bar books it.
    await clearDraftMaterials(tx, current.id)
    await syncDraftOperations(tx, current, revision.id, operations, actorIdOf(tools), {
      doing: 'Leaving out these steps',
      then: 'change the steps',
      published: 'keep those steps on the repair',
    })
    tools.audit({ recordType: 'WorkOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { steps: before.map((op) => op.routingSeq) }, after: { steps: operations.map((op) => op.routingSeq) } })
    tools.emit({ type: 'workorder.changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { workOrderId: current.id, number: current.number, changes: ['steps'], cells: 1, pieces: 1 } })
    return { workOrder: await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools)) }
  })
}

// ---- what the dialog needs ------------------------------------------------------------------------------------------------

export async function repairOptions(caller: CommandCaller, repairOrderId: string) {
  const repair = await officeRepair(caller, repairOrderId, WORKORDERS_VIEW)
  return caller.withClient(async (client) => {
    const blockers: string[] = []
    const stage = repairStageProblem(repair.number, repair.stage)
    if (stage) blockers.push(stage)
    const existing = repair.workOrderId ? await client.workOrder.findUnique({ where: { id: repair.workOrderId }, select: { id: true, number: true, status: true } }) : null
    const live = liveWorkOrderProblem(repair.number, existing, await reworkRound(client, repair))
    if (live) blockers.push(live)
    const known = await knownGarment(client, repair)
    const garment = repairGarmentOf({ asked: null, ...known })
    const line = garment ? (await readOrderLines(client, [garment.salesOrderLineId])).get(garment.salesOrderLineId) ?? null : null
    const size = garment && line ? repairSizeOf(garment, repairFacts(repair), line) : null
    const garmentProblems = line ? repairLineProblems(repairFacts(repair), line, size, 'repair').map((problem) => problem.message) : garment ? ['The sales order line the garment was sold on is not found.'] : [NO_GARMENT_WORDS]
    const styleId = line?.styleId ?? repair.styleId
    const revision = styleId && line ? await repairRevision(client, styleId, undefined, line) : styleId ? await readReleasedRevision(client, styleId) : null
    if (!revision) blockers.push(styleId ? 'The style has no released revision: release one (Product › Styles) first.' : 'The repair names no style and no sold line: name the sales order line the garment was sold on.')
    const site = await client.site.findUniqueOrThrow({ where: { id: repair.siteId }, select: SITE_COLUMNS })
    if (site.kind !== 'PLANT' || site.status !== 'ACTIVE') blockers.push(`Site ${site.code} is not an active plant: a work order is made at a plant.`)
    if (!(await hasSeries(client, repair.companyId, 'WORK_ORDER'))) blockers.push('The company has no active work order number series: an admin sets one up under Numbering (kind WORK_ORDER).')
    const steps = revision ? await readSteps(client, revision.id) : []
    const centres = await client.workCentre.findMany({ where: { siteId: repair.siteId, status: 'ACTIVE' }, select: { kind: true } })
    const kinds = new Set(centres.map((centre) => centre.kind))
    return {
      repair: { id: repair.id, number: repair.number, kind: repair.kind, stage: repair.stage, version: repair.version, siteId: repair.siteId, siteCode: site.code, serial: repair.serial },
      workOrder: existing ? { id: existing.id, number: existing.number, status: existing.status } : null,
      garment: garment && line ? { from: garment.from, salesOrderLineId: line.id, orderNumber: line.orderNumber, lineSeq: line.seq, kind: line.kind, size, problems: garmentProblems } : { from: null, salesOrderLineId: null, orderNumber: null, lineSeq: null, kind: null, size: null, problems: garmentProblems },
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
      steps: steps.map((step) => ({ seq: step.seq, code: step.code, name: step.name, workCentreKind: step.workCentreKind, standardMinutes: step.standardMinutes, available: kinds.has(step.workCentreKind) })),
      blockers,
    }
  })
}
