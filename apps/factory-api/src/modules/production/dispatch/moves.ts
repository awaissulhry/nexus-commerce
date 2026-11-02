import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_DISPATCH_MANAGE } from '@nexus/factory-domain/production/dispatch/permissions'
import { assignmentKindOf, byLane, DISPATCH_REFUSALS, isPastDay, laneNumbers, laneOrderIssue, movePlan, placementsOf, REST_CARD, type MovePlan, type MoveTarget } from '@nexus/factory-domain/production/dispatch/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertPersonDecides } from '../../people/privacy/decide'
import { floorChecksFor } from '../settings/floor-rules'
import { scanSubjectFor } from '../settings/subject'
import { knownSite, officeOf, refuse } from './access'
import { assertNameable, assertStationDoes, checkPerson, emitChange, type Override } from './assignments'
import { ASSIGNMENT_SELECT, assignmentsOf, dayColumn, lineRowOf, lockDay, operationOf, stationOf, workerOf, type AssignmentRow, type OperationRow, type Reader, type StationRow } from './store'
import { bundleFlows } from './world'

/**
 * Move work (B-W2b-49; MES-027 "moves bundles or operations to another operator or line when someone is absent or a pile
 * builds; lists update at once"; design production.dispatch: drag a card to another station or line, "Move bundles", "every
 * move has Undo"): POST /production/dispatch/moves (office, production.dispatch.manage).
 *
 *   from      the card's key as the board gave it (REST: what has no place); a card that changed since answers 409
 *   bundleIds some bundles of the card (none: all of it)
 *   to        a station; a line (its first station for the operation: the database's shape keeps work at a station unless
 *             someone is named); an operator, with either or alone; or `unplaced`, back to Not assigned
 *   position  the place in the station's lane from 1 (none: the end); the same station puts the card in order
 *
 * ONE command under the lock of the site's day: the rows read again, factory-domain movePlan decides what changes, THE check
 * runs for whoever the work now falls to, the lane is numbered, and the site's sequence rule reads the lane: an operation
 * before the one it follows is refused at a STRICT site and answered as a warning at a WARN one. The answer carries `undo`:
 * the body that puts it back. Load is per line and station; nothing here counts a person's work.
 */

export interface MoveBody {
  readonly date?: BusinessDate | undefined
  readonly workOrderOperationId: string
  readonly from: string
  readonly bundleIds?: readonly string[] | undefined
  readonly to: { readonly stationId?: string | null | undefined; readonly lineId?: string | null | undefined; readonly workerId?: string | null | undefined; readonly unplaced?: boolean | undefined; readonly clearWorker?: boolean | undefined }
  readonly position?: number | undefined
  readonly overrideReason?: string | undefined
}

const DISPATCHED: readonly string[] = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD']

/** Where the work goes: a line alone means its first active station for the operation (unless someone is named). */
async function targetOf(tx: CommandTx, siteId: string, operation: OperationRow, body: MoveBody, keep: { readonly stationId: string | null; readonly lineId: string | null } | null): Promise<{ target: MoveTarget; station: StationRow | null }> {
  const { to } = body
  if (to.unplaced) return { target: { stationId: null, lineId: null, workerId: null, unplaced: true }, station: null }
  const workerId = to.workerId ?? null
  if (to.stationId) {
    const station = await stationOf(tx, to.stationId)
    if (!station || station.siteId !== siteId) throw new NotFoundError('Station not found.')
    assertStationDoes(station, operation)
    return { target: { stationId: station.id, lineId: station.lineId, workerId, unplaced: false, clearWorker: to.clearWorker }, station }
  }
  if (to.lineId) {
    const line = await lineRowOf(tx, to.lineId)
    if (!line || line.siteId !== siteId) throw new NotFoundError('Line not found.')
    if (line.status !== 'ACTIVE') refuse(DISPATCH_REFUSALS.LINE_INACTIVE)
    if (workerId) return { target: { stationId: null, lineId: line.id, workerId, unplaced: false }, station: null }
    const station = await tx.station.findFirst({ where: { siteId, lineId: line.id, workCentreId: operation.workCentreId, status: 'ACTIVE' }, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    if (!station) refuse(DISPATCH_REFUSALS.LINE_DOES_NOT_DO, line.code)
    const row = (await stationOf(tx, station!.id))!
    return { target: { stationId: row.id, lineId: row.lineId, workerId: null, unplaced: false }, station: row }
  }
  if (!keep || (!workerId && !to.clearWorker)) throw new ValidationError('Name where it goes: a station, a line or an operator.', [{ path: 'body/to', message: 'Give a station or a line; an operator alone only for work that has a place.' }])
  const station = keep.stationId ? await stationOf(tx, keep.stationId) : null
  return { target: { stationId: keep.stationId, lineId: keep.lineId, workerId, unplaced: false, clearWorker: to.clearWorker }, station }
}

const positionIn = (lane: readonly AssignmentRow[], ids: readonly string[]): number | null => {
  const ordered = [...lane].sort(byLane)
  const at = ordered.findIndex((row) => ids.includes(row.id))
  return at < 0 ? null : at + 1
}

interface Applied {
  readonly touched: AssignmentRow[]
  readonly movedIds: string[]
}

/** The plan on the rows: each update and delete at the version read, every failure a 409. */
async function applyPlan(tx: CommandTx, plan: MovePlan, ctx: { readonly siteId: string; readonly day: BusinessDate; readonly now: Date; readonly actorId: string; readonly decidedBy: string; readonly override: Override; readonly operation: OperationRow; readonly rows: readonly AssignmentRow[] }): Promise<Applied> {
  const { siteId, day, now, actorId, decidedBy, override, operation, rows } = ctx
  const touched: AssignmentRow[] = []
  const movedIds: string[] = []
  const overrideData = override ? { overrideReason: override.reason, overrideById: decidedBy } : {}
  const employeeOf = async (workerId: string | null) => (workerId ? ((await workerOf(tx, workerId))?.employeeId ?? null) : null)
  for (const remove of plan.removes) {
    const { count } = await tx.dispatchAssignment.deleteMany({ where: { id: remove.id, version: remove.version } })
    if (count !== 1) refuse(DISPATCH_REFUSALS.STALE)
    touched.push(rows.find((row) => row.id === remove.id)!)
  }
  for (const change of plan.updates) {
    const { id, version, workerId, bundleIds, ...place } = change
    const person = workerId !== undefined ? { workerId, employeeId: await employeeOf(workerId) } : {}
    const moved = place.stationId !== undefined || workerId !== undefined
    const { count } = await tx.dispatchAssignment.updateMany({ where: { id, version }, data: { ...place, ...(bundleIds ? { bundleIds: [...bundleIds] } : {}), ...person, ...(moved ? overrideData : {}), version: { increment: 1 }, updatedAt: now } })
    if (count !== 1) refuse(DISPATCH_REFUSALS.STALE)
    touched.push(rows.find((row) => row.id === id)!)
    movedIds.push(id)
  }
  for (const make of plan.creates) {
    const id = newId()
    const created = await tx.dispatchAssignment.create({
      data: { id, siteId, workDate: dayColumn(day), lineId: make.lineId, stationId: make.stationId, workOrderId: operation.workOrderId, workOrderOperationId: operation.id, bundleIds: [...make.bundleIds], workerId: make.workerId, employeeId: await employeeOf(make.workerId), ...overrideData, createdAt: now, updatedAt: now, createdById: actorId },
      select: ASSIGNMENT_SELECT,
    })
    touched.push(created)
    movedIds.push(id)
  }
  return { touched, movedIds }
}

/** POST /production/dispatch/moves. */
export async function moveWork(caller: CommandCaller, body: MoveBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((db: Reader) => operationOf(db, body.workOrderOperationId))
  if (!known) throw new NotFoundError('Work order operation not found.')
  const site = await knownSite(caller, context, known.siteId, PRODUCTION_DISPATCH_MANAGE)
  const { result } = await command(caller, { name: 'production.moveDispatchWork', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const decidedBy = assertPersonDecides(tools.context, 'DISPATCH_ASSIGNMENT')
    const today = businessDate(now, site.timezone)
    const day = body.date ?? today
    if (isPastDay(day, today)) refuse(DISPATCH_REFUSALS.PAST_DAY)
    await lockDay(tx, context.tenantId, site.id, day)
    const operation = (await operationOf(tx, body.workOrderOperationId))!
    if (!DISPATCHED.includes(operation.workOrder.status)) refuse(DISPATCH_REFUSALS.NOT_RELEASED)
    const names = body.to.workerId ? true : false
    if (names && (await scanSubjectFor(tx, site.id)) !== 'WORKER') refuse(DISPATCH_REFUSALS.SITE_NAMES_NO_WORKERS)
    const rows = await assignmentsOf(tx, site.id, day)
    const opRows = rows.filter((row) => row.workOrderOperationId === operation.id)
    const flows = await bundleFlows(tx, [operation.workOrderId])
    const open = flows.bundlesOf(operation.workOrderId).filter((bundle) => !flows.reported(bundle.id, operation.id)).map((bundle) => bundle.id)
    const source = body.from === REST_CARD ? null : (placementsOf(opRows, open).placements.find((placement) => placement.key === body.from) ?? null)
    const { target } = await targetOf(tx, site.id, operation, body, source)
    if (body.to.workerId) assertNameable(await workerOf(tx, body.to.workerId), site.id)
    const outcome = movePlan({ rows: opRows, openBundleIds: open, from: body.from, bundleIds: body.bundleIds?.length ? body.bundleIds : null, to: target })
    const reorder = !outcome.ok && outcome.refusal.code === 'NOTHING_TO_MOVE' && body.position !== undefined && source !== null && target.stationId !== null
    if (!outcome.ok && !reorder) refuse(outcome.refusal)
    const plan = outcome.ok ? outcome.plan : null
    const sourceLane = source?.stationId ? rows.filter((row) => row.stationId === source.stationId && row.workOrderOperationId !== null) : []
    const oldPosition = source ? positionIn(sourceLane, source.rows.map((row) => row.id)) : null

    // Whoever the work now falls to: the operator named, the people on the card, the station's operators there.
    const checked: { reason: string; codes: readonly string[] }[] = []
    if (!target.unplaced) {
      const people = new Set<string>()
      if (target.workerId) people.add(target.workerId)
      else if (!target.clearWorker) for (const row of source?.rows ?? []) if (row.workerId) people.add(row.workerId)
      if (target.stationId) for (const row of rows) if (row.stationId === target.stationId && assignmentKindOf(row) === 'STATION_OPERATOR') people.add(row.workerId!)
      for (const workerId of plan ? people : []) {
        const check = await checkPerson(tx, workerId, { workOrderOperationId: operation.id, stationId: target.stationId }, body.overrideReason, now)
        if (check) checked.push(check)
      }
    }
    const override: Override = checked[0] ? { reason: checked[0].reason, codes: [...new Set(checked.flatMap((check) => check.codes))] } : null
    const applied = plan ? await applyPlan(tx, plan, { siteId: site.id, day, now, actorId: context.actorId, decidedBy, override, operation, rows }) : { touched: [...source!.rows], movedIds: source!.rows.map((row) => row.id) }

    // The lane: numbered, then read by the site's sequence rule.
    const warnings: string[] = []
    if (target.stationId) {
      const after = (await assignmentsOf(tx, site.id, day)).filter((row) => row.stationId === target.stationId && row.workOrderOperationId !== null)
      const numbers = laneNumbers(after, applied.movedIds, body.position ?? null)
      for (const entry of numbers) await tx.dispatchAssignment.updateMany({ where: { id: entry.id }, data: { sequence: entry.sequence, version: { increment: 1 }, updatedAt: now } })
      const lane = (await assignmentsOf(tx, site.id, day)).filter((row) => row.stationId === target.stationId && row.workOrderOperationId !== null).sort(byLane)
      const facts = await tx.workOrderOperation.findMany({ where: { id: { in: lane.map((row) => row.workOrderOperationId!) } }, select: { id: true, seq: true, name: true, workOrderId: true, workOrder: { select: { number: true } } } })
      const entries = lane.flatMap((row) => {
        const fact = facts.find((candidate) => candidate.id === row.workOrderOperationId)
        return fact ? [{ workOrderId: fact.workOrderId, workOrderNumber: fact.workOrder.number, seq: fact.seq, name: fact.name }] : []
      })
      const issue = laneOrderIssue(entries)
      const rule = (await floorChecksFor(tx, site.id)).skippedOperationRule
      if (issue && rule === 'STRICT') refuse(DISPATCH_REFUSALS.SEQUENCE_ORDER, issue.words)
      if (issue && rule === 'WARN') warnings.push(issue.words)
    }

    for (const row of applied.touched) {
      tools.audit({ recordType: 'DispatchAssignment', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { stationId: row.stationId, lineId: row.lineId, workerId: row.workerId, bundleIds: [...row.bundleIds] }, after: { from: body.from, to: target, bundleIds: plan?.bundleIds ?? [], position: body.position ?? null, override: override ? { codes: override.codes } : null }, ...(override ? { reason: override.reason } : {}) })
    }
    emitChange(tools, site, day, 'MOVED', [...applied.touched, { id: applied.movedIds[0] ?? applied.touched[0]?.id ?? operation.id, lineId: target.lineId, stationId: target.stationId }], { workOrderId: operation.workOrderId, workOrderOperationId: operation.id })

    const key = plan ? plan.key : body.from
    const back = plan ? plan.back : { bundleIds: null, to: target }
    return {
      moved: { key, bundleIds: [...(plan?.bundleIds ?? [])], whole: plan?.whole ?? true, stationId: target.stationId, lineId: target.lineId },
      warnings,
      undo: { date: day, workOrderOperationId: operation.id, from: key, ...(back.bundleIds ? { bundleIds: [...back.bundleIds] } : {}), to: { stationId: back.to.stationId, lineId: back.to.lineId, workerId: back.to.workerId, unplaced: back.to.unplaced, clearWorker: back.to.clearWorker ?? false }, ...(oldPosition ? { position: oldPosition } : {}) },
    }
  })
  return result
}
