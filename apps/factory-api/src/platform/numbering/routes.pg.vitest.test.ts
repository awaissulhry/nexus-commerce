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
import { typedNumber } from './override'

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
// B-W2b-24: a company of its own for the preview and the override (no series of the earlier tests).
const companyThree = newId()
const companyB = newId()
const user = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'])] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'], [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['numbering.view'])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'])] },
  floor: { audience: 'floor', tenantId: tenantA, actorId: user, siteId: newId(), deviceId: newId(), grants: [grant(['numbering.view', 'numbering.manage'])] },
  // B-W2b-24 (PLT-125): a buyer sees the next purchase order number; who holds numbering.override types a migrated one.
  buyer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['purchasing.manage'])] },
  override: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['purchasing.manage', 'numbering.override'])] },
  stranger: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['parties.view'])] },
}

const call = (session: string | undefined, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: session ? { 'x-test-session': session } : {}, ...(payload === undefined ? {} : { payload: payload as object }) })
type Series = { id: string; companyId: string; code: string; nextValue: number; startValue: number; version: number; nextNumber: string | null; scopeKey: string }
const created = (response: { json(): unknown }) => (response.json() as { series: Series }).series

beforeAll(async () => {
  db = await migratedDatabase('numbering_routes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  for (const [tenantId, slug, companies] of [
    [tenantA, 'nr-a', [companyOne, companyTwo, companyThree]],
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

describe('B-W2b-24 (PLT-125): the number preview and the controlled override of a migrated document', () => {
  let poSeries: Series

  it('previews the number a new document would get, to who makes such documents, without reserving it', async () => {
    poSeries = created(await call('admin', 'POST', '/numbering/series', { companyId: companyThree, kind: 'PURCHASE_ORDER', year: 2026, pattern: 'PO-{YYYY}-{N:5}', startValue: 18 }))
    const asked = await call('buyer', 'GET', `/numbering/preview?companyId=${companyThree}&kind=PURCHASE_ORDER&date=2026-10-31`)
    expect(asked.statusCode, asked.body).toBe(200)
    expect(asked.json().preview).toMatchObject({ kind: 'PURCHASE_ORDER', code: 'MAIN', scopeKey: '2026', number: 'PO-2026-00018', fiscal: false, newPeriod: false, held: null })
    // Twice: the same number (nothing was taken).
    expect((await call('admin', 'GET', `/numbering/preview?companyId=${companyThree}&kind=PURCHASE_ORDER&date=2026-10-31`)).json().preview.number).toBe('PO-2026-00018')
    // A new year: that year's first number, from the newest row.
    expect((await call('buyer', 'GET', `/numbering/preview?companyId=${companyThree}&kind=PURCHASE_ORDER&date=2027-01-04`)).json().preview).toMatchObject({ scopeKey: '2027', number: 'PO-2027-00001', newPeriod: true })
    // No series of the kind, and a person who neither sees series nor makes such documents.
    expect((await call('buyer', 'GET', `/numbering/preview?companyId=${companyThree}&kind=WORK_ORDER`)).statusCode).toBe(403)
    expect((await call('admin', 'GET', `/numbering/preview?companyId=${companyThree}&kind=WORK_ORDER`)).json().preview).toMatchObject({ number: null, held: 'noSeries' })
    expect((await call('stranger', 'GET', `/numbering/preview?companyId=${companyThree}&kind=PURCHASE_ORDER`)).statusCode).toBe(403)
    expect((await call('admin-b', 'GET', `/numbering/preview?companyId=${companyThree}&kind=PURCHASE_ORDER`)).statusCode).toBe(404)
  })

  it('says at once what a typed number meets: free, taken, still to come from the series, a fiscal kind, a bad shape', async () => {
    // The series gives PO-2026-00018 to an order: that number is taken from now on.
    const recordId = newId()
    await command(callerFor(database, { ...SESSIONS.admin!, requestId: newId() } as RequestContext), { name: 'purchasing.create', input: {} }, async (tools) => {
      const number = await allocateNumber(tools, { companyId: companyThree, kind: 'PURCHASE_ORDER' }, { type: 'PurchaseOrder', id: recordId, date: '2026-10-31' })
      tools.audit({ recordType: 'PurchaseOrder', recordId, companyId: companyThree, after: { number: number.formatted } })
      return null
    })
    const check = async (number: string, kind = 'PURCHASE_ORDER', session = 'override') => call(session, 'POST', '/numbering/override/check', { companyId: companyThree, kind, number })
    expect((await check(' OA-19-0412 ')).json()).toEqual({ number: 'OA-19-0412', ok: true, refusal: null })
    expect((await check('PO-2026-00018')).json()).toMatchObject({ ok: false, refusal: { code: 'taken' } })
    expect((await check('PO-2026-00040')).json()).toMatchObject({ ok: false, refusal: { code: 'future', message: expect.stringMatching(/series will give this number later/) } })
    expect((await check('FT-2019-0007', 'INVOICE')).json()).toMatchObject({ ok: false, refusal: { code: 'kind' } })
    expect((await check('OA 19 0412')).json()).toMatchObject({ ok: false, refusal: { code: 'shape' } })
    expect((await check('OA-19-0412', 'PURCHASE_ORDER', 'buyer')).statusCode).toBe(403)
  })

  it('gives a migrated document its typed number inside its command: audited with the reason, the series untouched; a clash refused', async () => {
    const before = await db.admin.query('SELECT "nextValue", version FROM "NumberSeries" WHERE id = $1', [poSeries.id])
    const allocations = Number((await db.admin.query('SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "seriesId" = $1', [poSeries.id])).rows[0].n)
    const recordId = newId()
    const typed = await command(callerFor(database, { ...SESSIONS.override!, requestId: newId() } as RequestContext), { name: 'purchasing.create', input: {} }, async (tools) => {
      const number = await typedNumber(tools, { companyId: companyThree, kind: 'PURCHASE_ORDER' }, { type: 'PurchaseOrder', id: recordId }, { number: ' OA-19-0412 ', reason: ' Open order of the old system ' })
      tools.audit({ recordType: 'PurchaseOrder', recordId, companyId: companyThree, after: { number: number.formatted } })
      return number
    })
    expect(typed.result).toEqual({ formatted: 'OA-19-0412', kind: 'PURCHASE_ORDER', typed: true })
    const audit = await db.admin.query('SELECT action, after, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [recordId, 'numbering.override'])
    expect(audit.rows).toEqual([{ action: 'numbering.override', after: { kind: 'PURCHASE_ORDER', number: 'OA-19-0412', typed: true }, reason: 'Open order of the old system' }])
    expect((await db.admin.query('SELECT "nextValue", version FROM "NumberSeries" WHERE id = $1', [poSeries.id])).rows).toEqual(before.rows)
    expect(Number((await db.admin.query('SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "seriesId" = $1', [poSeries.id])).rows[0].n)).toBe(allocations)
    // Refused: a number the series gave, without the permission, without a reason, a fiscal kind.
    const attempt = (session: string, kind: 'PURCHASE_ORDER' | 'INVOICE', number: string, reason: string) =>
      command(callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as RequestContext), { name: 'purchasing.create', input: {} }, async (tools) => {
        await typedNumber(tools, { companyId: companyThree, kind }, { type: 'PurchaseOrder', id: newId() }, { number, reason })
      })
    await expect(attempt('override', 'PURCHASE_ORDER', 'PO-2026-00018', 'Carried over')).rejects.toMatchObject({ issues: [{ path: 'body/typedNumber/taken' }] })
    await expect(attempt('buyer', 'PURCHASE_ORDER', 'OA-19-0999', 'Carried over')).rejects.toMatchObject({ name: 'ForbiddenError' })
    await expect(attempt('override', 'PURCHASE_ORDER', 'OA-19-0999', ' ')).rejects.toMatchObject({ issues: [{ path: 'body/typedNumber/reason' }] })
    await expect(attempt('override', 'INVOICE', 'FT-2019-0007', 'Carried over')).rejects.toMatchObject({ issues: [{ path: 'body/typedNumber/kind' }] })
  })
})
