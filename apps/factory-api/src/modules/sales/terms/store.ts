import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PAYMENT_TERMS_VIEW } from '@nexus/factory-domain/sales/terms/permissions'
import { DEPOSIT_DUE_DAYS } from '@nexus/factory-domain/sales/quotes/terms'
import { depositDueDaysOf, depositOf, instalmentsOf, termsSummary, type Instalment } from '@nexus/factory-domain/sales/terms/terms'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { officeContextOf, type Reader } from '../quotes/store'

/**
 * The payment terms library's reads (factory-db pricing.prisma PaymentTerms): the columns every read names, who may see
 * and change an entry (office only; can() on its company: terms of every company are seen with any grant that holds the
 * permission and changed only by a grant over every company), and the entry as the screens and the other modules read
 * it (its instalments typed, its words in Italian and English, the deposit it asks on the order).
 */

export const TERMS_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  method: true,
  instalments: true,
  earlyPaymentDiscountPct: true,
  earlyPaymentDays: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentTermsSelect
export type TermsRow = Prisma.PaymentTermsGetPayload<{ select: typeof TERMS_COLUMNS }>

/** The scope columns of the library: a company's own terms, or every company's (no company). */
export const TERMS_SCOPE = { company: { field: 'companyId', nullable: true } } as const

export const mayOnTerms = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => can(actorOf(context), permission, companyId === null ? {} : { companyId })

/** The terms the caller may see (else 404). */
export async function readTermsFor(caller: CommandCaller, termsId: string): Promise<TermsRow> {
  const context = officeContextOf(caller)
  const row = isUuid(termsId) ? await caller.withClient((client) => client.paymentTerms.findUnique({ where: { id: termsId }, select: TERMS_COLUMNS })) : null
  if (!row || !mayOnTerms(context, PAYMENT_TERMS_VIEW, row.companyId)) throw new NotFoundError('Payment terms not found.')
  return row
}

/** The caller may change terms of this company (every company: a grant over every company), else 403. */
export function assertMayChangeTerms(context: OfficeContext, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) throw new ForbiddenError(companyId === null ? 'Payment terms of every company are changed only by a role over every company.' : undefined)
}

/** The terms as their rules read them. */
export interface TermsFacts {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly nameI18n: unknown
  readonly method: string
  readonly instalments: Instalment[]
  readonly earlyPaymentDiscountPct: string | null
  readonly earlyPaymentDays: number | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

export const termsFactsOf = (row: TermsRow): TermsFacts => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  nameI18n: row.nameI18n,
  method: row.method,
  instalments: instalmentsOf(row.instalments),
  earlyPaymentDiscountPct: row.earlyPaymentDiscountPct === null ? null : decimalText(row.earlyPaymentDiscountPct.toString()),
  earlyPaymentDays: row.earlyPaymentDays,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
})

/** One entry as the library's screen and the pick lists read it. */
export function termsViewOf(row: TermsRow, customers: number) {
  const facts = termsFactsOf(row)
  const texts = row.nameI18n !== null && typeof row.nameI18n === 'object' && !Array.isArray(row.nameI18n) ? (row.nameI18n as Record<string, string>) : null
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: texts,
    method: facts.method,
    instalments: facts.instalments.map((item) => ({ sharePct: decimalText(item.sharePct), from: item.from, days: item.days, endOfMonth: item.endOfMonth })),
    earlyPaymentDiscountPct: facts.earlyPaymentDiscountPct,
    earlyPaymentDays: facts.earlyPaymentDays,
    /** The deposit the terms ask on the order (its share and due days after acceptance); null: none. */
    deposit: depositOf(facts.instalments),
    summary: { it: termsSummary(facts, 'it'), en: termsSummary(facts, 'en') },
    status: facts.status,
    /** How many customers have them as their default terms. */
    customers,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type TermsView = ReturnType<typeof termsViewOf>

/** How many parties have each of these terms as their default. */
export async function customersOf(db: Reader, termsIds: readonly string[]): Promise<Map<string, number>> {
  if (termsIds.length === 0) return new Map()
  const rows = await db.party.groupBy({ by: ['paymentTermsId'], where: { paymentTermsId: { in: [...termsIds] } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.paymentTermsId!, row._count._all]))
}

/**
 * The terms a quote or an order of `companyId` may take: ACTIVE, of every company or of that company. Returns the facts,
 * or null (none, archived, another company's, not visible).
 */
export async function usableTerms(db: Reader, termsId: string | null, companyId: string): Promise<TermsFacts | null> {
  if (termsId === null || !isUuid(termsId)) return null
  const row = await db.paymentTerms.findUnique({ where: { id: termsId }, select: TERMS_COLUMNS })
  if (!row || row.status !== 'ACTIVE' || (row.companyId !== null && row.companyId !== companyId)) return null
  return termsFactsOf(row)
}

/**
 * The days a quote version's deposit is due after its acceptance: its payment terms' order instalment, else
 * DEPOSIT_DUE_DAYS (no terms, or terms without one). Terms in use keep their rules (./terms.ts updateTerms), so the
 * clause the PDF printed and the request made at acceptance read the same days.
 */
export async function depositDueDaysFor(db: Reader, paymentTermsId: string | null): Promise<number> {
  if (paymentTermsId === null) return DEPOSIT_DUE_DAYS
  const row = await db.paymentTerms.findUnique({ where: { id: paymentTermsId }, select: { instalments: true } })
  return depositDueDaysOf(row ? instalmentsOf(row.instalments) : null, DEPOSIT_DUE_DAYS)
}

/** How many quote versions and sales orders were made with these terms (their rules are then fixed). */
export async function termsUse(db: Reader, termsId: string): Promise<{ quoteVersions: number; orders: number }> {
  const [quoteVersions, orders] = [await db.quoteVersion.count({ where: { paymentTermsId: termsId } }), await db.salesOrder.count({ where: { paymentTermsId: termsId } })]
  return { quoteVersions, orders }
}
