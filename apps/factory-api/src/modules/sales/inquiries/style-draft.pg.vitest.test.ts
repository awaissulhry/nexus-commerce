import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-026 — Make style draft from a request (threads plan TH-2, L2-G18; wall W12) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (row-level security and the TH-2 guard on a request's drafts are real), on the seeds up
 * to the sales intake (the brand P1 = SEED-C1, the customer P3 = SEED-C2 — no BRAND role —, the size scale of the jacket
 * SEED-JKT-01). Every word and code is made up.
 *
 *   - the production manager (product.styles.manage; reads requests, answers none) makes a DRAFT style for P1's own label from
 *     P1's request: the request's company, its subject as the name, the request open and unchanged, naming the draft;
 *   - W12: the draft's brand is the request's customer, never one the body names (the body has no brand field);
 *   - a request of a customer that is not a brand, a prospect's, a closed one: refused in words; a role that makes no styles: 403;
 *     a taken code: 409; the request names each draft once, in the order made.
 * Run with `node scripts/factory/run-pg-tests.mjs inquiries/style-draft`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST'

const NS = 'th2-style-draft'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')

const withGrains = (template: { permissions: readonly string[]; grains: readonly string[] }) => [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const PEOPLE = { ada: newId(), marco: newId() } as const
const SESSIONS: Record<string, SessionContext> = {
  ada: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(withGrains(templateOf('sales')!))] },
  marco: { audience: 'office', tenantId: T, actorId: PEOPLE.marco, grants: [grant(withGrains(templateOf('production_manager')!))] },
  // ---- B-TH-261: a product-office reader of styles who reads no requests, and an office person limited to the customer P3 ----
  paola: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['product.styles.view'] as Permission[])] },
  limited: { audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: ['product.styles.view', 'sales.inquiries.view'] as Permission[], companies: 'all', sites: 'all', parties: [P3] }] },
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `sd-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')

let scale = ''
const code = (key: string) => `TH2-${key}-${run}`.toUpperCase().slice(0, 30)

async function request(partyId: string | null, words = 'Made-up: a racing jacket with our own logo, in black.'): Promise<Json> {
  const { inquiry } = await ok('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', ...(partyId ? { partyId } : { prospect: { company: 'Made-up Moto Club' } }), request: words, lines: [{ description: 'Made-up: racing jacket, own logo', quantity: 20 }] }, 201)
  return inquiry
}
const draftBody = (version: number, key: string, extra: Json = {}) => ({ version, code: code(key), productType: 'JACKET', sizeScaleId: scale, sizes: ['50', '52'], baseSize: '52', ppeCategory: 'NOT_PPE', ...extra })

beforeAll(async () => {
  h = await startHarness('th2_style_draft')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE)) {
    const role = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, person === 'marco' ? 'production_manager' : 'sales'])).id
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, role])
  }
  scale = (await one('SELECT "sizeScaleId" FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).sizeScaleId
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-026 Make style draft from a request', () => {
  let asked: Json

  it('the production manager makes a DRAFT style for P1’s own label from P1’s request; the request stays open and names it', async () => {
    asked = await request(P1)
    const seen = (await ok('marco', 'GET', `/sales/inquiries/${asked.id}`)).inquiry
    // He reads requests and answers none (READ_ONLY), but Make style draft is the product office's: allowed.
    expect(seen.actions.quote).toMatchObject({ allowed: false, refusal: { code: 'READ_ONLY' } })
    expect(seen.actions.styleDraft).toEqual({ allowed: true, refusal: null })
    const made = await ok('marco', 'POST', `/sales/inquiries/${asked.id}/style-draft`, draftBody(seen.version, 'A1'), 201)
    expect(made.style).toMatchObject({ code: code('A1'), name: 'Made-up: a racing jacket with our own logo, in black.', status: 'DRAFT' })
    expect(await one('SELECT "brandPartyId", "companyId", status FROM "Style" WHERE id = $1', [made.style.id])).toEqual({ brandPartyId: P1, companyId: companyA, status: 'DRAFT' })
    expect(made.inquiry).toMatchObject({ status: asked.status, styleDrafts: [{ id: made.style.id, code: code('A1'), status: 'DRAFT' }] })
    expect(await one('SELECT status, "styleIds" FROM "Inquiry" WHERE id = $1', [asked.id])).toEqual({ status: asked.status, styleIds: [made.style.id] })
    expect(made.files).toEqual({ carried: [], notCarried: [] })
    // A second draft is named after the first; sales reads both on the request.
    const second = await ok('marco', 'POST', `/sales/inquiries/${asked.id}/style-draft`, draftBody(made.inquiry.version, 'A2', { name: 'Made-up racing jacket, light' }), 201)
    expect((await ok('ada', 'GET', `/sales/inquiries/${asked.id}`)).inquiry.styleDrafts.map((draft: Json) => draft.id)).toEqual([made.style.id, second.style.id])
  })

  it('W12: the body names no brand — a brand, a company or a party sent is refused before anything is made', async () => {
    const fresh = await request(P1)
    for (const extra of [{ brandPartyId: P3 }, { companyId: newId() }, { partyId: P3 }]) {
      expect((await call('marco', 'POST', `/sales/inquiries/${fresh.id}/style-draft`, draftBody(fresh.version, 'W12', extra))).statusCode).toBe(400)
    }
    expect((await admin('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code('W12')])).length).toBe(0)
  })

  it('a customer that is not a brand, a prospect, a closed request: refused in words; sales (no product.styles.manage): 403; a taken code: 409', async () => {
    const ofCustomer = await request(P3)
    expect(JSON.stringify((await no('marco', 'POST', `/sales/inquiries/${ofCustomer.id}/style-draft`, draftBody(ofCustomer.version, 'C3'), 400)).issues)).toContain('not a brand')
    const prospect = await request(null)
    const fromProspect = await no('marco', 'POST', `/sales/inquiries/${prospect.id}/style-draft`, draftBody(prospect.version, 'PR'), 409)
    expect(refusal(fromProspect)).toBe('refusal/NEEDS_CUSTOMER')
    const lost = await request(P1)
    const closed = await ok('ada', 'POST', `/sales/inquiries/${lost.id}/lost`, { version: lost.version, note: 'Made-up: they went elsewhere.' })
    expect(refusal(await no('marco', 'POST', `/sales/inquiries/${lost.id}/style-draft`, draftBody(closed.inquiry.version, 'CL'), 409))).toBe('refusal/CLOSED')
    const fresh = await request(P1)
    expect((await ok('ada', 'GET', `/sales/inquiries/${fresh.id}`)).inquiry.actions.styleDraft.allowed).toBe(false)
    await no('ada', 'POST', `/sales/inquiries/${fresh.id}/style-draft`, draftBody(fresh.version, 'S1'), 403)
    expect((await no('marco', 'POST', `/sales/inquiries/${fresh.id}/style-draft`, draftBody(fresh.version, 'A1'), 409)).message).toContain('is taken')
    expect((await one('SELECT "styleIds" FROM "Inquiry" WHERE id = $1', [fresh.id])).styleIds).toEqual([])
  })
})

// ---- B-TH-261 (threads plan TH-6; O-PRD-STY.band): the style page says "Made from INQ-…" for a draft a request made ------------------
describe('B-TH-261 the request a style draft was made from (GET /sales/inquiries/source?styleId=)', () => {
  it('the draft names its request to a reader of requests; a style made without one answers null; the same request for every draft', async () => {
    const asked = await request(P1)
    const seen = (await ok('marco', 'GET', `/sales/inquiries/${asked.id}`)).inquiry
    const made = await ok('marco', 'POST', `/sales/inquiries/${asked.id}/style-draft`, draftBody(seen.version, 'MF1'), 201)
    const second = await ok('marco', 'POST', `/sales/inquiries/${asked.id}/style-draft`, draftBody(made.inquiry.version, 'MF2'), 201)
    for (const style of [made.style.id, second.style.id]) {
      const source = (await ok('marco', 'GET', `/sales/inquiries/source?styleId=${style}`)).inquiry
      expect(source).toMatchObject({ id: asked.id, number: asked.number })
    }
    const seeded = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
    expect((await ok('marco', 'GET', `/sales/inquiries/source?styleId=${seeded}`)).inquiry).toBeNull()
  })

  it('a reader of styles who reads no requests is refused (the route asks sales.inquiries.view; the page asks only with it); the wall: another customer’s person gets 404', async () => {
    const asked = await request(P1)
    const seen = (await ok('marco', 'GET', `/sales/inquiries/${asked.id}`)).inquiry
    const made = await ok('marco', 'POST', `/sales/inquiries/${asked.id}/style-draft`, draftBody(seen.version, 'MF3'), 201)
    const quiet = await call('paola', 'GET', `/sales/inquiries/source?styleId=${made.style.id}`)
    expect(quiet.statusCode).toBe(403)
    expect(quiet.body).not.toContain(asked.number)
    // W12 / W27: P1's own-label style does not exist for a person limited to P3 — the same 404 as an unknown style, no request named.
    const walled = await call('limited', 'GET', `/sales/inquiries/source?styleId=${made.style.id}`)
    expect(walled.statusCode).toBe(404)
    expect(walled.body).not.toContain(asked.number)
    expect(walled.body).not.toContain(made.style.code)
    expect((await call('limited', 'GET', `/sales/inquiries/source?styleId=${newId()}`)).statusCode).toBe(404)
  })

  it('exactly one of quote, order or style: two named, or none, is refused in words (400)', async () => {
    const style = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
    expect(String((await no('marco', 'GET', `/sales/inquiries/source?styleId=${style}&quoteId=${newId()}`, undefined, 400)).message)).toContain('one of them')
    await no('marco', 'GET', '/sales/inquiries/source', undefined, 400)
  })
})
// ---- end B-TH-261
