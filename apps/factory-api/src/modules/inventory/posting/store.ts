import type { FactoryClient } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { postingDateProblem, rulesInForce, type RulesInForce, type SettingsRow } from '@nexus/factory-domain/inventory/posting/rules'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * The warehouse rules as they are read everywhere (B-W2b-314): InventorySettings, the company's row (id = the company's)
 * and the tenant-wide row (id = the tenant's, companyId null), each rule the company's own value, else the tenant-wide
 * one, else its default (factory-domain inventory/posting/rules `rulesInForce`, the database's own reading).
 *
 *   rulesOf(db, tenantId, companyId)          the rows and what is in force
 *   honourPostingDate(tools, moves, day)      postMoves' check of an office post's posting date (B-W2b-314, SCM-196):
 *                                             in words before the database's own trigger refuses it (a 400 at the
 *                                             caller's path), one read of the rules per company
 */

export type Db = FactoryClient | CommandTx

export const SETTINGS_COLUMNS = {
  id: true,
  companyId: true,
  backDatingDays: true,
  adjustmentApprovalAmount: true,
  lowStockAlerts: true,
  receiverNotMatcher: true,
  counterNotApprover: true,
  version: true,
  updatedAt: true,
  updatedById: true,
} as const

export interface SettingsRecord extends SettingsRow {
  readonly id: string
  readonly companyId: string | null
  readonly receiverNotMatcher: boolean | null
  readonly counterNotApprover: boolean | null
  readonly version: number
  readonly updatedAt: Date
  readonly updatedById: string | null
}

export interface Rows {
  readonly company: SettingsRecord | null
  readonly tenant: SettingsRecord | null
}

/** The company's row and the tenant-wide one (companyId null: the tenant-wide row only). */
export async function rowsOf(db: Db, tenantId: string, companyId: string | null): Promise<Rows> {
  const rows = (await db.inventorySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: SETTINGS_COLUMNS })) as SettingsRecord[]
  return { company: companyId === null ? null : (rows.find((row) => row.id === companyId) ?? null), tenant: rows.find((row) => row.id === tenantId) ?? null }
}

/** What is in force for the scope (a company: its row and the tenant-wide one; null: the tenant-wide row alone). */
export const inForceOf = (companyId: string | null, rows: Rows): RulesInForce => rulesInForce(companyId === null ? undefined : rows.company, rows.tenant)

export async function rulesOf(db: Db, tenantId: string, companyId: string | null): Promise<{ readonly rows: Rows; readonly inForce: RulesInForce }> {
  const rows = await rowsOf(db, tenantId, companyId)
  return { rows, inForce: inForceOf(companyId, rows) }
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : undefined
  if (!tenantId) throw new Error('inventory rules: a command outside a tenant')
  return tenantId
}

/**
 * An office (or system) post's posting date, checked against each company's back-dating limit in words (SCM-196): not after
 * the day it is entered, not further back than the limit. The floor never sends one (its moves count on the day entered).
 * The period lock over the day is postMoves' (honourPeriodLocks reads the posting day).
 */
export async function honourPostingDate(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, moves: readonly { readonly companyId: string }[], day: BusinessDate, path: string): Promise<void> {
  const today = businessDate(tools.now)
  if (tools.context.audience === 'floor') {
    throw new ValidationError('A move from the floor counts on the day it is entered.', [{ path, message: postingDateProblem({ day, today, backDatingDays: null, floor: true }) ?? 'A move from the floor counts on the day it is entered.' }])
  }
  const tenantId = tenantOf(tools)
  for (const companyId of [...new Set(moves.map((move) => move.companyId))]) {
    const { inForce } = await rulesOf(tools.tx, tenantId, companyId)
    const problem = postingDateProblem({ day, today, backDatingDays: inForce.backDatingDays.value })
    if (problem) throw new ValidationError(problem, [{ path, message: problem }])
  }
}

/** The posting date as the column keeps it (a calendar day at UTC midnight). */
export const postingDateColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

/** A posting date column read back as its day. */
export const postingDayText = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
