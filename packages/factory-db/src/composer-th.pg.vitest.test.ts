import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedEmail } from '../seed/email'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedThreads } from '../seed/threads'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedHeldMail, type HeldMail } from './testing/held-mail'

/**
 * The composer in depth (TH-3, threads schema wave 5/9, B-TH-038; gaps N7, thread-G08, thread-G19, thread-G20; Owner decision 6
 * "undo send, 10 seconds"; …_threads_composer_th_guards and the generated policy migration), on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - the wall (W01): a message's typed amount and its currency are hidden from the partner role (no read, no write), the
 *     floor's role reads no message at all; a portal session never reads a held message (a mail waiting in its undo window or
 *     taken back) and never writes one;
 *   - the amount: with its currency, 0 or more, only on an internal note that stays in the office;
 *   - reply and correct: one message of the same thread, written before, that the writer reads; a shared message points only at
 *     a shared one that is not held; a correction keeps the direction of what it corrects; still append-only;
 *   - undo send: a mail with a window names a held message, and a held message has its mail by commit; the window is at most a
 *     minute; taken back only from QUEUED, never claimed, by an office person, with when and by whom; its message stays held for
 *     good; a mail that leaves the window (claimed, or failed) releases its message in the same statement, and only then;
 *   - a task names the message it came from: a message of its own record's thread, never changed.
 * The refusals are check_violation (23514), the wall's permission denied or a row-level security refusal.
 */

const NS = 'th-038-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let held: HeldMail

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  identity: key('email:identity:A:conversation'),
  companyThread: key('threads:company:A'),
  quoteThread: key('threads:quote:Q1'),
  quote: key('quote:Q1'),
  companyNote: key('threads:message:company-note'),
  quoteNote: key('threads:message:quote-note'),
  quoteOut: key('threads:message:quote-out'),
  quoteIn: key('threads:message:quote-in'),
}
const DOMAIN = `company-a.${NS}.example.com`
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
/** Several inserts in ONE transaction of `scope` (the deferred check runs at its commit). */
const together = (scope: FactoryScope, rows: readonly [string, Record<string, unknown>][]) =>
  as(scope, (client) =>
    client.$transaction(async (tx) => {
      for (const [table, row] of rows) await tx.$executeRawUnsafe(...insertSql(table, row))
    }),
  )

let clock = Date.parse('2026-11-01T09:00:00.000Z')
/** A later instant each time, so every new message is written after the seeded ones. */
const later = (): string => new Date((clock += 60_000)).toISOString()

/** An office internal note on `threadId` (or the quote thread), with `extra` columns. */
const note = (extra: Record<string, unknown> = {}, threadId = A.quoteThread): Record<string, unknown> => ({
  id: randomUUID(),
  threadId,
  direction: 'INTERNAL_NOTE',
  audience: 'OFFICE',
  channel: 'APP',
  authorKind: 'USER',
  authorId: a.actorId,
  authorName: 'Seed Office User',
  bodyText: 'Seed note.',
  at: later(),
  ...extra,
})
/** The office's mail message to P1 on the quote thread (held when it waits in an undo window). */
const mailMessage = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const id = randomUUID()
  return {
    id,
    threadId: A.quoteThread,
    partyId: A.P1,
    direction: 'OUTBOUND',
    audience: 'PARTNER',
    channel: 'EMAIL',
    authorKind: 'USER',
    authorId: a.actorId,
    authorName: 'Seed Office User',
    bodyText: 'Seed mail: the new delivery date.',
    emailMessageId: `<${id}@${DOMAIN}>`,
    at: later(),
    ...extra,
  }
}
/** The EmailOutbound row of `message` (queued now, with a 10-second window unless `extra` says otherwise). */
const mailOf = (message: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const queuedAt = String(message.at)
  return {
    id: randomUUID(),
    companyId: A.companyA,
    identityId: A.identity,
    threadId: message.threadId,
    messageId: message.id,
    recordType: 'Quote',
    recordId: A.quote,
    templateKey: 'thread.message',
    locale: 'it',
    fromAddress: `noreply@${DOMAIN}`,
    fromName: 'Seed Office User via Seed A',
    to: ['buyer.th-038@example.com'],
    subject: 'Nuova data di consegna',
    emailMessageId: message.emailMessageId,
    status: 'QUEUED',
    queuedAt,
    sendAfter: new Date(Date.parse(queuedAt) + 10_000).toISOString(),
    createdById: a.actorId,
    ...extra,
  }
}
/** A mail with a window and its held message, written together as the API does; answers both rows. */
async function waitingMail(): Promise<{ message: Record<string, unknown>; mail: Record<string, unknown> }> {
  const message = mailMessage({ held: true })
  const mail = mailOf(message)
  await together(office(), [
    ['Message', message],
    ['EmailOutbound', mail],
  ])
  return { message, mail }
}
const heldOf = async (messageId: unknown) => (await admin(`SELECT held FROM "Message" WHERE id = $1::uuid`, [messageId]))[0]!.held
const partnerSees = async (messageId: unknown) => (await sql(partner(A.P1), `SELECT id FROM "Message" WHERE id = $1::uuid`, messageId)).length === 1

beforeAll(async () => {
  db = await migratedDatabase('composerth')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedThreads({ db: factory, namespace: NS })
  await seedEmail({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  held = await seedHeldMail({ db: factory, namespace: NS })
  // Run twice: every seed and the fixture are idempotent.
  await seedThreads({ db: factory, namespace: NS })
  await seedEmail({ db: factory, namespace: NS })
  await seedHeldMail({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the wall (W01)', () => {
  it('the amount and its currency are hidden from the portal (no read, no write); the floor reads no message at all', async () => {
    const priced = note({ amount: 4250, amountCurrency: 'EUR', bodyText: 'Seed note: the price we agreed by phone.' })
    expect(await insert(office(), 'Message', priced)).toBe(1)
    expect(await sql(office(), `SELECT amount, "amountCurrency" FROM "Message" WHERE id = $1::uuid`, priced.id)).toEqual([{ amount: 4250, amountCurrency: 'EUR' }])
    for (const column of ['amount', 'amountCurrency']) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "Message" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(floor(), `SELECT "${column}" FROM "Message" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    await expect(sql(floor(), `SELECT id FROM "Message" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // A portal post cannot carry one either: the column has no grant.
    const post = { id: randomUUID(), threadId: A.quoteThread, partyId: A.P1, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Seed Portal Buyer', bodyText: 'Seed post.', at: later(), amount: 100, amountCurrency: 'EUR' }
    await expect(insert(partner(A.P1), 'Message', post)).rejects.toThrow(/permission denied/)
  })

  it('a portal session never reads a held message (a mail taken back) and never writes one; the office reads it', async () => {
    expect(await heldOf(held.messageId)).toBe(true)
    expect(await partnerSees(held.messageId)).toBe(false)
    expect((await sql(partner(A.P1), `SELECT id FROM "Message" WHERE held`)).length).toBe(0)
    expect((await sql(office(), `SELECT id FROM "Message" WHERE id = $1::uuid`, held.messageId)).length).toBe(1)
    // Not vacuous: P1 reads the quote thread's shared messages that are not held.
    expect((await sql(partner(A.P1), `SELECT id FROM "Message" WHERE "threadId" = $1::uuid ORDER BY at`, A.quoteThread)).map((row) => row.id)).toEqual([A.quoteOut, A.quoteIn])
    const post = { id: randomUUID(), threadId: A.quoteThread, partyId: A.P1, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Seed Portal Buyer', bodyText: 'Seed post.', at: later(), held: true }
    await expect(insert(partner(A.P1), 'Message', post)).rejects.toThrow(/row-level security/)
  })
})

describe('the amount (N7)', () => {
  it('comes with its currency, 0 or more, only on an internal note that stays in the office', async () => {
    expect(await insert(office(), 'Message', note({ amount: 0, amountCurrency: 'CHF' }))).toBe(1)
    await expect(insert(office(), 'Message', note({ amount: 4250 }))).rejects.toThrow(/together with its currency/)
    await expect(insert(office(), 'Message', note({ amountCurrency: 'EUR' }))).rejects.toThrow(/together with its currency/)
    await expect(insert(office(), 'Message', note({ amount: -1, amountCurrency: 'EUR' }))).rejects.toThrow(/0 or more/)
    await expect(insert(office(), 'Message', note({ amount: 100, amountCurrency: 'eur' }))).rejects.toThrow(/0 or more/)
    // Never on a note for the floor, never on a shared message.
    await expect(insert(office(), 'Message', note({ amount: 100, amountCurrency: 'EUR', forFloor: true }))).rejects.toThrow(/stays in the office/)
    const shared = mailMessage({ amount: 100, amountCurrency: 'EUR' })
    await expect(insert(office(), 'Message', shared)).rejects.toThrow(/stays in the office/)
  })
})

describe('reply and correct (thread-G20)', () => {
  it('a reply names a message of its own thread written before it, one its writer reads', async () => {
    expect(await insert(office(), 'Message', note({ replyToMessageId: A.quoteIn }))).toBe(1)
    // Another thread's message: the reference includes the thread (the guard, named before the reference, says it first).
    await expect(insert(office(), 'Message', note({ replyToMessageId: A.companyNote }))).rejects.toThrow(/of its own thread that its writer can read|foreign key/)
    // Not both a reply and a correction.
    await expect(insert(office(), 'Message', note({ replyToMessageId: A.quoteIn, correctsMessageId: A.quoteNote }))).rejects.toThrow(/not both/)
    // Never a message written after it.
    const early = note({ at: '2026-10-28T09:05:00.000Z', replyToMessageId: A.quoteIn })
    await expect(insert(office(), 'Message', early)).rejects.toThrow(/written before it/)
  })

  it('a shared message points only at a shared message that is not held; a portal post likewise, in neutral words', async () => {
    // The office's mail answering the customer's reply: fine. Answering an internal note: refused.
    expect(await insert(office(), 'Message', mailMessage({ replyToMessageId: A.quoteIn }))).toBe(1)
    await expect(insert(office(), 'Message', mailMessage({ replyToMessageId: A.quoteNote }))).rejects.toThrow(/answers or corrects only a message shared too/)
    await expect(insert(office(), 'Message', mailMessage({ replyToMessageId: held.messageId }))).rejects.toThrow(/answers or corrects only a message shared too/)
    // An internal note may answer the held mail (the office sees it).
    expect(await insert(office(), 'Message', note({ replyToMessageId: held.messageId }))).toBe(1)
    // P1's portal answers the office's mail; it cannot point at an internal note or the mail taken back: it cannot read them, and
    // the words are the same as for a message that is not there.
    const post = (replyTo: string) => ({ id: randomUUID(), threadId: A.quoteThread, partyId: A.P1, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Seed Portal Buyer', bodyText: 'Seed post: thank you.', at: later(), replyToMessageId: replyTo })
    expect(await insert(partner(A.P1), 'Message', post(A.quoteOut))).toBe(1)
    await expect(insert(partner(A.P1), 'Message', post(A.quoteNote))).rejects.toThrow(/that its writer can read/)
    await expect(insert(partner(A.P1), 'Message', post(held.messageId))).rejects.toThrow(/that its writer can read/)
  })

  it('a correction keeps the direction of what it corrects; the old message is never changed', async () => {
    expect(await insert(office(), 'Message', note({ correctsMessageId: A.quoteNote, bodyText: 'Seed note: correction, the leather is in stock.' }))).toBe(1)
    expect(await insert(office(), 'Message', mailMessage({ correctsMessageId: A.quoteOut, bodyText: 'Seed mail: correction, the quote is for 40 jackets.' }))).toBe(1)
    await expect(insert(office(), 'Message', note({ correctsMessageId: A.quoteOut }))).rejects.toThrow(/keeps the direction/)
    await expect(insert(office(), 'Message', mailMessage({ correctsMessageId: A.quoteIn }))).rejects.toThrow(/keeps the direction/)
    // Messages stay append-only: no runtime role updates one, and the owner's own update is refused.
    await expect(run(office(), `UPDATE "Message" SET "bodyText" = 'changed' WHERE id = $1::uuid`, A.quoteNote)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "Message" SET "replyToMessageId" = $2::uuid WHERE id = $1::uuid`, [A.quoteIn, A.quoteOut])).rejects.toThrow(/append-only/)
  })
})

describe('undo send (thread-G08, Owner decision 6)', () => {
  it('a mail with a window names a held message, and a held message has its mail by commit', async () => {
    const { message, mail } = await waitingMail()
    expect(await heldOf(message.id)).toBe(true)
    expect(await partnerSees(message.id)).toBe(false)
    expect((await admin(`SELECT status::text AS status, "sendAfter" IS NOT NULL AS waits FROM "EmailOutbound" WHERE id = $1::uuid`, [mail.id]))[0]).toEqual({ status: 'QUEUED', waits: true })
    // A held message alone: refused at commit.
    await expect(insert(office(), 'Message', mailMessage({ held: true }))).rejects.toThrow(/no such mail names it/)
    // A mail with a window whose message is not held, or a held message whose mail has no window: refused.
    const open = mailMessage()
    await expect(together(office(), [['Message', open], ['EmailOutbound', mailOf(open)]])).rejects.toThrow(/exactly when its message is held/)
    const waits = mailMessage({ held: true })
    await expect(together(office(), [['Message', waits], ['EmailOutbound', mailOf(waits, { sendAfter: null })]])).rejects.toThrow(/exactly when its message is held/)
    // Only the message of a mail sent waits.
    await expect(insert(office(), 'Message', note({ held: true }))).rejects.toThrow(/only the message of a mail sent/)
  })

  it('the window starts when the mail was queued and lasts at most a minute; only a thread mail has one; it never changes', async () => {
    const tooLong = mailMessage({ held: true })
    await expect(together(office(), [['Message', tooLong], ['EmailOutbound', mailOf(tooLong, { sendAfter: new Date(Date.parse(String(tooLong.at)) + 61_000).toISOString() })]])).rejects.toThrow(/at most a minute/)
    const before = mailMessage({ held: true })
    await expect(together(office(), [['Message', before], ['EmailOutbound', mailOf(before, { sendAfter: new Date(Date.parse(String(before.at)) - 1_000).toISOString() })]])).rejects.toThrow(/at most a minute/)
    // A sign-in mail (no thread message) never waits.
    const signIn = { ...mailOf(mailMessage()), threadId: null, messageId: null, recordType: 'User', recordId: a.actorId, templateKey: 'auth.invitation' }
    await expect(insert(office(), 'EmailOutbound', signIn)).rejects.toThrow(/only a mail on a thread/)
    const { mail } = await waitingMail()
    await expect(run(office(), `UPDATE "EmailOutbound" SET "sendAfter" = "sendAfter" + interval '5 seconds' WHERE id = $1::uuid`, mail.id)).rejects.toThrow(/never changes/)
  })

  it('taken back only from QUEUED, never claimed, by an office person, with when and by whom; its message stays held for good', async () => {
    const takeBack = (id: unknown, by: string = a.actorId, at = 'now()') =>
      run(office(), `UPDATE "EmailOutbound" SET status = 'WITHDRAWN', "withdrawnAt" = ${at}, "withdrawnById" = $2::uuid WHERE id = $1::uuid`, id, by)
    const { message, mail } = await waitingMail()
    // When and by whom exactly with WITHDRAWN.
    await expect(run(office(), `UPDATE "EmailOutbound" SET status = 'WITHDRAWN' WHERE id = $1::uuid`, mail.id)).rejects.toThrow(/exactly when it was/)
    await expect(run(office(), `UPDATE "EmailOutbound" SET "withdrawnAt" = now(), "withdrawnById" = $2::uuid WHERE id = $1::uuid`, mail.id, a.actorId)).rejects.toThrow(/exactly when it was/)
    // By an office person only.
    await expect(takeBack(mail.id, portal.userIds.p1Buyer)).rejects.toThrow(/office person/)
    expect(await takeBack(mail.id)).toBe(1)
    expect(await heldOf(message.id)).toBe(true)
    expect(await partnerSees(message.id)).toBe(false)
    // Final; when and by whom set once.
    await expect(run(office(), `UPDATE "EmailOutbound" SET status = 'SENDING', attempts = attempts + 1 WHERE id = $1::uuid`, mail.id)).rejects.toThrow(/cannot move from WITHDRAWN/)
    await expect(run(office(), `UPDATE "EmailOutbound" SET "withdrawnAt" = now() WHERE id = $1::uuid`, mail.id)).rejects.toThrow(/set once/)
    // The owner cannot release a withdrawn mail's message either.
    await expect(admin(`UPDATE "Message" SET held = false WHERE id = $1::uuid`, [message.id])).rejects.toThrow(/append-only/)
    // A mail claimed once (a failed try put back) may have left: never taken back. A mail with no window: never.
    const claimed = await waitingMail()
    expect(await run(office(), `UPDATE "EmailOutbound" SET status = 'SENDING', attempts = 1 WHERE id = $1::uuid`, claimed.mail.id)).toBe(1)
    expect(await run(office(), `UPDATE "EmailOutbound" SET status = 'QUEUED' WHERE id = $1::uuid`, claimed.mail.id)).toBe(1)
    await expect(takeBack(claimed.mail.id)).rejects.toThrow(/already claimed/)
    const plain = mailMessage()
    const plainMail = mailOf(plain, { sendAfter: null })
    await together(office(), [['Message', plain], ['EmailOutbound', plainMail]])
    await expect(takeBack(plainMail.id)).rejects.toThrow(/no undo window/)
    // Never born taken back.
    const born = mailMessage({ held: true })
    await expect(together(office(), [['Message', born], ['EmailOutbound', mailOf(born, { status: 'WITHDRAWN', withdrawnAt: born.at, withdrawnById: a.actorId })]])).rejects.toThrow(/not born taken back/)
  })

  it('a mail that leaves its window releases its message in the same statement: claimed for sending, or failed', async () => {
    const sent = await waitingMail()
    expect(await partnerSees(sent.message.id)).toBe(false)
    // The owner cannot release it while the mail waits.
    await expect(admin(`UPDATE "Message" SET held = false WHERE id = $1::uuid`, [sent.message.id])).rejects.toThrow(/append-only/)
    expect(await run(office(), `UPDATE "EmailOutbound" SET status = 'SENDING', attempts = attempts + 1 WHERE id = $1::uuid`, sent.mail.id)).toBe(1)
    expect(await heldOf(sent.message.id)).toBe(false)
    expect(await partnerSees(sent.message.id)).toBe(true)
    // Released once: the rest of the message is as it was.
    expect((await admin(`SELECT "bodyText", "emailMessageId" FROM "Message" WHERE id = $1::uuid`, [sent.message.id]))[0]).toEqual({ bodyText: sent.message.bodyText, emailMessageId: sent.message.emailMessageId })
    await expect(admin(`UPDATE "Message" SET held = true WHERE id = $1::uuid`, [sent.message.id])).rejects.toThrow(/append-only/)
    // A mail refused when its window ends (a suppressed address) releases its message too: the portal shows what was written.
    const failed = await waitingMail()
    expect(await run(office(), `UPDATE "EmailOutbound" SET status = 'FAILED', "failedAt" = now(), "lastError" = 'suppressed' WHERE id = $1::uuid`, failed.mail.id)).toBe(1)
    expect(await heldOf(failed.message.id)).toBe(false)
  })
})

describe('the task of a message (thread-G19)', () => {
  const task = (extra: Record<string, unknown>) => ({ id: randomUUID(), companyId: A.companyA, partyId: A.P1, title: 'Seed task: call the buyer back', recordType: 'Quote', recordId: A.quote, recordLabel: 'SEED-QT-0001', ...extra })
  it("names a message of its own record's thread, when it is made, never changed", async () => {
    const made = task({ messageId: A.quoteIn })
    expect(await insert(office(), 'Task', made)).toBe(1)
    // Another record's message, or no record: refused.
    await expect(insert(office(), 'Task', task({ messageId: A.companyNote }))).rejects.toThrow(/own record's thread/)
    await expect(insert(office(), 'Task', task({ messageId: A.quoteIn, recordType: null, recordId: null, recordLabel: null }))).rejects.toThrow(/own record's thread/)
    // Never changed, nor named later.
    await expect(run(office(), `UPDATE "Task" SET "messageId" = $2::uuid WHERE id = $1::uuid`, made.id, A.quoteOut)).rejects.toThrow(/never changes/)
    const plain = task({})
    expect(await insert(office(), 'Task', plain)).toBe(1)
    await expect(run(office(), `UPDATE "Task" SET "messageId" = $2::uuid WHERE id = $1::uuid`, plain.id, A.quoteOut)).rejects.toThrow(/never changes/)
    expect(await run(office(), `UPDATE "Task" SET title = 'Seed task: call the buyer back today' WHERE id = $1::uuid`, made.id)).toBe(1)
  })
})
