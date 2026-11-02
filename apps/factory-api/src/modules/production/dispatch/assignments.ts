import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_DISPATCH_MANAGE } from '@nexus/factory-domain/production/dispatch/permissions'
import { assignmentKindOf, DISPATCH_LIMITS, DISPATCH_REFUSALS, isPastDay, placementsOf } from '@nexus/factory-domain/production/dispatch/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertPersonDecides } from '../../people/privacy/decide'
import { assertAssignable, qualificationCheck } from '../../people/skills/check'
import { scanSubjectFor } from '../settings/subject'
import { contextOf, knownSite, officeOf, refuse, type DispatchContext } from './access'
import { ASSIGNMENT_SELECT, assignmentRow, assignmentsOf, dayColumn, lockDay, operationOf, stationOf, workerOf, type AssignmentRow, type OperationRow, type Reader, type StationRow, type WorkerRow } from './store'
import { bundleFlows } from './world'

/**
 * Assign an operator (B-W2b-49; MES-023, MES-028; design production.dispatch "drop an operator onto a station (assign); a
 * missing skill is a held drop with its reason, or a warning with an override reason (site rule)", floor.supervisor
 * "Reassign"; D.Lgs. 152/1997 art. 1-bis: a person decides, assertPersonDecides first in each command):
 *
 *   POST /production/dispatch/assignments                    an operator to a station for the day, or to an operation (some
 *                                                            of its bundles), at a station or not (office and the team
 *                                                            leader's floor device; production.dispatch.manage)
 *   POST /production/dispatch/assignments/:id/reassign       someone else takes this work (the same two audiences)
 *   POST /production/dispatch/assignments/:id/remove         the row goes (office: the floor role deletes nothing)
 *
 * Every write takes the lock of the site's day, reads the rows again and runs THE check (people/skills/check.ts) inside the
 * command: a hold refuses in words; a warning needs a reason, kept on the row with who decided. An authorisation is never
 * overridden. A site whose floor records name the station names no operator at all.
 */

export interface AssignBody {
  readonly date?: BusinessDate | undefined
  readonly workerId: string
  readonly stationId?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly bundleIds?: readonly string[] | undefined
  readonly overrideReason?: string | undefined
  readonly note?: string | undefined
}

export interface ReassignBody {
  readonly version: number
  readonly workerId: string
  readonly overrideReason?: string | undefined
}

const DISPATCHED: readonly string[] = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD']

export const assignmentView = (row: AssignmentRow) => ({
  id: row.id,
  kind: assignmentKindOf(row),
  day: row.workDate.toISOString().slice(0, 10),
  lineId: row.lineId,
  stationId: row.stationId,
  workOrderId: row.workOrderId,
  workOrderOperationId: row.workOrderOperationId,
  bundleIds: [...row.bundleIds],
  workerId: row.workerId,
  sequence: row.sequence,
  overridden: row.overrideReason !== null,
  note: row.note,
  version: row.version,
})

export type Override = { readonly reason: string; readonly codes: readonly string[] } | null

/** The check of one person on the work named: a hold refuses; a warning needs the reason, whose words stay on the row. */
export async function checkPerson(tx: CommandTx, workerId: string, work: { readonly workOrderOperationId?: string | null | undefined; readonly stationId?: string | null | undefined }, overrideReason: string | null | undefined, now: Date): Promise<Override> {
  const check = await qualificationCheck(tx, { workerId, workOrderOperationId: work.workOrderOperationId ?? null, stationId: work.stationId ?? null }, { names: 'DISPLAY', now })
  return assertAssignable(check, overrideReason)
}

/** The person against a station and the operations queued at it that day (each checked: the worst decides). */
async function checkStation(tx: CommandTx, workerId: string, stationId: string, rows: readonly AssignmentRow[], overrideReason: string | null | undefined, now: Date): Promise<Override> {
  const operations = [...new Set(rows.flatMap((row) => (row.stationId === stationId && row.workOrderOperationId ? [row.workOrderOperationId] : [])))].slice(0, DISPATCH_LIMITS.stationOperationsChecked)
  const overrides: Override[] = [await checkPerson(tx, workerId, { stationId }, overrideReason, now)]
  for (const workOrderOperationId of operations) overrides.push(await checkPerson(tx, workerId, { stationId, workOrderOperationId }, overrideReason, now))
  const kept = overrides.filter((override): override is NonNullable<Override> => override !== null)
  return kept.length > 0 ? { reason: kept[0]!.reason, codes: [...new Set(kept.flatMap((override) => override.codes))] } : null
}

export function emitChange(tools: Pick<CommandTools, 'emit'>, site: { readonly id: string; readonly companyId: string }, day: BusinessDate, change: 'ASSIGNED' | 'REASSIGNED' | 'MOVED' | 'REMOVED', rows: readonly { readonly id: string; readonly lineId: string | null; readonly stationId: string | null }[], work: { readonly workOrderId: string | null; readonly workOrderOperationId: string | null }): void {
  const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  tools.emit({
    type: 'dispatch.assignment_changed',
    subject: site.id,
    companyId: site.companyId,
    siteId: site.id,
    payload: { siteId: site.id, workDate: day, change, assignmentIds: unique(rows.map((row) => row.id)), lineIds: unique(rows.map((row) => row.lineId)), stationIds: unique(rows.map((row) => row.stationId)), ...work },
  })
}

/** A person of the site who can be named here. */
export function assertNameable(worker: WorkerRow | null, siteId: string): asserts worker is WorkerRow {
  if (!worker || worker.siteId !== siteId || worker.status !== 'ACTIVE') refuse(DISPATCH_REFUSALS.WORKER_INACTIVE)
}

export function assertStationDoes(station: StationRow, operation: Pick<OperationRow, 'workCentreId'> | null): void {
  if (station.status !== 'ACTIVE') refuse(DISPATCH_REFUSALS.STATION_INACTIVE)
  if (operation && station.workCentreId !== operation.workCentreId) refuse(DISPATCH_REFUSALS.WRONG_WORK_CENTRE, station.code)
}

function bodyIssues(body: AssignBody): Issue[] {
  const issues: Issue[] = []
  if (!body.stationId && !body.workOrderOperationId) issues.push({ path: 'body/stationId', message: 'Name a station or an operation.' })
  if (body.bundleIds?.length && !body.workOrderOperationId) issues.push({ path: 'body/bundleIds', message: 'Bundles go with an operation.' })
  if (body.bundleIds && new Set(body.bundleIds).size !== body.bundleIds.length) issues.push({ path: 'body/bundleIds', message: 'Each bundle once.' })
  return issues
}

/** POST /production/dispatch/assignments. */
export async function assignOperator(caller: CommandCaller, body: AssignBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const issues = bodyIssues(body)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const siteId = await caller.withClient(async (db: Reader) => {
    const station = body.stationId ? await stationOf(db, body.stationId) : null
    if (body.stationId && !station) throw new NotFoundError('Station not found.')
    const operation = body.workOrderOperationId ? await operationOf(db, body.workOrderOperationId) : null
    if (body.workOrderOperationId && !operation) throw new NotFoundError('Work order operation not found.')
    if (station && operation && station.siteId !== operation.siteId) throw new NotFoundError('Station not found.')
    return (station?.siteId ?? operation?.siteId)!
  })
  const site = await knownSite(caller, context, siteId, PRODUCTION_DISPATCH_MANAGE)
  const { result } = await command(caller, { name: 'production.assignOperator', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const decidedBy = assertPersonDecides(tools.context, 'DISPATCH_ASSIGNMENT')
    const today = businessDate(now, site.timezone)
    const day = body.date ?? today
    if (isPastDay(day, today)) refuse(DISPATCH_REFUSALS.PAST_DAY)
    if ((await scanSubjectFor(tx, site.id)) !== 'WORKER') refuse(DISPATCH_REFUSALS.SITE_NAMES_NO_WORKERS)
    await lockDay(tx, context.tenantId, site.id, day)
    const worker = await workerOf(tx, body.workerId)
    assertNameable(worker, site.id)
    const station = body.stationId ? await stationOf(tx, body.stationId) : null
    const operation = body.workOrderOperationId ? await operationOf(tx, body.workOrderOperationId) : null
    if (operation && !DISPATCHED.includes(operation.workOrder.status)) refuse(DISPATCH_REFUSALS.NOT_RELEASED)
    if (station) assertStationDoes(station, operation)
    const rows = await assignmentsOf(tx, site.id, day)
    const bundleIds = [...(body.bundleIds ?? [])]
    if (operation) {
      const opRows = rows.filter((row) => row.workOrderOperationId === operation.id)
      const flows = await bundleFlows(tx, [operation.workOrderId])
      const open = flows.bundlesOf(operation.workOrderId).filter((bundle) => !flows.reported(bundle.id, operation.id)).map((bundle) => bundle.id)
      if (bundleIds.some((id) => !open.includes(id))) refuse(DISPATCH_REFUSALS.BUNDLE_NOT_OPEN)
      const { placements } = placementsOf(opRows, open)
      const named = placements.filter((placement) => !placement.whole).flatMap((placement) => [...placement.bundleIds])
      if (bundleIds.some((id) => named.includes(id))) refuse(DISPATCH_REFUSALS.BUNDLE_TAKEN)
      if (opRows.some((row) => row.workerId === worker.id && row.stationId === (station?.id ?? null) && sameBundles(row.bundleIds, bundleIds))) refuse(DISPATCH_REFUSALS.ALREADY_ASSIGNED)
      const whole = placements.find((placement) => placement.whole)
      if (bundleIds.length === 0 && whole?.stationId && station && whole.stationId !== station.id) refuse(DISPATCH_REFUSALS.WHOLE_ELSEWHERE)
    } else if (rows.some((row) => row.workOrderOperationId === null && row.stationId === station!.id && row.workerId === worker.id)) {
      refuse(DISPATCH_REFUSALS.ALREADY_ASSIGNED)
    }
    const override = operation ? await checkPerson(tx, worker.id, { workOrderOperationId: operation.id, stationId: station?.id }, body.overrideReason, now) : await checkStation(tx, worker.id, station!.id, rows, body.overrideReason, now)
    const id = newId()
    const created = await tx.dispatchAssignment.create({
      data: {
        id,
        siteId: site.id,
        workDate: dayColumn(day),
        lineId: station?.lineId ?? null,
        stationId: station?.id ?? null,
        workOrderId: operation?.workOrderId ?? null,
        workOrderOperationId: operation?.id ?? null,
        bundleIds,
        workerId: worker.id,
        employeeId: worker.employeeId,
        overrideReason: override?.reason ?? null,
        overrideById: override ? decidedBy : null,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: ASSIGNMENT_SELECT,
    })
    tools.audit({ recordType: 'DispatchAssignment', recordId: id, companyId: site.companyId, siteId: site.id, after: { workDate: day, stationId: created.stationId, workOrderOperationId: created.workOrderOperationId, bundleIds, workerId: worker.id, override: override ? { codes: override.codes } : null }, ...(override ? { reason: override.reason } : {}) })
    emitChange(tools, site, day, 'ASSIGNED', [created], { workOrderId: created.workOrderId, workOrderOperationId: created.workOrderOperationId })
    return { assignment: assignmentView(created), overridden: override !== null }
  })
  return result
}

const sameBundles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id))

async function knownRow(caller: CommandCaller, context: DispatchContext, assignmentId: string) {
  const row = await caller.withClient((db: Reader) => assignmentRow(db, assignmentId))
  if (!row) throw new NotFoundError('Assignment not found.')
  const site = await knownSite(caller, context, row.siteId, PRODUCTION_DISPATCH_MANAGE).catch(() => {
    throw new NotFoundError('Assignment not found.')
  })
  return { row, site }
}

/** POST /production/dispatch/assignments/:id/reassign: someone else takes this work (the qualification check runs again). */
export async function reassign(caller: CommandCaller, assignmentId: string, body: ReassignBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const { row: known, site } = await knownRow(caller, context, assignmentId)
  const { result } = await command(caller, { name: 'production.reassignOperator', idempotencyKey, input: { assignmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const decidedBy = assertPersonDecides(tools.context, 'DISPATCH_ASSIGNMENT')
    const day = known.workDate.toISOString().slice(0, 10)
    if (isPastDay(day, businessDate(now, site.timezone))) refuse(DISPATCH_REFUSALS.PAST_DAY)
    if ((await scanSubjectFor(tx, site.id)) !== 'WORKER') refuse(DISPATCH_REFUSALS.SITE_NAMES_NO_WORKERS)
    await lockDay(tx, context.tenantId, site.id, day)
    const row = await assignmentRow(tx, assignmentId)
    if (!row) throw new NotFoundError('Assignment not found.')
    if (row.version !== body.version) refuse(DISPATCH_REFUSALS.STALE)
    const worker = await workerOf(tx, body.workerId)
    assertNameable(worker, site.id)
    if (row.workerId === worker.id) refuse(DISPATCH_REFUSALS.ALREADY_ASSIGNED)
    const rows = await assignmentsOf(tx, site.id, day)
    const override = row.workOrderOperationId ? await checkPerson(tx, worker.id, { workOrderOperationId: row.workOrderOperationId, stationId: row.stationId }, body.overrideReason, now) : await checkStation(tx, worker.id, row.stationId!, rows, body.overrideReason, now)
    const { count } = await tx.dispatchAssignment.updateMany({
      where: { id: row.id, version: row.version },
      data: { workerId: worker.id, employeeId: worker.employeeId, overrideReason: override?.reason ?? null, overrideById: override ? decidedBy : null, version: { increment: 1 }, updatedAt: now },
    })
    if (count !== 1) refuse(DISPATCH_REFUSALS.STALE)
    tools.audit({ recordType: 'DispatchAssignment', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { workerId: row.workerId }, after: { workerId: worker.id, override: override ? { codes: override.codes } : null }, ...(override ? { reason: override.reason } : {}) })
    emitChange(tools, site, day, 'REASSIGNED', [row], { workOrderId: row.workOrderId, workOrderOperationId: row.workOrderOperationId })
    const after = await assignmentRow(tx, row.id)
    return { assignment: assignmentView(after!), overridden: override !== null }
  })
  return result
}

/** POST /production/dispatch/assignments/:id/remove (office). */
export async function removeAssignment(caller: CommandCaller, assignmentId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { row: known, site } = await knownRow(caller, context, assignmentId)
  const { result } = await command(caller, { name: 'production.removeDispatchAssignment', idempotencyKey, input: { assignmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const day = known.workDate.toISOString().slice(0, 10)
    if (isPastDay(day, businessDate(now, site.timezone))) refuse(DISPATCH_REFUSALS.PAST_DAY)
    await lockDay(tx, context.tenantId, site.id, day)
    const row = await assignmentRow(tx, assignmentId)
    if (!row) throw new NotFoundError('Assignment not found.')
    if (row.version !== body.version) refuse(DISPATCH_REFUSALS.STALE)
    const { count } = await tx.dispatchAssignment.deleteMany({ where: { id: row.id, version: row.version } })
    if (count !== 1) refuse(DISPATCH_REFUSALS.STALE)
    tools.audit({ recordType: 'DispatchAssignment', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { workDate: day, stationId: row.stationId, workOrderOperationId: row.workOrderOperationId, bundleIds: [...row.bundleIds], workerId: row.workerId } })
    emitChange(tools, site, day, 'REMOVED', [row], { workOrderId: row.workOrderId, workOrderOperationId: row.workOrderOperationId })
    return { removed: row.id }
  })
  return result
}

