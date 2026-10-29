import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, isDomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { planRequirements } from '@nexus/factory-domain/planning/explode'
import { PLANNING_RUN } from '@nexus/factory-domain/planning/permissions'
import { command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../core/command'
import { officeContextOf, siteFor } from './access'
import type { RunView } from './contract'
import { ITEM_COLUMNS, lotFactsOf, planItemOf, readDemand, readLots, readPurchases, readStock, readSupplyRules, readWorkOrders, type SiteRow } from './store'
import { RUN_COLUMNS, runViewOf } from './views'

/**
 * Run the plan for a site (PLN-062; A2 SCR-055 "Run plan now"): ONE command reads the site's open orders, BOMs, work
 * orders, stock and open purchase orders in its own transaction, plans (factory-domain planning/explode), and writes
 * the run with its lines: the run is inserted RUNNING, its lines added, the site's previous DONE run SUPERSEDED and the
 * run DONE, all or nothing, with its audit rows and the event planning.run_finished. An Idempotency-Key makes a resent
 * request answer the same run.
 *
 * Two runs of one site never overlap: the command first takes the site's planning lock without waiting (a transaction
 * advisory lock): a second run while one goes is refused at once (409), never queued; a RUNNING row of the site (a run
 * the lock does not cover) refuses it too, and the …_supply_guards partial unique index ("one RUNNING run per site") is
 * the backstop. A run that fails for any other reason than a refusal is recorded as a FAILED run in a command of its
 * own (planning.run_failed), with a message that names the request, never the error: the previous plan stays.
 *
 * On demand only in W1 (SCOPE PLN-062: "one MRP run on demand for open orders"): no nightly cron.
 */

/** A run may take longer than an everyday command (it reads the whole site); still bounded. */
let runTimeoutMs = 60_000

/** Tests only: a shorter limit, to see a run fail. `undefined` restores the default. */
export function usePlanningRunTimeout(ms: number | undefined): void {
  runTimeoutMs = ms ?? 60_000
}

/** The site's planning lock, without waiting: true when taken (held until the transaction ends). */
const lockSite = async (tools: CommandTools, tenantId: string, siteId: string): Promise<boolean> => {
  const rows = await tools.tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.planning-run', ${tenantId}::uuid, ${siteId}::uuid), 0)) AS locked`
  return rows[0]?.locked === true
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

async function work(tools: CommandTools, site: SiteRow, note: string | null): Promise<{ run: RunView }> {
  const { tx, now, context } = tools
  if (context.audience !== 'office') throw new ForbiddenError()
  const actorId = context.actorId
  if (!(await lockSite(tools, context.tenantId, site.id))) throw new ConflictError('A planning run of this site is going; two runs never overlap. Look at its plan when it is done.')
  const running = await tx.planningRun.findFirst({ where: { siteId: site.id, status: 'RUNNING' }, select: { startedAt: true } })
  if (running) throw new ConflictError(`A planning run of this site is going since ${toUtcIso(running.startedAt)}; two runs never overlap.`)

  const runId = newId()
  try {
    await tx.planningRun.create({
      data: { id: runId, companyId: site.companyId, siteId: site.id, trigger: 'MANUAL', status: 'RUNNING', startedAt: now, note, createdById: actorId },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('A planning run of this site is going; two runs never overlap.')
    throw error
  }

  // ---- the inputs, in this transaction -------------------------------------------------------------------------------
  const runDate = businessDate(now, site.timezone)
  const demand = await readDemand(tx, site)
  const itemIds = [...new Set(demand.revisions.flatMap((revision) => revision.lines.map((line) => line.itemId)))].sort()
  const items = itemIds.length === 0 ? [] : await tx.item.findMany({ where: { id: { in: itemIds } }, select: ITEM_COLUMNS })
  const workOrders = await readWorkOrders(tx, site.id, demand.orderLines.map((line) => line.orderLineId))
  const stock = await readStock(tx, site.id, itemIds)
  const lots = await readLots(tx, stock.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))
  const purchases = await readPurchases(tx, site.id, itemIds)
  const supplyRulesOf = await readSupplyRules(tx, items, demand.revisions.flatMap((revision) => revision.lines.map((line) => line.supplierId)))

  const plan = planRequirements({
    runDate,
    orderLines: demand.orderLines,
    revisions: demand.revisions,
    items: items.map(planItemOf),
    workOrderCells: workOrders.cells,
    workOrderIssues: workOrders.issues,
    stock,
    lots: lots.map(lotFactsOf),
    purchases,
    supplyRulesOf,
  })
  const warnings = [...demand.unplaced, ...plan.warnings]

  // ---- the run's lines, the older plan superseded, the run DONE ----------------------------------------------------
  if (plan.requirements.length > 0) {
    await tx.materialRequirement.createMany({
      data: plan.requirements.map((line) => ({
        id: newId(),
        siteId: site.id,
        runId,
        seq: line.seq,
        itemId: line.itemId,
        itemColourId: line.itemColourId,
        action: line.action,
        uom: line.uom,
        grossQuantity: line.grossQuantity,
        usableStock: line.usableStock,
        heldStock: line.heldStock,
        onOrder: line.onOrder,
        netQuantity: line.netQuantity,
        suggestedQuantity: line.suggestedQuantity,
        suggestedUom: line.suggestedUom,
        needDate: dateOf(line.needDate),
        supplierId: line.supplierId,
        sources: line.sources as unknown as Prisma.InputJsonValue,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      })),
    })
  }
  const older = await tx.planningRun.findMany({ where: { siteId: site.id, status: 'DONE' }, select: { id: true, companyId: true } })
  for (const run of older) {
    await tx.planningRun.update({ where: { id: run.id }, data: { status: 'SUPERSEDED', version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'planning.run', recordType: 'PlanningRun', recordId: run.id, companyId: run.companyId, siteId: site.id, before: { status: 'DONE' }, after: { status: 'SUPERSEDED', supersededBy: runId } })
  }
  const done = await tx.planningRun.update({
    where: { id: runId },
    data: { status: 'DONE', finishedAt: now, orderLines: plan.orderLines, warnings: warnings as unknown as Prisma.InputJsonValue },
    select: RUN_COLUMNS,
  })
  const short = plan.requirements.filter((line) => line.netQuantity !== '0.0000').length
  tools.audit({
    recordType: 'PlanningRun',
    recordId: runId,
    companyId: site.companyId,
    siteId: site.id,
    after: { status: 'DONE', trigger: 'MANUAL', orderLines: plan.orderLines, requirements: plan.requirements.length, short, warnings: warnings.length, superseded: older.map((run) => run.id) },
  })
  tools.emit({
    type: 'planning.run_finished',
    subject: runId,
    companyId: site.companyId,
    siteId: site.id,
    payload: { runId, siteId: site.id, trigger: 'MANUAL', orderLines: plan.orderLines, requirements: plan.requirements.length, short, warnings: warnings.length, supersededRunId: older[0]?.id ?? null },
  })
  return { run: runViewOf(done, { requirements: plan.requirements.length, short }) }
}

/** planning.run: a new plan of the site (POST /planning/runs). */
export async function runPlan(caller: CommandCaller, body: { readonly siteId: string; readonly note?: string | undefined }, idempotencyKey?: string): Promise<{ run: RunView; replayed: boolean }> {
  officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_RUN)
  const note = body.note?.trim() ? body.note.trim() : null
  try {
    const { result, replayed } = await runCommand(
      caller,
      { name: 'planning.run', idempotencyKey, input: { siteId: site.id, note } },
      (tools) => work(tools, site, note),
      { ...COMMAND_SETTINGS, timeoutMs: runTimeoutMs },
    )
    return { ...result, replayed }
  } catch (error) {
    if (!isDomainError(error)) await recordFailure(caller, site).catch(() => undefined)
    throw error
  }
}

/** A run that could not be finished: a FAILED run of its own, so the run history says so (the previous plan stays). */
async function recordFailure(caller: CommandCaller, site: SiteRow): Promise<void> {
  const context = officeContextOf(caller)
  await command(caller, { name: 'planning.recordFailure', input: { siteId: site.id } }, async (tools) => {
    const runId = newId()
    const error = `The plan could not be finished (request ${context.requestId}). The previous plan stays; run it again, and if it fails again, give this request to support.`
    await tools.tx.planningRun.create({
      data: { id: runId, companyId: site.companyId, siteId: site.id, trigger: 'MANUAL', status: 'FAILED', startedAt: tools.now, finishedAt: tools.now, error, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: 'PlanningRun', recordId: runId, companyId: site.companyId, siteId: site.id, after: { status: 'FAILED' } })
    tools.emit({ type: 'planning.run_failed', subject: runId, companyId: site.companyId, siteId: site.id, payload: { runId, siteId: site.id } })
    return { runId }
  })
}
