import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCalendar } from '../seed/calendar'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedImports } from '../seed/imports'
import { seed as seedPricing, type PricingSeed } from '../seed/pricing'
import { seed as seedViews } from '../seed/views'
import { seed as seedFollowups } from '../seed/w2b-followups-platform'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The W2a follow-ups for sales, product and platform (W2b schema wave 3/7, B-W2b-03) beyond the generated isolation
 * tests, on a database built from the migrations and seeded, through the real login and the scoped client, and as the
 * owner (the …_followups_platform_w2b_guards rules hold for every login):
 *   - the seed is idempotent; the floor and the portal read none of the three new tables; a first-load step is written
 *     once, a report run never changed;
 *   - a closed-short reason code only on a line closed short (also once its order PARTLY_SHIPPED);
 *   - a customer's dated price lists never overlap, keep their customer, list and start, and are never deleted;
 *   - a style's copied-from (never itself, the revision only with its style and of that style, set once); its gender;
 *   - Role.requireMfaSince kept by the database; a lifted suppression (one block in force per address);
 *   - first-load steps (an APPLIED import of the company, or nothing to load with its reason); one personal default
 *     view per owner, list and company; deleting a view clears its exports' viewId (and only that); report runs; a
 *     supplier calendar's time zone; the scanner and error-tracking providers; a device's network.
 * The refusals are check_violation (SQLSTATE 23514), read in their words.
 */

const NS = 'followups-platform-w2b'
const DENIED = /permission denied/
const UNIQUE = /unique|duplicate key/i
let db: MigratedDatabase
let factory: FactoryDatabase
let core: CoreSeed
let pricing: PricingSeed

const key = (name: string): string => seedUuid(NS, name)
const companyA = key('company:A')
const companyB = key('company:B')
const siteA1 = key('site:A1')
const P1 = key('party:P1')
const P2 = key('party:P2')
const ownerId = key('actor')
const tablet = key('device:A1:cutting')

const office = (): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: core.tenantId, actorId: tablet, siteId: siteA1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: core.tenantId, actorId: randomUUID(), partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [core.tenantId]))[0]!.n)
const NEW_TABLES = ['PartyPriceListAssignment', 'FirstLoadStep', 'ReportRun'] as const
/** The new tables' row counts of the tenant, one query after the other (one admin connection). */
async function counts(): Promise<number[]> {
  const result: number[] = []
  for (const table of NEW_TABLES) result.push(await count(table))
  return result
}

beforeAll(async () => {
  db = await migratedDatabase('followups_w2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  core = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  pricing = await seedPricing({ db: factory, namespace: NS })
  await seedImports({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedCalendar({ db: factory, namespace: NS })
  await seedViews({ db: factory, namespace: NS })
  await seedFollowups({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed and the walls', () => {
  it('is idempotent: a second run inserts nothing', async () => {
    const before = await counts()
    expect(before).toEqual([3, 1, 3])
    await seedFollowups({ db: factory, namespace: NS })
    expect(await counts()).toEqual(before)
  })

  it('lets the floor and the portal read none of the new tables', async () => {
    for (const table of NEW_TABLES) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
      await expect(sql(partner(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    }
  })

  it('writes a first-load step once and never changes a report run, for every login', async () => {
    const [step] = await admin('SELECT id::text AS id FROM "FirstLoadStep" WHERE "tenantId" = $1', [core.tenantId])
    await expect(run(office(), `UPDATE "FirstLoadStep" SET reason = 'x' WHERE id = $1::uuid`, step!.id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "FirstLoadStep" WHERE id = $1::uuid`, step!.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "FirstLoadStep" SET reason = 'x' WHERE id = $1`, [step!.id])).rejects.toThrow(/is done once; UPDATE is refused/)
    await expect(admin(`DELETE FROM "FirstLoadStep" WHERE id = $1`, [step!.id])).rejects.toThrow(/is done once; DELETE is refused/)
    await expect(admin('TRUNCATE "FirstLoadStep"')).rejects.toThrow(/TRUNCATE on "FirstLoadStep" is refused/)

    const [runRow] = await admin('SELECT id::text AS id FROM "ReportRun" WHERE "tenantId" = $1 ORDER BY at LIMIT 1', [core.tenantId])
    await expect(run(office(), `UPDATE "ReportRun" SET params = '{}' WHERE id = $1::uuid`, runRow!.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "ReportRun" SET params = '{}' WHERE id = $1`, [runRow!.id])).rejects.toThrow(/report run .* is never changed/)
    await expect(admin('TRUNCATE "ReportRun"')).rejects.toThrow(/TRUNCATE on "ReportRun" is refused/)
  })
})

describe('sales', () => {
  it('names a closed-short reason code only on a line closed short, also once the order PARTLY_SHIPPED', async () => {
    const order = pricing.money.sales.orderId
    const [line] = await admin('SELECT id::text AS id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1', [order])
    const close = (code: string | null) =>
      run(
        office(),
        `UPDATE "SalesOrderLine" SET "closedShortQuantity" = 1, "closedShortAt" = now(), "closedShortById" = $2::uuid, "closeShortReason" = 'The customer does not want the rest.', "closedShortReasonCode" = $3 WHERE id = $1::uuid`,
        line!.id,
        core.actorId,
        code,
      )
    const reopen = (code: string | null = null) =>
      run(office(), `UPDATE "SalesOrderLine" SET "closedShortQuantity" = NULL, "closedShortAt" = NULL, "closedShortById" = NULL, "closeShortReason" = NULL, "closedShortReasonCode" = $2 WHERE id = $1::uuid`, line!.id, code)
    await expect(run(office(), `UPDATE "SalesOrderLine" SET "closedShortReasonCode" = 'CUSTOMER_REQUEST' WHERE id = $1::uuid`, line!.id)).rejects.toThrow(/only while it is closed short/)
    await expect(close('customer request')).rejects.toThrow(/upper-case letters, digits and underscores/)
    await admin(`UPDATE "SalesOrder" SET status = 'PARTLY_SHIPPED' WHERE id = $1`, [order])
    try {
      expect(await close('CUSTOMER_REQUEST')).toBe(1)
      expect(await admin('SELECT "closedShortReasonCode" AS code FROM "SalesOrderLine" WHERE id = $1', [line!.id])).toEqual([{ code: 'CUSTOMER_REQUEST' }])
      await expect(reopen('CUSTOMER_REQUEST')).rejects.toThrow(/only while it is closed short/)
      expect(await reopen()).toBe(1)
      // A line closed short before W2b (no code) stays as it was.
      expect(await close(null)).toBe(1)
      expect(await reopen()).toBe(1)
    } finally {
      await admin(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1`, [order])
    }
  })

  it("keeps a customer's price lists dated, never overlapping, ended and never deleted", async () => {
    const insert = (values: { validFrom: string; validTo?: string | null; list?: string; party?: string }) =>
      run(
        office(),
        `INSERT INTO "PartyPriceListAssignment" (id, "partyId", "priceListId", "validFrom", "validTo", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, now())`,
        randomUUID(),
        values.party ?? P1,
        values.list ?? pricing.baseListId,
        values.validFrom,
        values.validTo ?? null,
      )
    // P1 has the base list in September 2026 and its own list from 1 October 2026 (open).
    await expect(insert({ validFrom: '2026-09-15', validTo: '2026-09-20' })).rejects.toThrow(/overlaps another list of its customer/)
    await expect(insert({ validFrom: '2027-01-01' })).rejects.toThrow(/overlaps another list of its customer/)
    await expect(insert({ validFrom: '2026-08-10', validTo: '2026-08-01' })).rejects.toThrow(/ends \(2026-08-01\) before it starts/)
    expect(await insert({ validFrom: '2026-08-01', validTo: '2026-08-31' })).toBe(1)
    // Another customer is apart.
    expect(await insert({ validFrom: '2026-09-15', party: P2 })).toBe(1)

    const open = pricing.customerListId
    const [row] = await admin('SELECT id::text AS id FROM "PartyPriceListAssignment" WHERE "partyId" = $1 AND "priceListId" = $2', [P1, open])
    // Giving another list: the open row ends the day before, then the new one starts.
    expect(await run(office(), `UPDATE "PartyPriceListAssignment" SET "validTo" = '2026-12-31' WHERE id = $1::uuid`, row!.id)).toBe(1)
    expect(await insert({ validFrom: '2027-01-01' })).toBe(1)
    await expect(run(office(), `UPDATE "PartyPriceListAssignment" SET "validTo" = '2026-09-01' WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/before it starts/)
    await expect(run(office(), `UPDATE "PartyPriceListAssignment" SET "validFrom" = '2026-10-02' WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/keeps its customer, list and start/)
    await expect(run(office(), `UPDATE "PartyPriceListAssignment" SET "priceListId" = $2::uuid WHERE id = $1::uuid`, row!.id, pricing.baseListId)).rejects.toThrow(/keeps its customer, list and start/)
    await expect(run(office(), `DELETE FROM "PartyPriceListAssignment" WHERE id = $1::uuid`, row!.id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "PartyPriceListAssignment" WHERE id = $1`, [row!.id])).rejects.toThrow(/ended, never deleted/)
    await expect(admin('TRUNCATE "PartyPriceListAssignment"')).rejects.toThrow(/is refused/)

    // An archived list is not given.
    const archived = randomUUID()
    await admin(
      `INSERT INTO "PriceList" (id, "tenantId", code, name, kind, currency, status, "updatedAt") VALUES ($1, $2, $3, 'Old list', 'CUSTOMER', 'EUR', 'ARCHIVED', now())`,
      [archived, core.tenantId, `T-OLD-${archived.slice(0, 8)}`],
    )
    await expect(insert({ validFrom: '2025-01-01', validTo: '2025-01-31', list: archived })).rejects.toThrow(/gives a price list that is ARCHIVED/)
  })
})

describe('product', () => {
  it('copies a style from another style and its revision, never from itself, set once; with its gender', async () => {
    const source = pricing.product.styleId
    const revision = pricing.product.revisionId
    const [copy] = await admin(`SELECT id::text AS id FROM "Style" WHERE "tenantId" = $1 AND id <> $2 ORDER BY code LIMIT 1`, [core.tenantId, source])
    const set = (style: string | null, rev: string | null, id = copy!.id as string) =>
      run(office(), `UPDATE "Style" SET "copiedFromStyleId" = $2::uuid, "copiedFromRevisionId" = $3::uuid WHERE id = $1::uuid`, id, style, rev)
    await expect(set(source, null, source)).rejects.toThrow(/is not a copy of itself/)
    await expect(set(null, revision)).rejects.toThrow(/only with that revision's style/)
    // A revision of another style (the copy's own) is refused by the tenant-safe key (the revision's style is part of it).
    const [own] = await admin('SELECT id::text AS id FROM "StyleRevision" WHERE "styleId" = $1 LIMIT 1', [copy!.id])
    await expect(set(source, own!.id as string)).rejects.toThrow(/foreign key/)
    expect(await set(source, null)).toBe(1)
    // Filled in later, once (as from the audit): the revision.
    expect(await set(source, revision)).toBe(1)
    await expect(set(source, null)).rejects.toThrow(/keeps the style and revision it was copied from/)
    await expect(admin(`UPDATE "Style" SET "copiedFromStyleId" = NULL, "copiedFromRevisionId" = NULL WHERE id = $1`, [copy!.id])).rejects.toThrow(/keeps the style and revision/)

    expect(await run(office(), `UPDATE "Style" SET gender = 'UNISEX' WHERE id = $1::uuid`, copy!.id)).toBe(1)
    await expect(run(office(), `UPDATE "Style" SET gender = 'KIDS' WHERE id = $1::uuid`, copy!.id)).rejects.toThrow(/invalid input value for enum/)
    // The floor reads the new columns (no money in them).
    expect(await sql(floor(), 'SELECT gender::text AS gender, "copiedFromStyleId"::text AS source FROM "Style" WHERE id = $1::uuid', copy!.id)).toEqual([{ gender: 'UNISEX', source }])
  })
})

describe('platform', () => {
  it("keeps Role.requireMfaSince with requireMfa: set when it is switched on, cleared when off, never moved while on", async () => {
    const role = randomUUID()
    const since = async () => (await admin('SELECT "requireMfaSince" AS since FROM "Role" WHERE id = $1', [role]))[0]!.since as Date | null
    await run(office(), `INSERT INTO "Role" (id, key, name, "requireMfa", "updatedAt") VALUES ($1::uuid, $2, 'Test role', true, now())`, role, `custom.t-${role.slice(0, 8)}`)
    const first = await since()
    expect(first).toBeInstanceOf(Date)
    await expect(run(office(), `UPDATE "Role" SET "requireMfaSince" = now() - interval '1 day' WHERE id = $1::uuid`, role)).rejects.toThrow(/never moves while it asks/)
    expect(await run(office(), `UPDATE "Role" SET name = 'Renamed' WHERE id = $1::uuid`, role)).toBe(1)
    expect(await since()).toEqual(first)
    expect(await run(office(), `UPDATE "Role" SET "requireMfa" = false, "requireMfaSince" = now() WHERE id = $1::uuid`, role)).toBe(1)
    expect(await since()).toBeNull()
    // Switched on again with the command's time.
    expect(await run(office(), `UPDATE "Role" SET "requireMfa" = true, "requireMfaSince" = '2026-11-02T08:00:00Z' WHERE id = $1::uuid`, role)).toBe(1)
    expect((await since())!.toISOString()).toBe('2026-11-02T08:00:00.000Z')

    // A role that asked before W2b (no time) may be given its time once, from the audit.
    const legacy = randomUUID()
    await run(office(), `INSERT INTO "Role" (id, key, name, "updatedAt") VALUES ($1::uuid, $2, 'Legacy role', now())`, legacy, `custom.l-${legacy.slice(0, 8)}`)
    await admin(`ALTER TABLE "Role" DISABLE TRIGGER "Role_require_mfa_since"`)
    try {
      await admin(`UPDATE "Role" SET "requireMfa" = true WHERE id = $1`, [legacy])
    } finally {
      await admin(`ALTER TABLE "Role" ENABLE TRIGGER "Role_require_mfa_since"`)
    }
    expect(await run(office(), `UPDATE "Role" SET "requireMfaSince" = '2026-10-30T10:00:00Z' WHERE id = $1::uuid`, legacy)).toBe(1)
    await expect(run(office(), `UPDATE "Role" SET "requireMfaSince" = '2026-10-31T10:00:00Z' WHERE id = $1::uuid`, legacy)).rejects.toThrow(/never moves/)
  })

  it('lifts a suppression with when, who and why, once; one block in force per address', async () => {
    const address = `lift-${randomUUID().slice(0, 8)}@cliente.example`
    const block = (id = randomUUID()) =>
      run(office(), `INSERT INTO "Suppression" (id, address, reason, at, "updatedAt") VALUES ($1::uuid, $2, 'BOUNCE', now(), now())`, id, address).then(() => id)
    const first = await block()
    await expect(block()).rejects.toThrow(UNIQUE)
    await expect(
      run(office(), `INSERT INTO "Suppression" (id, address, reason, at, "liftedAt", "liftedById", "liftReason", "updatedAt") VALUES ($1::uuid, $2, 'BOUNCE', now(), now(), $3::uuid, 'x', now())`, randomUUID(), `${address}.born`, ownerId),
    ).rejects.toThrow(/starts in force/)
    await expect(run(office(), `UPDATE "Suppression" SET "liftedAt" = now() WHERE id = $1::uuid`, first)).rejects.toThrow(/lifted with when, who and why/)
    await expect(run(office(), `UPDATE "Suppression" SET "liftedAt" = now(), "liftedById" = $2::uuid, "liftReason" = '  ' WHERE id = $1::uuid`, first, ownerId)).rejects.toThrow(/lifted with when, who and why/)
    expect(await run(office(), `UPDATE "Suppression" SET "liftedAt" = now(), "liftedById" = $2::uuid, "liftReason" = 'The customer fixed its mailbox.' WHERE id = $1::uuid`, first, ownerId)).toBe(1)
    await expect(run(office(), `UPDATE "Suppression" SET detail = 'changed' WHERE id = $1::uuid`, first)).rejects.toThrow(/was lifted; it never changes again/)
    await expect(run(office(), `UPDATE "Suppression" SET "liftedAt" = NULL, "liftedById" = NULL, "liftReason" = NULL WHERE id = $1::uuid`, first)).rejects.toThrow(/never changes again/)
    // A later bounce blocks the address again, in a new row.
    await block()
    expect(await admin('SELECT count(*)::int AS n FROM "Suppression" WHERE address = $1', [address])).toEqual([{ n: 2 }])
  })

  it('marks a first-load step done with an APPLIED import of its company, or nothing to load and why; once per step', async () => {
    const job = key('imports:job')
    const step = (values: { step: string; jobId?: string | null; nothing?: boolean; reason?: string | null; company?: string }) =>
      run(
        office(),
        `INSERT INTO "FirstLoadStep" (id, "companyId", step, "jobId", "nothingToLoad", reason, "doneAt", "doneById", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, now(), $7::uuid, now())`,
        randomUUID(),
        values.company ?? companyA,
        values.step,
        values.jobId ?? null,
        values.nothing ?? false,
        values.reason ?? null,
        ownerId,
      )
    await expect(step({ step: 'materials' })).rejects.toThrow(/names the import it matched, or says there was nothing to load and why/)
    await expect(step({ step: 'materials', nothing: true })).rejects.toThrow(/nothing to load and why/)
    await expect(step({ step: 'materials', jobId: job, nothing: true, reason: 'No sheet.' })).rejects.toThrow(/nothing to load and why/)
    await expect(step({ step: 'Materials list', nothing: true, reason: 'No sheet.' })).rejects.toThrow(/names its step by its key/)
    // The seeded job is PLANNED, not APPLIED.
    await expect(step({ step: 'materials', jobId: job })).rejects.toThrow(/APPLIED import of its company/)
    await admin(`UPDATE "ImportJob" SET status = 'APPLIED', "appliedAt" = now(), "appliedCount" = 2 WHERE id = $1`, [job])
    await expect(step({ step: 'materials', jobId: job, company: companyB })).rejects.toThrow(/APPLIED import of its company/)
    expect(await step({ step: 'materials', jobId: job })).toBe(1)
    await expect(step({ step: 'materials', nothing: true, reason: 'Again.' })).rejects.toThrow(UNIQUE)
    expect(await step({ step: 'openOrders', nothing: true, reason: 'Open orders are typed as sales orders.' })).toBe(1)
  })

  it("keeps one personal default view per owner, list and company; deleting a view clears its exports' link only", async () => {
    const view = (values: { name: string; company?: string | null; personal?: boolean }) => {
      const id = randomUUID()
      return run(
        office(),
        `INSERT INTO "SavedView" (id, "listKey", name, "ownerId", audience, "companyId", "isPersonalDefault", state, "updatedAt") VALUES ($1::uuid, 'warehouse.lots', $2, $3::uuid, 'ONLY_ME', $4::uuid, $5, '{}', now())`,
        id,
        values.name,
        ownerId,
        values.company ?? null,
        values.personal ?? false,
      ).then(() => id)
    }
    const mine = await view({ name: 'My lots', company: companyA, personal: true })
    await expect(view({ name: 'My other lots', company: companyA, personal: true })).rejects.toThrow(UNIQUE)
    await view({ name: 'Lots of B', company: companyB, personal: true })
    await view({ name: 'Every lot', personal: true })
    const other = await view({ name: 'Plain lots', company: companyA })

    // Two exports made from the view: one waits, one failed (final).
    const exportFrom = async (viewId: string) => {
      const id = randomUUID()
      await run(
        office(),
        `INSERT INTO "ExportJob" (id, "companyId", "requestedById", "listKey", "viewId", format, query, "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'warehouse.lots', $4::uuid, 'CSV', '{}', now())`,
        id,
        companyA,
        ownerId,
        viewId,
      )
      return id
    }
    const queued = await exportFrom(mine)
    const failed = await exportFrom(mine)
    await run(office(), `UPDATE "ExportJob" SET status = 'FAILED', "finishedAt" = now(), "failureReason" = 'Stopped.' WHERE id = $1::uuid`, failed)
    await expect(run(office(), `UPDATE "ExportJob" SET "viewId" = $2::uuid WHERE id = $1::uuid`, queued, other)).rejects.toThrow(/keeps what was asked/)
    await expect(run(office(), `UPDATE "ExportJob" SET "failureReason" = 'Other.' WHERE id = $1::uuid`, failed)).rejects.toThrow(/is FAILED; it changes no more/)

    expect(await run(office(), 'DELETE FROM "SavedView" WHERE id = $1::uuid', mine)).toBe(1)
    expect(await admin('SELECT id::text AS id, "viewId", "tenantId"::text AS tenant, status::text AS status FROM "ExportJob" WHERE id = ANY($1::uuid[]) ORDER BY status', [[queued, failed]])).toEqual([
      { id: failed, viewId: null, tenant: core.tenantId, status: 'FAILED' },
      { id: queued, viewId: null, tenant: core.tenantId, status: 'QUEUED' },
    ])
  })

  it('keeps report runs with a report key and their filters as an object; old ones may be deleted', async () => {
    const insert = (reportKey: string, params: string) =>
      run(office(), `INSERT INTO "ReportRun" (id, "userId", "reportKey", params, at) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, now())`, randomUUID(), ownerId, reportKey, params)
    await expect(insert('daily', '{}')).rejects.toThrow(/names its report by its key/)
    await expect(insert('production.daily', '[]')).rejects.toThrow(/keeps its filters as an object/)
    expect(await insert('sales.margin-by-order', '{"companyId": null}')).toBe(1)
    expect(await run(office(), `DELETE FROM "ReportRun" WHERE "reportKey" = 'sales.margin-by-order'`)).toBe(1)
  })

  it("gives only a supplier's calendar a time zone of its own, a known one", async () => {
    const supplier = key('calendar:supplier:P2')
    const company = key('calendar:company:A')
    await expect(run(office(), `UPDATE "WorkCalendar" SET "timeZone" = 'Europe/Rome' WHERE id = $1::uuid`, company)).rejects.toThrow(/only as a supplier's calendar/)
    await expect(run(office(), `UPDATE "WorkCalendar" SET "timeZone" = 'Mars/Olympus' WHERE id = $1::uuid`, supplier)).rejects.toThrow(/a known one \(IANA\), not Mars\/Olympus/)
    expect(await run(office(), `UPDATE "WorkCalendar" SET "timeZone" = 'Asia/Karachi' WHERE id = $1::uuid`, supplier)).toBe(1)
    expect(await run(office(), `UPDATE "WorkCalendar" SET "timeZone" = NULL WHERE id = $1::uuid`, supplier)).toBe(1)
  })

  it("knows the scanner and the error-tracking providers, and a device's network and time in use", async () => {
    const providers = await admin(`SELECT unnest(enum_range(NULL::"IntegrationProvider"))::text AS provider`)
    expect(providers.map((row) => row.provider)).toEqual(['SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES', 'CLAMAV', 'ERROR_TRACKING'])
    // The floor reports its own state (the device's row, its site).
    expect(await run(floor(), `UPDATE "Device" SET network = 'WIFI', "inUseSince" = now() WHERE id = $1::uuid`, tablet)).toBe(1)
    expect(await sql(office(), `SELECT network::text AS network, "inUseSince" IS NOT NULL AS "inUse" FROM "Device" WHERE id = $1::uuid`, tablet)).toEqual([{ network: 'WIFI', inUse: true }])
  })
})
