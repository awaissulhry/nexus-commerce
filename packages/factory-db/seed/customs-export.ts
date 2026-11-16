import { createHash } from 'node:crypto'
import { DutyPayer, MasterStatus, ShipmentStatus, TransportBy } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCustoms } from './customs'
import { seed as seedQuality } from './quality'

/**
 * The export to a country outside the EU (B-W2b-F59), per tenant of seed/_core.ts, so the customs papers, the broker's
 * document pack and its link can be tried on a fresh seed (LOG-095, LOG-097). Written as the app writes it: the office's rows
 * in the tenant's office scope, the packing in plant A1's floor scope (the operator at the packing table). It runs the customs
 * seed first (which runs the files, returns, shipping, money and quality seeds; all idempotent).
 *
 *   EORI      company B's made-up EORI (IT and its made-up Partita IVA, as company A's of customs.ts): every company has one.
 *   style     SEED-JKT-02's customs facts: HS 4203 10 00 (garments of leather), made in Italy, 1.850 kg net a garment.
 *   release   one more garment of WO-0001, a RED 50, released from its PASSED inspection (SEED-REL-0006, the lot's fifth),
 *             under the style's certificate, like the quality seed's releases.
 *   SH-0003   party P1's SEED-SO-0002 (its prices: the values on the papers): that garment to the team's base in Switzerland
 *             (a made-up address in "Seedwil", CH: the destination customs reads), one parcel packed and weighed on the floor,
 *             PACKED; the duties paid by the receiver. A non-EU destination is what the export papers and the pack rest on.
 *   broker    the customs seed's broker (SEED-BROKER) gets an active contact with an e-mail (example.com), so its link can be
 *             mailed (FAKE locally: the local mailbox) as well as passed on.
 *
 * Left to the person, as the story's next steps (each a route of the API): open the export declaration on SH-0003 (choosing
 * SEED-BROKER), print the packing list and the commercial invoice (the API makes their PDFs), switch the broker pack ON at
 * plant A1 (OFF by default, the Owner's rule of 11-13: a step-up of his), then send the pack by link. The customer stays P1
 * (an Italian brand shipping to its own base abroad): a Swiss customer would need its own order, work order, inspection and
 * release (see the step's notes).
 *
 * The generated isolation tests copy the FIRST row of each table by id: every row here has an id starting with eight f's, so
 * it is never a first row. Every name, number and value is invented. Idempotent: skipped when its shipment exists.
 */

const T = {
  released: seedAt('2026-11-25T09:00:00.000Z'),
  planned: seedAt('2026-11-25T10:00:00.000Z'),
  packed: seedAt('2026-11-25T11:00:00.000Z'),
} as const
/** Company B's made-up EORI: IT and the made-up Partita IVA of seed/_core.ts. */
export const SEED_EORI_B = 'IT00000004044'

export interface CustomsExportSeed {
  readonly shipmentId: string
  readonly parcelId: string
  readonly lineId: string
  readonly releaseId: string
  readonly brokerPartyId: string
  readonly brokerContactId: string
}

export async function seed(context: SeedContext): Promise<CustomsExportSeed> {
  const { db, namespace } = context
  const customs = await seedCustoms(context)
  const quality = await seedQuality(context)
  const { production } = quality
  const id = (key: string): string => seedUuid(namespace, key)
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const operatorId = id('worker:A1:operator')
  const office = { audience: 'office' as const, tenantId, actorId }
  const packer = { audience: 'floor' as const, tenantId, actorId: operatorId, siteId: siteA }
  const select = { id: true } as const

  const result: CustomsExportSeed = {
    shipmentId: lateId('customs-export:shipment:SH-0003'),
    parcelId: lateId('customs-export:SH-0003:parcel:1'),
    lineId: lateId('customs-export:SH-0003:line:RED-50'),
    releaseId: lateId('customs-export:release:WO-0001:RED-50'),
    brokerPartyId: customs.brokerPartyId,
    brokerContactId: lateId('customs-export:broker:contact'),
  }
  if (await db.withScope(office, (client) => client.shipment.findUnique({ where: { id: result.shipmentId }, select }))) return result

  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const shipTo = { name: 'Seed Racing team base (made up)', line1: 'Teststrasse 1', postalCode: '8000', city: 'Seedwil', country: 'CH' }
  const carrier = { carrierCode: 'seed-express', carrierName: 'Seed Express', serviceCode: 'seed-standard' }

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.company.updateMany({ where: { id: companyB, eori: null }, data: { eori: SEED_EORI_B, updatedAt: T.released } })
      await tx.style.update({ where: { id: production.styleId }, data: { hsCode: '42031000', originCountry: 'IT', netMassKg: '1.850' }, select })
      await tx.partyContact.create({
        data: { id: result.brokerContactId, partyId: customs.brokerPartyId, name: 'Seed customs desk (made up)', email: 'customs-desk@seed-broker.example.com', language: 'it', status: MasterStatus.ACTIVE },
        select,
      })
      await tx.qualityRelease.create({
        data: {
          id: result.releaseId,
          number: 'SEED-REL-0006',
          companyId: companyA,
          siteId: siteA,
          workOrderId: production.workOrderId,
          workOrderSizeId: production.cellIds['RED-50'],
          inspectionId: quality.passedInspectionId,
          quantity: 1,
          certificateIds: [quality.certificateId],
          releasedById: actorId,
          releasedAt: T.released,
          signatureSha256: createHash('sha256').update(`seed signed decision release WO-0001:RED-50 (${namespace})`).digest('hex'),
          createdAt: T.released,
          createdById: actorId,
        },
        select,
      })
      await tx.shipment.create({
        data: { id: result.shipmentId, companyId: companyA, siteId: siteA, partyId: brandId, salesOrderId: production.salesOrderId, number: 'SEED-SH-0003', shipTo, transportBy: TransportBy.CARRIER, ...carrier, dutyPayer: DutyPayer.RECEIVER, ...stamp(T.planned) },
        select,
      })
    }),
  )
  await db.withScope(packer, (client) =>
    client.$transaction(async (tx) => {
      await tx.parcel.create({
        data: { id: result.parcelId, siteId: siteA, partyId: brandId, shipmentId: result.shipmentId, seq: 1, grossWeightKg: '2.4000', lengthCm: '60.00', widthCm: '40.00', heightCm: '15.00', ...stamp(T.packed, operatorId) },
        select,
      })
      await tx.shipmentLine.create({
        data: {
          id: result.lineId,
          siteId: siteA,
          partyId: brandId,
          shipmentId: result.shipmentId,
          parcelId: result.parcelId,
          workOrderId: production.workOrderId,
          workOrderSizeId: production.cellIds['RED-50'],
          salesOrderLineId: id('production:sales-order:SO-0002:20'),
          size: '50',
          quantity: 1,
          ...stamp(T.packed, operatorId),
        },
        select,
      })
      await tx.shipment.update({ where: { id: result.shipmentId }, data: { status: ShipmentStatus.PACKED, packedAt: T.packed, updatedAt: T.packed }, select })
    }),
  )
  return result
}
