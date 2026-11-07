import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalFrame, type PortalFrameSeed } from '../seed/portal-frame'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The portal frame (W2b schema wave 20/22, B-W2b-156, …_portal_frame_w2b_guards) on a database built from the migrations
 * and seeded, through the real login and the scoped client:
 *   - grants: a portal session reads its own party's tasks, notifications and e-mail settings, never another party's,
 *     never who in the office asked or caused one; it marks its open task done, saves its people's settings and posts
 *     in its party's threads; the floor reads none of it;
 *   - partner tasks: born OPEN, one per record, kind and source; who asked both or neither; closed exactly with a time;
 *     done by an active person of the party; the partner only closes an open task as DONE; reopened, never deleted;
 *   - e-mail settings: a partner user of the row's own party; only how often changes; never deleted;
 *   - notifications: the party of a partner user's notification, none for an office person's; kept once written; a
 *     summary mail (EMAIL_DIGEST) names its mail;
 *   - portal posts: INBOUND, PARTNER, PORTAL, PARTY with the person's name, not a mail, attaching only available files of
 *     the record shared with the party; no author id, mention or floor note; the office writes as before.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-156-a'
const DENIED = /permission denied/
const RLS = /row-level security/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalFrameSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: key('worker:A1:operator'), siteId: key('site:A1') })
/** A portal session of the buyer (P1) or the order desk (P2); a link session has the link as its actor. */
const portal = (partyId: string = P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: partyId === P1 ? seeded.buyerId : seeded.orderDeskId, partyId })
const link = (partyId: string = P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** A row of `table` as the owner reads it, as JSON. */
async function rowOf(table: string, id: string): Promise<Record<string, unknown>> {
  const [row] = await admin(`SELECT to_jsonb(r) AS row FROM "${table}" r WHERE r.id = $1::uuid`, [id])
  expect(row, `${table} ${id}`).toBeDefined()
  return row!.row as Record<string, unknown>
}
/** INSERT, as `scope`, a copy of row `id` of `table` with `changes`, naming only `columns` (all but `without`). */
async function copyAs(scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>, without: readonly string[] = []): Promise<number> {
  const row = { ...(await rowOf(table, id)), ...changes }
  const columns = Object.keys(row).filter((column) => !without.includes(column)).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** Runs `text` as the owner with the triggers off: to put a row in a state the guards refuse to reach. */
async function bypass(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}

/** A new OPEN task of P1, made by the office from the seed's first one with `changes`. */
async function newTask(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyAs(office(), 'PartnerTask', seeded.tasks.acceptQuote, { id, sourceKey: `Test:${id}`, ...changes })
  return id
}
/** The partner's own columns of a message (its grant leaves out the author id, the mentions and the floor flag). */
const NOT_THE_PARTNERS = ['authorId', 'mentionedUserIds', 'forFloor']
/** A portal post of the buyer, made from the seed's post with `changes`. */
const post = (changes: Record<string, unknown> = {}, scope: FactoryScope = portal()) =>
  copyAs(scope, 'Message', seeded.postId, { id: randomUUID(), bodyText: 'Test portal post.', ...changes }, NOT_THE_PARTNERS)
/** A file of the quote shared with P1, made from the seed's sketch with `changes`. */
async function newFile(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyAs(office(), 'StoredFile', seeded.postFileId, { id, storageKey: `t/test/${id}`, ...changes })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('portalframew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedPortalFrame({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the two models (office and partner, no floor, no personal-data map) and the partner grants on notifications and messages', () => {
    const ownership = loadOwnership()
    const all = classifiedModels(loadSchema(), ownership)
    const models = all.filter(({ model }) => model.file === 'portal-frame.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['PartnerEmailPreference', 'PartnerTask'])
    for (const { model, ownership: entry } of models) {
      expect(Object.keys(entry.access).sort(), model.name).toEqual(['factory_partner_runtime', 'factory_runtime'])
      expect(entry.keyColumns, model.name).toEqual({ tenant: 'tenantId', party: 'partyId' })
    }
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => entry.model.startsWith('Partner'))).toEqual([])
    const access = (name: string) => all.find(({ model }) => model.name === name)!.ownership.access
    expect(access('PartnerTask').factory_partner_runtime).toEqual({ privileges: ['select', 'update'], scopedBy: ['party'], hiddenColumns: ['askedById'] })
    expect(access('Notification').factory_partner_runtime).toEqual({ privileges: ['select'], scopedBy: ['party'], hiddenColumns: ['actorId'] })
    expect(access('Message').factory_partner_runtime).toEqual({ privileges: ['select', 'insert'], scopedBy: ['party'], hiddenColumns: NOT_THE_PARTNERS })
    for (const name of ['NotificationDelivery', 'RecordFollower', 'MessageMention', 'Task']) expect(Object.keys(access(name)), name).toEqual(['factory_runtime'])
    expect(access('Thread').factory_partner_runtime!.privileges).toEqual(['select'])
  })

  it('the seed: five tasks, the buyer’s post with the sketch, three notifications, six e-mail settings', async () => {
    const tasks = await sql(office(), `SELECT kind::text, status::text, "partyId"::text AS party, "doneById"::text AS done, "remindedAt" IS NOT NULL AS reminded FROM "PartnerTask" ORDER BY kind::text`)
    expect(tasks).toEqual([
      { kind: 'ACCEPT_QUOTE', status: 'OPEN', party: P1, done: null, reminded: false },
      { kind: 'ANSWER_MESSAGE', status: 'DONE', party: P1, done: seeded.buyerId, reminded: false },
      { kind: 'APPROVE', status: 'OPEN', party: P1, done: null, reminded: true },
      { kind: 'CONFIRM_PO', status: 'OPEN', party: P2, done: null, reminded: false },
      { kind: 'UPLOAD_DOCUMENT', status: 'CANCELLED', party: P2, done: null, reminded: false },
    ])
    expect(await sql(office(), `SELECT direction::text, audience::text, channel::text, "authorKind"::text AS author, "authorId", "attachmentFileIds"::text[] AS files FROM "Message" WHERE id = $1::uuid`, seeded.postId)).toEqual([
      { direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', author: 'PARTY', authorId: null, files: [seeded.postFileId] },
    ])
    expect(await sql(office(), `SELECT "partyId"::text AS party FROM "Notification" WHERE id = ANY($1::uuid[]) ORDER BY "partyId", id`, Object.values(seeded.notifications))).toHaveLength(3)
    expect(await sql(office(), `SELECT channel::text FROM "NotificationDelivery" WHERE id = ANY($1::uuid[]) ORDER BY channel::text`, Object.values(seeded.deliveries))).toEqual([{ channel: 'EMAIL' }, { channel: 'EMAIL_DIGEST' }])
    expect(await sql(office(), `SELECT topic::text, frequency::text, version FROM "PartnerEmailPreference" WHERE "userId" = $1::uuid ORDER BY topic::text`, seeded.buyerId)).toEqual([
      { topic: 'DATES', frequency: 'DAILY', version: 1 },
      { topic: 'DOCUMENTS', frequency: 'WEEKLY', version: 2 },
      { topic: 'MESSAGES', frequency: 'INSTANT', version: 1 },
      { topic: 'REMINDERS', frequency: 'WEEKLY', version: 1 },
    ])
    // An office person's notifications carry no party.
    expect(await sql(office(), `SELECT count(*)::int AS n FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.audience = 'OFFICE' AND n."partyId" IS NOT NULL`)).toEqual([{ n: 0 }])
  })

  it('a portal session reads its own party only, never who in the office asked or caused one; the floor reads none', async () => {
    expect((await sql(portal(), 'SELECT id FROM "PartnerTask"')).length).toBe(3)
    expect((await sql(portal(P2), 'SELECT id FROM "PartnerTask"')).length).toBe(2)
    expect((await sql(portal(), 'SELECT "askedByName" FROM "PartnerTask" WHERE id = $1::uuid', seeded.tasks.acceptQuote))[0]).toEqual({ askedByName: 'Seed Owner' })
    await expect(sql(portal(), 'SELECT "askedById" FROM "PartnerTask"')).rejects.toThrow(DENIED)
    expect((await sql(portal(), 'SELECT id FROM "Notification"')).map((row) => row.id).sort()).toEqual([seeded.notifications.sample, seeded.notifications.shipped].sort())
    expect(await sql(portal(P2), 'SELECT id FROM "Notification"')).toEqual([{ id: seeded.notifications.po }])
    await expect(sql(portal(), 'SELECT "actorId" FROM "Notification"')).rejects.toThrow(DENIED)
    await expect(sql(portal(), 'SELECT id FROM "NotificationDelivery"')).rejects.toThrow(DENIED)
    expect((await sql(portal(), 'SELECT id FROM "PartnerEmailPreference"')).length).toBe(4)
    expect((await sql(portal(P2), 'SELECT id FROM "PartnerEmailPreference"')).length).toBe(2)
    for (const table of ['PartnerTask', 'PartnerEmailPreference', 'Notification']) await expect(sql(floor(), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    // Read, done and snooze of a portal notification are the API's, in the tenant's system scope.
    await expect(update(portal(), 'Notification', seeded.notifications.sample, '"readAt" = now()')).rejects.toThrow(DENIED)
    await expect(run(portal(), 'DELETE FROM "PartnerTask" WHERE false')).rejects.toThrow(DENIED)
    await expect(run(portal(), 'INSERT INTO "PartnerTask" (id) VALUES (NULL)')).rejects.toThrow(DENIED)
  })
})

describe('partner tasks (COL-043)', () => {
  it('born OPEN, one per record, kind and source; its record and source named; who asked both or neither', async () => {
    expect(await newTask()).toBeTruthy()
    await expect(newTask({ status: 'DONE', closedAt: '2026-11-04T10:00:00Z' })).rejects.toThrow(/a new partner task .* is OPEN/)
    await expect(newTask({ remindedAt: '2026-11-04T10:00:00Z' })).rejects.toThrow(/a new partner task .* is OPEN/)
    await expect(newTask({ version: 2 })).rejects.toThrow(/a new partner task .* is OPEN/)
    await expect(copyAs(office(), 'PartnerTask', seeded.tasks.acceptQuote, { id: randomUUID() })).rejects.toThrow(/PartnerTask_tenantId_recordType_recordId_kind_sourceKey_key/)
    await expect(newTask({ sourceKey: 'two words' })).rejects.toThrow(/in one word/)
    await expect(newTask({ sourceKey: 'x'.repeat(201) })).rejects.toThrow(/in one word/)
    await expect(newTask({ recordLabel: ' ' })).rejects.toThrow(/names its record/)
    await expect(newTask({ askedByName: null })).rejects.toThrow(/asked by a person/)
    await expect(newTask({ askedById: null })).rejects.toThrow(/asked by a person/)
    expect(await newTask({ askedById: null, askedByName: null })).toBeTruthy()
    await expect(newTask({ partyId: randomUUID() })).rejects.toThrow(/PartnerTask_tenantId_partyId_fkey/)
  })

  it('a portal session marks its open task done, with its person; a link session with none; nothing else', async () => {
    const task = await newTask()
    const done = `status = 'DONE', "closedAt" = now(), "doneById" = $2::uuid, version = version + 1`
    // Another party's task is not even seen.
    expect(await update(portal(P2), 'PartnerTask', task, done, seeded.orderDeskId)).toBe(0)
    await expect(update(portal(), 'PartnerTask', task, `"dueAt" = now() + interval '9 days'`)).rejects.toThrow(/only marks its open task .* done/)
    await expect(update(portal(), 'PartnerTask', task, `status = 'CANCELLED', "closedAt" = now(), version = version + 1`)).rejects.toThrow(/only marks its open task .* done/)
    await expect(update(portal(), 'PartnerTask', task, `${done}, "remindedAt" = now()`, seeded.buyerId)).rejects.toThrow(/only marks its open task .* done/)
    await expect(update(portal(), 'PartnerTask', task, `status = 'DONE', version = version + 1`)).rejects.toThrow(/wrong closing/)
    // Done by a person of another partner, an office person, a person not ACTIVE: refused.
    await expect(update(office(), 'PartnerTask', task, done, seeded.orderDeskId)).rejects.toThrow(/done by an active person of its own partner/)
    await expect(update(office(), 'PartnerTask', task, done, a.actorId)).rejects.toThrow(/done by an active person of its own partner/)
    await expect(update(office(), 'PartnerTask', task, done, key('portal:user:P1:viewer'))).rejects.toThrow(/done by an active person of its own partner/)
    // A portal session cannot see an office person: naming one is refused, not skipped.
    await expect(update(portal(), 'PartnerTask', task, done, a.actorId)).rejects.toThrow(/done by an active person of its own partner/)
    expect(await update(portal(), 'PartnerTask', task, done, seeded.buyerId)).toBe(1)
    expect(await sql(portal(), 'SELECT status::text, "doneById"::text AS done, version FROM "PartnerTask" WHERE id = $1::uuid', task)).toEqual([{ status: 'DONE', done: seeded.buyerId, version: 2 }])
    // Reopening is the office's.
    await expect(update(portal(), 'PartnerTask', task, `status = 'OPEN', "closedAt" = NULL, "doneById" = NULL, version = version + 1`)).rejects.toThrow(/only marks its open task .* done/)
    // A link session (a PO_CONFIRM or APPROVAL link answering) closes it with no person.
    const byLink = await newTask()
    expect(await update(link(), 'PartnerTask', byLink, `status = 'DONE', "closedAt" = now(), version = version + 1`)).toBe(1)
    // A no-op passes; RLS keeps the task in its party.
    expect(await update(portal(), 'PartnerTask', byLink, '"companyId" = "companyId"')).toBe(1)
    await expect(update(portal(), 'PartnerTask', byLink, '"partyId" = $2::uuid', P2)).rejects.toThrow(RLS)
  })

  it('the office reopens, cancels, reminds and moves the due time; a closed task changes only by reopening; never deleted', async () => {
    const task = await newTask()
    await expect(update(office(), 'PartnerTask', task, `"sourceKey" = 'Other:1'`)).rejects.toThrow(/keeps its company, partner, kind, record, source and who asked/)
    await expect(update(office(), 'PartnerTask', task, `"recordLabel" = 'SEED-QT-9999'`)).rejects.toThrow(/keeps its company/)
    await expect(update(office(), 'PartnerTask', task, `"askedByName" = 'Someone Else'`)).rejects.toThrow(/keeps its company/)
    await expect(update(office(), 'PartnerTask', task, `"partyId" = $2::uuid`, P2)).rejects.toThrow(/keeps its company/)
    await expect(update(office(), 'PartnerTask', task, 'version = version + 2')).rejects.toThrow(/goes up by one/)
    expect(await update(office(), 'PartnerTask', task, `"dueAt" = now() + interval '3 days', "remindedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'PartnerTask', task, `"remindedAt" = "remindedAt" - interval '1 hour', version = version + 1`)).rejects.toThrow(/only moves later/)
    await expect(update(office(), 'PartnerTask', task, `"remindedAt" = NULL, version = version + 1`)).rejects.toThrow(/only moves later/)
    await expect(update(office(), 'PartnerTask', task, `status = 'CANCELLED', version = version + 1`)).rejects.toThrow(/wrong closing/)
    await expect(update(office(), 'PartnerTask', task, `status = 'CANCELLED', "closedAt" = now(), "doneById" = $2::uuid, version = version + 1`, seeded.buyerId)).rejects.toThrow(/wrong closing/)
    expect(await update(office(), 'PartnerTask', task, `status = 'CANCELLED', "closedAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'PartnerTask', task, `"dueAt" = now() + interval '5 days', version = version + 1`)).rejects.toThrow(/is CANCELLED; it changes only by being reopened/)
    await expect(update(office(), 'PartnerTask', task, `status = 'DONE', version = version + 1`)).rejects.toThrow(/changes only by being reopened/)
    await expect(update(office(), 'PartnerTask', task, `status = 'OPEN', version = version + 1`)).rejects.toThrow(/wrong closing/)
    expect(await update(office(), 'PartnerTask', task, `status = 'OPEN', "closedAt" = NULL, version = version + 1`)).toBe(1)
    await expect(admin('DELETE FROM "PartnerTask" WHERE id = $1::uuid', [task])).rejects.toThrow(/cancelled, never deleted/)
    await expect(admin('TRUNCATE "PartnerTask"')).rejects.toThrow(/TRUNCATE on "PartnerTask" is refused/)
    await expect(run(office(), 'DELETE FROM "PartnerTask" WHERE false')).rejects.toThrow(DENIED)
  })
})

describe('e-mail settings of partner users (COL-063, PLT-148)', () => {
  const setting = (changes: Record<string, unknown>, scope: FactoryScope = portal()) => copyAs(scope, 'PartnerEmailPreference', seeded.preferences[0]!, { id: randomUUID(), topic: 'CLAIMS', frequency: 'INSTANT', version: 1, ...changes })

  it('a portal session saves its people’s settings; never a person of another party or an office person’s', async () => {
    expect(await setting({})).toBe(1)
    await expect(setting({ userId: seeded.orderDeskId })).rejects.toThrow(/of a partner user of its own partner/)
    await expect(setting({ userId: a.actorId })).rejects.toThrow(/of a partner user of its own partner/)
    await expect(setting({ partyId: P2 })).rejects.toThrow(RLS)
    // The office (the unsubscribe link) writes them too, held to the same rule.
    expect(await setting({ topic: 'SHIPPED', frequency: 'OFF' }, office())).toBe(1)
    await expect(setting({ partyId: P2 }, office())).rejects.toThrow(/of a partner user of its own partner/)
  })

  it('only how often changes; the version goes up by one; never deleted', async () => {
    const row = seeded.preferences[1]!
    expect(await update(portal(), 'PartnerEmailPreference', row, `frequency = 'DAILY', version = version + 1`)).toBe(1)
    await expect(update(portal(), 'PartnerEmailPreference', row, `topic = 'ORDERS', version = version + 1`)).rejects.toThrow(/keeps its person, partner and topic/)
    await expect(update(office(), 'PartnerEmailPreference', row, `"userId" = $2::uuid, version = version + 1`, key('portal:user:P1:viewer'))).rejects.toThrow(/keeps its person/)
    await expect(update(portal(), 'PartnerEmailPreference', row, `frequency = 'OFF', version = version + 3`)).rejects.toThrow(/goes up by one/)
    expect(await update(portal(P2), 'PartnerEmailPreference', row, `frequency = 'OFF', version = version + 1`)).toBe(0)
    await expect(run(portal(), 'DELETE FROM "PartnerEmailPreference" WHERE id = $1::uuid', row)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "PartnerEmailPreference" WHERE id = $1::uuid', [row])).rejects.toThrow(/changed, never deleted/)
    await expect(admin('TRUNCATE "PartnerEmailPreference"')).rejects.toThrow(/TRUNCATE on "PartnerEmailPreference" is refused/)
  })
})

describe('notifications for partner users (PLT-148)', () => {
  const notify = (changes: Record<string, unknown>) =>
    copyAs(office(), 'Notification', seeded.notifications.sample, { id: randomUUID(), eventId: randomUUID(), readAt: null, version: 1, ...changes })

  it('a partner user’s notification carries the person’s party, an office person’s none; kept once written', async () => {
    expect(await notify({})).toBe(1)
    await expect(notify({ partyId: null })).rejects.toThrow(/names its person's party exactly when the person is a partner user/)
    await expect(notify({ partyId: P2 })).rejects.toThrow(/names its person's party/)
    await expect(notify({ userId: a.actorId })).rejects.toThrow(/names its person's party/)
    expect(await notify({ userId: a.actorId, partyId: null })).toBe(1)
    await expect(update(office(), 'Notification', seeded.notifications.sample, '"partyId" = $2::uuid', P2)).rejects.toThrow(/keeps what it says/)
    expect(await update(office(), 'Notification', seeded.notifications.sample, '"readAt" = now(), version = version + 1')).toBe(1)
  })

  it('a delivery in a summary mail (EMAIL_DIGEST) names its mail when sent, as an e-mail does', async () => {
    const deliver = (changes: Record<string, unknown>) => copyAs(office(), 'NotificationDelivery', seeded.deliveries.shipped, { id: randomUUID(), ...changes })
    expect(await deliver({})).toBe(1)
    await expect(deliver({ emailOutboundId: null })).rejects.toThrow(/an e-mail or a summary mail sent .* names its mail/)
    await expect(deliver({ outcome: 'SKIPPED', detail: 'The person chose a weekly summary.' })).rejects.toThrow(/names its mail, and nothing else names one/)
    expect(await deliver({ outcome: 'SKIPPED', emailOutboundId: null, detail: 'The person chose a weekly summary.' })).toBe(1)
    await expect(deliver({ outcome: 'FAILED', emailOutboundId: null, detail: ' ' })).rejects.toThrow(/says why/)
    // W2a's e-mail rule holds as before.
    expect(await deliver({ channel: 'EMAIL' })).toBe(1)
    await expect(deliver({ channel: 'PUSH' })).rejects.toThrow(/names its mail/)
  })
})

describe('portal posts in a record thread (COL-060)', () => {
  it('a portal session posts INBOUND, PARTNER, PORTAL, PARTY with the person’s name, attaching a file of the record shared with it', async () => {
    expect(await post()).toBe(1)
    expect(await post({ attachmentFileIds: [] })).toBe(1)
    const shared = await newFile()
    expect(await post({ attachmentFileIds: [shared, seeded.postFileId] })).toBe(1)
    await expect(post({ direction: 'OUTBOUND' })).rejects.toThrow(/posts only its party's own message from the portal/)
    await expect(post({ channel: 'EMAIL' })).rejects.toThrow(/posts only its party's own message from the portal/)
    await expect(post({ channel: 'APP' })).rejects.toThrow(/posts only its party's own message from the portal/)
    await expect(post({ authorKind: 'SYSTEM' })).rejects.toThrow(/posts only its party's own message from the portal/)
    await expect(post({ authorName: ' ' })).rejects.toThrow(/names the person who wrote it/)
    await expect(post({ authorName: null })).rejects.toThrow(/names the person who wrote it/)
    await expect(post({ emailMessageId: `<test-${randomUUID()}@example.com>` })).rejects.toThrow(/is not a mail/)
  })

  it('never a file the party may not see, of another record, or not available; never another party’s thread or an internal note', async () => {
    const officeOnly = await newFile({ visibility: ['OFFICE'], partyId: null })
    await expect(post({ attachmentFileIds: [officeOnly] })).rejects.toThrow(/attaches only available files of its record that are shared with its party/)
    const otherRecord = await newFile({ recordType: 'SalesOrder', recordId: key('sales:SO1') })
    await expect(post({ attachmentFileIds: [otherRecord] })).rejects.toThrow(/attaches only available files/)
    const pending = await newFile({ status: 'PENDING_UPLOAD', availableAt: null })
    await expect(post({ attachmentFileIds: [pending] })).rejects.toThrow(/attaches only available files/)
    await expect(post({ attachmentFileIds: [randomUUID()] })).rejects.toThrow(/attaches only available files/)
    // The supplier's session: its own party's thread only (the quote's is P1's), and only its own files.
    await expect(post({ partyId: P2, attachmentFileIds: [] }, portal(P2))).rejects.toThrow(/Message_tenantId_threadId_partyId_fkey/)
    await expect(post({ partyId: P2 }, portal(P2))).rejects.toThrow(/attaches only available files/)
    await expect(post({}, portal(P2))).rejects.toThrow(RLS)
    await expect(post({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', partyId: null })).rejects.toThrow(RLS)
    // No author id, no mention, no floor note: the partner role has no column for them.
    await expect(copyAs(portal(), 'Message', seeded.postId, { id: randomUUID() })).rejects.toThrow(DENIED)
    await expect(run(portal(), 'UPDATE "Message" SET "bodyText" = "bodyText" WHERE false')).rejects.toThrow(DENIED)
  })

  it('the office writes as before: an outbound mail by a person, attaching an office file of the record', async () => {
    const officeOnly = await newFile({ visibility: ['OFFICE'], partyId: null })
    const outbound = await rowOf('Message', key('threads:message:quote-out'))
    expect(outbound).toMatchObject({ direction: 'OUTBOUND', authorKind: 'USER' })
    expect(await copyAs(office(), 'Message', key('threads:message:quote-out'), { id: randomUUID(), emailMessageId: `<test-${randomUUID()}@example.com>`, attachmentFileIds: [officeOnly] })).toBe(1)
    // And it may copy a portal post (the email-in step's and the fan-out's tests): the partner rule is the partner's.
    expect(await copyAs(office(), 'Message', seeded.postId, { id: randomUUID(), attachmentFileIds: [officeOnly] })).toBe(1)
  })
})

describe('the guards’ reads', () => {
  it('a guard reads only what its role may see: a file of the record shared with another party is refused', async () => {
    const file = await newFile()
    await bypass('UPDATE "StoredFile" SET "partyId" = $2::uuid WHERE id = $1::uuid', [file, P2])
    await expect(post({ attachmentFileIds: [file] })).rejects.toThrow(/attaches only available files/)
  })
})
