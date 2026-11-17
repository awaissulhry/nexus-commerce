import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { followInCommand, unfollowInCommand, type AutomaticFollowReason, type FollowedRecord } from './followers'
import { mayShare, NOT_SHAREABLE, NOT_SHAREABLE_REFUSAL, THREAD_RECORDS, useThreadRecords, type RecordResolver } from './records'
import { ensureThread, writeMessage } from './threads'

/**
 * B-PR-08a part 1 (production plan R-02, §2 "work order, hold and NCR threads stay internal"; PW-05; threads lead T2 + T5,
 * 2026-11-17) on the local stack, with the app's real routes on a throwaway PostgreSQL 17 database (row-level security and the
 * guard triggers are real):
 *
 *   NOT SHAREABLE  a WorkOrder's, QualityHold's and Nonconformance's thread never takes a party, even when the record's resolver
 *                  names one (part 2 gives a work order its brand as a WALL party: made-up resolvers here stand in for it); the
 *                  office's mail or any shared message on it is refused in words (409 refusal/NOT_SHAREABLE); a portal or a link
 *                  reads it empty, also a thread that holds the party (a row made before the rule); the office's notes go on.
 *   T5             unfollowInCommand takes back ONE automatic follow (CREATOR or ASSIGNEE) of one person on one record inside the
 *                  caller's command, with the person's own unfollow's audit row and event; a chosen, a mentioned, another
 *                  reason's or a muted follow stays.
 *
 * Run with `node scripts/factory/run-pg-tests.mjs platform/threads/not-shareable`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const company = newId()
const site = newId()
const party = newId()
const author = newId()
const colleague = newId()
const account = newId()
const identity = newId()
/** One made-up record of each type that is never shared, and a quote (shared) for the control. */
const records = { WorkOrder: newId(), QualityHold: newId(), Nonconformance: newId() } as const
const legacy = { WorkOrder: newId(), QualityHold: newId(), Nonconformance: newId() } as const
const quote = newId()
const PRODUCTION = Object.keys(records) as Array<keyof typeof records>

const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const PARTNER_READ = [grant(['threads.read', 'files.read'])]
const OFFICE = [grant(['threads.read', 'threads.post', 'threads.manage', 'files.read', 'email.send'])]
const SESSIONS: Record<string, SessionContext> = {
  office: { audience: 'office', tenantId: tenant, actorId: author, grants: OFFICE },
  partner: { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: party, grants: PARTNER_READ },
  ...Object.fromEntries(PRODUCTION.map((type) => [`link-${type}`, { audience: 'link', tenantId: tenant, linkId: newId(), partyId: party, record: { type, id: records[type] }, grants: PARTNER_READ }])),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const count = async (sql: string, values: unknown[] = []): Promise<number> => (await admin<{ n: number }>(sql, values))[0]!.n
let keys = 0
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': `not-shareable-${++keys}-${newId()}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const office = () => callerFor(database, { audience: 'office', tenantId: tenant, actorId: author, grants: OFFICE, requestId: newId() })
const threadOf = async (recordId: string) => (await admin<{ id: string; partyId: string | null }>('SELECT id, "partyId" FROM "Thread" WHERE "recordId" = $1', [recordId]))[0]

/** The office's internal note on a record (201), through the route. */
async function note(type: string, id: string, body: string): Promise<Json> {
  const response = await call('office', 'POST', `/threads/${type}/${id}/notes`, { body })
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}

/** A shared message through the seam (OUTBOUND, as the email step writes it): the error it threw, or null when it was written. */
async function shareThroughSeam(type: string, id: string): Promise<unknown> {
  try {
    await command(office(), { name: 'email.send', input: { recordType: type, recordId: id } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type, id }, author)
      await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: author, name: 'Ada Author' }, bodyText: 'Made-up words for the customer.' })
      return null
    })
    return null
  } catch (error) {
    return error
  }
}

beforeAll(async () => {
  db = await migratedDatabase('threads_noshare')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'not-shareable'])
  await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [company, tenant, 'not-shareable-0'])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S1', 'Plant one', 'PLANT')`, [site, tenant, company])
  for (const [id, name] of [
    [author, 'Ada Author'],
    [colleague, 'Carlo Colleague'],
  ] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, $5)', [id, tenant, `${id.slice(-8)}@example.com`, name, 'ACTIVE'])
  }
  // The company's verified sending address: the office's mail reaches the thread seam (and nothing else stops it first).
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'SES', 'mail', 'Mail', 'FAKE')`, [account, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.not-shareable.example.com', 'office@mail.not-shareable.example.com', 'Made-up factory', 'reply.not-shareable.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [identity, tenant, company, account],
  )
  // Part 2 stand-ins: each production record's resolver names the party (its WALL party); the quote's is its customer.
  const production =
    (type: keyof typeof records): RecordResolver =>
    async (client, id) =>
      (id === records[type] || id === legacy[type]) && (await client.company.findUnique({ where: { id: company }, select: { id: true } })) ? { companyId: company, siteId: site, partyId: party } : null
  useThreadRecords({
    WorkOrder: production('WorkOrder'),
    QualityHold: production('QualityHold'),
    Nonconformance: production('Nonconformance'),
    Quote: async (client, id) => (id === quote && (await client.company.findUnique({ where: { id: company }, select: { id: true } })) ? { companyId: company, siteId: null, partyId: party } : null),
  })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 300_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-08a production threads are never shareable (PW-05)', () => {
  it('the one list: work orders, quality holds and nonconformances; every other thread type may share; the refusal in Italian and English names no customer', () => {
    expect([...NOT_SHAREABLE].sort()).toEqual(['Nonconformance', 'QualityHold', 'WorkOrder'])
    for (const type of NOT_SHAREABLE) expect(Object.hasOwn(THREAD_RECORDS, type), type).toBe(true)
    expect(Object.keys(THREAD_RECORDS).filter((type) => !mayShare(type)).sort()).toEqual(['Nonconformance', 'QualityHold', 'WorkOrder'])
    expect(NOT_SHAREABLE_REFUSAL.it).toContain('nota interna')
    expect(NOT_SHAREABLE_REFUSAL.en).toContain('internal note')
    for (const words of Object.values(NOT_SHAREABLE_REFUSAL)) expect(words).not.toMatch(/Brand|Alpha|Beta/)
  })

  it.each(PRODUCTION)('%s: the office writes notes; the thread never takes the party its resolver names (made, and on the next note)', async (type) => {
    const first = await note(type, records[type], `A made-up note on the ${type}.`)
    expect(first.thread).toMatchObject({ recordType: type, recordId: records[type], companyId: company, siteId: site, partyId: null })
    await note(type, records[type], 'A second made-up note.')
    expect(await threadOf(records[type])).toMatchObject({ partyId: null })
    const opened = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'threads.open' AND "recordId" = $1`, [first.thread.id])
    expect(opened.map((row) => row.after.partyId)).toEqual([null])
    expect(await count(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'threads.setParty' AND "recordId" = $1`, [first.thread.id])).toBe(0)
  })

  it.each(PRODUCTION)('%s: a shared message is refused in the seam, in words (409 refusal/NOT_SHAREABLE); nothing is written', async (type) => {
    const before = await count('SELECT count(*)::int AS n FROM "Message" WHERE "partyId" IS NOT NULL')
    const error = await shareThroughSeam(type, records[type])
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({ code: 'conflict', message: NOT_SHAREABLE_REFUSAL.en, issues: [{ path: 'refusal/NOT_SHAREABLE', message: NOT_SHAREABLE_REFUSAL.en }] })
    expect(await count('SELECT count(*)::int AS n FROM "Message" WHERE "partyId" IS NOT NULL')).toBe(before)
    expect(await count(`SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.audience = 'PARTNER'`, [records[type]])).toBe(0)
  })

  it.each(PRODUCTION)('%s: the office’s mail from the thread is refused in words (409 refusal/NOT_SHAREABLE); no mail is queued', async (type) => {
    const response = await call('office', 'POST', `/threads/${type}/${records[type]}/emails`, { to: ['buyer@customer.example.com'], subject: 'Made-up subject', body: 'Made-up words for the customer.' })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toMatchObject({ code: 'conflict', message: NOT_SHAREABLE_REFUSAL.en, issues: [{ path: 'refusal/NOT_SHAREABLE', message: NOT_SHAREABLE_REFUSAL.en }] })
    expect(await count('SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordId" = $1', [records[type]])).toBe(0)
  })

  it.each(PRODUCTION)('%s: a portal of the party and a link on the record read it empty, as "none" — also a thread that holds the party (made before the rule)', async (type) => {
    const empty = { thread: null, messages: [], nextCursor: null }
    const portal = await call('partner', 'GET', `/threads/${type}/${records[type]}`)
    expect(portal.statusCode, portal.body).toBe(200)
    expect(portal.json()).toEqual(empty)
    const link = await call(`link-${type}`, 'GET', `/threads/${type}/${records[type]}`)
    expect(link.statusCode, link.body).toBe(200)
    expect(link.json()).toEqual(empty)
    // A thread of the record that holds the party (as one made before the rule would): row-level security would show it to the
    // party's portal; the rule still gives it nothing.
    const made = await note(type, legacy[type], 'A made-up note before the rule.')
    await admin('UPDATE "Thread" SET "partyId" = $2 WHERE id = $1', [made.thread.id, party])
    const held = await call('partner', 'GET', `/threads/${type}/${legacy[type]}`)
    expect(held.statusCode, held.body).toBe(200)
    expect(held.json()).toEqual(empty)
    // …and nothing shared goes onto it either.
    expect(await shareThroughSeam(type, legacy[type])).toMatchObject({ code: 'conflict', issues: [{ path: 'refusal/NOT_SHAREABLE' }] })
    // The office still reads its notes (the control: the wall stands in front of partners, never in front of the office).
    expect(JSON.stringify((await call('office', 'GET', `/threads/${type}/${legacy[type]}`)).json())).toContain('A made-up note before the rule.')
  })

  it('the control: a quote still takes its customer and shares a message the customer reads', async () => {
    expect(await shareThroughSeam('Quote', quote)).toBeNull()
    expect(await threadOf(quote)).toMatchObject({ partyId: party })
    const read = await call('partner', 'GET', `/threads/Quote/${quote}`)
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().messages).toEqual([expect.objectContaining({ audience: 'PARTNER', body: 'Made-up words for the customer.' })])
  })
})

describe('B-PR-08a (T5) unfollowInCommand takes back one automatic follow inside the caller’s command', () => {
  const where = (recordId: string): FollowedRecord => ({ type: 'WorkOrder', id: recordId, companyId: company, siteId: site })
  /** One follow row of the colleague, as followInCommand (or the person) makes it. */
  async function follow(recordId: string, reason: 'CREATOR' | 'ASSIGNEE' | 'MENTIONED' | 'CHOSE', muted = false): Promise<void> {
    await command(office(), { name: 'threads.follow', input: { recordId, reason } }, async (tools) => {
      expect(await followInCommand(tools, where(recordId), colleague, reason, author)).toBe(true)
      return null
    })
    if (muted) await admin('UPDATE "RecordFollower" SET muted = true, version = version + 1 WHERE "recordId" = $1 AND "userId" = $2', [recordId, colleague])
  }
  async function unfollow(recordId: string, reason: AutomaticFollowReason): Promise<boolean> {
    const { result } = await command(office(), { name: 'production.supervisorFollows', input: { recordId, reason } }, async (tools) => {
      const gone = await unfollowInCommand(tools, where(recordId), colleague, reason)
      // A command records at least one audit row: the caller's own.
      tools.audit({ recordType: 'WorkOrder', recordId, companyId: company, siteId: site, after: { gone } })
      return gone
    })
    return result
  }
  const rowOf = async (recordId: string) => (await admin<{ reason: string; muted: boolean }>('SELECT reason, muted FROM "RecordFollower" WHERE "recordId" = $1 AND "userId" = $2', [recordId, colleague]))[0] ?? null
  const unfollows = (recordId: string) => admin<{ before: Json; after: Json; recordType: string; companyId: string; siteId: string }>(`SELECT before, after, "recordType", "companyId", "siteId" FROM "AuditLog" WHERE action = 'threads.unfollow' AND after->>'recordId' = $1`, [recordId])
  const events = (recordId: string) => count(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'thread.followers_changed' AND payload->>'recordId' = $1`, [recordId])

  it('an ASSIGNEE follow goes: the row, the person’s own unfollow’s audit row naming whose it was, and the followers event; a later assignment follows again', async () => {
    const recordId = newId()
    await follow(recordId, 'ASSIGNEE')
    const eventsBefore = await events(recordId)
    expect(await unfollow(recordId, 'ASSIGNEE')).toBe(true)
    expect(await rowOf(recordId)).toBeNull()
    expect(await unfollows(recordId)).toEqual([
      { recordType: 'RecordFollower', companyId: company, siteId: site, before: { reason: 'ASSIGNEE', muted: false }, after: { following: false, recordType: 'WorkOrder', recordId, userId: colleague } },
    ])
    expect(await events(recordId)).toBe(eventsBefore + 1)
    await follow(recordId, 'ASSIGNEE')
    expect(await rowOf(recordId)).toEqual({ reason: 'ASSIGNEE', muted: false })
  })

  it('a CREATOR follow goes when its reason is named, and only then', async () => {
    const recordId = newId()
    await follow(recordId, 'CREATOR')
    expect(await unfollow(recordId, 'ASSIGNEE')).toBe(false)
    expect(await rowOf(recordId)).toEqual({ reason: 'CREATOR', muted: false })
    expect(await unfollow(recordId, 'CREATOR')).toBe(true)
    expect(await rowOf(recordId)).toBeNull()
  })

  it.each([
    ['a follow the person chose', 'CHOSE', false],
    ['a mention’s follow', 'MENTIONED', false],
    ['a muted ASSIGNEE follow (the person’s own word)', 'ASSIGNEE', true],
  ] as const)('%s stays: no row removed, no audit row, no event', async (_, reason, muted) => {
    const recordId = newId()
    await follow(recordId, reason, muted)
    const eventsBefore = await events(recordId)
    for (const asked of ['ASSIGNEE', 'CREATOR'] as const) expect(await unfollow(recordId, asked)).toBe(false)
    // Even asked for its own reason by a caller that forced the type, a chosen or mentioned follow is never taken back.
    if (reason !== 'ASSIGNEE') expect(await unfollow(recordId, reason as unknown as AutomaticFollowReason)).toBe(false)
    expect(await rowOf(recordId)).toEqual({ reason, muted })
    expect(await unfollows(recordId)).toEqual([])
    expect(await events(recordId)).toBe(eventsBefore)
  })

  it('nobody following: nothing to take back, nothing recorded', async () => {
    const recordId = newId()
    expect(await unfollow(recordId, 'ASSIGNEE')).toBe(false)
    expect(await unfollows(recordId)).toEqual([])
    expect(await events(recordId)).toBe(0)
  })
})
