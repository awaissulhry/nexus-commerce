import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { firmInputProblems, firmProblem } from '@nexus/factory-domain/planning/mrp/firm'
import { PLANNING_FIRM } from '@nexus/factory-domain/planning/mrp/permissions'
import { QUANTITY_SCALE, toBase } from '@nexus/factory-domain/product/units/units'
import { isApproved } from '@nexus/factory-domain/purchasing/sources/sources'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller } from '../../core/command'
import { serverClock } from '../../core/time'
import { activeSourcesOf } from '../purchasing/supplier-items/store'
import { assertMayAt, officeContextOf, seesCost } from './access'
import type { LineView } from './contract'
import { dayOf, ITEM_COLUMNS, unitsOf } from './store'
import { lineViewOf, quantityOf, readLineContext, REQUIREMENT_COLUMNS } from './views'

/**
 * Firm planned orders (B-W2a-22; PLN-075; design planning.mrp "firm and convert"): a planner fixes what a line of the
 * site's LATEST plan brings — how much (in the line's suggested unit), by when (not before today), for a buy from which
 * supplier (an approved source's when the material has sources, else anyone; left out: the line's) — and the next runs
 * keep it as planned supply instead of planning it again. Unfirm makes it planned again (all six columns cleared). ONE
 * command on the PlanningRun (its version bump keeps a new run from superseding it meanwhile), then compare-and-set on
 * the line's version; audited, event planning.requirement_firmed. An ORDERED line's firm order is fixed (its purchase
 * order line says it); a set-aside line is never firm.
 */

const todayAt = (timezone: string) => businessDate(serverClock.now(), timezone)

async function lineFor(caller: CommandCaller, requirementId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(requirementId) ? await db.materialRequirement.findUnique({ where: { id: requirementId }, select: { id: true, runId: true, run: { select: { companyId: true, siteId: true, site: { select: { timezone: true, companyId: true } } } } } }) : null
    assertMayAt(context, PLANNING_FIRM, row ? { companyId: row.run.companyId, siteId: row.run.siteId } : null, 'Requirement')
    return { id: row!.id, runId: row!.runId, companyId: row!.run.companyId, siteId: row!.run.siteId, timezone: row!.run.site.timezone }
  })
}

async function viewOf(caller: CommandCaller, requirementId: string, timezone: string): Promise<LineView> {
  const context = officeContextOf(caller)
  const withCost = seesCost(context)
  return caller.withClient(async (db) => {
    const row = await db.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: REQUIREMENT_COLUMNS })
    return lineViewOf(row, await readLineContext(db, [row], withCost), todayAt(timezone), withCost)
  })
}

export interface FirmBody {
  readonly version: number
  readonly quantity: string
  readonly date: string
  readonly supplierId?: string | undefined
}

/** POST /planning/requirements/:requirementId/firm: make the line a firm planned order (or change it). */
export async function firmLine(caller: CommandCaller, requirementId: string, body: FirmBody, idempotencyKey?: string): Promise<{ line: LineView; replayed: boolean }> {
  const target = await lineFor(caller, requirementId)
  const today = todayAt(target.timezone)
  const problems = firmInputProblems(body, today)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { replayed } = await command(
    caller,
    { name: 'planning.firm', idempotencyKey, input: { requirementId, ...body }, record: { type: 'PlanningRun', id: target.runId } },
    async (tools) => {
      const { tx, now, context } = tools
      const run = await tx.planningRun.findUniqueOrThrow({ where: { id: target.runId }, select: { status: true } })
      const line = await tx.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: { ...REQUIREMENT_COLUMNS } })
      const problem = firmProblem(line, run.status, 'FIRM', line.firmedAt !== null)
      if (problem) throw new ConflictError(problem)
      if (line.version !== body.version) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      if (line.action === 'MAKE' && body.supplierId) throw new ValidationError('A part we make has no supplier.', [{ path: 'body/supplierId', message: 'Leave the supplier out for a part we make.' }])
      const units = unitsOf(await tx.item.findUniqueOrThrow({ where: { id: line.itemId }, select: ITEM_COLUMNS }))
      let base: string
      try {
        base = toBase(body.quantity, line.suggestedUom, units, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }).toFixed(QUANTITY_SCALE)
      } catch {
        throw new ConflictError(`The material no longer converts ${line.suggestedUom} to its base unit; run the plan again.`)
      }
      if (!new Dec(base).gt(0)) throw new ValidationError('The quantity is too small to keep.', [{ path: 'body/quantity', message: 'Give a larger quantity.' }])
      const supplierId = line.action === 'BUY' ? (body.supplierId ?? line.firmSupplierId ?? line.supplierId) : null
      if (supplierId && body.supplierId) {
        const party = await tx.party.findUnique({ where: { id: supplierId }, select: { id: true, roles: true, status: true } })
        if (!party || !party.roles.includes('SUPPLIER')) throw new ValidationError('The supplier is not a supplier.', [{ path: 'body/supplierId', message: 'Pick a supplier.' }])
        if (party.status !== 'ACTIVE') throw new ConflictError('The supplier is not active: pick another one.')
        const sources = await activeSourcesOf(tx, [line.itemId])
        if (!isApproved(sources, { companyId: target.companyId, itemId: line.itemId, itemColourId: line.itemColourId }, supplierId)) {
          throw new ValidationError('The supplier is not an approved source of this material.', [{ path: 'body/supplierId', message: 'Pick one of its approved sources.' }])
        }
      }
      const actorId = context.audience === 'office' ? context.actorId : null
      const before = { firmQuantity: line.firmQuantity ? quantityOf(line.firmQuantity) : null, firmBaseQuantity: line.firmBaseQuantity ? quantityOf(line.firmBaseQuantity) : null, firmDate: line.firmDate ? dayOf(line.firmDate) : null, firmSupplierId: line.firmSupplierId }
      const quantity = quantityOf(body.quantity)
      const { count } = await tx.materialRequirement.updateMany({
        where: { id: line.id, version: body.version },
        data: { firmQuantity: quantity, firmBaseQuantity: base, firmDate: new Date(`${body.date}T00:00:00.000Z`), firmSupplierId: supplierId, firmedAt: now, firmedById: actorId, version: body.version + 1 },
      })
      if (count !== 1) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      tools.audit({
        action: 'planning.firm',
        recordType: 'MaterialRequirement',
        recordId: line.id,
        companyId: target.companyId,
        siteId: target.siteId,
        before,
        after: { firmQuantity: quantity, firmBaseQuantity: base, firmDate: body.date, firmSupplierId: supplierId },
      })
      tools.emit({ type: 'planning.requirement_firmed', subject: target.runId, companyId: target.companyId, siteId: target.siteId, payload: { runId: target.runId, siteId: target.siteId, requirementId: line.id, firm: true } })
      return { requirementId: line.id }
    },
  )
  return { line: await viewOf(caller, requirementId, target.timezone), replayed }
}

/** POST /planning/requirements/:requirementId/unfirm: the line is planned again (the next run plans it freely). */
export async function unfirmLine(caller: CommandCaller, requirementId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ line: LineView; replayed: boolean }> {
  const target = await lineFor(caller, requirementId)
  const { replayed } = await command(
    caller,
    { name: 'planning.unfirm', idempotencyKey, input: { requirementId, ...body }, record: { type: 'PlanningRun', id: target.runId } },
    async (tools) => {
      const { tx } = tools
      const run = await tx.planningRun.findUniqueOrThrow({ where: { id: target.runId }, select: { status: true } })
      const line = await tx.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: { ...REQUIREMENT_COLUMNS } })
      const problem = firmProblem(line, run.status, 'PLANNED', line.firmedAt !== null)
      if (problem) throw new ConflictError(problem)
      if (line.version !== body.version) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      const { count } = await tx.materialRequirement.updateMany({
        where: { id: line.id, version: body.version },
        data: { firmQuantity: null, firmBaseQuantity: null, firmDate: null, firmSupplierId: null, firmedAt: null, firmedById: null, version: body.version + 1 },
      })
      if (count !== 1) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      tools.audit({
        action: 'planning.unfirm',
        recordType: 'MaterialRequirement',
        recordId: line.id,
        companyId: target.companyId,
        siteId: target.siteId,
        before: { firmQuantity: quantityOf(line.firmQuantity!), firmBaseQuantity: quantityOf(line.firmBaseQuantity!), firmDate: dayOf(line.firmDate!), firmSupplierId: line.firmSupplierId },
        after: { firmQuantity: null },
      })
      tools.emit({ type: 'planning.requirement_firmed', subject: target.runId, companyId: target.companyId, siteId: target.siteId, payload: { runId: target.runId, siteId: target.siteId, requirementId: line.id, firm: false } })
      return { requirementId: line.id }
    },
  )
  return { line: await viewOf(caller, requirementId, target.timezone), replayed }
}
