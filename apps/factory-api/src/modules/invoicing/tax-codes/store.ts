import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ALL_OFF, type TaxSwitches } from '@nexus/factory-domain/invoicing/tax-codes/switches'
import type { TaxCodeFacts } from '@nexus/factory-domain/invoicing/tax-codes/tax-codes'
import { actorOf, type OfficeContext } from '../../../core/context'
import type { Reader } from '../store'

/**
 * Tax rules as data, what the three parts share (B-W2b-392; modules/invoicing/{tax-codes,intent,stamp-duty}): who may act
 * on a company's tax rows (can() on the company; a declaration also on its customer), the company's tax switches
 * (CompanyEInvoiceSettings, read FOR SHARE inside a command so a switch never changes under it), the codes as the domain
 * reads them, and the database's refusals of these tables in words (409 `refusal/<CODE>`, never a 500).
 */

/** The caller may see the company's tax rows (`see`, else 404) and do `permission` there (else 403). */
export function assertCompany(context: OfficeContext, see: Permission, permission: Permission, scope: { readonly companyId: string; readonly partyId?: string } | null, what: string): asserts scope is { readonly companyId: string; readonly partyId?: string } {
  if (!scope || !can(actorOf(context), see, scope)) throw new NotFoundError(`${what} not found.`)
  if (!can(actorOf(context), permission, scope)) throw new ForbiddenError()
}

export interface SwitchesRow extends TaxSwitches {
  /** The settings row's version, or null when the company has none yet (every switch off). */
  readonly version: number | null
  readonly selfInvoicesOn: boolean
}

const SWITCH_COLUMNS = { taxCodesOn: true, stampDutyOn: true, declarationsOfIntentOn: true, selfInvoicesOn: true, version: true } as const satisfies Prisma.CompanyEInvoiceSettingsSelect

/** A company's tax switches (no row: all off). */
export async function readSwitches(db: Reader, companyId: string): Promise<SwitchesRow> {
  const row = isUuid(companyId) ? await db.companyEInvoiceSettings.findUnique({ where: { id: companyId }, select: SWITCH_COLUMNS }) : null
  return row ?? { ...ALL_OFF, selfInvoicesOn: false, version: null }
}

/**
 * Inside a command: the company's tax switches, the row held FOR SHARE until the commit, so the switch the command read
 * is the one the …_tax_currency_w2b_guards read (a switch changed meanwhile waits for this command).
 */
export async function lockSwitches(tx: Prisma.TransactionClient, companyId: string): Promise<SwitchesRow> {
  const rows = await tx.$queryRaw<{ taxCodesOn: boolean; stampDutyOn: boolean; declarationsOfIntentOn: boolean; selfInvoicesOn: boolean; version: number }[]>`
    SELECT "taxCodesOn", "stampDutyOn", "declarationsOfIntentOn", "selfInvoicesOn", "version" FROM "CompanyEInvoiceSettings" WHERE "id" = ${companyId}::uuid FOR SHARE`
  return rows[0] ?? { ...ALL_OFF, selfInvoicesOn: false, version: null }
}

export const TAX_CODE_COLUMNS = {
  id: true,
  companyId: true,
  country: true,
  code: true,
  label: true,
  ratePct: true,
  natura: true,
  legalRef: true,
  accountCodeKey: true,
  ruleId: true,
  verification: true,
  confirmedAt: true,
  confirmedById: true,
  validFrom: true,
  validTo: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TaxCodeSelect
export type TaxCodeRow = Prisma.TaxCodeGetPayload<{ select: typeof TAX_CODE_COLUMNS }>

export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)
export const dayValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

/** A row as the domain reads it. */
export const codeFactsOf = (row: TaxCodeRow): TaxCodeFacts => ({
  id: row.id,
  companyId: row.companyId,
  country: row.country,
  code: row.code,
  label: row.label,
  ratePct: row.ratePct.toFixed(2),
  natura: row.natura,
  legalRef: row.legalRef,
  accountCodeKey: row.accountCodeKey,
  ruleId: row.ruleId,
  verification: row.verification,
  confirmedAt: row.confirmedAt ? toUtcIso(row.confirmedAt) : null,
  validFrom: dayOf(row.validFrom),
  validTo: row.validTo ? dayOf(row.validTo) : null,
  status: row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
})

/** A company's code versions (every country), oldest first per code. */
export async function readCodes(db: Reader, companyId: string): Promise<TaxCodeRow[]> {
  return db.taxCode.findMany({ where: { companyId }, select: TAX_CODE_COLUMNS, orderBy: [{ country: 'asc' }, { code: 'asc' }, { validFrom: 'asc' }, { id: 'asc' }] })
}

// ---- refusals in words --------------------------------------------------------------------------------------------------

export const TAX_REFUSALS = [
  'DATABASE',
  'PROTOCOL_LIVE',
  'SWITCH_OFF',
  'IN_FORCE',
  'OVERLAP',
  'NOT_PLANNED',
  'NEXT_VERSION',
  'CONFIRMED',
  'ARCHIVED',
  'REVOKED',
  'CHECKED',
  'RECEIPT',
  'DECLARATION',
  'QUARTER_OPEN',
  'QUARTER_PAID',
  'NOT_CUSTOMER',
] as const
export type TaxRefusal = (typeof TAX_REFUSALS)[number]

/** The issue's 409 with every problem (issue.ts refusal's words), for a check run again inside the issue command. */
export function issueRefusal(problems: readonly { readonly code: string; readonly path: string; readonly message: string }[]): DomainError {
  const first = problems[0]!
  return new DomainError('conflict', problems.length === 1 ? first.message : `This invoice cannot be issued yet: ${problems.length} things to fix. ${first.message}`, problems.map((problem) => ({ path: problem.path, message: problem.message })))
}

/** A 409 with its code (`refusal/<CODE>`) and words. */
export const refused = (code: TaxRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

const causeOf = (error: unknown) => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause

/**
 * The database's own refusal of a tax row, a declaration on an invoice or a stamp duty line (…_tax_currency_w2b_guards:
 * check_violation 'tax: …' or 'invoicing: …'; the partial uniques), as a 409 in words; null for anything else.
 */
export function taxRefusal(error: unknown): DomainError | null {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (cause?.originalCode === '23514') {
    const prefix = ['tax: ', 'invoicing: '].find((one) => message.startsWith(one))
    if (prefix) {
      const words = message.slice(prefix.length)
      return refused('DATABASE', `${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
    }
  }
  const code = (error as { code?: unknown } | null)?.code
  const target = String((error as { meta?: { target?: unknown } } | null)?.meta?.target ?? '')
  if (cause?.originalCode === '23505' || code === 'P2002') {
    if (/DeclarationOfIntent_one_live/.test(message) || /DeclarationOfIntent_one_live|protocolNumber/.test(target)) {
      return refused('PROTOCOL_LIVE', 'A declaration of intent with this protocol is recorded already: open it, or revoke it before recording it again.')
    }
    if (/InvoiceLine_one_stamp_duty/.test(message) || /InvoiceLine_one_stamp_duty/.test(target)) return refused('DATABASE', 'An invoice charges its stamp duty once.')
    if (/StampDutyQuarter/.test(message) || /quarterStart/.test(target)) return refused('DATABASE', 'This quarter was counted at the same moment by another request: read it again.')
    if (/CompanyEInvoiceSettings/.test(message) || /CompanyEInvoiceSettings/.test(target)) return refused('DATABASE', "The company's tax switches were set at the same moment by another request: read them again.")
  }
  return null
}

/** Runs a write and turns the database's tax refusals into 409s in words. */
export async function refusingInWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw taxRefusal(error) ?? error
  }
}
