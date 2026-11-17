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
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedOptions } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createErrorTracker, useErrorTracker } from '../../../observability/tracker'

/**
 * B-TH-042 (threads plan G5; O-SAL-INQ-LIST.pane-actions-F08, O-SAL-INQ-REC.side, T5-F03; wall W20, W23, test T23): a prospect's
 * request gets its customer — GET /sales/inquiries/:inquiryId/customer checks who the prospect may already be (a contact's address,
 * the contacts' company domain, the name; only among the customers the reader may make a request for) and POST …/customer matches
 * one (asking first unless one of ITS contacts has the address) or makes one from the prospect (its contact with the lawful basis
 * carried), in ONE command; the mail the request came from then joins its thread, shared with the matched customer only. Through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (SEED-INQ-0003:
 * a prospect's request made from the mail an unknown sender wrote, the mail still in Mail to sort; SEED-INQ-0004: P1's own;
 * SEED-INQ-0006: LOST, its prospect erased). Made-up data only. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/inquiries/make-customer`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>

const NS = 'th042-make-customer'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const COMPANY_A = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')
const salesTemplate = templateOf('sales')!
const SALES = [...new Set([...salesTemplate.permissions, ...salesTemplate.grains.map((grain) => `money.${grain}`), 'parties.view', 'parties.manage', 'threads.read'])] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions, parties)] })
const partner = (partyId: string): SessionContext => ({ audience: 'partner', tenantId: T, actorId: newId(), partyId, grants: [{ permissions: ['threads.read'] as Permission[], companies: 'all', sites: 'all', parties: [partyId] }] }) as SessionContext
const SESSIONS: Record<string, SessionContext> = {
  sales: office(SALES),
  // Keeps requests but makes no customers.
  noParties: office(SALES.filter((name) => name !== 'parties.manage')),
  // W23: limited to the customer P3 — never told of P1, never matches to it.
  onlyP3: office(SALES, [P3]),
  portalP1: partner(P1),
  portalP3: partner(P3),
}

let h: Harness
let app: FastifyInstance
/** What the app logged as unexpected (a 500): none may be. */
const unexpected: unknown[] = []
const run = randomBytes(4).toString('hex')
const inject = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, 'x-run': run, 'idempotency-key': randomBytes(8).toString('hex') }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await inject(session, method, url, payload)
  expect(response.statusCode, `${response.body} ${JSON.stringify(unexpected.at(-1) ?? null)}`).toBe(status)
  return response.json()
}
async function refused(session: string, method: 'GET' | 'POST', url: string, payload: unknown, status: number, code?: string): Promise<Json> {
  const response = await inject(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  const body = response.json()
  if (code) expect(JSON.stringify(body.issues ?? body)).toContain(`refusal/${code}`)
  return body
}
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const byNumber = async (number: string): Promise<Json> => (await ok('sales', 'GET', '/sales/inquiries?tile=ALL')).rows.find((row: Json) => row.number === number)
const readOne = async (id: string): Promise<Json> => (await ok('sales', 'GET', `/sales/inquiries/${id}`)).inquiry
const check = (session: string, id: string) => ok(session, 'GET', `/sales/inquiries/${id}/customer`)
const answer = (session: string, id: string, body: Json, status = 200) => ok(session, 'POST', `/sales/inquiries/${id}/customer`, body, status)
/** A new prospect's request typed in the office (made-up names and addresses). */
async function prospectRequest(prospect: Json): Promise<Json> {
  return (await ok('sales', 'POST', '/sales/inquiries', { companyId: COMPANY_A, source: 'PHONE', prospect, request: 'Made-up: ten jackets for a club.' }, 201)).inquiry
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  h = await startHarness('th042_make_customer')
  // In the CLI's name order (each seed runs the ones it builds on itself).
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedOptions({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  // The office sessions are real people (a request's maker follows it).
  for (const [key, session] of Object.entries(SESSIONS)) {
    if (session.audience !== 'office') continue
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [session.actorId, T, `th042-${key}-${run}@example.test`, `Made-up ${key}`])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // P1 gets a contact at a company domain of its own (made up), so the check has something to find.
  await ok('sales', 'POST', `/parties/${P1}/contacts`, { name: 'Made-up Lead Alpha', email: 'lead@alpha-moto.example', roles: ['ORDERS'] }, 201)
}, 900_000)

afterAll(async () => {
  useErrorTracker(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('answer a new customer (B-TH-042)', () => {
  it('the check finds the customer by its contact’s address, its contacts’ domain and its name — the strongest first', async () => {
    const byAddress = await prospectRequest({ name: 'Made-up Lead', company: 'Alpha Moto Trading', email: 'lead@alpha-moto.example' })
    const found = await check('sales', byAddress.id)
    expect(found.candidates[0]).toMatchObject({ party: { id: P1 }, matchedBy: 'CONTACT', contact: { name: 'Made-up Lead Alpha' } })
    expect(found.ambiguous).toBe(false)
    expect(found.match.allowed).toBe(true)
    expect(found.make.allowed).toBe(true)
    expect(found.suggestion).toEqual({ code: 'ALPHA-MOTO-TRADING', legalName: 'Alpha Moto Trading', kind: 'ORGANISATION' })
    const byDomain = await prospectRequest({ name: 'Made-up Other', email: 'someone.else@alpha-moto.example' })
    expect((await check('sales', byDomain.id)).candidates).toEqual([expect.objectContaining({ party: expect.objectContaining({ id: P1 }), matchedBy: 'DOMAIN', contact: null })])
    // A shared mail provider's domain finds nobody by itself.
    const freeMail = await prospectRequest({ name: 'Made-up Free', email: 'lead.alpha@outlook.com' })
    expect((await check('sales', freeMail.id)).candidates).toEqual([])
  })

  it('a match by the customer’s own contact goes on alone: the customer and contact named, the prospect cleared, its own number given', async () => {
    const request = await prospectRequest({ name: 'Made-up Lead', company: 'Alpha Moto Trading', email: 'lead@alpha-moto.example', lawfulBasis: 'CONTRACT' })
    const done = await answer('sales', request.id, { version: request.version, match: { partyId: P1 } })
    expect(done).toMatchObject({ party: { id: P1 }, made: null, mailJoined: false })
    expect(done.contactId).toEqual(expect.any(String))
    expect(done.inquiry).toMatchObject({ party: { id: P1 }, prospect: false, prospectDetails: null, contact: { id: done.contactId } })
    const [row] = await admin<{ customerSeq: number | null; prospectEmail: string | null }>('SELECT "customerSeq", "prospectEmail" FROM "Inquiry" WHERE id = $1', [request.id])
    expect(row!.customerSeq).toBeGreaterThan(0)
    expect(row!.prospectEmail).toBeNull()
    // Again: it is P1's now.
    await refused('sales', 'POST', `/sales/inquiries/${request.id}/customer`, { version: done.inquiry.version, match: { partyId: P1 } }, 409, 'NOT_PROSPECT')
  })

  it('a match by domain, by name or by nothing asks first; confirmed, the prospect becomes a new contact of the customer with its lawful basis', async () => {
    const request = await prospectRequest({ name: 'Made-up Second Buyer', email: 'second.buyer@alpha-moto.example', phone: '+39 000 0000099', lawfulBasis: 'CONSENT' })
    const asked = await refused('sales', 'POST', `/sales/inquiries/${request.id}/customer`, { version: request.version, match: { partyId: P1, addContact: true } }, 409, 'CONFIRM_MATCH')
    expect(JSON.stringify(asked)).toContain('e-mail domain')
    const done = await answer('sales', request.id, { version: request.version, match: { partyId: P1, addContact: true }, confirmed: true })
    expect(done.made).toBe('CONTACT')
    const [contact] = await admin<{ partyId: string; name: string; email: string; phone: string; lawfulBasis: string; consentAt: Date | null; consentSource: string | null }>(
      'SELECT "partyId", name, email, phone, "lawfulBasis", "consentAt", "consentSource" FROM "PartyContact" WHERE id = $1',
      [done.contactId],
    )
    expect(contact).toMatchObject({ partyId: P1, name: 'Made-up Second Buyer', email: 'second.buyer@alpha-moto.example', lawfulBasis: 'CONSENT' })
    expect(contact!.consentAt).not.toBeNull()
    expect(contact!.consentSource).toContain(done.inquiry.number)
    // No personal data in the request's audit row.
    const audits = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Inquiry' AND "recordId" = $1 AND action = 'sales.inquiries.customer'`, [request.id])
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0]!.after)).not.toMatch(/second\.buyer|Second Buyer/)
  })

  it('make: a new customer and its contact from the prospect, in the request’s company; while the check found a customer it asks first', async () => {
    const fresh = await prospectRequest({ name: 'Made-up Gamma Buyer', company: 'Gamma Made-up Riders', email: 'buyer@gamma-riders.example', lawfulBasis: 'LEGITIMATE_INTEREST' })
    expect((await check('sales', fresh.id)).candidates).toEqual([])
    const made = await answer('sales', fresh.id, { version: fresh.version, make: {} })
    expect(made).toMatchObject({ made: 'CUSTOMER', party: { code: 'GAMMA-MADE-UP-RIDERS', name: 'Gamma Made-up Riders' } })
    const [party] = await admin<{ companyId: string | null; roles: string[]; status: string }>('SELECT "companyId", roles::text[] AS roles, status::text FROM "Party" WHERE id = $1', [made.party.id])
    expect(party).toEqual({ companyId: COMPANY_A, roles: ['CUSTOMER'], status: 'PROSPECT' })
    const [contact] = await admin<{ partyId: string; email: string; lawfulBasis: string }>('SELECT "partyId", email, "lawfulBasis" FROM "PartyContact" WHERE id = $1', [made.contactId])
    expect(contact).toEqual({ partyId: made.party.id, email: 'buyer@gamma-riders.example', lawfulBasis: 'LEGITIMATE_INTEREST' })
    expect(made.inquiry).toMatchObject({ party: { id: made.party.id }, contact: { id: made.contactId }, prospect: false })

    // The same code again is refused in words; a prospect the check ties to P1 asks before a new customer is made.
    const twin = await prospectRequest({ name: 'Made-up Twin', company: 'Gamma Made-up Riders', email: 'twin@other-riders.example' })
    await refused('sales', 'POST', `/sales/inquiries/${twin.id}/customer`, { version: twin.version, make: {}, confirmed: true }, 409, 'CODE_TAKEN')
    const known = await prospectRequest({ name: 'Made-up Known', email: 'third@alpha-moto.example' })
    const asked = await refused('sales', 'POST', `/sales/inquiries/${known.id}/customer`, { version: known.version, make: { code: 'ALPHA-TWO' } }, 409, 'MATCH_FOUND')
    expect(JSON.stringify(asked)).toContain('may already be a customer')
    const confirmed = await answer('sales', known.id, { version: known.version, make: { code: 'ALPHA-TWO' }, confirmed: true })
    expect(confirmed.made).toBe('CUSTOMER')
  })

  it('refused in words: not a prospect’s, closed, an erased prospect made a customer, no parties.manage, match and make at once', async () => {
    const own = await byNumber('SEED-INQ-0002')
    await refused('sales', 'POST', `/sales/inquiries/${own.id}/customer`, { version: own.version, match: { partyId: P3 } }, 409, 'NOT_PROSPECT')
    const quoted = await byNumber('SEED-INQ-0004')
    await refused('sales', 'POST', `/sales/inquiries/${quoted.id}/customer`, { version: quoted.version, match: { partyId: P1 } }, 409, 'CLOSED')
    const lost = await byNumber('SEED-INQ-0006')
    await refused('sales', 'POST', `/sales/inquiries/${lost.id}/customer`, { version: lost.version, make: {}, confirmed: true }, 409, 'CLOSED')
    const request = await prospectRequest({ name: 'Made-up Delta', company: 'Delta Made-up', email: 'd@delta-made-up.example' })
    const forbidden = await inject('noParties', 'POST', `/sales/inquiries/${request.id}/customer`, { version: request.version, make: {} })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.body).toContain('customers')
    expect(unexpected).toEqual([])
    expect((await check('noParties', request.id)).make.allowed).toBe(false)
    await refused('sales', 'POST', `/sales/inquiries/${request.id}/customer`, { version: request.version, make: {}, match: { partyId: P1 } }, 400)
    // A stale version is refused.
    await refused('sales', 'POST', `/sales/inquiries/${request.id}/customer`, { version: request.version + 5, make: {}, confirmed: true }, 409)
  })

  it('T23: matching to customer B asks first; its mail joins only the matched party; a person limited to B is never told of A', async () => {
    // SEED-INQ-0003: a prospect's request made from a mail that still waits in Mail to sort.
    const request = await byNumber('SEED-INQ-0003')
    const record = await readOne(request.id)
    expect(record.prospect).toBe(true)
    // P1's contacts share the prospect's mail domain? Not here: nothing ties it to P3 — the match asks first.
    await refused('sales', 'POST', `/sales/inquiries/${request.id}/customer`, { version: request.version, match: { partyId: P3 } }, 409, 'CONFIRM_MATCH')
    const done = await answer('sales', request.id, { version: request.version, match: { partyId: P3 }, confirmed: true })
    expect(done).toMatchObject({ party: { id: P3 }, mailJoined: true })
    const [mail] = await admin<{ status: string; threadId: string | null }>('SELECT status::text, "threadId" FROM "InboundEmail" WHERE id = (SELECT "sourceEmailId" FROM "Inquiry" WHERE id = $1)', [request.id])
    expect(mail!.status).toBe('MATCHED')
    const [thread] = await admin<{ id: string; partyId: string | null }>(`SELECT id, "partyId" FROM "Thread" WHERE "recordType" = 'Inquiry' AND "recordId" = $1`, [request.id])
    expect(thread).toEqual({ id: mail!.threadId, partyId: P3 })
    const messages = await admin<{ partyId: string | null; direction: string }>('SELECT "partyId", direction::text FROM "Message" WHERE "threadId" = $1', [thread!.id])
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((message) => message.partyId === P3)).toBe(true)
    // The matched customer reads it in its thread; the other customer reads nothing of it.
    const p3 = await ok('portalP3', 'GET', `/threads/Inquiry/${request.id}`)
    expect(p3.messages.length).toBeGreaterThan(0)
    const p1 = await inject('portalP1', 'GET', `/threads/Inquiry/${request.id}`)
    expect([403, 404].includes(p1.statusCode) || (p1.statusCode === 200 && p1.json().messages.length === 0), p1.body).toBe(true)

    // A person limited to P3 checking a prospect the domain ties to P1: P1 is never named, nor matchable by them.
    const tiedToP1 = await prospectRequest({ name: 'Made-up Fourth', email: 'fourth@alpha-moto.example' })
    const limited = await check('onlyP3', tiedToP1.id)
    expect(limited.candidates).toEqual([])
    expect(JSON.stringify(limited)).not.toContain(P1)
    const tried = await inject('onlyP3', 'POST', `/sales/inquiries/${tiedToP1.id}/customer`, { version: tiedToP1.version, match: { partyId: P1 }, confirmed: true })
    expect(tried.statusCode).toBe(400)
    expect(tried.body).not.toMatch(/Seed Customer|SEED-P1/)
  })
})
