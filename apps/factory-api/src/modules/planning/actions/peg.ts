import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { pegProblem, pegWords } from '@nexus/factory-domain/planning/actions/pegs'
import { PLANNING_FIRM } from '@nexus/factory-domain/planning/mrp/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf, seesCost } from '../access'
import type { LineView } from '../contract'
import { lineViewOf, readLineContext, REQUIREMENT_COLUMNS, sourcesOf } from '../views'

/**
 * Order-specific supply (B-W2b-306; PLN-072 "hard-pegged supply for special orders"): POST
 * /planning/requirements/:requirementId/order-specific keeps a material of the site's LATEST plan for one order line alone
 * (orderLineId: one of the orders behind the line), or for every order again (null). The next runs carry it: that order
 * line's need of the material is a line of its own, netted only against what is its own (factory-domain planning/actions
 * pegs, planning/explode `orderSpecific`); what is bought from a line planned for it alone serves only it. While the line is
 * OPEN (fixed once ordered or set aside: the database's rule). planning.firm over the site (the planner's act on a line of
 * the latest plan, as making it firm). ONE command on the PlanningRun (its version bump keeps a new run from superseding
 * it meanwhile), then compare-and-set on the line's version; audited `planning.peg`; event material_requirement.pegged.
 */

const todayAt = (timezone: string) => businessDate(serverClock.now(), timezone)

export async function pegRequirement(caller: CommandCaller, requirementId: string, body: { readonly version: number; readonly orderLineId: string | null }, idempotencyKey?: string): Promise<{ line: LineView; words: string; replayed: boolean }> {
  const office = officeContextOf(caller)
  const target = await caller.withClient(async (db) => {
    const row = isUuid(requirementId) ? await db.materialRequirement.findUnique({ where: { id: requirementId }, select: { id: true, runId: true, run: { select: { companyId: true, siteId: true, site: { select: { timezone: true } } } } } }) : null
    assertMayAt(office, PLANNING_FIRM, row ? { companyId: row.run.companyId, siteId: row.run.siteId } : null, 'Requirement')
    return { id: row!.id, runId: row!.runId, companyId: row!.run.companyId, siteId: row!.run.siteId, timezone: row!.run.site.timezone }
  })
  const { result, replayed } = await command(
    caller,
    { name: 'planning.peg', idempotencyKey, input: { requirementId, ...body }, record: { type: 'PlanningRun', id: target.runId } },
    async (tools) => {
      const { tx } = tools
      const run = await tx.planningRun.findUniqueOrThrow({ where: { id: target.runId }, select: { status: true } })
      const line = await tx.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: { ...REQUIREMENT_COLUMNS, orderSpecific: true, reservedForLineId: true, reservedForPartyId: true } })
      const sources = sourcesOf(line.sources)
      const problem = pegProblem({ decision: line.decision, orderSpecific: line.orderSpecific, reservedForLineId: line.reservedForLineId, sources }, run.status, body.orderLineId)
      if (problem) throw new ConflictError(problem)
      if (line.version !== body.version) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      let partyId: string | null = null
      if (body.orderLineId) {
        const orderLine = await tx.salesOrderLine.findUnique({ where: { id: body.orderLineId }, select: { partyId: true } })
        if (!orderLine) throw new ValidationError('That order line is not found.', [{ path: 'body/orderLineId', message: 'Pick one of the orders behind the line.' }])
        partyId = orderLine.partyId
      }
      const { count } = await tx.materialRequirement.updateMany({
        where: { id: line.id, version: body.version },
        data: { orderSpecific: body.orderLineId !== null, reservedForLineId: body.orderLineId, reservedForPartyId: partyId, version: body.version + 1 },
      })
      if (count !== 1) throw new StaleVersionError('MaterialRequirement', line.id, line.version, body.version)
      tools.audit({ action: 'planning.peg', recordType: 'MaterialRequirement', recordId: line.id, companyId: target.companyId, siteId: target.siteId, before: { orderSpecific: line.orderSpecific, reservedForLineId: line.reservedForLineId }, after: { orderSpecific: body.orderLineId !== null, reservedForLineId: body.orderLineId } })
      tools.emit({ type: 'material_requirement.pegged', subject: target.runId, companyId: target.companyId, siteId: target.siteId, payload: { runId: target.runId, siteId: target.siteId, requirementId: line.id, orderLineId: body.orderLineId } })
      return { words: pegWords({ sources }, body.orderLineId) }
    },
  )
  const withCost = seesCost(office)
  const line = await caller.withClient(async (db) => {
    const row = await db.materialRequirement.findUniqueOrThrow({ where: { id: requirementId }, select: REQUIREMENT_COLUMNS })
    return lineViewOf(row, await readLineContext(db, [row], withCost), todayAt(target.timezone), withCost)
  })
  return { line, words: result.words, replayed }
}
