import { createHash } from 'node:crypto'
import {
  DepositKind,
  MoqAction,
  MoqPer,
  PartyTaxMode,
  ProductType,
  QuoteAcceptanceMode,
  QuoteStatus,
  QuoteVersionStatus,
  SalesFeeKind,
  SalesLineKind,
  SalesOrderStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedOptions } from './options'
import { seed as seedPricing } from './pricing'
import { seed as seedRoles } from './roles'

/**
 * The quotes, pricing and configuration seed (W2b-5, schema wave 38/44, B-W2b-280), per tenant of seed/_core.ts, written in
 * the tenant's office scope as the app does:
 *
 *   size curves      company A's "Seed EU jacket curve" over the EU jacket scale (48 5 %, 50 20 %, 52 40 %, 54 25 %, 56 10 %)
 *                    and the tenant-wide "Seed small run" (50 25 %, 52 50 %, 54 25 %).
 *   quote templates  company A's "Seed season order" (signed and paid: a 30 % acconto on DEP30, 45 days, EXW Seedville, ship
 *                    complete; lines: SEED-JKT-01 BLK 2/4/2 and SEED-JKT-05 under "Jackets", a 500.00 development fee for
 *                    SEED-JKT-05 under "Fees") and the tenant-wide "Seed sample request" (a 150.00 sample fee for
 *                    SEED-JKT-01 BLK).
 *   price lists      on SEED-PL-P1's DRAFT version 2: breaks for SEED-JKT-01 (from 10 pieces 425.00, from 50 pieces 415.00)
 *                    and 3 % off every entry from 100 pieces; a 20.00 surcharge on size 56; SEED-JKT-02 at 400.00 to
 *                    2027-01-31 and 415.00 from 2027-02-01 (an announced increase). SEED-JKT-05's own 5 % surcharge on size 54.
 *                    SEED-PL-P1 shows only net prices (no discount).
 *   minimums         company A: SEED-JKT-01 at least 5 per colourway (warn); jackets at least 20 per order for SEED-PL-P1's
 *                    customers, else 12.00 a piece more (surcharge).
 *   margin floors    the tenant-wide sales settings: sales 25 %, owner 10 % (B-W2b-330 reads them).
 *   SEED-Q-0003      a DRAFT quote from "Seed season order" for P1 (EXW Seedville, ship complete, signed and paid with the
 *                    30 % acconto): SEED-JKT-05 BLK 2/4/2 configured (standard armour by default, the thermal liner +60.00,
 *                    front perforation +5 % = 20.00, the name "ROSSI" +15.00), priced SUGGESTED 400.00 → options → 5 %
 *                    discount → a manual 0.25 off (COMPETITION) → NET 470.00, size 54 at +23.50 (SEED-JKT-05's surcharge),
 *                    delivered in two (4 December: 1/1/1, 18 December: 52 × 2; the rest at the promise date); and the
 *                    500.00 development fee.
 *   SEED-Q-0004      a SENT quote (SEED-JKT-01 RED 52 × 3: LIST 430.00 from SEED-PL-P1 version 1, a manual 10.00 off for
 *                    VOLUME, NET 420.00, DAP Seedville) whose customer was reminded on 2026-11-10.
 *   SEED-SO-0004     an order typed by the office for P1, CONFIRMED (DAP Seedville, ship as ready): SEED-JKT-05 BLK 50 × 2 and
 *                    52 × 2 with the standard armour and the liner (SUGGESTED 400.00 + 60.00 liner + 10.00 LOYALTY = 470.00),
 *                    delivered on 15 January (50 × 1) and 29 January (52 × 2).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * a delivery's copy must not bring more of a size than its line has, an option or delivery is written only while its quote
 * is DRAFT (its order CONFIRMED), a break or a version surcharge only while its version is a DRAFT. So the first rows (ids
 * with eight leading zeros, still derived from the namespace) are a DRAFT quote's and a CONFIRMED order's first delivery
 * (at most half of each size) and default option, a DRAFT version's break and surcharge, a template, its line, a curve and
 * a minimum.
 *
 * Every name, number and amount is invented; the document hash is SHA-256 of a text. Idempotent: rows are inserted once and
 * left as they are (skipped when they exist); a column added to an earlier row is written only while it is still empty.
 */

const T = {
  setup: new Date('2026-11-01T08:00:00.000Z'),
  quoted: new Date('2026-11-02T09:00:00.000Z'),
  sent: new Date('2026-11-02T10:00:00.000Z'),
  reminded: new Date('2026-11-10T08:00:00.000Z'),
  ordered: new Date('2026-11-03T08:00:00.000Z'),
} as const
const DAY = {
  q3FirstDelivery: new Date('2026-12-04T00:00:00.000Z'),
  q3SecondDelivery: new Date('2026-12-18T00:00:00.000Z'),
  q3Promise: new Date('2026-12-23T00:00:00.000Z'),
  q4ValidUntil: new Date('2026-12-20T00:00:00.000Z'),
  orderDate: new Date('2026-11-03T00:00:00.000Z'),
  soFirstDelivery: new Date('2027-01-15T00:00:00.000Z'),
  soSecondDelivery: new Date('2027-01-29T00:00:00.000Z'),
  oldPriceTo: new Date('2027-01-31T00:00:00.000Z'),
  newPriceFrom: new Date('2027-02-01T00:00:00.000Z'),
} as const

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const source = (type: string, id: string) => ({ type, id })

export interface SalesPricingSeed {
  readonly templateIds: { readonly season: string; readonly samples: string }
  readonly curveIds: readonly [string, string]
  /** SEED-Q-0003 (DRAFT, configured) and SEED-Q-0004 (SENT, reminded). */
  readonly draftQuote: { readonly quoteId: string; readonly versionId: string; readonly gridLineId: string; readonly feeLineId: string }
  readonly sentQuote: { readonly quoteId: string; readonly versionId: string; readonly lineId: string }
  /** SEED-SO-0004 (CONFIRMED) and its configured line. */
  readonly order: { readonly orderId: string; readonly lineId: string }
  readonly breakIds: readonly string[]
  readonly surchargeIds: { readonly size56: string; readonly jkt05Size54: string }
  readonly moqRuleIds: readonly [string, string]
}

export async function seed(context: SeedContext): Promise<SalesPricingSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order (this one before sales.ts): the quotes, lists, roles and options come from these.
  const pricing = await seedPricing(context)
  const options = await seedOptions(context)
  await seedAuth(context)
  await seedRoles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const jkt01 = pricing.product.styleId
  const [jkt01Blk, jkt01Red] = pricing.product.colourwayIds as [string, string]
  const jkt02 = pricing.money.shipping.quality.production.styleId
  const jkt05 = options.jacketStyleId
  const jkt05Blk = id('options:colourway:JKT-05:BLK')
  const scaleId = id('product:size-scale:EU-JKT')
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const

  const curveIds = [firstId('sales-pricing:curve:EU-JKT'), id('sales-pricing:curve:SMALL')] as const
  const templateIds = { season: firstId('sales-pricing:template:SEASON'), samples: id('sales-pricing:template:SAMPLES') }
  const breakIds = [firstId('sales-pricing:break:P1v2:JKT-01:10'), id('sales-pricing:break:P1v2:JKT-01:50'), id('sales-pricing:break:P1v2:all:100')]
  const surchargeIds = { size56: firstId('sales-pricing:surcharge:P1v2:56'), jkt05Size54: id('sales-pricing:surcharge:JKT-05:54') }
  const moqRuleIds = [firstId('sales-pricing:moq:JKT-01'), id('sales-pricing:moq:JACKET')] as const
  const q3 = {
    quoteId: id('sales-pricing:Q3'),
    versionId: id('sales-pricing:Q3:v1'),
    gridLineId: id('sales-pricing:Q3:v1:line:10'),
    feeLineId: id('sales-pricing:Q3:v1:line:20'),
  }
  const q4 = { quoteId: id('sales-pricing:Q4'), versionId: id('sales-pricing:Q4:v1'), lineId: id('sales-pricing:Q4:v1:line:10') }
  const so = { orderId: id('sales-pricing:SO4'), lineId: id('sales-pricing:SO4:line:10') }
  const q3Options = {
    armour: firstId('sales-pricing:Q3:option:ARMOUR'),
    liner: id('sales-pricing:Q3:option:LINER'),
    perforation: id('sales-pricing:Q3:option:PERF'),
    name: id('sales-pricing:Q3:option:NAME'),
  }
  const soOptions = { armour: firstId('sales-pricing:SO4:option:ARMOUR'), liner: id('sales-pricing:SO4:option:LINER') }

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

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      // --- size curves -------------------------------------------------------------------------------------------------
      await tx.sizeCurve.createMany({
        data: [
          { id: curveIds[0], companyId: companyA, sizeScaleId: scaleId, name: 'Seed EU jacket curve', shares: { '48': '5.0000', '50': '20.0000', '52': '40.0000', '54': '25.0000', '56': '10.0000' }, ...stamp(T.setup) },
          { id: curveIds[1], companyId: null, sizeScaleId: scaleId, name: 'Seed small run', shares: { '50': '25.0000', '52': '50.0000', '54': '25.0000' }, ...stamp(T.setup) },
        ],
        skipDuplicates: true,
      })

      // --- quote templates ---------------------------------------------------------------------------------------------
      await tx.quoteTemplate.createMany({
        data: [
          {
            id: templateIds.season,
            companyId: companyA,
            name: 'Seed season order',
            description: 'A brand season order: the jackets in their usual size run and the development fee.',
            validityDays: 45,
            firmOffer: true,
            acceptanceMode: QuoteAcceptanceMode.SIGN_AND_PAY,
            depositPct: '30.0000',
            depositKind: DepositKind.ACCONTO,
            paymentTermsId: pricing.paymentTermsIds.DEP30,
            termsText: 'Seed general terms of sale: made-up wording for the seed.',
            termsVersion: 'SEED-TC-2026',
            incoterm: 'EXW',
            incotermPlace: 'Seedville',
            shipComplete: true,
            ...stamp(T.setup),
          },
          { id: templateIds.samples, companyId: null, name: 'Seed sample request', validityDays: 15, ...stamp(T.setup) },
        ],
        skipDuplicates: true,
      })
      await tx.quoteTemplateLine.createMany({
        data: [
          { id: firstId('sales-pricing:template:SEASON:10'), templateId: templateIds.season, seq: 10, section: 'Jackets', kind: SalesLineKind.SIZE_GRID, styleId: jkt01, colourwayId: jkt01Blk, sizeQuantities: { '50': 2, '52': 4, '54': 2 }, ...stamp(T.setup) },
          { id: id('sales-pricing:template:SEASON:20'), templateId: templateIds.season, seq: 20, section: 'Jackets', kind: SalesLineKind.SIZE_GRID, styleId: jkt05, description: 'Configurable touring jacket: options chosen on the quote.', ...stamp(T.setup) },
          { id: id('sales-pricing:template:SEASON:30'), templateId: templateIds.season, seq: 30, section: 'Fees', kind: SalesLineKind.FEE, feeKind: SalesFeeKind.DEVELOPMENT, styleId: jkt05, unitPrice: '500.000000', description: 'Development of the configured jacket', ...stamp(T.setup) },
          { id: id('sales-pricing:template:SAMPLES:10'), templateId: templateIds.samples, seq: 10, kind: SalesLineKind.FEE, feeKind: SalesFeeKind.SAMPLE, styleId: jkt01, colourwayId: jkt01Blk, unitPrice: '150.000000', description: 'Sample of the jacket in size 52', ...stamp(T.setup) },
        ],
        skipDuplicates: true,
      })

      // --- price lists: breaks, surcharges, dated prices, the discount shown --------------------------------------------
      const draftVersion = await tx.priceListVersion.findUniqueOrThrow({ where: { id: pricing.draftVersionId }, select: { status: true } })
      if (draftVersion.status === 'DRAFT') {
        const jkt01Entry = firstId('pricing:list:P1:v2:JKT-01')
        await tx.priceBreak.createMany({
          data: [
            { id: breakIds[0]!, versionId: pricing.draftVersionId, entryId: jkt01Entry, minQuantity: 10, unitPrice: '425.000000', ...stamp(T.setup) },
            { id: breakIds[1]!, versionId: pricing.draftVersionId, entryId: jkt01Entry, minQuantity: 50, unitPrice: '415.000000', ...stamp(T.setup) },
            { id: breakIds[2]!, versionId: pricing.draftVersionId, minQuantity: 100, discountPct: '3.0000', ...stamp(T.setup) },
          ],
          skipDuplicates: true,
        })
        await tx.sizeSurcharge.createMany({
          data: [{ id: surchargeIds.size56, versionId: pricing.draftVersionId, size: '56', surchargeAmount: '20.000000', currency: 'EUR', ...stamp(T.setup) }],
          skipDuplicates: true,
        })
        await tx.priceListEntry.createMany({
          data: [
            { id: id('sales-pricing:list:P1:v2:JKT-02:old'), versionId: pricing.draftVersionId, styleId: jkt02, unitPrice: '400.000000', validTo: DAY.oldPriceTo, ...stamp(T.setup) },
            { id: id('sales-pricing:list:P1:v2:JKT-02:new'), versionId: pricing.draftVersionId, styleId: jkt02, unitPrice: '415.000000', validFrom: DAY.newPriceFrom, ...stamp(T.setup) },
          ],
          skipDuplicates: true,
        })
      }
      await tx.sizeSurcharge.createMany({
        data: [{ id: surchargeIds.jkt05Size54, styleId: jkt05, size: '54', surchargePct: '5.0000', ...stamp(T.setup) }],
        skipDuplicates: true,
      })
      await tx.priceList.updateMany({ where: { id: pricing.customerListId, showDiscount: true }, data: { showDiscount: false } })

      // --- minimum order quantities ------------------------------------------------------------------------------------
      await tx.moqRule.createMany({
        data: [
          { id: moqRuleIds[0], companyId: companyA, styleId: jkt01, minQuantity: 5, per: MoqPer.COLOURWAY, action: MoqAction.WARN, note: 'Under 5 a colour the leather is cut in a short lay.', ...stamp(T.setup) },
          { id: moqRuleIds[1], companyId: companyA, priceListId: pricing.customerListId, productType: ProductType.JACKET, minQuantity: 20, per: MoqPer.ORDER, action: MoqAction.SURCHARGE, surchargeAmount: '12.000000', currency: 'EUR', ...stamp(T.setup) },
        ],
        skipDuplicates: true,
      })

      // --- margin floors by role ---------------------------------------------------------------------------------------
      const settings = await tx.salesSettings.findUnique({ where: { id: tenantId }, select: { marginFloorByRole: true } })
      if (settings && settings.marginFloorByRole === null) {
        await tx.salesSettings.update({ where: { id: tenantId }, data: { marginFloorByRole: { sales: '25.0000', owner: '10.0000' } }, select })
      }

      // --- SEED-Q-0003: a DRAFT quote from the season template, configured -----------------------------------------------
      if (!(await tx.quote.findUnique({ where: { id: q3.quoteId }, select }))) {
        await tx.quote.create({ data: { id: q3.quoteId, companyId: companyA, number: 'SEED-Q-0003', partyId: P1, contactId: id('party-contact:P1:buyer'), templateId: templateIds.season, status: QuoteStatus.DRAFT, ...stamp(T.quoted) }, select })
        await tx.quoteVersion.create({
          data: {
            id: q3.versionId,
            quoteId: q3.quoteId,
            partyId: P1,
            revision: 1,
            currency: 'EUR',
            language: 'it',
            taxMode: PartyTaxMode.IT_B2B,
            taxIdentityId: id('party-tax:P1'),
            billToAddressId: id('party-address:P1:office'),
            shipToAddressId: id('party-address:P1:workshop'),
            firmOffer: true,
            promiseDate: DAY.q3Promise,
            incoterm: 'EXW',
            incotermPlace: 'Seedville',
            shipComplete: true,
            acceptanceMode: QuoteAcceptanceMode.SIGN_AND_PAY,
            paymentTerms: 'Deposit 30% at the order, balance before shipping',
            paymentTermsId: pricing.paymentTermsIds.DEP30,
            termsText: 'Seed general terms of sale: made-up wording for the seed.',
            termsVersion: 'SEED-TC-2026',
            depositPct: '30.0000',
            depositKind: DepositKind.ACCONTO,
            netAmount: 430_700,
            vatAmount: 94_754,
            grossAmount: 525_454,
            ...stamp(T.quoted),
          },
          select,
        })
        // The configured jacket: 8 pieces, size 54 at its own price (+5 %).
        const gridSteps = [
          { kind: 'SUGGESTED', unitPrice: '400.000000', source: source('StyleRevision', options.jacketRevisionId), label: 'From the cost and the markup' },
          { kind: 'OPTION', delta: '60.000000', unitPrice: '460.000000', source: source('QuoteLineOption', q3Options.liner), label: 'Thermal liner' },
          { kind: 'OPTION', delta: '20.000000', pct: '5.0000', unitPrice: '480.000000', source: source('QuoteLineOption', q3Options.perforation), label: 'Front perforation' },
          { kind: 'OPTION', delta: '15.000000', unitPrice: '495.000000', source: source('QuoteLineOption', q3Options.name), label: 'Name embroidery' },
          { kind: 'DISCOUNT', delta: '-24.750000', pct: '5.0000', unitPrice: '470.250000', label: 'Season discount' },
          { kind: 'MANUAL', delta: '-0.250000', unitPrice: '470.000000', reasonCode: 'COMPETITION', note: 'Rounded to the price the brand was offered elsewhere.' },
          { kind: 'SIZE_SURCHARGE', sizes: { '54': '23.500000' }, source: source('SizeSurcharge', surchargeIds.jkt05Size54), label: 'Size 54' },
          { kind: 'NET', unitPrice: '470.000000' },
        ]
        await tx.quoteLine.createMany({
          data: [
            {
              id: q3.gridLineId,
              versionId: q3.versionId,
              partyId: P1,
              seq: 10,
              section: 'Jackets',
              kind: SalesLineKind.SIZE_GRID,
              styleId: jkt05,
              styleRevisionId: options.jacketRevisionId,
              colourwayId: jkt05Blk,
              description: 'SEED-JKT-05 Black, configured: liner, front perforation, name',
              quantity: 8,
              unitPrice: '470.000000',
              priceSteps: gridSteps,
              netAmount: 380_700,
              vatRatePct: '22.00',
              vatAmount: 83_754,
              ...stamp(T.quoted),
            },
            {
              id: q3.feeLineId,
              versionId: q3.versionId,
              partyId: P1,
              seq: 20,
              section: 'Fees',
              kind: SalesLineKind.FEE,
              feeKind: SalesFeeKind.DEVELOPMENT,
              styleId: jkt05,
              colourwayId: jkt05Blk,
              description: 'Development of the configured jacket',
              quantity: 1,
              unitPrice: '500.000000',
              netAmount: 50_000,
              vatRatePct: '22.00',
              vatAmount: 11_000,
              ...stamp(T.quoted),
            },
          ],
        })
        await tx.quoteLineSize.createMany({
          data: [
            { id: id('sales-pricing:Q3:v1:line:10:50'), lineId: q3.gridLineId, partyId: P1, size: '50', quantity: 2, ...stamp(T.quoted) },
            { id: id('sales-pricing:Q3:v1:line:10:52'), lineId: q3.gridLineId, partyId: P1, size: '52', quantity: 4, ...stamp(T.quoted) },
            { id: id('sales-pricing:Q3:v1:line:10:54'), lineId: q3.gridLineId, partyId: P1, size: '54', quantity: 2, unitPrice: '493.500000', ...stamp(T.quoted) },
          ],
        })
        await tx.quoteLineOption.createMany({
          data: [
            { id: q3Options.armour, lineId: q3.gridLineId, partyId: P1, groupId: options.groupIds.armour, valueId: options.valueIds.armourStd, byDefault: true, ...stamp(T.quoted) },
            { id: q3Options.liner, lineId: q3.gridLineId, partyId: P1, groupId: options.groupIds.liner, valueId: options.valueIds.linerYes, surchargeAmount: '60.000000', ...stamp(T.quoted) },
            { id: q3Options.perforation, lineId: q3.gridLineId, partyId: P1, groupId: options.groupIds.perforation, valueId: options.valueIds.perfFront, surchargeAmount: '20.000000', surchargePct: '5.0000', ...stamp(T.quoted) },
            { id: q3Options.name, lineId: q3.gridLineId, partyId: P1, groupId: options.groupIds.name, valueId: options.valueIds.name, freeText: 'ROSSI', surchargeAmount: '15.000000', ...stamp(T.quoted) },
          ],
        })
        await tx.quoteLineDelivery.createMany({
          data: [
            { id: firstId('sales-pricing:Q3:v1:line:10:delivery:1'), lineId: q3.gridLineId, partyId: P1, deliveryDate: DAY.q3FirstDelivery, sizeQuantities: { '50': 1, '52': 1, '54': 1 }, quantity: 3, note: 'The first jackets for the brand fair.', ...stamp(T.quoted) },
            { id: id('sales-pricing:Q3:v1:line:10:delivery:2'), lineId: q3.gridLineId, partyId: P1, deliveryDate: DAY.q3SecondDelivery, sizeQuantities: { '52': 2 }, quantity: 2, ...stamp(T.quoted) },
          ],
        })
      }

      // --- SEED-Q-0004: SENT, its customer reminded --------------------------------------------------------------------
      if (!(await tx.quote.findUnique({ where: { id: q4.quoteId }, select }))) {
        await tx.quote.create({ data: { id: q4.quoteId, companyId: companyA, number: 'SEED-Q-0004', partyId: P1, contactId: id('party-contact:P1:buyer'), status: QuoteStatus.DRAFT, ...stamp(T.quoted) }, select })
        await tx.quoteVersion.create({
          data: {
            id: q4.versionId,
            quoteId: q4.quoteId,
            partyId: P1,
            revision: 1,
            currency: 'EUR',
            language: 'it',
            taxMode: PartyTaxMode.IT_B2B,
            taxIdentityId: id('party-tax:P1'),
            billToAddressId: id('party-address:P1:office'),
            shipToAddressId: id('party-address:P1:workshop'),
            incoterm: 'DAP',
            incotermPlace: 'Seedville',
            paymentTermsId: pricing.paymentTermsIds.BB30FM,
            paymentTerms: 'Bank transfer 30 days end of month',
            priceListVersionId: pricing.activeVersionId,
            netAmount: 126_000,
            vatAmount: 27_720,
            grossAmount: 153_720,
            ...stamp(T.quoted),
          },
          select,
        })
        await tx.quoteLine.create({
          data: {
            id: q4.lineId,
            versionId: q4.versionId,
            partyId: P1,
            seq: 10,
            kind: SalesLineKind.SIZE_GRID,
            styleId: jkt01,
            styleRevisionId: pricing.product.revisionId,
            colourwayId: jkt01Red,
            description: 'SEED-JKT-01 Red',
            quantity: 3,
            listUnitPrice: '430.000000',
            unitPrice: '420.000000',
            priceSteps: [
              { kind: 'LIST', unitPrice: '430.000000', source: source('PriceListEntry', id('pricing:list:P1:v1:JKT-01:RED')), label: 'SEED-PL-P1, version 1' },
              { kind: 'MANUAL', delta: '-10.000000', unitPrice: '420.000000', reasonCode: 'VOLUME' },
              { kind: 'NET', unitPrice: '420.000000' },
            ],
            netAmount: 126_000,
            vatRatePct: '22.00',
            vatAmount: 27_720,
            ...stamp(T.quoted),
          },
          select,
        })
        await tx.quoteLineSize.create({ data: { id: id('sales-pricing:Q4:v1:line:10:52'), lineId: q4.lineId, partyId: P1, size: '52', quantity: 3, ...stamp(T.quoted) }, select })
        const step = (at: Date) => ({ updatedAt: at, version: { increment: 1 } })
        await tx.quoteVersion.update({
          where: { id: q4.versionId },
          data: { status: QuoteVersionStatus.SENT, sentAt: T.sent, sentById: actorId, validUntil: DAY.q4ValidUntil, documentSha256: sha256(`seed quote SEED-Q-0004 version 1 (${namespace})`), billTo, shipTo, ...step(T.sent) },
          select,
        })
        await tx.quote.update({ where: { id: q4.quoteId }, data: { status: QuoteStatus.SENT, ...step(T.sent) }, select })
        await tx.quoteVersion.update({ where: { id: q4.versionId }, data: { reminderSentAt: T.reminded, ...step(T.reminded) }, select })
      }

      // --- SEED-SO-0004: an order typed by the office, configured and scheduled ----------------------------------------
      if (!(await tx.salesOrder.findUnique({ where: { id: so.orderId }, select }))) {
        await tx.salesOrder.create({
          data: {
            id: so.orderId,
            companyId: companyA,
            partyId: P1,
            number: 'SEED-SO-0004',
            status: SalesOrderStatus.CONFIRMED,
            orderDate: DAY.orderDate,
            currency: 'EUR',
            language: 'it',
            taxMode: PartyTaxMode.IT_B2B,
            billTo,
            shipTo,
            incoterm: 'DAP',
            incotermPlace: 'Seedville',
            shipComplete: false,
            paymentTermsId: pricing.paymentTermsIds.BB30FM,
            paymentTerms: 'Bank transfer 30 days end of month',
            netAmount: 188_000,
            vatAmount: 41_360,
            grossAmount: 229_360,
            ...stamp(T.ordered),
          },
          select,
        })
        await tx.salesOrderLine.create({
          data: {
            id: so.lineId,
            companyId: companyA,
            orderId: so.orderId,
            partyId: P1,
            seq: 10,
            kind: SalesLineKind.SIZE_GRID,
            styleId: jkt05,
            colourwayId: jkt05Blk,
            description: 'SEED-JKT-05 Black with the thermal liner',
            quantity: 4,
            unitPrice: '470.000000',
            priceSteps: [
              { kind: 'SUGGESTED', unitPrice: '400.000000', source: source('StyleRevision', options.jacketRevisionId) },
              { kind: 'OPTION', delta: '60.000000', unitPrice: '460.000000', source: source('SalesOrderLineOption', soOptions.liner), label: 'Thermal liner' },
              { kind: 'MANUAL', delta: '10.000000', unitPrice: '470.000000', reasonCode: 'LOYALTY', note: 'Made-up: the liner fitted by hand.' },
              { kind: 'NET', unitPrice: '470.000000' },
            ],
            netAmount: 188_000,
            vatRatePct: '22.00',
            vatAmount: 41_360,
            ...stamp(T.ordered),
          },
          select,
        })
        await tx.salesOrderLineSize.createMany({
          data: [
            { id: id('sales-pricing:SO4:line:10:50'), lineId: so.lineId, partyId: P1, size: '50', quantity: 2, ...stamp(T.ordered) },
            { id: id('sales-pricing:SO4:line:10:52'), lineId: so.lineId, partyId: P1, size: '52', quantity: 2, ...stamp(T.ordered) },
          ],
        })
        await tx.salesOrderLineOption.createMany({
          data: [
            { id: soOptions.armour, lineId: so.lineId, partyId: P1, groupId: options.groupIds.armour, valueId: options.valueIds.armourStd, byDefault: true, ...stamp(T.ordered) },
            { id: soOptions.liner, lineId: so.lineId, partyId: P1, groupId: options.groupIds.liner, valueId: options.valueIds.linerYes, surchargeAmount: '60.000000', ...stamp(T.ordered) },
          ],
        })
        await tx.salesOrderLineDelivery.createMany({
          data: [
            { id: firstId('sales-pricing:SO4:line:10:delivery:1'), lineId: so.lineId, partyId: P1, deliveryDate: DAY.soFirstDelivery, sizeQuantities: { '50': 1 }, quantity: 1, ...stamp(T.ordered) },
            { id: id('sales-pricing:SO4:line:10:delivery:2'), lineId: so.lineId, partyId: P1, deliveryDate: DAY.soSecondDelivery, sizeQuantities: { '52': 2 }, quantity: 2, ...stamp(T.ordered) },
          ],
        })
      }
    }),
  )

  return {
    templateIds,
    curveIds,
    draftQuote: q3,
    sentQuote: q4,
    order: so,
    breakIds,
    surchargeIds,
    moqRuleIds,
  }
}
