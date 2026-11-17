import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'

/**
 * B-TH-049 (threads plan TH-3, gap N7; features T8-F04 "Amount field", T5-F06 "For the floor", PL8-F03; wall W08: "the amount never
 * reaches a partner session nor the floor") through the app's real routes on a throwaway PostgreSQL 17 database from the migrations,
 * every factory-db seed (customer A = SEED-C1 with its orders, customer B = SEED-C2, the work order SEED-WO-0001).
 *
 *   - an office note takes a price in its amount field (minor units, ISO 4217): a reader holding the price grain reads it, a reader
 *     without the grain gets the note without the field, a portal reader gets neither the note nor the field; the audit row keeps it
 *     as marked money;
 *   - a person without the price grain cannot send one (403), an amount is never on a note for the floor (400 in words), never on a
 *     portal reply (its body takes none);
 *   - a note for the floor whose words look like a price is held (409 refusal/FLOOR_PRICE, the words named) and nothing is written;
 *     the same words stay possible in an office note; a floor note of pieces and sizes goes.
 * Every name and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/message-amount`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'message-amount-th049'
const T = seedUuid(NS, 'tenant')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const OFFICE = { priced: newId(), plain: newId() } as const
const grant = (permissions: string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
const WRITE = ['threads.read', 'threads.post', 'files.read']
const SESSIONS: Record<string, SessionContext> = {
  priced: { audience: 'office', tenantId: T, actorId: OFFICE.priced, grants: [grant([...WRITE, 'money.price'])] },
  plain: { audience: 'office', tenantId: T, actorId: OFFICE.plain, grants: [grant(WRITE)] },
  portalA: { audience: 'partner', tenantId: T, actorId: newId(), partyId: partyA, grants: [grant(['threads.read', 'files.read', 'money.price'], [partyA])] },
  portalB: { audience: 'partner', tenantId: T, actorId: newId(), partyId: partyB, grants: [grant(['threads.read', 'files.read', 'money.price'], [partyB])] },
}

let h: Harness
let app: FastifyInstance
let run = 0
let order = ''
let workOrder = ''
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th049-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(who, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const issuesOf = (answer: Json): Json[] => answer.error?.issues ?? answer.issues ?? []
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const messageCount = async (recordType: string, recordId: string) =>
  (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."tenantId" = $1 AND t."recordType" = $2 AND t."recordId" = $3', [T, recordType, recordId]))[0]!.n

beforeAll(async () => {
  h = await startHarness('message_amount_th049')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  for (const [person, userId] of Object.entries(OFFICE)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [userId, T, `th049-${person}@example.com`, `Made-up ${person}`])
  order = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 1', [T, partyA]))[0]!.id
  workOrder = (await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T]))[0]!.id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-049 a typed amount on a message', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an office note takes a price in its amount field: the price grain reads it, a reader without it gets the note without it', async () => {
    const posted = await ok('priced', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: agreed with the buyer on the phone.', amount: { value: 12_50, currency: 'EUR' } }, 201)
    expect(posted.message).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', forFloor: false, amount: { value: 1250, currency: 'EUR' } })
    const stored = (await admin<Json>('SELECT amount, "amountCurrency", audience::text AS audience, "forFloor" FROM "Message" WHERE id = $1', [posted.message.id]))[0]
    expect(stored).toEqual({ amount: 1250, amountCurrency: 'EUR', audience: 'OFFICE', forFloor: false })
    // The price grain reads it on the thread; a note without one answers amount null.
    const priced = (await ok('priced', 'GET', `/threads/SalesOrder/${order}`)).messages as Json[]
    expect(priced.find((message) => message.id === posted.message.id)?.amount).toEqual({ value: 1250, currency: 'EUR' })
    const without = await ok('priced', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: no price in this one.' }, 201)
    expect(without.message.amount).toBeNull()
    // Without the grain: the same note, no amount field at all (money.price drops it).
    const plain = (await ok('plain', 'GET', `/threads/SalesOrder/${order}`)).messages as Json[]
    const seen = plain.find((message) => message.id === posted.message.id)!
    expect(seen.body).toBe('Made-up: agreed with the buyer on the phone.')
    expect(Object.keys(seen)).not.toContain('amount')
    // The history keeps it as marked money (shown only with the grain).
    const audit = (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'Message' AND "recordId" = $2`, [T, posted.message.id]))[0]!
    expect(audit.after.amount).toEqual({ $money: 'price', value: { value: 1250, currency: 'EUR' } })
  })

  it('W08: a portal reader of the order gets neither the office note nor an amount field; customer B gets nothing of the thread', async () => {
    await ok('priced', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: margin is thin on this one.', amount: { value: 99_00, currency: 'EUR' } }, 201)
    const portal = await ok('portalA', 'GET', `/threads/SalesOrder/${order}`)
    expect(JSON.stringify(portal)).not.toContain('margin is thin')
    expect(keysOf(portal)).not.toContain('amount')
    expect(keysOf(portal)).not.toContain('amountCurrency')
    const other = await call('portalB', 'GET', `/threads/SalesOrder/${order}`)
    expect([200, 404]).toContain(other.statusCode)
    expect(other.body).not.toContain('margin is thin')
    if (other.statusCode === 200) expect((other.json() as Json).messages).toEqual([])
  })

  it('refused in words: no price grain (403), an amount on a note for the floor (400), a bad currency or figure (400), a portal reply (400)', async () => {
    const before = await messageCount('SalesOrder', order)
    const forbidden = await call('plain', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: a price I may not see.', amount: { value: 100, currency: 'EUR' } })
    expect(forbidden.statusCode).toBe(403)
    expect(issuesOf(forbidden.json() as Json).some((issue) => String(issue.path).endsWith('amount'))).toBe(true)
    const floor = await call('priced', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: sew the collar first.', forFloor: true, amount: { value: 100, currency: 'EUR' } })
    expect(floor.statusCode, floor.body).toBe(400)
    expect(issuesOf(floor.json() as Json)).toEqual([expect.objectContaining({ path: 'body/amount', message: expect.stringContaining('stays in the office') })])
    for (const amount of [{ value: 100, currency: 'eur' }, { value: -5, currency: 'EUR' }, { value: 1.5, currency: 'EUR' }]) {
      expect((await call('priced', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up.', amount })).statusCode, JSON.stringify(amount)).toBe(400)
    }
    const reply = await call('priced', 'POST', `/threads/SalesOrder/${order}/replies`, { body: 'Made-up: your price.', amount: { value: 100, currency: 'EUR' } })
    expect(reply.statusCode).toBe(400)
    expect(await messageCount('SalesOrder', order)).toBe(before)
  })
})

describe('B-TH-049 the price check before a note goes to the floor', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a floor note whose words look like a price is held with the reason; nothing is written', async () => {
    const before = await messageCount('WorkOrder', workOrder)
    for (const body of ['Made-up: il cliente paga € 12,50 al pezzo', 'Made-up: price agreed at 30 EUR', 'Made-up: prezzo: 42 per capo']) {
      const held = await call('priced', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body, forFloor: true })
      expect(held.statusCode, held.body).toBe(409)
      const issue = issuesOf(held.json() as Json).find((entry) => String(entry.path).startsWith('refusal/'))
      expect(issue?.path).toBe('refusal/FLOOR_PRICE')
      expect(issue?.message).toMatch(/looks like a price.*amount field/)
    }
    expect(await messageCount('WorkOrder', workOrder)).toBe(before)
  })

  it('the same words stay possible in an office note; a floor note of pieces and sizes goes to the floor', async () => {
    const office = await ok('priced', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: il cliente paga € 12,50 al pezzo' }, 201)
    expect(office.message).toMatchObject({ forFloor: false, audience: 'OFFICE' })
    const floor = await ok('priced', 'POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: taglia 48, 30 pezzi, cucire il collo prima delle maniche.', forFloor: true }, 201)
    expect(floor.message).toMatchObject({ forFloor: true, amount: null })
  })
})
