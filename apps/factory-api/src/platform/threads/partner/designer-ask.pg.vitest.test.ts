import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { DESIGNER_ASKS_PER_DAY, designerAskAuthor, designerAskWords } from '@nexus/factory-domain/threads/designer/rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor, command } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard } from '../../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
import { fanOut } from '../../notifications/fan-out'
import { systemContext } from '../../outbox/system'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../search/partner/testing/world'
import { ensureThread, postNote, writeMessage } from '../threads'

/**
 * B-CP-079 (customer page plan C7, D12; 12 §5; review B6, C4, F4; lead pick B6; wall W-CP-6) on the local stack with every base seed
 * and the real portal sign-in by code: customer A = the seed's P1 (its buyer; its sent request SEED-RQ-0001), customer B = the seed's
 * P3 (a buyer of its own, a draft of its own). Office people with real roles: Giulia reads and writes every customer's threads (the
 * factory designer of A, later of B too), Marta only A's (A's backup).
 *
 *   - asked: the customer's message is posted as always, then ONE office-only note "<customer> … asks the factory designer: «first 80
 *     characters…»" mentions Giulia and Marta (mention rows, MENTIONED follows), `thread.factory_designer_asked` with ids only; the
 *     answer says "We asked Giulia Verdi."; the bell names who asks and the record, never the excerpt; the customer never reads the
 *     note; a repeated Idempotency-Key writes no second note;
 *   - held BEFORE the post (409 in words, nothing written): no factory designer named for the customer; nobody of the slot reads that
 *     thread;
 *   - the cap: after DESIGNER_ASKS_PER_DAY asks of a customer in 24 hours the next message is posted WITHOUT the ask, and says so;
 *   - W-CP-6: Giulia serving A and B — an ask on A writes the note on A's thread only; B's people get no news of it; her note in B's
 *     thread cannot attach A's file.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/partner/designer-ask`.
 */

type Json = Record<string, any>
let h: Harness
let world: PartnerWorld
let buyerA: Browser
let buyerB: Browser
const NS = 'cp079'
const P3 = seedUuid(NS, 'party:P3')
const betaBuyer: Person = { id: newId(), email: `berta.buyer.${NS}@brand-beta.example`, name: 'Made-up Berta Buyer' }
const giulia = { id: newId(), name: 'Made-up Giulia Verdi' }
const marta = { id: newId(), name: 'Made-up Marta Bianchi' }
let sent = ''
let betaDraft = ''
let customerA = ''
let serial = 0

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const requestId = async (where: string, values: unknown[]): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND ${where} ORDER BY id LIMIT 1`, [world.tenantId, ...values]))[0]!.id
const post = (browser: Browser, id: string, body: string, ask = true, key = `cp079-key-${++serial}`) =>
  browser.send('POST', `/portal/threads/PortalOrderRequest/${id}/messages`, { body, ...(ask ? { askFactoryDesigner: true } : {}) }, { headers: { 'idempotency-key': key } })
const notesOn = (recordId: string) =>
  admin<Json>(`SELECT m.id, m."bodyText", m.audience::text AS audience, m."authorKind"::text AS "authorKind", m."authorName", m."mentionedUserIds" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m."authorKind" = 'SYSTEM' ORDER BY m.at, m.id`, [recordId])
const messagesOn = async (recordId: string) => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1`, [recordId]))[0]!.n
const slot = (partyId: string, designerId: string | null, backupId: string | null) =>
  inTenant(h, world, (client) => client.portalSettings.update({ where: { id: partyId }, data: { factoryDesignerId: designerId, factoryDesignerSetAt: designerId ? new Date() : null, factoryDesignerBackupId: backupId }, select: { id: true } }))

/** The worker's fan-out of the office's thread events since a mark (oldest first). */
async function fanOutSince(mark: Date): Promise<void> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type IN ('thread.user_mentioned', 'thread.message_posted') AND "occurredAt" >= $2 ORDER BY "occurredAt", id`, [world.tenantId, mark])
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    await fanOut(callerFor(h.database, systemContext(world.tenantId, `cp079-${row.id}`)), envelope)
  }
}

beforeAll(async () => {
  h = await startHarness('cp079_designer_ask')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  await inTenant(h, world, async (client) => {
    // Customer B: the seed's second customer, its portal on, one buyer who may write.
    await client.portalSettings.upsert({ where: { id: P3 }, create: { id: P3, partyId: P3, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id: betaBuyer.id, email: betaBuyer.email, displayName: betaBuyer.name, status: 'ACTIVE', audience: 'PARTNER', partyId: P3, partnerKind: 'CUSTOMER', locale: 'en' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment']) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: world.tenantId, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: betaBuyer.id, roleId: role.id, allCompanies: true, partyIds: [P3], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
    // The office people, with real roles (the ask reads their live grants).
    const permissions = ['threads.read', 'threads.post', 'orders.view', 'files.read', 'parties.view']
    for (const [person, parties] of [[giulia, []], [marta, [world.p1]]] as const) {
      const roleId = newId()
      // A UUIDv7 starts with its clock: two ids made in the same minute share their first characters, so the random tail names them.
      await client.user.create({ data: { id: person.id, email: `${person.id.slice(-12)}.${NS}@example.com`, displayName: person.name, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
      await client.role.create({ data: { id: roleId, key: `t-${NS}-${person.id.slice(-12)}`, name: 'T designer (made up)', audience: 'OFFICE', permissions, grains: [] }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: person.id, roleId, allCompanies: true, partyIds: [...parties], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  buyerA = await signIn(h, world, world.people.buyer)
  buyerB = await signIn(h, world, betaBuyer)
  sent = await requestId('number = $2', ['SEED-RQ-0001'])
  const party = (await admin<{ tradeName: string | null; legalName: string }>('SELECT "tradeName", "legalName" FROM "Party" WHERE id = $1', [world.p1]))[0]!
  customerA = party.tradeName ?? party.legalName
  const made = await buyerB.send('POST', '/portal/order-requests', {}, { headers: { 'idempotency-key': `cp079-key-${++serial}` } })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  betaDraft = made.body.request.id
  await slot(world.p1, giulia.id, marta.id)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-CP-079: "Ask the factory designer" from a portal thread', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('asked: the message as always, then ONE office-only note mentioning the designer and the backup; the bell without the excerpt', async () => {
    const mark = new Date(Date.now() - 1_000)
    const long = 'Made-up: can the logo on the left sleeve be 8 cm wide instead of 6, and the stripes in a darker red than the sample?'
    const key = `cp079-key-${++serial}`
    const asked = await post(buyerA, sent, long, true, key)
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    expect(asked.body.designerAsk).toEqual({ asked: true, name: giulia.name, words: designerAskWords('ASKED', 'en', giulia.name) })
    const [note, ...more] = await notesOn(sent)
    expect(more).toEqual([])
    expect(note).toMatchObject({ audience: 'OFFICE', authorKind: 'SYSTEM', authorName: designerAskAuthor(customerA) })
    expect(note!.mentionedUserIds.sort()).toEqual([giulia.id, marta.id].sort())
    // The first 80 characters only (review B6), cut with "…".
    expect(note!.bodyText).toContain(`«${[...long].slice(0, 80).join('').trimEnd()}…»`)
    expect(note!.bodyText).not.toContain('darker red than the sample')
    const mentions = await admin<{ userId: string }>('SELECT "userId" FROM "MessageMention" WHERE "messageId" = $1 ORDER BY "userId"', [note!.id])
    expect(mentions.map((row) => row.userId)).toEqual([giulia.id, marta.id].sort())
    const follows = await admin<{ userId: string; reason: string }>(`SELECT "userId", reason::text AS reason FROM "RecordFollower" WHERE "recordType" = 'PortalOrderRequest' AND "recordId" = $1 AND "userId" = ANY($2::uuid[])`, [sent, [giulia.id, marta.id]])
    expect(follows.map((row) => row.reason)).toEqual(['MENTIONED', 'MENTIONED'])
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.factory_designer_asked' AND subject = $2`, [world.tenantId, sent])
    expect(event!.payload).toEqual({ threadId: expect.any(String), messageId: asked.body.message.id, noteId: note!.id, recordType: 'PortalOrderRequest', recordId: sent })
    // The urgent MENTION bell names who asks and the record — never the note's words.
    await fanOutSince(mark)
    const bells = await admin<Json>(`SELECT "userId", category::text AS category, "messageKey", params FROM "Notification" WHERE "tenantId" = $1 AND "recordId" = $2 AND category = 'MENTION'`, [world.tenantId, sent])
    expect(bells.map((row) => row.userId).sort()).toEqual([giulia.id, marta.id].sort())
    for (const bell of bells) {
      expect(bell).toMatchObject({ messageKey: 'notifications.designerAsked', params: expect.objectContaining({ customer: customerA }) })
      expect(JSON.stringify(bell)).not.toMatch(/left sleeve|8 cm/)
    }
    // The customer reads its own message, never the note; the same key again writes nothing more.
    const thread = await buyerA.get(`/portal/threads/PortalOrderRequest/${sent}`)
    expect(JSON.stringify(thread.body)).not.toMatch(/asks the factory designer|\(portal\)/)
    expect((await post(buyerA, sent, long, true, key)).status).toBe(201)
    expect(await notesOn(sent)).toHaveLength(1)
  })

  it('held before the post, in words, nothing written: no factory designer named; nobody of the slot reads the thread', async () => {
    const before = await messagesOn(betaDraft)
    const none = await post(buyerB, betaDraft, 'Made-up: who can help with our logo?')
    expect(none.status).toBe(409)
    expect(none.body.error.issues).toEqual([{ path: 'refusal/DESIGNER_NO_DESIGNER', message: designerAskWords('NO_DESIGNER', 'en') }])
    // B's designer is Marta, who reads A's threads only: she cannot be asked on B's draft.
    await slot(P3, marta.id, null)
    const notHere = await post(buyerB, betaDraft, 'Made-up: who can help with our logo?')
    expect(notHere.status).toBe(409)
    expect(notHere.body.error.issues).toEqual([{ path: 'refusal/DESIGNER_NOT_HERE', message: designerAskWords('NOT_HERE', 'en') }])
    expect(await messagesOn(betaDraft)).toBe(before)
    // Without the ask the same message goes as always.
    expect((await post(buyerB, betaDraft, 'Made-up: who can help with our logo?', false)).status).toBe(201)
  })

  it(`the cap: after ${DESIGNER_ASKS_PER_DAY} asks of a customer in 24 hours the next message goes WITHOUT the ask, and says so`, async () => {
    const already = (await notesOn(sent)).length
    // The customer's earlier asks today, as their notes (authored by its portal), on its own record's thread.
    await command(callerFor(h.database, systemContext(world.tenantId, `cp079-plant-${newId()}`)), { name: 'test.plantAsks', input: { sent } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'PortalOrderRequest', id: sent }, null)
      for (let index = already; index < DESIGNER_ASKS_PER_DAY; index += 1) {
        await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: designerAskAuthor(customerA) }, bodyText: `Made-up earlier ask ${index + 1}` })
      }
      return null
    })
    const capped = await post(buyerA, sent, 'Made-up: one more question for the designer.')
    expect(capped.status, JSON.stringify(capped.body)).toBe(201)
    expect(capped.body.designerAsk).toEqual({ asked: false, name: null, words: designerAskWords('CAPPED', 'en') })
    expect(await notesOn(sent)).toHaveLength(DESIGNER_ASKS_PER_DAY)
    expect(JSON.stringify((await buyerA.get(`/portal/threads/PortalOrderRequest/${sent}`)).body)).toContain('one more question for the designer')
  })

  it('W-CP-6: Giulia serving A and B — A’s ask writes on A’s thread only; B is told nothing; her note on B cannot attach A’s file', async () => {
    await slot(P3, giulia.id, null)
    const asked = await post(buyerB, betaDraft, 'Made-up: Beta asks about its own badge.')
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    expect(asked.body.designerAsk).toMatchObject({ asked: true, name: giulia.name })
    const betaNotes = await notesOn(betaDraft)
    expect(betaNotes).toHaveLength(1)
    expect(betaNotes[0]!.bodyText).not.toContain(customerA)
    for (const row of await notesOn(sent)) expect(row.bodyText).not.toMatch(/Beta asks about its own badge/)
    // B's bell and threads hold nothing of A's asks.
    expect(JSON.stringify((await buyerB.get('/portal/notifications')).body)).not.toContain(sent)
    expect(JSON.stringify((await buyerB.get('/portal/threads')).body)).not.toContain(sent)
    // Her own note in B's draft thread cannot carry a file of A (another record's, another customer's).
    const fileOfA = (await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "partyId" = $2 AND status = 'AVAILABLE' ORDER BY id LIMIT 1`, [world.tenantId, world.p1]))[0]
    if (fileOfA) {
      const asGiulia = callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: giulia.id, requestId: newId(), grants: [{ permissions: ['threads.read', 'threads.post', 'orders.view', 'files.read'], companies: 'all', sites: 'all', parties: 'all' }] })
      await expect(postNote(asGiulia, { type: 'PortalOrderRequest', id: betaDraft }, { body: 'Made-up: here is the badge.', attachments: [fileOfA.id] }, `cp079-key-${++serial}`)).rejects.toThrow(/not valid|Only a file of this record|File not found/)
    }
  })
})
