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
import { skippedRanges } from './series'

/**
 * The numbers a series issued and its gap proof (B-W0-28, design 02 admin.documents "Fiscal check"), and closing a
 * series, on the local stack with the app's real routes.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const tenant = newId()
const companyOne = newId()
const companyTwo = newId()
const user = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['numbering.view', 'numbering.manage'])] },
  viewer: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['numbering.view'])] },
  'viewer-two': { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['numbering.view'], [companyTwo])] },
}
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })

async function issue(date: string): Promise<string> {
  const { result } = await command(callerFor(database, { ...SESSIONS.admin!, requestId: newId() } as RequestContext), { name: 'invoices.issue', input: {} }, async (tools) => {
    const recordId = newId()
    const number = await allocateNumber(tools, { companyId: companyOne, kind: 'INVOICE' }, { type: 'Invoice', id: recordId, date })
    tools.audit({ recordType: 'Invoice', recordId, companyId: companyOne, after: { number: number.formatted } })
    return number.formatted
  })
  return result
}

beforeAll(async () => {
  db = await migratedDatabase('numbering_alloc')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await db.admin.query('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'na-a'])
  for (const [index, companyId] of [companyOne, companyTwo].entries()) {
    await db.admin.query('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenant, `na-${index}`])
  }
  await db.admin.query(`INSERT INTO "User" (id, "tenantId", email, "displayName") VALUES ($1, $2, 'admin@example.com', 'Ada Demo')`, [user, tenant])
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

describe('skippedRanges', () => {
  it('lists the ranges between the first and the last value that are missing, at most the cap', () => {
    expect(skippedRanges([])).toEqual({ ranges: [], more: false })
    expect(skippedRanges([3, 4, 5])).toEqual({ ranges: [], more: false })
    expect(skippedRanges([1, 2, 6, 8])).toEqual({ ranges: [{ from: 3, to: 5 }, { from: 7, to: 7 }], more: false })
    expect(skippedRanges([1, 3, 5, 7], 2)).toEqual({ ranges: [{ from: 2, to: 2 }, { from: 4, to: 4 }], more: true })
  })
})

describe('GET /numbering/series/:id/allocations and POST …/close', () => {
  it('proves the numbers issued, names who issued them, lists a range moved past; a closed series issues no more', async () => {
    const created = await call('admin', 'POST', '/numbering/series', { companyId: companyOne, kind: 'INVOICE', year: 2026 })
    expect(created.statusCode).toBe(201)
    const series = (created.json() as { series: { id: string; version: number } }).series
    expect(await issue('2026-10-01')).toBe('FT-2026-00001')
    expect(await issue('2026-10-02')).toBe('FT-2026-00002')
    // A restore: the numbers 3 to 9 exist in the SDI receipts; the series moves past them.
    const advanced = await call('admin', 'POST', `/numbering/series/${series.id}/advance`, { pastValue: 9, reason: 'restore: last SDI receipt FT-2026-00009', version: 3 })
    expect(advanced.statusCode).toBe(200)
    expect(await issue('2026-10-03')).toBe('FT-2026-00010')

    const answer = await call('viewer', 'GET', `/numbering/series/${series.id}/allocations?limit=2`)
    expect(answer.statusCode).toBe(200)
    const body = answer.json() as { series: { nextValue: number }; summary: unknown; allocations: Array<{ formatted: string; allocatedByName: string | null; recordType: string; documentDate: string }> }
    expect(body.summary).toEqual({ count: 3, first: 1, last: 10, firstFormatted: 'FT-2026-00001', lastFormatted: 'FT-2026-00010', lastDocumentDate: '2026-10-03', skipped: [{ from: 3, to: 9 }], moreSkipped: false })
    expect(body.allocations).toEqual([
      expect.objectContaining({ formatted: 'FT-2026-00010', allocatedByName: 'Ada Demo', recordType: 'Invoice', documentDate: '2026-10-03' }),
      expect.objectContaining({ formatted: 'FT-2026-00002', allocatedByName: 'Ada Demo' }),
    ])
    expect((await call('viewer-two', 'GET', `/numbering/series/${series.id}/allocations`)).statusCode).toBe(404)

    const version = (await call('viewer', 'GET', `/numbering/series/${series.id}/allocations`)).json().series.version as number
    expect((await call('viewer', 'POST', `/numbering/series/${series.id}/close`, { version })).statusCode).toBe(403)
    expect((await call('admin', 'POST', `/numbering/series/${series.id}/close`, { version: version - 1 })).statusCode).toBe(409)
    const closed = await call('admin', 'POST', `/numbering/series/${series.id}/close`, { version, reason: 'Moved to the new series R' })
    expect(closed.statusCode).toBe(200)
    expect(closed.json()).toMatchObject({ series: { status: 'CLOSED', version: version + 1 } })
    expect((await call('admin', 'POST', `/numbering/series/${series.id}/close`, { version: version + 1 })).statusCode).toBe(409)
    await expect(issue('2026-10-04')).rejects.toThrow(/no active invoice series/)
    const { rows } = await db.admin.query(`SELECT action, before->>'status' AS "from", after->>'status' AS "to", reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'numbering.closeSeries'`, [series.id])
    expect(rows).toEqual([{ action: 'numbering.closeSeries', from: 'ACTIVE', to: 'CLOSED', reason: 'Moved to the new series R' }])
  })
})
