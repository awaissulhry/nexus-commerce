import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { allocateNumber } from './allocate'

/**
 * The numbering routes on the local stack, with the app's real routes: an admin lists the series, creates one with
 * its start, gives an unused one another start and moves one past a number; each write is audited and kept to the
 * companies the caller's grant reaches.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyB = newId()
const user = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'])] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'], [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view'])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'])] },
  floor: { audience: 'floor', tenantId: tenantA, actorId: user, siteId: newId(), deviceId: newId(), grants: [grant(['numbering.view', 'numbering.manage'])] },
}

const call = (session: string | undefined, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: session ? { 'x-test-session': session } : {}, ...(payload === undefined ? {} : { payload: payload as object }) })
type Series = { id: string; companyId: string; code: string; nextValue: number; startValue: number; version: number; nextNumber: string | null; scopeKey: string }
const created = (response: { json(): unknown }) => (response.json() as { series: Series }).series

beforeAll(async () => {
  db = await migratedDatabase('numbering_routes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'nr-a', [companyOne, companyTwo]],
    [tenantB, 'nr-b', [companyB]],
  ] as const) {
    await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
    }
  }
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
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('POST /numbering/series', () => {
  it('creates a series with the kind\'s defaults, starting where the paper booklet stopped, and audits it', async () => {
    const response = await call('admin', 'POST', '/numbering/series', { companyId: companyOne, kind: 'DDT', year: 2026, startValue: 143 })
    expect(response.statusCode).toBe(201)
    const series = created(response)
    expect(series).toMatchObject({
      companyId: companyOne,
      kind: 'DDT',
      code: 'MAIN',
      scopeKey: '2026',
      year: 2026,
      reset: 'YEARLY',
      pattern: 'DDT-{YYYY}-{N:5}',
      fiscal: true,
      startValue: 143,
      nextValue: 143,
      nextNumber: 'DDT-2026-00143',
      lastIssuedDate: null,
      status: 'ACTIVE',
      version: 1,
    })
    const audit = await db.admin.query(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [series.id])
    expect(audit.rows).toEqual([{ action: 'numbering.createSeries', after: expect.objectContaining({ kind: 'DDT', startValue: 143, nextValue: 143 }) }])
  })

  it('refuses a second series for the same period, a bad pattern and a year for a series that never resets', async () => {
    const body = { companyId: companyOne, kind: 'INVOICE', code: 'A', year: 2026, pattern: '{N}/A' }
    expect((await call('admin', 'POST', '/numbering/series', body)).statusCode).toBe(201)
    const twice = await call('admin', 'POST', '/numbering/series', body)
    expect(twice.statusCode).toBe(409)
    expect(twice.json()).toMatchObject({ error: { code: 'conflict', message: expect.stringMatching(/exists already/) } })
    const pattern = await call('admin', 'POST', '/numbering/series', { ...body, code: 'B', pattern: 'FT-{YYYY}' })
    expect(pattern.statusCode).toBe(400)
    expect(pattern.json()).toMatchObject({ error: { code: 'validation_failed', issues: [{ path: 'body/pattern', message: expect.stringMatching(/needs \{N\}/) }] } })
    expect((await call('admin', 'POST', '/numbering/series', { ...body, code: 'C', pattern: 'FATTURA-{YYYY}-{N:9}' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/numbering/series', { companyId: companyOne, kind: 'LOT', reset: 'NEVER', year: 2026 })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/numbering/series', { ...body, code: 'A', year: 2027, reset: 'NEVER', pattern: '{N}/A' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/numbering/series', { ...body, code: 'lower' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/numbering/series', { ...body, kind: 'INVOICES' })).statusCode).toBe(400)
  })

  it('keeps to the caller\'s companies, its tenant and its permission', async () => {
    const body = { companyId: companyTwo, kind: 'PURCHASE_ORDER', year: 2026 }
    expect((await call('admin-one', 'POST', '/numbering/series', body)).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/numbering/series', body)).statusCode).toBe(403)
    expect((await call('floor', 'POST', '/numbering/series', body)).statusCode).toBe(403)
    expect((await call(undefined, 'POST', '/numbering/series', body)).statusCode).toBe(401)
    expect((await call('admin-b', 'POST', '/numbering/series', body)).statusCode).toBe(404)
    expect((await call('admin', 'POST', '/numbering/series', body)).statusCode).toBe(201)
  })
})

describe('GET /numbering/series', () => {
  it('lists the series the caller\'s grant reaches, with their next number', async () => {
    await call('admin', 'POST', '/numbering/series', { companyId: companyTwo, kind: 'WORK_ORDER', reset: 'NEVER' })
    const all = (await call('viewer', 'GET', '/numbering/series')).json() as { series: Series[] }
    expect(new Set(all.series.map((series) => series.companyId))).toEqual(new Set([companyOne, companyTwo]))
    const one = (await call('admin-one', 'GET', '/numbering/series')).json() as { series: Series[] }
    expect(one.series.length).toBeGreaterThan(0)
    expect(one.series.every((series) => series.companyId === companyOne)).toBe(true)
    const workOrders = (await call('viewer', 'GET', `/numbering/series?companyId=${companyTwo}&kind=WORK_ORDER`)).json() as { series: Series[] }
    expect(workOrders.series).toEqual([expect.objectContaining({ scopeKey: 'ALL', year: null, nextNumber: 'WO-000001' })])
    expect(((await call('admin-b', 'GET', '/numbering/series')).json() as { series: Series[] }).series).toEqual([])
    expect((await call('floor', 'GET', '/numbering/series')).statusCode).toBe(403)
    expect((await call('viewer', 'GET', '/numbering/series?kind=NOPE')).statusCode).toBe(400)
  })
})

describe('PUT /numbering/series/:seriesId/start and POST /numbering/series/:seriesId/advance', () => {
  it('sets another start before the first number, then only moves forward, with a reason in the audit log', async () => {
    const series = created(await call('admin', 'POST', '/numbering/series', { companyId: companyOne, kind: 'INVOICE', code: 'R', year: 2026, pattern: 'R{N:4}' }))
    const start = await call('admin', 'PUT', `/numbering/series/${series.id}/start`, { startValue: 42, version: series.version })
    expect(start.statusCode).toBe(200)
    const restarted = created(start)
    expect(restarted).toMatchObject({ startValue: 42, nextValue: 42, nextNumber: 'R0042', version: 2 })
    expect((await call('admin', 'PUT', `/numbering/series/${series.id}/start`, { startValue: 50, version: 1 })).statusCode).toBe(409)

    // A document takes 42; the start is now fixed.
    await command(callerFor(database, { ...SESSIONS.admin!, requestId: newId() } as RequestContext), { name: 'invoices.issue', input: {} }, async (tools) => {
      const recordId = newId()
      const number = await allocateNumber(tools, { companyId: companyOne, kind: 'INVOICE', code: 'R' }, { type: 'Invoice', id: recordId, date: '2026-10-28' })
      tools.audit({ recordType: 'Invoice', recordId, companyId: companyOne, after: { number: number.formatted } })
      return number.formatted
    })
    const fixed = await call('admin', 'PUT', `/numbering/series/${series.id}/start`, { startValue: 1, version: 3 })
    expect(fixed.statusCode).toBe(409)
    expect(fixed.json()).toMatchObject({ error: { message: expect.stringMatching(/start is fixed/) } })

    const reason = 'restore of 2026-11-02: the last SDI receipt is R0100'
    const advance = await call('admin', 'POST', `/numbering/series/${series.id}/advance`, { pastValue: 100, reason, lastIssuedDate: '2026-11-01', version: 3 })
    expect(advance.statusCode).toBe(200)
    expect(created(advance)).toMatchObject({ nextValue: 101, nextNumber: 'R0101', lastIssuedDate: '2026-11-01', version: 4 })
    const back = await call('admin', 'POST', `/numbering/series/${series.id}/advance`, { pastValue: 99, reason: 'oops', version: 4 })
    expect(back.statusCode).toBe(409)
    expect(back.json()).toMatchObject({ error: { code: 'conflict', message: expect.stringMatching(/never moves back/) } })
    const audit = await db.admin.query(`SELECT action, reason FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [series.id])
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(['numbering.createSeries', 'numbering.setStart', 'numbering.advance'])
    expect(audit.rows[2]).toEqual({ action: 'numbering.advance', reason })

    // Outside the caller's companies, tenant or permission; bad bodies.
    const two = created(await call('admin', 'POST', '/numbering/series', { companyId: companyTwo, kind: 'QUOTE', year: 2026 }))
    expect((await call('admin-one', 'POST', `/numbering/series/${two.id}/advance`, { pastValue: 5, reason: 'not mine', version: 1 })).statusCode).toBe(403)
    expect((await call('admin-b', 'POST', `/numbering/series/${two.id}/advance`, { pastValue: 5, reason: 'other tenant', version: 1 })).statusCode).toBe(404)
    expect((await call('viewer', 'PUT', `/numbering/series/${two.id}/start`, { startValue: 5, version: 1 })).statusCode).toBe(403)
    expect((await call('admin', 'POST', `/numbering/series/${two.id}/advance`, { pastValue: 5, version: 1 })).statusCode).toBe(400)
    expect((await call('admin', 'PUT', `/numbering/series/${two.id}/start`, { startValue: 0, version: 1 })).statusCode).toBe(400)
    expect((await call('admin', 'PUT', `/numbering/series/not-a-uuid/start`, { startValue: 5, version: 1 })).statusCode).toBe(400)
    expect((await call('admin', 'PUT', `/numbering/series/${newId()}/start`, { startValue: 5, version: 1 })).statusCode).toBe(404)
  })
})
