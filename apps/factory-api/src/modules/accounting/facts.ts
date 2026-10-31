import type { Prisma } from '@nexus/factory-db'
import {
  checksFor,
  intrastatCheck,
  paymentsPlacedCheck,
  periodEndedCheck,
  placementsCheck,
  rejectedCheck,
  shipmentsInvoicedCheck,
  stockValuedCheck,
  totalsCheck,
  yearEndCheck,
  type CheckResult,
  type TotalsFacts,
} from '@nexus/factory-domain/accounting/checks'
import { intrastatDocuments, intrastatRowOf, isEuSale, type IntrastatLineFacts, type IntrastatRow } from '@nexus/factory-domain/accounting/intrastat'
import {
  buyerOfBillTo,
  paymentDocument,
  purchasesJournalDocument,
  refundDocument,
  salesJournalDocument,
  vatEntriesOf,
  viesPrefix,
  type DocumentRows,
  type PaymentFacts,
  type RefundFacts,
  type SalesInvoiceFacts,
  type SupplierInvoiceFacts,
} from '@nexus/factory-domain/accounting/journals'
import type { ExportDocument } from '@nexus/factory-domain/accounting/manifest'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import type { Period } from '@nexus/factory-domain/accounting/periods'
import { yearEndDocuments, type ValuationRowFacts, type YearEndCountFacts } from '@nexus/factory-domain/accounting/year-end'
import { businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { notInvoiced } from '@nexus/factory-domain/invoicing/from-shipment/shipped'
import { endOfDay, valueStockAsOf } from '../costing/valuation/valuation'
import { invoicedOf, readDdts, shippedOf } from '../invoicing/from-shipment/store'
import { dateOf, dayOf, type CompanyRow, type Reader } from './store'

/**
 * What a company's month holds for its accounting export (B-W2a-39), read in one place so the preview, the export and
 * the export's own re-check inside its command read the same: the invoices issued in the month (the sales journal, the
 * Intrastat rows and three checks), the payments received and the refunds paid (the payments and two checks), the
 * supplier invoices received (the purchases journal), the DDTs of the month's shipments (every shipment invoiced), and
 * at the year end the signed-off year-end inventories and the stock valuation at the end of the day (the year-end pack,
 * B-W2a-15 and B-W2a-29's valueStockAsOf). Row-level security keeps the tenant; the company is the caller's to read
 * (companyFor). The year-end valuation is the company's whole stock (every site), as the accountant gets it.
 */

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ISSUED_TYPES = ['TD01', 'TD02', 'TD04', 'TD24'] as const

export interface PeriodFacts {
  readonly period: Period
  readonly sales: readonly SalesInvoiceFacts[]
  readonly totals: readonly TotalsFacts[]
  readonly rejected: readonly { readonly id: string; readonly number: string | null }[]
  readonly openDdts: readonly { readonly ddtId: string; readonly number: string }[]
  readonly payments: readonly PaymentFacts[]
  readonly refunds: readonly RefundFacts[]
  readonly purchases: readonly SupplierInvoiceFacts[] | null
  readonly intrastat: readonly IntrastatRow[] | null
  readonly yearEnd: YearEndFacts | null
}

export interface YearEndFacts {
  readonly day: BusinessDate
  readonly counts: readonly YearEndCountFacts[]
  readonly valuation: readonly ValuationRowFacts[]
  readonly unvaluedMoves: number
  readonly sitesWithStock: readonly { readonly siteId: string; readonly code: string }[]
  readonly words: string
}

const inPeriod = (period: Period) => ({ gte: dateOf(period.start), lte: dateOf(period.end) })

/** Everything the packages asked for need of the month (the base journals and checks always). */
export async function readPeriodFacts(db: Reader, company: CompanyRow, period: Period, packages: readonly AccountingPackage[]): Promise<PeriodFacts> {
  const wanted = new Set(packages)
  const invoices = await db.invoice.findMany({
    where: { companyId: company.id, issueDate: inPeriod(period), status: { not: 'DRAFT' }, docType: { in: [...ISSUED_TYPES] } },
    select: {
      id: true,
      number: true,
      version: true,
      docType: true,
      status: true,
      issueDate: true,
      currency: true,
      netTotal: true,
      vatTotal: true,
      grossTotal: true,
      stampDutyAmount: true,
      vatSummary: true,
      billTo: true,
      buyerPartyId: true,
      buyer: { select: { code: true, incoterm: true } },
      creditOf: { select: { number: true } },
    },
    orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
  })
  const issued = invoices.filter((invoice) => invoice.status !== 'REJECTED')
  const sales: SalesInvoiceFacts[] = issued.map((invoice) => ({
    id: invoice.id,
    number: invoice.number ?? '',
    version: invoice.version,
    docType: invoice.docType,
    issueDate: dayOf(invoice.issueDate!),
    currency: invoice.currency,
    netTotal: invoice.netTotal,
    vatTotal: invoice.vatTotal,
    grossTotal: invoice.grossTotal,
    stampDutyAmount: invoice.stampDutyAmount,
    summary: vatEntriesOf(invoice.vatSummary),
    buyerCode: invoice.buyer.code,
    buyer: buyerOfBillTo(invoice.billTo),
    creditOfNumber: invoice.creditOf?.number ?? null,
  }))
  const totals: TotalsFacts[] = issued.map((invoice) => ({ id: invoice.id, number: invoice.number ?? '', netTotal: invoice.netTotal, vatTotal: invoice.vatTotal, grossTotal: invoice.grossTotal, stampDutyAmount: invoice.stampDutyAmount, vatSummary: invoice.vatSummary }))
  const rejected = invoices.filter((invoice) => invoice.status === 'REJECTED').map((invoice) => ({ id: invoice.id, number: invoice.number }))

  // Every shipment invoiced: the DDTs of the month's shipped goods that an issued invoice does not wholly bill.
  const ddts = await readDdts(db, { companyId: company.id, documentDate: inPeriod(period), cancellations: { none: {} }, shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } }, 5000)
  const open = notInvoiced(await shippedOf(db, ddts), await invoicedOf(db, ddts.map((ddt) => ddt.id))).filter((row) => row.notInvoiced.gt(0))
  const openDdts = ddts.filter((ddt) => open.some((row) => row.ddtId === ddt.id)).map((ddt) => ({ ddtId: ddt.id, number: ddt.number }))

  const paymentRows = await db.payment.findMany({
    where: { companyId: company.id, receivedOn: inPeriod(period), status: 'RECEIVED' },
    select: {
      id: true,
      version: true,
      receivedOn: true,
      externalRef: true,
      method: true,
      currency: true,
      amount: true,
      party: { select: { code: true, legalName: true } },
      allocations: { select: { amount: true, invoiceId: true, depositRequestId: true, invoice: { select: { number: true } } } },
      refunds: { where: { status: { in: ['DUE', 'PAID'] } }, select: { amount: true } },
    },
    orderBy: [{ receivedOn: 'asc' }, { externalRef: 'asc' }],
  })
  const payments: PaymentFacts[] = paymentRows.map((payment) => {
    const perInvoice = new Map<string, { number: string; net: number }>()
    const perDeposit = new Map<string, number>()
    for (const allocation of payment.allocations) {
      if (allocation.invoiceId) {
        const entry = perInvoice.get(allocation.invoiceId) ?? { number: allocation.invoice?.number ?? allocation.invoiceId, net: 0 }
        entry.net += allocation.amount
        perInvoice.set(allocation.invoiceId, entry)
      } else if (allocation.depositRequestId) {
        perDeposit.set(allocation.depositRequestId, (perDeposit.get(allocation.depositRequestId) ?? 0) + allocation.amount)
      }
    }
    return {
      id: payment.id,
      version: payment.version,
      receivedOn: dayOf(payment.receivedOn),
      reference: payment.externalRef,
      method: payment.method,
      currency: payment.currency,
      amount: payment.amount,
      placed: payment.allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
      refunded: payment.refunds.reduce((sum, refund) => sum + refund.amount, 0),
      paysInvoices: [...perInvoice.values()].filter((entry) => entry.net > 0).map((entry) => entry.number).sort(),
      paysDeposits: [...perDeposit.values()].filter((net) => net > 0).length,
      customerCode: payment.party.code,
      customerName: payment.party.legalName,
    }
  })
  const refundRows = await db.refund.findMany({
    where: { companyId: company.id, status: 'PAID', paidOn: inPeriod(period) },
    select: { id: true, version: true, paidOn: true, externalRef: true, method: true, currency: true, amount: true, party: { select: { code: true, legalName: true } }, creditNote: { select: { number: true } }, payment: { select: { externalRef: true } } },
    orderBy: [{ paidOn: 'asc' }, { id: 'asc' }],
  })
  const refunds: RefundFacts[] = refundRows.map((refund) => ({
    id: refund.id,
    version: refund.version,
    paidOn: dayOf(refund.paidOn!),
    reference: refund.externalRef,
    method: refund.method,
    currency: refund.currency,
    amount: refund.amount,
    of: refund.creditNote?.number ?? refund.payment?.externalRef ?? null,
    customerCode: refund.party.code,
    customerName: refund.party.legalName,
  }))

  const purchases = wanted.has('PURCHASES_JOURNAL') ? await readPurchases(db, company, period) : null
  const intrastat = wanted.has('INTRASTAT') ? await readIntrastat(db, issued) : null
  const yearEnd = wanted.has('YEAR_END_STOCK') ? await readYearEnd(db, company, period) : null
  return { period, sales, totals, rejected, openDdts, payments, refunds, purchases, intrastat, yearEnd }
}

async function readPurchases(db: Reader, company: CompanyRow, period: Period): Promise<SupplierInvoiceFacts[]> {
  const rows = await db.supplierInvoice.findMany({
    where: { companyId: company.id, receivedOn: inPeriod(period), status: { not: 'VOIDED' } },
    select: {
      id: true,
      number: true,
      version: true,
      kind: true,
      docType: true,
      source: true,
      issueDate: true,
      receivedOn: true,
      currency: true,
      netTotal: true,
      vatTotal: true,
      grossTotal: true,
      withholdingAmount: true,
      stampDutyAmount: true,
      vatSummary: true,
      sdiIdentifier: true,
      party: { select: { code: true, legalName: true, taxIdentities: { select: { country: true, vatNumber: true, validFrom: true }, orderBy: { validFrom: 'desc' } } } },
    },
    orderBy: [{ receivedOn: 'asc' }, { number: 'asc' }],
  })
  return rows.map((row) => {
    const issueDay = dayOf(row.issueDate)
    const identity = row.party.taxIdentities.find((entry) => dayOf(entry.validFrom) <= issueDay) ?? row.party.taxIdentities.at(-1) ?? null
    const vat = identity?.vatNumber ?? null
    return {
      id: row.id,
      number: row.number,
      version: row.version,
      kind: row.kind,
      docType: row.docType,
      source: row.source,
      issueDate: issueDay,
      receivedOn: dayOf(row.receivedOn),
      currency: row.currency,
      netTotal: row.netTotal,
      vatTotal: row.vatTotal,
      grossTotal: row.grossTotal,
      withholdingAmount: row.withholdingAmount,
      stampDutyAmount: row.stampDutyAmount,
      summary: vatEntriesOf(row.vatSummary),
      supplierCode: row.party.code,
      supplierName: row.party.legalName,
      supplierVatId: vat === null ? null : /^[A-Z]{2}/.test(vat) ? vat : `${viesPrefix(identity!.country)}${vat}`,
      sdiIdentifier: row.sdiIdentifier,
    }
  })
}

type IssuedInvoice = { readonly id: string; readonly number: string | null; readonly version: number; readonly docType: string; readonly issueDate: Date | null; readonly currency: string; readonly billTo: Prisma.JsonValue; readonly buyerPartyId: string; readonly buyer: { readonly code: string; readonly incoterm: string | null } }

const countryOf = (value: Prisma.JsonValue | null, path: readonly string[]): string | null => {
  let at: unknown = value
  for (const key of path) at = at !== null && typeof at === 'object' && !Array.isArray(at) ? (at as Record<string, unknown>)[key] : undefined
  return typeof at === 'string' && /^[A-Z]{2}$/.test(at) ? at : null
}

/** The month's EU sales of goods, line by line, with what the Intrastat file needs of each. */
async function readIntrastat(db: Reader, issued: readonly IssuedInvoice[]): Promise<IntrastatRow[]> {
  const candidates = issued.filter((invoice) => ['TD01', 'TD24', 'TD04'].includes(invoice.docType))
  if (candidates.length === 0) return []
  const lines = await db.invoiceLine.findMany({
    where: { invoiceId: { in: candidates.map((invoice) => invoice.id) }, kind: 'GOODS' },
    select: { id: true, invoiceId: true, seq: true, kind: true, quantity: true, netAmount: true, description: true, salesOrderLineId: true, ddtId: true },
    orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }],
  })
  const ddtIds = [...new Set(lines.map((line) => line.ddtId).filter((value): value is string => value !== null))]
  const ddts = new Map((ddtIds.length > 0 ? await db.ddt.findMany({ where: { id: { in: ddtIds } }, select: { id: true, recipient: true, destination: true, transportMode: true, shipmentId: true } }) : []).map((row) => [row.id, row]))
  // B-W2b-22 (Z9:01's Intrastat part): the mode of transport the DDT froze at its issue, else its shipment's (B-W2b-19).
  const shipmentIds = [...new Set([...ddts.values()].filter((ddt) => ddt.transportMode === null && ddt.shipmentId !== null).map((ddt) => ddt.shipmentId!))]
  const shipmentModes = new Map((shipmentIds.length > 0 ? await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, transportMode: true } }) : []).map((row) => [row.id, row.transportMode]))
  const orderLineIds = [...new Set(lines.map((line) => line.salesOrderLineId).filter((value): value is string => value !== null))]
  const orderLines = new Map((orderLineIds.length > 0 ? await db.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, styleId: true } }) : []).map((row) => [row.id, row.styleId]))
  const styleIds = [...new Set(orderLines.values())]
  const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, hsCode: true, originCountry: true, netMassKg: true } }) : []).map((row) => [row.id, row]))
  const byId = new Map(candidates.map((invoice) => [invoice.id, invoice]))
  const rows: IntrastatRow[] = []
  for (const line of lines) {
    const invoice = byId.get(line.invoiceId)!
    const buyer = buyerOfBillTo(invoice.billTo)
    const ddt = line.ddtId ? ddts.get(line.ddtId) : undefined
    const ddtCountry = ddt ? (countryOf(ddt.destination, ['country']) ?? countryOf(ddt.recipient, ['address', 'country'])) : null
    const destination = ddtCountry ? { country: ddtCountry, source: 'DDT' as const } : { country: buyer.country, source: 'BILL_TO' as const }
    const styleId = line.salesOrderLineId ? orderLines.get(line.salesOrderLineId) : undefined
    const style = styleId ? styles.get(styleId) : undefined
    const facts: IntrastatLineFacts = {
      invoice: { id: invoice.id, number: invoice.number ?? '', version: invoice.version, docType: invoice.docType, issueDate: dayOf(invoice.issueDate!), currency: invoice.currency },
      line: { id: line.id, seq: line.seq, kind: line.kind, quantity: line.quantity.toFixed(4), netAmount: line.netAmount, description: line.description },
      buyer: { ...buyer, partyId: invoice.buyerPartyId, code: invoice.buyer.code, incoterm: invoice.buyer.incoterm },
      destination,
      style: style ? { id: style.id, code: style.code, hsCode: style.hsCode, originCountry: style.originCountry, netMassKg: style.netMassKg === null ? null : style.netMassKg.toFixed(3) } : null,
      transportMode: ddt ? (ddt.transportMode ?? (ddt.shipmentId ? (shipmentModes.get(ddt.shipmentId) ?? null) : null)) : null,
    }
    if (isEuSale(facts)) rows.push(intrastatRowOf(facts))
  }
  return rows
}

/** The year-end inventories of the company for the year-end day and its stock valued at the end of that day. */
async function readYearEnd(db: Reader, company: CompanyRow, period: Period): Promise<YearEndFacts> {
  const day = period.end
  const counts = await db.stockCount.findMany({
    where: { companyId: company.id, kind: 'YEAR_END', inventoryDate: dateOf(day) },
    select: { id: true, number: true, version: true, siteId: true, status: true, signedOffAt: true, valuedListFileId: true, site: { select: { code: true } } },
    orderBy: { number: 'asc' },
  })
  const sheets = counts.length > 0 ? await db.storedFile.findMany({ where: { recordType: 'StockCount', recordId: { in: counts.map((count) => count.id) }, contentType: XLSX, status: 'AVAILABLE' }, select: { id: true, recordId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }) : []
  const valuation = await valueStockAsOf(db, { siteIds: null, companyId: company.id }, endOfDay(day))
  const rows: ValuationRowFacts[] = valuation.rows.map((row) => ({
    category: row.category,
    siteCode: row.site.code,
    itemCode: row.item?.code ?? null,
    itemName: row.item?.name ?? null,
    colourCode: row.colour?.code ?? null,
    lotCode: row.lot?.code ?? null,
    workOrderNumber: row.workOrder?.number ?? null,
    quantity: row.quantity,
    uom: row.uom,
    hides: row.hides,
    value: row.value as number,
    currency: row.currency,
    valued: row.valued,
    dependsOnMethod: row.dependsOnMethod,
  }))
  const withStock = new Map<string, string>()
  for (const row of valuation.rows) if (row.category !== 'WIP' && row.quantity !== null && !/^-?0(\.0+)?$/.test(row.quantity)) withStock.set(row.site.id, row.site.code)
  return {
    day,
    counts: counts.map((count) => ({
      id: count.id,
      number: count.number,
      version: count.version,
      siteId: count.siteId,
      siteCode: count.site.code,
      status: count.status,
      signedOffAt: count.signedOffAt ? toUtcIso(count.signedOffAt) : null,
      pdfFileId: count.valuedListFileId,
      sheetFileId: sheets.find((sheet) => sheet.recordId === count.id)?.id ?? null,
    })),
    valuation: rows,
    unvaluedMoves: valuation.unvaluedMoves,
    sitesWithStock: [...withStock.entries()].map(([siteId, code]) => ({ siteId, code })).sort((a, b) => a.code.localeCompare(b.code)),
    words: valuation.words,
  }
}

/** The documents per package, with their file rows. */
export interface PackageDocuments {
  readonly documents: readonly ExportDocument[]
  /** The journals' rows per document (DOCUMENTS packages). */
  readonly journals: ReadonlyMap<AccountingPackage, readonly DocumentRows[]>
}

export function documentsOf(facts: PeriodFacts, company: CompanyRow, packages: readonly AccountingPackage[]): PackageDocuments {
  const wanted = new Set(packages)
  const journals = new Map<AccountingPackage, DocumentRows[]>()
  if (wanted.has('SALES_JOURNAL')) journals.set('SALES_JOURNAL', facts.sales.map(salesJournalDocument))
  if (wanted.has('PURCHASES_JOURNAL') && facts.purchases) journals.set('PURCHASES_JOURNAL', facts.purchases.map(purchasesJournalDocument))
  if (wanted.has('PAYMENTS')) journals.set('PAYMENTS', [...facts.payments.map(paymentDocument), ...facts.refunds.map(refundDocument)])
  const documents: ExportDocument[] = [...journals.values()].flatMap((rows) => rows.map((row) => row.document))
  if (wanted.has('INTRASTAT') && facts.intrastat) documents.push(...intrastatDocuments(facts.intrastat, new Map(facts.sales.map((invoice) => [invoice.id, invoice.version]))))
  if (wanted.has('YEAR_END_STOCK') && facts.yearEnd) documents.push(...yearEndDocuments({ companyId: company.id, yearEndDay: facts.yearEnd.day, counts: facts.yearEnd.counts, valuation: facts.yearEnd.valuation }))
  return { documents, journals }
}

/** The named checks of an export of these packages, as the month stands. */
export function checksOf(facts: PeriodFacts, packages: readonly AccountingPackage[], today: BusinessDate): CheckResult[] {
  const all: Record<string, () => CheckResult> = {
    PERIOD_ENDED: () => periodEndedCheck(facts.period, today),
    SHIPMENTS_INVOICED: () => shipmentsInvoicedCheck(facts.openDdts),
    NO_INVOICE_REJECTED: () => rejectedCheck(facts.rejected),
    PAYMENTS_PLACED: () => paymentsPlacedCheck(facts.payments),
    PLACEMENTS_WITHIN_PAYMENTS: () => placementsCheck(facts.payments),
    TOTALS_EQUAL_ROWS: () => totalsCheck(facts.totals),
    INTRASTAT_COMPLETE: () => intrastatCheck(facts.intrastat ?? []),
    YEAR_END_SIGNED_OFF: () => yearEndCheck({ counts: facts.yearEnd?.counts ?? [], sitesWithStock: facts.yearEnd?.sitesWithStock ?? [] }),
    STOCK_VALUED: () => stockValuedCheck(facts.yearEnd?.unvaluedMoves ?? 0),
  }
  return checksFor(packages).map((code) => all[code]!())
}

/** Stock moves dated in the month that change stock and have no value yet (a hard lock waits for them). */
export async function unvaluedMovesIn(db: Reader, companyId: string, period: Period): Promise<number> {
  const from = businessDayStart(period.start)
  const to = endOfDay(period.end)
  return db.stockMove.count({
    where: {
      companyId,
      occurredAt: { gte: from, lte: to },
      valuations: { none: {} },
      OR: [
        { fromLocationId: null, NOT: { toLocationId: null } },
        { toLocationId: null, NOT: { fromLocationId: null } },
      ],
    },
  })
}
