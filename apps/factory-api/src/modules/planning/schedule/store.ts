import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { laneOfSlot, type DiffSlot, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { CommandTx } from '../../../core/command'
import type { Reader, SiteRow } from '../store'

/**
 * What the planning board reads and locks (B-W2a-34), one query after another on the caller's client (a command's `tx`
 * or `caller.withClient`). Every read names its columns.
 *
 *   the lock      every write of a site's schedule (a place, move, removal, allocation, placement by due date, and the
 *                 publish) takes the advisory lock `factory.schedule|tenant|site` first, then the working plan's row
 *                 (its version bump): writes of one site's plan run one after another, and a publish copies a plan
 *                 nobody is changing.
 *   the working plan  one per site (the partial unique index): made by the first write that needs it.
 */

export const SLOT_COLUMNS = {
  id: true,
  siteId: true,
  planVersionId: true,
  planKind: true,
  workOrderId: true,
  workOrderOperationId: true,
  lineId: true,
  workCentreId: true,
  partyId: true,
  startAt: true,
  endAt: true,
  pieces: true,
  minutes: true,
  overloadReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  updatedById: true,
} as const satisfies Prisma.ScheduleSlotSelect
export type SlotRow = Prisma.ScheduleSlotGetPayload<{ select: typeof SLOT_COLUMNS }>

export const PLAN_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  number: true,
  previousId: true,
  coversFrom: true,
  coversTo: true,
  effectiveFrom: true,
  publishedAt: true,
  publishedById: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PlanVersionSelect
export type PlanRow = Prisma.PlanVersionGetPayload<{ select: typeof PLAN_COLUMNS }>

export const workingPlanOf = (db: Reader, siteId: string): Promise<PlanRow | null> => db.planVersion.findFirst({ where: { siteId, kind: 'WORKING' }, select: PLAN_COLUMNS })

/** The site's published versions, the latest number first. */
export const publishedOf = (db: Reader, siteId: string, take?: number): Promise<PlanRow[]> =>
  db.planVersion.findMany({ where: { siteId, kind: 'PUBLISHED' }, select: PLAN_COLUMNS, orderBy: { number: 'desc' }, ...(take ? { take } : {}) })

/**
 * The version the floor works to now: the highest number that has started (effectiveFrom ≤ now); and a later one that
 * waits for its start ("New schedule v13 from 06:00").
 */
export async function floorVersionsOf(db: Reader, siteId: string, now: Date): Promise<{ current: PlanRow | null; upcoming: PlanRow | null }> {
  const versions = await db.planVersion.findMany({ where: { siteId, kind: 'PUBLISHED' }, select: PLAN_COLUMNS, orderBy: { number: 'desc' }, take: 20 })
  const current = versions.find((version) => version.effectiveFrom !== null && version.effectiveFrom <= now) ?? null
  const upcoming = versions.find((version) => version.effectiveFrom !== null && version.effectiveFrom > now && (current === null || version.number! > current.number!)) ?? null
  return { current, upcoming }
}

/** The slots of a plan; with a window, those that reach into it. */
export const slotsOf = (db: Reader, planVersionId: string, window?: { readonly start: Date; readonly end: Date }): Promise<SlotRow[]> =>
  db.scheduleSlot.findMany({
    where: { planVersionId, ...(window ? { startAt: { lt: window.end }, endAt: { gt: window.start } } : {}) },
    select: SLOT_COLUMNS,
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  })

export const diffSlotOf = (slot: SlotRow): DiffSlot => ({
  workOrderId: slot.workOrderId,
  operationId: slot.workOrderOperationId,
  lane: laneOfSlot(slot),
  startAt: slot.startAt.getTime(),
  endAt: slot.endAt.getTime(),
  pieces: slot.pieces,
})

/** Office users' names (who moved a slot, who published): names inside one record only, never a figure. */
export async function userNamesOf(db: Reader, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((value): value is string => value !== null && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

export interface WorkshopRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: string
  readonly location: { readonly id: string; readonly code: string } | null
}

/**
 * The site's workshops (terzisti): ACTIVE parties with the SUBCONTRACTOR role that have an ACTIVE SUBCONTRACTOR location
 * at the site (a subcontract order needs one), and any other workshop the plan names.
 */
export async function workshopsOf(db: Reader, site: SiteRow, alsoIds: Iterable<string> = []): Promise<WorkshopRow[]> {
  const locations = await db.location.findMany({ where: { siteId: site.id, kind: 'SUBCONTRACTOR', status: 'ACTIVE', partyId: { not: null } }, select: { id: true, code: true, partyId: true }, orderBy: { code: 'asc' } })
  const ids = [...new Set([...locations.map((location) => location.partyId!), ...alsoIds])]
  if (ids.length === 0) return []
  const parties = await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, status: true }, orderBy: { code: 'asc' } })
  return parties
    .filter((party) => party.roles.includes('SUBCONTRACTOR'))
    .map((party) => {
      const location = locations.find((candidate) => candidate.partyId === party.id)
      return { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, status: party.status, location: location ? { id: location.id, code: location.code } : null }
    })
}

/** The outside work of a work order's operations: its routing step's workshop and transit days (null: in-house). */
export async function outsideWorkOf(db: Reader, operations: readonly { readonly id: string; readonly styleRevisionId: string; readonly routingSeq: number }[]): Promise<Map<string, { partyId: string; transitDays: number | null }>> {
  const revisions = [...new Set(operations.map((operation) => operation.styleRevisionId))]
  if (revisions.length === 0) return new Map()
  const steps = await db.routingOperation.findMany({ where: { revisionId: { in: revisions }, supplierId: { not: null } }, select: { revisionId: true, seq: true, supplierId: true, transitDays: true } })
  const out = new Map<string, { partyId: string; transitDays: number | null }>()
  for (const operation of operations) {
    const step = steps.find((candidate) => candidate.revisionId === operation.styleRevisionId && candidate.seq === operation.routingSeq)
    if (step) out.set(operation.id, { partyId: step.supplierId!, transitDays: step.transitDays })
  }
  return out
}

/** Takes the site's schedule lock (see above). */
export async function lockSchedule(tx: CommandTx, tenantId: string, siteId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.schedule', ${tenantId}::uuid, ${siteId}::uuid), 0))`
}

/** The working plan's version changed since the caller read it (a publish reviewed an older plan). */
export class PlanChangedError extends DomainError {
  override name = 'PlanChangedError'
  constructor(current: number, sent: number) {
    super('conflict', `The working plan changed since it was read (version ${sent}); it is now at version ${current}. Review it again.`, [{ path: 'body/version', message: `The current version is ${current}.` }])
  }
}

/**
 * Under the site's schedule lock: the working plan (made when the site has none), its version checked when the caller
 * sends one, and bumped when `bump` (every change of the plan; a publish reads it and leaves it).
 */
export async function lockedWorkingPlan(tx: CommandTx, site: SiteRow, tenantId: string, options: { readonly actorId: string | null; readonly now: Date; readonly expectedVersion?: number | undefined; readonly bump: boolean }): Promise<PlanRow> {
  await lockSchedule(tx, tenantId, site.id)
  let plan = await workingPlanOf(tx, site.id)
  if (!plan) {
    plan = await tx.planVersion.create({
      data: { id: newId(), companyId: site.companyId, siteId: site.id, kind: 'WORKING', note: null, createdAt: options.now, updatedAt: options.now, createdById: options.actorId },
      select: PLAN_COLUMNS,
    })
  }
  if (options.expectedVersion !== undefined && options.expectedVersion !== plan.version) throw new PlanChangedError(plan.version, options.expectedVersion)
  if (!options.bump) return plan
  return tx.planVersion.update({ where: { id: plan.id }, data: { version: plan.version + 1, updatedAt: options.now }, select: PLAN_COLUMNS })
}

/** A slot changed since the board read it: who moved it and when, in words ("Moved by Marco at 10:42 · Reload"). */
export class SlotMovedError extends DomainError {
  override name = 'SlotMovedError'
  constructor(current: { readonly version: number; readonly updatedAt: Date }, sent: number, by: string | null, timeZone: string) {
    super(
      'conflict',
      `${by ? `Moved by ${by}` : 'Moved'} at ${whenWords(current.updatedAt.getTime(), timeZone)} (version ${current.version}; you had version ${sent}). Reload the board.`,
      [
        { path: 'body/version', message: `The current version is ${current.version}.` },
        { path: 'updatedAt', message: toUtcIso(current.updatedAt) },
      ],
    )
  }
}

/** A working slot under the lock, at the version the caller read. */
export async function lockedSlot(tx: CommandTx, slotId: string, sentVersion: number, timeZone: string): Promise<SlotRow> {
  const slot = isUuid(slotId) ? await tx.scheduleSlot.findUnique({ where: { id: slotId }, select: SLOT_COLUMNS }) : null
  if (!slot || slot.planKind !== 'WORKING') throw new NotFoundError('Slot not found on the working plan.')
  if (slot.version !== sentVersion) {
    const names = await userNamesOf(tx, [slot.updatedById])
    throw new SlotMovedError(slot, sentVersion, slot.updatedById ? (names.get(slot.updatedById) ?? null) : null, timeZone)
  }
  return slot
}

/** The lane a request names, checked on the site: an ACTIVE line or work centre of it, or an ACTIVE workshop. */
export async function laneFacts(db: Reader, site: SiteRow, lane: LaneRef): Promise<{ readonly ref: LaneRef; readonly code: string; readonly name: string }> {
  if (lane.kind === 'LINE') {
    const row = isUuid(lane.id) ? await db.line.findUnique({ where: { id: lane.id }, select: { id: true, siteId: true, code: true, name: true, status: true } }) : null
    if (!row || row.siteId !== site.id) throw new NotFoundError('Line not found on this site.')
    if (row.status !== 'ACTIVE') throw new ConflictError(`Line ${row.code} is archived: place the work on an active lane.`)
    return { ref: lane, code: row.code, name: row.name }
  }
  if (lane.kind === 'WORK_CENTRE') {
    const row = isUuid(lane.id) ? await db.workCentre.findUnique({ where: { id: lane.id }, select: { id: true, siteId: true, code: true, name: true, status: true } }) : null
    if (!row || row.siteId !== site.id) throw new NotFoundError('Work centre not found on this site.')
    if (row.status !== 'ACTIVE') throw new ConflictError(`Work centre ${row.code} is archived: place the work on an active lane.`)
    return { ref: lane, code: row.code, name: row.name }
  }
  const row = isUuid(lane.id) ? await db.party.findUnique({ where: { id: lane.id }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, status: true } }) : null
  if (!row || !row.roles.includes('SUBCONTRACTOR')) throw new NotFoundError('Workshop not found: a workshop is a party with the subcontractor role.')
  if (row.status !== 'ACTIVE') throw new ConflictError(`${row.tradeName ?? row.legalName} is not active: pick another workshop.`)
  return { ref: lane, code: row.code, name: row.tradeName ?? row.legalName }
}
