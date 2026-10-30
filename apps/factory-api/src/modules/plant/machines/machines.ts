import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { PLANT_MACHINES_MANAGE, PLANT_REPORT, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { machineDraftProblems, normalAssetNumber, OPEN_JOB_STATUSES, OPEN_REQUEST_STATUSES, retireRefusal, type MachineStatus, type MachineTile } from '@nexus/factory-domain/plant/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, byOf, may, officeOf, problemsError, refused, scopeOf } from '../access'
import { auditedMachine, jobViews, JOB_COLUMNS, lockMachine, machineCard, machineViews, moveMachine, readMachine, REQUEST_COLUMNS, requestViews, MACHINE_COLUMNS, type MachineRow } from '../store'

/**
 * The machine and equipment register (B-W2a-35; QHS-162; design plant.machines SCR-150): office routes, plant.view to read
 * and plant.machines.manage to write, each machine checked with can() against its company and site.
 *
 *   GET   /plant/machines             the register of the caller's sites (a site, statuses, a tile, a class, a station, a
 *                                     work centre, words; `code`: a scanned tag, in any state), asset number order, pages
 *   GET   /plant/machines/counts      the tiles: down now, do-not-use, under maintenance; locked; how many in use
 *   GET   /plant/machines/:machineId  the record: the machine card (now, the open job, the last jobs, the repeat-failure
 *                                     hint), its open requests and its maintenance history
 *   POST  /plant/machines             a machine at a site, RUNNING, with its class and place (its asset number is the QR tag)
 *   PATCH /plant/machines/:machineId  its class, facts, place, supplier, cost (the cost grain), note
 *   POST  /plant/machines/:machineId/retire  retired for good, with the reason (not while a request or job is open)
 *
 * Every write is one command() on the machine row (locked first), with an Idempotency-Key and the version read; the
 * …_quality_plant_w2a_guards Machine trigger stays the last word.
 */

const SORT: Prisma.MachineOrderByWithRelationInput[] = [{ assetNumber: 'asc' }, { id: 'asc' }]

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: readonly MachineStatus[] | undefined
  readonly tile?: MachineTile | undefined
  readonly classId?: string | undefined
  readonly stationId?: string | undefined
  readonly workCentreId?: string | undefined
  readonly q?: string | undefined
  readonly code?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /plant/machines: asset number order; a cursor is the last asset number's machine id. */
export async function listMachines(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const statuses = query.tile ? [query.tile] : query.status && query.status.length > 0 ? [...query.status] : null
  const where: Prisma.MachineWhereInput = {
    AND: [
      scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.code ? { assetNumber: normalAssetNumber(query.code) } : statuses ? { status: { in: statuses } } : { status: { not: 'RETIRED' } },
      query.classId ? { classId: query.classId } : {},
      query.stationId ? { stationId: query.stationId } : {},
      query.workCentreId ? { workCentreId: query.workCentreId } : {},
      query.q
        ? { OR: [{ assetNumber: { contains: query.q, mode: 'insensitive' } }, { make: { contains: query.q, mode: 'insensitive' } }, { modelName: { contains: query.q, mode: 'insensitive' } }, { serialNumber: { contains: query.q, mode: 'insensitive' } }] }
        : {},
    ],
  }
  return caller.withClient(async (client) => {
    let after: Prisma.MachineWhereInput = {}
    if (query.cursor) {
      const last = await client.machine.findUnique({ where: { id: query.cursor }, select: { assetNumber: true, id: true } })
      if (last) after = { OR: [{ assetNumber: { gt: last.assetNumber } }, { assetNumber: last.assetNumber, id: { gt: last.id } }] }
    }
    const rows = (await client.machine.findMany({ where: { AND: [where, after] }, orderBy: SORT, take: query.limit + 1, select: MACHINE_COLUMNS })) as MachineRow[]
    const page = rows.slice(0, query.limit)
    return { machines: await machineViews(client, page, context), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /plant/machines/counts. */
export async function machineCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const where: Prisma.MachineWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, query.siteId ? { siteId: query.siteId } : {}, { status: { not: 'RETIRED' } }] }
  return caller.withClient(async (client) => {
    const byStatus = new Map((await client.machine.groupBy({ by: ['status'], where, _count: { _all: true } })).map((row) => [row.status, row._count._all]))
    const lockedMachines = await client.maintenanceRequest.findMany({ where: { unsafe: true, signedSafeAt: null, machine: where }, distinct: ['machineId'], select: { machineId: true } })
    return {
      tiles: { DOWN: byStatus.get('DOWN') ?? 0, DO_NOT_USE: byStatus.get('DO_NOT_USE') ?? 0, UNDER_MAINTENANCE: byStatus.get('UNDER_MAINTENANCE') ?? 0 },
      locked: lockedMachines.length,
      inUse: [...byStatus.values()].reduce((sum, count) => sum + count, 0),
    }
  })
}

/** GET /plant/machines/:machineId. */
export async function machineRecord(caller: CommandCaller, machineId: string) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const machine = await readMachine(client, context, machineId)
    if (!machine) throw new NotFoundError('Machine not found.')
    assertMay(context, PLANT_VIEW, machine, 'Machine')
    const card = (await machineCard(client, context, machineId, now, { lastJobs: 5 }))!
    const requests = await client.maintenanceRequest.findMany({ where: { machineId, status: { in: [...OPEN_REQUEST_STATUSES] } }, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], select: REQUEST_COLUMNS })
    const history = await client.maintenanceJob.findMany({ where: { machineId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: JOB_COLUMNS })
    return {
      card,
      openRequests: await requestViews(client, requests, context, now),
      history: await jobViews(client, history, context, now),
      canManage: may(context, PLANT_MACHINES_MANAGE, machine),
      canReport: may(context, PLANT_REPORT, machine),
    }
  })
}

// ---- writes -----------------------------------------------------------------------------------------------------------

/** The place, the class and the supplier named: of the machine's site, active; a 400 naming the field otherwise. */
async function checkRefs(tx: CommandTx, siteId: string, refs: { readonly classId?: string | undefined; readonly stationId?: string | null | undefined; readonly workCentreId?: string | null | undefined; readonly supplierId?: string | null | undefined }, classChanged: boolean): Promise<void> {
  if (refs.classId !== undefined) {
    const machineClass = await tx.machineClass.findUnique({ where: { id: refs.classId }, select: { active: true } })
    if (!machineClass) throw bodyIssue('classId', 'Not a machine class of the group.')
    if (!machineClass.active && classChanged) throw bodyIssue('classId', 'This class is retired: pick an active one.')
  }
  if (refs.stationId) {
    const station = await tx.station.findUnique({ where: { id: refs.stationId }, select: { siteId: true, status: true } })
    if (!station || station.siteId !== siteId) throw bodyIssue('stationId', 'Not a station of the machine\'s site.')
    if (station.status !== 'ACTIVE') throw bodyIssue('stationId', 'This station is archived.')
  }
  if (refs.workCentreId) {
    const centre = await tx.workCentre.findUnique({ where: { id: refs.workCentreId }, select: { siteId: true, status: true } })
    if (!centre || centre.siteId !== siteId) throw bodyIssue('workCentreId', 'Not a work centre of the machine\'s site.')
    if (centre.status !== 'ACTIVE') throw bodyIssue('workCentreId', 'This work centre is archived.')
  }
  if (refs.supplierId) {
    const party = await tx.party.findUnique({ where: { id: refs.supplierId }, select: { roles: true } })
    if (!party) throw bodyIssue('supplierId', 'Not a party of the group.')
    if (!party.roles.includes('SUPPLIER')) throw bodyIssue('supplierId', 'This party is not a supplier.')
  }
}

/** The cost may be sent only with the cost grain (the grain filter refuses it before; this says it for a null). */
function assertCostGrain(caller: CommandCaller, sent: boolean): void {
  if (sent && !holds(actorOf(officeOf(caller)), 'money.cost')) throw new ForbiddenError('The purchase cost is changed only with the cost grain.')
}

export interface CreateBody {
  readonly siteId: string
  readonly assetNumber: string
  readonly classId: string
  readonly make?: string | null | undefined
  readonly modelName?: string | null | undefined
  readonly serialNumber?: string | null | undefined
  readonly year?: number | null | undefined
  readonly stationId?: string | null | undefined
  readonly workCentreId?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly purchaseCost?: number | null | undefined
  readonly note?: string | null | undefined
}

const clean = (value: string | null | undefined): string | null => (value === undefined || value === null ? null : value.trim() || null)

/** POST /plant/machines. */
export async function createMachine(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = machineDraftProblems(body, true)
  if (problems.length > 0) throw problemsError(problems, 'The machine is not valid.')
  assertCostGrain(caller, body.purchaseCost !== undefined)
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true, status: true } }))
  if (!site) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, { companyId: site.companyId, siteId: site.id }, 'Machines of this site are registered by a role that keeps them (plant.machines.manage).')
  if (site.status !== 'ACTIVE') throw bodyIssue('siteId', 'This site is archived.')
  const assetNumber = normalAssetNumber(body.assetNumber)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.createMachine', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await checkRefs(tx, site.id, body, true)
    if (await tx.machine.findFirst({ where: { assetNumber }, select: { id: true } })) throw new ConflictError(`Asset number ${assetNumber} is taken: every tag carries its own.`)
    const data: Prisma.MachineUncheckedCreateInput = {
      id,
      companyId: site.companyId,
      siteId: site.id,
      assetNumber,
      classId: body.classId,
      make: clean(body.make),
      modelName: clean(body.modelName),
      serialNumber: clean(body.serialNumber),
      year: body.year ?? null,
      stationId: body.stationId ?? null,
      workCentreId: body.workCentreId ?? null,
      supplierId: body.supplierId ?? null,
      purchaseCost: body.purchaseCost ?? null,
      status: 'RUNNING',
      statusSince: now,
      note: clean(body.note),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    await tx.machine.create({ data, select: { id: true } })
    tools.audit({ action: 'plant.createMachine', recordType: 'Machine', recordId: id, companyId: site.companyId, siteId: site.id, after: auditedMachine({ ...data, make: data.make ?? null, modelName: data.modelName ?? null, serialNumber: data.serialNumber ?? null, year: data.year ?? null, stationId: data.stationId ?? null, workCentreId: data.workCentreId ?? null, note: data.note ?? null, status: 'RUNNING' }) })
    tools.emit({ type: 'machine.registered', subject: id, companyId: site.companyId, siteId: site.id, payload: { machineId: id, assetNumber, classId: body.classId, stationId: body.stationId ?? null, workCentreId: body.workCentreId ?? null } })
    const [view] = await machineViews(tx, [(await readMachine(tx, context, id))!], context)
    return { machine: view! }
  })
  return { ...result, replayed }
}

export interface UpdateBody extends Partial<Omit<CreateBody, 'siteId' | 'assetNumber'>> {
  readonly version: number
}

const CHANGEABLE = ['classId', 'make', 'modelName', 'serialNumber', 'year', 'stationId', 'workCentreId', 'supplierId', 'purchaseCost', 'note'] as const

/** PATCH /plant/machines/:machineId. */
export async function updateMachine(caller: CommandCaller, machineId: string, body: UpdateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = machineDraftProblems(body, false)
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  assertCostGrain(caller, body.purchaseCost !== undefined)
  const known = isUuid(machineId) ? await caller.withClient((client) => readMachine(client, context, machineId)) : null
  if (!known) throw new NotFoundError('Machine not found.')
  assertMay(context, PLANT_VIEW, known, 'Machine')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, known, 'Machines of this site are changed by a role that keeps them (plant.machines.manage).')
  const { result } = await command(caller, { name: 'plant.updateMachine', idempotencyKey, input: { machineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, machineId))!
    assertVersion('machine', machine.version, body.version)
    if (machine.status === 'RETIRED') throw new ConflictError(`Machine ${machine.assetNumber} is retired: only its note changes.`)
    await checkRefs(tx, machine.siteId, body, body.classId !== undefined && body.classId !== machine.classId)
    const data: Prisma.MachineUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    const fields: string[] = []
    for (const field of CHANGEABLE) {
      const value = body[field]
      if (value === undefined) continue
      const next = typeof value === 'string' ? (field === 'classId' || field.endsWith('Id') ? value : clean(value)) : value
      if (next === (machine as Record<string, unknown>)[field]) continue
      ;(data as Record<string, unknown>)[field] = next
      fields.push(field)
    }
    if (fields.length === 0) {
      const [view] = await machineViews(tx, [machine], context)
      tools.audit({ action: 'plant.updateMachine', recordType: 'Machine', recordId: machine.id, companyId: machine.companyId, siteId: machine.siteId, after: { unchanged: true } })
      return { machine: view! }
    }
    await tx.machine.update({ where: { id: machine.id }, data, select: { id: true } })
    const after = (await readMachine(tx, context, machine.id))!
    tools.audit({ action: 'plant.updateMachine', recordType: 'Machine', recordId: machine.id, companyId: machine.companyId, siteId: machine.siteId, before: auditedMachine(machine as Required<MachineRow>), after: auditedMachine(after as Required<MachineRow>) })
    tools.emit({ type: 'machine.changed', subject: machine.id, companyId: machine.companyId, siteId: machine.siteId, payload: { machineId: machine.id, assetNumber: machine.assetNumber, fields } })
    const [view] = await machineViews(tx, [after], context)
    return { machine: view! }
  })
  return result
}

/** POST /plant/machines/:machineId/retire. */
export async function retireMachine(caller: CommandCaller, machineId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = isUuid(machineId) ? await caller.withClient((client) => readMachine(client, context, machineId)) : null
  if (!known) throw new NotFoundError('Machine not found.')
  assertMay(context, PLANT_VIEW, known, 'Machine')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, known, 'Machines of this site are retired by a role that keeps them (plant.machines.manage).')
  const { result, replayed } = await command(caller, { name: 'plant.retireMachine', idempotencyKey, input: { machineId, ...body } }, async (tools) => {
    const { tx } = tools
    const machine = (await lockMachine(tx, context, machineId))!
    assertVersion('machine', machine.version, body.version)
    const openRequests = await tx.maintenanceRequest.count({ where: { machineId, status: { in: [...OPEN_REQUEST_STATUSES] } } })
    const openJobs = await tx.maintenanceJob.count({ where: { machineId, status: { in: [...OPEN_JOB_STATUSES] } } })
    const refusal = retireRefusal({ assetNumber: machine.assetNumber, status: machine.status as MachineStatus, openRequests, openJobs })
    if (refusal) refused(refusal)
    await moveMachine(tools, machine, 'RETIRED', { reason: `Retired: ${body.reason.trim()}`.slice(0, 500), cause: 'RETIRE', recordType: 'Machine', recordId: machine.id, by: byOf(context) })
    const [view] = await machineViews(tx, [(await readMachine(tx, context, machine.id))!], context)
    return { machine: view! }
  })
  return { ...result, replayed }
}
