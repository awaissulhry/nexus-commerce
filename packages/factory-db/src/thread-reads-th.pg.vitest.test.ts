import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedPrivacyOps, type PrivacyOpsSeed } from '../seed/privacy-ops'
import { seed as seedThreads } from '../seed/threads'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Threads know who read them and who answers them (TH-2, threads schema wave 4/9, B-TH-023; review PR-26;
 * …_threads_reads_th_guards and the generated policy migration), on a database built from the migrations and seeded twice,
 * through the real login and the scoped client:
 *   - the wall (W01): an office person's mark is the office's; a portal session reads and writes only its own party's people's
 *     marks, on messages shared with its party (never an internal note), and removes none; another party reads none; the floor's
 *     role reads and writes none (Statuto dei Lavoratori art. 4: no read record of a floor worker);
 *   - whose mark: an office person's carries no party, a portal person's their own party (the thread's), one per thread and
 *     person, its thread, person and party never change, read at a time not in the future;
 *   - the marks go with the person's erasure (an ERASURE request's record of the User), and only theirs;
 *   - Thread.ownerId: an active office person, hidden from the portal.
 * The refusals are check_violation (23514), the wall's permission denied or a row-level security refusal.
 */

const NS = 'th-023-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let privacy: PrivacyOpsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  member: key('user:member'),
  invited: key('user:invited'),
  companyThread: key('threads:company:A'),
  quoteThread: key('threads:quote:Q1'),
  companyNote: key('threads:message:company-note'),
  quoteNote: key('threads:message:quote-note'),
  quoteOut: key('threads:message:quote-out'),
  quoteIn: key('threads:message:quote-in'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string, actorId = portal.userIds.p1Buyer): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))

/** A read mark: `userId` on `threadId` up to `messageId` (an office person's unless a party is given), written by `scope`. */
async function mark(scope: FactoryScope, row: { threadId: string; userId: string; messageId: string; partyId?: string | null; readAt?: string; key?: string }): Promise<string> {
  const id = randomUUID()
  const key = row.key ?? `read:${row.threadId}:${row.userId}`
  expect(await insert(scope, 'ThreadRead', { id, threadId: row.threadId, userId: row.userId, partyId: row.partyId ?? null, key, lastReadMessageId: row.messageId, readAt: row.readAt ?? new Date().toISOString() })).toBe(1)
  return id
}
const marksOf = async (userId: string) => (await admin(`SELECT id FROM "ThreadRead" WHERE "userId" = $1::uuid ORDER BY id`, [userId])).map((row) => row.id as string)

beforeAll(async () => {
  db = await migratedDatabase('threadreadsth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedIntegration({ db: factory, namespace: NS })
  await seedThreads({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  privacy = await seedPrivacyOps({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedThreads({ db: factory, namespace: NS })
  await seedPortalAuth({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the wall (W01)', () => {
  it("a portal session reads and writes only its own party's people's marks; another party none; the floor none", async () => {
    const officeMark = await mark(office(), { threadId: A.quoteThread, userId: a.actorId, messageId: A.quoteNote })
    // The buyer marks what they read, in the portal's own scope, on a message shared with P1.
    const buyerMark = await mark(partner(A.P1), { threadId: A.quoteThread, userId: portal.userIds.p1Buyer, partyId: A.P1, messageId: A.quoteOut })
    expect(await run(partner(A.P1), `UPDATE "ThreadRead" SET "lastReadMessageId" = $2::uuid, "readAt" = now() WHERE id = $1::uuid`, buyerMark, A.quoteIn)).toBe(1)
    // P1 reads its own people's marks, never the office person's.
    expect((await sql(partner(A.P1), `SELECT id FROM "ThreadRead"`)).map((row) => row.id)).toEqual([buyerMark])
    expect(await sql(partner(A.P1), `SELECT id FROM "ThreadRead" WHERE id = $1::uuid`, officeMark)).toEqual([])
    // Another party reads nothing, and writes nothing under P1.
    expect(await sql(partner(A.P2, portal.userIds.p2Orders), `SELECT id FROM "ThreadRead"`)).toEqual([])
    await expect(mark(partner(A.P2, portal.userIds.p2Orders), { threadId: A.quoteThread, userId: portal.userIds.p1Viewer, partyId: A.P1, messageId: A.quoteOut })).rejects.toThrow(/row-level security/)
    // A portal session removes none (Mark unread is the office's), never an office person's mark.
    await expect(run(partner(A.P1), `DELETE FROM "ThreadRead" WHERE id = $1::uuid`, buyerMark)).rejects.toThrow(/permission denied/)
    await expect(mark(partner(A.P1), { threadId: A.quoteThread, userId: a.actorId, messageId: A.quoteOut })).rejects.toThrow(/row-level security/)
    // The floor reads and writes none.
    await expect(sql(floor(), `SELECT id FROM "ThreadRead" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(mark(floor(), { threadId: A.quoteThread, userId: a.actorId, messageId: A.quoteNote })).rejects.toThrow(/permission denied/)
    // The office reads every mark of the tenant (the API keeps each person to their own) and removes one (Mark unread).
    expect((await sql(office(), `SELECT id FROM "ThreadRead" ORDER BY id`)).map((row) => row.id).sort()).toEqual([officeMark, buyerMark].sort())
    expect(await run(office(), `DELETE FROM "ThreadRead" WHERE id = $1::uuid`, officeMark)).toBe(1)
  })

  it('a portal person never marks an internal note, a message of another thread, or someone who is not theirs', async () => {
    // The internal note is not P1's to read: the portal session cannot see it, the office's write is refused too.
    await expect(mark(partner(A.P1), { threadId: A.quoteThread, userId: portal.userIds.p1Viewer, partyId: A.P1, messageId: A.quoteNote })).rejects.toThrow(/stops at a message of its own thread/)
    await expect(mark(office(), { threadId: A.quoteThread, userId: portal.userIds.p1Viewer, partyId: A.P1, messageId: A.quoteNote })).rejects.toThrow(/shared with their party, never an internal note/)
    const viewer = await mark(partner(A.P1), { threadId: A.quoteThread, userId: portal.userIds.p1Viewer, partyId: A.P1, messageId: A.quoteOut })
    await expect(run(partner(A.P1), `UPDATE "ThreadRead" SET "lastReadMessageId" = $2::uuid WHERE id = $1::uuid`, viewer, A.quoteNote)).rejects.toThrow(/stops at a message of its own thread/)
    // A message of another thread.
    await expect(run(office(), `UPDATE "ThreadRead" SET "lastReadMessageId" = $2::uuid WHERE id = $1::uuid`, viewer, A.companyNote)).rejects.toThrow(/stops at a message of its own thread/)
    // P2's person on P1's thread: not P1's people, and not the thread's party.
    await expect(mark(office(), { threadId: A.quoteThread, userId: portal.userIds.p2Orders, partyId: A.P1, messageId: A.quoteOut })).rejects.toThrow(/portal person's \(their own party\)/)
    await expect(mark(office(), { threadId: A.quoteThread, userId: portal.userIds.p2Orders, partyId: A.P2, messageId: A.quoteOut })).rejects.toThrow(/ThreadRead_tenantId_threadId_partyId_fkey|foreign key/)
  })
})

describe('whose mark', () => {
  it("an office person's has no party, a portal person's their own; one per thread and person, fixed, read at a time not in the future", async () => {
    await expect(mark(office(), { threadId: A.companyThread, userId: A.member, partyId: A.P1, messageId: A.companyNote })).rejects.toThrow(/office person's \(no party\)|foreign key/)
    await expect(mark(office(), { threadId: A.quoteThread, userId: A.member, partyId: A.P1, messageId: A.quoteOut })).rejects.toThrow(/office person's \(no party\)/)
    await expect(mark(office(), { threadId: A.companyThread, userId: portal.userIds.p1Viewer, messageId: A.companyNote })).rejects.toThrow(/portal person's \(their own party\)/)
    await expect(mark(office(), { threadId: A.companyThread, userId: A.member, messageId: A.companyNote, readAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/read at a time not in the future/)
    const own = await mark(office(), { threadId: A.companyThread, userId: A.member, messageId: A.companyNote })
    await expect(mark(office(), { threadId: A.companyThread, userId: A.member, messageId: A.companyNote })).rejects.toThrow(/ThreadRead_tenantId_key_key|duplicate key/)
    // The key names its thread and person.
    await expect(mark(office(), { threadId: A.quoteThread, userId: A.member, messageId: A.quoteNote, key: `read:${A.companyThread}:${A.member}x` })).rejects.toThrow(/key of read mark .* is read:<threadId>:<userId>/)
    await expect(run(office(), `UPDATE "ThreadRead" SET key = key || '-2' WHERE id = $1::uuid`, own)).rejects.toThrow(/thread, person and party of read mark .* never change/)
    await expect(run(office(), `UPDATE "ThreadRead" SET "userId" = $2::uuid WHERE id = $1::uuid`, own, a.actorId)).rejects.toThrow(/thread, person and party of read mark .* never change/)
    await expect(run(office(), `UPDATE "ThreadRead" SET "threadId" = $2::uuid, "lastReadMessageId" = $3::uuid WHERE id = $1::uuid`, own, A.quoteThread, A.quoteNote)).rejects.toThrow(/thread, person and party of read mark .* never change/)
    // Moving it back is "Mark unread" on a message: allowed.
    expect(await run(office(), `UPDATE "ThreadRead" SET "readAt" = now() WHERE id = $1::uuid`, own)).toBe(1)
  })
})

describe('erased with the person (PR-26)', () => {
  it("an erasure of the person removes their marks, and only theirs; a record the law keeps removes nothing", async () => {
    const buyer = await marksOf(portal.userIds.p1Buyer)
    expect(buyer.length).toBeGreaterThan(0)
    const others = await marksOf(portal.userIds.p1Viewer)
    expect(others.length).toBeGreaterThan(0)
    const erasure = (method: string, recordId: string, fields: Record<string, unknown>) =>
      insert(office(), 'ErasureRecord', { id: randomUUID(), companyId: A.companyA, dataRequestId: privacy.requestIds.contactErasure, recordType: 'User', recordId, method, erasedById: a.actorId, ...fields })
    // KEPT: nothing removed.
    expect(await erasure('KEPT', portal.userIds.p1Buyer, { keptWhy: 'Kept as the law requires (made up).' })).toBe(1)
    expect(await marksOf(portal.userIds.p1Buyer)).toEqual(buyer)
    expect(await erasure('ANONYMISED', portal.userIds.p1Buyer, { erasedFields: ['displayName', 'email'] })).toBe(1)
    expect(await marksOf(portal.userIds.p1Buyer)).toEqual([])
    expect(await marksOf(portal.userIds.p1Viewer)).toEqual(others)
  })
})

describe('who answers a thread (Thread.ownerId)', () => {
  it('is an active office person, never a portal person or someone invited; hidden from the portal', async () => {
    expect(await run(office(), `UPDATE "Thread" SET "ownerId" = $2::uuid WHERE id = $1::uuid`, A.quoteThread, A.member)).toBe(1)
    await expect(run(office(), `UPDATE "Thread" SET "ownerId" = $2::uuid WHERE id = $1::uuid`, A.quoteThread, portal.userIds.p1Buyer)).rejects.toThrow(/answered by an active office person, not one that is ACTIVE \(PARTNER\)/)
    await expect(run(office(), `UPDATE "Thread" SET "ownerId" = $2::uuid WHERE id = $1::uuid`, A.quoteThread, A.invited)).rejects.toThrow(/answered by an active office person, not one that is INVITED \(OFFICE\)/)
    expect(await run(office(), `UPDATE "Thread" SET "ownerId" = NULL WHERE id = $1::uuid`, A.quoteThread)).toBe(1)
    expect((await sql(partner(A.P1), `SELECT id FROM "Thread" WHERE id = $1::uuid`, A.quoteThread)).length).toBe(1)
    await expect(sql(partner(A.P1), `SELECT "ownerId" FROM "Thread" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})
