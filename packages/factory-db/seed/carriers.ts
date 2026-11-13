import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { FreightBilling, GeneratedDocumentKind, IsoWeekday, PickupStatus, PrinterMode } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedParties } from './parties'
import { seed as seedPrint } from './print'
import { seed as seedShipping } from './shipping'

/**
 * The carriers, labels and dispatch seed (W2b-6, schema wave 48/57, B-W2b-367), per tenant of seed/_core.ts, written in the
 * tenant's office scope as apps/factory-api's modules/shipping will write it (B-W2b-390, -391, -395, -400). It runs the
 * files, parties, print and shipping seeds first (all idempotent).
 *
 *   contracts   company A: its contract with the made-up carrier "seed-express" for every site, "use only our rates", and
 *               the earlier one for A1 alone, switched off without its number; company B: "seed-freight". Each live number
 *               is sealed in a SecretValue of purpose shipping.carrier_account (made-up bytes under a key that does not
 *               exist: never openable).
 *   customer    P3 ships on its own "seed-express" account (COLLECT), sealed for parties.carrier_account, its default
 *               service "seed-express-eu".
 *   settings    A1 stays in test mode (the default) and insures a parcel declared above 500.00 EUR; B1 went live on
 *               2026-11-09, switched by the seed's actor.
 *   SH-0002     its parcel declares 520.00 and is insured for 520.00.
 *   pickups     A1 "seed-express": one that failed (the carrier had no driver), then a recurring one, Monday to Friday,
 *               confirmed through the provider; B1 "seed-freight": a pallet booked by phone, confirmed.
 *   day sheets  A1 "seed-express": the sheet of SH-0001's day, open with SH-0001 on it; the sheet of 11 November, closed with
 *               its PDF (a file of the sheet and its MANIFEST document, version 1).
 *   print       A1's label printer prints straight from the station (DIRECT); the lot label sent on A1 is printed again
 *               because the first was torn.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first rows (ids starting with eight zeros, still derived from the namespace) are ones a copy may repeat: a
 * contract switched off without its number (a sealed number is unique), a pickup that failed, an open day sheet (a closed
 * one's file is a file of that sheet only). The rows this seed adds to other modules' tables (secrets, the sheet's file and
 * document, the reprint) start with eight f's, so they never become those tables' first rows. Every name, code and value is
 * invented; every time is before the day the wave was built (the guards refuse a close or a live switch in the future).
 * Idempotent: written once, skipped when its first row exists.
 */

const T = {
  setup: new Date('2026-11-09T08:00:00.000Z'),
  live: new Date('2026-11-09T09:30:00.000Z'),
  failedAsk: new Date('2026-11-10T09:00:00.000Z'),
  failed: new Date('2026-11-10T11:00:00.000Z'),
  recurringAsk: new Date('2026-11-11T08:00:00.000Z'),
  recurringYes: new Date('2026-11-11T08:20:00.000Z'),
  phone: new Date('2026-11-11T10:00:00.000Z'),
  sheetOpened: new Date('2026-11-11T07:00:00.000Z'),
  sheetClosed: new Date('2026-11-11T17:30:00.000Z'),
  values: new Date('2026-11-12T09:10:00.000Z'),
  reprint: new Date('2026-11-12T10:00:00.000Z'),
} as const
const DAY = {
  closed: new Date('2026-11-11T00:00:00.000Z'),
  /** SH-0001's day (the shipping seed's story: handed over on 24 November). */
  sh0001: new Date('2026-11-24T00:00:00.000Z'),
} as const

export interface CarriersSeed {
  readonly contractIds: { readonly oldA1: string; readonly companyA: string; readonly companyB: string }
  readonly secretIds: { readonly companyA: string; readonly companyB: string; readonly partyP3: string }
  readonly pickupIds: { readonly failed: string; readonly recurring: string; readonly phone: string }
  readonly manifestIds: { readonly open: string; readonly closed: string }
  readonly manifestFileId: string
  readonly manifestDocumentId: string
  readonly reprintJobId: string
  /** The lot label job it prints again (the print seed's). */
  readonly originalJobId: string
  readonly labelPrinterA1: string
  readonly partyP3: string
  /** SH-0001 (SHIPPED, on the open sheet), SH-0002 (DRAFT) and its parcel (the shipping seed's). */
  readonly shippedShipmentId: string
  readonly draftShipmentId: string
  readonly draftParcelId: string
}

export async function seed(context: SeedContext): Promise<CarriersSeed> {
  const { db, namespace } = context
  await seedFiles(context)
  await seedParties(context)
  await seedPrint(context)
  const shipping = await seedShipping(context)
  const id = (key: string): string => seedUuid(namespace, key)
  /** Ids that sort first, and ids that sort last (see above). */
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const bytes = (text: string, length: number): Uint8Array<ArrayBuffer> => new Uint8Array(createHash('sha256').update(`seed carriers ${namespace} ${text}`).digest().subarray(0, length))
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const siteA = id('site:A1')
  const siteB = id('site:B1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: actorId })
  const select = { id: true } as const

  const result: CarriersSeed = {
    contractIds: { oldA1: firstId('carriers:contract:A1:seed-express:old'), companyA: id('carriers:contract:A:seed-express'), companyB: id('carriers:contract:B:seed-freight') },
    secretIds: { companyA: lateId('carriers:secret:A:seed-express'), companyB: lateId('carriers:secret:B:seed-freight'), partyP3: lateId('carriers:secret:P3') },
    pickupIds: { failed: firstId('carriers:pickup:A1:failed'), recurring: id('carriers:pickup:A1:recurring'), phone: id('carriers:pickup:B1:phone') },
    manifestIds: { open: firstId('carriers:manifest:A1:seed-express:SH-0001'), closed: id('carriers:manifest:A1:seed-express:2026-11-11') },
    manifestFileId: lateId('carriers:manifest:A1:2026-11-11:file'),
    manifestDocumentId: lateId('carriers:manifest:A1:2026-11-11:document'),
    reprintJobId: lateId('carriers:print:A1:sent:reprint'),
    originalJobId: id('print:job:A1:sent'),
    labelPrinterA1: id('print:printer:A1:LBL'),
    partyP3: id('party:P3'),
    shippedShipmentId: shipping.shipmentId,
    draftShipmentId: shipping.draftShipmentId,
    draftParcelId: shipping.draftParcelId,
  }
  const { contractIds: C, secretIds: S, pickupIds: P, manifestIds: M } = result

  if (await db.withScope(office, (client) => client.carrierAccount.findUnique({ where: { id: C.oldA1 }, select }))) return result

  const secret = (secretId: string, purpose: string, key: string) =>
    ({
      id: secretId,
      purpose,
      keyId: 'seed:not-a-key',
      algorithm: 'AES-256-GCM',
      wrappedKey: bytes(`${key} wrapped`, 32),
      iv: bytes(`${key} iv`, 12),
      ciphertext: bytes(`${key} ciphertext`, 24),
      authTag: bytes(`${key} tag`, 16),
      ...stamp(T.setup),
    }) satisfies Prisma.SecretValueCreateManyInput
  const addressOf = async (tx: Prisma.TransactionClient, siteId: string): Promise<Prisma.InputJsonValue> =>
    ((await tx.shippingSettings.findUniqueOrThrow({ where: { id: siteId }, select: { senderAddress: true } })).senderAddress ?? {}) as Prisma.InputJsonValue

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- carrier contracts and the customer's carrier account (LOG-033, LOG-038) -----------------------------------------
      await tx.secretValue.createMany({
        data: [
          secret(S.companyA, 'shipping.carrier_account', 'A seed-express'),
          secret(S.companyB, 'shipping.carrier_account', 'B seed-freight'),
          secret(S.partyP3, 'parties.carrier_account', 'P3 seed-express'),
        ],
      })
      await tx.carrierAccount.createMany({
        data: [
          // The earlier contract for A1 alone, switched off (its number removed) when the company-wide one came.
          { id: C.oldA1, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', active: false, ...stamp(T.setup) },
          { id: C.companyA, companyId: companyA, carrierCode: 'seed-express', accountNumberSecretId: S.companyA, ownRatesOnly: true, ...stamp(T.setup) },
          { id: C.companyB, companyId: companyB, carrierCode: 'seed-freight', accountNumberSecretId: S.companyB, ...stamp(T.setup) },
        ],
      })
      await tx.party.update({
        where: { id: result.partyP3 },
        data: { preferredCarrierCode: 'seed-express', carrierAccountSecretId: S.partyP3, defaultCarrierService: 'seed-express-eu', freightBilling: FreightBilling.COLLECT, version: { increment: 1 }, updatedAt: T.setup },
        select,
      })

      // --- test mode and insurance (LOG-035, LOG-042) -----------------------------------------------------------------------
      await tx.shippingSettings.update({ where: { id: siteA }, data: { insureAbove: 50000, version: { increment: 1 }, updatedAt: T.setup }, select })
      await tx.shippingSettings.update({ where: { id: siteB }, data: { testMode: false, liveSince: T.live, liveSetById: actorId, version: { increment: 1 }, updatedAt: T.live }, select })
      await tx.parcel.update({ where: { id: shipping.draftParcelId }, data: { declaredValue: 52000, insuredValue: 52000, version: { increment: 1 }, updatedAt: T.values }, select })

      // --- pickups (LOG-048): asked, then the carrier's answer ---------------------------------------------------------------
      const addressA = await addressOf(tx, siteA)
      const addressB = await addressOf(tx, siteB)
      await tx.pickupRequest.createMany({
        data: [
          { id: P.failed, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', readyAt: new Date('2026-11-10T14:00:00.000Z'), parcels: 2, pallets: 0, address: addressA, ...stamp(T.failedAsk) },
          {
            id: P.recurring, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', readyAt: new Date('2026-11-16T14:30:00.000Z'), parcels: 3, pallets: 0, address: addressA,
            repeatWeekdays: [IsoWeekday.MONDAY, IsoWeekday.TUESDAY, IsoWeekday.WEDNESDAY, IsoWeekday.THURSDAY, IsoWeekday.FRIDAY], ...stamp(T.recurringAsk),
          },
          { id: P.phone, companyId: companyB, siteId: siteB, carrierCode: 'seed-freight', readyAt: new Date('2026-11-13T09:00:00.000Z'), parcels: 0, pallets: 1, address: addressB, ...stamp(T.phone) },
        ],
      })
      await tx.pickupRequest.update({
        where: { id: P.failed },
        data: { status: PickupStatus.FAILED, providerReference: 'SEED-PU-0001', errorWords: 'Seed: the carrier had no driver free that afternoon.', version: 2, updatedAt: T.failed },
        select,
      })
      await tx.pickupRequest.update({ where: { id: P.recurring }, data: { status: PickupStatus.CONFIRMED, providerReference: 'SEED-PU-0002', version: 2, updatedAt: T.recurringYes }, select })
      await tx.pickupRequest.update({ where: { id: P.phone }, data: { status: PickupStatus.CONFIRMED, note: 'Seed: booked by phone with the depot.', version: 2, updatedAt: T.phone }, select })

      // --- day sheets (LOG-049) ---------------------------------------------------------------------------------------------
      await tx.dispatchManifest.createMany({
        data: [
          { id: M.open, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', day: DAY.sh0001, ...stamp(T.sheetOpened) },
          { id: M.closed, companyId: companyA, siteId: siteA, carrierCode: 'seed-express', day: DAY.closed, ...stamp(T.sheetOpened) },
        ],
      })
      await tx.shipment.update({ where: { id: shipping.shipmentId }, data: { manifestId: M.open, version: { increment: 1 } }, select })
      const sheetSha = createHash('sha256').update(`seed carriers day sheet A1 seed-express 2026-11-11 version 1 (${namespace})`).digest('hex')
      await tx.storedFile.create({
        data: {
          id: result.manifestFileId,
          companyId: companyA,
          recordType: 'DispatchManifest',
          recordId: M.closed,
          kind: 'DOCUMENT',
          originalName: 'Seed day sheet A1 seed-express 2026-11-11.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          sha256: sheetSha,
          storeAccountId: id('files:account:r2'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('carriers:manifest:A1:2026-11-11:key')}`,
          status: 'AVAILABLE',
          availableAt: T.sheetClosed,
          visibility: ['OFFICE'],
          ...stamp(T.sheetClosed),
        },
        select,
      })
      await tx.generatedDocument.create({
        data: {
          id: result.manifestDocumentId,
          companyId: companyA,
          siteId: siteA,
          recordType: 'DispatchManifest',
          recordId: M.closed,
          kind: GeneratedDocumentKind.MANIFEST,
          version: 1,
          fingerprint: sheetSha,
          language: 'it',
          fileId: result.manifestFileId,
          createdAt: T.sheetClosed,
          createdById: actorId,
        },
        select,
      })
      await tx.dispatchManifest.update({ where: { id: M.closed }, data: { closedAt: T.sheetClosed, closedById: actorId, fileId: result.manifestFileId, version: 2, updatedAt: T.sheetClosed }, select })

      // --- printing (LOG-026, LOG-027) --------------------------------------------------------------------------------------
      await tx.printer.update({ where: { id: result.labelPrinterA1 }, data: { mode: PrinterMode.DIRECT, version: { increment: 1 }, updatedAt: T.setup }, select })
      const original = await tx.printJob.findUniqueOrThrow({
        where: { id: result.originalJobId },
        select: { companyId: true, siteId: true, printerId: true, recordType: true, recordId: true, payloadKind: true, labelKind: true, scanId: true, zpl: true },
      })
      await tx.printJob.create({
        data: { id: result.reprintJobId, ...original, reprintOfId: result.originalJobId, reprintReason: 'Seed: the lot label was torn at the dock.', requestedById: actorId, ...stamp(T.reprint) },
        select,
      })
    }),
  )

  return result
}
