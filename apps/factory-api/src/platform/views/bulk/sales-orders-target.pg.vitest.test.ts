import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { undoRowsOf, type BulkResult } from '@nexus/factory-domain/views/bulk/rules'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * B-TH-060 (threads plan TH-4, SHEET-G09; design O-SAL-ORD-LIST.grid-F26, SHEET.brand-fields-F03/F08; surface W17, wall T17): the
 * Sales › Orders sheet's cells through the app's real routes (POST /views/bulk/preview and /apply, list `sales.orders`) on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the order's database rules are
 * real), tenant A from EVERY seed: customer A's order SEED-SO-0004 and the second brand's order (customer B). All words made up.
 *   - the office note and custom values (TEXT, NUMBER, DATE, SELECT, YES_NO) by column id, previewed old → new and written through
 *     one command per row (version-checked: the row's version moves; audited); Undo puts them back; a stale version is refused;
 *   - never the lines, a money field or a field the person does not see; a cancelled order keeps every cell;
 *   - W17 / T17: customer B's own field is no field of customer A's order (held `invalid`, nothing written), and an office person
 *     limited to customer A is never told it exists (400 "Not a field this list edits").
 * Run with `node scripts/factory/run-pg-tests.mjs sales-orders-target`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'th4-cells-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `th4-cells-${Date.now()}-${++serial}`

const A = { tenant: seedUuid(NS, 'tenant') }
const grant = (permissions: readonly string[], scope: Partial<Grant> = {}): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const ORDERS = ['orders.view', 'orders.manage']
const SESSIONS: Record<string, SessionContext> = {
  keeper: office([grant(['fields.view', 'fields.manage', ...ORDERS, 'parties.view', 'money.price'])]),
  reader: office([grant(['orders.view'])]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown, key = true) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' && key ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const preview = (session: string, ids: string[], changes: Json) => call(session, 'POST', '/views/bulk/preview', { listKey: 'sales.orders', ids, changes })
const apply = async (session: string, rows: { id: string; version: number; changes: Json }[], undo = false): Promise<BulkResult[]> => (await ok(session, 'POST', '/views/bulk/apply', { listKey: 'sales.orders', rows, ...(undo ? { undo } : {}) })).results
const versionOf = async (id: string) => (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [id]))[0]!.version
const valueOf = async (orderId: string, code: string) => (await admin<{ value: unknown }>(`SELECT v.value FROM "CustomFieldValue" v JOIN "CustomField" f ON f.id = v."fieldId" WHERE v."recordId" = $1 AND f.code = $2`, [orderId, code]))[0]?.value ?? null

let orderA: { id: string; partyId: string; number: string }
let orderB: { id: string; partyId: string; number: string }
let cancelled: { id: string; number: string }

beforeAll(async () => {
  db = await migratedDatabase('th4_cells')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const customers = `SELECT o.id, o."partyId", o.number FROM "SalesOrder" o JOIN "Party" p ON p."tenantId" = o."tenantId" AND p.id = o."partyId"
                     WHERE o."tenantId" = $1 AND o.status = 'CONFIRMED' AND p.status = 'ACTIVE' AND 'CUSTOMER' = ANY (p.roles::text[])`
  orderA = (await admin<typeof orderA>(`${customers} AND o.number = 'SEED-SO-0004'`, [A.tenant]))[0]!
  orderB = (await admin<typeof orderB>(`${customers} AND o."partyId" <> $2 ORDER BY o.number LIMIT 1`, [A.tenant, orderA.partyId]))[0]!
  cancelled = (await admin<typeof cancelled>(`SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0003'`, [A.tenant]))[0]!
  // A cancelled order of customer A (the order's own rules allow it from CONFIRMED with a reason).
  await admin(`UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'Made-up: the customer withdrew it.', "closedAt" = now(), version = version + 1 WHERE id = $1`, [cancelled.id])
  // Sales for customer A only (a sales rep's accounts).
  SESSIONS.sellerA = office([grant([...ORDERS, 'parties.view'], { parties: [orderA.partyId] })])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The custom fields of orders: every customer's, one of each kind a cell edits, a money one, and customer B's own.
  const list = (await ok('keeper', 'POST', '/fields/picklists', { code: 'cell_finish', labelIt: 'Finitura', labelEn: 'Finish' }, 201)).picklist
  await ok('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'STANDARD', labelIt: 'Standard', labelEn: 'Standard' }, 201)
  const field = (body: Json) => ok('keeper', 'POST', '/fields', { recordType: 'ORDER', labelIt: 'Campo inventato', ...body }, 201)
  await field({ code: 'ship_note', type: 'TEXT', labelEn: 'Ship note (made up)' })
  await field({ code: 'pallets', type: 'NUMBER', labelEn: 'Pallets (made up)' })
  await field({ code: 'label_due', type: 'DATE', labelEn: 'Labels due (made up)' })
  await field({ code: 'hangers', type: 'YES_NO', labelEn: 'Hangers (made up)' })
  await field({ code: 'finish', type: 'SELECT', labelEn: 'Finish (made up)', picklistId: list.id })
  await field({ code: 'target_price', type: 'MONEY', grain: 'price', labelEn: 'Target price (made up)' })
  await field({ code: 'beta_lining', type: 'TEXT', partyId: orderB.partyId, labelEn: 'Beta lining (made up)' })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-TH-060 the sheet’s cells', () => {
  it('the note and every kind of custom value: previewed, written in one command per row, its version moved, audited, undone', async () => {
    const before = { a: await versionOf(orderA.id), b: await versionOf(orderB.id) }
    const shown = await preview('keeper', [orderA.id, orderB.id], { note: 'Made-up: pack by size.', 'cf:ship_note': 'Made-up: dock 4' })
    expect(shown.statusCode, shown.body).toBe(200)
    const rows = shown.json().rows
    expect(rows[0]).toMatchObject({ id: orderA.id, label: orderA.number, version: before.a, refusal: null })
    expect(rows[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'note', next: 'Made-up: pack by size.' }), { field: 'cf:ship_note', now: null, next: 'Made-up: dock 4' }]))
    expect(rows[1]).toMatchObject({ id: orderB.id, label: orderB.number, version: before.b, refusal: null })
    const results = await apply('keeper', [{ id: orderA.id, version: before.a, changes: { note: 'Made-up: pack by size.', 'cf:ship_note': 'Made-up: dock 4' } }, { id: orderB.id, version: before.b, changes: { note: 'Made-up: pack by size.' } }])
    expect(results.map((result) => [result.ok, result.version])).toEqual([[true, before.a + 1], [true, before.b + 1]])
    expect(results[0]!.after).toEqual({ note: 'Made-up: pack by size.', 'cf:ship_note': 'Made-up: dock 4' })
    expect((await admin(`SELECT "internalNote" FROM "SalesOrder" WHERE id = $1`, [orderA.id]))[0]!.internalNote).toBe('Made-up: pack by size.')
    expect(await valueOf(orderA.id, 'ship_note')).toBe('Made-up: dock 4')
    const audits = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action IN ('sales.orders.editCells', 'fields.setValue') ORDER BY at, id`, [orderA.id])
    expect(audits.map((row) => row.action).sort()).toEqual(['fields.setValue', 'sales.orders.editCells'])

    // NUMBER (a decimal typed as text), DATE, YES_NO, SELECT.
    const kinds = await apply('keeper', [{ id: orderA.id, version: before.a + 1, changes: { 'cf:pallets': '3.5', 'cf:label_due': '2026-12-01', 'cf:hangers': 'YES', 'cf:finish': 'STANDARD' } }])
    expect(kinds[0]).toMatchObject({ ok: true, after: { 'cf:pallets': 3.5, 'cf:label_due': '2026-12-01', 'cf:hangers': 'YES', 'cf:finish': 'STANDARD' } })
    expect([await valueOf(orderA.id, 'pallets'), await valueOf(orderA.id, 'label_due'), await valueOf(orderA.id, 'hangers'), await valueOf(orderA.id, 'finish')]).toEqual([3.5, '2026-12-01', true, 'STANDARD'])

    // Undo: back to what they were, from the version the change gave the row.
    const undone = await apply('keeper', undoRowsOf(kinds), true)
    expect(undone[0]).toMatchObject({ ok: true, after: { 'cf:pallets': null, 'cf:label_due': null, 'cf:hangers': null, 'cf:finish': null } })
    expect(await valueOf(orderA.id, 'pallets')).toBeNull()
  })

  it('a stale version is refused and nothing is written; a cancelled order keeps every cell', async () => {
    const version = await versionOf(orderA.id)
    const stale = await apply('keeper', [{ id: orderA.id, version: version - 1, changes: { note: 'Made-up: too late' } }])
    expect(stale[0]).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect((await admin(`SELECT "internalNote" FROM "SalesOrder" WHERE id = $1`, [orderA.id]))[0]!.internalNote).not.toBe('Made-up: too late')
    const kept = await preview('keeper', [cancelled.id], { note: 'Made-up: x', 'cf:ship_note': 'Made-up: y' })
    expect(kept.json().rows[0]).toMatchObject({ refusal: { code: 'held', status: 'CANCELLED' } })
    const refused = await apply('keeper', [{ id: cancelled.id, version: await versionOf(cancelled.id), changes: { note: 'Made-up: x' } }])
    expect(refused[0]).toMatchObject({ ok: false, refusal: { code: 'held', status: 'CANCELLED' } })
  })

  it('never the lines, a money field or an unknown one; only who changes orders', async () => {
    for (const changes of [{ lines: 'x' }, { quantity: 3 }, { 'cf:price:target_price': 100 }, { 'cf:no_such_field': 'x' }]) {
      const answer = await preview('keeper', [orderA.id], changes)
      expect(answer.statusCode, JSON.stringify(changes)).toBe(400)
      expect(answer.json().error.issues[0].message).toBe('Not a field this list edits.')
    }
    expect((await preview('reader', [orderA.id], { note: 'Made-up' })).statusCode).toBe(403)
  })

  it('W17 / T17: customer B’s field is no field of customer A’s order; a person limited to A is never told it exists', async () => {
    const shown = await preview('keeper', [orderA.id, orderB.id], { 'cf:beta_lining': 'Made-up: BL-9' })
    expect(shown.json().rows.map((row: Json) => [row.id, row.refusal])).toEqual([
      [orderA.id, { code: 'invalid', field: 'cf:beta_lining', status: null }],
      [orderB.id, null],
    ])
    const results = await apply('keeper', [
      { id: orderA.id, version: await versionOf(orderA.id), changes: { 'cf:beta_lining': 'Made-up: BL-9' } },
      { id: orderB.id, version: await versionOf(orderB.id), changes: { 'cf:beta_lining': 'Made-up: BL-9' } },
    ])
    expect(results.map((result) => [result.ok, result.refusal?.code ?? null])).toEqual([[false, 'invalid'], [true, null]])
    expect(await valueOf(orderA.id, 'beta_lining')).toBeNull()
    expect(await valueOf(orderB.id, 'beta_lining')).toBe('Made-up: BL-9')
    // Limited to customer A: B's field is no field of the list, and B's order is not there to change.
    const limited = await preview('sellerA', [orderA.id], { 'cf:beta_lining': 'Made-up: x' })
    expect(limited.statusCode).toBe(400)
    expect(limited.json().error.issues).toEqual([{ path: 'body/changes/cf:beta_lining', message: 'Not a field this list edits.' }])
    expect(JSON.stringify(limited.json())).not.toContain('Beta')
    expect((await preview('sellerA', [orderB.id], { note: 'Made-up' })).json().rows[0]).toMatchObject({ refusal: { code: 'missing' } })
    expect((await apply('sellerA', [{ id: orderA.id, version: await versionOf(orderA.id), changes: { 'cf:ship_note': 'Made-up: by seller A' } }]))[0]).toMatchObject({ ok: true })
  })
})
