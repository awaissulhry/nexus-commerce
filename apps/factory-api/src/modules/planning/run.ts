import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, isDomainError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { detectExceptions } from '@nexus/factory-domain/planning/exceptions/detect'
import { planRequirements } from '@nexus/factory-domain/planning/explode'
import { peggingRowsOf } from '@nexus/factory-domain/planning/pegging/pegging'
import { PLANNING_RUN } from '@nexus/factory-domain/planning/permissions'
import { command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../core/command'
import { officeContextOf, siteFor } from './access'
import type { RunView, Trigger } from './contract'
import { detectInputs, refreshExceptions } from './exceptions/refresh'
import { latestDoneRun, readPlanInputs } from './inputs'
import { unitsOf, type SiteRow } from './store'
import { fromBase, QUANTITY_SCALE, type Uom } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
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
 * On demand in W1 (SCOPE PLN-062: "one MRP run on demand for open orders").
 *
 * B-W2a-22 (MRP every day): the run also reads the site's ACTIVE reservations, item parameters and approved sources
 * (./inputs), carries the firm planned orders of the run it supersedes (PLN-075: a firm OPEN line becomes a line of this
 * run with the same firm columns, its quantity netted as planned supply by its date), writes the pegging of every line
 * (PLN-071: RequirementPegging, append-only, createMany in this transaction) and refreshes the site's exception list
 * (PLN-193: ./exceptions/refresh). The scheduler runs it every night at the site's PlanningSettings.scheduledRunTime
 * (./nightly, trigger SCHEDULED, as the tenant's system).
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

async function work(tools: CommandTools, site: SiteRow, note: string | null, trigger: Trigger): Promise<{ run: RunView }> {
  /** A carried firm quantity said in the line's unit (half up; never 0). */
  const firmIn = (baseQuantity: string, line: { itemId: string; suggestedUom: Uom }): string => {
    const item = inputs.items.find((entry) => entry.id === line.itemId)!
    const value = fromBase(baseQuantity, line.suggestedUom, unitsOf(item), { scale: QUANTITY_SCALE, rounding: 'HALF_UP' })
    return (value.gt(0) ? value : new Dec('0.0001')).toFixed(QUANTITY_SCALE)
  }
  const { tx, now, context } = tools
  if (context.audience !== 'office' && !(context.audience === 'system' && trigger === 'SCHEDULED')) throw new ForbiddenError()
  const actorId = context.audience === 'office' ? context.actorId : null
  if (!(await lockSite(tools, context.tenantId, site.id))) throw new ConflictError('A planning run of this site is going; two runs never overlap. Look at its plan when it is done.')
  const running = await tx.planningRun.findFirst({ where: { siteId: site.id, status: 'RUNNING' }, select: { startedAt: true } })
  if (running) throw new ConflictError(`A planning run of this site is going since ${toUtcIso(running.startedAt)}; two runs never overlap.`)
  // The plan this run supersedes: its firm planned orders are carried.
  const previous = await latestDoneRun(tx, site.id)

  const runId = newId()
  try {
    await tx.planningRun.create({
      data: { id: runId, companyId: site.companyId, siteId: site.id, trigger, status: 'RUNNING', startedAt: now, note, createdById: actorId },
      select: { id: true },
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError('A planning run of this site is going; two runs never overlap.')
    throw error
  }

  // ---- the inputs, in this transaction -------------------------------------------------------------------------------
  const runDate = businessDate(now, site.timezone)
  const inputs = await readPlanInputs(tx, site, runDate, previous?.id ?? null)
  const plan = planRequirements(inputs.input)
  const warnings = [...inputs.demand.unplaced, ...plan.warnings]

  // ---- the run's lines (a carried firm planned order with its firm columns), their pegging ----------------------------
  const idOf = new Map(plan.requirements.map((line) => [line.seq, newId()]))
  if (plan.requirements.length > 0) {
    await tx.materialRequirement.createMany({
      data: plan.requirements.map((line, index) => {
        const carried = plan.netting[index]!.carried
        return {
          id: idOf.get(line.seq)!,
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
          ...(carried
            ? {
                // In the line's unit (the firm order's own, unless the material no longer converts it).
                firmQuantity: carried.uom === line.suggestedUom ? carried.quantity : firmIn(carried.baseQuantity, line),
                firmBaseQuantity: carried.baseQuantity,
                firmDate: dateOf(carried.date),
                firmSupplierId: line.action === 'BUY' ? carried.supplierId : null,
                firmedAt: carried.firmedAt,
                firmedById: carried.firmedById,
                // B-W2b-20: the line it carries (the DB keeps a carried line firm at insert; it may be made planned
                // again later, keeping this as its history). Only of the same action: when the site's parameters
                // switched make or buy since, the DB's rule (same material, colour and action) does not hold.
                ...(carried.action === line.action ? { firmCarriedFromId: carried.requirementId } : {}),
              }
            : {}),
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        }
      }),
    })
    const pegging = plan.requirements.flatMap((line, index) =>
      peggingRowsOf(plan.netting[index]!.pegging, line.needDate).map((row) => ({
        id: newId(),
        siteId: site.id,
        runId,
        requirementId: idOf.get(line.seq)!,
        seq: row.seq,
        demandKind: row.demandKind,
        salesOrderLineId: row.salesOrderLineId,
        partyId: row.partyId,
        size: row.size,
        workOrderId: row.workOrderId,
        demandDate: dateOf(row.demandDate),
        quantity: row.quantity,
        supplyKind: row.supplyKind,
        reservationId: row.reservationId,
        purchaseOrderLineId: row.purchaseOrderLineId,
        supplyDate: row.supplyDate ? dateOf(row.supplyDate) : null,
        createdAt: now,
        createdById: actorId,
      })),
    )
    if (pegging.length > 0) await tx.requirementPegging.createMany({ data: pegging })
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

  // ---- the exception list of this run (PLN-193) -----------------------------------------------------------------------
  const conditions = detectExceptions({
    runDate,
    ...(await detectInputs(tools, site, inputs, plan, runDate)),
    purchaseOf: (lineId) => {
      const line = inputs.purchases.find((purchase) => purchase.purchaseOrderLineId === lineId)
      return line ? { purchaseOrderId: line.purchaseOrderId, purchaseOrderNumber: line.purchaseOrderNumber } : undefined
    },
  })
  const exceptions = await refreshExceptions(tools, site, runId, conditions, (seq) => (seq === null ? null : (idOf.get(seq) ?? null)))

  const short = plan.requirements.filter((line) => line.netQuantity !== '0.0000').length
  const carried = plan.netting.flatMap((entry) => (entry.carried ? [{ from: entry.carried.requirementId, to: idOf.get(entry.seq)! }] : []))
  tools.audit({
    recordType: 'PlanningRun',
    recordId: runId,
    companyId: site.companyId,
    siteId: site.id,
    after: { status: 'DONE', trigger, orderLines: plan.orderLines, requirements: plan.requirements.length, short, warnings: warnings.length, superseded: older.map((run) => run.id), carried, exceptions },
  })
  tools.emit({
    type: 'planning.run_finished',
    subject: runId,
    companyId: site.companyId,
    siteId: site.id,
    payload: { runId, siteId: site.id, trigger, orderLines: plan.orderLines, requirements: plan.requirements.length, short, warnings: warnings.length, supersededRunId: older[0]?.id ?? null },
  })
  tools.emit({ type: 'planning.exceptions_found', subject: runId, companyId: site.companyId, siteId: site.id, payload: { runId, siteId: site.id, ...exceptions } })
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
      (tools) => work(tools, site, note, 'MANUAL'),
      { ...COMMAND_SETTINGS, timeoutMs: runTimeoutMs },
    )
    return { ...result, replayed }
  } catch (error) {
    if (!isDomainError(error)) await recordFailure(caller, site, 'MANUAL').catch(() => undefined)
    throw error
  }
}

/**
 * The nightly run (./nightly): the site's plan as the tenant's system (trigger SCHEDULED, no person), its key fixed per
 * site and day so a tick that runs twice answers from the first one's receipt. A run that is going is not waited for.
 */
export async function runScheduledPlan(caller: CommandCaller, site: SiteRow, day: string): Promise<{ run: RunView; replayed: boolean }> {
  if (caller.factoryContext?.audience !== 'system') throw new UnauthenticatedError()
  try {
    const { result, replayed } = await runCommand(
      caller,
      { name: 'planning.run', idempotencyKey: `planning-nightly:${site.id}:${day}`, input: { siteId: site.id, scheduled: day } },
      (tools) => work(tools, site, null, 'SCHEDULED'),
      { ...COMMAND_SETTINGS, timeoutMs: runTimeoutMs },
    )
    return { ...result, replayed }
  } catch (error) {
    if (!isDomainError(error)) await recordFailure(caller, site, 'SCHEDULED').catch(() => undefined)
    throw error
  }
}

/** A run that could not be finished: a FAILED run of its own, so the run history says so (the previous plan stays). */
async function recordFailure(caller: CommandCaller, site: SiteRow, trigger: Trigger): Promise<void> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  await command(caller, { name: 'planning.recordFailure', input: { siteId: site.id } }, async (tools) => {
    const runId = newId()
    const error = `The plan could not be finished (request ${context.requestId}). The previous plan stays; run it again, and if it fails again, give this request to support.`
    await tools.tx.planningRun.create({
      data: { id: runId, companyId: site.companyId, siteId: site.id, trigger, status: 'FAILED', startedAt: tools.now, finishedAt: tools.now, error, createdById: context.audience === 'office' ? context.actorId : null },
      select: { id: true },
    })
    tools.audit({ recordType: 'PlanningRun', recordId: runId, companyId: site.companyId, siteId: site.id, after: { status: 'FAILED' } })
    tools.emit({ type: 'planning.run_failed', subject: runId, companyId: site.companyId, siteId: site.id, payload: { runId, siteId: site.id } })
    return { runId }
  })
}
