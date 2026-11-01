import type { Prisma } from '../src/generated/prisma/client'
import { DdtFreight, DdtReason, ShipmentStatus, TrackingSource, TrackingStatus, TransportBy, TransportMode } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedNumbering } from './numbering'
import { seed as seedQuality, type QualitySeed } from './quality'

/**
 * The shipping seed, per tenant of seed/_core.ts: the golden flow's stage 14-ship on plant A1, written as the app does:
 * the office's rows in the tenant's office scope (shipments, labels, DDTs, tracking from the carrier), the packing in
 * A1's floor scope (the operator signed in at the packing table).
 *
 *   settings    A1 and B1 have their shipping settings (sender address, a made-up carrier, cut-off).
 *   SH-0001     SEED-SO-0002's released BLK 50 and RED 52 (one each), from WO-0001: two parcels packed and weighed on the
 *               floor, PACKED; carrier labels bought (made-up tracking numbers); DDT 143/2026 issued from company A's
 *               DDT series, then cancelled (the goods' appearance was wrong) and replaced by DDT 144/2026, which keeps
 *               the series without a gap (their NumberAllocation rows, the series moved to 145); SHIPPED; tracking:
 *               both labels created, then in transit. W2b (B-W2b-01): its DDTs keep the language they were printed in
 *               (Italian) and the mode of transport (road); it left by road, and the carrier's cost (18.50 EUR, a cost
 *               the office alone reads) is on it.
 *   SH-0002     a DRAFT shipment of SEED-SO-0003's serial-tracked jacket: one of WO-0003's two released garments, one
 *               parcel, being packed (its serial is packed before it is PACKED).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: lines and parcels change only while their shipment is a DRAFT, and a cell's lines never ship more than it has
 * released (less reversals). So the DRAFT shipment, its line and its parcel get ids that start with eight zeros (still
 * derived from the namespace), and its line takes one of WO-0003's two released garments, leaving one.
 *
 * Every name, number and value is invented. Idempotent: each step runs once and is skipped when its rows exist (DDTs,
 * their cancellations and tracking events are append-only, a shipment that left never changes).
 */

/** Fixed instants and dates, so the seed never depends on the clock. */
const T = {
  setup: new Date('2026-11-08T08:00:00.000Z'),
  planned: new Date('2026-11-23T08:00:00.000Z'),
  packed: new Date('2026-11-23T10:00:00.000Z'),
  labelled: new Date('2026-11-23T11:00:00.000Z'),
  firstDdt: new Date('2026-11-24T07:30:00.000Z'),
  cancelled: new Date('2026-11-24T07:40:00.000Z'),
  secondDdt: new Date('2026-11-24T07:45:00.000Z'),
  start: new Date('2026-11-24T08:00:00.000Z'),
  pickedUp: new Date('2026-11-24T08:05:00.000Z'),
  inTransit: new Date('2026-11-24T17:30:00.000Z'),
  draft: new Date('2026-11-25T08:00:00.000Z'),
} as const
// B-W2b-30: the DDTs' date (and the series' last issued date) is in the past, before any invoice of them, so a fresh
// seed issues the TD24 draft of DDT 144 (FatturaPA: no DDT dated after its invoice) and, with the holds seed's DDT 145
// dated the same day, today's DDTs of the series. Their issue and transport times stay in the November story above.
const DDT_DATE = new Date('2026-10-30T00:00:00.000Z')
const YEAR = '2026'

export interface ShippingSeed {
  readonly quality: QualitySeed
  /** SH-0001 (SHIPPED), its lines and parcels; SH-0002 (DRAFT), its line and parcel. */
  readonly shipmentId: string
  readonly lineIds: readonly [string, string]
  readonly parcelIds: readonly [string, string]
  readonly draftShipmentId: string
  readonly draftLineId: string
  readonly draftParcelId: string
  /** DDT 143/2026 (cancelled), its cancellation, DDT 144/2026 (live); company A's DDT series. */
  readonly cancelledDdtId: string
  readonly cancellationId: string
  readonly ddtId: string
  readonly ddtSeriesId: string
}

export async function seed(context: SeedContext): Promise<ShippingSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the released garments this seed ships come from the quality seed (which runs
  // the seeds before it), and the DDT series from the numbering seed: run them first (both are idempotent).
  const quality = await seedQuality(context)
  await seedNumbering(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const brandId = id('party:P1')
  const operatorId = id('worker:A1:operator')
  const office = { audience: 'office' as const, tenantId, actorId }
  const packer = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const { production } = quality
  const cell = production.cellIds
  const orderLine = { BLK: id('production:sales-order:SO-0002:10'), RED: id('production:sales-order:SO-0002:20') }
  const senderAddress = { name: 'Seed Factory A S.r.l.', line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT', phone: '+39 000 0000000' }
  const shipTo = { name: 'Seed Racing workshop', line1: 'Via Esempio 12', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' }
  const carrier = { carrierCode: 'seed-express', carrierName: 'Seed Express', serviceCode: 'seed-standard' }

  // --- the shipping settings ------------------------------------------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const settings: (Prisma.ShippingSettingsCreateManyInput & { id: string })[] = [
        {
          id: siteA,
          companyId: companyA,
          siteId: siteA,
          senderAddress,
          defaultCarrierCode: carrier.carrierCode,
          defaultServiceCode: carrier.serviceCode,
          defaultTransportBy: TransportBy.CARRIER,
          defaultGoodsAppearance: 'Scatole di cartone',
          cutOffTime: '16:00',
          ...stamp(T.setup),
        },
        {
          id: siteB,
          companyId: id('company:B'),
          siteId: siteB,
          senderAddress: { ...senderAddress, name: 'Seed Factory B S.r.l.', line1: 'Via Seed 2' },
          defaultTransportBy: TransportBy.SENDER,
          ...stamp(T.setup),
        },
      ]
      for (const { id: rowId, ...data } of settings) await tx.shippingSettings.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data, select: { id: true } })
    }),
  )

  // --- SH-0001: planned, packed on the floor, labelled ----------------------------------------------------------------
  const shipmentId = id('shipping:shipment:SH-0001')
  const parcelIds = [id('shipping:SH-0001:parcel:1'), id('shipping:SH-0001:parcel:2')] as const
  const lineIds = [id('shipping:SH-0001:line:BLK-50'), id('shipping:SH-0001:line:RED-52')] as const
  const cancelledDdtId = id('shipping:ddt:143')
  const cancellationId = id('shipping:ddt:143:cancellation')
  const ddtId = id('shipping:ddt:144')
  const ddtSeriesId = id(`series:A:DDT:MAIN:${YEAR}`)
  const shipped = await db.withScope(office, (client) => client.shipment.findUnique({ where: { id: shipmentId }, select: { id: true } }))
  if (!shipped) {
    await db.withScope(office, (client) =>
      client.shipment.create({
        data: { id: shipmentId, companyId: companyA, siteId: siteA, partyId: brandId, salesOrderId: production.salesOrderId, number: 'SEED-SH-0001', shipTo, transportBy: TransportBy.CARRIER, ...carrier, ...stamp(T.planned) },
        select: { id: true },
      }),
    )
    await db.withScope(packer, (client) =>
      client.$transaction(async (tx) => {
        await tx.parcel.createMany({
          data: parcelIds.map((parcelId, index) => ({
            id: parcelId,
            siteId: siteA,
            partyId: brandId,
            shipmentId,
            seq: index + 1,
            grossWeightKg: index === 0 ? '3.1000' : '2.9000',
            lengthCm: '60.00',
            widthCm: '40.00',
            heightCm: '15.00',
            ...stamp(T.packed, operatorId),
          })),
        })
        await tx.shipmentLine.createMany({
          data: [
            { id: lineIds[0], parcelId: parcelIds[0], workOrderSizeId: cell['BLK-50'], salesOrderLineId: orderLine.BLK, size: '50' },
            { id: lineIds[1], parcelId: parcelIds[1], workOrderSizeId: cell['RED-52'], salesOrderLineId: orderLine.RED, size: '52' },
          ].map((line) => ({ ...line, siteId: siteA, partyId: brandId, shipmentId, workOrderId: production.workOrderId, quantity: 1, ...stamp(T.packed, operatorId) })),
        })
        await tx.shipment.update({ where: { id: shipmentId }, data: { status: ShipmentStatus.PACKED, packedAt: T.packed, updatedAt: T.packed }, select: { id: true } })
      }),
    )
    await db.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        // The carrier labels (B-W1-48 buys them through Sendcloud; made-up numbers here), and the carrier's first events.
        for (const [index, parcelId] of parcelIds.entries()) {
          await tx.parcel.update({
            where: { id: parcelId },
            data: { trackingNumber: `SEEDTRACK000${index + 1}`, carrierParcelId: `seed-parcel-${index + 1}`, labelledAt: T.labelled, updatedAt: T.labelled },
            select: { id: true },
          })
        }
        await tx.shipment.update({ where: { id: shipmentId }, data: { carrierShipmentId: 'seed-shipment-0001', updatedAt: T.labelled }, select: { id: true } })
        await tx.trackingEvent.createMany({
          data: parcelIds.map((parcelId, index) => ({
            id: id(`shipping:SH-0001:tracking:label:${index + 1}`),
            siteId: siteA,
            partyId: brandId,
            shipmentId,
            parcelId,
            status: TrackingStatus.LABEL_CREATED,
            carrierStatusCode: 'ANNOUNCED',
            description: 'Label created',
            occurredAt: T.labelled,
            recordedAt: T.labelled,
            source: TrackingSource.WEBHOOK,
            externalEventId: `seed-event-label-${index + 1}`,
            createdById: actorId,
          })),
        })
      }),
    )
  }

  // --- the DDTs: 143/2026 cancelled and replaced by 144/2026; then SH-0001 leaves -------------------------------------
  const ddtLines = [
    { seq: 1, description: 'Giacca moto in pelle SEED-JKT-02, nero, taglia 50 (DPI cat. II, EN 17092-3 classe AA)', quantity: '1', uom: 'PCS', salesOrderLineId: orderLine.BLK, size: '50', batchNumber: 'SEED-BT-0001', serials: [] },
    { seq: 2, description: 'Giacca moto in pelle SEED-JKT-02, rosso, taglia 52 (DPI cat. II, EN 17092-3 classe AA)', quantity: '1', uom: 'PCS', salesOrderLineId: orderLine.RED, size: '52', batchNumber: 'SEED-BT-0001', serials: [] },
  ]
  const ddt = (number: string, appearance: string, at: Date) => ({
    companyId: companyA,
    siteId: siteA,
    partyId: brandId,
    shipmentId,
    numberSeriesId: ddtSeriesId,
    number,
    documentDate: DDT_DATE,
    reason: DdtReason.SALE,
    transportBy: TransportBy.CARRIER,
    language: 'it',
    transportMode: TransportMode.ROAD,
    carrier: { name: carrier.carrierName, address: { line1: 'Via Corriere 3', postalCode: '00000', city: 'Seedport', country: 'IT' }, vatNumber: 'IT00000000000' },
    startAt: T.start,
    appearance,
    packages: 2,
    grossWeightKg: '6.0000',
    netWeightKg: '4.8000',
    freight: DdtFreight.FREE,
    sender: { name: 'Seed Factory A S.r.l.', vatNumber: 'IT00000000000', address: { line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', province: 'MI', country: 'IT' } },
    recipient: { name: 'Seed Customer One S.r.l.', vatNumber: 'IT00000000001', address: { line1: 'Via Esempio 10', postalCode: '00000', city: 'Seedville', province: 'MI', country: 'IT' } },
    destination: shipTo,
    lines: ddtLines,
    documentRefs: [{ kind: 'CUSTOMER_ORDER', number: 'SEED-PO-78', date: '2026-11-12' }],
    issuedAt: at,
    createdById: actorId,
  })
  const allocation = (value: number, recordId: string, at: Date): Prisma.NumberAllocationCreateManyInput => ({
    id: id(`shipping:allocation:DDT:${value}`),
    companyId: companyA,
    seriesId: ddtSeriesId,
    kind: 'DDT',
    value,
    formatted: `${value}/${YEAR}`,
    documentDate: DDT_DATE,
    recordType: 'Ddt',
    recordId,
    allocatedAt: at,
    allocatedById: actorId,
    requestId: `seed-shipping-ddt-${value}`,
  })
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.ddt.findUnique({ where: { id: cancelledDdtId }, select: { id: true } })) return
      // As allocateNumber does: lock the series row, take its next number, record it and move the counter.
      await tx.$queryRaw`SELECT 1 FROM "NumberSeries" WHERE "id" = ${ddtSeriesId}::uuid FOR UPDATE`
      await tx.ddt.create({ data: { id: cancelledDdtId, ...ddt(`143/${YEAR}`, 'Pallet', T.firstDdt) }, select: { id: true } })
      await tx.numberAllocation.create({ data: allocation(143, cancelledDdtId, T.firstDdt), select: { id: true } })
      await tx.ddtCancellation.create({
        data: { id: cancellationId, siteId: siteA, partyId: brandId, ddtId: cancelledDdtId, reason: 'Wrong appearance of the goods: two cardboard boxes, not a pallet.', cancelledAt: T.cancelled, createdById: actorId },
        select: { id: true },
      })
      await tx.ddt.create({ data: { id: ddtId, ...ddt(`144/${YEAR}`, 'Due scatole di cartone', T.secondDdt) }, select: { id: true } })
      await tx.numberAllocation.create({ data: allocation(144, ddtId, T.secondDdt), select: { id: true } })
      await tx.numberSeries.update({ where: { id: ddtSeriesId }, data: { nextValue: 145, lastIssuedDate: DDT_DATE, updatedAt: T.secondDdt }, select: { id: true } })
    }),
  )
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const leaving = await tx.shipment.updateMany({
        where: { id: shipmentId, status: ShipmentStatus.PACKED },
        data: { status: ShipmentStatus.SHIPPED, shippedAt: T.pickedUp, updatedAt: T.pickedUp, transportMode: TransportMode.ROAD, freightCost: 1_850, freightCostCurrency: 'EUR' },
      })
      if (leaving.count === 0) return
      await tx.trackingEvent.create({
        data: {
          id: id('shipping:SH-0001:tracking:in-transit'),
          siteId: siteA,
          partyId: brandId,
          shipmentId,
          status: TrackingStatus.IN_TRANSIT,
          carrierStatusCode: 'EN_ROUTE',
          description: 'In transit to the delivery depot',
          location: 'Seedport hub',
          occurredAt: T.inTransit,
          recordedAt: T.inTransit,
          source: TrackingSource.WEBHOOK,
          externalEventId: 'seed-event-in-transit',
          createdById: actorId,
        },
        select: { id: true },
      })
    }),
  )

  // --- SH-0002: a DRAFT being packed ----------------------------------------------------------------------------------
  const draftShipmentId = firstId('shipping:shipment:SH-0002')
  const draftLineId = firstId('shipping:SH-0002:line:BLK-52-JKT-03')
  const draftParcelId = firstId('shipping:SH-0002:parcel:1')
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.shipment.findUnique({ where: { id: draftShipmentId }, select: { id: true } })) return
      await tx.shipment.create({
        data: { id: draftShipmentId, companyId: companyA, siteId: siteA, partyId: brandId, salesOrderId: quality.serialSalesOrderId, number: 'SEED-SH-0002', shipTo, transportBy: TransportBy.CARRIER, ...carrier, ...stamp(T.draft) },
        select: { id: true },
      })
    }),
  )
  await db.withScope(packer, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.parcel.findUnique({ where: { id: draftParcelId }, select: { id: true } })) return
      await tx.parcel.create({ data: { id: draftParcelId, siteId: siteA, partyId: brandId, shipmentId: draftShipmentId, seq: 1, ...stamp(T.draft, operatorId) }, select: { id: true } })
      await tx.shipmentLine.create({
        data: {
          id: draftLineId,
          siteId: siteA,
          partyId: brandId,
          shipmentId: draftShipmentId,
          parcelId: draftParcelId,
          workOrderId: quality.serialWorkOrderId,
          workOrderSizeId: quality.serialCellId,
          salesOrderLineId: quality.serialSalesOrderLineId,
          size: '52',
          quantity: 1,
          ...stamp(T.draft, operatorId),
        },
        select: { id: true },
      })
    }),
  )

  return { quality, shipmentId, lineIds, parcelIds, draftShipmentId, draftLineId, draftParcelId, cancelledDdtId, cancellationId, ddtId, ddtSeriesId }
}
