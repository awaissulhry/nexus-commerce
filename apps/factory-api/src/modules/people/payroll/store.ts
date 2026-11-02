import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { confirmationWords, layoutConfirmed, parseDefinition, type FileContext, type LayoutDefinition, type PayrollFormat } from '@nexus/factory-domain/people/payroll/layouts'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import type { Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { PayrollRefusal } from '@nexus/factory-domain/people/payroll/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { gateClosedError } from '../privacy/gate'
import type { Client } from '../attendance/store'
import { reachesCompany, gatesOf, type Place } from '../close/store'
import { dateOf, dayOf, refuse } from '../employees/access'

/**
 * What the payroll export reads and keeps (B-W2b-54): layouts and exports with their files. Nothing here reads a person: that is
 * ./facts.ts, behind the gate.
 */

/** A payroll rule's refusal: a 409 with `refusal/<CODE>`, in words (the codes are factory-domain people/payroll/rules). */
export const refusePayroll = (code: PayrollRefusal, message: string, field?: string, more: readonly Issue[] = []): never => refuse(code, message, field, more)

export const LAYOUT_SELECT = { id: true, companyId: true, name: true, format: true, provider: true, definition: true, status: true, note: true, updatedAt: true, version: true } as const satisfies Prisma.PayrollExportLayoutSelect
export type LayoutRow = Prisma.PayrollExportLayoutGetPayload<{ select: typeof LAYOUT_SELECT }>

export const EXPORT_SELECT = {
  id: true,
  companyId: true,
  periodStart: true,
  periodEnd: true,
  payPeriodId: true,
  layoutId: true,
  layoutSnapshot: true,
  revision: true,
  correctionOfId: true,
  number: true,
  status: true,
  checks: true,
  values: true,
  exportedAt: true,
  exportedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
  company: { select: { code: true, legalName: true, vatNumber: true } },
  layout: { select: { id: true, name: true } },
  correctionOf: { select: { id: true, number: true, revision: true, values: true } },
  correctedBy: { where: { status: 'EXPORTED' }, select: { id: true } },
  files: { orderBy: { seq: 'asc' }, select: { id: true, seq: true, kind: true, format: true, rowCount: true, fileId: true, file: { select: { originalName: true, contentType: true, sizeBytes: true, sha256: true } } } },
} as const satisfies Prisma.PayrollExportSelect
export type ExportRow = Prisma.PayrollExportGetPayload<{ select: typeof EXPORT_SELECT }>

export const monthOfRow = (row: { readonly periodStart: Date }): string => dayOf(row.periodStart).slice(0, 7)

/** The layout as an export keeps it. */
export interface LayoutUsed {
  readonly format: PayrollFormat
  readonly definition: LayoutDefinition
}

export const layoutUsedOf = (snapshot: unknown): LayoutUsed => {
  const row = (snapshot ?? {}) as { format?: PayrollFormat; definition?: unknown }
  return { format: row.format ?? 'DELIMITED', definition: parseDefinition(row.definition) }
}

export const layoutParts = (row: Pick<LayoutRow, 'provider' | 'definition'>): { readonly provider: string | null; readonly definition: LayoutDefinition } => ({ provider: row.provider, definition: parseDefinition(row.definition) })

/** Confirmed and its words, for a layout row. */
export function layoutState(row: Pick<LayoutRow, 'provider' | 'definition'>): { readonly confirmed: boolean; readonly words: string | null } {
  const parts = layoutParts(row)
  return { confirmed: layoutConfirmed(parts), words: confirmationWords(parts) }
}

export async function layoutOf(db: Client, companyId: string, layoutId: string): Promise<LayoutRow> {
  const row = await db.payrollExportLayout.findFirst({ where: { id: layoutId, companyId }, select: LAYOUT_SELECT })
  if (!row) throw new NotFoundError('Layout not found.')
  return row
}

export function periodDaysOf(month: string): { readonly from: string; readonly to: string } {
  const period = monthPeriod(month)
  if (!period) throw new InvalidStateError('A month is written YYYY-MM.')
  return { from: period.periodStart, to: period.periodEnd }
}

export const contextOfFile = (place: Pick<Place, 'company'>, month: string, revision: number): FileContext => {
  const days = periodDaysOf(month)
  return { companyCode: place.company.code, month, periodStart: days.from, periodEnd: days.to, revision }
}

/** The exports of a company's month, oldest first. */
export const exportsOfMonth = (db: Client, companyId: string, month: string): Promise<ExportRow[]> =>
  db.payrollExport.findMany({ where: { companyId, periodStart: dateOf(periodDaysOf(month).from) }, select: EXPORT_SELECT, orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })

/** The month's file in force: the EXPORTED one of the highest revision. */
export const latestExported = (rows: readonly ExportRow[]): ExportRow | null => rows.filter((row) => row.status === 'EXPORTED').sort((a, b) => b.revision - a.revision)[0] ?? null

/** One maker per company and month at a time (a transaction's lock). */
export async function lockMonthExports(tx: CommandTx, companyId: string, month: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.payroll-export', current_setting('factory.tenant_id', true), ${companyId}::text, ${month}::text), 0))`
}

export const mayDo = (context: OfficeContext, place: Place, permission: Permission): boolean => reachesCompany(context, place, [permission])

/** Every site holding days of the month has its ATTENDANCE gate on: the file names their people's hours, by employee code. */
export async function monthGatesOpen(db: Client, place: Place, month: string): Promise<boolean> {
  const gates = await gatesOf(db, place)
  const days = periodDaysOf(month)
  const off = gates.off.map((site) => site.id)
  const held = off.length === 0 ? 0 : await db.attendanceDay.count({ where: { companyId: place.company.id, siteId: { in: off }, date: { gte: dateOf(days.from), lte: dateOf(days.to) } } })
  return held === 0 && gates.open.length > 0
}

/** Else 409 gate/ATTENDANCE, before anything of a person is read (Statuto dei Lavoratori art. 4 c.2). */
export async function requireMonthGates(db: Client, place: Place, month: string): Promise<void> {
  if (!(await monthGatesOpen(db, place, month))) throw gateClosedError('ATTENDANCE')
}
