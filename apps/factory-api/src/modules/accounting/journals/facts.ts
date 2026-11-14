import { ENTRY_PACKAGES } from '@nexus/factory-domain/accounting/checks'
import type { CostRegisterFacts } from '@nexus/factory-domain/accounting/journals/cost-of-sales'
import type { PurchaseLineFacts, SalesLineFacts } from '@nexus/factory-domain/accounting/journals/entries'
import type { TaxCodeFacts, VarianceCategory } from '@nexus/factory-domain/accounting/mapping/keys'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import type { Period } from '@nexus/factory-domain/accounting/periods'
import { businessDate, businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { endOfDay } from '../../costing/valuation/valuation'
import { journalsSettingsOf, mappingRowsOf, taxCodesOf, type StoredMapping } from '../mapping/store'
import type { CompanyRow, Reader } from '../store'

/**
 * What the accountant's bridge reads of a company's month besides the W2a journals (B-W2b-408; read by facts.ts's
 * readPeriodFacts, so the preview, the export and its re-check inside its command read the same):
 *
 *   always        the journals switch (AccountingSettings: the company's row, else the tenant's, else off)
 *   journals on   (or asked by the integrity checks) the mapping rows and the sales tax codes (the accounts of the entries), the lines of the month's
 *                 invoices (their kind and charge kind) and supplier invoices (their kind and the ordered item's kind), and
 *                 the countries of the parties (their party group)
 *   cost of goods sold and variances
 *                 the cost of goods sold posted in the month (B-W2b-407), the variances of the work-order closes made in it
 *                 and not undone (B-W2b-411), the purchase price variances taken in it (B-W2b-407); and the work orders
 *                 completed by the month's end and still not closed (the WORK_ORDERS_CLOSED check)
 * Everything is the company's (row-level security keeps the tenant; the caller's company was checked by companyFor).
 */

export interface BridgeFacts {
  readonly journalsOn: boolean
  /** The entries' facts were read (the journals on, or the integrity checks' own read): the entries can be made. */
  readonly entriesRead: boolean
  readonly mapping: readonly StoredMapping[]
  readonly codes: readonly TaxCodeFacts[]
  /** Per sales invoice: its lines (journals on). */
  readonly salesLines: ReadonlyMap<string, readonly SalesLineFacts[]>
  /** Per supplier invoice: its lines (journals on). */
  readonly purchaseLines: ReadonlyMap<string, readonly PurchaseLineFacts[]>
  /** Per party code: the country it is established in (journals on). */
  readonly countries: ReadonlyMap<string, string>
  /** The cost register's figures (COST_OF_SALES asked), else null. */
  readonly costFigures: readonly CostRegisterFacts[] | null
  /** Work orders completed by the month's end and not closed (COST_OF_SALES asked), else null. */
  readonly openWorkOrders: readonly { readonly id: string; readonly number: string }[] | null
}

export interface BridgeIds {
  readonly invoiceIds: readonly string[]
  readonly supplierInvoiceIds: readonly string[]
  readonly partyCodes: readonly string[]
}

/** The month's instants: from the first day's start (Rome) to the last day's end. */
const monthInstants = (period: Period) => ({ gte: businessDayStart(period.start), lte: endOfDay(period.end) })

/** `entries`: read the entries' facts whatever the switch says (the integrity check LEDGER_BALANCES). */
export async function readBridgeFacts(db: Reader, company: CompanyRow, period: Period, packages: readonly AccountingPackage[], ids: BridgeIds, options: { readonly entries?: boolean } = {}): Promise<BridgeFacts> {
  const wanted = new Set(packages)
  const { journalsOn } = await journalsSettingsOf(db, company.id)
  const entries = (journalsOn || options.entries === true) && ENTRY_PACKAGES.some((pkg) => wanted.has(pkg))
  const [mapping, codes] = entries ? await Promise.all([mappingRowsOf(db, company.id), taxCodesOf(db, company.id)]) : [[], []]

  const salesLines = new Map<string, SalesLineFacts[]>()
  if (entries && wanted.has('SALES_JOURNAL') && ids.invoiceIds.length > 0) {
    const rows = await db.invoiceLine.findMany({ where: { invoiceId: { in: [...ids.invoiceIds] } }, select: { invoiceId: true, kind: true, chargeKind: true, netAmount: true }, orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }] })
    for (const row of rows) salesLines.set(row.invoiceId, [...(salesLines.get(row.invoiceId) ?? []), { kind: row.kind, chargeKind: row.chargeKind, netAmount: row.netAmount }])
  }
  const purchaseLines = new Map<string, PurchaseLineFacts[]>()
  if (entries && wanted.has('PURCHASES_JOURNAL') && ids.supplierInvoiceIds.length > 0) {
    const rows = await db.supplierInvoiceLine.findMany({
      where: { invoiceId: { in: [...ids.supplierInvoiceIds] } },
      select: { invoiceId: true, kind: true, netAmount: true, purchaseOrderLine: { select: { item: { select: { kind: true } } } } },
      orderBy: [{ invoiceId: 'asc' }, { seq: 'asc' }],
    })
    for (const row of rows) purchaseLines.set(row.invoiceId, [...(purchaseLines.get(row.invoiceId) ?? []), { kind: row.kind, itemKind: row.purchaseOrderLine?.item?.kind ?? null, netAmount: row.netAmount }])
  }
  const countries = new Map<string, string>()
  if (entries && ids.partyCodes.length > 0) {
    for (const row of await db.party.findMany({ where: { code: { in: [...new Set(ids.partyCodes)] } }, select: { code: true, country: true } })) countries.set(row.code, row.country)
  }

  const costFigures = wanted.has('COST_OF_SALES') ? await readCostFigures(db, company, period) : null
  const openWorkOrders = wanted.has('COST_OF_SALES')
    ? await db.workOrder.findMany({ where: { companyId: company.id, status: 'COMPLETED', completedAt: { lte: endOfDay(period.end) } }, select: { id: true, number: true }, orderBy: { number: 'asc' } })
    : null
  return { journalsOn, entriesRead: entries, mapping, codes, salesLines, purchaseLines, countries, costFigures, openWorkOrders }
}

const day = (at: Date): BusinessDate => businessDate(at)

/** The month's cost of goods sold, live work-order variances and purchase price variances, oldest first. */
async function readCostFigures(db: Reader, company: CompanyRow, period: Period): Promise<CostRegisterFacts[]> {
  const when = monthInstants(period)
  const sold = await db.costOfSalesEntry.findMany({
    where: { companyId: company.id, postedAt: when },
    select: {
      id: true,
      partyId: true,
      quantity: true,
      materialAmount: true,
      labourAmount: true,
      subcontractAmount: true,
      overheadAmount: true,
      amount: true,
      currency: true,
      postedAt: true,
      reversalOfId: true,
      shipmentLine: { select: { shipment: { select: { number: true } } } },
      invoiceLine: { select: { invoice: { select: { number: true } } } },
    },
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
  })
  const variances = await db.workOrderVariance.findMany({
    where: { companyId: company.id, close: { closedAt: when, undoneAt: null } },
    select: { id: true, category: true, actualQuantity: true, amount: true, currency: true, item: { select: { code: true } }, close: { select: { closedAt: true, workOrder: { select: { number: true } } } } },
    orderBy: [{ id: 'asc' }],
  })
  const ppv = await db.purchasePriceVariance.findMany({
    where: { companyId: company.id, postedAt: when },
    select: {
      id: true,
      at: true,
      quantity: true,
      differenceAmount: true,
      currency: true,
      postedAt: true,
      reversalOfId: true,
      item: { select: { code: true, kind: true } },
      supplier: { select: { code: true, legalName: true } },
      receiptLine: { select: { receipt: { select: { number: true } } } },
      supplierInvoiceLine: { select: { invoice: { select: { number: true } } } },
    },
    orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
  })
  const parties = new Map(
    sold.length > 0 ? (await db.party.findMany({ where: { id: { in: [...new Set(sold.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]) : [],
  )
  const figures: CostRegisterFacts[] = [
    ...sold.map((row): CostRegisterFacts => {
      const reference = row.shipmentLine?.shipment.number ?? row.invoiceLine?.invoice.number ?? null
      const party = parties.get(row.partyId)
      return {
        recordType: 'CostOfSalesEntry',
        id: row.id,
        reference,
        day: day(row.postedAt),
        currency: row.currency,
        amount: row.amount,
        partyCode: party?.code ?? null,
        partyName: party?.legalName ?? null,
        category: null,
        itemKind: null,
        workOrderNumber: null,
        itemCode: null,
        at: null,
        quantity: row.quantity.toFixed(4),
        parts: { material: row.materialAmount, labour: row.labourAmount, subcontract: row.subcontractAmount, overhead: row.overheadAmount },
        reverses: row.reversalOfId ? reference : null,
      }
    }),
    ...variances.map(
      (row): CostRegisterFacts => ({
        recordType: 'WorkOrderVariance',
        id: row.id,
        reference: row.close.workOrder.number,
        day: day(row.close.closedAt),
        currency: row.currency,
        amount: row.amount,
        partyCode: null,
        partyName: null,
        category: row.category as VarianceCategory,
        itemKind: null,
        workOrderNumber: row.close.workOrder.number,
        itemCode: row.item?.code ?? null,
        at: null,
        quantity: row.actualQuantity === null ? null : row.actualQuantity.toFixed(4),
        parts: null,
        reverses: null,
      }),
    ),
    ...ppv.map((row): CostRegisterFacts => {
      const reference = row.receiptLine?.receipt.number ?? row.supplierInvoiceLine?.invoice.number ?? null
      return {
        recordType: 'PurchasePriceVariance',
        id: row.id,
        reference,
        day: day(row.postedAt),
        currency: row.currency,
        amount: row.differenceAmount,
        partyCode: row.supplier.code,
        partyName: row.supplier.legalName,
        category: null,
        itemKind: row.item.kind,
        workOrderNumber: null,
        itemCode: row.item.code,
        at: row.at,
        quantity: row.quantity.toFixed(4),
        parts: null,
        reverses: row.reversalOfId ? reference : null,
      }
    }),
  ]
  return figures.sort((a, b) => a.day.localeCompare(b.day) || a.recordType.localeCompare(b.recordType) || a.id.localeCompare(b.id))
}
