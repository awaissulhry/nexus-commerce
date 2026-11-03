import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { dayOf, dueStateOf, keptYearsOf, reminderFromOf, type CheckIntervalUnit, type CheckOutcome, type CheckPlanStatus, type StatutoryRefusal } from '@nexus/factory-domain/plant/statutory/rules'
import type { CommandTx } from '../../../core/command'
import { heldRoles } from '../../../platform/auth/roles/access'
import { bodyIssue } from '../access'
import { locksOf, namesOf, wordsOf } from '../store'

/**
 * What the statutory checks read and show (B-W2b-124; QHS-205): the columns, the views of a check type, a plan and a
 * result, the report files of a result, and the refusal of a check rule (a 409 whose issues are `refusal/<CODE>` and
 * `fix`, as every plant refusal). People: the plan's owner and who recorded a result are office users, named (as the
 * plant's lists name office users); who did a check is the outside body or the inspector, in words as on the report.
 */

export type Reader = Pick<
  CommandTx,
  'machineCheckType' | 'machineCheckPlan' | 'machineCheckResult' | 'machine' | 'machineClass' | 'maintenanceRequest' | 'maintenanceJob' | 'party' | 'user' | 'site' | 'storedFile' | '$queryRaw'
>

/** Today, in the factory's zone. */
export const todayOf = (now: Date): BusinessDate => businessDate(now)

// ---- refusals ---------------------------------------------------------------------------------------------------------------

export class StatutoryRefusedError extends ConflictError {
  override name = 'StatutoryRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: StatutoryRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: StatutoryRefusal): never => {
  throw new StatutoryRefusedError(refusal)
}

// ---- check types ------------------------------------------------------------------------------------------------------------

export const TYPE_COLUMNS = {
  id: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  legalBasis: true,
  classId: true,
  defaultInterval: true,
  defaultIntervalUnit: true,
  outsideBody: true,
  retentionYears: true,
  sortOrder: true,
  active: true,
  version: true,
  updatedAt: true,
  machineClass: { select: { id: true, code: true, labelIt: true, labelEn: true } },
} as const satisfies Prisma.MachineCheckTypeSelect
export type TypeRow = Prisma.MachineCheckTypeGetPayload<{ select: typeof TYPE_COLUMNS }>

export const typeView = (row: TypeRow, use: { readonly plans: number; readonly results: number }) => ({
  id: row.id,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  legalBasis: row.legalBasis,
  machineClass: row.machineClass,
  defaultInterval: row.defaultInterval,
  defaultIntervalUnit: row.defaultIntervalUnit as CheckIntervalUnit,
  outsideBody: row.outsideBody,
  retentionYears: row.retentionYears,
  /** How long its results are kept: its retention, at least the law's three years. */
  keptYears: keptYearsOf(row.retentionYears),
  sortOrder: row.sortOrder,
  active: row.active,
  /** ACTIVE plans of the type, and results of it (a used type is retired, never deleted). */
  plans: use.plans,
  results: use.results,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

export const byOrder = (a: { sortOrder: number; code: string }, b: { sortOrder: number; code: string }) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

const typeBrief = (row: { id: string; code: string; labelIt: string; labelEn: string; legalBasis: string; outsideBody: boolean; retentionYears: number; active: boolean }) => ({
  id: row.id,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  legalBasis: row.legalBasis,
  outsideBody: row.outsideBody,
  keptYears: keptYearsOf(row.retentionYears),
  active: row.active,
})
const TYPE_BRIEF = { id: true, code: true, labelIt: true, labelEn: true, legalBasis: true, outsideBody: true, retentionYears: true, active: true } as const

const MACHINE_BRIEF = { id: true, assetNumber: true, make: true, modelName: true, status: true, classId: true, siteId: true } as const
const SITE_BRIEF = { id: true, code: true, name: true } as const
const PARTY_BRIEF = { id: true, legalName: true } as const

// ---- plans ---------------------------------------------------------------------------------------------------------------------

export const PLAN_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  machineId: true,
  checkTypeId: true,
  interval: true,
  intervalUnit: true,
  outsideBodyPartyId: true,
  ownerId: true,
  firstDueOn: true,
  nextDueOn: true,
  reminderDays: true,
  lastRemindedAt: true,
  status: true,
  endedAt: true,
  endedReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  site: { select: SITE_BRIEF },
  machine: { select: MACHINE_BRIEF },
  checkType: { select: TYPE_BRIEF },
  outsideBody: { select: PARTY_BRIEF },
} as const satisfies Prisma.MachineCheckPlanSelect
export type PlanRow = Prisma.MachineCheckPlanGetPayload<{ select: typeof PLAN_COLUMNS }>

export async function readPlan(db: Pick<Reader, 'machineCheckPlan'>, id: string): Promise<PlanRow | null> {
  return db.machineCheckPlan.findUnique({ where: { id }, select: PLAN_COLUMNS })
}

/** The plan row locked (FOR UPDATE), then read. */
export async function lockPlan(tx: CommandTx, id: string): Promise<PlanRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MachineCheckPlan" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readPlan(tx, id)
}

/** The newest result of each plan that no later result corrects (the plan's "last done"). */
async function lastDoneOf(db: Pick<Reader, 'machineCheckResult'>, planIds: readonly string[]) {
  const last = new Map<string, { resultId: string; performedOn: BusinessDate; outcome: CheckOutcome }>()
  if (planIds.length === 0) return last
  const rows = await db.machineCheckResult.findMany({
    where: { planId: { in: [...planIds] }, correctedBy: { none: {} } },
    orderBy: [{ performedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, planId: true, performedOn: true, outcome: true },
  })
  for (const row of rows) if (row.planId && !last.has(row.planId)) last.set(row.planId, { resultId: row.id, performedOn: dayOf(row.performedOn), outcome: row.outcome as CheckOutcome })
  return last
}

export async function planViews(db: Reader, rows: readonly PlanRow[], now: Date) {
  const today = todayOf(now)
  const names = await namesOf(db, rows.map((row) => row.ownerId))
  const last = await lastDoneOf(db, rows.map((row) => row.id))
  const locks = await locksOf(db, [...new Set(rows.map((row) => row.machineId))])
  return rows.map((row) => {
    const nextDueOn = dayOf(row.nextDueOn)
    const status = row.status as CheckPlanStatus
    return {
      id: row.id,
      companyId: row.companyId,
      site: row.site,
      machine: { ...row.machine, locked: locks.has(row.machineId) },
      checkType: typeBrief(row.checkType),
      interval: row.interval,
      intervalUnit: row.intervalUnit as CheckIntervalUnit,
      outsideBody: row.outsideBody ? { id: row.outsideBody.id, name: row.outsideBody.legalName } : null,
      owner: row.ownerId ? { id: row.ownerId, name: names.get(row.ownerId) ?? null } : null,
      firstDueOn: dayOf(row.firstDueOn),
      nextDueOn,
      reminderDays: row.reminderDays,
      reminderFrom: reminderFromOf({ nextDueOn, reminderDays: row.reminderDays }),
      lastRemindedAt: row.lastRemindedAt ? toUtcIso(row.lastRemindedAt) : null,
      lastDone: last.get(row.id) ?? null,
      due: dueStateOf({ status, nextDueOn }, today),
      status,
      endedAt: row.endedAt ? toUtcIso(row.endedAt) : null,
      endedReason: row.endedReason,
      note: row.note,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}
export type PlanView = Awaited<ReturnType<typeof planViews>>[number]

// ---- results ---------------------------------------------------------------------------------------------------------------------

export const RESULT_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  machineId: true,
  checkTypeId: true,
  planId: true,
  performedOn: true,
  outcome: true,
  remarks: true,
  performedBy: true,
  outsideBodyPartyId: true,
  nextDueOn: true,
  keptUntil: true,
  correctsId: true,
  correctionReason: true,
  createdAt: true,
  createdById: true,
  site: { select: SITE_BRIEF },
  machine: { select: MACHINE_BRIEF },
  checkType: { select: TYPE_BRIEF },
  outsideBody: { select: PARTY_BRIEF },
  corrects: { select: { id: true, performedOn: true } },
  correctedBy: { select: { id: true, performedOn: true, createdAt: true } },
  jobs: { select: { id: true, number: true, status: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.MachineCheckResultSelect
export type ResultRow = Prisma.MachineCheckResultGetPayload<{ select: typeof RESULT_COLUMNS }>

export async function readResult(db: Pick<Reader, 'machineCheckResult'>, id: string): Promise<ResultRow | null> {
  return db.machineCheckResult.findUnique({ where: { id }, select: RESULT_COLUMNS })
}

/** The result's report files: AVAILABLE CHECK_REPORT files of it (the generic routes cannot set that category). */
export async function reportsOf(db: Pick<Reader, 'storedFile'>, resultIds: readonly string[]) {
  const reports = new Map<string, { id: string; originalName: string; contentType: string; sizeBytes: number; availableAt: string | null }[]>()
  if (resultIds.length === 0) return reports
  const rows = await db.storedFile.findMany({
    where: { recordType: 'MachineCheckResult', recordId: { in: [...resultIds] }, category: 'CHECK_REPORT', status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, availableAt: true },
  })
  for (const row of rows) {
    const list = reports.get(row.recordId) ?? []
    list.push({ id: row.id, originalName: row.originalName, contentType: row.contentType, sizeBytes: row.sizeBytes, availableAt: row.availableAt ? toUtcIso(row.availableAt) : null })
    reports.set(row.recordId, list)
  }
  return reports
}

/**
 * Whether a result has its report on file: a report of its own, or of a result it corrects (down the chain): a correction of
 * a typed date keeps the report the outside body gave.
 */
export async function reportOnFile(db: Pick<Reader, 'storedFile' | 'machineCheckResult'>, rows: readonly Pick<ResultRow, 'id' | 'correctsId'>[]): Promise<Map<string, boolean>> {
  const chain = new Map<string, string[]>()
  const corrects = new Map<string, string | null>(rows.map((row) => [row.id, row.correctsId]))
  // Follow the corrections down (a chain is short: each result is corrected at most once).
  let missing = rows.map((row) => row.correctsId).filter((id): id is string => id !== null && !corrects.has(id))
  for (let depth = 0; missing.length > 0 && depth < 20; depth++) {
    const found = await db.machineCheckResult.findMany({ where: { id: { in: missing } }, select: { id: true, correctsId: true } })
    for (const row of found) corrects.set(row.id, row.correctsId)
    missing = found.map((row) => row.correctsId).filter((id): id is string => id !== null && !corrects.has(id))
  }
  for (const row of rows) {
    const ids = [row.id]
    let next = row.correctsId
    while (next && !ids.includes(next) && ids.length < 21) {
      ids.push(next)
      next = corrects.get(next) ?? null
    }
    chain.set(row.id, ids)
  }
  const reports = await reportsOf(db, [...new Set([...chain.values()].flat())])
  return new Map([...chain.entries()].map(([id, ids]) => [id, ids.some((one) => (reports.get(one)?.length ?? 0) > 0)]))
}

export async function resultViews(db: Reader, rows: readonly ResultRow[]) {
  const names = await namesOf(db, rows.map((row) => row.createdById))
  const reports = await reportsOf(db, rows.map((row) => row.id))
  const onFile = await reportOnFile(db, rows)
  return rows.map((row) => {
    const correctedBy = row.correctedBy[0] ?? null
    return {
      id: row.id,
      companyId: row.companyId,
      site: row.site,
      machine: row.machine,
      checkType: typeBrief(row.checkType),
      planId: row.planId,
      performedOn: dayOf(row.performedOn),
      outcome: row.outcome as CheckOutcome,
      remarks: row.remarks,
      performedBy: row.performedBy,
      outsideBody: row.outsideBody ? { id: row.outsideBody.id, name: row.outsideBody.legalName } : null,
      nextDueOn: row.nextDueOn ? dayOf(row.nextDueOn) : null,
      keptUntil: dayOf(row.keptUntil),
      corrects: row.corrects ? { id: row.corrects.id, performedOn: dayOf(row.corrects.performedOn) } : null,
      correctionReason: row.correctionReason,
      correctedBy: correctedBy ? { id: correctedBy.id, performedOn: dayOf(correctedBy.performedOn) } : null,
      /** Not corrected by a later result: the one in force. */
      inForce: correctedBy === null,
      reports: reports.get(row.id) ?? [],
      /** A report on file, its own or one of the result it corrects. */
      reportOnFile: onFile.get(row.id) ?? false,
      jobs: row.jobs.map((job) => ({ id: job.id, number: job.number, status: job.status })),
      recordedAt: toUtcIso(row.createdAt),
      recordedBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? null } : null,
    }
  })
}
export type ResultView = Awaited<ReturnType<typeof resultViews>>[number]

// ---- checks of what a body names ---------------------------------------------------------------------------------------------------

/** The outside body named: an organisation of the tenant (of the machine's company, or of every company) not archived. */
export async function checkOutsideBody(tx: Pick<CommandTx, 'party'>, partyId: string | null | undefined, companyId: string, path = 'outsideBodyPartyId'): Promise<string | null> {
  if (!partyId) return null
  const party = await tx.party.findFirst({ where: { id: partyId, kind: 'ORGANISATION', status: { not: 'ARCHIVED' }, OR: [{ companyId: null }, { companyId }] }, select: { id: true } })
  if (!party) throw bodyIssue(path, 'Not an organisation of the group (the outside body, an accredited inspector): pick one from the parties.')
  return party.id
}

/** The plan's owner named: an ACTIVE office user who sees the machine's plant (plant.view over its company and site). */
export async function checkOwner(tx: CommandTx, tenantId: string, ownerId: string | null | undefined, machine: { readonly companyId: string; readonly siteId: string }, now: Date): Promise<string | null> {
  if (!ownerId) return null
  const user = await tx.user.findFirst({ where: { id: ownerId, status: 'ACTIVE' }, select: { id: true } })
  const grants = user ? sessionGrants({ requireMfa: false }, await heldRoles(tx, ownerId, now), true) : []
  if (!user || !can({ audience: 'office', tenantId, grants }, PLANT_VIEW, machine)) throw bodyIssue('ownerId', "Not an office person who sees this machine's plant (plant.view at its site).")
  return user.id
}
