import type { MachineStatus as DbMachineStatus, Prisma } from '@nexus/factory-db'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import {
  isOpenJob,
  isOpenRequest,
  isOverdue,
  isRepeatFailure,
  minutesSince,
  OPEN_JOB_STATUSES,
  OPEN_REQUEST_STATUSES,
  REPEAT_FAILURE,
  type JobOwnership,
  type MachineAfter,
  type MachineStatus,
} from '@nexus/factory-domain/plant/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTools, CommandTx } from '../../core/command'
import type { PlantContext } from './access'

/**
 * The plant's rows as the API reads them (B-W2a-35), the views it answers with, and the one way a machine's status moves
 * (`moveMachine`: the row, its audit row and machine.status_changed in the caller's command). The floor reads the same
 * rows without the machine's cost and supplier (the column grant hides the cost; the floor reads no Party), and its
 * views name nobody: a reporter and a technician are a kind (a station, a worker, an office user; mine or another's),
 * never a name (Statuto dei Lavoratori art. 4). An office list names office users only; a floor worker's name appears
 * only inside the one record, at a site that records workers.
 */

export type Reader = Pick<CommandTx, 'machine' | 'machineClass' | 'machineSymptom' | 'maintenanceRequest' | 'maintenanceJob' | 'user' | 'worker' | 'storedFile' | 'station' | '$queryRaw'>

// ---- words of the lists ---------------------------------------------------------------------------------------------

export const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

const CLASS_BRIEF = { id: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true } as const satisfies Prisma.MachineClassSelect
const SYMPTOM_BRIEF = { id: true, code: true, classId: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, unsafe: true, needsDetail: true, active: true } as const satisfies Prisma.MachineSymptomSelect
type ClassBrief = Prisma.MachineClassGetPayload<{ select: typeof CLASS_BRIEF }>
type SymptomBrief = Prisma.MachineSymptomGetPayload<{ select: typeof SYMPTOM_BRIEF }>

export const classBrief = (row: ClassBrief) => ({ id: row.id, code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: wordsOf(row.labelI18n), icon: row.icon })
export const symptomBrief = (row: SymptomBrief) => ({
  id: row.id,
  code: row.code,
  classId: row.classId,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  unsafe: row.unsafe,
  needsDetail: row.needsDetail,
  active: row.active,
})

// ---- machines -----------------------------------------------------------------------------------------------------

const PLACE = {
  station: { select: { id: true, code: true, name: true, line: { select: { id: true, code: true, name: true } } } },
  workCentre: { select: { id: true, code: true, name: true } },
} as const

/** What the floor may read of a machine (never its cost or supplier). */
export const MACHINE_FLOOR_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  assetNumber: true,
  classId: true,
  make: true,
  modelName: true,
  serialNumber: true,
  year: true,
  stationId: true,
  workCentreId: true,
  status: true,
  statusSince: true,
  statusReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  site: { select: { code: true } },
  machineClass: { select: CLASS_BRIEF },
  ...PLACE,
} as const satisfies Prisma.MachineSelect

export const MACHINE_COLUMNS = {
  ...MACHINE_FLOOR_COLUMNS,
  supplierId: true,
  purchaseCost: true,
  supplier: { select: { id: true, code: true, legalName: true } },
} as const satisfies Prisma.MachineSelect

export type MachineFloorRow = Prisma.MachineGetPayload<{ select: typeof MACHINE_FLOOR_COLUMNS }>
export type MachineRow = MachineFloorRow & Partial<Pick<Prisma.MachineGetPayload<{ select: typeof MACHINE_COLUMNS }>, 'supplierId' | 'purchaseCost' | 'supplier'>>

export const machineColumns = (context: PlantContext) => (context.audience === 'office' ? MACHINE_COLUMNS : MACHINE_FLOOR_COLUMNS)

export async function readMachine(db: Reader, context: PlantContext, id: string): Promise<MachineRow | null> {
  return (await db.machine.findUnique({ where: { id }, select: machineColumns(context) })) as MachineRow | null
}

/** The machine row locked for the command (every plant write that moves a machine takes it first: one lock order). */
export async function lockMachine(tx: CommandTx, context: PlantContext, id: string): Promise<MachineRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Machine" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readMachine(tx, context, id)
}

/** The machines locked as unsafe (an unsafe request not signed safe), by machine: the first such request. */
export async function locksOf(db: Pick<Reader, 'maintenanceRequest'>, machineIds: readonly string[]): Promise<Map<string, string>> {
  if (machineIds.length === 0) return new Map()
  const rows = await db.maintenanceRequest.findMany({
    where: { machineId: { in: [...machineIds] }, unsafe: true, signedSafeAt: null },
    orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, machineId: true },
  })
  const locks = new Map<string, string>()
  for (const row of rows) if (!locks.has(row.machineId)) locks.set(row.machineId, row.id)
  return locks
}

/** Open requests and open jobs per machine. One query after the other: a transaction client runs one at a time. */
export async function openWorkOf(db: Pick<Reader, 'maintenanceRequest' | 'maintenanceJob'>, machineIds: readonly string[]): Promise<{ requests: Map<string, number>; jobs: Map<string, number> }> {
  const requests = new Map<string, number>()
  const jobs = new Map<string, number>()
  if (machineIds.length === 0) return { requests, jobs }
  for (const row of await db.maintenanceRequest.groupBy({ by: ['machineId'], where: { machineId: { in: [...machineIds] }, status: { in: [...OPEN_REQUEST_STATUSES] } }, _count: { _all: true } })) requests.set(row.machineId, row._count._all)
  for (const row of await db.maintenanceJob.groupBy({ by: ['machineId'], where: { machineId: { in: [...machineIds] }, status: { in: [...OPEN_JOB_STATUSES] } }, _count: { _all: true } })) jobs.set(row.machineId, row._count._all)
  return { requests, jobs }
}

const placeView = (row: MachineFloorRow) => ({
  station: row.station ? { id: row.station.id, code: row.station.code, name: row.station.name } : null,
  line: row.station?.line ? { id: row.station.line.id, code: row.station.line.code, name: row.station.line.name } : null,
  workCentre: row.workCentre ? { id: row.workCentre.id, code: row.workCentre.code, name: row.workCentre.name } : null,
})

export interface MachineFacts {
  readonly locked: boolean
  readonly openRequests: number
  readonly openJobs: number
}

/** A machine as a list row or record shows it; the office also sees the supplier, and the cost with its grain. */
export function machineView(row: MachineRow, facts: MachineFacts, context: PlantContext) {
  const office = context.audience === 'office'
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    siteCode: row.site.code,
    assetNumber: row.assetNumber,
    class: classBrief(row.machineClass),
    make: row.make,
    modelName: row.modelName,
    serialNumber: row.serialNumber,
    year: row.year,
    ...placeView(row),
    supplier: office && row.supplier ? { id: row.supplier.id, code: row.supplier.code, name: row.supplier.legalName } : null,
    purchaseCost: asMoney('cost', office ? (row.purchaseCost ?? null) : null),
    status: row.status as MachineStatus,
    statusSince: toUtcIso(row.statusSince),
    statusReason: row.statusReason,
    locked: facts.locked,
    note: row.note,
    openRequests: facts.openRequests,
    openJobs: facts.openJobs,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export async function machineViews(db: Reader, rows: readonly MachineRow[], context: PlantContext) {
  const ids = rows.map((row) => row.id)
  const locks = await locksOf(db, ids)
  const work = await openWorkOf(db, ids)
  return rows.map((row) => machineView(row, { locked: locks.has(row.id), openRequests: work.requests.get(row.id) ?? 0, openJobs: work.jobs.get(row.id) ?? 0 }, context))
}

/** What the audit rows keep of a machine (the cost with its grain). */
export const auditedMachine = (row: { readonly assetNumber: string; readonly classId: string; readonly make: string | null; readonly modelName: string | null; readonly serialNumber: string | null; readonly year: number | null; readonly stationId: string | null; readonly workCentreId: string | null; readonly supplierId?: string | null; readonly purchaseCost?: number | null; readonly note: string | null; readonly status: string }) => ({
  assetNumber: row.assetNumber,
  classId: row.classId,
  make: row.make,
  modelName: row.modelName,
  serialNumber: row.serialNumber,
  year: row.year,
  stationId: row.stationId,
  workCentreId: row.workCentreId,
  supplierId: row.supplierId ?? null,
  purchaseCost: markMoney('cost', row.purchaseCost ?? null),
  note: row.note,
  status: row.status,
})

export interface StatusMove {
  readonly reason: string | null
  readonly cause: 'REPORT' | 'JOB' | 'SIGN_SAFE' | 'TRIAGE' | 'RETIRE'
  readonly recordType: 'MaintenanceRequest' | 'MaintenanceJob' | 'Machine'
  readonly recordId: string
  readonly by: 'OFFICE' | 'FLOOR' | 'SYSTEM'
}

/**
 * Moves a machine's status inside the caller's command (the machine row locked first by the caller): the row (since now,
 * the reason a DO_NOT_USE, DOWN or RETIRED status shows; none otherwise), its audit row and machine.status_changed. The
 * database's Machine_lock_kept holds the lock at commit (H1). Answers the status it now has.
 */
export async function moveMachine(tools: CommandTools, machine: { readonly id: string; readonly assetNumber: string; readonly companyId: string; readonly siteId: string; readonly status: string }, to: MachineStatus, move: StatusMove): Promise<MachineStatus> {
  const from = machine.status as MachineStatus
  if (from === to) return from
  const reason = to === 'DO_NOT_USE' || to === 'DOWN' || to === 'RETIRED' ? move.reason : null
  await tools.tx.machine.update({
    where: { id: machine.id },
    data: { status: to as DbMachineStatus, statusSince: tools.now, statusReason: reason, version: { increment: 1 }, updatedAt: tools.now },
    select: { id: true },
  })
  const locked = (await locksOf(tools.tx, [machine.id])).has(machine.id)
  const scope = { companyId: machine.companyId, siteId: machine.siteId }
  tools.audit({ action: 'plant.machineStatus', recordType: 'Machine', recordId: machine.id, ...scope, before: { status: from }, after: { status: to, statusReason: reason, cause: move.cause, recordType: move.recordType, recordId: move.recordId } })
  tools.emit({
    type: 'machine.status_changed',
    subject: machine.id,
    ...scope,
    payload: { machineId: machine.id, assetNumber: machine.assetNumber, from, to, cause: move.cause, recordType: move.recordType, recordId: move.recordId, locked, by: move.by },
  })
  return to
}

// ---- requests ------------------------------------------------------------------------------------------------------

export const REQUEST_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  machineId: true,
  symptomId: true,
  description: true,
  unsafe: true,
  reportedAt: true,
  reportedById: true,
  reportedByWorkerId: true,
  stationId: true,
  deviceId: true,
  status: true,
  acknowledgedAt: true,
  acknowledgedById: true,
  jobId: true,
  mergedIntoId: true,
  closedAt: true,
  closedById: true,
  closeReason: true,
  closeNote: true,
  signedSafeAt: true,
  signedSafeById: true,
  signedSafeByWorkerId: true,
  signedSafeNote: true,
  version: true,
  createdAt: true,
  machine: { select: { id: true, assetNumber: true, status: true, classId: true, machineClass: { select: CLASS_BRIEF } } },
  symptom: { select: SYMPTOM_BRIEF },
  station: { select: { id: true, code: true, name: true } },
  job: { select: { id: true, number: true, status: true } },
} as const satisfies Prisma.MaintenanceRequestSelect
export type RequestRow = Prisma.MaintenanceRequestGetPayload<{ select: typeof REQUEST_COLUMNS }>

export async function readRequest(db: Reader, id: string): Promise<RequestRow | null> {
  return db.maintenanceRequest.findUnique({ where: { id }, select: REQUEST_COLUMNS })
}

/** The request row locked for the command (after its machine). */
export async function lockRequest(tx: CommandTx, id: string): Promise<RequestRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MaintenanceRequest" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readRequest(tx, id)
}

/** Office users' names by id (office answers only). */
export async function namesOf(db: Pick<Reader, 'user'>, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** Floor workers' names by id (only inside one record, in the office). */
async function workerNamesOf(db: Pick<Reader, 'worker'>, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.worker.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((worker) => [worker.id, worker.displayName]))
}

type Person = { readonly kind: 'USER' | 'WORKER' | 'STATION'; readonly id: string | null; readonly name: string | null }

export interface ViewOptions {
  /** Inside one record: a worker's name may show (office). */
  readonly record: boolean
}

/** Other open requests of the same machine (possible duplicates), per request. */
export async function duplicatesOf(db: Pick<Reader, 'maintenanceRequest'>, rows: readonly Pick<RequestRow, 'id' | 'machineId' | 'status'>[]): Promise<Map<string, number>> {
  const open = new Map<string, number>()
  const machineIds = [...new Set(rows.map((row) => row.machineId))]
  if (machineIds.length > 0) {
    for (const row of await db.maintenanceRequest.groupBy({ by: ['machineId'], where: { machineId: { in: machineIds }, status: { in: [...OPEN_REQUEST_STATUSES] } }, _count: { _all: true } })) open.set(row.machineId, row._count._all)
  }
  return new Map(rows.map((row) => [row.id, Math.max(0, (open.get(row.machineId) ?? 0) - (isOpenRequest(row.status) ? 1 : 0))]))
}

/** Requests as a list row or a record shows them. */
export async function requestViews(db: Reader, rows: readonly RequestRow[], context: PlantContext, now: Date, options: ViewOptions = { record: false }) {
  const office = context.audience === 'office'
  const users = office ? await namesOf(db, rows.flatMap((row) => [row.reportedById, row.acknowledgedById, row.closedById, row.signedSafeById])) : new Map<string, string>()
  const workers = office && options.record ? await workerNamesOf(db, rows.flatMap((row) => [row.reportedByWorkerId, row.signedSafeByWorkerId])) : new Map<string, string>()
  const duplicates = await duplicatesOf(db, rows)
  const photos = new Map<string, number>()
  if (rows.length > 0) {
    for (const row of await db.storedFile.groupBy({ by: ['recordId'], where: { recordType: 'MaintenanceRequest', recordId: { in: rows.map((entry) => entry.id) }, status: 'AVAILABLE' }, _count: { _all: true } })) {
      photos.set(row.recordId, row._count._all)
    }
  }
  const person = (userId: string | null, workerId: string | null, station: RequestRow['station'] | null): Person | null => {
    if (userId) return { kind: 'USER', id: office ? userId : null, name: users.get(userId) ?? null }
    if (workerId) return { kind: 'WORKER', id: office && options.record ? workerId : null, name: workers.get(workerId) ?? null }
    if (station) return { kind: 'STATION', id: station.id, name: `${station.code} ${station.name}` }
    return null
  }
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    machine: { id: row.machine.id, assetNumber: row.machine.assetNumber, status: row.machine.status as MachineStatus, class: classBrief(row.machine.machineClass) },
    symptom: row.symptom ? symptomBrief(row.symptom) : null,
    description: row.description,
    unsafe: row.unsafe,
    reportedAt: toUtcIso(row.reportedAt),
    ageMinutes: minutesSince(row.reportedAt, now),
    reportedBy: person(row.reportedById, row.reportedByWorkerId, row.station)!,
    station: row.station ? { id: row.station.id, code: row.station.code, name: row.station.name } : null,
    status: row.status,
    acknowledgedAt: row.acknowledgedAt ? toUtcIso(row.acknowledgedAt) : null,
    acknowledgedBy: row.acknowledgedById ? person(row.acknowledgedById, null, null) : null,
    job: row.job ? { id: row.job.id, number: row.job.number, status: row.job.status } : null,
    mergedIntoId: row.mergedIntoId,
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    closedBy: row.closedById ? person(row.closedById, null, null) : null,
    closeReason: row.closeReason,
    closeNote: row.closeNote,
    signedSafe: row.signedSafeAt
      ? { at: toUtcIso(row.signedSafeAt), by: person(row.signedSafeById, row.signedSafeByWorkerId, null)!, note: row.signedSafeNote }
      : null,
    /** An unsafe request that waits for a technician's sign-safe: the machine is locked by it. */
    locking: row.unsafe && row.signedSafeAt === null,
    duplicates: duplicates.get(row.id) ?? 0,
    photos: photos.get(row.id) ?? 0,
    version: row.version,
  }))
}

// ---- jobs ------------------------------------------------------------------------------------------------------------

export const JOB_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  machineId: true,
  type: true,
  source: true,
  problem: true,
  symptomId: true,
  priority: true,
  assigneeId: true,
  assigneeWorkerId: true,
  dueAt: true,
  status: true,
  startedAt: true,
  handedBackAt: true,
  handedBackById: true,
  handedBackByWorkerId: true,
  workDone: true,
  machineAfter: true,
  closedAt: true,
  closedById: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  createdById: true,
  machine: { select: { id: true, assetNumber: true, status: true, classId: true, machineClass: { select: CLASS_BRIEF }, ...PLACE } },
  symptom: { select: SYMPTOM_BRIEF },
  requests: { select: { id: true }, orderBy: { reportedAt: 'asc' } },
} as const satisfies Prisma.MaintenanceJobSelect
export type JobRow = Prisma.MaintenanceJobGetPayload<{ select: typeof JOB_COLUMNS }>

export async function readJob(db: Reader, id: string): Promise<JobRow | null> {
  return db.maintenanceJob.findUnique({ where: { id }, select: JOB_COLUMNS })
}

/** The job row locked for the command (after its machine). */
export async function lockJob(tx: CommandTx, id: string): Promise<JobRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MaintenanceJob" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readJob(tx, id)
}

/** Whose job it is for a floor technician (no name). */
export const ownershipOf = (job: Pick<JobRow, 'assigneeId' | 'assigneeWorkerId'>, context: PlantContext): JobOwnership => {
  if (job.assigneeId === null && job.assigneeWorkerId === null) return 'NOBODY'
  if (context.audience === 'floor') return job.assigneeWorkerId === context.actorId ? 'MINE' : 'OTHER'
  return job.assigneeId === context.actorId ? 'MINE' : 'OTHER'
}

/** Jobs as a list row or a record shows them. */
export async function jobViews(db: Reader, rows: readonly JobRow[], context: PlantContext, now: Date, options: ViewOptions = { record: false }) {
  const office = context.audience === 'office'
  const users = office ? await namesOf(db, rows.flatMap((row) => [row.assigneeId, row.handedBackById, row.closedById, row.createdById])) : new Map<string, string>()
  const workers = office && options.record ? await workerNamesOf(db, rows.flatMap((row) => [row.assigneeWorkerId, row.handedBackByWorkerId])) : new Map<string, string>()
  const locks = await locksOf(db, [...new Set(rows.map((row) => row.machineId))])
  const person = (userId: string | null, workerId: string | null): Person | null => {
    if (userId) return { kind: 'USER', id: office ? userId : null, name: office ? (users.get(userId) ?? null) : null }
    if (workerId) return { kind: 'WORKER', id: office && options.record ? workerId : null, name: workers.get(workerId) ?? null }
    return null
  }
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    number: row.number,
    machine: {
      id: row.machine.id,
      assetNumber: row.machine.assetNumber,
      status: row.machine.status as MachineStatus,
      locked: locks.has(row.machineId),
      class: classBrief(row.machine.machineClass),
      station: row.machine.station ? { id: row.machine.station.id, code: row.machine.station.code, name: row.machine.station.name } : null,
      line: row.machine.station?.line ? { id: row.machine.station.line.id, code: row.machine.station.line.code, name: row.machine.station.line.name } : null,
    },
    type: row.type,
    source: row.source,
    problem: row.problem,
    symptom: row.symptom ? symptomBrief(row.symptom) : null,
    priority: row.priority,
    assignee: person(row.assigneeId, row.assigneeWorkerId),
    /** The caller's view of whose job it is: MINE, NOBODY or OTHER. */
    ownership: ownershipOf(row, context),
    dueAt: row.dueAt ? toUtcIso(row.dueAt) : null,
    overdue: isOverdue(row, now),
    status: row.status,
    startedAt: row.startedAt ? toUtcIso(row.startedAt) : null,
    handedBack: row.handedBackAt ? { at: toUtcIso(row.handedBackAt), by: person(row.handedBackById, row.handedBackByWorkerId)!, workDone: row.workDone!, machineAfter: row.machineAfter! as MachineAfter } : null,
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    closedBy: row.closedById ? person(row.closedById, null) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    requestIds: row.requests.map((request) => request.id),
    ageMinutes: minutesSince(row.createdAt, now),
    open: isOpenJob(row.status),
    createdAt: toUtcIso(row.createdAt),
    createdBy: office && row.createdById ? person(row.createdById, null) : null,
    version: row.version,
  }))
}

// ---- the machine card (a request's and a job's record; the station's) ----------------------------------------------

/** What the record of a request or job shows of its machine: now, the open job, the last jobs, the repeat-failure hint. */
export async function machineCard(db: Reader, context: PlantContext, machineId: string, now: Date, options: { readonly lastJobs: number }) {
  const machine = await readMachine(db, context, machineId)
  if (!machine) return null
  const [view] = await machineViews(db, [machine], context)
  const since = new Date(now.getTime() - REPEAT_FAILURE.days * 24 * 60 * 60_000)
  const recent = await db.maintenanceRequest.count({ where: { machineId, reportedAt: { gte: since }, status: { not: 'MERGED' } } })
  const jobs = await db.maintenanceJob.findMany({ where: { machineId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.lastJobs + 1, select: { id: true, number: true, type: true, status: true, problem: true, createdAt: true, closedAt: true } })
  const openJob = await db.maintenanceJob.findFirst({ where: { machineId, status: { in: [...OPEN_JOB_STATUSES] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, number: true, status: true } })
  return {
    machine: view!,
    openJob,
    lastJobs: jobs.slice(0, options.lastJobs).map((job) => ({ id: job.id, number: job.number, type: job.type, status: job.status, problem: job.problem, createdAt: toUtcIso(job.createdAt), closedAt: job.closedAt ? toUtcIso(job.closedAt) : null })),
    requestsIn30Days: recent,
    repeatFailure: isRepeatFailure(recent),
  }
}
