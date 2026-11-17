import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
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
 * B-TH-014 (Owner ask P7, threads plan): the production manager reads Incoming through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations, on the seeds up to the sales intake. His template holds sales.inquiries.view and
 * no price grain: he lists and opens every request of the company (an office role that sees every customer by design, 08-wall
 * F2), never a target price or a price shown, never a prospect's e-mail or phone (B-TH-016, PR-30), and every action is held
 * with the reason READ_ONLY; a write is refused (403). Made-up data only.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'

const NS = 'th014-production-manager'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const pmTemplate = templateOf('production_manager')!
const salesTemplate = templateOf('sales')!
const permissionsOf = (template: typeof pmTemplate) => [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties: 'all' }] })
const SESSIONS: Record<string, SessionContext> = { pm: office(permissionsOf(pmTemplate)), sales: office(permissionsOf(salesTemplate)) }

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `i-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

beforeAll(async () => {
  h = await startHarness('th014_pm')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the production manager reads Incoming (B-TH-014)', () => {
  it('holds the view in his system role, keeps none, and has no price grain', () => {
    expect(pmTemplate.permissions).toContain('sales.inquiries.view')
    expect(pmTemplate.permissions).not.toContain('sales.inquiries.manage')
    expect(pmTemplate.grains).not.toContain('price')
  })

  it('lists and opens every request without amounts, without a prospect’s contact details, every action held with the reason', async () => {
    const list = await ok('pm', 'GET', '/sales/inquiries?tile=ALL')
    expect(list.rows.map((row: Json) => row.number).sort()).toEqual(['SEED-INQ-0001', 'SEED-INQ-0002', 'SEED-INQ-0003', 'SEED-INQ-0004', 'SEED-INQ-0005', 'SEED-INQ-0006'])
    for (const row of list.rows) expect('targetUnitPrice' in row, row.number).toBe(false)
    // The prospect who wrote a mail: their e-mail address is not the list's "From" for him (it is for sales).
    const mailRow = list.rows.find((row: Json) => row.number === 'SEED-INQ-0003')
    expect(mailRow.fromWords).toBe('Nuovo Cliente')
    expect((await ok('pm', 'GET', `/sales/inquiries/${mailRow.id}`)).inquiry.mail.from).toEqual({ address: null, name: expect.any(String) })
    expect((await ok('sales', 'GET', `/sales/inquiries/${mailRow.id}`)).inquiry.mail.from.address).toEqual(expect.stringContaining('@'))
    const typed = list.rows.find((row: Json) => row.number === 'SEED-INQ-0001')
    const { inquiry } = await ok('pm', 'GET', `/sales/inquiries/${typed.id}`)
    expect('targetUnitPrice' in inquiry).toBe(false)
    expect(inquiry.prospectDetails).toMatchObject({ name: 'Seed Prospect', company: 'Seed Moto Club', email: null, phone: null })
    // B-TH-026: Make style draft is the product office's — his own right (product.styles.manage), never READ_ONLY; this request
    // is a prospect's, so it waits for the customer. Every answering verb stays READ_ONLY.
    const { styleDraft, ...answering } = inquiry.actions as Record<string, Json>
    for (const [verb, held] of Object.entries(answering)) expect(held, verb).toEqual({ allowed: false, refusal: { code: 'READ_ONLY', message: expect.stringMatching(/is for sales/) } })
    expect(styleDraft).toMatchObject({ allowed: false, refusal: { code: 'NEEDS_CUSTOMER' } })
    // Sales reads the same request with its target price and the prospect's contact details.
    const seen = (await ok('sales', 'GET', `/sales/inquiries/${typed.id}`)).inquiry
    expect(seen).toMatchObject({ targetUnitPrice: '380', prospectDetails: { email: 'prospect.club@example.com', phone: '+39 000 0000011' } })
    expect(seen.actions.assign).toEqual({ allowed: true, refusal: null })
    // P1's request: the line's price shown stays hidden for him; sales reads it.
    const p1 = list.rows.find((row: Json) => row.number === 'SEED-INQ-0004')
    const lines = (await ok('pm', 'GET', `/sales/inquiries/${p1.id}`)).inquiry.lines
    expect(lines).toHaveLength(1)
    expect('unitPriceShown' in lines[0]).toBe(false)
    expect((await ok('sales', 'GET', `/sales/inquiries/${p1.id}`)).inquiry.lines[0].unitPriceShown).toBe('420')
  })

  it('searches no prospect by an e-mail address he is not shown, and changes nothing', async () => {
    expect((await ok('pm', 'GET', `/sales/inquiries?tile=ALL&q=prospect.club@example.com`)).rows).toEqual([])
    expect((await ok('sales', 'GET', `/sales/inquiries?tile=ALL&q=prospect.club@example.com`)).rows.map((row: Json) => row.number)).toEqual(['SEED-INQ-0001'])
    const typed = (await ok('pm', 'GET', '/sales/inquiries?tile=ALL')).rows.find((row: Json) => row.number === 'SEED-INQ-0001')
    for (const [method, url, body] of [
      ['PATCH', `/sales/inquiries/${typed.id}`, { version: typed.version, note: 'Made-up.' }],
      ['POST', `/sales/inquiries/${typed.id}/ask-info`, { version: typed.version }],
      ['POST', `/sales/inquiries/${typed.id}/decline`, { version: typed.version, reason: 'CAPACITY' }],
    ] as const) {
      const response = await call('pm', method, url, body)
      expect(response.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})
