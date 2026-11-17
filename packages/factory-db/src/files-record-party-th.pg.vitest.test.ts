import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { seed as seedSalesIntake, type SalesIntakeSeed } from '../seed/sales-intake'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * A file is shared only with its record's own party (TH-2, follow-up WALL-G02 of TH-0 part A, B-TH-003; surface W25;
 * …_files_record_party_th_guards), on a database built from the migrations and seeded twice, through the real login and the
 * scoped client, and as the owner: whatever path writes the file (the generic route, a module's own upload, a copy, a new
 * version, a visibility change), a file that names a party names its record's own; a record of no party shares with none; a
 * record type whose table names no party is left to the API. The refusals are check_violation (23514), in words naming no
 * party.
 */

const NS = 'th-g02-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SalesIntakeSeed
let sales: SalesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  P3: key('party:P3'),
  jacket: key('product:style:JKT-01'),
  officeFile: key('files:office'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const COPY = `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(r) || $1::jsonb FROM "StoredFile" r WHERE r.id = $2::uuid))`

/** A file of `recordType` `recordId` (a copy of the seeded office document), shared with `partyId` when given. */
function fileRow(recordType: string, recordId: string, partyId: string | null): Record<string, unknown> {
  return {
    id: randomUUID(),
    recordType,
    recordId,
    storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
    visibility: partyId ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
    partyId,
  }
}
async function newFile(recordType: string, recordId: string, partyId: string | null): Promise<string> {
  const row = fileRow(recordType, recordId, partyId)
  expect(await run(office(), COPY, JSON.stringify(row), A.officeFile)).toBe(1)
  return row.id as string
}
const share = (id: string, partyId: string) => run(office(), `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE', 'PARTNER']::"FileAudience"[], "partyId" = $2::uuid WHERE id = $1::uuid`, id, partyId)

beforeAll(async () => {
  db = await migratedDatabase('filesrecordpartyth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  s = await seedSalesIntake({ db: factory, namespace: NS })
  sales = await seedSales({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedFiles({ db: factory, namespace: NS })
  await seedSalesIntake({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe("a file names its record's own party (WALL-G02, W25)", () => {
  it("P1's order file is shared with P1, never with another party, at upload or afterwards", async () => {
    expect(await newFile('SalesOrder', sales.orderId, A.P1)).toBeTruthy()
    await expect(newFile('SalesOrder', sales.orderId, A.P3)).rejects.toThrow(/shared only with the party its SalesOrder belongs to, never with another/)
    const kept = await newFile('SalesOrder', sales.orderId, null)
    await expect(share(kept, A.P2)).rejects.toThrow(/shared only with the party its SalesOrder belongs to/)
    expect(await share(kept, A.P1)).toBe(1)
    // The same for the quote and P1's own request.
    await expect(newFile('Quote', sales.quoteId, A.P3)).rejects.toThrow(/shared only with the party its Quote belongs to/)
    await expect(newFile('Inquiry', s.inquiryIds.quoted, A.P3)).rejects.toThrow(/shared only with the party its Inquiry belongs to/)
    expect(await newFile('Inquiry', s.inquiryIds.quoted, A.P1)).toBeTruthy()
  })

  it('a record of no party shares with none; a party record with itself; a style with its brand', async () => {
    // A prospect's request (no customer yet).
    await expect(newFile('Inquiry', s.inquiryIds.prospect, A.P1)).rejects.toThrow(/belongs to a Inquiry that is no party's; it is shared with no portal or link/)
    // The party itself.
    expect(await newFile('Party', A.P1, A.P1)).toBeTruthy()
    await expect(newFile('Party', A.P1, A.P3)).rejects.toThrow(/shared only with the party its Party belongs to/)
    // P1's private-label jacket: its brand only.
    expect(await newFile('Style', A.jacket, A.P1)).toBeTruthy()
    await expect(newFile('Style', A.jacket, A.P3)).rejects.toThrow(/shared only with the party its Style belongs to/)
  })

  it("holds for the owner too; a record type whose table names no party is left to the API", async () => {
    const row = fileRow('SalesOrder', sales.orderId, A.P3)
    await expect(db.admin.query(COPY, [JSON.stringify(row), A.officeFile])).rejects.toThrow(/shared only with the party its SalesOrder belongs to/)
    // Company has no party column: the API's thread resolver refuses a share there (B-TH-003); the database does not judge it.
    expect(await newFile('Company', A.companyA, A.P1)).toBeTruthy()
  })
})
