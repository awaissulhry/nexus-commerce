import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { partiesNamed } from './views'

/**
 * Saved views never name a customer to a person who may not see it (B-TH-020; threads plan TH-1a; WALL-G09 = SHEET-G07;
 * wall test T18; feature SHEET.brand-view-F07): GET /views leaves out a view whose party term names a party the reader
 * cannot reach, and GET /views/:id answers it as not found. A throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security is real); made-up people, roles and customers. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/views`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const tenant = newId()
const companyA = newId()
const companyB = newId()
const alpha = newId()
const beta = newId()
const gamma = newId()
const lead = newId()
const anna = newId()
const bruno = newId()
const carla = newId()
const roleSales = newId()

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (actorId: string, parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): SessionContext => ({
  audience: 'office',
  tenantId: tenant,
  actorId,
  companyId: companyA,
  grants: [grant(['views.save', 'views.manage', 'orders.view'], parties, companies)],
})
const SESSIONS: Record<string, SessionContext> = {
  // The sales lead sees every customer and shares the customers' sheets with the Sales role.
  lead: office(lead),
  // Anna is an account manager limited to Brand Alpha; Bruno to Brand Beta; Carla works for company A only.
  anna: office(anna, [alpha]),
  bruno: office(bruno, [beta]),
  carla: office(carla, 'all', [companyA]),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const names = async (session: string): Promise<string[]> => ((await ok(session, 'GET', '/views?listKey=sales.orders')).views as Json[]).map((view) => view.name)
const ids: Record<string, string> = {}
let keys = 0
const share = async (name: string, query: string, extra: Record<string, unknown> = {}) => {
  const { view } = await ok('lead', 'POST', '/views', { listKey: 'sales.orders', name, audience: 'ROLE', roleId: roleSales, state: { query }, ...extra }, 201, `views-party-${++keys}-${newId()}`)
  ids[name] = view.id
  return view
}

beforeAll(async () => {
  db = await migratedDatabase('platform_views_party')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'views-party'])
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $3, 'VPA', 'Viste Clienti A S.r.l.'), ($2, $3, 'VPB', 'Viste Clienti B S.r.l.')`, [companyA, companyB, tenant])
  // Brand Alpha and Brand Beta are customers of every company; Brand Gamma is company B's own customer.
  await admin(
    `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES
       ($1, $4, NULL, 'ALPHA', 'ORGANISATION', 'Brand Alpha S.r.l.', '{CUSTOMER}'),
       ($2, $4, NULL, 'BETA', 'ORGANISATION', 'Brand Beta S.r.l.', '{CUSTOMER}'),
       ($3, $4, $5, 'GAMMA', 'ORGANISATION', 'Brand Gamma S.r.l.', '{CUSTOMER}')`,
    [alpha, beta, gamma, tenant, companyB],
  )
  for (const [userId, email, name] of [
    [lead, 'lead@example.com', 'Lead Demo'],
    [anna, 'anna@example.com', 'Anna Demo'],
    [bruno, 'bruno@example.com', 'Bruno Demo'],
    [carla, 'carla@example.com', 'Carla Demo'],
  ] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, tenant, email, name])
  }
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience) VALUES ($1, $2, 'custom.sales', 'Demo sales', 'OFFICE')`, [roleSales, tenant])
  for (const userId of [lead, anna, bruno, carla]) {
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), tenant, userId, roleSales])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await share('Brand Alpha — tracking', `party=${alpha}&rows=all`)
  await share('Brand Beta — tracking', `party=${beta}`, { roleDefault: true })
  await share('Alpha and Beta — late', `late=true&partyId=${alpha},${beta}`)
  await share('Brand Gamma — open', `customer=${gamma}`)
  await share('Every customer — late', 'late=true')
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('which parties a view names', () => {
  it('reads the party terms of the list frames and the API, several ids in one term, nothing else', () => {
    expect(partiesNamed(`party=${alpha}&rows=all`)).toEqual([alpha])
    expect(partiesNamed(`late=true&partyId=${alpha},${beta}`)).toEqual([alpha, beta])
    expect(partiesNamed(`customer=${gamma.toUpperCase()}`)).toEqual([gamma])
    expect(partiesNamed('late=true&q=Brand%20Beta&status=READY')).toEqual([])
    expect(partiesNamed('party=not-an-id')).toEqual([])
  })
})

describe('GET /views: a view naming a customer the reader cannot reach is not listed (T18)', () => {
  it('the lead, who sees every customer, lists every shared sheet', async () => {
    expect((await names('lead')).sort()).toEqual(['Alpha and Beta — late', 'Brand Alpha — tracking', 'Brand Beta — tracking', 'Brand Gamma — open', 'Every customer — late'])
  })

  it('limited to Brand Alpha: Brand Beta\'s sheet, its default mark and the view naming both are gone; not even a name tells', async () => {
    const answer = await ok('anna', 'GET', '/views?listKey=sales.orders')
    expect((answer.views as Json[]).map((view) => view.name).sort()).toEqual(['Brand Alpha — tracking', 'Every customer — late'])
    // Brand Beta's sheet is the role's default: Anna's list opens on no hidden view.
    expect(answer.roleDefaultId).toBeNull()
    expect(JSON.stringify(answer)).not.toContain('Beta')
    expect(JSON.stringify(answer)).not.toContain(beta)
  })

  it('limited to Brand Beta: its own sheet (and the role default), never Brand Alpha\'s', async () => {
    const answer = await ok('bruno', 'GET', '/views?listKey=sales.orders')
    expect((answer.views as Json[]).map((view) => view.name).sort()).toEqual(['Brand Beta — tracking', 'Every customer — late'])
    expect(answer.roleDefaultId).toBe(ids['Brand Beta — tracking'])
    expect(JSON.stringify(answer)).not.toContain('Alpha')
  })

  it('a customer of one company only: hidden from a person who works for another company', async () => {
    expect(await names('carla')).not.toContain('Brand Gamma — open')
    expect(await names('carla')).toContain('Brand Alpha — tracking')
  })

  it('GET /views/:id answers a hidden view as not found, the same answer as a view that does not exist', async () => {
    const hidden = await call('anna', 'GET', `/views/${ids['Brand Beta — tracking']}`)
    const missing = await call('anna', 'GET', `/views/${newId()}`)
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json().error.message).toBe(missing.json().error.message)
    expect((await call('anna', 'GET', `/views/${ids['Brand Alpha — tracking']}`)).statusCode).toBe(200)
    expect((await call('lead', 'GET', `/views/${ids['Brand Beta — tracking']}`)).statusCode).toBe(200)
  })

  it('a widened scope shows the view at the next read; an id that names no party hides nothing', async () => {
    SESSIONS.anna = office(anna, [alpha, beta])
    expect(await names('anna')).toContain('Brand Beta — tracking')
    SESSIONS.anna = office(anna, [alpha])
    await share('Unknown customer', `party=${newId()}`)
    expect(await names('anna')).toContain('Unknown customer')
  })
})
