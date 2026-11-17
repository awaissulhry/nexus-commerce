import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { fanOut } from '../../notifications/fan-out'
import { systemContext } from '../../outbox/system'
import { useThreadRecords, type RecordScope } from '../../threads/records'
import { ensureThread, writeMessage } from '../../threads/threads'
import { runDigests } from './digest'
import { partnerQuotes, QUOTE_MAX_CHARACTERS, quoteOf } from './message-text'

/**
 * B-TH-080 (threads plan TH-6, thread-G11; T06, T31): a notification mail carries the message it is about, cut per reader.
 *
 *   - the office's instant mail and daily digest quote the note a mention points at — and not for a person who may no longer
 *     read that record's thread (their access moved to another company after the mention);
 *   - a customer's portal mail quotes only a message we shared with THAT customer: never an internal note, never another
 *     customer's message (brand B's mail never holds brand A's text; the quotes are cut here, the mail composed by
 *     factory-domain portal/notifications/mail, whose own test renders them).
 *
 * The local stack: a throwaway PostgreSQL 17 from the migrations (the runtime login, the threads and notification guards
 * real), the real routes and fan-out, people with live role assignments, FAKE SES for the mails. Two made-up customers
 * (Brand Alpha, Brand Beta) and their made-up quotes. Run with `node scripts/factory/run-pg-tests.mjs email-out/digest/message-text`.
 */

vi.setConfig({ testTimeout: 120_000 })

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let company: string
let otherCompany: string

const PEOPLE = { sales: newId(), planner: newId(), reader: newId(), mover: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { sales: 'sales', planner: 'planner', reader: 'planner', mover: 'planner' }
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const sessions = new Map<string, SessionContext>()
let serial = 0
async function ok(who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th080-key-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function person(id: string, key: string, roleKey: string): Promise<void> {
  const roleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [tenant.id, roleKey]))[0]!.id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, 'ACTIVE', 'en')`, [id, tenant.id, `${key}@message-text.example.com`, `Person ${key}`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '1 day')`, [newId(), tenant.id, id, roleId])
  sessions.set(key, { audience: 'office', tenantId: tenant.id, actorId: id, grants: [grantOf(roleKey)] })
}

let mark = new Date(0)
const system = () => callerFor(h.database, systemContext(tenant.id, `test-${newId()}`))
async function fanOutSince(): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [tenant.id, ['thread.user_mentioned', 'thread.message_posted'], mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(system(), envelope)
  }
  return made
}
const mention = (whom: Person[], body: string) => ok('sales', 'POST', `/threads/Company/${company}/notes`, { body, mentions: whom.map((key) => PEOPLE[key]) }, 201)
const mailsTo = (key: Person, from: number) => h.ses.mails.slice(from).filter((mail) => mail.to.includes(`${key}@message-text.example.com`))

// Two made-up customers and a quote of each (the threads seam's record resolver, as the threads tests do).
const brandA = newId()
const brandB = newId()
const quoteA = newId()
const quoteB = newId()
const quotes = new Map<string, string>([
  [quoteA, brandA],
  [quoteB, brandB],
])

beforeAll(async () => {
  h = await startHarness('message_text_th080')
  h.clock.set(new Date())
  tenant = await addTenant(h, 'message-text-th080', 2)
  company = tenant.companies[0]!.id
  otherCompany = tenant.companies[1]!.id
  for (const [key, id] of Object.entries(PEOPLE)) await person(id, key, ROLE_OF[key as Person])
  for (const [id, code, name] of [
    [brandA, 'BRAND-ALPHA', 'Brand Alpha S.r.l.'],
    [brandB, 'BRAND-BETA', 'Brand Beta GmbH'],
  ] as const) {
    await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{CUSTOMER}')`, [id, tenant.id, company, code, name])
  }
  useThreadRecords({
    Quote: async (client, id): Promise<RecordScope | null> => {
      const partyId = quotes.get(id)
      if (!partyId || !(await client.company.findUnique({ where: { id: company }, select: { id: true } }))) return null
      return { companyId: company, siteId: null, partyId }
    },
  })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions.get(String(request.headers['x-test-session'])) ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await app?.close()
  await h?.close()
})

describe('B-TH-080: the office mail quotes the message, cut per reader', () => {
  it('the instant mail of a mention quotes the note under its sentence', async () => {
    await ok('planner', 'PUT', '/notifications/preferences', { event: 'MENTIONED', channel: 'EMAIL', cadence: 'INSTANT' })
    mark = new Date()
    const before = h.ses.mails.length
    await mention(['planner'], 'Planner: check the delivery plan for AX-100 before Friday.')
    expect(await fanOutSince()).toBeGreaterThan(0)
    const [mail] = mailsTo('planner', before)
    expect(mail?.templateKey).toBe('notifications.instant')
    const text = textOf(mail!.raw)
    expect(text).toContain('Person sales mentioned you on C1')
    expect(text).toContain('“Planner: check the delivery plan for AX-100 before Friday.”')
  })

  it('the daily digest quotes each note; a person who may no longer read the thread gets the line, never the text', async () => {
    for (const key of ['reader', 'mover'] as const) await ok(key, 'PUT', '/notifications/digest', { on: true, sendTime: '00:00', weekdays: [1, 2, 3, 4, 5, 6, 7], categories: ['MENTION'], version: 0 })
    mark = new Date()
    await mention(['reader', 'mover'], 'Reader and mover: the size chart BX-200 is the new one.')
    expect(await fanOutSince()).toBeGreaterThan(0)
    // The mover's access moves to the other company after the mention (the company's threads no longer theirs).
    await admin(`SET session_replication_role = replica`)
    try {
      await admin(`UPDATE "RoleAssignment" SET "allCompanies" = false, "companyIds" = ARRAY[$2]::uuid[] WHERE "userId" = $1`, [PEOPLE.mover, otherCompany])
    } finally {
      await admin(`SET session_replication_role = DEFAULT`)
    }
    const before = h.ses.mails.length
    const result = await runDigests({ database: h.database, log: { info() {}, warn() {}, error() {} }, runtime: () => h.email })
    expect(result.sent).toBeGreaterThanOrEqual(2)
    const reader = textOf(mailsTo('reader', before)[0]!.raw)
    expect(reader).toContain('Person sales mentioned you on C1')
    expect(reader).toContain('“Reader and mover: the size chart BX-200 is the new one.”')
    const mover = textOf(mailsTo('mover', before)[0]!.raw)
    expect(mover).toContain('Person sales mentioned you on C1')
    expect(mover).not.toContain('BX-200')
  })
})

describe('B-TH-080: a customer’s mail quotes only a message shared with that customer (T06, T31)', () => {
  it('brand A: our shared message — never the internal note of its record, never brand B’s message', async () => {
    const office = callerFor(h.database, { audience: 'office', tenantId: tenant.id, actorId: PEOPLE.sales, grants: [grantOf('sales')], requestId: newId() })
    const { result } = await command(office, { name: 'email.send', input: { quoteA, quoteB } }, async (tools) => {
      const a = (await ensureThread(tools, { type: 'Quote', id: quoteA }, PEOPLE.sales)).thread
      const b = (await ensureThread(tools, { type: 'Quote', id: quoteB }, PEOPLE.sales)).thread
      const author = { kind: 'USER' as const, id: PEOPLE.sales, name: 'Person sales' }
      const sharedA = await writeMessage(tools, a, { direction: 'OUTBOUND', channel: 'EMAIL', author, bodyText: 'Alpha: your jackets AX-100 ship on Monday.' })
      const noteA = await writeMessage(tools, a, { direction: 'INTERNAL_NOTE', channel: 'APP', author, bodyText: 'Internal: Alpha pays late, keep the margin.' })
      const sharedB = await writeMessage(tools, b, { direction: 'OUTBOUND', channel: 'EMAIL', author, bodyText: 'Beta: the size chart BX-200 is approved.' })
      return { sharedA: sharedA.id, noteA: noteA.id, sharedB: sharedB.id }
    })
    const notices = [
      { id: 'shared-a', anchor: `message:${result.sharedA}` },
      { id: 'note-a', anchor: `message:${result.noteA}` },
      { id: 'shared-b', anchor: `message:${result.sharedB}` },
      { id: 'no-message', anchor: null },
      { id: 'not-an-id', anchor: 'message:x' },
    ]
    const ofA = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.sales }, (client) => partnerQuotes(client, brandA, notices))
    expect([...ofA.entries()]).toEqual([['shared-a', 'Alpha: your jackets AX-100 ship on Monday.']])
    const ofB = await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.sales }, (client) => partnerQuotes(client, brandB, notices))
    expect([...ofB.entries()]).toEqual([['shared-b', 'Beta: the size chart BX-200 is approved.']])
    // T00 of these mails: brand B's quotes hold none of brand A's words, and no note reaches either.
    for (const word of ['Alpha', 'AX-100', 'Internal', 'margin']) expect(JSON.stringify([...ofB.values()])).not.toContain(word)
    expect(JSON.stringify([...ofA.values()])).not.toContain('Internal')
  })

  it('a quote is the plain text, spaces folded, cut at its length', () => {
    expect(quoteOf('  Two\n\nlines\tand  spaces  ')).toBe('Two lines and spaces')
    expect(quoteOf('   ')).toBeNull()
    const long = quoteOf('x'.repeat(QUOTE_MAX_CHARACTERS + 50))!
    expect(long).toHaveLength(QUOTE_MAX_CHARACTERS)
    expect(long.endsWith('…')).toBe(true)
  })
})
