import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_RECORD } from '@nexus/factory-domain/quality/final/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeOf, type Signer } from './access'
import { identityOf, madeAny } from './facts'
import { makersOf, readInspection, type InspectionRow, type Reader } from './store'

/**
 * Assigning an inspector (B-W2a-67; design quality.inspections qi-assign "Assign inspector", qi-grid inline "Inspector",
 * qi-new "Inspector (optional)"; schema wave 6 Inspection.assignedInspectorId / assignedInspectorWorkerId). The office
 * assigns an OPEN inspection to one inspector before it is decided — an ACTIVE office user whose live roles record
 * inspections over its company and site, or an ACTIVE worker of its site with a live floor role that does — never to a
 * person who made some of its garments (the floor's records: cut log, bundles, scans). Assigned, only that person records
 * and signs it (./inspections.ts `isOwn`); their first write makes them its inspector. The floor never assigns (the
 * …_quality_plant_w2a_guards Inspection_assignment_guard holds the same for every login).
 *
 *   GET  /quality/inspections/inspectors?siteId&workOrderIds   the picker, each person with the work orders they made.
 *   POST /quality/inspections/assign                           every inspection named or none (409 `inspections/<i>`).
 *
 * Floor workers are listed by name only to a caller who may see the site's workers (workers.view); a picker only — no
 * list, filter or total names a worker (Statuto dei Lavoratori art. 4; Owner answer W1).
 */

const MAX_PEOPLE = 500
const MAX_WORKERS = 1000
const WORKERS_VIEW = 'workers.view'

export interface Assignee {
  readonly userId: string | null
  readonly workerId: string | null
}

export const NOBODY: Assignee = Object.freeze({ userId: null, workerId: null })

/** The inspection's assignee (or nobody). */
export const assigneeOf = (row: Pick<InspectionRow, 'assignedInspectorId' | 'assignedInspectorWorkerId'>): Assignee => ({ userId: row.assignedInspectorId, workerId: row.assignedInspectorWorkerId })

export const isAssigned = (assignee: Assignee): boolean => assignee.userId !== null || assignee.workerId !== null

/** The signer is the assignee. */
export const isAssignee = (assignee: Assignee, signer: Signer): boolean =>
  (assignee.userId !== null && assignee.userId === signer.userId) || (assignee.workerId !== null && assignee.workerId === signer.workerId)

/** An office user as a reader with their live roles (the plant's technicians pattern). */
async function userActor(db: Reader, context: OfficeContext, userId: string, now: Date): Promise<Actor> {
  return { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
}

/** The names of assignees, for the views (an office user's or a worker's display name). */
export async function assigneeNames(db: Reader, rows: readonly Pick<InspectionRow, 'assignedInspectorId' | 'assignedInspectorWorkerId'>[]): Promise<Map<string, string>> {
  const userIds = [...new Set(rows.map((row) => row.assignedInspectorId).filter((id): id is string => id !== null))]
  const workerIds = [...new Set(rows.map((row) => row.assignedInspectorWorkerId).filter((id): id is string => id !== null))]
  const names = new Map<string, string>()
  if (userIds.length) for (const user of await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })) names.set(user.id, user.displayName)
  if (workerIds.length) for (const worker of await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, displayName: true } })) names.set(worker.id, worker.displayName)
  return names
}

/**
 * Why this person cannot be assigned an inspection of this work order, in words, or null: not an ACTIVE office user who
 * records inspections over its company and site (or a worker of its site with a floor role that does), or a maker.
 */
export async function assigneeProblem(db: Reader, context: OfficeContext, assignee: Assignee, inspection: Pick<InspectionRow, 'companyId' | 'siteId' | 'workOrderId'>, workOrderNumber: string, now: Date): Promise<string | null> {
  if (!isAssigned(assignee)) return null
  if (assignee.userId !== null && assignee.workerId !== null) return 'An inspection is assigned to one inspector: an office user or a worker of the site.'
  const scope = { companyId: inspection.companyId, siteId: inspection.siteId }
  if (assignee.userId) {
    const user = isUuid(assignee.userId) ? await db.user.findUnique({ where: { id: assignee.userId }, select: { status: true } }) : null
    if (!user || user.status !== 'ACTIVE') return 'Not an active office user of this group.'
    if (!can(await userActor(db, context, assignee.userId, now), QUALITY_INSPECTIONS_RECORD, scope)) return 'This person does not record inspections at this site (quality.inspections.record).'
  } else if (assignee.workerId) {
    if (!can(actorOf(context), WORKERS_VIEW, scope)) return "Assigning a floor inspector needs workers.view at the site (whoever sees the site's workers)."
    const worker = isUuid(assignee.workerId)
      ? await db.worker.findFirst({ where: { id: assignee.workerId, siteId: inspection.siteId, status: 'ACTIVE', roles: { some: { endedAt: null, role: { permissions: { has: QUALITY_INSPECTIONS_RECORD } } } } }, select: { id: true } })
      : null
    if (!worker) return 'Not an active floor inspector of this site.'
  }
  const identity = await identityOf(db, { userId: assignee.userId, workerId: assignee.workerId })
  if (madeAny(identity, await makersOf(db, inspection.workOrderId))) return `Made garments of work order ${workOrderNumber}: another inspector, who made none of them, inspects it.`
  return null
}

// ---- the picker -----------------------------------------------------------------------------------------------------------------

export async function listInspectors(caller: CommandCaller, query: { readonly siteId: string; readonly workOrderIds?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = new Date()
  const ids = (query.workOrderIds ?? '').split(',').map((id) => id.trim()).filter(isUuid).slice(0, 50)
  return caller.withClient(async (db) => {
    const site = isUuid(query.siteId) ? await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true } }) : null
    if (!site || !can(actor, 'quality.inspections.view', { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const scope = { companyId: site.companyId, siteId: site.id }
    if (!can(actor, QUALITY_INSPECTIONS_RECORD, scope)) throw new ForbiddenError('Assigning an inspector needs quality.inspections.record at its site.')
    const orders = ids.length ? await db.workOrder.findMany({ where: { id: { in: ids }, siteId: site.id }, select: { id: true, number: true } }) : []
    const makers = await Promise.all(orders.map(async (order) => ({ number: order.number, makers: await makersOf(db, order.id) })))
    const madeBy = async (signer: Signer): Promise<string[]> => {
      if (makers.length === 0) return []
      const identity = await identityOf(db, signer)
      return makers.filter((entry) => madeAny(identity, entry.makers)).map((entry) => entry.number)
    }
    const inspectors: { kind: 'USER' | 'WORKER'; id: string; name: string; me: boolean; made: string[] }[] = []
    const users = await db.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
    for (const user of users) {
      if (!can(await userActor(db, context, user.id, now), QUALITY_INSPECTIONS_RECORD, scope)) continue
      inspectors.push({ kind: 'USER', id: user.id, name: user.displayName, me: user.id === context.actorId, made: await madeBy({ userId: user.id, workerId: null }) })
    }
    const floorListed = can(actor, WORKERS_VIEW, scope)
    if (floorListed) {
      const workers = await db.worker.findMany({
        where: { siteId: site.id, status: 'ACTIVE', roles: { some: { endedAt: null, role: { permissions: { has: QUALITY_INSPECTIONS_RECORD } } } } },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: MAX_WORKERS,
        select: { id: true, displayName: true },
      })
      for (const worker of workers) inspectors.push({ kind: 'WORKER', id: worker.id, name: worker.displayName, me: false, made: await madeBy({ userId: null, workerId: worker.id }) })
    }
    return { inspectors: [...inspectors.filter((entry) => entry.me), ...inspectors.filter((entry) => !entry.me)], floorListed }
  })
}

// ---- assign ------------------------------------------------------------------------------------------------------------------------

export interface AssignBody {
  readonly inspections: readonly { readonly id: string; readonly version: number }[]
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
}

export async function assignInspections(caller: CommandCaller, body: AssignBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const assignee: Assignee = { userId: body.assigneeId ?? null, workerId: body.assigneeWorkerId ?? null }
  if (new Set(body.inspections.map((entry) => entry.id)).size !== body.inspections.length) throw new ValidationError('Name each inspection once.', [{ path: 'body/inspections', message: 'Name each inspection once.' }])
  const answer = async (ids: readonly string[]) =>
    caller.withClient(async (db) => {
      const rows = (await Promise.all(ids.map((id) => readInspection(db, id)))).filter((row): row is InspectionRow => row !== null)
      const names = await assigneeNames(db, rows)
      return { inspections: rows.map((row) => ({ id: row.id, version: row.version, assigned: assignedView(row, names, true) })) }
    })
  // Nothing to change (each one already has this assignee, at the version read): the answer as it stands, no command —
  // a command writes and audits something, and an assignment that changes nothing writes nothing.
  const current = await caller.withClient((db) => Promise.all(body.inspections.map((entry) => readInspection(db, entry.id))))
  const unchanged = current.every((row, index) => {
    if (!row || row.version !== body.inspections[index]!.version || row.status !== 'OPEN' || !can(actorOf(context), QUALITY_INSPECTIONS_RECORD, { companyId: row.companyId, siteId: row.siteId })) return false
    const before = assigneeOf(row)
    return before.userId === assignee.userId && before.workerId === assignee.workerId
  })
  if (unchanged) return answer(body.inspections.map((entry) => entry.id))
  const { result } = await command(caller, { name: 'quality.inspection.assign', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const problems: Issue[] = []
    const changed: { id: string; version: number }[] = []
    let wrote = false
    for (const [index, entry] of body.inspections.entries()) {
      await tx.$queryRaw`SELECT "id" FROM "Inspection" WHERE "id" = ${entry.id}::uuid FOR UPDATE`
      const row = await readInspection(tx, entry.id)
      if (!row || !can(actorOf(context), 'quality.inspections.view', { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Inspection not found.')
      if (!can(actorOf(context), QUALITY_INSPECTIONS_RECORD, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError("Assigning an inspector needs quality.inspections.record over the inspection's company and site.")
      if (row.version !== entry.version) throw new StaleVersionError('Inspection', row.id, row.version, entry.version)
      const order = await tx.workOrder.findUnique({ where: { id: row.workOrderId }, select: { number: true } })
      const label = row.number ?? order?.number ?? row.id
      if (row.status !== 'OPEN') {
        problems.push({ path: `inspections/${index}`, message: `${label} is ${row.status.toLowerCase()}: only an open inspection is assigned.` })
        continue
      }
      const problem = await assigneeProblem(tx, context, assignee, row, order?.number ?? '', now)
      if (problem) {
        problems.push({ path: `inspections/${index}`, message: `${label}: ${problem}` })
        continue
      }
      const before = assigneeOf(row)
      if (before.userId === assignee.userId && before.workerId === assignee.workerId) {
        changed.push({ id: row.id, version: row.version })
        continue
      }
      const updated = await tx.inspection.update({ where: { id: row.id }, data: { assignedInspectorId: assignee.userId, assignedInspectorWorkerId: assignee.workerId, version: { increment: 1 }, updatedAt: now }, select: { id: true, version: true } })
      wrote = true
      tools.audit({ recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { assigned: before }, after: { assigned: assignee } })
      tools.emit({
        type: 'quality.inspection_assigned',
        subject: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        payload: { inspectionId: row.id, workOrderId: row.workOrderId, number: order?.number ?? '', assigned: isAssigned(assignee) },
      })
      changed.push(updated)
    }
    if (problems.length > 0) throw new AssignRefusedError(problems)
    // Read as changed before the command, unchanged now: another person assigned the same meanwhile.
    if (!wrote) throw new ConflictError('These inspections changed while you assigned them: read them again.')
    return changed
  })
  return answer(result.map((entry) => entry.id))
}

/** The assignee as the views show it: an office user by name; a worker by name only inside one inspection (`named`). */
export function assignedView(row: Pick<InspectionRow, 'assignedInspectorId' | 'assignedInspectorWorkerId'>, names: ReadonlyMap<string, string> | undefined, named: boolean) {
  if (row.assignedInspectorId) return { kind: 'USER' as const, userId: row.assignedInspectorId, workerId: null, name: names?.get(row.assignedInspectorId) ?? null }
  if (row.assignedInspectorWorkerId) return { kind: 'WORKER' as const, userId: null, workerId: row.assignedInspectorWorkerId, name: named ? (names?.get(row.assignedInspectorWorkerId) ?? null) : null }
  return null
}

/** Every refused inspection in words (409): nothing was assigned. */
export class AssignRefusedError extends ConflictError {
  override name = 'AssignRefusedError'
  override readonly issues: readonly Issue[]
  constructor(issues: readonly Issue[]) {
    super(issues.length === 1 ? issues[0]!.message : `${issues.length} inspections cannot be assigned: nothing was assigned.`)
    this.issues = issues
  }
}

/** An assignment at open (office only): refused in words before the command writes anything. */
export async function assertAssignable(db: Reader, context: OfficeContext, assignee: Assignee, header: { readonly companyId: string; readonly siteId: string; readonly id: string; readonly number: string }, now: Date): Promise<void> {
  const problem = await assigneeProblem(db, context, assignee, { companyId: header.companyId, siteId: header.siteId, workOrderId: header.id }, header.number, now)
  if (problem) throw new InvalidStateError(problem)
}
