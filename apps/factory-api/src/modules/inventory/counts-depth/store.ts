import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { separationInForce, type SeparationInForce, type SeparationRow } from '@nexus/factory-domain/inventory/counts-depth/separation'
import { StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'

/**
 * What counts in depth reads and writes beside the counts' own seam (../counts/store.ts): the count schedules (CountSchedule,
 * B-W2b-277's warehouse-depth.prisma) with their audit rows, the scans of a count (StockCountScan, append-only), and the
 * separation switches of the warehouse rules (InventorySettings: the company's row, id = the company's, else the tenant-wide
 * row, id = the tenant's, else on — as the database reads `factory_wh_counter_not_approver`).
 */

export type Db = FactoryClient | CommandTx

export const SCHEDULE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  name: true,
  locationId: true,
  abcClass: true,
  itemKind: true,
  everyDays: true,
  nextDueOn: true,
  lastCountedOn: true,
  lastCountId: true,
  active: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.CountScheduleSelect
export type ScheduleRow = Prisma.CountScheduleGetPayload<{ select: typeof SCHEDULE_COLUMNS }>

export const dayText = (value: Date): string => value.toISOString().slice(0, 10)
export const dayColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

/** What the audit keeps of a schedule. */
export const auditedSchedule = (row: ScheduleRow) => ({
  name: row.name,
  siteId: row.siteId,
  locationId: row.locationId,
  abcClass: row.abcClass,
  itemKind: row.itemKind,
  everyDays: row.everyDays,
  nextDueOn: dayText(row.nextDueOn),
  lastCountedOn: row.lastCountedOn ? dayText(row.lastCountedOn) : null,
  lastCountId: row.lastCountId,
  active: row.active,
  note: row.note,
})

/** The schedule's row FOR UPDATE at the version the caller read. */
export async function lockSchedule(tx: CommandTx, scheduleId: string, expectedVersion?: number): Promise<ScheduleRow> {
  const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "CountSchedule" WHERE "id" = ${scheduleId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Count schedule not found.')
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('CountSchedule', scheduleId, locked.version, expectedVersion)
  return (await tx.countSchedule.findUnique({ where: { id: scheduleId }, select: SCHEDULE_COLUMNS }))!
}

export function scheduleChanged(tools: Pick<CommandTools, 'emit'>, row: ScheduleRow, change: 'CREATED' | 'CHANGED' | 'RETIRED' | 'REACTIVATED' | 'COUNTED', countId: string | null = null): void {
  tools.emit({
    type: 'inventory.count_schedule_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { scheduleId: row.id, siteId: row.siteId, change, active: row.active, nextDueOn: dayText(row.nextDueOn), locationId: row.locationId, abcClass: row.abcClass, itemKind: row.itemKind, countId },
  })
}

// ---- the separation switches ----------------------------------------------------------------------------------------------

export const SEPARATION_COLUMNS = { id: true, companyId: true, counterNotApprover: true, receiverNotMatcher: true, separationOffReason: true, version: true, updatedAt: true, updatedById: true } as const
export interface SeparationRecord extends SeparationRow {
  readonly id: string
  readonly companyId: string | null
  readonly version: number
  readonly updatedAt: Date
  readonly updatedById: string | null
}

export interface SeparationRows {
  readonly company: SeparationRecord | null
  readonly tenant: SeparationRecord | null
}

/** The company's row and the tenant-wide one (companyId null: the tenant-wide row alone). */
export async function separationRowsOf(db: Db, tenantId: string, companyId: string | null): Promise<SeparationRows> {
  const rows = (await db.inventorySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: SEPARATION_COLUMNS })) as SeparationRecord[]
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

export const separationOf = (companyId: string | null, rows: SeparationRows): SeparationInForce => separationInForce(companyId === null ? undefined : rows.company, rows.tenant)

const tenantOfContext = (context: CommandCaller['factoryContext'] | CommandTools['context']): string => {
  const tenantId = context && 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) throw new ForbiddenError()
  return tenantId
}

/** The switches in force for a company, read with the caller's (or the command's) client. */
export async function separationFor(db: Db, tenantId: string, companyId: string): Promise<SeparationInForce> {
  return separationOf(companyId, await separationRowsOf(db, tenantId, companyId))
}

export const tenantOf = tenantOfContext

/** The request acting as its tenant's system (a floor command's follow-up the floor's grant cannot write: a recount asked). */
export function asSystem(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  const tenantId = tenantOfContext(context)
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(tenantId, context && 'requestId' in context ? String(context.requestId) : 'counts-depth')
  return view
}

// ---- scans ----------------------------------------------------------------------------------------------------------------

export const SCAN_COLUMNS = { id: true, lineId: true, pass: true, code: true, quantity: true, scannedById: true, scannedByWorkerId: true, scannedAt: true } as const

export async function scansOf(db: Db, countId: string, lineIds?: readonly string[]) {
  return db.stockCountScan.findMany({ where: { countId, ...(lineIds ? { lineId: { in: [...lineIds] } } : {}) }, select: SCAN_COLUMNS, orderBy: [{ scannedAt: 'asc' }, { id: 'asc' }] })
}
export type ScanRow = Awaited<ReturnType<typeof scansOf>>[number]

/**
 * The office users who scanned units of these lines: an office user's scans, and a worker's as the office user the worker is
 * (Worker.userId): "who counted is who scanned" for the counter-not-approver rule.
 */
export async function scannerUsersByLine(db: Db, scans: readonly Pick<ScanRow, 'lineId' | 'scannedById' | 'scannedByWorkerId'>[]): Promise<Map<string, string[]>> {
  const workerIds = [...new Set(scans.flatMap((scan) => (scan.scannedByWorkerId ? [scan.scannedByWorkerId] : [])))]
  const workers = workerIds.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, userId: true } })
  const userOf = new Map(workers.map((worker) => [worker.id, worker.userId]))
  const out = new Map<string, string[]>()
  for (const scan of scans) {
    const user = scan.scannedById ?? (scan.scannedByWorkerId ? (userOf.get(scan.scannedByWorkerId) ?? null) : null)
    if (!user) continue
    const list = out.get(scan.lineId) ?? []
    if (!list.includes(user)) list.push(user)
    out.set(scan.lineId, list)
  }
  return out
}
