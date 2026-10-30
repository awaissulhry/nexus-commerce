import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { serverClock, type Clock } from '../../core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import type { Period } from '@nexus/factory-domain/accounting/periods'

/**
 * What the accounting module reads and writes of its own tables (B-W2a-39; accounting.prisma: AccountingExport,
 * AccountingExportFile, PeriodLock), who may, and its commands' clock. Every read names its columns; row-level security
 * keeps the tenant; can() keeps a person to the companies their grants reach (an export or a lock belongs to its
 * company: one the caller may not see is not found).
 */

export type Reader = FactoryClient | CommandTx

let clock: Clock = serverClock
/** Test only: the clock of the accounting commands and checks (default the server clock). */
export function useAccountingClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const accountingClock = (): Clock => clock

/** Exporting a month writes every file row and reads the period again: its command may take longer. */
const LONG_COMMAND_MS = 60_000

export function accountingCommand<Result>(caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>, long = false) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock, ...(long ? { timeoutMs: LONG_COMMAND_MS, maxWaitMs: 10_000 } : {}) })
}

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const grainsOf = (context: OfficeContext): ReadonlySet<Grain> => heldGrains(actorOf(context))

export const COMPANY_SELECT = { id: true, code: true, legalName: true, fiscalYearStartMonth: true, currency: true } as const
export interface CompanyRow {
  readonly id: string
  readonly code: string
  readonly legalName: string
  readonly fiscalYearStartMonth: number
  readonly currency: string
}
export const companyRef = (company: Pick<CompanyRow, 'id' | 'code' | 'legalName'>) => ({ id: company.id, code: company.code, name: company.legalName })

/** The company the caller works on with this permission (one it may not see is not found; one its grants miss, 403). */
export async function companyFor(caller: CommandCaller, companyId: string, permission: Permission): Promise<CompanyRow> {
  const context = officeOf(caller)
  if (!isUuid(companyId)) throw new NotFoundError('Company not found.')
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: COMPANY_SELECT }))
  if (!company) throw new NotFoundError('Company not found.')
  if (!can(actorOf(context), permission, { companyId })) throw new ForbiddenError()
  return company
}

/** A Prisma @db.Date value of a business day. */
export const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
/** A @db.Date value as its business day. */
export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

export const FILE_SELECT = { id: true, seq: true, package: true, format: true, rowCount: true, file: { select: { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true } } } as const

export const EXPORT_SELECT = {
  id: true,
  companyId: true,
  numberSeriesId: true,
  number: true,
  periodStart: true,
  periodEnd: true,
  packages: true,
  layout: true,
  supersedesId: true,
  status: true,
  checks: true,
  manifest: true,
  exportedAt: true,
  exportedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
  company: { select: { id: true, code: true, legalName: true, fiscalYearStartMonth: true, currency: true } },
  files: { select: FILE_SELECT, orderBy: { seq: 'asc' } },
} as const satisfies Prisma.AccountingExportSelect

export type ExportRow = Prisma.AccountingExportGetPayload<{ select: typeof EXPORT_SELECT }>

/** Every export of a company's period, oldest first. */
export async function periodExports(db: Reader, companyId: string, period: Period): Promise<ExportRow[]> {
  return db.accountingExport.findMany({
    where: { companyId, periodStart: dateOf(period.start), periodEnd: dateOf(period.end) },
    select: EXPORT_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** The exported batches of a period in the order they were made (what the accountant holds, folded). */
export const exportedInOrder = (rows: readonly ExportRow[]): ExportRow[] =>
  rows.filter((row) => row.status === 'EXPORTED').sort((a, b) => a.exportedAt!.getTime() - b.exportedAt!.getTime() || a.id.localeCompare(b.id))

/** The latest exported batch of a period (a re-export amends it), or null. */
export const latestExported = (rows: readonly ExportRow[]): ExportRow | null => exportedInOrder(rows).at(-1) ?? null

export const LOCK_SELECT = {
  id: true,
  companyId: true,
  periodStart: true,
  periodEnd: true,
  level: true,
  status: true,
  exportId: true,
  lockedAt: true,
  lockedById: true,
  note: true,
  unlockedAt: true,
  unlockedById: true,
  unlockReason: true,
  version: true,
  export: { select: { id: true, number: true, status: true } },
} as const satisfies Prisma.PeriodLockSelect

export type LockRow = Prisma.PeriodLockGetPayload<{ select: typeof LOCK_SELECT }>

/** The lock row of exactly this month, or null. */
export async function lockOfPeriod(db: Reader, companyId: string, period: Period): Promise<LockRow | null> {
  return db.periodLock.findFirst({ where: { companyId, periodStart: dateOf(period.start), periodEnd: dateOf(period.end) }, select: LOCK_SELECT })
}

/** The LOCKED locks of a company that share a day with the period (a lock of several months included). */
export async function liveLocksOver(db: Reader, companyId: string, period: Period): Promise<LockRow[]> {
  return db.periodLock.findMany({ where: { companyId, status: 'LOCKED', periodStart: { lte: dateOf(period.end) }, periodEnd: { gte: dateOf(period.start) } }, select: LOCK_SELECT })
}

/** Office people's names (an export's or a lock's maker; never a floor worker). */
export async function peopleNames(db: Reader, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((value): value is string => typeof value === 'string' && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** One advisory lock per company and period: two exports of one month never run their commands at once. */
export async function lockPeriodExports(tx: CommandTx, companyId: string, period: Period): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.accounting-export', current_setting('factory.tenant_id', true), ${companyId}::text, ${period.start}::text), 0))`
}
