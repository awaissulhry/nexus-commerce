import { randomUUID } from 'node:crypto'
import { isValidCodiceFiscale, isValidPartitaIva } from '@nexus/factory-domain/tax/tax-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedParties, type PartiesSeed } from '../seed/parties'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The parties' walls beyond the generated isolation tests (plan A1 §2.2; features SAL-001, SAL-006, SAL-285), on a
 * database built from the migrations and seeded twice (tenants A and B), through the real login and the scoped client:
 *   - a portal or link session (factory_partner_runtime) reads its own party and that party's rows only, never an
 *     internal note or who wrote a row, never a VIES check, and writes nothing;
 *   - the floor reads none of it;
 *   - a VIES check is never changed or removed, by any login (the …_parties_guards triggers), the owner included;
 *   - a measurement profile is never edited in place, and a revision supersedes one of its own party only;
 *   - every reference stays inside the tenant, and inside the party where it names one;
 *   - the seed is idempotent, and its made-up tax numbers pass the offline checks.
 */

const DENIED = /permission denied/
const PARTY_TABLES = ['Party', 'PartyAddress', 'PartyContact', 'PartyTaxIdentity', 'ViesCheck', 'MeasurementProfile'] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let partiesA: PartiesSeed
let partiesB: PartiesSeed

const office = (seeded: CoreSeed): FactoryScope => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const ids = (rows: Record<string, unknown>[]) => rows.map((row) => String(row.id)).sort()

beforeAll(async () => {
  db = await migratedDatabase('parties')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'parties-a' })
  b = await seedCore({ db: factory, namespace: 'parties-b' })
  partiesA = await seedParties({ db: factory, namespace: 'parties-a' })
  partiesB = await seedParties({ db: factory, namespace: 'parties-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('a portal or link session', () => {
  it('reads its own party only, without the internal note or who made it', async () => {
    const seen = await as(partner(partiesA.customerId), (client) =>
      client.party.findMany({ select: { id: true, code: true, legalName: true, roles: true, status: true } }),
    )
    expect(seen).toEqual([{ id: partiesA.customerId, code: 'SEED-C1', legalName: 'Seed Customer One S.r.l.', roles: ['CUSTOMER', 'BRAND'], status: 'ACTIVE' }])
    // Tenant B's P1 and tenant A's other parties exist, and stay out of sight.
    expect((await admin('SELECT count(*)::int AS n FROM "Party" WHERE id <> $1', [partiesA.customerId]))[0]!.n).toBeGreaterThanOrEqual(7)
    await expect(sql(partner(partiesA.customerId), 'SELECT "internalNote" FROM "Party"')).rejects.toThrow(DENIED)
    await expect(sql(partner(partiesA.customerId), 'SELECT "createdById" FROM "Party"')).rejects.toThrow(DENIED)
    // Prisma's default select names every column, so a forgotten select fails loudly.
    await expect(as(partner(partiesA.customerId), (client) => client.party.findMany())).rejects.toThrow(DENIED)
    await expect(as(partner(partiesA.customerId), (client) => client.measurementProfile.findMany())).rejects.toThrow(DENIED)
  })

  it("reads its own party's addresses, contacts, tax identities and measurement profiles, and no other party's", async () => {
    for (const table of ['PartyAddress', 'PartyContact', 'PartyTaxIdentity', 'MeasurementProfile']) {
      for (const partyId of [partiesA.customerId, partiesA.supplierId]) {
        const seen = await sql(partner(partyId), `SELECT id::text AS id FROM "${table}"`)
        const own = await admin(`SELECT id::text AS id FROM "${table}" WHERE "tenantId" = $1 AND "partyId" = $2`, [a.tenantId, partyId])
        expect(ids(seen), `${table} for ${partyId}`).toEqual(ids(own))
      }
      const all = await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE "partyId" <> $1`, [partiesA.customerId])
      expect(all[0]!.n, `${table} rows of other parties`).toBeGreaterThan(0)
    }
    const profiles = await sql(partner(partiesA.customerId), 'SELECT "riderName", "fitNotes", measurements FROM "MeasurementProfile"')
    expect(profiles).toEqual([{ riderName: 'Seed Team Rider', fitNotes: 'Racing position, slightly longer sleeves.', measurements: expect.objectContaining({ chest: { value: '100.0', unit: 'cm' } }) }])
    await expect(sql(partner(partiesA.customerId), 'SELECT "internalNote" FROM "MeasurementProfile"')).rejects.toThrow(DENIED)
  })

  it('reads no VIES check and writes nothing', async () => {
    const scope = partner(partiesA.customerId)
    await expect(sql(scope, 'SELECT id FROM "ViesCheck"')).rejects.toThrow(DENIED)
    for (const table of PARTY_TABLES) {
      await expect(run(scope, `INSERT INTO "${table}" (id) VALUES (NULL)`), table).rejects.toThrow(DENIED)
      await expect(run(scope, `UPDATE "${table}" SET id = id WHERE false`), table).rejects.toThrow(DENIED)
      await expect(run(scope, `DELETE FROM "${table}" WHERE false`), table).rejects.toThrow(DENIED)
    }
  })
})

describe('the floor', () => {
  it.each(PARTY_TABLES)('reads and writes nothing in %s', async (table) => {
    await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(run(floor(), `INSERT INTO "${table}" (id) VALUES (NULL)`)).rejects.toThrow(DENIED)
  })
})

describe('a VIES check', () => {
  const checkId = () => admin('SELECT id::text AS id FROM "ViesCheck" WHERE "tenantId" = $1 AND result = $2', [a.tenantId, 'VALID']).then((rows) => String(rows[0]!.id))

  it('is never changed or removed by the office: no grant (and the scoped client sends no TRUNCATE at all)', async () => {
    const id = await checkId()
    await expect(run(office(a), 'UPDATE "ViesCheck" SET result = \'INVALID\' WHERE id = $1::uuid', id)).rejects.toThrow(DENIED)
    await expect(run(office(a), 'DELETE FROM "ViesCheck" WHERE id = $1::uuid', id)).rejects.toThrow(DENIED)
    await expect(run(office(a), 'TRUNCATE "ViesCheck"')).rejects.toThrow(/refused by the tenant scope/)
  })

  it('is never changed or removed by any login, the owner included: the triggers', async () => {
    const id = await checkId()
    await expect(admin('UPDATE "ViesCheck" SET "consultationNumber" = NULL WHERE id = $1', [id])).rejects.toThrow(/append-only: UPDATE on "ViesCheck" is refused/)
    await expect(admin('DELETE FROM "ViesCheck" WHERE id = $1', [id])).rejects.toThrow(/append-only: DELETE on "ViesCheck" is refused/)
    await expect(admin('TRUNCATE "ViesCheck"')).rejects.toThrow(/append-only: TRUNCATE on "ViesCheck" is refused/)
    expect((await admin('SELECT "consultationNumber" FROM "ViesCheck" WHERE id = $1', [id]))[0]).toEqual({ consultationNumber: 'SEEDVIES0000001' })
  })

  it("names one of its own party's tax identities", async () => {
    const [identity] = await admin('SELECT id::text AS id FROM "PartyTaxIdentity" WHERE "tenantId" = $1 AND "partyId" = $2', [a.tenantId, partiesA.supplierId])
    const insert = (partyId: string) =>
      as(office(a), (client) =>
        client.viesCheck.create({
          data: { id: randomUUID(), partyId, taxIdentityId: String(identity!.id), countryCode: 'IT', vatNumber: '00000002022', requestedAt: new Date(), result: 'VALID', requestId: 'parties-test' },
          select: { id: true },
        }),
      )
    await expect(insert(partiesA.customerId)).rejects.toThrow(/ViesCheck_tenantId_partyId_taxIdentityId_fkey/)
  })
})

describe('a measurement profile', () => {
  it('is never edited in place or removed by the office', async () => {
    const [row] = await admin('SELECT id::text AS id FROM "MeasurementProfile" WHERE "tenantId" = $1 LIMIT 1', [a.tenantId])
    await expect(run(office(a), 'UPDATE "MeasurementProfile" SET "fitNotes" = NULL WHERE id = $1::uuid', row!.id)).rejects.toThrow(DENIED)
    await expect(run(office(a), 'DELETE FROM "MeasurementProfile" WHERE id = $1::uuid', row!.id)).rejects.toThrow(DENIED)
  })

  it('supersedes a revision of its own party only', async () => {
    const [p4] = await admin('SELECT id::text AS id, "partyId"::text AS "partyId" FROM "MeasurementProfile" WHERE "tenantId" = $1 AND revision = 2', [a.tenantId])
    const insert = (supersedesId: string) =>
      as(office(a), (client) =>
        client.measurementProfile.create({
          data: {
            id: randomUUID(),
            partyId: partiesA.customerId,
            riderName: 'Seed Team Rider',
            garmentType: 'JACKET',
            revision: 2,
            supersedesId,
            measurements: {},
            takenAt: new Date(),
            takenBy: 'Seed Fitter',
            privacyNoticeRef: 'seed-privacy-notice-v1',
            privacyNoticeAt: new Date(),
          },
          select: { id: true },
        }),
      )
    expect(p4!.partyId).not.toBe(partiesA.customerId)
    await expect(insert(String(p4!.id))).rejects.toThrow(/MeasurementProfile_tenantId_partyId_supersedesId_fkey/)
  })
})

describe('the references', () => {
  it("never reach another tenant's party, nor another party's contact", async () => {
    const address = (partyId: string) =>
      as(office(a), (client) =>
        client.partyAddress.create({ data: { id: randomUUID(), partyId, kinds: ['SHIP_TO'], line1: 'Via Esempio 1', postalCode: '00000', city: 'Seedville', country: 'IT' }, select: { id: true } }),
      )
    await expect(address(partiesB.customerId)).rejects.toThrow(/PartyAddress_tenantId_partyId_fkey/)
    expect(await address(partiesA.customerId)).toEqual({ id: expect.any(String) })

    const [supplierContact] = await admin('SELECT id::text AS id FROM "PartyContact" WHERE "tenantId" = $1 AND "partyId" = $2', [a.tenantId, partiesA.supplierId])
    await expect(
      as(office(a), (client) =>
        client.measurementProfile.create({
          data: {
            id: randomUUID(),
            partyId: partiesA.customerId,
            contactId: String(supplierContact!.id),
            riderName: 'Seed Someone Else',
            garmentType: 'JACKET',
            revision: 1,
            measurements: {},
            takenAt: new Date(),
            takenBy: 'Seed Fitter',
            privacyNoticeRef: 'seed-privacy-notice-v1',
            privacyNoticeAt: new Date(),
          },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow(/MeasurementProfile_tenantId_partyId_contactId_fkey/)
  })

  it("never reach another tenant's company", async () => {
    await expect(
      as(office(a), (client) =>
        client.party.create({ data: { id: randomUUID(), companyId: b.companies[0]!.id, code: 'X-1', kind: 'ORGANISATION', legalName: 'Seed X', roles: ['CUSTOMER'] }, select: { id: true } }),
      ),
    ).rejects.toThrow(/Party_tenantId_companyId_fkey/)
  })

  it('keeps one tax identity per party and start date', async () => {
    const identity = () =>
      as(office(a), (client) =>
        client.partyTaxIdentity.create({
          data: { id: randomUUID(), partyId: partiesA.customerId, country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000001016', validFrom: new Date('2026-01-01T00:00:00.000Z') },
          select: { id: true },
        }),
      )
    await expect(identity()).rejects.toThrow(/Unique constraint failed/)
  })
})

describe('the seed', () => {
  it('is idempotent: a second run changes nothing', async () => {
    const count = async () => {
      const out: number[] = []
      for (const table of PARTY_TABLES) out.push(Number((await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n))
      return out
    }
    const before = await count()
    expect(before.every((n) => n > 0)).toBe(true)
    await seedParties({ db: factory, namespace: 'parties-a' })
    expect(await count()).toEqual(before)
  })

  it('holds only made-up tax numbers that pass the offline checks', async () => {
    const rows = await admin('SELECT "vatNumber", "fiscalCode", country FROM "PartyTaxIdentity" WHERE "tenantId" = $1', [a.tenantId])
    for (const row of rows) {
      if (row.country === 'IT' && row.vatNumber) expect(isValidPartitaIva(String(row.vatNumber).slice(2)), String(row.vatNumber)).toBe(true)
      if (row.fiscalCode) expect(isValidCodiceFiscale(String(row.fiscalCode)), String(row.fiscalCode)).toBe(true)
    }
    const emails = await admin('SELECT email FROM "PartyContact" WHERE email IS NOT NULL')
    for (const { email } of emails) expect(String(email)).toMatch(/@example\.com$/)
  })
})
