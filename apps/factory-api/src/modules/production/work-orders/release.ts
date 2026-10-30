import { ConflictError, DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { workOrderMachine } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_RELEASE } from '@nexus/factory-domain/production/work-orders/permissions'
import { releaseRefusal, type MaterialLine, type ReleaseChecklist } from '@nexus/factory-domain/production/work-orders/release'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { checklistOf, readBasics, readReleaseFacts, type ReleaseFacts } from './facts'
import { officeContextOf } from './access'
import { clearDraftSpec, readWorkOrder, type Header } from './store'
import { workOrderView, type WorkOrderView } from './views'
import { officeWorkOrder, onWorkOrder, todayNow, todayOfCommand } from './work-orders'
import { readinessPart } from './release/blockers'

/** B-W2a-46: a DRAFT, or a DRAFT put on hold (its release check shows the hold as a blocker). */
const beforeRelease = (row: Pick<Header, 'status' | 'heldFromStatus'>): boolean => row.status === 'DRAFT' || (row.status === 'ON_HOLD' && row.heldFromStatus === 'DRAFT')

/**
 * The release (B-W1-38; MES-005, MES-076; plan A1 §2.5 "Work order"; PLAN §4.7 stage 10-work-order "release WO (frozen
 * spec)"): ONE command on the work order — its version bump locks its row; the site's release lock (an advisory lock
 * per site, waited for) makes two releases at one site take their turns, so each counts the material the other promised;
 * the style row FOR SHARE holds its revision as released until the commit (a new revision's release waits) — then the
 * release check (./facts checklistOf: THE check, the one the record shows) on the rows as they are now, a 409 listing
 * every blocker before the database is asked, and the frozen spec written: the draft's stored parts replaced by one
 * operation per routing step at the site's work centres and the planned materials (BOM line × cell), the revision's
 * label template, the batch number from the company's BATCH series (unique in the tenant), RELEASED with its time. The
 * …_production_guards trigger checks the same at the update, for every login.
 *
 * A material shortage passes only with the planner's override and its reason: recorded in the release's audit row (its
 * reason and `after.materialOverride`, read back by the record) and flagged on the event. WorkOrder has no column for it
 * yet (a later schema step).
 */

/** The release check of a work order as the record shows it (a DRAFT; afterwards the frozen spec card replaces it). */
export async function releaseCheck(caller: CommandCaller, workOrderId: string) {
  const workOrder = await officeWorkOrder(caller, workOrderId)
  return caller.withClient(async (client) => {
    if (!beforeRelease(workOrder)) return checkAnswer(workOrder, null)
    // The record shows the plan's readiness beside the checks: read it always here.
    const facts = await readReleaseFacts(client, await readBasics(client, workOrder), todayNow(), undefined, 'always')
    return checkAnswer(workOrder, checklistOf(facts, null), facts.material, facts.blockers)
  })
}

function checkAnswer(workOrder: Pick<Header, 'id' | 'number' | 'status' | 'version' | 'heldFromStatus'>, checklist: ReleaseChecklist | null, material: readonly MaterialLine[] = [], blockers: ReleaseFacts['blockers'] | null = null) {
  return {
    workOrderId: workOrder.id,
    number: workOrder.number,
    status: workOrder.status,
    version: workOrder.version,
    frozen: !beforeRelease(workOrder),
    releasable: checklist?.releasable ?? false,
    checks: checklist ? checklist.checks.map((check) => ({ ...check, problems: [...check.problems] })) : [],
    blockers: checklist ? [...checklist.blockers] : [],
    materials: material.map((line) => ({ ...line, held: [...line.held] })),
    // B-W2a-46: the plan's readiness beside the checks, and the holds that block the release.
    readiness: readinessPart(blockers?.readiness ?? null),
    holds: blockers ? blockers.holds.map((hold) => ({ ...hold })) : [],
  }
}

/** Two releases at one site take their turns (waited for, never refused): each sees what the other promised. */
async function lockSiteReleases(tx: CommandTx, tenantId: string, siteId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-release', ${tenantId}::uuid, ${siteId}::uuid), 0))`
}

export interface ReleaseInput {
  readonly version?: number | undefined
  /** The planner's override of a material shortage, with its reason. */
  readonly materialOverride?: { readonly reason: string } | undefined
}

/** workorders.release: the release, or a 409 with every blocker in words. */
export async function releaseWorkOrder(caller: CommandCaller, workOrderId: string, body: ReleaseInput, idempotencyKey?: string): Promise<{ workOrder: WorkOrderView }> {
  const { tenantId } = officeContextOf(caller)
  const workOrder = await officeWorkOrder(caller, workOrderId, WORKORDERS_RELEASE)
  if (!beforeRelease(workOrder)) throw new InvalidStateError(`Work order ${workOrder.number} is ${workOrder.status}; it was released already.`)
  return onWorkOrder(caller, workOrder, { name: 'workorders.release', idempotencyKey, input: { workOrderId, ...body }, version: body.version }, async (tools) => {
    const { tx, now } = tools
    await lockSiteReleases(tx, tenantId, workOrder.siteId)
    await tx.$queryRaw`SELECT 1 FROM "Style" WHERE "id" = ${workOrder.styleId}::uuid FOR SHARE`
    const current = (await readWorkOrder(tx, workOrder.id))!
    if (!beforeRelease(current)) throw new InvalidStateError(`Work order ${current.number} is ${current.status}; it was released already.`)

    const facts = await readReleaseFacts(tx, await readBasics(tx, current), todayOfCommand(tools))
    const override = body.materialOverride ?? null
    const checklist = checklistOf(facts, override)
    if (!checklist.releasable) throw new DomainError('invalid_state', releaseRefusal(current.number, checklist), checklist.blockers)
    assertTransition(workOrderMachine, current.status, 'RELEASED', { releaseBlockers: [] })
    const revision = facts.revision!
    const label = facts.label!
    const overridden = checklist.checks.find((check) => check.code === 'MATERIAL' && check.state === 'OVERRIDDEN') ?? null

    // The frozen spec: the draft's stored parts (if any) replaced by the ones built now. A repair (B-W2a-12, MES-019)
    // keeps the steps stored on its draft as they are, and plans no material.
    const repair = current.kind === 'REPAIR'
    const cleared = repair ? { operations: 0, materials: 0 } : await clearDraftSpec(tx, current.id)
    const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
    if (!repair) await tx.workOrderOperation.createMany({
      data: facts.spec.operations.map((op) => ({
        id: newId(),
        siteId: current.siteId,
        workOrderId: current.id,
        styleRevisionId: revision.id,
        seq: op.seq,
        routingSeq: op.routingSeq,
        code: op.code,
        name: op.name,
        standardMinutes: op.standardMinutes,
        scanRequired: op.scanRequired,
        workCentreId: op.workCentreId!,
        createdById: actorId,
      })),
    })
    if (!repair) await tx.workOrderMaterial.createMany({
      data: facts.spec.materials.map((material) => ({
        id: newId(),
        siteId: current.siteId,
        workOrderId: current.id,
        styleRevisionId: revision.id,
        bomLineId: material.bomLineId,
        itemId: material.itemId,
        itemColourId: material.itemColourId,
        workOrderSizeId: material.cellId,
        quantity: material.quantity,
        uom: material.uom,
        baseQuantity: material.baseQuantity,
        createdById: actorId,
      })),
    })

    const batch = await allocateNumber(tools, { companyId: current.companyId, kind: 'BATCH' }, { type: 'WorkOrder', id: current.id })
    const taken = await tx.workOrder.findFirst({ where: { batchNumber: batch.formatted }, select: { number: true } })
    if (taken) {
      throw new ConflictError(`Batch number ${batch.formatted} is already on work order ${taken.number}: a batch number is unique in the tenant, so give each company's batch series its own prefix.`)
    }
    await tx.workOrder.update({
      where: { id: current.id },
      data: { status: 'RELEASED', labelTemplateId: label.id, batchNumber: batch.formatted, releasedAt: now, releasedById: actorId },
      select: { id: true },
    })

    const pieces = facts.cells.reduce((sum, cell) => sum + cell.quantity, 0)
    const materialOverride = overridden ? { reason: override!.reason.trim(), shortages: overridden.problems.map((problem) => problem.message) } : null
    tools.audit({
      recordType: 'WorkOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: 'DRAFT', ...(cleared.operations + cleared.materials > 0 ? { draftSpec: cleared } : {}) },
      after: {
        status: 'RELEASED',
        releasedAt: toUtcIso(now),
        batchNumber: batch.formatted,
        styleRevisionId: revision.id,
        revision: revision.revision,
        labelTemplateId: label.id,
        cells: facts.cells.length,
        pieces,
        operations: facts.spec.operations.length,
        materials: facts.spec.materials.length,
        checks: checklist.checks.map((check) => ({ code: check.code, state: check.state })),
        materialOverride,
      },
      ...(materialOverride ? { reason: materialOverride.reason } : {}),
    })
    tools.emit({
      type: 'workorder.released',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: {
        workOrderId: current.id,
        number: current.number,
        batchNumber: batch.formatted,
        siteId: current.siteId,
        styleId: current.styleId,
        styleRevisionId: revision.id,
        labelTemplateId: label.id,
        salesOrderIds: facts.orders.map((order) => order.id),
        cells: facts.cells.length,
        pieces,
        operations: facts.spec.operations.length,
        materials: facts.spec.materials.length,
        materialOverride: materialOverride !== null,
      },
    })
    // The record reads the override back from this audit row, which command() writes after the work: say it here.
    const view = await workOrderView(tx, (await readWorkOrder(tx, current.id))!, todayOfCommand(tools))
    const release = view.release && materialOverride ? { ...view.release, materialOverride: { ...materialOverride, byId: actorId, at: toUtcIso(now) } } : view.release
    return { workOrder: { ...view, release } }
  })
}
