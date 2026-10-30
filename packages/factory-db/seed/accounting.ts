import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  AccountingExportStatus,
  AccountingPackage,
  CostingMethod,
  PeriodLockLevel,
  StandardCostSource,
  StandardCostStatus,
  SupplierInvoiceKind,
  SupplierInvoiceLineKind,
  SupplierInvoiceMatchStatus,
  SupplierInvoiceSource,
  WorkOrderCostKind,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCosting } from './costing'
import { seed as seedFiles } from './files'
import { seed as seedMoney, type MoneySeed } from './money'
import { seed as seedNumbering } from './numbering'

/**
 * The payables, cost-ledger and accounting seed (W2a schema wave 7/7), per tenant of seed/_core.ts, for company A,
 * written in the tenant's office scope as the app does:
 *
 *   costing method  left to the accountant: the tenant-wide costing settings (seed/costing.ts) keep the placeholder
 *                   UNDECIDED, unlocked; every cost entry below is valued under it (provisional, relied on by nobody).
 *   standards       FROZEN from 2026-10-01 (no end yet) at the product seed's standard costs: black leather 4.20 per ft²,
 *                   grey lining 3.10 per m, protectors 6.50 each; a DRAFT for the leather from 2027-01-01 at 4.35 (the
 *                   tannery's new price list).
 *   cost ledger     SEED-WO-0001: the hide issued on 2026-11-16 (53.2 ft² at the lot's 4.20: 223.44 EUR) and the labour
 *                   of the standing sewing scan (2 pieces × 96.5 standard minutes at 0.40 EUR a minute and 80 %
 *                   efficiency: 96.50 EUR). Per work order and operation, never per person.
 *   supplier inv.   P2's invoice 2026/0412 through SDI for SEED-GR-0001's leather (105 ft² at 4.30, the order said 4.20) and
 *                   15.00 EUR of freight: RECEIVED, its line matched against PO1's leather line and the receipt, a price
 *                   difference of 10.50 EUR outside the 2 % tolerance, not accepted yet ("Differences to check").
 *   exports         EXP-2026-0001, September 2026 (the month before the seed's first documents): EXPORTED with its three
 *                   empty journals (the number from the company's ACCOUNTING_EXPORT series, its NumberAllocation row
 *                   written and the series moved to 2, as allocateNumber does); October's export, a DRAFT whose job wrote
 *                   the sales journal so far (FT-2026-00001 and FT-2026-00003).
 *   period lock     September 2026, HARD, after EXP-2026-0001: nothing dated in it is written any more.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a supplier invoice, its line and its match are written while it is RECEIVED; a standard starts as a DRAFT; a
 * cost entry's copy must pass its checks again (the move's quantity, the method in force); an export starts as a DRAFT
 * and a file is added only to a DRAFT export. So the supplier invoice, its goods line and match, the 2027 DRAFT
 * standard, the material entry, October's DRAFT export and its file get ids that start with eight zeros (still derived
 * from the namespace); the rows this seed adds to other modules' tables (files, the number allocation) and the other
 * rows start with eight f's or are plain.
 *
 * Every name, number and amount is invented. Idempotent: each record is written once, in one transaction, and skipped
 * when it exists (cost entries are append-only, an exported batch and a frozen standard never change).
 */

const T = {
  frozen: new Date('2026-10-01T08:00:00.000Z'),
  exportedSeptember: new Date('2026-10-05T08:00:00.000Z'),
  lockedSeptember: new Date('2026-10-05T09:00:00.000Z'),
  draftedOctober: new Date('2026-11-02T08:00:00.000Z'),
  supplierInvoice: new Date('2026-11-13T07:00:00.000Z'),
  matched: new Date('2026-11-13T10:00:00.000Z'),
  nextStandard: new Date('2026-11-20T08:00:00.000Z'),
  // seed/production.ts: the hide issued to SEED-WO-0001, and the standing sewing scan.
  issued: new Date('2026-11-16T07:30:00.000Z'),
  rescanned: new Date('2026-11-17T09:30:00.000Z'),
} as const
const DAY = {
  standardFrom: new Date('2026-10-01T00:00:00.000Z'),
  nextStandardFrom: new Date('2027-01-01T00:00:00.000Z'),
  september: { first: new Date('2026-09-01T00:00:00.000Z'), last: new Date('2026-09-30T00:00:00.000Z') },
  october: { first: new Date('2026-10-01T00:00:00.000Z'), last: new Date('2026-10-31T00:00:00.000Z') },
  exportedSeptember: new Date('2026-10-05T00:00:00.000Z'),
  supplierIssued: new Date('2026-11-12T00:00:00.000Z'),
  supplierReceived: new Date('2026-11-13T00:00:00.000Z'),
  supplierDue: new Date('2026-12-31T00:00:00.000Z'),
} as const
const YEAR = '2026'
const TEN_YEARS = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear() + 10, at.getUTCMonth(), at.getUTCDate()))
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** P2's invoice: 105 ft² of leather at 4.30 (the order's price is 4.20) and 15.00 of freight, VAT 22 %, minor units. */
const SUPPLIER = { leatherNet: 45_150, freightNet: 1_500, net: 46_650, vat: 10_263 } as const
/** The labour of the standing scan: 2 pieces × 96.5 minutes; 0.40 a minute at 80 % = 0.50 a standard minute. */
const LABOUR = { minutes: '193.0000', perMinute: '0.500000', amount: 9_650 } as const

export interface AccountingSeed {
  readonly money: MoneySeed
  /** The FROZEN standards from 2026-10-01 and the DRAFT leather standard from 2027. */
  readonly standardCostIds: { readonly leather: string; readonly lining: string; readonly protector: string; readonly nextLeather: string }
  /** SEED-WO-0001's cost entries: the hide issued, the sewing labour. */
  readonly costEntryIds: { readonly material: string; readonly labour: string }
  /** P2's SDI invoice (RECEIVED, DIFFERENCES), its two lines, the leather line's match and the invoice's XML. */
  readonly supplierInvoiceId: string
  readonly supplierLineIds: { readonly leather: string; readonly freight: string }
  readonly matchId: string
  readonly supplierXmlFileId: string
  /** EXP-2026-0001 (September, EXPORTED) and its files; October's DRAFT export and its file. */
  readonly exportedId: string
  readonly exportedFileIds: readonly string[]
  readonly draftExportId: string
  readonly draftFileId: string
  /** September 2026's HARD lock. */
  readonly periodLockId: string
  /** Company A's ACCOUNTING_EXPORT series for the year. */
  readonly exportSeriesId: string
}

export async function seed(context: SeedContext): Promise<AccountingSeed> {
  const { db, namespace } = context
  // The CLI runs this file first (name order): run what it builds on. The money seed runs the shipping, quality,
  // production, inventory, supply, sales, product, parties and earlier seeds; costing the rates and the tenant-wide
  // settings; numbering the ACCOUNTING_EXPORT series; files the store. All idempotent.
  const money = await seedMoney(context)
  await seedCosting(context)
  await seedNumbering(context)
  await seedFiles(context)
  const production = money.shipping.quality.production
  const inventory = production.inventory
  const supply = inventory.supply
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const P2 = id('party:P2')
  const store = id('files:account:r2')
  const item = { leather: id('product:item:leather'), lining: id('product:item:lining'), protector: id('product:item:protector') }
  const exportSeriesId = `ffffffff${id(`series:A:ACCOUNTING_EXPORT:MAIN:${YEAR}`).slice(8)}`
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const
  const archived = (key: string, recordType: string, recordId: string, name: string, contentType: string, at: Date): Prisma.StoredFileCreateManyInput => ({
    id: lastId(`accounting:file:${key}`),
    companyId: companyA,
    recordType,
    recordId,
    kind: 'FISCAL_ARCHIVE',
    originalName: name,
    contentType,
    sizeBytes: 2048,
    sha256: sha256(`seed accounting ${namespace} ${key}`),
    storeAccountId: store,
    storageKey: `legal/t/${tenantId}/c/${companyA}/${YEAR}/${id(`accounting:file:key:${key}`)}`,
    status: 'AVAILABLE',
    availableAt: at,
    visibility: ['OFFICE'],
    retainUntil: TEN_YEARS(at),
    ...stamp(at),
  })

  const standardCostIds = {
    leather: id('accounting:standard:A:leather:2026-10'),
    lining: id('accounting:standard:A:lining:2026-10'),
    protector: id('accounting:standard:A:protector:2026-10'),
    nextLeather: firstId('accounting:standard:A:leather:2027-01'),
  }
  const costEntryIds = { material: firstId('accounting:cost:WO-0001:issue:H1'), labour: id('accounting:cost:WO-0001:scan:3') }
  const supplierInvoiceId = firstId('accounting:supplier-invoice:P2:2026-0412')
  const supplierLineIds = { leather: firstId('accounting:supplier-invoice:P2:2026-0412:1'), freight: id('accounting:supplier-invoice:P2:2026-0412:2') }
  const matchId = firstId('accounting:supplier-invoice:P2:2026-0412:1:match')
  const exportedId = id('accounting:export:A:2026-09')
  const draftExportId = firstId('accounting:export:A:2026-10')
  const periodLockId = id('accounting:lock:A:2026-09')
  const supplierXml = archived('supplier-invoice:P2:2026-0412:xml', 'SupplierInvoice', supplierInvoiceId, 'IT00000002022_00412.xml', 'application/xml', T.supplierInvoice)
  const exportedFiles = [AccountingPackage.SALES_JOURNAL, AccountingPackage.PURCHASES_JOURNAL, AccountingPackage.PAYMENTS].map((pkg) =>
    archived(`export:A:2026-09:${pkg}`, 'AccountingExport', exportedId, `EXP-2026-0001-${pkg.toLowerCase()}.csv`, 'text/csv', T.exportedSeptember),
  )
  const draftFile = archived('export:A:2026-10:SALES_JOURNAL', 'AccountingExport', draftExportId, 'EXP-2026-10-sales_journal.csv', 'text/csv', T.draftedOctober)
  const draftFileId = firstId('accounting:export-file:A:2026-10:1')
  const exportedFileIds = exportedFiles.map((_, index) => id(`accounting:export-file:A:2026-09:${index + 1}`))

  // --- standard costs ---------------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.standardCost.findUnique({ where: { id: standardCostIds.leather }, select })) return
      const frozen = (key: keyof typeof item, cost: string): Prisma.StandardCostCreateManyInput => ({
        id: standardCostIds[key],
        companyId: companyA,
        itemId: item[key],
        validFrom: DAY.standardFrom,
        source: StandardCostSource.PURCHASE,
        materialCost: cost,
        unitCost: cost,
        breakdown: { basis: 'the item standard cost of the product seed (made up)' },
        ...stamp(T.frozen),
      })
      const rows = [frozen('leather', '4.200000'), frozen('lining', '3.100000'), frozen('protector', '6.500000')]
      await tx.standardCost.createMany({ data: rows })
      await tx.standardCost.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { status: StandardCostStatus.FROZEN, frozenAt: T.frozen, frozenById: actorId, version: 2 },
      })
      await tx.standardCost.create({
        data: {
          id: standardCostIds.nextLeather,
          companyId: companyA,
          itemId: item.leather,
          validFrom: DAY.nextStandardFrom,
          source: StandardCostSource.PURCHASE,
          materialCost: '4.350000',
          unitCost: '4.350000',
          breakdown: { basis: "the tannery's 2027 price list (made up)" },
          note: 'For 2027: frozen when the year closes.',
          ...stamp(T.nextStandard),
        },
        select,
      })
    }),
  )

  // --- SEED-WO-0001's cost ledger ----------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.workOrderCostEntry.findUnique({ where: { id: costEntryIds.material }, select })) return
      await tx.workOrderCostEntry.createMany({
        data: [
          {
            id: costEntryIds.material,
            companyId: companyA,
            siteId: siteA,
            workOrderId: production.workOrderId,
            kind: WorkOrderCostKind.MATERIAL,
            occurredAt: T.issued,
            itemId: item.leather,
            quantity: '53.2000',
            unitCost: '4.200000',
            standardUnitCost: '4.200000',
            amount: 22_344,
            currency: 'EUR',
            costingMethod: CostingMethod.UNDECIDED,
            standardCostId: standardCostIds.leather,
            stockMoveId: production.issueMoveId,
            idempotencyKey: `move:${production.issueMoveId}`,
            createdAt: T.issued,
            createdById: actorId,
          },
          {
            id: costEntryIds.labour,
            companyId: companyA,
            siteId: siteA,
            workOrderId: production.workOrderId,
            kind: WorkOrderCostKind.LABOUR,
            occurredAt: T.rescanned,
            minutes: LABOUR.minutes,
            unitCost: LABOUR.perMinute,
            amount: LABOUR.amount,
            currency: 'EUR',
            costingMethod: CostingMethod.UNDECIDED,
            operationScanId: production.scanIds[2],
            idempotencyKey: `scan:${production.scanIds[2]}`,
            createdAt: T.rescanned,
            createdById: actorId,
          },
        ],
      })
    }),
  )

  // --- P2's invoice through SDI, its lines and the three-way match --------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.supplierInvoice.findUnique({ where: { id: supplierInvoiceId }, select })) return
      await tx.supplierInvoice.create({
        data: {
          id: supplierInvoiceId,
          companyId: companyA,
          partyId: P2,
          source: SupplierInvoiceSource.SDI,
          kind: SupplierInvoiceKind.INVOICE,
          docType: 'TD01',
          number: '2026/0412',
          issueDate: DAY.supplierIssued,
          receivedOn: DAY.supplierReceived,
          sdiIdentifier: 'SEED-SDI-IN-0000001',
          sdiFileName: 'IT00000002022_00412.xml',
          netTotal: SUPPLIER.net,
          vatTotal: SUPPLIER.vat,
          grossTotal: SUPPLIER.net + SUPPLIER.vat,
          vatSummary: [{ rate: '22.00', nature: null, taxable: SUPPLIER.net, vat: SUPPLIER.vat }],
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: SUPPLIER.net + SUPPLIER.vat, dueDate: '2026-12-31' }] },
          dueDate: DAY.supplierDue,
          ...stamp(T.supplierInvoice),
        },
        select,
      })
      await tx.storedFile.createMany({ data: [supplierXml], skipDuplicates: true })
      await tx.supplierInvoiceLine.createMany({
        data: [
          {
            id: supplierLineIds.leather,
            partyId: P2,
            invoiceId: supplierInvoiceId,
            seq: 1,
            kind: SupplierInvoiceLineKind.GOODS,
            description: 'Pelle bovina nera, scelta A, 1,1-1,3 mm',
            itemCode: 'SEED-ART-100',
            quantity: '105.0000',
            uom: 'FT2',
            unitPrice: '4.300000',
            netAmount: SUPPLIER.leatherNet,
            vatRatePct: '22.00',
            siteId: siteA,
            purchaseOrderLineId: supply.leatherLineId,
            ...stamp(T.supplierInvoice),
          },
          {
            id: supplierLineIds.freight,
            partyId: P2,
            invoiceId: supplierInvoiceId,
            seq: 2,
            kind: SupplierInvoiceLineKind.CHARGE,
            description: 'Trasporto',
            quantity: '1.0000',
            unitPrice: '15.000000',
            netAmount: SUPPLIER.freightNet,
            vatRatePct: '22.00',
            ...stamp(T.supplierInvoice),
          },
        ],
      })
      await tx.supplierInvoiceMatch.create({
        data: {
          id: matchId,
          siteId: siteA,
          partyId: P2,
          invoiceId: supplierInvoiceId,
          invoiceLineId: supplierLineIds.leather,
          purchaseOrderLineId: supply.leatherLineId,
          goodsReceiptLineId: inventory.receiptLineId,
          invoicedQuantity: '105.0000',
          receivedQuantity: '105.0000',
          orderedUnitPrice: '4.200000',
          invoicedUnitPrice: '4.300000',
          differenceAmount: 1_050,
          quantityTolerancePct: '5.0000',
          priceTolerancePct: '2.0000',
          withinTolerance: false,
          ...stamp(T.matched),
        },
        select,
      })
      await tx.supplierInvoice.update({
        where: { id: supplierInvoiceId },
        data: { xmlFileId: supplierXml.id, matchStatus: SupplierInvoiceMatchStatus.DIFFERENCES, matchedAt: T.matched, version: 2, updatedAt: T.matched },
        select,
      })
    }),
  )

  // --- EXP-2026-0001: September, exported; then September locked ---------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.accountingExport.findUnique({ where: { id: exportedId }, select })) return
      await tx.accountingExport.create({
        data: {
          id: exportedId,
          companyId: companyA,
          periodStart: DAY.september.first,
          periodEnd: DAY.september.last,
          packages: [AccountingPackage.SALES_JOURNAL, AccountingPackage.PURCHASES_JOURNAL, AccountingPackage.PAYMENTS],
          checks: [
            { code: 'SHIPMENTS_INVOICED', passed: true },
            { code: 'NO_INVOICE_REJECTED', passed: true },
            { code: 'PAYMENTS_PLACED', passed: true },
            { code: 'TOTALS_EQUAL_ROWS', passed: true },
          ],
          manifest: [],
          note: 'The month before the first documents: empty journals (made up).',
          ...stamp(T.exportedSeptember),
        },
        select,
      })
      await tx.storedFile.createMany({ data: exportedFiles, skipDuplicates: true })
      await tx.accountingExportFile.createMany({
        data: exportedFiles.map((file, index) => ({
          id: exportedFileIds[index] as string,
          exportId: exportedId,
          seq: index + 1,
          package: [AccountingPackage.SALES_JOURNAL, AccountingPackage.PURCHASES_JOURNAL, AccountingPackage.PAYMENTS][index] as AccountingPackage,
          fileId: file.id as string,
          format: 'CSV',
          rowCount: 0,
          createdAt: T.exportedSeptember,
          createdById: actorId,
        })),
      })
      // The number, as allocateNumber gives it: the series' next value, its NumberAllocation row, the series moved on.
      await tx.numberAllocation.createMany({
        data: [
          {
            id: lastId('accounting:allocation:EXP-2026-0001'),
            companyId: companyA,
            seriesId: exportSeriesId,
            kind: 'ACCOUNTING_EXPORT',
            value: 1,
            formatted: `EXP-${YEAR}-0001`,
            documentDate: DAY.exportedSeptember,
            recordType: 'AccountingExport',
            recordId: exportedId,
            allocatedAt: T.exportedSeptember,
            allocatedById: actorId,
            requestId: 'seed-accounting-EXP-2026-0001',
          },
        ],
        skipDuplicates: true,
      })
      await tx.numberSeries.update({ where: { id: exportSeriesId }, data: { nextValue: 2, lastIssuedDate: DAY.exportedSeptember, updatedAt: T.exportedSeptember }, select })
      await tx.accountingExport.update({
        where: { id: exportedId },
        data: {
          status: AccountingExportStatus.EXPORTED,
          numberSeriesId: exportSeriesId,
          number: `EXP-${YEAR}-0001`,
          exportedAt: T.exportedSeptember,
          exportedById: actorId,
          version: 2,
          updatedAt: T.exportedSeptember,
        },
        select,
      })
      await tx.periodLock.create({
        data: {
          id: periodLockId,
          companyId: companyA,
          periodStart: DAY.september.first,
          periodEnd: DAY.september.last,
          level: PeriodLockLevel.HARD,
          exportId: exportedId,
          lockedAt: T.lockedSeptember,
          lockedById: actorId,
          note: 'Closed after EXP-2026-0001 (made up).',
          ...stamp(T.lockedSeptember),
        },
        select,
      })
    }),
  )

  // --- October's export, a DRAFT: the job wrote the sales journal so far ---------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.accountingExport.findUnique({ where: { id: draftExportId }, select })) return
      await tx.accountingExport.create({
        data: {
          id: draftExportId,
          companyId: companyA,
          periodStart: DAY.october.first,
          periodEnd: DAY.october.last,
          packages: [AccountingPackage.SALES_JOURNAL, AccountingPackage.PURCHASES_JOURNAL, AccountingPackage.PAYMENTS, AccountingPackage.INTRASTAT],
          checks: [
            { code: 'SHIPMENTS_INVOICED', passed: false },
            { code: 'NO_INVOICE_REJECTED', passed: true },
          ],
          manifest: [
            { recordType: 'Invoice', recordId: money.sampleInvoiceId, number: `FT-${YEAR}-00001`, change: 'NEW' },
            { recordType: 'Invoice', recordId: money.depositInvoiceId, number: `FT-${YEAR}-00003`, change: 'NEW' },
          ],
          ...stamp(T.draftedOctober),
        },
        select,
      })
      await tx.storedFile.createMany({ data: [draftFile], skipDuplicates: true })
      await tx.accountingExportFile.create({
        data: {
          id: draftFileId,
          exportId: draftExportId,
          seq: 1,
          package: AccountingPackage.SALES_JOURNAL,
          fileId: draftFile.id as string,
          format: 'CSV',
          rowCount: 2,
          createdAt: T.draftedOctober,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  return {
    money,
    standardCostIds,
    costEntryIds,
    supplierInvoiceId,
    supplierLineIds,
    matchId,
    supplierXmlFileId: supplierXml.id as string,
    exportedId,
    exportedFileIds,
    draftExportId,
    draftFileId,
    periodLockId,
    exportSeriesId,
  }
}
