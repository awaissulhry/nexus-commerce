import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedEmail } from '../seed/email'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedPrivacyOps, type PrivacyOpsSeed } from '../seed/privacy-ops'
import { seed as seedThreadsLater, type ThreadsLaterSeed } from '../seed/threads-later'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedHeldMail, type HeldMail } from './testing/held-mail'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * Threads, the later depth (TH-9, threads schema wave 9/9, B-TH-090; …_threads_later_th_guards and the generated policy
 * migration), on a database built from the migrations and seeded twice, through the real login and the scoped client:
 *   - the wall (W01): pins are the office's, and a portal session reads only the pins of messages shared with its party; drafts
 *     are the writer's own: a portal session reads and writes only its own party's people's, on its own party's records; the
 *     second brand of the same factory reads none of P1's and P1 none of its; the floor reads and writes none; Done and
 *     production's answer are the office's (hidden from the portal);
 *   - pins: the message's party, of the pin's thread, never a held mail, by an active office person, once, never changed;
 *   - drafts: one per person and record, fixed person, party, record and key, text and fields in shape, removed with the person;
 *   - Done: both or neither, by an active office person, never on a new thread;
 *   - WITHDRAWN: only from an open state, only by a portal person of the request's own customer, final;
 *   - production's answer: all or none, NOT_BEFORE exactly with a Monday, by an active office person, only while open.
 * The refusals are check_violation (23514), the wall's permission denied, a row-level security refusal or a foreign key.
 */

const NS = 'th-090-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let privacy: PrivacyOpsSeed
let later: ThreadsLaterSeed
let held: HeldMail
let second: SecondBrand

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  member: key('user:member'),
  invited: key('user:invited'),
  quote: key('quote:Q1'),
  companyThread: key('threads:company:A'),
  quoteThread: key('threads:quote:Q1'),
  quoteOut: key('threads:message:quote-out'),
  quoteIn: key('threads:message:quote-in'),
  quoteNote: key('threads:message:quote-note'),
  companyNote: key('threads:message:company-note'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partner = (partyId: string, actorId: string = randomUUID()): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
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
const ids = (rows: Record<string, unknown>[]): string[] => rows.map((row) => String(row.id)).sort()

/** A pin of `messageId` on `threadId`, written by the office (`extra`: who, when, the key …). */
const pin = (threadId: string, messageId: string, extra: Record<string, unknown> = {}) =>
  insert(office(), 'ThreadPin', { id: randomUUID(), threadId, messageId, key: `pin:${threadId}:${messageId}`, pinnedById: a.actorId, pinnedAt: new Date().toISOString(), ...extra })
/** A draft of `userId` (on `recordType` `recordId`, or the New order), written by `scope`. */
function draft(scope: FactoryScope, userId: string, record: { type: string; id: string } | null, extra: Record<string, unknown> = {}) {
  const draftKey = record === null ? `draft:new-request:${userId}` : `draft:${record.type}:${record.id}:${userId}`
  return insert(scope, 'ComposerDraft', { id: randomUUID(), userId, recordType: record?.type ?? null, recordId: record?.id ?? null, key: draftKey, bodyText: 'Seed: half written.', ...extra })
}
let numbers = 0
/** A request of P1 (or of `extra.partyId`, or a prospect's), typed by the office; answers its id. */
async function request(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Inquiry', { id, companyId: A.companyA, number: `SEED-TH90-${++numbers}`, source: 'OFFICE', receivedAt: new Date(Date.now() - 60_000).toISOString(), partyId: A.P1, request: 'Seed: twenty jackets.', ...extra })).toBe(1)
  return id
}
const draftsOf = async (userId: string) => (await admin(`SELECT id FROM "ComposerDraft" WHERE "userId" = $1::uuid ORDER BY id`, [userId])).map((row) => row.id as string)

beforeAll(async () => {
  db = await migratedDatabase('laterdepthth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedIntegration({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  later = await seedThreadsLater({ db: factory, namespace: NS })
  await seedEmail({ db: factory, namespace: NS })
  held = await seedHeldMail({ db: factory, namespace: NS })
  privacy = await seedPrivacyOps({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedThreadsLater({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the wall (W01)', () => {
  it('a portal session reads only the pins of messages shared with its party; another brand none; the floor none', async () => {
    // The seed's two pins: the message sent to P1 (P1's) and the office's note (no party, copied from the message).
    expect(await admin(`SELECT id, "partyId"::text AS party FROM "ThreadPin" WHERE "threadId" = $1::uuid ORDER BY "partyId" NULLS FIRST`, [A.quoteThread])).toEqual([
      { id: later.notePin, party: null },
      { id: later.sharedPin, party: A.P1 },
    ])
    expect(ids(await sql(partner(A.P1, portal.userIds.p1Buyer), `SELECT id FROM "ThreadPin"`))).toEqual([later.sharedPin])
    await expect(sql(partner(A.P1), `SELECT "pinnedById" FROM "ThreadPin" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // Brand Two: a pin of its own shared message, and none of P1's.
    expect(await pin(second.threadId, second.messageIds[0]!)).toBe(1)
    const two = partner(second.partyId, second.userId)
    expect((await sql(two, `SELECT "partyId"::text AS party FROM "ThreadPin"`)).map((row) => row.party)).toEqual([second.partyId])
    expect(await sql(two, `SELECT id FROM "ThreadPin" WHERE id = ANY($1::uuid[])`, [later.sharedPin, later.notePin])).toEqual([])
    expect(await sql(partner(A.P1), `SELECT id FROM "ThreadPin" WHERE "threadId" = $1::uuid`, second.threadId)).toEqual([])
    // A portal session pins nothing; the floor reads nothing.
    await expect(insert(partner(A.P1), 'ThreadPin', { id: randomUUID(), threadId: A.quoteThread, messageId: A.quoteIn, key: `pin:${A.quoteThread}:${A.quoteIn}`, pinnedById: portal.userIds.p1Buyer, pinnedAt: new Date().toISOString() })).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT id FROM "ThreadPin" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it("drafts are the writer's own: a portal session reads and writes its own party's people's only, on its own records", async () => {
    const p1 = partner(A.P1, portal.userIds.p1Buyer)
    expect(ids(await sql(p1, `SELECT id FROM "ComposerDraft"`))).toEqual([later.buyerReply, later.buyerNewRequest].sort())
    // P1's people save drafts on its own records (here its account conversation), save again and discard one.
    const account = { type: 'Party', id: A.P1 }
    expect(await draft(p1, portal.userIds.p1Viewer, account, { partyId: A.P1, audience: 'PARTNER' })).toBe(1)
    expect(await run(p1, `UPDATE "ComposerDraft" SET "bodyText" = 'Seed: written on.' WHERE id = $1::uuid`, later.buyerReply)).toBe(1)
    expect(await run(p1, `DELETE FROM "ComposerDraft" WHERE "key" = $1`, `draft:Party:${A.P1}:${portal.userIds.p1Viewer}`)).toBe(1)
    // Never in another party's name, never on another brand's record (or one the session cannot read), never an office note.
    await expect(draft(p1, portal.userIds.p1Viewer, account, { partyId: second.partyId })).rejects.toThrow(/row-level security/)
    await expect(draft(p1, portal.userIds.p1Viewer, { type: 'SalesOrder', id: second.salesOrderId }, { partyId: A.P1 })).rejects.toThrow(/drafts only on their own company's records/)
    await expect(draft(p1, portal.userIds.p1Viewer, { type: 'Quote', id: randomUUID() }, { partyId: A.P1 })).rejects.toThrow(/drafts only on their own company's records/)
    await expect(draft(p1, portal.userIds.p1Viewer, null, { partyId: A.P1, audience: 'OFFICE' })).rejects.toThrow(/a reply, never an office note/)
    await expect(draft(p1, second.userId, null, { partyId: A.P1 })).rejects.toThrow(/not one of this session's people|their own party/)
    // Brand Two reads none of P1's drafts, nor P1 of Brand Two's; the floor none.
    expect(await draft(office(), second.userId, null, { partyId: second.partyId })).toBe(1)
    expect(await sql(partner(second.partyId, second.userId), `SELECT id FROM "ComposerDraft" WHERE "partyId" = $1::uuid`, A.P1)).toEqual([])
    expect(await sql(p1, `SELECT id FROM "ComposerDraft" WHERE "userId" = $1::uuid`, second.userId)).toEqual([])
    expect(await sql(p1, `SELECT id FROM "ComposerDraft" WHERE id = $1::uuid`, later.ownerDraft)).toEqual([])
    await expect(sql(floor(), `SELECT id FROM "ComposerDraft" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it("Done and production's answer are the office's: hidden from the portal", async () => {
    await expect(sql(partner(A.P1), `SELECT "doneAt" FROM "Thread" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(A.P1), `SELECT "doneById" FROM "Thread" LIMIT 1`)).rejects.toThrow(/permission denied/)
    for (const column of ['productionAnswer', 'productionNotBefore', 'productionAnsweredAt', 'productionAnsweredById']) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "Inquiry" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('pins (N4)', () => {
  it("carry the message's party, of their own thread, never a held mail, by an active office person, once, never changed", async () => {
    // The party is the message's, whatever the writer says.
    const id = randomUUID()
    expect(await insert(office(), 'ThreadPin', { id, threadId: A.quoteThread, messageId: A.quoteIn, partyId: second.partyId, key: `pin:${A.quoteThread}:${A.quoteIn}`, pinnedById: a.actorId, pinnedAt: new Date().toISOString() })).toBe(1)
    expect((await admin(`SELECT "partyId"::text AS party FROM "ThreadPin" WHERE id = $1::uuid`, [id]))[0]!.party).toBe(A.P1)
    // Once per message; never changed; unpinned by removal.
    await expect(pin(A.quoteThread, A.quoteIn)).rejects.toThrow(/unique|duplicate/)
    await expect(run(office(), `UPDATE "ThreadPin" SET "pinnedAt" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied|never changed/)
    expect(await run(office(), `DELETE FROM "ThreadPin" WHERE id = $1::uuid`, id)).toBe(1)
    // A message of another thread; a held mail; a portal person or someone invited; the key; a time to come.
    await expect(pin(A.quoteThread, A.companyNote)).rejects.toThrow(/foreign key/)
    await expect(pin(held.threadId, held.messageId)).rejects.toThrow(/undo window or taken back/)
    await expect(pin(A.quoteThread, A.quoteIn, { pinnedById: portal.userIds.p1Buyer })).rejects.toThrow(/by an active office person/)
    await expect(pin(A.quoteThread, A.quoteIn, { pinnedById: A.invited })).rejects.toThrow(/by an active office person/)
    await expect(pin(A.quoteThread, A.quoteIn, { key: `pin:${A.quoteThread}:other` })).rejects.toThrow(/pin:<threadId>:<messageId>/)
    await expect(pin(A.quoteThread, A.quoteIn, { pinnedAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow(/not in the future/)
  })
})

describe('drafts (N6)', () => {
  it('one per person and record, in shape, its person, party, record and key fixed', async () => {
    const quote = { type: 'Quote', id: A.quote }
    expect(await draft(office(), A.member, quote, { audience: 'OFFICE', fields: { to: ['buyer.p1@example.com'] } })).toBe(1)
    await expect(draft(office(), A.member, quote)).rejects.toThrow(/unique|duplicate/)
    // Each refusal below on a record of its own (one draft per person and record).
    const fresh = () => ({ type: 'Quote', id: randomUUID() })
    // An office person's draft names no party; the key; a record by type and id, both or neither.
    await expect(draft(office(), a.actorId, fresh(), { partyId: A.P1 })).rejects.toThrow(/an office person's \(no party\)/)
    await expect(draft(office(), a.actorId, fresh(), { key: `draft:Quote:${A.quote}:someone` })).rejects.toThrow(/the key of draft/)
    await expect(insert(office(), 'ComposerDraft', { id: randomUUID(), userId: A.member, recordType: 'Quote', recordId: null, key: `draft:new-request:${A.member}` })).rejects.toThrow(/both or neither/)
    // The text, the fields, the files.
    await expect(draft(office(), a.actorId, fresh(), { bodyText: 'x'.repeat(20_001) })).rejects.toThrow(/up to 20000 characters/)
    await expect(draft(office(), a.actorId, fresh(), { fields: ['not', 'an', 'object'] })).rejects.toThrow(/one JSON object up to 64 kB/)
    await expect(draft(office(), a.actorId, fresh(), { fields: { big: 'x'.repeat(70_000) } })).rejects.toThrow(/one JSON object up to 64 kB/)
    const file = randomUUID()
    await expect(draft(office(), a.actorId, fresh(), { attachmentFileIds: [file, file] })).rejects.toThrow(/at most 50 files, each once/)
    // Saved again: the text moves, the person and record never.
    expect(await run(office(), `UPDATE "ComposerDraft" SET "bodyText" = '', "updatedAt" = now() WHERE "userId" = $1::uuid AND "recordId" = $2::uuid`, A.member, A.quote)).toBe(1)
    await expect(run(office(), `UPDATE "ComposerDraft" SET "recordId" = $1::uuid WHERE "userId" = $2::uuid AND "recordId" = $3::uuid`, randomUUID(), A.member, A.quote)).rejects.toThrow(/never change/)
  })

  it("go with the person's erasure, and only theirs; a record the law keeps removes nothing", async () => {
    const buyer = await draftsOf(portal.userIds.p1Buyer)
    expect(buyer.length).toBeGreaterThan(0)
    const owner = await draftsOf(a.actorId)
    expect(owner.length).toBeGreaterThan(0)
    const erasure = (method: string, recordId: string, fields: Record<string, unknown>) =>
      insert(office(), 'ErasureRecord', { id: randomUUID(), companyId: A.companyA, dataRequestId: privacy.requestIds.contactErasure, recordType: 'User', recordId, method, erasedById: a.actorId, ...fields })
    expect(await erasure('KEPT', portal.userIds.p1Buyer, { keptWhy: 'Kept as the law requires (made up).' })).toBe(1)
    expect(await draftsOf(portal.userIds.p1Buyer)).toEqual(buyer)
    expect(await erasure('ANONYMISED', portal.userIds.p1Buyer, { erasedFields: ['displayName', 'email'] })).toBe(1)
    expect(await draftsOf(portal.userIds.p1Buyer)).toEqual([])
    expect(await draftsOf(a.actorId)).toEqual(owner)
  })
})

describe('Done (N18)', () => {
  it('both or neither, by an active office person, never on a new thread', async () => {
    const done = (set: string, ...values: unknown[]) => run(office(), `UPDATE "Thread" SET ${set} WHERE id = $${values.length + 1}::uuid`, ...values, A.companyThread)
    await expect(done(`"doneAt" = now()`)).rejects.toThrow(/both or neither/)
    await expect(done(`"doneAt" = now(), "doneById" = $1::uuid`, portal.userIds.p1Buyer)).rejects.toThrow(/by an active office person/)
    await expect(done(`"doneAt" = now() + interval '1 day', "doneById" = $1::uuid`, a.actorId)).rejects.toThrow(/not in the future/)
    expect(await done(`"doneAt" = now(), "doneById" = $1::uuid`, a.actorId)).toBe(1)
    expect(await done(`"doneAt" = NULL, "doneById" = NULL`)).toBe(1)
    await expect(
      insert(office(), 'Thread', { id: randomUUID(), companyId: A.companyA, recordType: 'Company', recordId: randomUUID(), replyToken: `seedth90${randomUUID().replace(/-/g, '').slice(0, 20)}`, doneAt: new Date().toISOString(), doneById: a.actorId }),
    ).rejects.toThrow(/open work, not done/)
  })
})

describe('WITHDRAWN (N20)', () => {
  const withdraw = (id: string, closedById: string | null, extra = '') =>
    run(office(), `UPDATE "Inquiry" SET status = 'WITHDRAWN', "closedAt" = now(), "closedById" = $1::uuid${extra} WHERE id = $2::uuid`, closedById, id)

  it('only from an open state, only by a portal person of its own customer, then final', async () => {
    const id = await request()
    await expect(withdraw(id, second.userId)).rejects.toThrow(/withdrawn by a portal person of its own customer/)
    await expect(withdraw(id, a.actorId)).rejects.toThrow(/withdrawn by a portal person of its own customer/)
    await expect(withdraw(id, null)).rejects.toThrow(/WITHDRAWN only by its customer, who is named/)
    await expect(withdraw(id, portal.userIds.p1Buyer, `, "closeNote" = 'Seed: words.'`)).rejects.toThrow(/says in words/)
    await expect(run(office(), `UPDATE "Inquiry" SET status = 'WITHDRAWN', "closedById" = $1::uuid WHERE id = $2::uuid`, portal.userIds.p1Buyer, id)).rejects.toThrow(/wrong closing time/)
    expect(await withdraw(id, portal.userIds.p1Buyer)).toBe(1)
    await expect(run(office(), `UPDATE "Inquiry" SET status = 'ASSIGNED', "closedAt" = NULL, "closedById" = NULL, "assigneeId" = $1::uuid, "assignedAt" = now() WHERE id = $2::uuid`, a.actorId, id)).rejects.toThrow(/WITHDRAWN are final/)
    // A prospect's request has no customer to withdraw it; a closed request is not withdrawn.
    const prospect = await request({ partyId: null, prospectName: 'Seed Prospect', prospectLawfulBasis: 'CONTRACT' })
    await expect(withdraw(prospect, portal.userIds.p1Buyer)).rejects.toThrow(/WITHDRAWN only by its customer/)
    const declined = await request()
    expect(await run(office(), `UPDATE "Inquiry" SET status = 'DECLINED', "declineReason" = 'CAPACITY', "closedAt" = now(), "closedById" = $1::uuid WHERE id = $2::uuid`, a.actorId, declined)).toBe(1)
    await expect(withdraw(declined, portal.userIds.p1Buyer)).rejects.toThrow(/cannot move from DECLINED to WITHDRAWN/)
  })
})

describe("production's answer (N17)", () => {
  // The next Monday after today, as a calendar day.
  const monday = (): string => {
    const day = new Date()
    day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7))
    return day.toISOString().slice(0, 10)
  }
  const answer = (id: string, set: string, ...values: unknown[]) => run(office(), `UPDATE "Inquiry" SET ${set} WHERE id = $${values.length + 1}::uuid`, ...values, id)

  it('all or none, NOT_BEFORE exactly with a Monday, by an active office person, only while open', async () => {
    const id = await request()
    await expect(answer(id, `"productionAnswer" = 'OK'`)).rejects.toThrow(/when and by whom, all or none/)
    await expect(answer(id, `"productionAnswer" = 'OK', "productionAnsweredAt" = now(), "productionAnsweredById" = $1::uuid, "productionNotBefore" = $2::date`, a.actorId, monday())).rejects.toThrow(/exactly when it says not before/)
    await expect(answer(id, `"productionAnswer" = 'NOT_BEFORE', "productionAnsweredAt" = now(), "productionAnsweredById" = $1::uuid`, a.actorId)).rejects.toThrow(/exactly when it says not before/)
    const tuesday = new Date(`${monday()}T00:00:00.000Z`)
    tuesday.setUTCDate(tuesday.getUTCDate() + 1)
    await expect(answer(id, `"productionAnswer" = 'NOT_BEFORE', "productionNotBefore" = $1::date, "productionAnsweredAt" = now(), "productionAnsweredById" = $2::uuid`, tuesday.toISOString().slice(0, 10), a.actorId)).rejects.toThrow(/by its Monday/)
    await expect(answer(id, `"productionAnswer" = 'OK', "productionAnsweredAt" = now(), "productionAnsweredById" = $1::uuid`, portal.userIds.p1Buyer)).rejects.toThrow(/by an active office person/)
    await expect(answer(id, `"productionAnswer" = 'OK', "productionAnsweredAt" = now() + interval '1 day', "productionAnsweredById" = $1::uuid`, a.actorId)).rejects.toThrow(/not in the future/)
    expect(await answer(id, `"productionAnswer" = 'NOT_BEFORE', "productionNotBefore" = $1::date, "productionAnsweredAt" = now(), "productionAnsweredById" = $2::uuid`, monday(), A.member)).toBe(1)
    expect(await answer(id, `"productionAnswer" = 'OK', "productionNotBefore" = NULL, "productionAnsweredAt" = now(), "productionAnsweredById" = $1::uuid`, a.actorId)).toBe(1)
    // Closed: the answer stays as it was.
    expect(await answer(id, `status = 'LOST', "closeNote" = 'Seed: the customer went away.', "closedAt" = now()`)).toBe(1)
    await expect(answer(id, `"productionAnswer" = NULL, "productionAnsweredAt" = NULL, "productionAnsweredById" = NULL`)).rejects.toThrow(/never changes/)
  })
})
