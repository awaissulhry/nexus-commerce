import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * A custom field for one customer (TH-4, threads schema wave 7/9, B-TH-055; WALL-G08 / SHEET-G06, research §12 decision 12;
 * …_config_brand_fields_th_guards and the generated policy migration), on a database built from the migrations and seeded
 * twice, through the real login and the scoped client:
 *   - the wall (W17): a value of a field for customer B goes only on customer B's records, never on customer A's, never on a
 *     record of none; a field of every customer goes on any record as before; portal and floor sessions read no field at all;
 *   - whose field: an active customer of the tenant (role CUSTOMER), of the field's company or every company, on a record type
 *     whose records name their customer; never changed.
 * The refusals are check_violation (23514) or the wall's permission denied; the words name no customer.
 */

const NS = 'th-055-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let sales: SalesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  P3: key('party:P3'),
  P4: key('party:P4'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))

let codes = 0
/** A TEXT field on `recordType` for `partyId` (null: every customer), written by the office; answers its id. */
async function field(recordType: string, partyId: string | null, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const code = `fit_note_${++codes}`
  expect(await insert(office(), 'CustomField', { id, companyId: null, recordType, code, key: `field:${recordType}:${code}`, type: 'TEXT', labelIt: 'Nota vestibilità', labelEn: 'Fit note', partyId, ...extra })).toBe(1)
  return id
}
/** A value of `fieldId` on `recordType` `recordId`. */
const value = (fieldId: string, recordType: string, recordId: string) =>
  insert(office(), 'CustomFieldValue', { id: randomUUID(), fieldId, recordType, recordId, key: `value:${fieldId}:${recordId}`, value: 'Seed: slim fit, long sleeves', changedAt: new Date().toISOString(), changedById: a.actorId })
/** A customer party of the tenant written by the office (`extra`: its company, status, roles). */
async function party(extra: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Party', { id, code: `SEED-TH55-${id.slice(0, 6)}`, kind: 'ORGANISATION', legalName: 'Seed Customer Five S.r.l.', roles: ['CUSTOMER'], status: 'ACTIVE', ...extra })).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('brandfieldsth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSales({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the wall (W17)', () => {
  it("a field of customer B is never a field of customer A: its values go only on B's records", async () => {
    // A field for P4 (another active customer) on the customer's own record: on P4 yes, on P1 never.
    const forP4 = await field('Party', A.P4)
    expect(await value(forP4, 'Party', A.P4)).toBe(1)
    await expect(value(forP4, 'Party', A.P1)).rejects.toThrow(/goes only on a record of the customer the field is for/)
    // On orders: P1's order takes P1's field, never P4's.
    expect(await value(await field('SalesOrder', A.P1), 'SalesOrder', sales.orderId)).toBe(1)
    await expect(value(await field('SalesOrder', A.P4), 'SalesOrder', sales.orderId)).rejects.toThrow(/goes only on a record of the customer the field is for/)
    // A field of every customer: on any record, as before.
    expect(await value(await field('SalesOrder', null), 'SalesOrder', sales.orderId)).toBe(1)
    // The words name no customer.
    await expect(value(forP4, 'Party', A.P1)).rejects.toThrow(/^(?![\s\S]*SEED-)/)
  })

  it('portal and floor sessions read no custom field and no value at all', async () => {
    for (const table of ['CustomField', 'CustomFieldValue']) {
      await expect(sql(partner(A.P4), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe("whose field (B-TH-055)", () => {
  it('an active customer of the tenant, of the field\'s company or every company, on a record type that names its customer', async () => {
    // Not a customer (P2 is a supplier), not a party of the tenant, not active (P3 is a prospect).
    await expect(field('Party', A.P2)).rejects.toThrow(/one active customer/)
    await expect(field('Party', randomUUID())).rejects.toThrow(/one active customer|foreign key/)
    await expect(field('Party', A.P3)).rejects.toThrow(/one active customer/)
    // A record type whose records name no customer (an article).
    await expect(field('Item', A.P1)).rejects.toThrow(/whose records name their customer/)
    // A customer of company A only: a field of company A or of every company, never of company B.
    const ofA = await party({ companyId: A.companyA })
    expect(await field('Party', ofA, { companyId: A.companyA })).toBeTruthy()
    expect(await field('Party', ofA)).toBeTruthy()
    await expect(field('Party', ofA, { companyId: a.companies[1]!.id })).rejects.toThrow(/customer of that company or of every company/)
  })

  it('never changes: another customer\'s field is another row', async () => {
    const forP1 = await field('SalesOrder', A.P1)
    const forEvery = await field('SalesOrder', null)
    await expect(run(office(), `UPDATE "CustomField" SET "partyId" = $2::uuid WHERE id = $1::uuid`, forP1, A.P4)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "CustomField" SET "partyId" = $2::uuid WHERE id = $1::uuid`, forEvery, A.P4)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "CustomField" SET "partyId" = NULL WHERE id = $1::uuid`, forP1)).rejects.toThrow(/never changes/)
    // Its words and order still change.
    expect(await run(office(), `UPDATE "CustomField" SET "labelEn" = 'Fit notes', "sortOrder" = 5 WHERE id = $1::uuid`, forP1)).toBe(1)
  })
})
