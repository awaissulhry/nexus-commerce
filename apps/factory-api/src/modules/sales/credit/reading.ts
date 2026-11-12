import type { FactoryClient } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addToAgeing, emptyAgeing } from '@nexus/factory-domain/receivables/ledger'
import { OPEN_ORDER_STATUSES, usedPercent, type CreditReading } from '@nexus/factory-domain/sales/credit/credit'
import type { CommandTx } from '../../../core/command'
import { holdsInForce } from '../../parties/holds/holds'
import { companyTermsRow } from '../../parties/company-terms/in-force'
import { openInvoices } from '../../receivables/store'

/**
 * What a customer's credit with a company stands at (B-W2b-304; SAL-237): the reading a check writes and the screens show.
 * Office or system scope (the partner and the floor read none of these tables).
 *
 *   limit          the live PartyCompanyTerms row of (party, company): creditLimitAmount in creditLimitCurrency; none →
 *                  no limit, so no check (`limitOf` null)
 *   open orders    the customer's orders with the company, in the limit's currency, still open (waiting for a yes,
 *                  confirmed, in production, ready, partly or wholly shipped): what is not invoiced yet of each, i.e. its
 *                  gross amount less its lines already on an issued TD01/TD24 invoice (each line's gross, else its net
 *                  with VAT) less the deposits paid on it (a paid acconto is money in; the final invoice deducts it);
 *                  never below 0. An order being made is left out here and counted as the check's subject.
 *   open invoices  receivables' own reading (modules/receivables/store.ts openInvoices: the issued TD01/TD24 less credit
 *                  notes and allocations), in the limit's currency, as of today; the overdue part = the instalments past
 *                  their due date (receivables/ledger addToAgeing)
 *   on hold        a CREDIT PartyHold in force for the company (B-W2b-290; of the company or of every company)
 *
 * Amounts in another currency than the limit's are left out (a customer billed in two currencies is checked in its
 * limit's): a named gap.
 */

export type Reader = FactoryClient | CommandTx

export interface Limit {
  readonly termsId: string
  readonly amount: number
  readonly currency: string
  readonly version: number
}

/** The credit limit in force for the party with the company, or null (none set: no check). */
export async function limitOf(db: Reader, partyId: string, companyId: string): Promise<Limit | null> {
  const row = await companyTermsRow(db, partyId, companyId)
  if (!row || row.creditLimitAmount === null || row.creditLimitCurrency === null) return null
  return { termsId: row.id, amount: row.creditLimitAmount, currency: row.creditLimitCurrency, version: row.version }
}

/** A CREDIT hold in force for the party with the company (of the company or of every company). */
export async function creditHoldInForce(db: Reader, partyId: string, companyId: string): Promise<boolean> {
  return (await holdsInForce(db, partyId, companyId)).some((hold) => hold.reason === 'CREDIT')
}

/** What is not invoiced yet of the customer's open orders with the company, in the currency (orders left out: `exclude`). */
export async function openOrdersAmount(db: Reader, input: { readonly partyId: string; readonly companyId: string; readonly currency: string; readonly exclude?: readonly string[] }): Promise<number> {
  const exclude = [...(input.exclude ?? [])]
  const rows = await db.$queryRaw<{ id: string; gross: number; invoiced: bigint | null; deposits: bigint | null }[]>`
    SELECT o.id, o."grossAmount" AS gross,
           (SELECT sum(coalesce(l."grossAmount", round(l."netAmount" * (1 + l."vatRatePct" / 100))::int))
              FROM "InvoiceLine" l
              JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i.id = l."invoiceId"
              JOIN "SalesOrderLine" sl ON sl."tenantId" = l."tenantId" AND sl.id = l."salesOrderLineId"
             WHERE sl."orderId" = o.id AND i."docType" IN ('TD01', 'TD24') AND i.status <> 'DRAFT') AS invoiced,
           (SELECT sum(d.amount) FROM "DepositRequest" d WHERE d."tenantId" = o."tenantId" AND d."orderId" = o.id AND d.status = 'PAID') AS deposits
      FROM "SalesOrder" o
     WHERE o."partyId" = ${input.partyId}::uuid AND o."companyId" = ${input.companyId}::uuid AND o.currency = ${input.currency}
       AND o.status::text = ANY(${[...OPEN_ORDER_STATUSES]}::text[])
       AND NOT (o.id = ANY(${exclude}::uuid[]))
     ORDER BY o.id`
  return rows.reduce((sum, row) => sum + Math.max(0, row.gross - Number(row.invoiced ?? 0n) - Number(row.deposits ?? 0n)), 0)
}

/** The customer's invoices not yet paid with the company, in the currency, and their overdue part, as of a day. */
export async function openInvoicesAmount(db: Reader, input: { readonly partyId: string; readonly companyId: string; readonly currency: string; readonly asOf: string }): Promise<{ open: number; overdue: number }> {
  const rows = (await openInvoices(db, { companyId: input.companyId, partyId: input.partyId, asOf: input.asOf })).filter((row) => row.currency === input.currency)
  const totals = emptyAgeing()
  for (const row of rows) addToAgeing(totals, row.instalments, input.asOf)
  return { open: totals.open, overdue: Math.min(totals.overdue, totals.open) }
}

export interface ReadingInput {
  readonly partyId: string
  readonly companyId: string
  /** What is checked when it is not counted yet (a quote being sent, an order being made): minor units of the limit's currency. */
  readonly subject?: number
  /** Orders not counted as open orders (the order being made: it is the subject). */
  readonly exclude?: readonly string[]
  readonly now: Date
}

/** The amounts of a customer's credit with a company in one currency, with the limit given (null: none). */
export async function readAmounts(db: Reader, input: ReadingInput & { readonly currency: string; readonly limit: number | null }): Promise<CreditReading> {
  const asOf = businessDate(input.now)
  const orders = await openOrdersAmount(db, { partyId: input.partyId, companyId: input.companyId, currency: input.currency, exclude: input.exclude ?? [] })
  const invoices = await openInvoicesAmount(db, { partyId: input.partyId, companyId: input.companyId, currency: input.currency, asOf })
  const onHold = await creditHoldInForce(db, input.partyId, input.companyId)
  return { currency: input.currency, openOrders: orders, openInvoices: invoices.open, overdue: invoices.overdue, subject: Math.max(0, input.subject ?? 0), limit: input.limit, onHold }
}

/** The reading of a customer's credit with a company now, or null when no limit is set (no check). */
export async function readCredit(db: Reader, input: ReadingInput): Promise<(CreditReading & { readonly limitRow: Limit }) | null> {
  const limit = await limitOf(db, input.partyId, input.companyId)
  if (!limit) return null
  return { ...(await readAmounts(db, { ...input, currency: limit.currency, limit: limit.amount })), limitRow: limit }
}

/**
 * The share of the limit used (whole percent) per company × customer × currency, for the receivables ageing's "credit limit
 * used" (design finance.receivables sec:ageing, B-W2b-304); a key without a limit in that currency is left out.
 */
export async function creditUsedFor(db: Reader, keys: readonly { readonly companyId: string; readonly partyId: string; readonly currency: string }[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (keys.length === 0) return out
  const terms = await db.partyCompanyTerms.findMany({
    where: { endedAt: null, creditLimitAmount: { not: null }, partyId: { in: [...new Set(keys.map((key) => key.partyId))] }, companyId: { in: [...new Set(keys.map((key) => key.companyId))] } },
    select: { partyId: true, companyId: true, creditLimitAmount: true, creditLimitCurrency: true },
  })
  for (const key of keys) {
    const row = terms.find((entry) => entry.partyId === key.partyId && entry.companyId === key.companyId && entry.creditLimitCurrency === key.currency)
    if (!row || row.creditLimitAmount === null) continue
    const reading = await readAmounts(db, { partyId: key.partyId, companyId: key.companyId, currency: key.currency, limit: row.creditLimitAmount, now })
    const pct = usedPercent(reading)
    if (pct !== null) out.set(`${key.companyId}|${key.partyId}|${key.currency}`, pct)
  }
  return out
}
