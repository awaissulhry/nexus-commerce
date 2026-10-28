import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { useThreadRecords, type RecordScope } from './records'
import { attachmentProblems, ensureThread, writeMessage } from './threads'

/**
 * Record threads and the record timeline on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations, the runtime login through the scoped clients (row-level security and the guard
 * triggers are real), sessions from the test authenticator. `Quote` is a made-up record type with a party (the sales
 * module brings the real one). Run with `node scripts/factory/run-pg-tests.mjs threads`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyRace = newId()
const companyTimeline = newId()
const companyB = newId()
const siteOne = newId()
const partyOne = newId()
const partyTwo = newId()
const author = newId()
const colleague = newId()
const outsider = newId()
const suspended = newId()
const authorB = newId()
const store = newId()
const quote = newId()
const otherQuote = newId()
const lateQuote = newId()

/** The made-up quotes: their company and party (a quote may get its party later). */
const quotes = new Map<string, { companyId: string; partyId: string | null }>([
  [quote, { companyId: companyOne, partyId: partyOne }],
  [otherQuote, { companyId: companyOne, partyId: partyOne }],
  [lateQuote, { companyId: companyOne, partyId: null }],
])

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const OFFICE_ALL = ['threads.read', 'threads.post', 'threads.manage', 'files.read', 'audit.read'] as const
const PARTNER_READ = [grant(['threads.read', 'files.read'])]
const SESSIONS: Record<string, SessionContext> = {
  author: { audience: 'office', tenantId: tenantA, actorId: author, grants: [grant(OFFICE_ALL)] },
  reader: { audience: 'office', tenantId: tenantA, actorId: colleague, grants: [grant(['threads.read'])] },
  pricey: { audience: 'office', tenantId: tenantA, actorId: colleague, grants: [grant(['threads.read', 'audit.read', 'money.price'])] },
  'company-two': { audience: 'office', tenantId: tenantA, actorId: outsider, grants: [grant(['threads.read', 'threads.post', 'files.read'], [companyTwo])] },
  'author-b': { audience: 'office', tenantId: tenantB, actorId: authorB, grants: [grant(OFFICE_ALL)] },
  'partner-one': { audience: 'partner', tenantId: tenantA, actorId: newId(), partyId: partyOne, grants: PARTNER_READ },
  'partner-two': { audience: 'partner', tenantId: tenantA, actorId: newId(), partyId: partyTwo, grants: PARTNER_READ },
  'link-one': { audience: 'link', tenantId: tenantA, linkId: newId(), partyId: partyOne, record: { type: 'Quote', id: quote }, grants: PARTNER_READ },
  floor: { audience: 'floor', tenantId: tenantA, actorId: newId(), siteId: siteOne, deviceId: newId(), grants: [grant(['threads.read'])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
const office = (tenantId = tenantA, actorId = author) => callerFor(database, { audience: 'office', tenantId, actorId, grants: [grant(OFFICE_ALL)], requestId: newId() })

async function note(session: string, type: string, id: string, body: Json, headers: Record<string, string> = {}): Promise<Json> {
  const response = await call(session, 'POST', `/threads/${type}/${id}/notes`, body, headers)
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
async function thread(session: string, type: string, id: string, query = ''): Promise<Json> {
  const response = await call(session, 'GET', `/threads/${type}/${id}${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
async function timeline(session: string, id: string, query = ''): Promise<Json> {
  const response = await call(session, 'GET', `/threads/Company/${id}/timeline${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** An AVAILABLE file of a record, written straight into the table (the files flow is tested in platform/files). */
async function file(recordType: string, recordId: string, sharing: { visibility?: string[]; partyId?: string } = {}, availableAt = new Date()): Promise<string> {
  const id = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
       "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt")
     VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', $6, 'application/pdf', 100, $7, $8, $9, 'AVAILABLE', $10::"FileAudience"[], $11, $12)`,
    [
      id,
      tenantA,
      companyOne,
      recordType,
      recordId,
      `Made-up ${id.slice(-4)}.pdf`,
      createHash('sha256').update(id).digest('hex'),
      store,
      `t/${tenantA}/c/${companyOne}/2026/${newId()}`,
      sharing.visibility ?? ['OFFICE'],
      sharing.partyId ?? null,
      availableAt,
    ],
  )
  return id
}

/** A message shared with the party, written through the email steps' seam (OUTBOUND, as the email-out step will). */
async function sendToParty(recordId: string, bodyText: string, attachments: string[] = []): Promise<{ id: string; problems: readonly Issue[] }> {
  try {
    const { result } = await command(office(), { name: 'email.send', input: { recordId, bodyText, attachments } }, async (tools) => {
      const { thread: row } = await ensureThread(tools, { type: 'Quote', id: recordId }, author)
      const problems = await attachmentProblems(tools.tx, tools.context, row, attachments, 'PARTNER')
      if (problems.length > 0) throw new ValidationError('Not sent.', problems)
      const message = await writeMessage(tools, row, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: author, name: 'Ada Author' }, bodyText, attachments })
      return { id: message.id }
    })
    return { id: result.id, problems: [] }
  } catch (error) {
    if (error instanceof ValidationError) return { id: '', problems: error.issues ?? [] }
    throw error
  }
}

beforeAll(async () => {
  db = await migratedDatabase('threads')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'threads-a', [companyOne, companyTwo, companyRace, companyTimeline]],
    [tenantB, 'threads-b', [companyB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
    }
  }
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S1', 'Plant one', 'PLANT')`, [siteOne, tenantA, companyOne])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE')`, [store, tenantA])
  for (const [id, tenantId, name, status] of [
    [author, tenantA, 'Ada Author', 'ACTIVE'],
    [colleague, tenantA, 'Carlo Colleague', 'ACTIVE'],
    [outsider, tenantA, 'Olga Outsider', 'ACTIVE'],
    [suspended, tenantA, 'Sara Suspended', 'SUSPENDED'],
    [authorB, tenantB, 'Bea Other', 'ACTIVE'],
  ] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [id, tenantId, `${id.slice(-8)}@example.com`, name, status])
  }
  // A role that reads threads: over every company (author, colleague, suspended), or only company two (outsider).
  const role = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions) VALUES ($1, $2, 'custom.thread_reader', 'Thread reader', ARRAY['threads.read'])`, [role, tenantA])
  for (const [userId, all, companies] of [
    [author, true, []],
    [colleague, true, []],
    [suspended, true, []],
    [outsider, false, [companyTwo]],
  ] as const) {
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)`, [
      newId(),
      tenantA,
      userId,
      role,
      all,
      companies,
      new Date('2026-01-01T00:00:00Z'),
    ])
  }

  useThreadRecords({
    // A made-up quote is the tenant's when its company is (read in the caller's scope: row-level security decides).
    Quote: async (client, id): Promise<RecordScope | null> => {
      const found = quotes.get(id)
      if (!found || !(await client.company.findUnique({ where: { id: found.companyId }, select: { id: true } }))) return null
      return { companyId: found.companyId, siteId: null, partyId: found.partyId }
    },
  })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('one thread per record (COL-001)', () => {
  it('makes one thread when first notes race, and every note lands in it', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => note('author', 'Company', companyRace, { body: `First note ${index}` })))
    expect(new Set(results.map((result) => result.thread.id)).size).toBe(1)
    const { n: threads } = await first<{ n: number }>('SELECT count(*)::int AS n FROM "Thread" WHERE "recordId" = $1', [companyRace])
    const { n: messages } = await first<{ n: number }>('SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1', [results[0]!.thread.id])
    const { n: opened } = await first<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'threads.open' AND "recordId" = $1`, [results[0]!.thread.id])
    expect({ threads, messages, opened }).toEqual({ threads: 1, messages: 6, opened: 1 })
    const [row] = await admin('SELECT "companyId", "siteId", "partyId", "replyToken", status FROM "Thread" WHERE "recordId" = $1', [companyRace])
    expect(row).toMatchObject({ companyId: companyRace, siteId: null, partyId: null, status: 'OPEN' })
    expect(row!.replyToken).toMatch(/^[a-z2-7]{26}$/)
  })

  it("takes the record's company and site from the record, and answers an empty panel before the first message", async () => {
    expect(await thread('author', 'Site', siteOne)).toEqual({ thread: null, messages: [], nextCursor: null })
    const { thread: made, message } = await note('author', 'Site', siteOne, { body: '  Check the press on line 2.\r\n  ' })
    expect(made).toMatchObject({ recordType: 'Site', recordId: siteOne, companyId: companyOne, siteId: siteOne, status: 'OPEN', version: 1 })
    expect(made.lastMessageAt).toBe(message.at)
    expect(message).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', body: 'Check the press on line 2.', author: { kind: 'USER', id: author, name: 'Ada Author' } })
  })

  it('refuses a record type without threads, a record that does not exist, and a note with nothing in it', async () => {
    expect((await call('author', 'GET', `/threads/Gadget/${newId()}`)).statusCode).toBe(404)
    expect((await call('author', 'POST', `/threads/Company/${newId()}/notes`, { body: 'x' })).statusCode).toBe(404)
    const empty = await call('author', 'POST', `/threads/Company/${companyOne}/notes`, { body: ' \n ' })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error.issues).toEqual([{ path: 'body/body', message: 'Write something, or attach a file.' }])
  })

  it('answers a repeated Idempotency-Key with the first note, written once', async () => {
    const headers = { 'idempotency-key': 'thread-note-key-0001' }
    const first = await note('author', 'Company', companyOne, { body: 'Only once' }, headers)
    const again = await note('author', 'Company', companyOne, { body: 'Only once' }, headers)
    expect(again.message.id).toBe(first.message.id)
    expect((await admin(`SELECT id FROM "Message" WHERE "bodyText" = 'Only once'`)).length).toBe(1)
  })
})

describe('internal notes never reach a party (COL-003)', () => {
  let shared: string
  let internal: string

  beforeAll(async () => {
    internal = (await note('author', 'Quote', quote, { body: 'Internal: margin is thin on this one.' })).message.id
    shared = (await sendToParty(quote, 'Here is your quote.')).id
  })

  it('shows the office both, the party only the shared one, through the API', async () => {
    const seenByOffice = await thread('author', 'Quote', quote)
    expect(seenByOffice.thread).toMatchObject({ partyId: partyOne, recordType: 'Quote' })
    expect(seenByOffice.messages.map((message: Json) => message.id)).toEqual([shared, internal])

    for (const session of ['partner-one', 'link-one']) {
      const seen = await thread(session, 'Quote', quote)
      expect(seen.messages.map((message: Json) => message.id), session).toEqual([shared])
      expect(seen.messages[0]).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', author: { kind: 'USER', name: 'Ada Author' } })
      // Who in the office wrote it, whom a note mentioned and the thread's last activity stay inside.
      expect(seen.messages[0].author).not.toHaveProperty('id')
      expect(seen.messages[0]).not.toHaveProperty('mentions')
      expect(seen.thread).not.toHaveProperty('lastMessageAt')
    }
  })

  it("gives another party, another record's link, the floor and a portal on the timeline nothing", async () => {
    expect(await thread('partner-two', 'Quote', quote)).toEqual({ thread: null, messages: [], nextCursor: null })
    expect((await call('link-one', 'GET', `/threads/Quote/${otherQuote}`)).statusCode).toBe(404)
    expect((await call('floor', 'GET', `/threads/Quote/${quote}`)).statusCode).toBe(403)
    expect((await call('partner-one', 'GET', `/threads/Quote/${quote}/timeline`)).statusCode).toBe(403)
    expect((await call('partner-one', 'POST', `/threads/Quote/${quote}/notes`, { body: 'x' })).statusCode).toBe(403)
  })

  it('holds in the database: the partner role reads no internal note, and a note cannot carry a party', async () => {
    const rows = await database.withScope({ audience: 'partner', tenantId: tenantA, actorId: newId(), partyId: partyOne }, (client) =>
      client.message.findMany({ select: { id: true, direction: true, audience: true } }),
    )
    expect(rows.map((row) => row.id)).toContain(shared)
    expect(rows.every((row) => row.direction !== 'INTERNAL_NOTE' && row.audience === 'PARTNER')).toBe(true)
    // Prisma's default select names the hidden columns (authorId, mentionedUserIds): refused.
    await expect(database.withScope({ audience: 'partner', tenantId: tenantA, actorId: newId(), partyId: partyOne }, (client) => client.message.findMany())).rejects.toThrow(/permission denied/)

    const { id: threadId } = await first<{ id: string }>('SELECT id FROM "Thread" WHERE "recordId" = $1', [quote])
    const insert = (direction: string, audience: string, partyId: string | null) =>
      admin(
        `INSERT INTO "Message" (id, "tenantId", "threadId", "partyId", direction, audience, channel, "authorKind", "bodyText", at)
         VALUES ($1, $2, $3, $4, $5::"MessageDirection", $6::"MessageAudience", 'APP', 'SYSTEM', 'x', now())`,
        [newId(), tenantA, threadId, partyId, direction, audience],
      )
    await expect(insert('INTERNAL_NOTE', 'OFFICE', partyOne)).rejects.toThrow(/names a party exactly when it is shared/)
    await expect(insert('INTERNAL_NOTE', 'PARTNER', partyOne)).rejects.toThrow(/internal notes, and only they, are for the office/)
    await expect(insert('OUTBOUND', 'PARTNER', partyTwo)).rejects.toThrow(/Message_tenantId_threadId_partyId_fkey/)
  })

  it("takes the record's party once it has one, and never another after", async () => {
    await note('author', 'Quote', lateQuote, { body: 'No customer yet.' })
    const refused = await sendToParty(lateQuote, 'Hello?').catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/no customer or supplier/)

    quotes.set(lateQuote, { companyId: companyOne, partyId: partyTwo })
    await sendToParty(lateQuote, 'Now we know you.')
    quotes.set(lateQuote, { companyId: companyOne, partyId: partyOne })
    await sendToParty(lateQuote, 'Still you.')
    const [row] = await admin('SELECT id, "partyId" FROM "Thread" WHERE "recordId" = $1', [lateQuote])
    expect(row!.partyId).toBe(partyTwo)
    expect((await thread('partner-two', 'Quote', lateQuote)).messages.map((message: Json) => message.body)).toEqual(['Still you.', 'Now we know you.'])
    await expect(admin('UPDATE "Thread" SET "partyId" = $1 WHERE id = $2', [partyOne, row!.id])).rejects.toThrow(/set once and never changes/)
  })
})

describe('attachments (COL-045, COL-050)', () => {
  it('attaches only available files of the same record that the writer may read', async () => {
    const own = await file('Quote', otherQuote)
    const elsewhere = await file('Quote', quote)
    const ok = await note('author', 'Quote', otherQuote, { body: 'See the drawing.', attachments: [own, own] })
    expect(ok.message.attachments.map((attachment: Json) => attachment.id)).toEqual([own])

    const refused = await call('author', 'POST', `/threads/Quote/${otherQuote}/notes`, { body: 'Wrong file', attachments: [elsewhere, newId()] })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.issues).toEqual([
      { path: 'body/attachments/0', message: 'Only a file of this record can be attached.' },
      { path: 'body/attachments/1', message: 'File not found.' },
    ])
  })

  it('shows each reader only the files it may see', async () => {
    const officeOnly = await file('Quote', quote)
    const portal = await file('Quote', quote, { visibility: ['OFFICE', 'PARTNER'], partyId: partyOne })
    const link = await file('Quote', quote, { visibility: ['OFFICE', 'LINK'], partyId: partyOne })

    // A file the party may not see never goes out with a shared message.
    expect((await sendToParty(quote, 'With the internal file', [officeOnly])).problems).toEqual([{ path: 'body/attachments/0', message: "Share the file with the record's party first." }])
    const { id } = await sendToParty(quote, 'Your documents.', [portal, link])
    const attachmentsOf = async (session: string) => ((await thread(session, 'Quote', quote)).messages as Json[]).find((message) => message.id === id)!.attachments.map((attachment: Json) => attachment.id)
    expect(await attachmentsOf('author')).toEqual([portal, link])
    expect(await attachmentsOf('partner-one')).toEqual([portal])
    expect(await attachmentsOf('link-one')).toEqual([link])
    // An office reader without files.read sees the message, not its files.
    expect(await attachmentsOf('reader')).toEqual([])
  })
})

describe('mentions (COL-006) and events', () => {
  it('tells a colleague who can read the thread, with the live event of the panel', async () => {
    const { message, thread: row } = await note('author', 'Company', companyOne, { body: 'Can you check this?', mentions: [colleague, author] })
    expect(message.mentions).toEqual([colleague, author])
    const events = await admin<{ type: string; payload: Json; companyId: string; subject: string }>(
      `SELECT type, payload, "companyId", subject FROM "OutboxEvent" WHERE payload->>'messageId' = $1 ORDER BY type`,
      [message.id],
    )
    // The author mentioning themself is not told.
    expect(events).toEqual([
      { type: 'thread.message_posted', companyId: companyOne, subject: companyOne, payload: { threadId: row.id, messageId: message.id, recordType: 'Company', recordId: companyOne, direction: 'INTERNAL_NOTE', audience: 'OFFICE' } },
      { type: 'thread.user_mentioned', companyId: companyOne, subject: companyOne, payload: { threadId: row.id, messageId: message.id, recordType: 'Company', recordId: companyOne, userId: colleague, authorId: author } },
    ])
  })

  it('refuses someone who cannot read the thread, who is not active, or who is not a person of the tenant', async () => {
    const response = await call('author', 'POST', `/threads/Company/${companyOne}/notes`, { body: 'Hello', mentions: [outsider, suspended, authorB] })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.issues).toEqual([
      { path: 'body/mentions/0', message: "This person cannot read this record's thread." },
      { path: 'body/mentions/1', message: 'Not an active person of this tenant.' },
      { path: 'body/mentions/2', message: 'Not an active person of this tenant.' },
    ])
  })
})

describe('scope, tenant wall and status', () => {
  it("keeps a company-limited person to their company's records", async () => {
    expect((await call('company-two', 'GET', `/threads/Company/${companyOne}`)).statusCode).toBe(404)
    expect((await call('company-two', 'POST', `/threads/Company/${companyOne}/notes`, { body: 'x' })).statusCode).toBe(404)
    expect((await note('company-two', 'Company', companyTwo, { body: 'My own company' })).thread.companyId).toBe(companyTwo)
  })

  it("never shows or writes another tenant's thread", async () => {
    expect((await call('author-b', 'GET', `/threads/Company/${companyOne}`)).statusCode).toBe(404)
    expect((await call('author-b', 'GET', `/threads/Quote/${quote}`)).statusCode).toBe(404)
    expect((await call('author-b', 'POST', `/threads/Company/${companyOne}/notes`, { body: 'x' })).statusCode).toBe(404)
    expect((await call('author-b', 'GET', `/threads/Company/${companyOne}/timeline`)).statusCode).toBe(404)
    const seen = await database.withScope({ audience: 'office', tenantId: tenantB, actorId: authorB }, async (client) => ({
      threads: await client.thread.count(),
      messages: await client.message.count(),
    }))
    expect(seen).toEqual({ threads: 0, messages: 0 })
    // B's own thread is B's: same record id space, its own row.
    expect((await note('author-b', 'Company', companyB, { body: 'Tenant B' })).thread.companyId).toBe(companyB)
  })

  it('closes a thread to new notes and reopens it, with the edit-conflict guard', async () => {
    const { thread: row } = await note('author', 'Company', companyTwo, { body: 'Before closing' })
    const closed = await call('author', 'PUT', `/threads/Company/${companyTwo}/status`, { status: 'CLOSED', version: row.version, reason: 'Order done' })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().thread).toMatchObject({ status: 'CLOSED', version: row.version + 1 })
    expect((await call('author', 'POST', `/threads/Company/${companyTwo}/notes`, { body: 'Late' })).json().error.code).toBe('invalid_state')
    expect((await call('author', 'PUT', `/threads/Company/${companyTwo}/status`, { status: 'OPEN', version: row.version })).statusCode).toBe(409)
    expect((await call('reader', 'PUT', `/threads/Company/${companyTwo}/status`, { status: 'OPEN', version: row.version + 1 })).statusCode).toBe(403)
    expect((await call('author', 'PUT', `/threads/Company/${companyTwo}/status`, { status: 'OPEN', version: row.version + 1 })).json().thread.status).toBe('OPEN')
  })
})

describe('append-only messages', () => {
  it('refuses to change or remove a message for the runtime role and for the owner alike', async () => {
    const { id } = await first<{ id: string }>('SELECT id FROM "Message" LIMIT 1')
    await expect(database.withScope({ audience: 'office', tenantId: tenantA, actorId: author }, (client) => client.$executeRawUnsafe('UPDATE "Message" SET "bodyText" = $1 WHERE id = $2::uuid', 'changed', id))).rejects.toThrow(/permission denied/)
    await expect(database.withScope({ audience: 'office', tenantId: tenantA, actorId: author }, (client) => client.$executeRawUnsafe('DELETE FROM "Message" WHERE id = $1::uuid', id))).rejects.toThrow(/permission denied/)
    await expect(admin('UPDATE "Message" SET "bodyText" = $1 WHERE id = $2', ['changed', id])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "Message" WHERE id = $1', [id])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "Message" CASCADE')).rejects.toThrow(/append-only/)
  })

  it('keeps a thread: never deleted, its record and reply address never changed', async () => {
    const { id } = await first<{ id: string }>('SELECT id FROM "Thread" WHERE "tenantId" = $1 LIMIT 1', [tenantA])
    await expect(admin('DELETE FROM "Thread" WHERE id = $1', [id])).rejects.toThrow(/never deleted/)
    await expect(
      database.withScope({ audience: 'office', tenantId: tenantA, actorId: author }, (client) =>
        client.$executeRawUnsafe('UPDATE "Thread" SET "recordId" = $1::uuid WHERE id = $2::uuid', newId(), id),
      ),
    ).rejects.toThrow(/never change/)
    await expect(admin(`UPDATE "Thread" SET "replyToken" = 'abcdefghijklmnopqrstuvwxyz' WHERE id = $1`, [id])).rejects.toThrow(/never change/)
  })
})

describe('the record timeline (COL-002)', () => {
  const ids: Record<string, string> = {}
  const audit = (before: unknown, after: unknown) =>
    command(office(), { name: 'companies.update', input: { before, after } }, async ({ audit: record }) => {
      record({ recordType: 'Company', recordId: companyTimeline, companyId: companyTimeline, before, after })
      return null
    })
  const changeIds = async () => (await admin<{ id: string }>(`SELECT id FROM "AuditLog" WHERE "recordId" = $1 ORDER BY id`, [companyTimeline])).map((row) => row.id)

  beforeAll(async () => {
    await audit({ status: 'DRAFT', name: 'Old name' }, { status: 'ACTIVE', name: 'New name' })
    ids.change1 = (await changeIds())[0]!
    ids.note1 = (await note('author', 'Company', companyTimeline, { body: 'First note on the timeline.' })).message.id
    await audit({ unitPrice: markMoney('price', '10.00'), note: 'a' }, { unitPrice: markMoney('price', '12.00'), note: 'b' })
    ids.change2 = (await changeIds())[1]!
    ids.note2 = (await note('author', 'Company', companyTimeline, { body: 'Second note.' })).message.id
    ids.file = await file('Company', companyTimeline, {}, new Date(Date.now() + 3_600_000))
  })

  it('merges changes, messages and files newest first, without the thread\'s own audit rows', async () => {
    const { entries, nextCursor } = await timeline('author', companyTimeline)
    expect(entries.map((entry: Json) => [entry.kind, entry.id])).toEqual([
      ['file', ids.file],
      ['message', ids.note2],
      ['change', ids.change2],
      ['message', ids.note1],
      ['change', ids.change1],
    ])
    expect(nextCursor).toBeNull()
    expect(entries[1]).toMatchObject({ excerpt: 'Second note.', author: { kind: 'USER', id: author, name: 'Ada Author' }, attachmentCount: 0 })
    expect(entries[4]).toMatchObject({ action: 'companies.update', actor: { audience: 'OFFICE', id: author }, status: { from: 'DRAFT', to: 'ACTIVE' }, fields: ['name', 'status'] })
  })

  it('pages with the cursor, nothing lost or shown twice, and filters by kind', async () => {
    const all = (await timeline('author', companyTimeline)).entries.map((entry: Json) => entry.id)
    const paged: string[] = []
    let cursor: string | null = null
    do {
      const page: Json = await timeline('author', companyTimeline, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      paged.push(...page.entries.map((entry: Json) => entry.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(paged).toEqual(all)
    expect((await timeline('author', companyTimeline, '?kinds=message')).entries.map((entry: Json) => entry.id)).toEqual([ids.note2, ids.note1])
    expect((await timeline('author', companyTimeline, '?kinds=change,file')).entries.map((entry: Json) => entry.kind)).toEqual(['file', 'change', 'change'])
    expect((await call('author', 'GET', `/threads/Company/${companyTimeline}/timeline?kinds=gossip`)).statusCode).toBe(400)
    expect((await call('author', 'GET', `/threads/Company/${companyTimeline}/timeline?cursor=nonsense`)).statusCode).toBe(400)
  })

  it('never shows a price to a reader without the price grain, nor values without audit.read', async () => {
    const change = async (session: string) => ((await timeline(session, companyTimeline)).entries as Json[]).find((entry) => entry.id === ids.change2)!
    // audit.read, no grain: the price is neither named nor shown.
    expect(await change('author')).toMatchObject({ fields: ['note'], before: { note: 'a' }, after: { note: 'b' } })
    expect((await change('author')).before).not.toHaveProperty('unitPrice')
    // audit.read and the price grain: named and shown.
    expect(await change('pricey')).toMatchObject({ fields: ['note', 'unitPrice'], before: { unitPrice: '10.00', note: 'a' }, after: { unitPrice: '12.00', note: 'b' } })
    // No audit.read: what changed, never the values; no files.read: no file entry.
    const reader = (await timeline('reader', companyTimeline)).entries as Json[]
    expect(reader.find((entry) => entry.id === ids.change2)).toMatchObject({ fields: ['note'], before: null, after: null, reason: null })
    expect(reader.find((entry) => entry.id === ids.change1)).toMatchObject({ status: { from: 'DRAFT', to: 'ACTIVE' }, before: null })
    expect(reader.some((entry) => entry.kind === 'file')).toBe(false)
  })
})
