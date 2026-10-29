import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { decisionProblem } from '@nexus/factory-domain/planning/decisions'
import { hidesFor } from '@nexus/factory-domain/planning/buy'
import { QUANTITY_SCALE, toBase } from '@nexus/factory-domain/product/units/units'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../core/command'
import { dayOf, ITEM_COLUMNS, unitsOf } from './store'
import { quantityOf, REQUIREMENT_COLUMNS } from './views'

/**
 * The hook purchasing (B-W1-30, "Draft PO") calls INSIDE its own command, after its own permission checks
 * (purchasing.*; the planning permissions are not asked again): what a line proposes, and the line's decision when a
 * purchase order line buys it, or stops buying it. Each locks the line's run first (FOR UPDATE: a new run that would
 * supersede it, a set aside, and another Draft PO wait), then compares and sets the line's version.
 *
 *   proposalFor(tx, id)                        the purchase line a requirement proposes (no write)
 *   orderRequirement(tools, { … })             OPEN → ORDERED with the purchase order line that buys it (a BUY line of
 *                                              the latest DONE run, same material and colour, same site)
 *   unorderRequirement(tools, { … })           ORDERED → OPEN, before purchasing removes that line from its draft
 *                                              (MaterialRequirement.purchaseOrderLineId is a Restrict reference)
 *
 * Both audit and emit planning.requirements_decided. A superseded run's lines can no longer change (the …_supply_guards
 * trigger): a draft line named by one stays named (purchasing cancels or changes it, never deletes it).
 */

export interface PurchaseProposal {
  readonly requirementId: string
  readonly runId: string
  readonly siteId: string
  readonly supplierId: string | null
  readonly itemId: string
  readonly itemColourId: string | null
  /** In `uom`, the item's purchase unit: the run's suggestion. */
  readonly quantity: string
  readonly uom: string
  /** The same in the item's base unit (what the purchase line's baseQuantity is). */
  readonly baseQuantity: string
  readonly needDate: string
  /** Leather: about how many hides (PurchaseOrderLine.estimatedHides). */
  readonly estimatedHides: number | null
  /** Copied from the item (PurchaseOrderLine.requiresCrViTest). */
  readonly requiresCrViTest: boolean
  readonly version: number
}

/** What a requirement proposes to buy; a MAKE line or one with nothing short proposes nothing (409). */
export async function proposalFor(tx: CommandTx, requirementId: string): Promise<PurchaseProposal> {
  const row = isUuid(requirementId) ? await tx.materialRequirement.findUnique({ where: { id: requirementId }, select: REQUIREMENT_COLUMNS }) : null
  if (!row) throw new NotFoundError('Requirement not found.')
  if (row.action !== 'BUY') throw new ConflictError('A part we make is not bought: it has no purchase line.')
  if (!row.suggestedQuantity.gt(0)) throw new ConflictError('Nothing is short on this line: there is nothing to buy.')
  const item = await tx.item.findUniqueOrThrow({ where: { id: row.itemId }, select: ITEM_COLUMNS })
  const units = unitsOf(item)
  const base = toBase(row.suggestedQuantity.toString(), row.suggestedUom, units, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }).toFixed(QUANTITY_SCALE)
  return {
    requirementId: row.id,
    runId: row.runId,
    siteId: row.siteId,
    supplierId: row.supplierId,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    quantity: quantityOf(row.suggestedQuantity),
    uom: row.suggestedUom,
    baseQuantity: base,
    needDate: dayOf(row.needDate),
    estimatedHides: hidesFor(base, units),
    requiresCrViTest: item.requiresCrViTest,
    version: row.version,
  }
}

async function lockLine(tools: CommandTools, requirementId: string) {
  const row = isUuid(requirementId)
    ? await tools.tx.materialRequirement.findUnique({ where: { id: requirementId }, select: { id: true, runId: true, siteId: true, itemId: true, itemColourId: true, action: true, decision: true, version: true, purchaseOrderLineId: true } })
    : null
  if (!row) throw new NotFoundError('Requirement not found.')
  await tools.tx.$queryRaw`SELECT id FROM "PlanningRun" WHERE id = ${row.runId}::uuid FOR UPDATE`
  const run = await tools.tx.planningRun.findUniqueOrThrow({ where: { id: row.runId }, select: { status: true, companyId: true } })
  const line = await tools.tx.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: { decision: true, action: true, version: true, purchaseOrderLineId: true } })
  return { row: { ...row, ...line }, run }
}

async function setDecision(
  tools: CommandTools,
  locked: Awaited<ReturnType<typeof lockLine>>,
  expectedVersion: number | undefined,
  data: { decision: 'OPEN' | 'ORDERED'; purchaseOrderLineId: string | null },
): Promise<{ id: string; version: number }> {
  const { row, run } = locked
  const version = expectedVersion ?? row.version
  if (version !== row.version) throw new StaleVersionError('MaterialRequirement', row.id, row.version, version)
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const decided = data.decision === 'OPEN' ? { decidedAt: null, decidedById: null } : { decidedAt: tools.now, decidedById: actorId }
  const { count } = await tools.tx.materialRequirement.updateMany({
    where: { id: row.id, version },
    data: { decision: data.decision, purchaseOrderLineId: data.purchaseOrderLineId, decisionNote: null, ...decided, version: version + 1 },
  })
  if (count !== 1) throw new StaleVersionError('MaterialRequirement', row.id, row.version, version)
  tools.audit({
    action: data.decision === 'ORDERED' ? 'planning.order' : 'planning.unorder',
    recordType: 'MaterialRequirement',
    recordId: row.id,
    companyId: run.companyId,
    siteId: row.siteId,
    before: { decision: row.decision, purchaseOrderLineId: row.purchaseOrderLineId },
    after: { decision: data.decision, purchaseOrderLineId: data.purchaseOrderLineId },
  })
  tools.emit({
    type: 'planning.requirements_decided',
    subject: row.runId,
    companyId: run.companyId,
    siteId: row.siteId,
    payload: { runId: row.runId, siteId: row.siteId, decision: data.decision, requirementIds: [row.id] },
  })
  return { id: row.id, version: version + 1 }
}

/** OPEN → ORDERED: the purchase order line buys this requirement (same site, material and colour). */
export async function orderRequirement(tools: CommandTools, input: { readonly requirementId: string; readonly purchaseOrderLineId: string; readonly expectedVersion?: number }): Promise<{ id: string; version: number }> {
  const locked = await lockLine(tools, input.requirementId)
  const problem = decisionProblem(locked.row, locked.run.status, 'ORDERED')
  if (problem) throw new ConflictError(problem)
  const line = isUuid(input.purchaseOrderLineId)
    ? await tools.tx.purchaseOrderLine.findUnique({ where: { id: input.purchaseOrderLineId }, select: { siteId: true, itemId: true, itemColourId: true } })
    : null
  if (!line) throw new NotFoundError('Purchase order line not found.')
  if (line.siteId !== locked.row.siteId || line.itemId !== locked.row.itemId || line.itemColourId !== locked.row.itemColourId) {
    throw new ConflictError('The purchase order line buys another material, colour or site than the requirement.')
  }
  return setDecision(tools, locked, input.expectedVersion, { decision: 'ORDERED', purchaseOrderLineId: input.purchaseOrderLineId })
}

/** ORDERED → OPEN: the line's purchase order line is about to be removed from its draft (a line of the latest DONE run). */
export async function unorderRequirement(tools: CommandTools, input: { readonly requirementId: string; readonly expectedVersion?: number }): Promise<{ id: string; version: number }> {
  const locked = await lockLine(tools, input.requirementId)
  if (locked.run.status !== 'DONE') throw new ConflictError('A newer plan replaced this one: its lines no longer change.')
  if (locked.row.decision !== 'ORDERED') throw new ConflictError('The line is not ordered.')
  return setDecision(tools, locked, input.expectedVersion, { decision: 'OPEN', purchaseOrderLineId: null })
}
