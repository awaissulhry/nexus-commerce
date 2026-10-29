import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  DepositFiscalDocument,
  DepositKind,
  PartyTaxMode,
  QuoteAcceptanceChannel,
  QuoteApprovalReason,
  QuoteApprovalStatus,
  QuoteStatus,
  QuoteVersionStatus,
  SalesLineKind,
  SalesOrderStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduct } from './product'

/**
 * The sales seed, per tenant of seed/_core.ts: the golden flow's stages 05-quote to 07-order for the parties seed's
 * customer P1 and the product seed's jacket, written in the tenant's office scope, as the app does.
 *
 *   Q1  SEED-Q-0001 (company A): a size-grid quote, BLK 2/4/2 and RED 1/2/1 in sizes 50/52/54, priced under the 30%
 *       margin floor, so it went DRAFT → PENDING_APPROVAL → APPROVED (one approval) → SENT → ACCEPTED (recorded by the
 *       office from the customer's signed copy); a 30% deposit request (acconto, TD02 when paid) and the order
 *       SEED-SO-0001 made from the accepted version, CONFIRMED, its lines made at site A1. Its id is the links seed's
 *       QUOTE_ACCEPT record, so that seeded link names a real quote.
 *   Q2  SEED-Q-0002: a DRAFT quote with a size-grid line (RED 52 x 3) and one made-to-measure unit for P1's team rider
 *       (the parties seed's JACKET profile).
 *   The tenant-wide sales settings (the quote rules: a 20 % margin floor, a 15 % discount limit, 30 days' validity, a 30 %
 *       deposit), keyed by the tenant's id.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a sent or accepted version and its lines cannot be copied (the …_sales_guards triggers, the one-accepted index).
 * So Q2's rows get ids that start with eight zeros (still derived from the namespace) and are always the first.
 *
 * Every name, number and amount is invented; the document hashes are SHA-256 of a text, not of a PDF. Idempotent: Q1 is
 * made in one transaction and skipped when it exists (a sent version never changes, an acceptance is append-only); Q2 is
 * inserted once and its lines are left as they are once it left DRAFT.
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  created: new Date('2026-10-28T08:00:00.000Z'),
  approvalAsked: new Date('2026-10-28T09:00:00.000Z'),
  approved: new Date('2026-10-28T09:30:00.000Z'),
  sent: new Date('2026-10-28T10:00:00.000Z'),
  accepted: new Date('2026-10-29T15:00:00.000Z'),
  ordered: new Date('2026-10-30T08:00:00.000Z'),
} as const
const DAY = {
  validUntil: new Date('2026-11-27T00:00:00.000Z'),
  promise: new Date('2026-12-18T00:00:00.000Z'),
  depositDue: new Date('2026-11-06T00:00:00.000Z'),
  orderDate: new Date('2026-10-30T00:00:00.000Z'),
  requested: new Date('2026-12-15T00:00:00.000Z'),
} as const

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Q1's grid: pieces per size and colourway. */
const GRID = { BLK: { '50': 2, '52': 4, '54': 2 }, RED: { '50': 1, '52': 2, '54': 1 } } as const
/** Q1's prices and cost per piece (EUR), and the margin floor. Amounts below are in cents. */
const PRICE = { list: '450.000000', unit: '420.000000', unitCost: '300.500000', vat: '22.00', floorPct: '30.0000' } as const
const COST_SNAPSHOT = { material: '231.500000', labour: '69.000000', per: 'piece' }

export interface SalesSeed {
  /** Q1: the accepted quote, its accepted version and the order made from it. */
  readonly quoteId: string
  readonly acceptedVersionId: string
  readonly orderId: string
  readonly depositRequestId: string
  /** Q2: the draft quote and its draft version. */
  readonly draftQuoteId: string
  readonly draftVersionId: string
}

export async function seed(context: SeedContext): Promise<SalesSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the customer, its rider profile and the style come from earlier seeds.
  const product = await seedProduct(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Q2's ids: derived like every other, with eight leading zeros so they sort first (see above). */
  const draftId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const partyId = id('party:P1')
  const [colourBLK, colourRED] = product.colourwayIds as [string, string]
  const stamp = { createdAt: T.created, updatedAt: T.created, createdById: actorId }

  const q1 = {
    quote: id('link:P1:record'),
    version: id('sales:Q1:v1'),
    approval: id('sales:Q1:v1:approval'),
    acceptance: id('sales:Q1:v1:acceptance'),
    deposit: id('sales:Q1:deposit'),
    order: id('sales:SO1'),
  }
  const q2 = { quote: draftId('sales:Q2'), version: draftId('sales:Q2:v1') }
  const document = sha256(`seed quote SEED-Q-0001 version 1 (${namespace})`)

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
  const shipTo = {
    name: 'Seed Racing workshop',
    line1: 'Via Esempio 12',
    postalCode: '00000',
    city: 'Seedville',
    province: 'MI',
    country: 'IT',
    contactName: 'Seed Receiver',
    phone: '+39 000 0000001',
  }

  // Q1's lines: one per colourway, 420.00 net a piece (list 450.00), 22% VAT, 300.50 cost a piece.
  const q1Lines = (['BLK', 'RED'] as const).map((code, index) => {
    const sizes = Object.entries(GRID[code])
    const quantity = sizes.reduce((sum, [, pieces]) => sum + pieces, 0)
    const netAmount = quantity * 42_000
    const costAmount = quantity * 30_050
    return {
      code,
      seq: (index + 1) * 10,
      colourwayId: code === 'BLK' ? colourBLK : colourRED,
      quantity,
      netAmount,
      vatAmount: Math.round(netAmount * 0.22),
      costAmount,
      marginAmount: netAmount - costAmount,
      sizes,
    }
  })
  const totals = q1Lines.reduce(
    (sum, line) => ({ net: sum.net + line.netAmount, vat: sum.vat + line.vatAmount, cost: sum.cost + line.costAmount }),
    { net: 0, vat: 0, cost: 0 },
  )
  const gross = totals.net + totals.vat
  const depositAmount = Math.round(gross * 0.3)
  const marginPct = (((totals.net - totals.cost) / totals.net) * 100).toFixed(4)

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // --- the tenant-wide sales settings: the quote rules' old defaults (inserted once) ------------------------------
      await tx.salesSettings.createMany({
        data: [{ id: tenantId, companyId: null, marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', ...stamp }],
        skipDuplicates: true,
      })
      // --- Q2: the draft (inserted once; its parts are left alone once it left DRAFT) ---------------------------------
      await tx.quote.createMany({
        data: [{ id: q2.quote, companyId: companyA, number: 'SEED-Q-0002', partyId, contactId: id('party-contact:P1:buyer'), status: QuoteStatus.DRAFT, ...stamp }],
        skipDuplicates: true,
      })
      await tx.quoteVersion.createMany({
        data: [
          {
            id: q2.version,
            quoteId: q2.quote,
            partyId,
            revision: 1,
            status: QuoteVersionStatus.DRAFT,
            currency: 'EUR',
            language: 'it',
            taxMode: PartyTaxMode.IT_B2B,
            taxIdentityId: id('party-tax:P1'),
            billToAddressId: id('party-address:P1:office'),
            shipToAddressId: id('party-address:P1:workshop'),
            paymentTerms: 'Deposit 30% at acceptance, balance at delivery',
            depositPct: '30.0000',
            depositKind: DepositKind.ACCONTO,
            netAmount: 178_000,
            vatAmount: 39_160,
            grossAmount: 217_160,
            costAmount: 124_150,
            marginAmount: 53_850,
            marginPct: '30.2528',
            marginFloorPct: PRICE.floorPct,
            marginFloorBreached: false,
            ...stamp,
          },
        ],
        skipDuplicates: true,
      })
      const draft = await tx.quoteVersion.findUniqueOrThrow({ where: { id: q2.version }, select: { status: true } })
      if (draft.status === QuoteVersionStatus.DRAFT) {
        const gridLine = draftId('sales:Q2:v1:line:10')
        const mtmLine = draftId('sales:Q2:v1:line:20')
        await tx.quoteLine.createMany({
          data: [
            {
              id: gridLine,
              versionId: q2.version,
              partyId,
              seq: 10,
              kind: SalesLineKind.SIZE_GRID,
              styleId: product.styleId,
              styleRevisionId: product.revisionId,
              colourwayId: colourRED,
              description: 'SEED-JKT-01 Red',
              quantity: 3,
              listUnitPrice: PRICE.list,
              unitPrice: PRICE.unit,
              adjustmentReason: 'VOLUME',
              netAmount: 126_000,
              vatRatePct: PRICE.vat,
              vatAmount: 27_720,
              unitCost: PRICE.unitCost,
              costAmount: 90_150,
              marginAmount: 35_850,
              marginPct: '28.4524',
              costSnapshot: COST_SNAPSHOT,
              ...stamp,
            },
            {
              id: mtmLine,
              versionId: q2.version,
              partyId,
              seq: 20,
              kind: SalesLineKind.MADE_TO_MEASURE,
              styleId: product.styleId,
              styleRevisionId: product.revisionId,
              colourwayId: colourBLK,
              measurementProfileId: id('measurement:P1:rider:JACKET:1'),
              baseSize: '52',
              description: 'SEED-JKT-01 Black, made to measure for the team rider',
              quantity: 1,
              listUnitPrice: '520.000000',
              unitPrice: '520.000000',
              netAmount: 52_000,
              vatRatePct: PRICE.vat,
              vatAmount: 11_440,
              unitCost: '340.000000',
              costAmount: 34_000,
              marginAmount: 18_000,
              marginPct: '34.6154',
              costSnapshot: { material: '262.000000', labour: '78.000000', per: 'piece' },
              ...stamp,
            },
          ],
          skipDuplicates: true,
        })
        await tx.quoteLineSize.createMany({
          data: [{ id: draftId('sales:Q2:v1:line:10:52'), lineId: gridLine, partyId, size: '52', quantity: 3, ...stamp }],
          skipDuplicates: true,
        })
      }

      // --- Q1: through to the order, in one go (skipped once it exists) ------------------------------------------------
      if (await tx.quote.findUnique({ where: { id: q1.quote }, select: { id: true } })) return
      const select = { id: true } as const
      const step = (at: Date) => ({ updatedAt: at, version: { increment: 1 } })

      await tx.quote.create({
        data: { id: q1.quote, companyId: companyA, number: 'SEED-Q-0001', partyId, contactId: id('party-contact:P1:buyer'), customerRef: 'SEED-RFQ-12', status: QuoteStatus.DRAFT, ...stamp },
        select,
      })
      await tx.quoteVersion.create({
        data: {
          id: q1.version,
          quoteId: q1.quote,
          partyId,
          revision: 1,
          status: QuoteVersionStatus.DRAFT,
          currency: 'EUR',
          language: 'it',
          taxMode: PartyTaxMode.IT_B2B,
          taxIdentityId: id('party-tax:P1'),
          billToAddressId: id('party-address:P1:office'),
          shipToAddressId: id('party-address:P1:workshop'),
          promiseDate: DAY.promise,
          paymentTerms: 'Deposit 30% at acceptance, balance at delivery',
          termsText: 'Seed general terms of sale: synthetic text.',
          termsVersion: 'SEED-TERMS-1',
          depositPct: '30.0000',
          depositKind: DepositKind.ACCONTO,
          depositAmount,
          netAmount: totals.net,
          vatAmount: totals.vat,
          grossAmount: gross,
          costAmount: totals.cost,
          marginAmount: totals.net - totals.cost,
          marginPct,
          marginFloorPct: PRICE.floorPct,
          marginFloorBreached: true,
          ...stamp,
        },
        select,
      })
      const q1LineRows: Prisma.QuoteLineCreateManyInput[] = q1Lines.map((line) => ({
        id: id(`sales:Q1:v1:line:${line.seq}`),
        versionId: q1.version,
        partyId,
        seq: line.seq,
        kind: SalesLineKind.SIZE_GRID,
        styleId: product.styleId,
        styleRevisionId: product.revisionId,
        colourwayId: line.colourwayId,
        description: `SEED-JKT-01 ${line.code}`,
        quantity: line.quantity,
        listUnitPrice: PRICE.list,
        unitPrice: PRICE.unit,
        adjustmentReason: 'VOLUME',
        netAmount: line.netAmount,
        vatRatePct: PRICE.vat,
        vatAmount: line.vatAmount,
        unitCost: PRICE.unitCost,
        costAmount: line.costAmount,
        marginAmount: line.marginAmount,
        marginPct,
        costSnapshot: COST_SNAPSHOT,
        ...stamp,
      }))
      await tx.quoteLine.createMany({ data: q1LineRows })
      await tx.quoteLineSize.createMany({
        data: q1Lines.flatMap((line) =>
          line.sizes.map(([size, quantity]) => ({ id: id(`sales:Q1:v1:line:${line.seq}:${size}`), lineId: id(`sales:Q1:v1:line:${line.seq}`), partyId, size, quantity, ...stamp })),
        ),
      })

      // Under the margin floor: the version asks for an approval, an approver gives it.
      await tx.quoteVersion.update({ where: { id: q1.version }, data: { status: QuoteVersionStatus.PENDING_APPROVAL, ...step(T.approvalAsked) }, select })
      await tx.quote.update({ where: { id: q1.quote }, data: { status: QuoteStatus.PENDING_APPROVAL, ...step(T.approvalAsked) }, select })
      await tx.quoteApproval.create({
        data: {
          id: q1.approval,
          versionId: q1.version,
          partyId,
          reasons: [QuoteApprovalReason.MARGIN_FLOOR],
          details: { marginPct, marginFloorPct: PRICE.floorPct },
          requestNote: 'Volume order from a returning customer.',
          status: QuoteApprovalStatus.PENDING,
          createdAt: T.approvalAsked,
          updatedAt: T.approvalAsked,
          createdById: actorId,
        },
        select,
      })
      await tx.quoteApproval.update({
        where: { id: q1.approval },
        data: { status: QuoteApprovalStatus.APPROVED, decidedAt: T.approved, decidedById: actorId, decisionNote: 'Approved for this volume.', ...step(T.approved) },
        select,
      })
      await tx.quoteVersion.update({ where: { id: q1.version }, data: { status: QuoteVersionStatus.APPROVED, ...step(T.approved) }, select })
      await tx.quote.update({ where: { id: q1.quote }, data: { status: QuoteStatus.APPROVED, ...step(T.approved) }, select })

      // Sent: the version is frozen with what the party received.
      await tx.quoteVersion.update({
        where: { id: q1.version },
        data: { status: QuoteVersionStatus.SENT, sentAt: T.sent, sentById: actorId, validUntil: DAY.validUntil, documentSha256: document, billTo, shipTo, ...step(T.sent) },
        select,
      })
      await tx.quote.update({ where: { id: q1.quote }, data: { status: QuoteStatus.SENT, ...step(T.sent) }, select })

      // Accepted: the customer's signed copy, recorded by the office.
      await tx.quoteVersion.update({ where: { id: q1.version }, data: { status: QuoteVersionStatus.ACCEPTED, closedAt: T.accepted, ...step(T.accepted) }, select })
      await tx.quote.update({ where: { id: q1.quote }, data: { status: QuoteStatus.ACCEPTED, ...step(T.accepted) }, select })
      await tx.quoteAcceptance.create({
        data: {
          id: q1.acceptance,
          versionId: q1.version,
          partyId,
          channel: QuoteAcceptanceChannel.OFFICE,
          signerName: 'Seed Buyer One',
          documentSha256: document,
          termsVersion: 'SEED-TERMS-1',
          acceptedAt: T.accepted,
          requestId: `seed-sales-${namespace}-accept`,
          createdAt: T.accepted,
        },
        select,
      })
      await tx.depositRequest.create({
        data: {
          id: q1.deposit,
          companyId: companyA,
          partyId,
          quoteVersionId: q1.version,
          kind: DepositKind.ACCONTO,
          depositPct: '30.0000',
          currency: 'EUR',
          amount: depositAmount,
          dueDate: DAY.depositDue,
          fiscalDocument: DepositFiscalDocument.TD02,
          fiscalRule: 'seed.deposit.IT_B2B.v1',
          createdAt: T.accepted,
          updatedAt: T.accepted,
          createdById: actorId,
        },
        select,
      })

      // The order from the accepted version; its lines at site A1; the deposit request names it.
      const orderStamp = { createdAt: T.ordered, updatedAt: T.ordered, createdById: actorId }
      await tx.salesOrder.create({
        data: {
          id: q1.order,
          companyId: companyA,
          partyId,
          number: 'SEED-SO-0001',
          quoteVersionId: q1.version,
          customerRef: 'SEED-PO-77',
          status: SalesOrderStatus.CONFIRMED,
          orderDate: DAY.orderDate,
          currency: 'EUR',
          language: 'it',
          taxMode: PartyTaxMode.IT_B2B,
          billTo,
          shipTo,
          paymentTerms: 'Deposit 30% at acceptance, balance at delivery',
          requestedDate: DAY.requested,
          promiseDate: DAY.promise,
          originalPromiseDate: DAY.promise,
          depositRequired: true,
          netAmount: totals.net,
          vatAmount: totals.vat,
          grossAmount: gross,
          costAmount: totals.cost,
          ...orderStamp,
        },
        select,
      })
      await tx.salesOrderLine.createMany({
        data: q1Lines.map((line) => ({
          id: id(`sales:SO1:line:${line.seq}`),
          companyId: companyA,
          orderId: q1.order,
          partyId,
          seq: line.seq,
          kind: SalesLineKind.SIZE_GRID,
          quoteLineId: id(`sales:Q1:v1:line:${line.seq}`),
          styleId: product.styleId,
          colourwayId: line.colourwayId,
          description: `SEED-JKT-01 ${line.code}`,
          quantity: line.quantity,
          unitPrice: PRICE.unit,
          netAmount: line.netAmount,
          vatRatePct: PRICE.vat,
          vatAmount: line.vatAmount,
          unitCost: PRICE.unitCost,
          costAmount: line.costAmount,
          siteId: siteA,
          ...orderStamp,
        })),
      })
      await tx.salesOrderLineSize.createMany({
        data: q1Lines.flatMap((line) =>
          line.sizes.map(([size, quantity]) => ({ id: id(`sales:SO1:line:${line.seq}:${size}`), lineId: id(`sales:SO1:line:${line.seq}`), partyId, size, quantity, ...orderStamp })),
        ),
      })
      await tx.depositRequest.update({ where: { id: q1.deposit }, data: { orderId: q1.order, ...step(T.ordered) }, select })
    }),
  )

  return { quoteId: q1.quote, acceptedVersionId: q1.version, orderId: q1.order, depositRequestId: q1.deposit, draftQuoteId: q2.quote, draftVersionId: q2.version }
}
