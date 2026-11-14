import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { SimulatedOutcome } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import type { CommandTx } from '../../../core/command'
import type { Reader } from '../store'

/**
 * A company's e-invoicing settings as B-W2b-401 reads them (factory-db tax.prisma CompanyEInvoiceSettings, one row per company,
 * id = the company's; no row: test mode, simulated answers DELIVERED, every switch off): test mode, when it went live and who
 * said so, the answer test mode simulates, and the step's switch `selfInvoicesOn` (self-invoices, debit notes, the VAT time
 * limit). B-W2b-392's tax switches live on the same row (tax-codes/store.ts); neither writes the other's columns.
 */

export interface EInvoiceSettings {
  readonly testMode: boolean
  readonly liveSince: Date | null
  readonly liveSetById: string | null
  readonly simulateOutcome: SimulatedOutcome
  readonly selfInvoicesOn: boolean
  /** The row's version, or null while the company has none. */
  readonly version: number | null
}

const COLUMNS = { testMode: true, liveSince: true, liveSetById: true, simulateOutcome: true, selfInvoicesOn: true, version: true } as const satisfies Prisma.CompanyEInvoiceSettingsSelect

export const NO_ROW: EInvoiceSettings = Object.freeze({ testMode: true, liveSince: null, liveSetById: null, simulateOutcome: 'DELIVERED', selfInvoicesOn: false, version: null })

/** A company's settings (no row: the defaults). */
export async function readSettings(db: Reader, companyId: string): Promise<EInvoiceSettings> {
  const row = isUuid(companyId) ? await db.companyEInvoiceSettings.findUnique({ where: { id: companyId }, select: COLUMNS }) : null
  return row ?? NO_ROW
}

/**
 * Inside a command: the company's settings, the row held FOR SHARE until the commit (a switch or test mode changed meanwhile
 * waits for this command), so what the command read is what the database's guards read.
 */
export async function lockSettings(tx: CommandTx, companyId: string): Promise<EInvoiceSettings> {
  const rows = await tx.$queryRaw<{ testMode: boolean; liveSince: Date | null; liveSetById: string | null; simulateOutcome: SimulatedOutcome; selfInvoicesOn: boolean; version: number }[]>`
    SELECT "testMode", "liveSince", "liveSetById", "simulateOutcome"::text AS "simulateOutcome", "selfInvoicesOn", "version" FROM "CompanyEInvoiceSettings" WHERE "id" = ${companyId}::uuid FOR SHARE`
  return rows[0] ?? NO_ROW
}

/** The company's SDI connections that are not disabled (sdi/store.ts sdiAccountOf picks the one; here every one, for words). */
export async function connectionsOf(db: Reader, companyId: string): Promise<{ id: string; label: string; mode: string; status: string }[]> {
  return db.integrationAccount.findMany({ where: { provider: 'SDI', companyId, status: { not: 'DISABLED' } }, select: { id: true, label: true, mode: true, status: true }, orderBy: { id: 'asc' } })
}

export const instantOf = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
