import { IsoWeekday, PackagingKind, PalletKind, ShipmentHoldReason, ShippingMarkField } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduct } from './product'
import { seed as seedShipping } from './shipping'

/**
 * The packing seed (W2b-6, schema wave 46/57, B-W2b-364), per tenant of seed/_core.ts, written as apps/factory-api's
 * modules/shipping will write it (B-W2b-384, -386, -387): the office's rows in the tenant's office scope, the carton's
 * contents in A1's floor scope (the operator at the packing table). It runs the product seed (SEED-JKT-01 and its EU
 * jacket scale) and the shipping seed (SEED-SH-0002, a DRAFT shipment of one serial-tracked jacket in one parcel) first,
 * both idempotent.
 *
 *   packaging   company A: the cartons 60x40x40 and 40x30x20, a EUR pallet, a polybag and a hanger (each with a made-up
 *               cost per unit), an old box switched off; company B: one carton.
 *   defaults    company A: SEED-JKT-01 in the big carton and a polybag, sizes 48-50 of the EU jacket scale in the small
 *               carton; an earlier default of SEED-JKT-01 (the small carton) switched off.
 *   SH-0002     its parcel becomes a 60x40x40 carton, "1 of 1", its marks printed; its contents: the one BLK 52 jacket of
 *               its line. Its serials are not packed here: other seeds and the golden flows use them as they are.
 *   marks       company A's default (Italian), P1's brand marks (English, its PO and style codes, batch and origin), and
 *               an earlier default switched off.
 *   holds       on SH-0002, both released: the balance before shipping (released when it came in) and the customer's
 *               request to wait a day. None in force, so the shipment still packs.
 *   cut-offs    A1: the made-up carrier "seed-express" at 16:30 Monday to Friday and 11:00 on Saturday; B1: our own van at
 *               15:00 on Friday.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a
 * switched-off default and mark template, a released hold, the contents of a DRAFT shipment's carton (no cap while DRAFT).
 * Every name, code and value is invented; every time is before the day the wave was built (the guards refuse a hold, a
 * release or marks printed in the future). Idempotent: written once, skipped when its first row exists.
 */

const T = {
  setup: new Date('2026-11-09T08:00:00.000Z'),
  replaced: new Date('2026-11-10T08:00:00.000Z'),
  balanceHeld: new Date('2026-11-10T09:00:00.000Z'),
  balancePaid: new Date('2026-11-11T10:30:00.000Z'),
  customerWait: new Date('2026-11-11T14:00:00.000Z'),
  customerGo: new Date('2026-11-12T08:15:00.000Z'),
  packed: new Date('2026-11-12T09:00:00.000Z'),
  marks: new Date('2026-11-12T09:05:00.000Z'),
} as const

export interface PackingSeed {
  readonly companyA: string
  readonly packagingTypeIds: { readonly carton: string; readonly smallCarton: string; readonly pallet: string; readonly polybag: string; readonly hanger: string; readonly oldBox: string; readonly cartonB: string }
  readonly defaultIds: { readonly old: string; readonly styleCarton: string; readonly stylePolybag: string; readonly runCarton: string }
  readonly markTemplateIds: { readonly old: string; readonly defaultA: string; readonly brandP1: string }
  readonly holdIds: { readonly balance: string; readonly customer: string }
  readonly parcelLineId: string
  readonly cutOffIds: readonly string[]
  /** SH-0002, its line and parcel (the shipping seed's). */
  readonly shipmentId: string
  readonly shipmentLineId: string
  readonly parcelId: string
}

export async function seed(context: SeedContext): Promise<PackingSeed> {
  const { db, namespace } = context
  const product = await seedProduct(context)
  const shipping = await seedShipping(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const P1 = id('party:P1')
  const operatorId = id('worker:A1:operator')
  const scaleId = id('product:size-scale:EU-JKT')
  const office = { audience: 'office' as const, tenantId, actorId }
  const packer = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const select = { id: true } as const

  const result: PackingSeed = {
    companyA,
    packagingTypeIds: {
      carton: firstId('packing:type:A:carton-60'),
      smallCarton: id('packing:type:A:carton-40'),
      pallet: id('packing:type:A:pallet-eur'),
      polybag: id('packing:type:A:polybag'),
      hanger: id('packing:type:A:hanger'),
      oldBox: id('packing:type:A:old-box'),
      cartonB: id('packing:type:B:carton'),
    },
    defaultIds: {
      old: firstId('packing:default:A:JKT-01:carton:old'),
      styleCarton: id('packing:default:A:JKT-01:carton'),
      stylePolybag: id('packing:default:A:JKT-01:polybag'),
      runCarton: id('packing:default:A:EU-JKT:48-50:carton'),
    },
    markTemplateIds: { old: firstId('packing:marks:A:default:old'), defaultA: id('packing:marks:A:default'), brandP1: id('packing:marks:A:P1') },
    holdIds: { balance: firstId('packing:hold:SH-0002:balance'), customer: id('packing:hold:SH-0002:customer') },
    parcelLineId: firstId('packing:contents:SH-0002:1'),
    cutOffIds: [
      firstId('packing:cut-off:A1:seed-express:MONDAY'),
      ...(['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const).map((day) => id(`packing:cut-off:A1:seed-express:${day}`)),
      id('packing:cut-off:B1:own-van:FRIDAY'),
    ],
    shipmentId: shipping.draftShipmentId,
    shipmentLineId: shipping.draftLineId,
    parcelId: shipping.draftParcelId,
  }
  const { packagingTypeIds: P, defaultIds: D, markTemplateIds: M, holdIds: H } = result

  if (await db.withScope(office, (client) => client.packagingType.findUnique({ where: { id: P.carton }, select }))) return result

  // --- the office: packaging, defaults, mark templates, cut-offs and the holds on SH-0002 --------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const eur = { costCurrency: 'EUR' }
      await tx.packagingType.createMany({
        data: [
          { id: P.carton, companyId: companyA, kind: PackagingKind.CARTON, name: 'Seed carton 60x40x40', innerLengthCm: '58.00', innerWidthCm: '38.00', innerHeightCm: '38.00', tareKg: '0.8000', maxWeightKg: '25.0000', costPerUnit: '1.200000', ...eur, ...stamp(T.setup) },
          { id: P.smallCarton, companyId: companyA, kind: PackagingKind.CARTON, name: 'Seed carton 40x30x20', innerLengthCm: '38.00', innerWidthCm: '28.00', innerHeightCm: '18.00', tareKg: '0.4000', maxWeightKg: '12.0000', costPerUnit: '0.750000', ...eur, ...stamp(T.setup) },
          { id: P.pallet, companyId: companyA, kind: PackagingKind.PALLET, name: 'Seed EUR pallet', palletKind: PalletKind.EUR, tareKg: '25.0000', maxWeightKg: '1000.0000', costPerUnit: '9.000000', ...eur, ...stamp(T.setup) },
          { id: P.polybag, companyId: companyA, kind: PackagingKind.POLYBAG, name: 'Seed garment polybag', costPerUnit: '0.050000', ...eur, ...stamp(T.setup) },
          { id: P.hanger, companyId: companyA, kind: PackagingKind.HANGER, name: 'Seed jacket hanger', costPerUnit: '0.150000', ...eur, ...stamp(T.setup) },
          { id: P.oldBox, companyId: companyA, kind: PackagingKind.BOX, name: 'Seed old shoe box', innerLengthCm: '33.00', innerWidthCm: '22.00', innerHeightCm: '12.00', active: false, ...stamp(T.setup) },
          { id: P.cartonB, companyId: companyB, kind: PackagingKind.CARTON, name: 'Seed carton B 50x40x30', innerLengthCm: '48.00', innerWidthCm: '38.00', innerHeightCm: '28.00', tareKg: '0.6000', maxWeightKg: '20.0000', ...stamp(T.setup) },
        ],
      })
      // The earlier default first, switched off when the big carton replaced it.
      await tx.packagingDefault.create({
        data: { id: D.old, companyId: companyA, packagingTypeId: P.smallCarton, kind: PackagingKind.CARTON, styleId: product.styleId, ...stamp(T.setup) },
        select,
      })
      await tx.packagingDefault.update({ where: { id: D.old }, data: { active: false, version: 2, updatedAt: T.replaced }, select })
      await tx.packagingDefault.createMany({
        data: [
          { id: D.styleCarton, companyId: companyA, packagingTypeId: P.carton, kind: PackagingKind.CARTON, styleId: product.styleId, ...stamp(T.replaced) },
          { id: D.stylePolybag, companyId: companyA, packagingTypeId: P.polybag, kind: PackagingKind.POLYBAG, styleId: product.styleId, ...stamp(T.replaced) },
          { id: D.runCarton, companyId: companyA, packagingTypeId: P.smallCarton, kind: PackagingKind.CARTON, sizeScaleId: scaleId, fromSize: '48', toSize: '50', ...stamp(T.replaced) },
        ],
      })

      await tx.shippingMarkTemplate.create({
        data: { id: M.old, companyId: companyA, fields: [ShippingMarkField.SHIP_TO, ShippingMarkField.CARTON_NUMBER], language: 'it', ...stamp(T.setup) },
        select,
      })
      await tx.shippingMarkTemplate.update({ where: { id: M.old }, data: { active: false, version: 2, updatedAt: T.replaced }, select })
      await tx.shippingMarkTemplate.createMany({
        data: [
          {
            id: M.defaultA,
            companyId: companyA,
            fields: [ShippingMarkField.SHIP_TO, ShippingMarkField.SENDER, ShippingMarkField.ORDER_NUMBER, ShippingMarkField.STYLE, ShippingMarkField.COLOUR, ShippingMarkField.SIZES, ShippingMarkField.QUANTITY, ShippingMarkField.CARTON_NUMBER, ShippingMarkField.GROSS_WEIGHT],
            language: 'it',
            ...stamp(T.replaced),
          },
          {
            id: M.brandP1,
            companyId: companyA,
            partyId: P1,
            fields: [
              ShippingMarkField.SHIP_TO, ShippingMarkField.CUSTOMER_ORDER, ShippingMarkField.CUSTOMER_STYLE, ShippingMarkField.COLOUR, ShippingMarkField.SIZES, ShippingMarkField.QUANTITY,
              ShippingMarkField.CARTON_NUMBER, ShippingMarkField.GROSS_WEIGHT, ShippingMarkField.NET_WEIGHT, ShippingMarkField.DIMENSIONS, ShippingMarkField.BATCH, ShippingMarkField.ORIGIN,
            ],
            language: 'en',
            ...stamp(T.replaced),
          },
        ],
      })

      const [monday, ...weekdays] = result.cutOffIds
      await tx.carrierCutOff.createMany({
        data: [
          { id: monday!, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', weekday: IsoWeekday.MONDAY, cutOffTime: '16:30', ...stamp(T.setup) },
          ...(['TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const).map((day, index) => ({
            id: weekdays[index]!, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', weekday: IsoWeekday[day], cutOffTime: '16:30', ...stamp(T.setup),
          })),
          { id: weekdays[4]!, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', weekday: IsoWeekday.SATURDAY, cutOffTime: '11:00', ...stamp(T.setup) },
          { id: weekdays[5]!, companyId: companyB, siteId: siteB, carrierCode: 'own-van', weekday: IsoWeekday.FRIDAY, cutOffTime: '15:00', ...stamp(T.setup) },
        ],
      })

      // SH-0002's holds: each placed, then released (the history is the rows).
      const hold = { siteId: siteA, partyId: P1, shipmentId: shipping.draftShipmentId }
      await tx.shipmentHold.create({
        data: { id: H.balance, ...hold, reason: ShipmentHoldReason.BALANCE_UNPAID, words: 'Seed: the balance is due before the goods leave.', placedAt: T.balanceHeld, ...stamp(T.balanceHeld, actorId), placedById: null },
        select,
      })
      await tx.shipmentHold.update({ where: { id: H.balance }, data: { releasedAt: T.balancePaid, releaseWords: 'Seed: the balance came in by bank transfer.', version: 2, updatedAt: T.balancePaid }, select })
      await tx.shipmentHold.create({
        data: { id: H.customer, ...hold, reason: ShipmentHoldReason.CUSTOMER_REQUEST, placedAt: T.customerWait, placedById: actorId, ...stamp(T.customerWait) },
        select,
      })
      await tx.shipmentHold.update({
        where: { id: H.customer },
        data: { releasedAt: T.customerGo, releasedById: actorId, releaseWords: 'Seed: the customer can take the goods from today.', version: 2, updatedAt: T.customerGo },
        select,
      })
    }),
  )

  // --- the packing table (A1's floor): SH-0002's parcel is a 60x40x40 carton, 1 of 1, with its contents ------------------
  await db.withScope(packer, (client) =>
    client.$transaction(async (tx) => {
      await tx.parcel.update({
        where: { id: shipping.draftParcelId },
        data: { packagingTypeId: P.carton, cartonNumber: 1, cartonCount: 1, marksPrintedAt: T.marks, version: { increment: 1 }, updatedAt: T.marks },
        select,
      })
      await tx.parcelLine.create({
        data: { id: result.parcelLineId, siteId: siteA, partyId: P1, shipmentId: shipping.draftShipmentId, parcelId: shipping.draftParcelId, shipmentLineId: shipping.draftLineId, size: '52', quantity: 1, ...stamp(T.packed, operatorId) },
        select,
      })
    }),
  )

  return result
}
