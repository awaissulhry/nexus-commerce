import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  ApprovalTaskKind,
  ApprovalTaskStatus,
  CreditCheckResult,
  CreditCheckStep,
  DepositFiscalDocument,
  DepositKind,
  GeneratedDocumentKind,
  GoodsReceiptKind,
  GoodsReceiptStatus,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  LotQualityStatus,
  OrderFreezeAction,
  OrderFreezeField,
  OrderFreezeStage,
  PartyTaxMode,
  SalesLineKind,
  SalesOrderPriority,
  SalesOrderStatus,
  StockMoveReason,
  Uom,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedFiles } from './files'
import { seed as seedInventory } from './inventory'
import { seed as seedOptions } from './options'
import { seed as seedRoles } from './roles'
import { seed as seedSales } from './sales'

/**
 * The orders, credit and changes seed (W2b-5, schema wave 39/44, B-W2b-281), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the orders module (B-W2b-303, -304, -309) will write it. The CLI runs the seed files in name order;
 * this one runs the auth and roles seeds (the owner, the member, the role templates), the files seed (the file store), the
 * options seed (SEED-JKT-05 for the brand P1, whose woven label P1 sends: a customer-supplied BOM line), the sales seed
 * (SEED-Q-0001 and its accepted version) and the inventory seed (site A1's places) first, all idempotent.
 *
 *   freeze rules  company A: sizes and quantities need a priced change request from cutting and are blocked from finishing;
 *                 the colourway a change request from release, blocked from cutting; options a change request from cutting;
 *                 prices a change request from release; dates and the ship-to blocked once something shipped; and an old
 *                 rule switched off (ship-to blocked from cutting: the first row).
 *   orders        SEED-SO-W39-02 for P1 (typed by the office, IN_PRODUCTION, HIGH): over P1's made-up limit at its making, so
 *                 its ORDER check was a HOLD; the member asked a CREDIT_OVERRIDE, the Owner said yes, and an override check
 *                 names both; its confirmation (version 1, a PDF of the order) was sent; after cutting started the brand asked
 *                 one more jacket in 52: amendment 1 is priced (the extra jacket, a set-up fee), asks an extra deposit of 30 %
 *                 of what the order grew by, and asks the yes again (a SALES_ORDER_CHANGE request, PENDING).
 *                 SEED-SO-W39-01 for P1 (typed, URGENT with its reason): over the limit again, so it waits for a yes
 *                 (PENDING_APPROVAL): its HOLD check and the member's CREDIT_OVERRIDE request for Finance, PENDING.
 *   credit        P1's PASS at the quote SEED-Q-0001 (the first row: it overrides nothing), the two HOLDs and the override.
 *   materials     P1's woven labels expected for both orders' jacket lines, per size from the BOM (one a piece); nothing
 *                 received yet (the label is an untracked item: see the notes).
 *   owned stock   SEED-GR-W39-01, a CUSTOMER_SUPPLIED receipt from P1 at A1: 30 m of the brand's own lining (SEED-LIN-W39, a lot
 *                 item of its own), lot SEED-LOT-W39-01 owned by P1, RELEASED, posted into A1-STORE-01 with its RECEIPT move
 *                 and no valuation (customer-owned stock is never valued).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first rows of the new tables (ids starting with eight zeros, still derived from the namespace) are ones a copy may
 * repeat: the switched-off freeze rule, the PASS check, the material of the waiting order. Rows of earlier tables (orders,
 * lines, the deposit request, the amendment, the requests for a yes, the file, the document, the item, the receipt, the lot
 * and the move) get ids that start with eight f's, so they are never another table's first row. The caparra penitenziale stays
 * switched off (no sales settings row changes). Every name, number, amount and time is made up. Idempotent: written once,
 * skipped when its first row exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (every one before the day the wave was built). */
const T = {
  rules: new Date('2026-11-02T08:00:00.000Z'),
  quoteChecked: new Date('2026-11-03T09:00:00.000Z'),
  ordered2: new Date('2026-11-04T08:00:00.000Z'),
  held2: new Date('2026-11-04T08:05:00.000Z'),
  overrideAsked: new Date('2026-11-04T08:10:00.000Z'),
  overrideApproved: new Date('2026-11-04T09:00:00.000Z'),
  overrideChecked: new Date('2026-11-04T09:05:00.000Z'),
  confirmed: new Date('2026-11-04T10:00:00.000Z'),
  amended: new Date('2026-11-06T09:00:00.000Z'),
  received: new Date('2026-11-07T09:00:00.000Z'),
  ordered1: new Date('2026-11-09T08:00:00.000Z'),
  held1: new Date('2026-11-09T08:05:00.000Z'),
  asked1: new Date('2026-11-09T08:15:00.000Z'),
} as const
const DAY = {
  ordered2: new Date('2026-11-04T00:00:00.000Z'),
  ordered1: new Date('2026-11-09T00:00:00.000Z'),
  promise2: new Date('2026-12-11T00:00:00.000Z'),
  promise1: new Date('2026-11-27T00:00:00.000Z'),
  depositDue: new Date('2026-11-16T00:00:00.000Z'),
  ddt: new Date('2026-11-06T00:00:00.000Z'),
} as const
const HOUR = 3_600_000

/** The jacket's price (EUR) and VAT; amounts below are in cents. */
const UNIT = '480.000000'
const UNIT_CENTS = 48_000
const VAT = '22.00'
const vatOf = (net: number): number => Math.round(net * 0.22)

/** The sizes of each order line: SEED-SO-W39-02 before and after its amendment, SEED-SO-W39-01. */
const SIZES = {
  before2: { '50': 2, '52': 2, '54': 2 },
  after2: { '50': 2, '52': 3, '54': 2 },
  order1: { '50': 1, '52': 2, '54': 1 },
} as const
const pieces = (sizes: Readonly<Record<string, number>>): number => Object.values(sizes).reduce((sum, value) => sum + value, 0)
const bySize = (sizes: Readonly<Record<string, number>>): Record<string, string> => Object.fromEntries(Object.entries(sizes).map(([size, quantity]) => [size, `${quantity}.0000`]))

export interface SalesOrdersDepthSeed {
  readonly companyA: string
  readonly partyId: string
  readonly ownerId: string
  readonly memberId: string
  readonly freezeRuleIds: { readonly off: string; readonly sizeCut: string; readonly sizeFinished: string; readonly colourReleased: string; readonly colourCut: string }
  /** SEED-SO-W39-01 (PENDING_APPROVAL) and SEED-SO-W39-02 (IN_PRODUCTION), each with its jacket line. */
  readonly waitingOrderId: string
  readonly waitingLineId: string
  readonly orderId: string
  readonly lineId: string
  readonly amendmentId: string
  readonly extraDepositId: string
  readonly confirmationId: string
  readonly checkIds: { readonly pass: string; readonly hold2: string; readonly override2: string; readonly hold1: string }
  readonly taskIds: { readonly override2: string; readonly reapproval2: string; readonly override1: string }
  readonly materialIds: { readonly waiting: string; readonly order: string }
  readonly jacket: { readonly styleId: string; readonly revisionId: string; readonly colourwayId: string; readonly labelLineId: string; readonly labelItemId: string }
  /** The customer's own lining: the item, the receipt, its line, the owned lot and its RECEIPT move. */
  readonly owned: { readonly itemId: string; readonly receiptId: string; readonly receiptLineId: string; readonly lotId: string; readonly moveId: string; readonly locationId: string }
}

export async function seed(context: SeedContext): Promise<SalesOrdersDepthSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const { roleIds } = await seedRoles(context)
  await seedFiles(context)
  const options = await seedOptions(context)
  const sales = await seedSales(context)
  const inventory = await seedInventory(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const partyId = id('party:P1')
  const office = { audience: 'office', tenantId, actorId: ownerId } as const
  const select = { id: true } as const
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

  const result: SalesOrdersDepthSeed = {
    companyA,
    partyId,
    ownerId,
    memberId,
    freezeRuleIds: {
      off: firstId('orders-depth:freeze:A:SHIP_TO:CUT'),
      sizeCut: id('orders-depth:freeze:A:SIZE_QUANTITY:CUT'),
      sizeFinished: id('orders-depth:freeze:A:SIZE_QUANTITY:FINISHED'),
      colourReleased: id('orders-depth:freeze:A:COLOURWAY:RELEASED'),
      colourCut: id('orders-depth:freeze:A:COLOURWAY:CUT'),
    },
    waitingOrderId: lastId('orders-depth:SO-W39-01'),
    waitingLineId: lastId('orders-depth:SO-W39-01:line:10'),
    orderId: lastId('orders-depth:SO-W39-02'),
    lineId: lastId('orders-depth:SO-W39-02:line:10'),
    amendmentId: lastId('orders-depth:SO-W39-02:amendment:1'),
    extraDepositId: lastId('orders-depth:SO-W39-02:deposit:extra'),
    confirmationId: lastId('orders-depth:SO-W39-02:confirmation:1'),
    checkIds: {
      pass: firstId('orders-depth:credit:Q-0001'),
      hold2: id('orders-depth:credit:SO-W39-02:hold'),
      override2: id('orders-depth:credit:SO-W39-02:override'),
      hold1: id('orders-depth:credit:SO-W39-01:hold'),
    },
    taskIds: {
      override2: lastId('orders-depth:task:SO-W39-02:override'),
      reapproval2: lastId('orders-depth:task:SO-W39-02:reapproval'),
      override1: lastId('orders-depth:task:SO-W39-01:override'),
    },
    materialIds: { waiting: firstId('orders-depth:material:SO-W39-01:label'), order: id('orders-depth:material:SO-W39-02:label') },
    jacket: {
      styleId: options.jacketStyleId,
      revisionId: options.jacketRevisionId,
      colourwayId: id('options:colourway:JKT-05:BLK'),
      labelLineId: options.bomLineIds.label,
      labelItemId: options.itemIds.label,
    },
    owned: {
      itemId: lastId('orders-depth:item:LIN-W39'),
      receiptId: lastId('orders-depth:receipt:GR-W39-01'),
      receiptLineId: lastId('orders-depth:receipt:GR-W39-01:line:10'),
      lotId: lastId('orders-depth:lot:LOT-W39-01'),
      moveId: lastId('orders-depth:move:GR-W39-01'),
      locationId: inventory.locations.bin,
    },
  }
  const { freezeRuleIds: F, checkIds: C, taskIds: K, jacket, owned } = result

  if (await db.withScope(office, (client) => client.orderFreezeRule.findUnique({ where: { id: F.off }, select }))) return result

  const billTo = {
    legalName: 'Seed Customer One S.r.l.',
    kind: 'ORGANISATION',
    country: 'IT',
    taxMode: 'IT_B2B',
    vatNumber: 'IT00000001016',
    fiscalCode: '00000001016',
    sdiRecipientCode: 'SEEDC01',
    address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
  }
  const shipTo = { name: 'Seed Racing workshop', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' }
  const net = (sizes: Readonly<Record<string, number>>): number => pieces(sizes) * UNIT_CENTS
  const gross = (sizes: Readonly<Record<string, number>>): number => net(sizes) + vatOf(net(sizes))

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- What freezes on company A's orders at each stage (the first row switched off) -----------------------------------
      const rule = (
        rowId: string,
        field: OrderFreezeField,
        frozenFrom: OrderFreezeStage,
        action: OrderFreezeAction,
        extra: { active?: boolean; note?: string } = {},
      ): Prisma.OrderFreezeRuleCreateManyInput => ({ id: rowId, companyId: companyA, field, frozenFrom, action, ...extra, updatedById: ownerId, createdAt: T.rules, updatedAt: T.rules, createdById: ownerId })
      await tx.orderFreezeRule.createMany({
        data: [
          rule(F.off, OrderFreezeField.SHIP_TO, OrderFreezeStage.CUT, OrderFreezeAction.BLOCKED, { active: false, note: 'Old rule: the ship-to froze at cutting (switched off).' }),
          rule(F.sizeCut, OrderFreezeField.SIZE_QUANTITY, OrderFreezeStage.CUT, OrderFreezeAction.CHANGE_REQUEST, { note: 'Cutting started: size frozen' }),
          rule(F.sizeFinished, OrderFreezeField.SIZE_QUANTITY, OrderFreezeStage.FINISHED, OrderFreezeAction.BLOCKED),
          rule(F.colourReleased, OrderFreezeField.COLOURWAY, OrderFreezeStage.RELEASED, OrderFreezeAction.CHANGE_REQUEST),
          rule(F.colourCut, OrderFreezeField.COLOURWAY, OrderFreezeStage.CUT, OrderFreezeAction.BLOCKED, { note: 'The leather is cut in this colour' }),
          rule(id('orders-depth:freeze:A:OPTION:CUT'), OrderFreezeField.OPTION, OrderFreezeStage.CUT, OrderFreezeAction.CHANGE_REQUEST),
          rule(id('orders-depth:freeze:A:PRICE:RELEASED'), OrderFreezeField.PRICE, OrderFreezeStage.RELEASED, OrderFreezeAction.CHANGE_REQUEST),
          rule(id('orders-depth:freeze:A:DELIVERY_DATE:SHIPPED'), OrderFreezeField.DELIVERY_DATE, OrderFreezeStage.SHIPPED, OrderFreezeAction.BLOCKED),
          rule(id('orders-depth:freeze:A:SHIP_TO:SHIPPED'), OrderFreezeField.SHIP_TO, OrderFreezeStage.SHIPPED, OrderFreezeAction.BLOCKED),
        ],
      })

      // --- The two orders, typed by the office, with the jacket's line --------------------------------------------------
      const order = (rowId: string, number: string, at: Date, data: Partial<Prisma.SalesOrderUncheckedCreateInput> & { sizes: Readonly<Record<string, number>> }) => {
        const { sizes, ...rest } = data
        return tx.salesOrder.create({
          data: {
            id: rowId,
            companyId: companyA,
            partyId,
            number,
            orderDate: at,
            currency: 'EUR',
            language: 'it',
            taxMode: PartyTaxMode.IT_B2B,
            billTo,
            shipTo,
            paymentTerms: 'Balance at delivery (made-up)',
            netAmount: net(sizes),
            vatAmount: vatOf(net(sizes)),
            grossAmount: gross(sizes),
            ...rest,
            createdAt: at,
            updatedAt: at,
            createdById: memberId,
          },
          select,
        })
      }
      const line = async (orderId: string, lineId: string, sizes: Readonly<Record<string, number>>, at: Date) => {
        await tx.salesOrderLine.create({
          data: {
            id: lineId,
            companyId: companyA,
            orderId,
            partyId,
            seq: 10,
            kind: SalesLineKind.SIZE_GRID,
            styleId: jacket.styleId,
            colourwayId: jacket.colourwayId,
            description: 'SEED-JKT-05 BLK',
            quantity: pieces(sizes),
            unitPrice: UNIT,
            netAmount: net(sizes),
            vatRatePct: VAT,
            vatAmount: vatOf(net(sizes)),
            siteId: siteA,
            createdAt: at,
            updatedAt: at,
            createdById: memberId,
          },
          select,
        })
        await tx.salesOrderLineSize.createMany({
          data: Object.entries(sizes).map(([size, quantity]) => ({ id: lastId(`orders-depth:${lineId}:${size}`), lineId, partyId, size, quantity, createdAt: at, updatedAt: at, createdById: memberId })),
        })
      }
      await order(result.orderId, 'SEED-SO-W39-02', DAY.ordered2, {
        sizes: SIZES.after2,
        status: SalesOrderStatus.IN_PRODUCTION,
        customerRef: 'SEED-PO-W39-2',
        promiseDate: DAY.promise2,
        originalPromiseDate: DAY.promise2,
        priorityLevel: SalesOrderPriority.HIGH,
      })
      await line(result.orderId, result.lineId, SIZES.after2, T.ordered2)
      await order(result.waitingOrderId, 'SEED-SO-W39-01', DAY.ordered1, {
        sizes: SIZES.order1,
        status: SalesOrderStatus.PENDING_APPROVAL,
        customerRef: 'SEED-PO-W39-1',
        promiseDate: DAY.promise1,
        priorityLevel: SalesOrderPriority.URGENT,
        urgentReason: 'The brand moved its launch event a week forward (made-up).',
      })
      await line(result.waitingOrderId, result.waitingLineId, SIZES.order1, T.ordered1)

      // --- Credit: P1's checks with company A (the first row a PASS at the quote) ----------------------------------------
      const check = (rowId: string, at: Date, data: Omit<Prisma.CreditCheckCreateManyInput, 'id' | 'companyId' | 'partyId' | 'checkedAt' | 'createdAt' | 'exposureAmount'>): Prisma.CreditCheckCreateManyInput => ({
        id: rowId,
        companyId: companyA,
        partyId,
        ...data,
        exposureAmount: data.openOrdersAmount + data.openInvoicesAmount + (data.subjectAmount ?? 0),
        checkedAt: at,
        createdAt: at,
      })
      const limit = 1_500_000
      await tx.creditCheck.createMany({
        data: [
          check(C.pass, T.quoteChecked, {
            step: CreditCheckStep.QUOTE,
            recordType: 'QuoteVersion',
            recordId: sales.acceptedVersionId,
            openOrdersAmount: 120_000,
            openInvoicesAmount: 50_000,
            overdueAmount: 0,
            subjectAmount: 512_400,
            limitAmount: limit,
            result: CreditCheckResult.PASS,
            requestId: `seed-orders-depth-${namespace}-quote-check`,
            createdById: memberId,
          }),
          check(C.hold2, T.held2, {
            step: CreditCheckStep.ORDER,
            recordType: 'SalesOrder',
            recordId: result.orderId,
            openOrdersAmount: 980_000,
            openInvoicesAmount: 260_000,
            overdueAmount: 0,
            subjectAmount: gross(SIZES.before2),
            limitAmount: limit,
            result: CreditCheckResult.HOLD,
            words: 'Over the limit by 913.60 EUR (made-up)',
            requestId: `seed-orders-depth-${namespace}-order-2`,
            createdById: memberId,
          }),
        ],
      })

      // The member asks a yes over the limit; the Owner (never the person who asked) says yes; the override check names both.
      const task = (rowId: string, at: Date, data: Omit<Prisma.ApprovalTaskCreateManyInput, 'id' | 'companyId' | 'fingerprint' | 'requestedAt' | 'createdAt' | 'updatedAt' | 'createdById' | 'requestedById'>): Prisma.ApprovalTaskCreateManyInput => ({
        id: rowId,
        companyId: companyA,
        ...data,
        fingerprint: sha256(`seed orders depth ${namespace} ${rowId} ${JSON.stringify(data.preview)}`),
        requestedById: memberId,
        requestedAt: at,
        createdAt: at,
        updatedAt: at,
        createdById: memberId,
      })
      await tx.approvalTask.createMany({
        data: [
          task(K.override2, T.overrideAsked, {
            kind: ApprovalTaskKind.CREDIT_OVERRIDE,
            recordType: 'CreditCheck',
            recordId: C.hold2,
            ruleIds: [],
            summary: 'SEED-SO-W39-02 over the credit limit of P1 (made-up)',
            preview: { changes: [{ field: 'creditHold', from: true, to: false }], facts: [{ field: 'overLimitBy', value: '913.60', grain: 'price' }] },
            approverRoleId: roleIds.finance,
            dueAt: new Date(T.overrideAsked.getTime() + 24 * HOUR),
          }),
        ],
      })
      await tx.approvalTask.update({
        where: { id: K.override2 },
        data: { status: ApprovalTaskStatus.APPROVED, decidedAt: T.overrideApproved, decidedById: ownerId, comment: 'A good payer; the overdue was paid this morning (made-up).', version: { increment: 1 }, updatedAt: T.overrideApproved },
        select,
      })
      await tx.creditCheck.create({
        data: check(C.override2, T.overrideChecked, {
          step: CreditCheckStep.ORDER,
          recordType: 'SalesOrder',
          recordId: result.orderId,
          openOrdersAmount: 980_000,
          openInvoicesAmount: 260_000,
          overdueAmount: 0,
          subjectAmount: gross(SIZES.before2),
          limitAmount: limit,
          result: CreditCheckResult.HOLD,
          words: 'Overridden with a yes (made-up)',
          overridesCheckId: C.hold2,
          overrideTaskId: K.override2,
          requestId: `seed-orders-depth-${namespace}-override-2`,
          createdById: ownerId,
        }),
        select,
      })

      // --- SEED-SO-W39-02's confirmation: version 1, a PDF of the order, sent ---------------------------------------------
      const confirmationSha = sha256(`seed order confirmation SEED-SO-W39-02 version 1 (${namespace})`)
      const confirmationFile = lastId('orders-depth:SO-W39-02:confirmation:1:file')
      await tx.storedFile.create({
        data: {
          id: confirmationFile,
          companyId: companyA,
          recordType: 'SalesOrder',
          recordId: result.orderId,
          kind: 'DOCUMENT',
          originalName: 'SEED-SO-W39-02 confirmation v1.pdf',
          contentType: 'application/pdf',
          sizeBytes: 3072,
          sha256: confirmationSha,
          storeAccountId: id('files:account:r2'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('orders-depth:SO-W39-02:confirmation:1:key')}`,
          status: 'AVAILABLE',
          availableAt: T.confirmed,
          visibility: ['OFFICE'],
          createdAt: T.confirmed,
          updatedAt: T.confirmed,
          createdById: memberId,
        },
        select,
      })
      await tx.generatedDocument.create({
        data: {
          id: result.confirmationId,
          companyId: companyA,
          recordType: 'SalesOrder',
          recordId: result.orderId,
          kind: GeneratedDocumentKind.ORDER_CONFIRMATION,
          version: 1,
          fingerprint: confirmationSha,
          language: 'it',
          number: 'SEED-SO-W39-02',
          fileId: confirmationFile,
          createdAt: T.confirmed,
          createdById: memberId,
        },
        select,
      })
      await tx.salesOrder.update({ where: { id: result.orderId }, data: { confirmationSentAt: T.confirmed, confirmationVersion: 1, version: { increment: 1 }, updatedAt: T.confirmed }, select })

      // --- After cutting started: one more jacket in 52, priced, an extra deposit, the yes asked again ----------------------
      await tx.depositRequest.create({
        data: {
          id: result.extraDepositId,
          companyId: companyA,
          partyId,
          orderId: result.orderId,
          kind: DepositKind.ACCONTO,
          depositPct: '30.0000',
          currency: 'EUR',
          amount: Math.round((gross(SIZES.after2) - gross(SIZES.before2)) * 0.3),
          dueDate: DAY.depositDue,
          fiscalDocument: DepositFiscalDocument.TD02,
          fiscalRule: 'seed.deposit.IT_B2B.v1',
          createdAt: T.amended,
          updatedAt: T.amended,
          createdById: memberId,
        },
        select,
      })
      await tx.approvalTask.createMany({
        data: [
          task(K.reapproval2, T.amended, {
            kind: ApprovalTaskKind.SALES_ORDER_CHANGE,
            recordType: 'SalesOrder',
            recordId: result.orderId,
            ruleIds: [],
            summary: 'SEED-SO-W39-02: one more jacket after cutting started, asks the yes again (made-up)',
            preview: { changes: [{ field: 'quantity', from: '6', to: '7' }], facts: [{ field: 'orderValue', value: '3360.00', grain: 'price' }] },
            approverRoleId: roleIds.owner,
            dueAt: new Date(T.amended.getTime() + 48 * HOUR),
          }),
          task(K.override1, T.asked1, {
            kind: ApprovalTaskKind.CREDIT_OVERRIDE,
            recordType: 'CreditCheck',
            recordId: C.hold1,
            ruleIds: [],
            summary: 'SEED-SO-W39-01 over the credit limit of P1, urgent (made-up)',
            preview: { changes: [{ field: 'creditHold', from: true, to: false }], facts: [{ field: 'overLimitBy', value: '1342.40', grain: 'price' }] },
            approverRoleId: roleIds.finance,
            dueAt: new Date(T.asked1.getTime() + 24 * HOUR),
          }),
        ],
      })
      const snapshot = (sizes: Readonly<Record<string, number>>) => ({
        header: { promiseDate: '2026-12-11', requestedDate: null, paymentTerms: 'Balance at delivery (made-up)', netAmount: net(sizes), vatAmount: vatOf(net(sizes)), grossAmount: gross(sizes) },
        lines: [
          {
            id: result.lineId,
            seq: 10,
            kind: 'SIZE_GRID',
            styleId: jacket.styleId,
            colourwayId: jacket.colourwayId,
            description: 'SEED-JKT-05 BLK',
            quantity: pieces(sizes),
            unitPrice: UNIT,
            netAmount: net(sizes),
            vatRatePct: VAT,
            sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity, unitPrice: null })),
          },
        ],
      })
      await tx.salesOrderAmendment.create({
        data: {
          id: result.amendmentId,
          companyId: companyA,
          orderId: result.orderId,
          partyId,
          revision: 1,
          reason: 'The brand asked one more jacket in 52 after cutting started (made-up).',
          before: snapshot(SIZES.before2),
          after: snapshot(SIZES.after2),
          netAmountBefore: net(SIZES.before2),
          netAmountAfter: net(SIZES.after2),
          grossAmountBefore: gross(SIZES.before2),
          grossAmountAfter: gross(SIZES.after2),
          reacceptanceNeeded: false,
          priceDeltaLines: [{ label: 'One more jacket in 52, cut on its own', orderLineId: result.lineId, amount: UNIT_CENTS }],
          feeAmount: 2_500,
          depositRequestId: result.extraDepositId,
          reapprovalTaskId: K.reapproval2,
          requestId: `seed-orders-depth-${namespace}-amendment-1`,
          createdAt: T.amended,
          createdById: memberId,
        },
        select,
      })

      // --- SEED-SO-W39-01 waits: over the limit again; the member's request for a yes waits for Finance ---------------------
      await tx.creditCheck.create({
        data: check(C.hold1, T.held1, {
          step: CreditCheckStep.ORDER,
          recordType: 'SalesOrder',
          recordId: result.waitingOrderId,
          openOrdersAmount: 1_140_000,
          openInvoicesAmount: 260_000,
          overdueAmount: 80_000,
          subjectAmount: gross(SIZES.order1),
          limitAmount: limit,
          result: CreditCheckResult.HOLD,
          words: 'Over the limit by 1,342.40 EUR; 800.00 EUR overdue (made-up)',
          requestId: `seed-orders-depth-${namespace}-order-1`,
          createdById: memberId,
        }),
        select,
      })

      // --- The labels P1 sends for both jacket lines: one a piece, per size from the BOM ---------------------------------
      const material = (rowId: string, orderId: string, orderLineId: string, sizes: Readonly<Record<string, number>>, at: Date, note?: string): Prisma.CustomerMaterialCreateManyInput => ({
        id: rowId,
        companyId: companyA,
        partyId,
        orderId,
        orderLineId,
        bomRevisionId: jacket.revisionId,
        bomLineId: jacket.labelLineId,
        itemId: jacket.labelItemId,
        uom: Uom.PCS,
        expectedQuantity: `${pieces(sizes)}.0000`,
        expectedBySize: bySize(sizes),
        ...(note ? { note } : {}),
        updatedById: memberId,
        createdAt: at,
        updatedAt: at,
        createdById: memberId,
      })
      await tx.customerMaterial.createMany({
        data: [
          material(result.materialIds.waiting, result.waitingOrderId, result.waitingLineId, SIZES.order1, T.ordered1),
          material(result.materialIds.order, result.orderId, result.lineId, SIZES.after2, T.amended, 'Seven labels expected after amendment 1 (made-up).'),
        ],
      })

      // --- The brand's own lining, received from P1: customer-owned stock, never valued --------------------------------------
      await tx.item.create({
        data: {
          id: owned.itemId,
          code: 'SEED-LIN-W39',
          name: "Seed brand's own lining (sent by the brand)",
          kind: ItemKind.LINING,
          sourcing: ItemSourcing.BUY,
          tracking: ItemTracking.LOT,
          baseUom: Uom.M,
          purchaseUom: Uom.M,
          consumptionUom: Uom.M,
          composition: [{ fibre: 'polyester', percent: '100' }],
          createdAt: T.received,
          updatedAt: T.received,
          createdById: ownerId,
        },
        select,
      })
      await tx.goodsReceipt.create({
        data: {
          id: owned.receiptId,
          companyId: companyA,
          siteId: siteA,
          number: 'SEED-GR-W39-01',
          kind: GoodsReceiptKind.CUSTOMER_SUPPLIED,
          supplierId: partyId,
          supplierDdtNumber: 'SEED-DDT-P1-39',
          supplierDdtDate: DAY.ddt,
          receivedAt: T.received,
          note: "The brand's lining for its next orders (made-up).",
          createdAt: T.received,
          updatedAt: T.received,
          createdById: memberId,
        },
        select,
      })
      await tx.goodsReceiptLine.create({
        data: { id: owned.receiptLineId, siteId: siteA, receiptId: owned.receiptId, seq: 10, itemId: owned.itemId, quantity: '30.0000', uom: Uom.M, baseQuantity: '30.0000', createdAt: T.received, updatedAt: T.received, createdById: memberId },
        select,
      })
      await tx.lot.create({
        data: {
          id: owned.lotId,
          companyId: companyA,
          siteId: siteA,
          itemId: owned.itemId,
          code: 'SEED-LOT-W39-01',
          ownerPartyId: partyId,
          supplierLotRef: 'P1-LIN-0039',
          receiptLineId: owned.receiptLineId,
          receivedAt: T.received,
          qualityStatus: LotQualityStatus.RELEASED,
          qualityNote: "The brand's own lining: checked on arrival (made-up).",
          qualityDecidedAt: T.received,
          qualityDecidedById: memberId,
          createdAt: T.received,
          updatedAt: T.received,
          createdById: memberId,
        },
        select,
      })
      await tx.stockMove.create({
        data: {
          id: owned.moveId,
          companyId: companyA,
          siteId: siteA,
          reason: StockMoveReason.RECEIPT,
          itemId: owned.itemId,
          lotId: owned.lotId,
          toLocationId: owned.locationId,
          quantity: '30.0000',
          uom: Uom.M,
          baseQuantity: '30.0000',
          receiptLineId: owned.receiptLineId,
          reference: 'SEED-DDT-P1-39',
          idempotencyKey: `seed-orders-depth-${namespace}-GR-W39-01`,
          occurredAt: T.received,
          createdAt: T.received,
          createdById: memberId,
        },
        select,
      })
      await tx.goodsReceipt.update({
        where: { id: owned.receiptId },
        data: { status: GoodsReceiptStatus.POSTED, postedAt: T.received, postedById: memberId, version: { increment: 1 }, updatedAt: T.received },
        select,
      })
    }),
  )
  return result
}
