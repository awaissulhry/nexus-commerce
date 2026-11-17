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
 * The office's New request (B-TH-221; threads plan O-SAL-INQ-LIST.band-F02, walls W23 and W37) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations, on the seeds up to the sales intake (the brand P1 = SEED-C1 with its
 * workshop as a delivery address, the customer P3 = SEED-C2 with its office as one, the supplier P2):
 *   - GET /sales/inquiries/customers lists the customers a person may make a request for: everyone's for a person who reaches
 *     every customer; ONLY customer A's for a person limited to A — also when their parties.view reaches every customer — never
 *     a supplier; nothing for a role without sales.inquiries.manage;
 *   - POST /sales/inquiries keeps the customer's PO and one of ITS delivery addresses; another customer's address and an address
 *     with a prospect are refused at the field; a prospect keeps the lawful basis it was given;
 *   - "Make an inquiry" from a mail takes the same PO and delivery address.
 * Every name and word is made up. Run with `node scripts/factory/run-pg-tests.mjs inquiries/new-request`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>

const NS = 'th1b-new-request'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P2 = idOf('party:P2')
const P3 = idOf('party:P3')
const P1_SHIP_TO = idOf('party-address:P1:workshop')
const P1_OFFICE = idOf('party-address:P1:office') // registered and billing only: no delivery address
const P3_SHIP_TO = idOf('party-address:P3:office')

const sales = templateOf('sales')!
const SALES = [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const ADA = newId()
const LIMITED = newId()
const SESSIONS: Record<string, SessionContext> = {
  ada: { audience: 'office', tenantId: T, actorId: ADA, grants: [grant(SALES)] },
  // Sales for customer P1 only (RoleAssignment.partyIds).
  limited: { audience: 'office', tenantId: T, actorId: LIMITED, grants: [grant(SALES, [P1])] },
  // Reads every customer's record, but keeps requests for P1 only: the picker follows the requests.
  wideReader: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['parties.view'] as Permission[]), grant(SALES, [P1])] },
  planner: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(templateOf('planner')!.permissions as Permission[])] },
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `nr-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: 'GET' | 'POST', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const codes = (answer: Json): string[] => answer.customers.map((row: Json) => row.code)

beforeAll(async () => {
  h = await startHarness('inq_new_request')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  const salesRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  for (const [person, userId] of [['ada', ADA], ['limited', LIMITED]] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `th1b-${person}-${run}@example.test`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], $5::uuid[], now() - interval '30 days')`, [newId(), T, userId, salesRole, person === 'limited' ? [P1] : []])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('New request’s customer picker (B-TH-221, W23)', () => {
  it('lists every customer and brand for a person who reaches every customer — never a supplier', async () => {
    const answer = await ok('ada', 'GET', `/sales/inquiries/customers?companyId=${companyA}`)
    expect(codes(answer)).toEqual(expect.arrayContaining(['SEED-C1', 'SEED-C2']))
    expect(codes(answer)).not.toContain('SEED-S1')
    expect(answer.customers.find((row: Json) => row.id === P2)).toBeUndefined()
    expect(answer).toMatchObject({ limited: false, total: answer.customers.length })
  })

  it('lists ONLY customer A for a person limited to A: B’s name, code and count are not there', async () => {
    const answer = await ok('limited', 'GET', `/sales/inquiries/customers?companyId=${companyA}`)
    expect(answer.customers.map((row: Json) => [row.id, row.code])).toEqual([[P1, 'SEED-C1']])
    expect(answer).toMatchObject({ total: 1, limited: true })
    expect(JSON.stringify(answer)).not.toContain('SEED-C2')
    // A search for B's code finds nothing.
    expect(await ok('limited', 'GET', `/sales/inquiries/customers?companyId=${companyA}&q=SEED-C2`)).toEqual({ customers: [], total: 0, limited: true })
  })

  it('follows the requests a person keeps, not the customers they may read', async () => {
    const answer = await ok('wideReader', 'GET', `/sales/inquiries/customers?companyId=${companyA}`)
    expect(codes(answer)).toEqual(['SEED-C1'])
    expect(answer.limited).toBe(true)
  })

  it('finds by code or name; a role without sales.inquiries.manage is refused', async () => {
    expect(codes(await ok('ada', 'GET', `/sales/inquiries/customers?companyId=${companyA}&q=seed-c2`))).toEqual(['SEED-C2'])
    expect((await call('planner', 'GET', `/sales/inquiries/customers?companyId=${companyA}`)).statusCode).toBe(403)
  })
})

describe('New request keeps the customer’s PO and one of ITS delivery addresses (B-TH-221)', () => {
  const base = { companyId: companyA, source: 'PHONE', request: 'Made-up: a call — 20 black jackets for the spring.' }

  it('keeps the PO and the delivery address of the request’s own customer', async () => {
    const { inquiry } = await ok('ada', 'POST', '/sales/inquiries', { ...base, partyId: P1, customerRef: 'BA-PO-4521', shipToAddressId: P1_SHIP_TO }, 201)
    expect(inquiry.customerRef).toBe('BA-PO-4521')
    expect(await one('SELECT "customerRef", "shipToAddressId" FROM "Inquiry" WHERE id = $1', [inquiry.id])).toEqual({ customerRef: 'BA-PO-4521', shipToAddressId: P1_SHIP_TO })
  })

  it('refuses another customer’s address, an address that delivers nothing, and an address with a prospect — at the field', async () => {
    const foreign = await no('ada', 'POST', '/sales/inquiries', { ...base, partyId: P1, shipToAddressId: P3_SHIP_TO }, 400)
    expect(foreign.issues).toEqual([expect.objectContaining({ path: 'body/shipToAddressId' })])
    expect(JSON.stringify(foreign)).not.toContain('SEED-C2')
    const billing = await no('ada', 'POST', '/sales/inquiries', { ...base, partyId: P1, shipToAddressId: P1_OFFICE }, 400)
    expect(billing.issues).toEqual([expect.objectContaining({ path: 'body/shipToAddressId' })])
    const prospect = await no('ada', 'POST', '/sales/inquiries', { ...base, source: 'FAIR', prospect: { company: 'Made-up Moto Club', lawfulBasis: 'CONSENT' }, shipToAddressId: P1_SHIP_TO }, 400)
    expect(prospect.issues).toEqual([expect.objectContaining({ path: 'body/shipToAddressId' })])
    expect((await one(`SELECT count(*)::int AS n FROM "Inquiry" WHERE "tenantId" = $1 AND "shipToAddressId" = $2`, [T, P3_SHIP_TO])).n).toBe(0)
  })

  it('a person limited to A makes A’s request and is refused B’s, in words; a prospect keeps its lawful basis', async () => {
    await ok('limited', 'POST', '/sales/inquiries', { ...base, partyId: P1, shipToAddressId: P1_SHIP_TO }, 201)
    const refused = await no('limited', 'POST', '/sales/inquiries', { ...base, partyId: P3 }, 400)
    expect(refused.issues).toEqual([expect.objectContaining({ path: 'body/partyId' })])
    const { inquiry } = await ok('ada', 'POST', '/sales/inquiries', { ...base, source: 'FAIR', prospect: { name: 'Made-up Gianni', company: 'Made-up Moto Club', email: 'club@moto-club.example.com', lawfulBasis: 'LEGITIMATE_INTEREST' } }, 201)
    expect(await one('SELECT "prospectLawfulBasis"::text AS basis, "shipToAddressId" FROM "Inquiry" WHERE id = $1', [inquiry.id])).toEqual({ basis: 'LEGITIMATE_INTEREST', shipToAddressId: null })
  })

  it('"Make an inquiry" from a mail takes the same PO and delivery address', async () => {
    // A made-up mail waiting in Mail to sort (the seed's own is already a request): a copy of it with a new id and message.
    const mailId = newId()
    await admin(
      `INSERT INTO "InboundEmail" SELECT (jsonb_populate_record(NULL::"InboundEmail", to_jsonb(m) || jsonb_build_object(
         'id', $2::uuid, 'receiptId', gen_random_uuid(), 'sesMessageId', $3::text, 's3Key', $3::text, 'emailMessageId', $4::text,
         'fromAddress', 'buyer.c2@example.com', 'envelopeFrom', 'buyer.c2@example.com', 'subject', 'Made-up: 12 jackets',
         'bodyText', 'Made-up: please quote 12 jackets.', 'bodyHtml', NULL, 'senderPartyId', NULL, 'senderContactId', NULL,
         'attachments', '[]'::jsonb, 'version', 1, 'receivedAt', now() - interval '1 day'))).*
       FROM "InboundEmail" m WHERE m."tenantId" = $1 AND m.status = 'TRIAGE' ORDER BY m."receivedAt" LIMIT 1`,
      [T, mailId, `made-up-th1b-${run}`, `<th1b.${run}@mail.example.com>`],
    )
    const { inquiry } = await ok('ada', 'POST', `/sales/inquiries/from-mail/${mailId}`, { version: 1, companyId: companyA, partyId: P3, customerRef: 'C2-REF-9', shipToAddressId: P3_SHIP_TO }, 201)
    expect(await one('SELECT "customerRef", "shipToAddressId" FROM "Inquiry" WHERE id = $1', [inquiry.id])).toEqual({ customerRef: 'C2-REF-9', shipToAddressId: P3_SHIP_TO })
  })
})
