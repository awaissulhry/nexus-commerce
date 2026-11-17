import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard } from '../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../search/partner/testing/world'
import { DRAFT_WORDS } from './drafts'

/**
 * B-TH-092 (threads plan TH-9, N6 = L2-G14; T5-F10, T8-F07, O-SAL-ORD-NEW.form-F07, P-HOME.actions-F02, P-CUS-NEW.message-F02; wall
 * W08: "a draft is read only by its writer"; the Owner's rule 2026-11-16: "One brand must not be able to see anything related to any
 * other brand"): drafts on the server.
 *
 *   the office      saves its draft of a reply on brand A's order (mode, words, fields), reads it back on "another computer", lists
 *                   it; a colleague reads none of it; a save from an older tab replaces the newer one and says so; sending the note
 *                   removes it
 *   brand A         its buyer keeps a reply draft on its own order (never an office note) and a New order draft ("Draft: Spring
 *                   jackets" on Home); a colleague of the same customer reads neither; its post removes the reply draft
 *   brand B         404 on a draft of brand A's order, and never lists brand A's drafts
 *
 * Base seeds in one namespace (two brands included), real portal sign-ins, office sessions by the test authenticator. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads`.
 */

let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let alpha: Browser
let colleague: Browser
let beta: Browser
let run = 0
let order = ''
const NS = 'th092draft'
const office = { writer: newId(), other: newId() }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sessions = (): Record<string, SessionContext> => {
  const grants: readonly Grant[] = [{ permissions: ['threads.read', 'threads.post', 'files.read'], companies: 'all', sites: 'all', parties: 'all' }]
  return { writer: { audience: 'office', tenantId: world.tenantId, actorId: office.writer, grants }, other: { audience: 'office', tenantId: world.tenantId, actorId: office.other, grants } }
}
const call = async (who: keyof typeof office, method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: Json) => {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th092-${++run}` }) }, ...(payload ? { payload } : {}) })
  return { status: response.statusCode, body: response.json() as Json }
}
const send = (browser: Browser, method: 'PUT' | 'DELETE' | 'POST', url: string, body?: Json) => browser.send(method, url, body ?? {}, { headers: { 'idempotency-key': `th092-${++run}` } })

beforeAll(async () => {
  h = await startHarness('drafts_th092')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const brandB = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId]))[0]!.id
  const buyerB = (await admin<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB]))[0]!
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  for (const [key, id] of Object.entries(office)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [id, world.tenantId, `th092-${key}@example.com`, `Made-up ${key}`])
  order = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001' AND "partyId" = $2`, [world.tenantId, world.p1]))[0]!.id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions()[String(request.headers['x-test-session'])] ?? null) },
  )
  // A colleague of the same customer with the same access as the buyer (buyer + can comment): the drafts stay each person's own.
  const mate: Person = { id: newId(), email: `mate.buyer.${NS}@studio-alpha.example`, name: 'Made-up Mate' }
  await inTenant(h, world, async (client) => {
    await client.user.create({ data: { id: mate.id, email: mate.email, displayName: mate.name, status: 'ACTIVE', audience: 'PARTNER', partyId: world.p1, partnerKind: 'CUSTOMER', locale: 'en' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment']) {
      const role = await client.role.findFirstOrThrow({ where: { key, audience: 'PARTNER' }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: mate.id, roleId: role.id, allCompanies: true, partyIds: [world.p1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  alpha = await signIn(h, world, world.people.buyer)
  colleague = await signIn(h, world, mate)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
})

describe('B-TH-092: the office’s draft, one per person and record', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('saved, read back elsewhere, listed as "Draft"; a colleague reads none of it', async () => {
    const saved = await call('writer', 'PUT', `/threads/SalesOrder/${order}/draft`, { audience: 'PARTNER', body: 'Made-up: we can ship in week 12 if', fields: { subject: 'Delivery', cc: ['buyer@example.com'] } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ draft: { recordType: 'SalesOrder', recordId: order, audience: 'PARTNER', body: 'Made-up: we can ship in week 12 if', fields: { subject: 'Delivery' }, version: 1 }, replacedNewer: false })
    const again = await call('writer', 'GET', `/threads/SalesOrder/${order}/draft`)
    expect(again.body.draft).toMatchObject({ body: 'Made-up: we can ship in week 12 if', savedAt: expect.any(String) })
    expect((await call('writer', 'GET', '/threads/drafts')).body.drafts).toEqual([expect.objectContaining({ recordType: 'SalesOrder', recordId: order, excerpt: 'Delivery' })])
    expect((await call('other', 'GET', `/threads/SalesOrder/${order}/draft`)).body.draft).toBeNull()
    expect((await call('other', 'GET', '/threads/drafts')).body.drafts).toEqual([])
    // The history says it was saved, never the words.
    const audits = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'threads.saveDraft' AND "recordType" = 'ComposerDraft'`, [world.tenantId])
    expect(audits.length).toBeGreaterThan(0)
    expect(JSON.stringify(audits)).not.toContain('week 12')
  })

  it('a save from an older tab replaces the newer draft and says so ("newest wins")', async () => {
    const second = await call('writer', 'PUT', `/threads/SalesOrder/${order}/draft`, { audience: 'PARTNER', body: 'Made-up: second tab', version: 1 })
    expect(second.body).toMatchObject({ draft: { version: 2 }, replacedNewer: false })
    const stale = await call('writer', 'PUT', `/threads/SalesOrder/${order}/draft`, { audience: 'OFFICE', body: 'Made-up: first tab again', version: 1 })
    expect(stale.body).toMatchObject({ draft: { body: 'Made-up: first tab again', audience: 'OFFICE', version: 3 }, replacedNewer: true })
  })

  it('sending the note removes the writer’s draft of the record; discarding one that is gone changes nothing', async () => {
    const note = await call('writer', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: first tab again' })
    expect(note.status, JSON.stringify(note.body)).toBe(201)
    expect((await call('writer', 'GET', `/threads/SalesOrder/${order}/draft`)).body.draft).toBeNull()
    expect((await call('writer', 'DELETE', `/threads/SalesOrder/${order}/draft`)).body).toEqual({ draft: null })
  })
})

describe('B-TH-092 / W08: the portal’s drafts are the writer’s own', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A’s buyer keeps a reply draft on its own order — never an office note; its colleague reads none of it', async () => {
    const office = await send(alpha, 'PUT', `/portal/threads/SalesOrder/${order}/draft`, { audience: 'OFFICE', body: 'Made-up.' })
    expect(office.status, JSON.stringify(office.body)).toBe(400)
    expect(JSON.stringify(office.body)).toContain(DRAFT_WORDS.OFFICE_FOR_PORTAL.en)
    const saved = await send(alpha, 'PUT', `/portal/threads/SalesOrder/${order}/draft`, { audience: 'PARTNER', body: 'Made-up: can we add two size L?' })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect((await alpha.get(`/portal/threads/SalesOrder/${order}/draft`)).body.draft).toMatchObject({ body: 'Made-up: can we add two size L?' })
    const theirs = await colleague.get(`/portal/threads/SalesOrder/${order}/draft`)
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200)
    expect(theirs.body.draft).toBeNull()
    const [row] = await admin<{ partyId: string | null }>(`SELECT "partyId" FROM "ComposerDraft" WHERE "tenantId" = $1 AND "userId" = $2 AND "recordId" = $3`, [world.tenantId, world.people.buyer.id, order])
    expect(row?.partyId).toBe(world.p1)
  })

  it('a New order draft shows on Home as "Draft: Spring jackets"; discarded, it is gone', async () => {
    const saved = await send(alpha, 'PUT', '/portal/drafts/new-request', { body: 'Made-up: 40 jackets for the spring', fields: { subject: 'Spring jackets', wantedDate: '2027-03-01' } })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.draft).toMatchObject({ recordType: null, recordId: null, fields: { subject: 'Spring jackets' } })
    const home = await alpha.get('/portal/drafts')
    expect(home.body.drafts).toEqual(expect.arrayContaining([expect.objectContaining({ recordType: null, excerpt: 'Spring jackets' }), expect.objectContaining({ recordType: 'SalesOrder', recordId: order })]))
    expect((await colleague.get('/portal/drafts')).body.drafts).toEqual([])
    expect((await send(alpha, 'DELETE', '/portal/drafts/new-request')).body).toEqual({ draft: null })
    expect((await alpha.get('/portal/drafts/new-request')).body.draft).toBeNull()
  })

  it('the buyer’s post removes their reply draft of the record', async () => {
    const posted = await send(alpha, 'POST', `/portal/threads/SalesOrder/${order}/messages`, { body: 'Made-up: can we add two size L?' })
    expect(posted.status, JSON.stringify(posted.body)).toBe(201)
    expect((await alpha.get(`/portal/threads/SalesOrder/${order}/draft`)).body.draft).toBeNull()
  })

  it('brand B gets 404 on a draft of brand A’s order and never lists brand A’s drafts', async () => {
    await send(alpha, 'PUT', `/portal/threads/SalesOrder/${order}/draft`, { audience: 'PARTNER', body: 'Made-up: a draft brand B must never read.' })
    for (const method of ['PUT', 'DELETE'] as const) {
      const answer = await send(beta, method, `/portal/threads/SalesOrder/${order}/draft`, { audience: 'PARTNER', body: 'Made-up.' })
      expect(answer.status, JSON.stringify(answer.body)).toBe(404)
    }
    const read = await beta.get(`/portal/threads/SalesOrder/${order}/draft`)
    expect(read.status, JSON.stringify(read.body)).toBe(404)
    expect(JSON.stringify((await beta.get('/portal/drafts')).body)).not.toMatch(/never read|SalesOrder/)
    expect((await alpha.get(`/portal/threads/SalesOrder/${order}/draft`)).body.draft).toMatchObject({ body: 'Made-up: a draft brand B must never read.' })
  })
})
