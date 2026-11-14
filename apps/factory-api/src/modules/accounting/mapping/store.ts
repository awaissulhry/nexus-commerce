import type { Prisma } from '@nexus/factory-db'
import type { MappingKind, MappingRow, TaxCodeFacts } from '@nexus/factory-domain/accounting/mapping/keys'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { dayOf, type Reader } from '../store'

/**
 * What the accountant's bridge reads of its own tables (B-W2b-408; factory-db bank.prisma AccountMapping,
 * AccountingSettings; tax.prisma TaxCode): a company's mapping rows, its journals switch (its own row, else the
 * tenant-wide row, else off) and its sales tax codes (the TAX_CODE keys). Row-level security keeps the tenant; the
 * callers check the company with can().
 */

export const MAPPING_SELECT = { id: true, companyId: true, kind: true, key: true, accountCode: true, validFrom: true, note: true, version: true, createdAt: true, createdById: true } as const satisfies Prisma.AccountMappingSelect
export type MappingDbRow = Prisma.AccountMappingGetPayload<{ select: typeof MAPPING_SELECT }>

export interface StoredMapping extends MappingRow {
  readonly note: string | null
  readonly version: number
  readonly createdAt: Date
  readonly createdById: string | null
}

export const storedOf = (row: MappingDbRow): StoredMapping => ({
  id: row.id,
  kind: row.kind as MappingKind,
  key: row.key,
  accountCode: row.accountCode,
  validFrom: dayOf(row.validFrom),
  note: row.note,
  version: row.version,
  createdAt: row.createdAt,
  createdById: row.createdById,
})

/** Every mapping row of a company, by kind, key and first day. */
export async function mappingRowsOf(db: Reader, companyId: string): Promise<StoredMapping[]> {
  const rows = await db.accountMapping.findMany({ where: { companyId }, select: MAPPING_SELECT, orderBy: [{ kind: 'asc' }, { key: 'asc' }, { validFrom: 'asc' }] })
  return rows.map(storedOf)
}

export const SETTINGS_SELECT = { id: true, companyId: true, journalsOn: true, version: true } as const satisfies Prisma.AccountingSettingsSelect
export type SettingsRow = Prisma.AccountingSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>

export interface JournalsSettings {
  readonly own: SettingsRow | null
  readonly journalsOn: boolean
  readonly from: 'COMPANY' | 'TENANT' | 'DEFAULT'
}

/** The company's journals switch in force: its own row, else the tenant-wide row, else off. */
export async function journalsSettingsOf(db: Reader, companyId: string): Promise<JournalsSettings> {
  const rows = await db.accountingSettings.findMany({ where: { OR: [{ companyId }, { companyId: null }] }, select: SETTINGS_SELECT })
  const own = rows.find((row) => row.companyId === companyId) ?? null
  const tenant = rows.find((row) => row.companyId === null) ?? null
  return { own, journalsOn: (own ?? tenant)?.journalsOn ?? false, from: own ? 'COMPANY' : tenant ? 'TENANT' : 'DEFAULT' }
}

/** The company's tax codes as the TAX_CODE keys read them (archived versions left out). */
export async function taxCodesOf(db: Reader, companyId: string): Promise<TaxCodeFacts[]> {
  const rows = await db.taxCode.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: { code: true, label: true, ratePct: true, natura: true, accountCodeKey: true, validFrom: true, validTo: true },
    orderBy: [{ code: 'asc' }, { validFrom: 'asc' }],
  })
  return rows.map((row) => ({ code: row.code, label: row.label, ratePct: row.ratePct.toFixed(2), natura: row.natura, accountCodeKey: row.accountCodeKey, validFrom: dayOf(row.validFrom), validTo: row.validTo ? dayOf(row.validTo) : null }))
}

/**
 * A refusal of the bridge's tables by the database (…_bank_bridge_w2b_guards: check_violation 'accounting: …'; a second
 * row of a key on one day: the unique key, 23505) in words, as a 409; else the error unchanged.
 */
export function bridgeRefusal(error: unknown): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } }; code?: unknown } | null)?.meta?.driverAdapterError?.cause
  const prismaCode = (error as { code?: unknown } | null)?.code
  if (prismaCode === 'P2002' || cause?.originalCode === '23505') {
    const message = 'This key has a row from that day already: change that row (before its day) or pick another day.'
    return new DomainError('conflict', message, [{ path: 'problem/SAME_DAY', message }])
  }
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string' || !cause.originalMessage.startsWith('accounting: ')) return error
  const words = cause.originalMessage.slice('accounting: '.length)
  const message = `${words.charAt(0).toUpperCase()}${words.slice(1)}${words.endsWith('.') ? '' : '.'}`
  return new DomainError('conflict', message, [{ path: 'problem/DATABASE', message }])
}
