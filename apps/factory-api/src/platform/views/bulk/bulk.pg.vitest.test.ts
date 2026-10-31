import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { BULK_LIMITS, undoRowsOf, type BulkResult } from '@nexus/factory-domain/views/bulk/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { workOrders as workOrdersSource } from '../../exports/sources/work-orders'

/**
 * Bulk edit with preview, Undo and inline edit (B-W2b-13; PLT-182, PLT-166) and the work orders' relative-day quick
 * filter (PLT-167), through the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, the column grants and the work order guards are real), the factory-db seeds up to
 * production (WO-0001 in progress, WO-0002 a draft) and three made-up copies of the draft (two drafts, one cancelled).
 * Each row is written through the module's own workorders.update. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/views/bulk`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'views-bulk'
const tenant = seedUuid(ns, 'tenant')
const W: Record<'d1' | 'd2' | 'cancelled' | 'running', string> = { d1: newId(), d2: newId(), cancelled: newId(), running: '' }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(['workorders.view', 'workorders.manage']),
  viewer: office(['workorders.view']),
  stranger: office(['planning.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string): Promise<Json> {
  const response = await call(who, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const preview = (ids: string[], changes: Json, who = 'planner') => call(who, 'POST', '/views/bulk/preview', { listKey: 'production.work-orders', ids, changes })
const apply = (rows: Json[], key?: string, who = 'planner') => call(who, 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows }, key)
const header = async (id: string) => (await admin<{ version: number; due: string | null; priority: number }>(`SELECT version, to_char("dueDate", 'YYYY-MM-DD') AS due, priority FROM "WorkOrder" WHERE id = $1`, [id]))[0]!
const audits = async (id: string) => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.update'`, [id]))[0]!.n
const plus = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** A made-up copy of a draft work order (every column the same but its id, number and version), DRAFT. */
async function copyDraft(fromId: string, id: string, number: string): Promise<void> {
  const columns = (await admin<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'WorkOrder' ORDER BY ordinal_position`)).map((row) => row.name)
  const kept = columns.filter((name) => !['id', 'number', 'version', 'priority', 'dueDate'].includes(name))
  const list = kept.map((name) => `"${name}"`).join(', ')
  await admin(`INSERT INTO "WorkOrder" (id, number, version, priority, "dueDate", ${list}) SELECT $2, $3, 1, 0, NULL, ${list} FROM "WorkOrder" WHERE id = $1`, [fromId, id, number])
}

beforeAll(async () => {
  db = await migratedDatabase('platform_views_bulk')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  const [draft] = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND status = 'DRAFT' ORDER BY number LIMIT 1`, [tenant])
  const [running] = await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND status = 'IN_PROGRESS' ORDER BY number LIMIT 1`, [tenant])
  W.running = running!.id
  await copyDraft(draft!.id, W.d1, 'T-BULK-0001')
  await copyDraft(draft!.id, W.d2, 'T-BULK-0002')
  await copyDraft(draft!.id, W.cancelled, 'T-BULK-0003')
  await admin(`UPDATE "WorkOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Made-up: not needed', version = 2 WHERE id = $1`, [W.cancelled])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the preview (old → new per row, nothing written)', () => {
  it('answers each asked row in order: old → new, a cancelled one held with its state, an unknown one missing', async () => {
    const unknown = newId()
    const before = await header(W.d1)
    const response = await preview([W.d1, W.cancelled, unknown], { due: '2026-12-01', priority: ' 5 ' })
    expect(response.statusCode, response.body).toBe(200)
    const { rows } = response.json()
    expect(rows.map((row: Json) => row.id)).toEqual([W.d1, W.cancelled, unknown])
    expect(rows[0]).toEqual({ id: W.d1, label: 'T-BULK-0001', version: before.version, changes: [{ field: 'due', now: null, next: '2026-12-01' }, { field: 'priority', now: 0, next: 5 }], refusal: null })
    expect(rows[1]).toMatchObject({ label: 'T-BULK-0003', refusal: { code: 'held', field: null, status: 'CANCELLED' } })
    expect(rows[2]).toEqual({ id: unknown, label: '', version: 0, changes: [], refusal: { code: 'missing', field: null, status: null } })
    // Nothing written.
    expect(await header(W.d1)).toEqual(before)
    expect(await audits(W.d1)).toBe(0)
  })

  it('refuses in words: too many rows, a field the list does not edit, a value it cannot take; a list without bulk edit; without workorders.manage', async () => {
    const many = Array.from({ length: BULK_LIMITS.rows + 1 }, () => newId())
    expect((await preview(many, { due: '2026-12-01' })).statusCode).toBe(400)
    const unknownField = await preview([W.d1], { colour: 'red' })
    expect(unknownField.statusCode).toBe(400)
    expect(unknownField.json().error.issues).toEqual([{ path: 'body/changes/colour', message: 'Not a field this list edits.' }])
    const badDay = await preview([W.d1], { due: '2026-13-01', priority: 2000 })
    expect(badDay.statusCode).toBe(400)
    expect(badDay.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/changes/due', 'body/changes/priority'])
    expect((await call('planner', 'POST', '/views/bulk/preview', { listKey: 'sales.orders', ids: [W.d1], changes: { due: null } })).statusCode).toBe(404)
    expect((await preview([W.d1], { due: null }, 'viewer')).statusCode).toBe(403)
    expect((await preview([W.d1], { due: null }, 'stranger')).statusCode).toBe(403)
    expect((await preview([W.d1, W.d1], { due: null })).statusCode).toBe(400)
  })
})

describe('the apply, Undo and one cell', () => {
  let results: BulkResult[] = []

  it('writes each row through workorders.update (its version, audit row and event); a cancelled row is held, nothing written to it', async () => {
    const d1 = await header(W.d1)
    const d2 = await header(W.d2)
    const cancelled = await header(W.cancelled)
    const rows = [
      { id: W.d1, version: d1.version, changes: { due: '2026-12-01', priority: 5 } },
      { id: W.d2, version: d2.version, changes: { due: '2026-12-01', priority: 5 } },
      { id: W.cancelled, version: cancelled.version, changes: { due: '2026-12-01', priority: 5 } },
    ]
    const answer = await ok('planner', 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows }, 'bulk-apply-0001')
    results = answer.results
    expect(results.map((result) => [result.id, result.ok, result.refusal?.code ?? null])).toEqual([
      [W.d1, true, null],
      [W.d2, true, null],
      [W.cancelled, false, 'held'],
    ])
    expect(results[0]).toEqual({ id: W.d1, label: 'T-BULK-0001', ok: true, refusal: null, before: { due: null, priority: 0 }, after: { due: '2026-12-01', priority: 5 }, version: d1.version + 1 })
    expect(results[2]).toMatchObject({ refusal: { code: 'held', status: 'CANCELLED' }, before: { due: null, priority: 0 }, after: { due: null, priority: 0 }, version: cancelled.version })
    expect(await header(W.d1)).toEqual({ version: d1.version + 1, due: '2026-12-01', priority: 5 })
    expect(await header(W.cancelled)).toEqual(cancelled)
    expect(await audits(W.d1)).toBe(1)
    expect(await audits(W.cancelled)).toBe(0)
    const events = await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE subject = $1 AND type = 'workorder.changed'`, [W.d1])
    expect(events).toHaveLength(1)
  })

  it('a repeated apply with the same key answers each row from its receipt and writes nothing again', async () => {
    const versions = [await header(W.d1), await header(W.d2)]
    const rows = [
      { id: W.d1, version: versions[0]!.version - 1, changes: { due: '2026-12-01', priority: 5 } },
      { id: W.d2, version: versions[1]!.version - 1, changes: { due: '2026-12-01', priority: 5 } },
    ]
    const again = await ok('planner', 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows }, 'bulk-apply-0001')
    expect(again.results.map((result: Json) => [result.ok, result.after, result.version])).toEqual(results.slice(0, 2).map((result) => [result.ok, result.after, result.version]))
    expect(await header(W.d1)).toEqual(versions[0])
    expect(await audits(W.d1)).toBe(1)
  })

  it('a version that moved since the review is stale: nothing written (with or without a key)', async () => {
    const d2 = await header(W.d2)
    for (const key of [undefined, 'bulk-stale-0001']) {
      const response = await apply([{ id: W.d2, version: d2.version - 1, changes: { priority: 9 } }], key)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().results[0]).toMatchObject({ ok: false, refusal: { code: 'stale' }, version: d2.version, before: { priority: 5 }, after: { priority: 5 } })
    }
    expect(await header(W.d2)).toEqual(d2)
  })

  it('Undo puts each changed row back from the version the change gave it', async () => {
    const undo = undoRowsOf(results)
    expect(undo).toEqual([
      { id: W.d1, version: results[0]!.version, changes: { due: null, priority: 0 } },
      { id: W.d2, version: results[1]!.version, changes: { due: null, priority: 0 } },
    ])
    const answer = await ok('planner', 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows: undo, undo: true }, 'bulk-undo-0001')
    expect(answer.results.every((result: Json) => result.ok)).toBe(true)
    expect(await header(W.d1)).toEqual({ version: results[0]!.version + 1, due: null, priority: 0 })
    expect(await header(W.d2)).toEqual({ version: results[1]!.version + 1, due: null, priority: 0 })
  })

  it('one cell edited in the grid is one row and one field; a value the field cannot take is refused before anything is written', async () => {
    const d1 = await header(W.d1)
    const answer = await ok('planner', 'POST', '/views/bulk/apply', { listKey: 'production.work-orders', rows: [{ id: W.d1, version: d1.version, changes: { priority: 3 } }] }, 'bulk-cell-0001')
    expect(answer.results).toEqual([{ id: W.d1, label: 'T-BULK-0001', ok: true, refusal: null, before: { priority: 0 }, after: { priority: 3 }, version: d1.version + 1 }])
    const bad = await apply([{ id: W.d1, version: d1.version + 1, changes: { priority: 1.5 } }])
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.issues).toEqual([{ path: 'body/rows/0/changes/priority', message: 'A whole number is needed.' }])
    expect((await apply([{ id: W.d1, version: d1.version + 1, changes: { priority: 1 } }], undefined, 'viewer')).statusCode).toBe(403)
    expect((await header(W.d1)).priority).toBe(3)
  })
})

describe('the work orders’ quick filter: due on a relative day (PLT-167)', () => {
  it('reads the word against today; the export of the view reads the same word', async () => {
    const today = businessDate(new Date())
    const d1 = await header(W.d1)
    const d2 = await header(W.d2)
    await ok('planner', 'POST', '/views/bulk/apply', {
      listKey: 'production.work-orders',
      rows: [
        { id: W.d1, version: d1.version, changes: { due: plus(today, -3) } },
        { id: W.d2, version: d2.version, changes: { due: plus(today, 2) } },
      ],
    })
    const numbers = async (query: string) => (await ok('planner', 'GET', `/production/work-orders?${query}`)).workOrders.map((row: Json) => row.number).filter((number: string) => number.startsWith('T-BULK')).sort()
    expect(await numbers('due=overdue')).toEqual(['T-BULK-0001'])
    expect(await numbers('due=next-7-days')).toEqual(['T-BULK-0002'])
    expect(await numbers('due=last-7-days')).toEqual(['T-BULK-0001'])
    expect(await numbers('due=today')).toEqual([])
    expect(await numbers('open=true')).toEqual(['T-BULK-0001', 'T-BULK-0002'])
    expect((await call('planner', 'GET', '/production/work-orders?due=someday')).statusCode).toBe(400)
    expect(workOrdersSource.query(new URLSearchParams('due=this-week&view=all'))).toEqual({ q: undefined, due: 'this-week' })
    expect(workOrdersSource.query(new URLSearchParams('due=someday'))).toEqual({ open: true, q: undefined, due: undefined })
  })
})
