import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCarriers, type CarriersSeed } from '../seed/carriers'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Carriers, labels and dispatch (W2b-6, schema wave 48/57, B-W2b-367, …_carriers_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - our own carrier contracts (the number sealed for its purpose, one live per company, site and carrier, never deleted, the
 *     office's only) and the customer's carrier account (COLLECT and THIRD_PARTY only on it, never read by a portal);
 *   - a site's test mode (live with when and who, fixed while live) and insurance, a parcel's declared and insured values (not
 *     for the floor);
 *   - a shipment's manual carrier, the customer's collection and the day's sheet (put on and taken off while it is open, then
 *     frozen with it), pickups (what was asked fixed, FAILED and CANCELLED final);
 *   - a printer that prints straight from the station, a reprint with why, and the proforma, day sheet, carton marks and
 *     shipment pack documents (a proforma with its record's PROFORMA number).
 * The refusals are check_violation (23514) in words, or a unique key (23505); their messages are read through raw SQL.
 */

const NS = 'w2b-367-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: CarriersSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const COMPANY_A = key('company:A')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (party = key('party:P3')): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: party })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const one = async (table: string, id: string) => (await admin(`SELECT * FROM "${table}" WHERE id = $1::uuid`, [id]))[0]!
/** A new sealed secret of `purpose` (a copy of a seeded one: made-up bytes). */
async function secretOf(purpose: string): Promise<string> {
  const secretId = randomUUID()
  expect(await copyRow(office(), 'SecretValue', s.secretIds.companyA, { id: secretId, purpose })).toBe(1)
  return secretId
}
/** A DRAFT shipment of its own (a copy of SH-0002 without its lines and parcels). */
async function draftShipment(changes: Record<string, unknown> = {}): Promise<string> {
  const shipmentId = randomUUID()
  expect(await copyRow(office(), 'Shipment', s.draftShipmentId, { id: shipmentId, number: `SH-T-${shipmentId.slice(0, 8)}`, version: 1, ...changes })).toBe(1)
  return shipmentId
}
/** A file of `recordType` `recordId` (a copy of the day sheet's file). */
async function fileOf(recordType: string, recordId: string): Promise<string> {
  const fileId = randomUUID()
  expect(await copyRow(office(), 'StoredFile', s.manifestFileId, { id: fileId, recordType, recordId, storageKey: `test/${fileId}` })).toBe(1)
  return fileId
}

beforeAll(async () => {
  db = await migratedDatabase('carriersw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedCarriers({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedCarriers({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('our own carrier contracts (LOG-033)', () => {
  const newContract = (changes: Record<string, unknown>) => copyRow(office(), 'CarrierAccount', s.contractIds.oldA1, { id: randomUUID(), ...changes })

  it('keep a sealed number of their purpose while live, one live per company, site and carrier', async () => {
    await expect(newContract({ carrierCode: 'two words' })).rejects.toThrow(/code of 1 to 40 characters without spaces/)
    await expect(newContract({ carrierCode: 'seed-express-2', active: true, accountNumberSecretId: null })).rejects.toThrow(/live only with its account number/)
    await expect(newContract({ carrierCode: 'seed-express-2', active: true, accountNumberSecretId: await secretOf('integration.credentials') })).rejects.toThrow(/sealed for shipping.carrier_account/)
    // A secret is never shared (the schema's unique key), and one contract is live per company, site and carrier.
    await expect(newContract({ carrierCode: 'seed-express-2', active: true, accountNumberSecretId: s.secretIds.companyA })).rejects.toThrow(/CarrierAccount_tenantId_accountNumberSecretId_key/)
    await expect(newContract({ siteId: null, active: true, accountNumberSecretId: await secretOf('shipping.carrier_account') })).rejects.toThrow(/CarrierAccount_one_live/)
    // A1's own contract beside the company's (another scope), then switched off.
    const own = randomUUID()
    expect(await copyRow(office(), 'CarrierAccount', s.contractIds.oldA1, { id: own, active: true, accountNumberSecretId: await secretOf('shipping.carrier_account') })).toBe(1)
    await expect(update(office(), 'CarrierAccount', own, `"accountNumberSecretId" = NULL`)).rejects.toThrow(/live only with its account number/)
    expect(await update(office(), 'CarrierAccount', own, `active = false, "accountNumberSecretId" = NULL, version = version + 1`)).toBe(1)
    await expect(update(office(), 'CarrierAccount', own, `"carrierCode" = 'other'`)).rejects.toThrow(/company, site, carrier and creation of carrier contract .* never change/)
    await expect(update(office(), 'CarrierAccount', own, `"siteId" = NULL`)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "CarrierAccount" WHERE id = $1::uuid`, [own])).rejects.toThrow(/kept, never deleted/)
  })

  it("are the office's only", async () => {
    expect((await sql(office(), `SELECT "ownRatesOnly" FROM "CarrierAccount" WHERE id = $1::uuid`, s.contractIds.companyA))[0]).toEqual({ ownRatesOnly: true })
    await expect(sql(floor(), `SELECT id FROM "CarrierAccount" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT id FROM "CarrierAccount" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe("the customer's carrier account (LOG-038)", () => {
  it('bills COLLECT or THIRD_PARTY only on a sealed account of its preferred carrier', async () => {
    const P1 = key('party:P1')
    await expect(update(office(), 'Party', P1, `"freightBilling" = 'COLLECT'`)).rejects.toThrow(/billed COLLECT only on a carrier account it keeps/)
    await expect(update(office(), 'Party', P1, `"preferredCarrierCode" = NULL, "defaultCarrierService" = 'seed-standard'`)).rejects.toThrow(/default carrier service .* with its preferred carrier/)
    await expect(update(office(), 'Party', s.partyP3, `"preferredCarrierCode" = NULL`)).rejects.toThrow(/carrier account only with its preferred carrier/)
    await expect(update(office(), 'Party', P1, `"preferredCarrierCode" = 'seed-express', "carrierAccountSecretId" = $2::uuid`, await secretOf('shipping.carrier_account'))).rejects.toThrow(/sealed for parties.carrier_account/)
    await expect(update(office(), 'Party', P1, `"preferredCarrierCode" = 'seed-express', "carrierAccountSecretId" = $2::uuid`, s.secretIds.partyP3)).rejects.toThrow(/Party_tenantId_carrierAccountSecretId_key/)
    expect(await update(office(), 'Party', P1, `"preferredCarrierCode" = 'seed-express', "carrierAccountSecretId" = $2::uuid, "freightBilling" = 'THIRD_PARTY', version = version + 1`, await secretOf('parties.carrier_account'))).toBe(1)
    expect(await one('Party', s.partyP3)).toMatchObject({ freightBilling: 'COLLECT', defaultCarrierService: 'seed-express-eu' })
  })

  it('is never read by a portal session, which reads how it is billed', async () => {
    await expect(sql(partner(), `SELECT "carrierAccountSecretId" FROM "Party" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect(await sql(partner(), `SELECT "freightBilling", "defaultCarrierService" FROM "Party"`)).toEqual([{ freightBilling: 'COLLECT', defaultCarrierService: 'seed-express-eu' }])
  })
})

describe('test mode and insurance (LOG-035, LOG-042)', () => {
  it('go live with when and who, fixed while live, cleared back in test mode', async () => {
    const siteB1 = key('site:B1')
    expect(await one('ShippingSettings', SITE_A1)).toMatchObject({ testMode: true, liveSince: null, insureAbove: 50000 })
    expect(await one('ShippingSettings', siteB1)).toMatchObject({ testMode: false, liveSetById: a.actorId })
    await expect(update(office(), 'ShippingSettings', SITE_A1, `"testMode" = false`)).rejects.toThrow(/live \(test mode off\) exactly with when they went live/)
    await expect(update(office(), 'ShippingSettings', SITE_A1, `"testMode" = false, "liveSince" = now() + interval '1 day', "liveSetById" = $2::uuid`, a.actorId)).rejects.toThrow(/not in the future/)
    await expect(update(office(), 'ShippingSettings', siteB1, `"liveSince" = now()`)).rejects.toThrow(/stay as they are while live/)
    await expect(update(office(), 'ShippingSettings', siteB1, `"testMode" = true`)).rejects.toThrow(/in test mode, neither/)
    expect(await update(office(), 'ShippingSettings', siteB1, `"testMode" = true, "liveSince" = NULL, "liveSetById" = NULL, version = version + 1`)).toBe(1)
    expect(await update(office(), 'ShippingSettings', siteB1, `"testMode" = false, "liveSince" = now(), "liveSetById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'ShippingSettings', SITE_A1, `"insureAbove" = -1`)).rejects.toThrow(/insure parcels declared above 0 or more/)
  })

  it('show the floor the test mode, never a value', async () => {
    expect(await sql(floor(), `SELECT "testMode" FROM "ShippingSettings"`)).toEqual([{ testMode: true }])
    await expect(sql(floor(), `SELECT "insureAbove" FROM "ShippingSettings" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT "declaredValue" FROM "Parcel" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT "insuredValue" FROM "Parcel" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('declare a value of 0 or more and insure at most it, until the parcel leaves', async () => {
    const parcel = s.draftParcelId
    expect(await one('Parcel', parcel)).toMatchObject({ declaredValue: 52000, insuredValue: 52000 })
    await expect(update(office(), 'Parcel', parcel, `"declaredValue" = -1`)).rejects.toThrow(/declares a value of 0 or more/)
    await expect(update(office(), 'Parcel', parcel, `"insuredValue" = 0`)).rejects.toThrow(/insured for above 0/)
    await expect(update(office(), 'Parcel', parcel, `"insuredValue" = 52001`)).rejects.toThrow(/at most its declared value/)
    expect(await update(office(), 'Parcel', parcel, `"declaredValue" = 30000, "insuredValue" = NULL, version = version + 1`)).toBe(1)
    // SH-0001 left: its parcels change no more (W1's guard).
    const [left] = await admin(`SELECT id FROM "Parcel" WHERE "shipmentId" = $1::uuid LIMIT 1`, [s.shippedShipmentId])
    await expect(update(office(), 'Parcel', left!.id as string, `"declaredValue" = 1000`)).rejects.toThrow(/change until it leaves/)
  })
})

describe('the manual carrier, the customer collecting and the day sheet (LOG-041, LOG-049, LOG-053, LOG-122)', () => {
  it('types a tracking number only for a carrier booked by hand', async () => {
    const shipment = await draftShipment()
    await expect(update(office(), 'Shipment', shipment, `"transportBy" = 'SENDER', "manualTrackingNumber" = 'SEED123'`)).rejects.toThrow(/typed by hand .* only when a carrier booked outside Sendcloud/)
    await expect(update(office(), 'Shipment', shipment, `"carrierShipmentId" = 'sc-1', "manualTrackingNumber" = 'SEED123'`)).rejects.toThrow(/no Sendcloud shipment/)
    await expect(update(office(), 'Shipment', shipment, `"manualTrackingNumber" = 'two\nlines'`)).rejects.toThrow(/1 to 100 characters on one line/)
    expect(await update(office(), 'Shipment', shipment, `"manualTrackingNumber" = 'SEED123', express = true, "dutyPayer" = 'RECEIVER', paperless = true, version = version + 1`)).toBe(1)
    expect(await one('Shipment', shipment)).toMatchObject({ manualTrackingNumber: 'SEED123', express: true, dutyPayer: 'RECEIVER', paperless: true })
  })

  it('records who collected, the plate and the signature only when the customer collects', async () => {
    const shipment = await draftShipment()
    await expect(update(office(), 'Shipment', shipment, `"collectedByName" = 'Seed Driver'`)).rejects.toThrow(/only when the customer collects \(RECIPIENT\)/)
    await expect(update(office(), 'Shipment', shipment, `"transportBy" = 'RECIPIENT', "vehiclePlate" = 'ab 123 cd'`)).rejects.toThrow(/1 to 20 capitals/)
    await expect(update(office(), 'Shipment', shipment, `"transportBy" = 'RECIPIENT', "collectionSignatureFileId" = $2::uuid`, await fileOf('Shipment', s.draftShipmentId))).rejects.toThrow(/a file of the shipment and its company/)
    expect(await update(office(), 'Shipment', shipment, `"transportBy" = 'RECIPIENT', "collectedByName" = 'Seed Driver', "vehiclePlate" = 'AB 123 CD', "collectionSignatureFileId" = $2::uuid, version = version + 1`, await fileOf('Shipment', shipment))).toBe(1)
    await expect(update(office(), 'Shipment', shipment, `"transportBy" = 'CARRIER'`)).rejects.toThrow(/only when the customer collects/)
  })

  it("puts a shipment that left on its carrier's open sheet, then freezes both when the sheet is closed", async () => {
    const shipped = s.shippedShipmentId
    expect(await one('Shipment', shipped)).toMatchObject({ status: 'SHIPPED', manifestId: s.manifestIds.open })
    await expect(update(office(), 'Shipment', await draftShipment(), `"manifestId" = $2::uuid`, s.manifestIds.open)).rejects.toThrow(/on a day's sheet only while a carrier carries it and it is PACKED or left/)
    await expect(update(office(), 'Shipment', shipped, `"manifestId" = $2::uuid`, s.manifestIds.closed)).rejects.toThrow(/is closed; shipment .* goes on the next one/)
    // Another carrier's sheet of the same site and day … refused; off and back on the open one.
    const other = randomUUID()
    expect(await copyRow(office(), 'DispatchManifest', s.manifestIds.open, { id: other, carrierCode: 'seed-freight' })).toBe(1)
    await expect(update(office(), 'Shipment', shipped, `"manifestId" = $2::uuid`, other)).rejects.toThrow(/goes with carrier seed-express, not on the day's sheet of seed-freight/)
    expect(await update(office(), 'Shipment', shipped, `"manifestId" = NULL, version = version + 1`)).toBe(1)
    expect(await update(office(), 'Shipment', shipped, `"manifestId" = $2::uuid, version = version + 1`, s.manifestIds.open)).toBe(1)
    // What else changes once it left stays W1's (its service, the express flag).
    await expect(update(office(), 'Shipment', shipped, `express = true`)).rejects.toThrow(/left; only its delivery or return/)
    // Closing: with when, the sheet as closed (a file of its own) and who.
    await expect(update(office(), 'DispatchManifest', s.manifestIds.open, `"closedAt" = now()`)).rejects.toThrow(/closed with when .* and the sheet as closed, both or neither/)
    await expect(update(office(), 'DispatchManifest', s.manifestIds.open, `"closedAt" = now(), "fileId" = $2::uuid`, s.manifestFileId)).rejects.toThrow(/a file of its own \(DispatchManifest\)/)
    await expect(update(office(), 'DispatchManifest', s.manifestIds.open, `"closedAt" = now() + interval '1 day', "fileId" = $2::uuid`, await fileOf('DispatchManifest', s.manifestIds.open))).rejects.toThrow(/not in the future/)
    await expect(update(office(), 'DispatchManifest', s.manifestIds.open, `day = day + 1`)).rejects.toThrow(/company, site, carrier, day and creation of the day's sheet .* never change/)
    expect(await update(office(), 'DispatchManifest', s.manifestIds.open, `"closedAt" = now(), "closedById" = $2::uuid, "fileId" = $3::uuid, version = version + 1`, a.actorId, await fileOf('DispatchManifest', s.manifestIds.open))).toBe(1)
    await expect(update(office(), 'DispatchManifest', s.manifestIds.open, `"closedById" = NULL`)).rejects.toThrow(/was closed; it changes no more/)
    await expect(update(office(), 'Shipment', shipped, `"manifestId" = NULL`)).rejects.toThrow(/is closed; shipment .* stays on it/)
    // Delivered on a closed sheet: it stays on it.
    expect(await update(office(), 'Shipment', shipped, `status = 'DELIVERED', "deliveredAt" = now(), version = version + 1`)).toBe(1)
    await expect(copyRow(office(), 'DispatchManifest', s.manifestIds.closed, { id: randomUUID() })).rejects.toThrow(/DispatchManifest_tenantId_siteId_carrierCode_day_key/)
    await expect(admin(`DELETE FROM "DispatchManifest" WHERE id = $1::uuid`, [other])).rejects.toThrow(/kept, never deleted/)
  })

  it("shows the floor its own site's sheets and pickups, a portal session none", async () => {
    const sheets = await sql(floor(), `SELECT DISTINCT "siteId"::text AS site FROM "DispatchManifest"`)
    expect(sheets).toEqual([{ site: SITE_A1 }])
    expect(await sql(floor(), `SELECT DISTINCT "siteId"::text AS site FROM "PickupRequest"`)).toEqual([{ site: SITE_A1 }])
    await expect(sql(partner(), `SELECT id FROM "DispatchManifest" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT id FROM "PickupRequest" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(run(floor(), `UPDATE "PickupRequest" SET note = 'x'`)).rejects.toThrow(/permission denied/)
  })
})

describe('pickups (LOG-048)', () => {
  const ask = (changes: Record<string, unknown> = {}) => {
    const pickup = randomUUID()
    return { pickup, insert: copyRow(office(), 'PickupRequest', s.pickupIds.recurring, { id: pickup, status: 'REQUESTED', providerReference: null, errorWords: null, note: null, version: 1, ...changes }) }
  }

  it('ask parcels or pallets at an address, each weekday once', async () => {
    await expect(ask({ parcels: 0, pallets: 0 }).insert).rejects.toThrow(/at least one of either/)
    await expect(ask({ parcels: 10000 }).insert).rejects.toThrow(/0 to 9999 parcels/)
    await expect(ask({ address: { name: 'Seed', line1: 'Via Seed 1', postalCode: '00000', city: 'Seedtown', country: 'Italy' } }).insert).rejects.toThrow(/two capitals/)
    await expect(ask({ address: ['not', 'an', 'object'] }).insert).rejects.toThrow(/collects from an address/)
    await expect(ask({ repeatWeekdays: ['MONDAY', 'MONDAY'] }).insert).rejects.toThrow(/each weekday once/)
    await expect(ask({ carrierCode: '' }).insert).rejects.toThrow(/code of 1 to 40 characters/)
    await expect(ask({ status: 'FAILED' }).insert).rejects.toThrow(/why it failed .* exactly when it is FAILED/)
  })

  it('move REQUESTED → CONFIRMED → FAILED with why, then change no more', async () => {
    const { pickup, insert } = ask()
    expect(await insert).toBe(1)
    await expect(update(office(), 'PickupRequest', pickup, `"readyAt" = "readyAt" + interval '1 hour'`)).rejects.toThrow(/what pickup request .* asked never changes/)
    await expect(update(office(), 'PickupRequest', pickup, `"errorWords" = 'Too early'`)).rejects.toThrow(/exactly when it is FAILED/)
    expect(await update(office(), 'PickupRequest', pickup, `status = 'CONFIRMED', "providerReference" = 'SEED-T-1', version = version + 1`)).toBe(1)
    await expect(update(office(), 'PickupRequest', pickup, `"providerReference" = 'SEED-T-2'`)).rejects.toThrow(/set once, never changed/)
    await expect(update(office(), 'PickupRequest', pickup, `status = 'REQUESTED'`)).rejects.toThrow(/cannot move from CONFIRMED to REQUESTED/)
    expect(await update(office(), 'PickupRequest', pickup, `status = 'FAILED', "errorWords" = 'The driver did not come.', version = version + 1`)).toBe(1)
    await expect(update(office(), 'PickupRequest', pickup, `status = 'CANCELLED', "errorWords" = NULL`)).rejects.toThrow(/is FAILED; it changes no more/)
    await expect(update(office(), 'PickupRequest', s.pickupIds.failed, `note = 'Called the depot'`)).rejects.toThrow(/changes no more/)
    await expect(admin(`DELETE FROM "PickupRequest" WHERE id = $1::uuid`, [pickup])).rejects.toThrow(/kept, never deleted/)
  })
})

describe('printing straight from the station and reprints (LOG-026, LOG-027)', () => {
  it('prints DIRECT only on a label printer', async () => {
    expect(await one('Printer', s.labelPrinterA1)).toMatchObject({ mode: 'DIRECT' })
    const a4 = key('print:printer:A1:A4')
    await expect(update(office(), 'Printer', a4, `mode = 'DIRECT'`)).rejects.toThrow(/DIRECT\) only as a label printer/)
    expect(await update(office(), 'Printer', a4, `mode = 'PDF', version = version + 1`)).toBe(1)
    expect((await sql(floor(), `SELECT mode FROM "Printer" WHERE id = $1::uuid`, s.labelPrinterA1))[0]).toEqual({ mode: 'DIRECT' })
  })

  it('prints an earlier job of the same record again with why, both fixed once queued', async () => {
    expect(await one('PrintJob', s.reprintJobId)).toMatchObject({ reprintOfId: s.originalJobId, recordType: 'Lot' })
    const reprint = (changes: Record<string, unknown>) => copyRow(office(), 'PrintJob', s.reprintJobId, { id: randomUUID(), status: 'QUEUED', ...changes })
    await expect(reprint({ reprintReason: 'no' })).rejects.toThrow(/with why \(3 to 200 characters on one line\), both or neither/)
    await expect(reprint({ reprintOfId: null })).rejects.toThrow(/both or neither/)
    await expect(reprint({ recordId: randomUUID() })).rejects.toThrow(/of the same record \(Lot/)
    // The floor of the site reprints its own label too.
    expect(await copyRow(floor(), 'PrintJob', s.reprintJobId, { id: randomUUID(), status: 'QUEUED', reprintReason: 'Torn again at the dock.' })).toBe(1)
    await expect(update(office(), 'PrintJob', s.reprintJobId, `"reprintReason" = 'Another reason'`)).rejects.toThrow(/prints again and why never change/)
  })
})

describe('the proforma, the day sheet, carton marks and the shipment pack (LOG-058, LOG-049, LOG-013, LOG-031)', () => {
  it("are documents of their records; a proforma carries its record's PROFORMA number", async () => {
    const shipment = s.shippedShipmentId
    const file = await fileOf('Shipment', shipment)
    const document = (changes: Record<string, unknown>) => copyRow(office(), 'GeneratedDocument', s.manifestDocumentId, { id: randomUUID(), recordType: 'Shipment', recordId: shipment, fileId: file, version: 1, number: null, ...changes })
    await expect(document({ kind: 'MANIFEST' })).rejects.toThrow(/a day sheet a DispatchManifest's/)
    await expect(document({ kind: 'PROFORMA' })).rejects.toThrow(/carries the number its Shipment .* took from the company's PROFORMA series, not none/)
    await expect(document({ kind: 'PROFORMA', number: 'PF-2026-0001' })).rejects.toThrow(/PROFORMA series, not PF-2026-0001/)
    const [series] = await admin(`SELECT id FROM "NumberSeries" WHERE "tenantId" = $1::uuid AND "companyId" = $2::uuid AND kind = 'PROFORMA'`, [a.tenantId, COMPANY_A])
    expect(series).toBeDefined()
    expect(
      await run(
        office(),
        `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROFORMA', 1, 'PF-2026-0001', current_date, 'Shipment', $4::uuid, now(), $5::uuid, 'test-proforma')`,
        randomUUID(), COMPANY_A, series!.id, shipment, a.actorId,
      ),
    ).toBe(1)
    expect(await document({ kind: 'PROFORMA', number: 'PF-2026-0001' })).toBe(1)
    expect(await document({ kind: 'PROFORMA', number: 'PF-2026-0001', version: 2 })).toBe(1)
    expect(await document({ kind: 'SHIPPING_MARKS' })).toBe(1)
    expect(await document({ kind: 'SHIPMENT_PACK' })).toBe(1)
    // A day sheet's document is of its sheet's company and site.
    await expect(copyRow(office(), 'GeneratedDocument', s.manifestDocumentId, { id: randomUUID(), version: 2, siteId: null })).rejects.toThrow(/company and site of its DispatchManifest/)
    expect(await copyRow(office(), 'GeneratedDocument', s.manifestDocumentId, { id: randomUUID(), version: 2 })).toBe(1)
  })
})
