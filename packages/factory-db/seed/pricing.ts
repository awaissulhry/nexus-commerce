import type { Prisma } from '../src/generated/prisma/client'
import { PartyInvoiceTiming, PriceListKind, PriceListVersionStatus, SalesMilestoneKind, SalesMilestoneStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedMoney, type MoneySeed } from './money'
import { seed as seedProduct, type ProductSeed } from './product'

/**
 * The pricing seed (W2a schema wave 2/7), per tenant of seed/_core.ts, written in the tenant's office scope as the app
 * does:
 *
 *   payment terms  the tenant-wide library: BB30FM (bank transfer, 30 days end of month), BB60 (bank transfer, 60 days
 *                  from the invoice), CONSEGNA (bank transfer on delivery) and DEP30 (30% on the order, the balance before
 *                  shipping).
 *   price lists    company A's base list SEED-PL-BASE (version 1 ACTIVE from 2026-10-01: SEED-JKT-01 450.00,
 *                  SEED-JKT-02 410.00) and P1's list SEED-PL-P1 over it (version 1 ACTIVE from 2026-10-01: SEED-JKT-01
 *                  420.00, its RED colourway 430.00; version 2 a DRAFT for the next season: SEED-JKT-01 435.00).
 *   P1             its commercial terms: DEP30, SEED-PL-P1, a 30% deposit, invoiced monthly, DAP, a 1000.00 minimum order.
 *   SEED-Q-0002    the DRAFT quote keeps P1's terms and the list version its prices came from.
 *   SEED-SO-0001   sold on DEP30; its payment schedule: the 30% deposit (its deposit request, PAID by the money seed) and
 *                  the 70% balance before shipping (OPEN); amendment 1: the customer moved its requested date (no money
 *                  change, no new acceptance).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a price list version starts as a DRAFT and only a DRAFT's prices are written, a schedule step starts OPEN. So
 * SEED-PL-P1's DRAFT version 2, its entry and SEED-SO-0001's OPEN balance step get ids that start with eight zeros
 * (still derived from the namespace).
 *
 * Every name, number and amount is invented. Idempotent: rows are inserted once (skipped when they exist; an ACTIVE
 * version's prices and an amendment never change), the commercial terms written again with the same values.
 */

const T = {
  setup: new Date('2026-10-01T07:00:00.000Z'),
  activated: new Date('2026-10-01T07:30:00.000Z'),
  nextSeason: new Date('2026-10-29T09:00:00.000Z'),
  ordered: new Date('2026-10-30T08:00:00.000Z'),
  amended: new Date('2026-10-30T10:00:00.000Z'),
} as const
const DAY = {
  listsFrom: new Date('2026-10-01T00:00:00.000Z'),
  requestedBefore: '2026-12-10',
  requestedAfter: '2026-12-15',
} as const

export interface PricingSeed {
  readonly money: MoneySeed
  readonly product: ProductSeed
  /** The library: BB30FM, BB60, CONSEGNA, DEP30. */
  readonly paymentTermsIds: { readonly BB30FM: string; readonly BB60: string; readonly CONSEGNA: string; readonly DEP30: string }
  readonly baseListId: string
  readonly customerListId: string
  /** SEED-PL-P1's ACTIVE version 1 and DRAFT version 2. */
  readonly activeVersionId: string
  readonly draftVersionId: string
  /** SEED-SO-0001's schedule (deposit, balance) and its amendment 1. */
  readonly milestoneIds: readonly [string, string]
  readonly amendmentId: string
}

export async function seed(context: SeedContext): Promise<PricingSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the order, its deposit (paid) and the styles come from these (idempotent).
  const money = await seedMoney(context)
  const product = await seedProduct(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const jacket02 = money.shipping.quality.production.styleId
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const

  const terms = { BB30FM: id('pricing:terms:BB30FM'), BB60: id('pricing:terms:BB60'), CONSEGNA: id('pricing:terms:CONSEGNA'), DEP30: id('pricing:terms:DEP30') }
  const paymentTerms: Prisma.PaymentTermsCreateManyInput[] = [
    {
      id: terms.BB30FM,
      code: 'BB30FM',
      name: 'Bonifico bancario 30 gg d.f.f.m.',
      nameI18n: { en: 'Bank transfer 30 days end of month' },
      method: 'MP05',
      instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 30, endOfMonth: true }],
      ...stamp(T.setup),
    },
    {
      id: terms.BB60,
      code: 'BB60',
      name: 'Bonifico bancario 60 gg data fattura',
      nameI18n: { en: 'Bank transfer 60 days from the invoice date' },
      method: 'MP05',
      instalments: [{ sharePct: '100.0000', from: 'INVOICE', days: 60 }],
      earlyPaymentDiscountPct: '2.0000',
      earlyPaymentDays: 10,
      ...stamp(T.setup),
    },
    {
      id: terms.CONSEGNA,
      code: 'CONSEGNA',
      name: 'Bonifico alla consegna',
      nameI18n: { en: 'Bank transfer on delivery' },
      method: 'MP05',
      instalments: [{ sharePct: '100.0000', from: 'DELIVERY', days: 0 }],
      ...stamp(T.setup),
    },
    {
      id: terms.DEP30,
      code: 'DEP30',
      name: "30% all'ordine, saldo prima della spedizione",
      nameI18n: { en: '30% with the order, the balance before shipping' },
      method: 'MP05',
      instalments: [
        { sharePct: '30.0000', from: 'ORDER', days: 0 },
        { sharePct: '70.0000', from: 'BEFORE_SHIPPING', days: 0 },
      ],
      ...stamp(T.setup),
    },
  ]

  const baseListId = id('pricing:list:BASE')
  const customerListId = id('pricing:list:P1')
  const baseVersionId = id('pricing:list:BASE:v1')
  const activeVersionId = id('pricing:list:P1:v1')
  const draftVersionId = firstId('pricing:list:P1:v2')
  const red = product.colourwayIds[1] as string

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.paymentTerms.createMany({ data: paymentTerms, skipDuplicates: true })

      // --- the price lists: written once (an ACTIVE version's prices never change) -----------------------------------
      if (!(await tx.priceList.findUnique({ where: { id: baseListId }, select }))) {
        await tx.priceList.createMany({
          data: [
            { id: baseListId, companyId: companyA, code: 'SEED-PL-BASE', name: 'Seed base list', kind: PriceListKind.BASE, currency: 'EUR', ...stamp(T.setup) },
            { id: customerListId, companyId: companyA, code: 'SEED-PL-P1', name: 'Seed Customer One list', kind: PriceListKind.CUSTOMER, currency: 'EUR', baseListId, ...stamp(T.setup) },
          ],
        })
        await tx.priceListVersion.createMany({
          data: [
            { id: baseVersionId, listId: baseListId, revision: 1, ...stamp(T.setup) },
            { id: activeVersionId, listId: customerListId, revision: 1, ...stamp(T.setup) },
          ],
        })
        await tx.priceListEntry.createMany({
          data: [
            { id: id('pricing:list:BASE:v1:JKT-01'), versionId: baseVersionId, styleId: product.styleId, unitPrice: '450.000000', ...stamp(T.setup) },
            { id: id('pricing:list:BASE:v1:JKT-02'), versionId: baseVersionId, styleId: jacket02, unitPrice: '410.000000', ...stamp(T.setup) },
            { id: id('pricing:list:P1:v1:JKT-01'), versionId: activeVersionId, styleId: product.styleId, unitPrice: '420.000000', ...stamp(T.setup) },
            { id: id('pricing:list:P1:v1:JKT-01:RED'), versionId: activeVersionId, styleId: product.styleId, colourwayId: red, unitPrice: '430.000000', ...stamp(T.setup) },
          ],
        })
        // Activated: their prices are fixed from here on, valid from 1 October with no end.
        for (const versionId of [baseVersionId, activeVersionId]) {
          await tx.priceListVersion.update({
            where: { id: versionId },
            data: { status: PriceListVersionStatus.ACTIVE, validFrom: DAY.listsFrom, activatedAt: T.activated, activatedById: actorId, version: 2, updatedAt: T.activated },
            select,
          })
        }
        // The next season's DRAFT: one price raised so far.
        await tx.priceListVersion.create({ data: { id: draftVersionId, listId: customerListId, revision: 2, note: 'Next season: +15.00 on the jacket.', ...stamp(T.nextSeason) }, select })
        await tx.priceListEntry.create({ data: { id: firstId('pricing:list:P1:v2:JKT-01'), versionId: draftVersionId, styleId: product.styleId, unitPrice: '435.000000', ...stamp(T.nextSeason) }, select })
      }

      // --- P1's commercial terms (the same values on every run) -------------------------------------------------------
      await tx.party.update({
        where: { id: P1 },
        data: {
          paymentTermsId: terms.DEP30,
          priceListId: customerListId,
          defaultDepositPct: '30.0000',
          invoiceTiming: PartyInvoiceTiming.MONTHLY,
          incoterm: 'DAP',
          preferredCarrierCode: 'seed-carrier',
          minimumOrderAmount: 100_000,
        },
        select,
      })

      // --- SEED-Q-0002 (a DRAFT) keeps P1's terms and the list version its prices came from ---------------------------
      const draftQuote = await tx.quoteVersion.findUniqueOrThrow({ where: { id: money.sales.draftVersionId }, select: { status: true, paymentTermsId: true } })
      if (draftQuote.status === 'DRAFT' && draftQuote.paymentTermsId === null) {
        await tx.quoteVersion.update({ where: { id: money.sales.draftVersionId }, data: { paymentTermsId: terms.DEP30, priceListVersionId: activeVersionId }, select })
      }

      // --- SEED-SO-0001: its terms, its payment schedule and its first amendment -------------------------------------
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: money.sales.orderId },
        select: { status: true, paymentTermsId: true, version: true, netAmount: true, vatAmount: true, grossAmount: true, promiseDate: true, paymentTerms: true },
      })
      if (order.paymentTermsId === null && order.status !== 'CLOSED' && order.status !== 'CANCELLED') {
        await tx.salesOrder.update({ where: { id: money.sales.orderId }, data: { paymentTermsId: terms.DEP30, version: order.version + 1, updatedAt: T.ordered }, select })
      }
      const deposit = await tx.depositRequest.findUniqueOrThrow({ where: { id: money.sales.depositRequestId }, select: { amount: true, status: true, paidAt: true, dueDate: true } })
      const depositStepId = id('pricing:SO1:milestone:10')
      const balanceStepId = firstId('pricing:SO1:milestone:20')
      if (!(await tx.salesOrderMilestone.findUnique({ where: { id: depositStepId }, select }))) {
        await tx.salesOrderMilestone.createMany({
          data: [
            { id: depositStepId, companyId: companyA, orderId: money.sales.orderId, partyId: P1, seq: 10, kind: SalesMilestoneKind.DEPOSIT, label: "Acconto 30% all'ordine", sharePct: '30.0000', amount: deposit.amount, dueDate: deposit.dueDate, depositRequestId: money.sales.depositRequestId, ...stamp(T.ordered) },
            { id: balanceStepId, companyId: companyA, orderId: money.sales.orderId, partyId: P1, seq: 20, kind: SalesMilestoneKind.BEFORE_SHIPPING, label: 'Saldo prima della spedizione', sharePct: '70.0000', amount: order.grossAmount - deposit.amount, ...stamp(T.ordered) },
          ],
        })
        // The deposit step follows its request: PAID once the money seed allocated the transfer to it.
        if (deposit.status === 'PAID' && deposit.paidAt !== null) {
          await tx.salesOrderMilestone.update({ where: { id: depositStepId }, data: { status: SalesMilestoneStatus.PAID, paidAt: deposit.paidAt, version: 2, updatedAt: deposit.paidAt }, select })
        }
      }

      const amendmentId = id('pricing:SO1:amendment:1')
      if (!(await tx.salesOrderAmendment.findUnique({ where: { id: amendmentId }, select })) && ['CONFIRMED', 'IN_PRODUCTION', 'READY'].includes(order.status)) {
        const lines = await tx.salesOrderLine.findMany({
          where: { orderId: money.sales.orderId },
          orderBy: { seq: 'asc' },
          select: { id: true, seq: true, kind: true, styleId: true, colourwayId: true, description: true, quantity: true, unitPrice: true, netAmount: true, vatRatePct: true, sizes: { select: { size: true, quantity: true, unitPrice: true }, orderBy: { size: 'asc' } } },
        })
        const snapshotLines = lines.map((line) => ({
          ...line,
          unitPrice: line.unitPrice.toString(),
          vatRatePct: line.vatRatePct.toString(),
          sizes: line.sizes.map((size) => ({ ...size, unitPrice: size.unitPrice?.toString() ?? null })),
        }))
        const header = (requestedDate: string) => ({
          requestedDate,
          promiseDate: order.promiseDate?.toISOString().slice(0, 10) ?? null,
          paymentTerms: order.paymentTerms,
          netAmount: order.netAmount,
          vatAmount: order.vatAmount,
          grossAmount: order.grossAmount,
        })
        await tx.salesOrderAmendment.create({
          data: {
            id: amendmentId,
            companyId: companyA,
            orderId: money.sales.orderId,
            partyId: P1,
            revision: 1,
            reason: 'The customer moved its requested date (its mail of 30 October).',
            before: { header: header(DAY.requestedBefore), lines: snapshotLines },
            after: { header: header(DAY.requestedAfter), lines: snapshotLines },
            netAmountBefore: order.netAmount,
            netAmountAfter: order.netAmount,
            grossAmountBefore: order.grossAmount,
            grossAmountAfter: order.grossAmount,
            reacceptanceNeeded: false,
            requestId: `seed-pricing-${namespace}-amendment-1`,
            createdAt: T.amended,
            createdById: actorId,
          },
          select,
        })
      }
    }),
  )

  return {
    money,
    product,
    paymentTermsIds: terms,
    baseListId,
    customerListId,
    activeVersionId,
    draftVersionId,
    milestoneIds: [id('pricing:SO1:milestone:10'), firstId('pricing:SO1:milestone:20')],
    amendmentId: id('pricing:SO1:amendment:1'),
  }
}
