import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { priceBasisOf, priceText, discountOf, type DepositKind, type QuoteStatus, type QuoteVersionStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CustomerLine, CustomerQuote, CustomerVat } from '@nexus/factory-domain/sales/quotes/document'
import type { BillToSnapshot, ShipToSnapshot } from '@nexus/factory-domain/sales/quotes/send'
import { quoteTerms } from '@nexus/factory-domain/sales/quotes/terms'
import type { CommandTx } from '../../../core/command'

/**
 * The frozen version as its customer reads it (B-W1-24): the columns a portal or link session may read (factory-db
 * ownership/sales.json: never a cost, a margin, an internal note or who in the office wrote a row), and the one
 * CustomerQuote model (factory-domain sales/quotes/document) the PDF and the link page are both made from. The send
 * builds it in the office scope before it freezes the version; the link page in the party's scope (partner role),
 * with the style and colourway codes read in the tenant's system scope (product tables are not the partner's).
 */

export type Reader = FactoryClient | CommandTx

/** The Quote columns the partner role reads. */
export const CUSTOMER_QUOTE_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  partyId: true,
  contactId: true,
  customerRef: true,
  status: true,
  currentRevision: true,
  version: true,
} as const satisfies Prisma.QuoteSelect
export type CustomerQuoteRow = Prisma.QuoteGetPayload<{ select: typeof CUSTOMER_QUOTE_COLUMNS }>

/** The QuoteVersion columns the partner role reads. */
export const CUSTOMER_VERSION_COLUMNS = {
  id: true,
  quoteId: true,
  partyId: true,
  revision: true,
  status: true,
  currency: true,
  language: true,
  taxMode: true,
  billTo: true,
  shipTo: true,
  validUntil: true,
  firmOffer: true,
  promiseDate: true,
  paymentTerms: true,
  termsText: true,
  termsVersion: true,
  depositPct: true,
  depositKind: true,
  depositAmount: true,
  noWithdrawal: true,
  netAmount: true,
  vatAmount: true,
  grossAmount: true,
  changeNote: true,
  documentSha256: true,
  sentAt: true,
  closedAt: true,
  decisionNote: true,
  createdAt: true,
} as const satisfies Prisma.QuoteVersionSelect
export type CustomerVersionRow = Prisma.QuoteVersionGetPayload<{ select: typeof CUSTOMER_VERSION_COLUMNS }>

/** The QuoteLine columns the partner role reads (prices; never the cost, margin, cost sheet or adjustment reason). */
export const CUSTOMER_LINE_COLUMNS = {
  id: true,
  versionId: true,
  seq: true,
  styleId: true,
  colourwayId: true,
  description: true,
  note: true,
  quantity: true,
  listUnitPrice: true,
  unitPrice: true,
  netAmount: true,
  vatRatePct: true,
  vatNature: true,
  vatAmount: true,
} as const satisfies Prisma.QuoteLineSelect
type CustomerLineRow = Prisma.QuoteLineGetPayload<{ select: typeof CUSTOMER_LINE_COLUMNS }>

export interface CustomerLineRecord extends CustomerLineRow {
  readonly sizes: { readonly size: string; readonly quantity: number; readonly unitPrice: string | null }[]
}

const text = (value: Prisma.Decimal | null): string | null => (value === null ? null : priceText(value.toString()))
export const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))

export async function readCustomerVersions(db: Reader, quoteId: string): Promise<CustomerVersionRow[]> {
  return db.quoteVersion.findMany({ where: { quoteId }, select: CUSTOMER_VERSION_COLUMNS, orderBy: { revision: 'asc' } })
}

/** A version's lines with their size grids (in the order the sizes were stored; the codes say the style's range order). */
export async function readCustomerLines(db: Reader, versionId: string): Promise<CustomerLineRecord[]> {
  const lines = await db.quoteLine.findMany({ where: { versionId }, select: CUSTOMER_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  if (lines.length === 0) return []
  const sizes = await db.quoteLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } })
  return lines.map((line) => ({ ...line, sizes: sizes.filter((row) => row.lineId === line.id).map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: text(row.unitPrice) })) }))
}

/** The style and colourway codes of the lines, and each style's size range (office or system scope: product tables). */
export async function lineLabels(db: Reader, lines: readonly Pick<CustomerLineRecord, 'styleId' | 'colourwayId'>[]): Promise<{ code: (line: Pick<CustomerLineRecord, 'styleId' | 'colourwayId'>) => string; range: (styleId: string) => readonly string[] }> {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, sizes: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return {
    code: (line) => [styles.get(line.styleId)?.code, colourways.get(line.colourwayId)].filter(Boolean).join(' '),
    range: (styleId) => styles.get(styleId)?.sizes ?? [],
  }
}

const languageOf = (value: string): DocumentLanguage => (value === 'en' ? 'en' : 'it')

export interface CustomerQuoteInput {
  readonly quote: Pick<CustomerQuoteRow, 'number' | 'customerRef'>
  readonly version: Pick<
    CustomerVersionRow,
    'revision' | 'currency' | 'language' | 'taxMode' | 'validUntil' | 'firmOffer' | 'promiseDate' | 'paymentTerms' | 'termsText' | 'termsVersion' | 'depositPct' | 'depositKind' | 'depositAmount' | 'noWithdrawal' | 'netAmount' | 'vatAmount' | 'grossAmount'
  >
  readonly lines: readonly CustomerLineRecord[]
  readonly labels: Awaited<ReturnType<typeof lineLabels>>
  readonly billTo: BillToSnapshot
  readonly shipTo: ShipToSnapshot
  readonly contact: { readonly name: string; readonly email: string | null } | null
  /** The day it was (or is being) sent. */
  readonly date: string
  /** B-W2a-19: the days the deposit is due after acceptance (its payment terms' order instalment); default 7. */
  readonly depositDueDays?: number | undefined
}

/**
 * The CustomerQuote of a version from its rows: prices on the version's basis, the size grids in the style's range
 * order, the VAT of the version per treatment (one party: one treatment), the deposit and the terms.
 */
export function customerQuoteOf(input: CustomerQuoteInput): CustomerQuote {
  const { version } = input
  const language = languageOf(version.language)
  const lines: CustomerLine[] = input.lines.map((line) => {
    const range = input.labels.range(line.styleId)
    const unitPrice = text(line.unitPrice)!
    const listUnitPrice = text(line.listUnitPrice)
    const sizes = [...line.sizes].sort((a, b) => range.indexOf(a.size) - range.indexOf(b.size))
    return {
      seq: line.seq,
      code: input.labels.code(line),
      description: line.description ?? input.labels.code(line),
      note: line.note,
      quantity: line.quantity,
      unitPrice,
      listUnitPrice,
      discountPct: discountOf({ unitPrice, listUnitPrice, sizes }),
      netAmount: line.netAmount,
      vatAmount: line.vatAmount,
      vatRatePct: line.vatRatePct.toFixed(2),
      vatNature: line.vatNature,
      sizes,
    }
  })
  const first = input.lines[0]
  const vat: CustomerVat[] = first ? [{ rate: first.vatNature ? null : first.vatRatePct.toFixed(2), nature: first.vatNature, taxable: version.netAmount, vat: version.vatAmount }] : []
  const depositPct = text(version.depositPct)
  const deposit = depositPct !== null && version.depositAmount !== null && version.depositAmount > 0 ? { pct: depositPct, kind: (version.depositKind ?? 'ACCONTO') as DepositKind, amount: version.depositAmount } : null
  const validUntil = dayOf(version.validUntil)!
  return {
    number: input.quote.number,
    revision: version.revision,
    date: input.date,
    language,
    currency: version.currency,
    priceBasis: priceBasisOf(version.taxMode),
    taxMode: version.taxMode,
    customerRef: input.quote.customerRef,
    validUntil,
    firmOffer: version.firmOffer,
    promiseDate: dayOf(version.promiseDate),
    paymentTerms: version.paymentTerms,
    billTo: input.billTo,
    shipTo: input.shipTo,
    contact: input.contact,
    lines,
    totals: { net: version.netAmount, vat, gross: version.grossAmount },
    deposit,
    noWithdrawal: version.noWithdrawal,
    terms: quoteTerms({
      language,
      taxMode: version.taxMode,
      currency: version.currency,
      validUntil,
      firmOffer: version.firmOffer,
      promiseDate: dayOf(version.promiseDate),
      deposit,
      noWithdrawal: version.noWithdrawal,
      termsText: version.termsText,
      termsVersion: version.termsVersion,
      depositDueDays: input.depositDueDays,
    }),
  }
}

/** The day a sent version's document is dated: the day it was sent (Europe/Rome). */
export const sentDayOf = (version: Pick<CustomerVersionRow, 'sentAt'>, fallback: Date): string => businessDate(version.sentAt ?? fallback)

export type { QuoteStatus, QuoteVersionStatus }
