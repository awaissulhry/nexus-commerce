import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { RoutingTimesQuery, RoutingTimesView, StepMinutesBody } from '@nexus/factory-domain/product/minutes/contracts'
import {
  inForceOn,
  isGoverned,
  leadMinutes,
  minutesBySize,
  minutesFromAllowances,
  planSizeTimes,
  sideMinutesOf,
  sizesBelowZero,
  stepMinutesIn,
  stepRunSourceOf,
  type SizeTime,
  type StepRun,
  type TimedStep,
} from '@nexus/factory-domain/product/minutes/rules'
import { minutesOf, sameMinutes } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { decimalText, roundTo } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { findRevision, STYLE_COLUMNS, type BomStyleRow, type RevisionRow } from '../bom/store'
import { assertMayWrite, lockDraft, readRevisionFor } from '../routing/store'
import { contextOf, MINUTES_OPERATION_COLUMNS, readVersionsOf, smvOnDay, storedMinutesOf, todayOf, type VersionRecord } from './store'

/**
 * A routing's times (B-W2b-215; PRD-111, PRD-113, PRD-114, PRD-126; design products.styles › Operations (routing) "SMV
 * (editable here; 'Library: 4.20 · Use library value')", "Setup / run / wait / move (W2b)", "Extra minutes for big sizes
 * (W2b)"; the cost sheet's cost by size reads the per-size minutes).
 *
 *   GET …/routing/times                  every step's run (where it comes from: an approved version, its own allowances,
 *                                        typed), the library's SMV today and whether the step follows it, set-up / wait /
 *                                        move, the cells it is for, its extra minutes per size; one garment per size with
 *                                        the extras; the set-up, wait and move a work order adds; with ?quantity (&size) a
 *                                        lead time (set-up + run × quantity + wait + move)
 *   PUT …/routing/steps/:stepId/minutes   a DRAFT step's minutes, under the revision's version (product.routing.manage):
 *                                        the run copied from an APPROVED version of its operation (the one in force today
 *                                        when none is named: the step names it and carries its five numbers, the database
 *                                        checks them), its own basic minutes and allowances, or typed (W1); set-up, wait
 *                                        and move (null clears one); the extra minutes per size, the whole list (a new run
 *                                        must leave every kept size above 0). One command: the step's row, its size rows,
 *                                        an audit row on the step and on the revision, `style.routing_changed`.
 *
 * Lock order (the routing's, ../routing/store): the style row, the revision's version, then the step and its size rows.
 */

const STEP_TIME_COLUMNS = {
  id: true,
  revisionId: true,
  seq: true,
  operationId: true,
  code: true,
  name: true,
  workCentreKind: true,
  standardMinutes: true,
  basicMinutes: true,
  personalPct: true,
  fatiguePct: true,
  delayPct: true,
  timeVersionId: true,
  setupMinutes: true,
  waitMinutes: true,
  moveMinutes: true,
  appliesToSizes: true,
  version: true,
} as const satisfies Prisma.RoutingOperationSelect
type StepTimeRow = Prisma.RoutingOperationGetPayload<{ select: typeof STEP_TIME_COLUMNS }>

const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))
const minutesRound = { scale: 3, rounding: 'HALF_UP' } as const

const runOf = (row: StepTimeRow): StepRun => ({ ...storedMinutesOf(row), timeVersionId: row.timeVersionId })

async function sizeTimesOf(client: FactoryClient | CommandTx, where: Prisma.RoutingOperationSizeTimeWhereInput): Promise<Map<string, SizeTime[]>> {
  const rows = await client.routingOperationSizeTime.findMany({ where, select: { routingOperationId: true, size: true, extraMinutes: true }, orderBy: [{ routingOperationId: 'asc' }, { size: 'asc' }] })
  const out = new Map<string, SizeTime[]>()
  for (const row of rows) out.set(row.routingOperationId, [...(out.get(row.routingOperationId) ?? []), { size: row.size, extraMinutes: decimalText(row.extraMinutes.toString()) }])
  return out
}

// ---- the view -----------------------------------------------------------------------------------------------------------

async function routingTimesOf(client: FactoryClient | CommandTx, style: BomStyleRow, revision: RevisionRow, query: RoutingTimesQuery, today: BusinessDate): Promise<RoutingTimesView> {
  if (query.size !== undefined && !style.sizes.includes(query.size)) {
    throw new ValidationError('No such size.', [{ path: 'querystring/size', message: `Size ${query.size} is not in the style's range (${style.sizes.join(', ')}).` }])
  }
  const steps = await client.routingOperation.findMany({ where: { revisionId: revision.id }, select: STEP_TIME_COLUMNS, orderBy: { seq: 'asc' } })
  const sizeTimes = await sizeTimesOf(client, { revisionId: revision.id })
  const operationIds = [...new Set(steps.map((step) => step.operationId))]
  const operations = operationIds.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: operationIds } }, select: MINUTES_OPERATION_COLUMNS })
  const operationOf = new Map(operations.map((operation) => [operation.id, operation]))
  const versionsOf = await readVersionsOf(client, operationIds)
  const sizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  const labelOf = new Map(sizes.map((size) => [size.code, size.label]))
  const rangeOrder = (a: SizeTime, b: SizeTime) => style.sizes.indexOf(a.size) - style.sizes.indexOf(b.size)

  const timed: TimedStep[] = []
  const stepViews = steps.map((step) => {
    const versions = versionsOf.get(step.operationId) ?? []
    const operation = operationOf.get(step.operationId)
    const library = operation ? smvOnDay(storedMinutesOf(operation), versions, today) : { standardMinutes: decimalText(step.standardMinutes.toString()), version: null }
    const run = runOf(step)
    const own = [...(sizeTimes.get(step.id) ?? [])].sort(rangeOrder)
    const entry: TimedStep = { standardMinutes: run.standardMinutes, setupMinutes: textOrNull(step.setupMinutes), waitMinutes: textOrNull(step.waitMinutes), moveMinutes: textOrNull(step.moveMinutes), sizeTimes: own, appliesToSizes: step.appliesToSizes }
    timed.push(entry)
    const copied = step.timeVersionId === null ? undefined : versions.find((version) => version.id === step.timeVersionId)
    return {
      stepId: step.id,
      seq: step.seq,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      operationId: step.operationId,
      run: {
        from: stepRunSourceOf(run),
        standardMinutes: run.standardMinutes,
        basicMinutes: run.basicMinutes,
        personalPct: run.personalPct,
        fatiguePct: run.fatiguePct,
        delayPct: run.delayPct,
        timeVersion: copied ? { id: copied.id, number: copied.number, status: copied.status, effectiveFrom: copied.effectiveFrom } : null,
      },
      library: {
        standardMinutes: library.standardMinutes,
        governed: isGoverned(versions),
        inForceVersionId: library.version?.id ?? null,
        inForceNumber: library.version?.number ?? null,
        differs: !sameMinutes(run.standardMinutes, library.standardMinutes),
      },
      setupMinutes: entry.setupMinutes,
      waitMinutes: entry.waitMinutes,
      moveMinutes: entry.moveMinutes,
      appliesToSizes: [...step.appliesToSizes],
      sizeTimes: own.map((time) => ({ ...time, minutes: decimalText(roundTo(stepMinutesIn({ ...entry, appliesToSizes: [] }, time.size), minutesRound)) })),
      version: step.version,
    }
  })
  const lead = query.quantity === undefined ? null : { quantity: query.quantity, size: query.size ?? null, ...leadMinutes(timed, [{ size: query.size ?? null, quantity: query.quantity }]) }
  const perWorkOrder = leadMinutes(timed, [])
  const perGarment = leadMinutes(timed, [{ size: null, quantity: 1 }]).run
  return {
    revision: { id: revision.id, revision: revision.revision, status: revision.status, version: revision.version },
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    sizes: style.sizes.map((code) => ({ code, label: labelOf.get(code) ?? code })),
    steps: stepViews,
    perGarment,
    bySize: minutesBySize(timed, style.sizes),
    setup: perWorkOrder.setup,
    wait: perWorkOrder.wait,
    move: perWorkOrder.move,
    lead,
    editable: revision.status === 'DRAFT' && style.status !== 'ARCHIVED',
  }
}

/** GET /product/styles/:styleId/revisions/:revisionId/routing/times */
export async function getRoutingTimes(caller: CommandCaller, styleId: string, revisionId: string, query: RoutingTimesQuery): Promise<RoutingTimesView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient((client) => routingTimesOf(client, style, revision, query, todayOf(serverClock.now())))
}

async function routingTimesInTx(tx: CommandTx, styleId: string, revisionId: string, today: BusinessDate): Promise<RoutingTimesView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return routingTimesOf(tx, style, await findRevision(tx, styleId, revisionId), {}, today)
}

// ---- the write ----------------------------------------------------------------------------------------------------------

const prefixed = (issues: readonly Issue[], at: string): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))

/** The run the body asks for (VERSION, ALLOWANCES or TYPED), checked; the step's own when the body sends none. */
function plannedRun(body: StepMinutesBody, current: StepRun, operationCode: string, versions: readonly VersionRecord[], today: BusinessDate): { run: StepRun; issues: Issue[] } {
  const run = body.run
  if (!run) return { run: current, issues: [] }
  if (run.from === 'TYPED') {
    const typed = minutesOf(run.standardMinutes)
    if (!typed.ok) return { run: current, issues: [{ path: 'body/run/standardMinutes', message: typed.message }] }
    return { run: { standardMinutes: typed.minutes, basicMinutes: null, personalPct: null, fatiguePct: null, delayPct: null, timeVersionId: null }, issues: [] }
  }
  if (run.from === 'ALLOWANCES') {
    const built = minutesFromAllowances(run)
    if (!built.ok) return { run: current, issues: prefixed(built.issues, 'body/run') }
    return { run: { ...built.minutes, timeVersionId: null }, issues: [] }
  }
  const chosen = run.timeVersionId === undefined ? inForceOn(versions, today) : (versions.find((version) => version.id === run.timeVersionId) ?? null)
  if (run.timeVersionId !== undefined && chosen === null) return { run: current, issues: [{ path: 'body/run/timeVersionId', message: `No such SMV version of operation ${operationCode}.` }] }
  if (chosen === null) {
    const waiting = versions.filter((version) => version.status === 'APPROVED').map((version) => `version ${version.number} from ${version.effectiveFrom}`)
    throw new InvalidStateError(
      waiting.length > 0
        ? `Operation ${operationCode} has no approved SMV in force today (${waiting.join(', ')}): name the version to copy.`
        : `Operation ${operationCode} has no approved SMV: propose one (Products › Operations › Minutes), or give the step its own minutes.`,
    )
  }
  if (chosen.status !== 'APPROVED') throw new InvalidStateError(`SMV version ${chosen.number} of operation ${operationCode} is ${chosen.status.toLowerCase()}: a step copies an APPROVED version.`)
  return {
    run: { standardMinutes: chosen.standardMinutes, basicMinutes: chosen.basicMinutes, personalPct: chosen.personalPct, fatiguePct: chosen.fatiguePct, delayPct: chosen.delayPct, timeVersionId: chosen.id },
    issues: [],
  }
}

type Side = 'setupMinutes' | 'waitMinutes' | 'moveMinutes'
const SIDES: readonly Side[] = ['setupMinutes', 'waitMinutes', 'moveMinutes']

function plannedSide(body: StepMinutesBody, field: Side, current: string | null, issues: Issue[]): string | null {
  const value = body[field]
  if (value === undefined) return current
  if (value === null) return null
  const outcome = sideMinutesOf(value)
  if (!outcome.ok) {
    issues.push({ path: `body/${field}`, message: outcome.message })
    return current
  }
  return outcome.minutes
}

const sameText = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : sameMinutes(a, b))
const sameRun = (a: StepRun, b: StepRun): boolean =>
  a.timeVersionId === b.timeVersionId && sameMinutes(a.standardMinutes, b.standardMinutes) && sameText(a.basicMinutes, b.basicMinutes) && sameText(a.personalPct, b.personalPct) && sameText(a.fatiguePct, b.fatiguePct) && sameText(a.delayPct, b.delayPct)
const sizeKey = (times: readonly SizeTime[]) => JSON.stringify([...times].sort((a, b) => a.size.localeCompare(b.size)).map((time) => [time.size, decimalText(time.extraMinutes)]))

/** PUT /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/minutes */
export async function setStepMinutes(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, body: StepMinutesBody, idempotencyKey?: string): Promise<RoutingTimesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.setStepMinutes', idempotencyKey, input: { styleId, revisionId, stepId, ...body } }, async (tools: CommandTools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const step = isUuid(stepId) ? await tx.routingOperation.findUnique({ where: { id: stepId }, select: STEP_TIME_COLUMNS }) : null
    if (!step || step.revisionId !== revisionId) throw new NotFoundError('Routing step not found.')
    const fullStyle = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const versions = (await readVersionsOf(tx, [step.operationId])).get(step.operationId) ?? []

    const current = runOf(step)
    const { run, issues } = plannedRun(body, current, step.code, versions, today)
    const sides = Object.fromEntries(SIDES.map((field) => [field, plannedSide(body, field, textOrNull(step[field]), issues)])) as Record<Side, string | null>
    const keptTimes = (await sizeTimesOf(tx, { routingOperationId: stepId })).get(stepId) ?? []
    let nextTimes: SizeTime[] = keptTimes
    if (body.sizeTimes !== undefined) {
      const planned = planSizeTimes(body.sizeTimes, fullStyle.sizes, run.standardMinutes, 'body/sizeTimes')
      if (planned.ok) nextTimes = planned.sizeTimes
      else issues.push(...planned.issues)
    } else {
      const below = sizesBelowZero(keptTimes, run.standardMinutes)
      if (below.length > 0) issues.push({ path: 'body/run', message: `With ${run.standardMinutes} minutes, size ${below.join(', ')} would take 0 or less: change its extra minutes in the same request (sizeTimes).` })
    }
    if (issues.length > 0) throw new ValidationError('The step\'s minutes are not valid.', issues)

    const runChanged = !sameRun(current, run)
    const sidesChanged = SIDES.filter((field) => !sameText(textOrNull(step[field]), sides[field]))
    const timesChanged = sizeKey(keptTimes) !== sizeKey(nextTimes)
    if (runChanged || sidesChanged.length > 0) {
      await tx.routingOperation.update({
        where: { id: stepId },
        data: {
          ...(runChanged
            ? { standardMinutes: run.standardMinutes, basicMinutes: run.basicMinutes, personalPct: run.personalPct, fatiguePct: run.fatiguePct, delayPct: run.delayPct, timeVersionId: run.timeVersionId }
            : {}),
          ...Object.fromEntries(sidesChanged.map((field) => [field, sides[field]])),
          version: { increment: 1 },
          updatedAt: now,
        },
        select: { id: true },
      })
    }
    if (timesChanged) {
      const wanted = new Map(nextTimes.map((time) => [time.size, time.extraMinutes]))
      const gone = keptTimes.filter((time) => !wanted.has(time.size)).map((time) => time.size)
      if (gone.length > 0) await tx.routingOperationSizeTime.deleteMany({ where: { routingOperationId: stepId, size: { in: gone } } })
      for (const time of nextTimes) {
        const kept = keptTimes.find((entry) => entry.size === time.size)
        if (kept && sameMinutes(kept.extraMinutes, time.extraMinutes)) continue
        if (kept) await tx.routingOperationSizeTime.updateMany({ where: { routingOperationId: stepId, size: time.size }, data: { extraMinutes: time.extraMinutes, version: { increment: 1 }, updatedAt: now } })
        else await tx.routingOperationSizeTime.create({ data: { id: newId(), revisionId, routingOperationId: stepId, size: time.size, extraMinutes: time.extraMinutes, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
      }
    }
    const fields = [...(runChanged ? ['run'] : []), ...sidesChanged, ...(timesChanged ? ['sizeTimes'] : [])]
    const auditedRun = (value: StepRun) => ({ from: stepRunSourceOf(value), ...value })
    tools.audit({
      action: 'product.routing.setStepMinutes',
      recordType: 'RoutingOperation',
      recordId: stepId,
      companyId: draft.style.companyId,
      before: { ...(runChanged ? { run: auditedRun(current) } : {}), ...Object.fromEntries(sidesChanged.map((field) => [field, textOrNull(step[field])])), ...(timesChanged ? { sizeTimes: keptTimes } : {}) },
      after: { ...(runChanged ? { run: auditedRun(run) } : {}), ...Object.fromEntries(sidesChanged.map((field) => [field, sides[field]])), ...(timesChanged ? { sizeTimes: nextTimes } : {}) },
    })
    tools.audit({ action: 'product.routing.setStepMinutes', recordType: 'StyleRevision', recordId: revisionId, companyId: draft.style.companyId, after: { routing: { minutes: stepId, fields }, version: draft.version } })
    tools.emit({
      type: 'style.routing_changed',
      subject: draft.style.id,
      companyId: draft.style.companyId,
      payload: { styleId: draft.style.id, code: draft.style.code, revisionId, revision: draft.revision, stepIds: [stepId] },
    })
    return routingTimesInTx(tx, styleId, revisionId, today)
  })
  return result
}
