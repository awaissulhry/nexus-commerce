import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { mappingOf } from './mapping-memory'

/**
 * B-TH-101 (threads plan TH-9, SHEET-G13): GET /sales/order-import/:importId/remembered-mapping?partyId= — a customer's weekly
 * sheet with the same headers is offered the columns of the last applied order import for that customer; a mapping kept for
 * brand A is never offered for brand B (nor a sheet whose orders went to two customers, nor a dry run never applied).
 *
 * On a throwaway database from the migrations with the core and sales seeds (SEED-SO-0001 of SEED-C1, brand A). The past
 * imports are import jobs as the engine leaves them (the layout its dry run read, the rows' order lines), written by the
 * admin past the guards: test data; the read under test runs as the runtime login. Brand B (SEED-C2) gets a copy of
 * SEED-SO-0001. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs order-import/mapping-memory`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'thm-a'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A'), companyB: seedUuid(ns, 'company:B'), brandA: seedUuid(ns, 'party:P1'), brandB: seedUuid(ns, 'party:P3') }
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
async function copy(table: string, id: string, changes: Json): Promise<void> {
  const columns = (await admin<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [table]))
    .map((row) => `"${row.column_name}"`)
    .join(', ')
  await force(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(t) || $2::jsonb FROM "${table}" t WHERE id = $1))`, [id, JSON.stringify(changes)])
}

/** The headers of brand A's weekly sheet and what the office mapped them to (one header left out). */
const COLUMNS = [
  { index: 0, header: 'Rif', column: 'order' },
  { index: 1, header: 'Cliente', column: 'customer' },
  { index: 2, header: 'Art.', column: 'style' },
  { index: 3, header: 'Col.', column: 'colour' },
  { index: 4, header: 'Tg', column: 'size' },
  { index: 5, header: 'Pz', column: 'quantity' },
]
const IGNORED = [{ index: 6, header: 'Note', reason: 'No column of this import.' }]
const layout = (headers: readonly string[], columns = COLUMNS, ignored = IGNORED) => ({ format: 'xlsx', sheet: 'Ordini', sheets: ['Ordini'], encoding: null, delimiter: null, headers, columns, ignored })
const HEADERS = ['Rif', 'Cliente', 'Art.', 'Col.', 'Tg', 'Pz', 'Note']

/** An order import job as the engine leaves it: its sheet's file, its layout, its status, and its rows' order lines. */
async function job(input: { readonly companyId?: string; readonly status: 'PLANNED' | 'APPLIED'; readonly layout: unknown; readonly lineIds?: readonly string[]; readonly appliedAt?: string; readonly name: string }): Promise<string> {
  const id = newId()
  const fileId = newId()
  const companyId = input.companyId ?? A.companyA
  await force(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility)
     VALUES ($1, $2, $3, 'ImportJob', $4, 'DOCUMENT', $5, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100, $6, $7, $8, 'AVAILABLE', '{OFFICE}')`,
    [fileId, A.tenant, companyId, id, input.name, createHash('sha256').update(id).digest('hex'), S.store, `t/${A.tenant}/imports/${id}`],
  )
  await force(
    `INSERT INTO "ImportJob" (id, "tenantId", "companyId", "importerKey", "fileId", layout, status, mode, "rowCount", "appliedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'sales.orders', $4, $5::jsonb, $6, 'DRY_RUN', $7, $8, now(), now())`,
    [id, A.tenant, companyId, fileId, JSON.stringify(input.layout), input.status, input.lineIds?.length ?? 0, input.status === 'APPLIED' ? (input.appliedAt ?? new Date().toISOString()) : null],
  )
  for (const [index, lineId] of (input.lineIds ?? []).entries()) {
    await force(`INSERT INTO "ImportRow" (id, "tenantId", "jobId", "rowNumber", action, "recordId", outcome, "appliedAt") VALUES ($1, $2, $3, $4, 'CREATE', $5, 'APPLIED', now())`, [newId(), A.tenant, id, index + 2, lineId])
  }
  return id
}

const MANAGE: Permission[] = ['orders.view', 'orders.manage', 'imports.view', 'imports.run']
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all', companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => office([grant(MANAGE)]),
  brandBOnly: () => office([grant(MANAGE, [A.brandB])]),
  companyBOnly: () => office([grant(MANAGE, 'all', [A.companyB])]),
  viewer: () => office([grant(['orders.view', 'imports.view'])]),
}
async function remembered(session: string, importId: string, partyId: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url: `/sales/order-import/${importId}/remembered-mapping?partyId=${partyId}`, headers: { 'x-test-session': session } })
  return { status: response.statusCode, body: response.json() as Json }
}

beforeAll(async () => {
  db = await migratedDatabase('order_import_memory')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: ns })
  await seedSales({ db: database, namespace: ns })
  S.store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [A.tenant]))[0]?.id
  if (!S.store) {
    S.store = newId()
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE')`, [S.store, A.tenant])
  }
  const so1 = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [A.tenant]))[0]!.id
  S.linesA = (await admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [so1])).map((row) => row.id)
  // Brand B's order: a copy of SEED-SO-0001 for SEED-C2.
  const orderB = newId()
  await copy('SalesOrder', so1, { id: orderB, number: 'TEST-SO-B1', partyId: A.brandB, quoteVersionId: null })
  S.linesB = []
  for (const lineId of S.linesA) {
    const copyId = newId()
    S.linesB.push(copyId)
    await copy('SalesOrderLine', lineId, { id: copyId, orderId: orderB, partyId: A.brandB })
  }
  // Brand A's mapping, applied two days ago; a newer sheet of the same headers whose orders went to both brands; a newer dry
  // run of brand A never applied, with other columns.
  S.applied = await job({ status: 'APPLIED', layout: layout(HEADERS), lineIds: S.linesA, appliedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), name: 'Brand Alpha week 45.xlsx' })
  S.mixed = await job({ status: 'APPLIED', layout: layout(HEADERS, COLUMNS.map((entry) => (entry.header === 'Pz' ? { ...entry, column: 'customerPo' } : entry))), lineIds: [S.linesA[0], S.linesB[0]], appliedAt: new Date(Date.now() - 86_400_000).toISOString(), name: 'Two customers.xlsx' })
  S.dryRun = await job({ status: 'PLANNED', layout: layout(HEADERS, COLUMNS.slice(0, 3)), name: 'Brand Alpha draft.xlsx' })
  // This week's sheet of brand A: the same headers, another order and case, just read by its dry run.
  S.asking = await job({ status: 'PLANNED', layout: layout(['note', 'PZ', 'tg', 'col.', 'art.', 'cliente', 'RIF'], [], []), name: 'Brand Alpha week 46.xlsx' })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('B-TH-101: order import remembers a customer’s columns', () => {
  it('brand A’s next sheet with the same headers is offered the columns of its last applied import', async () => {
    const answer = await remembered('sales', S.asking, A.brandA)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.remembered).toEqual({
      mapping: { Rif: 'order', Cliente: 'customer', 'Art.': 'style', 'Col.': 'colour', Tg: 'size', Pz: 'quantity', Note: null },
      fromImportId: S.applied,
      fileName: 'Brand Alpha week 45.xlsx',
      appliedAt: expect.any(String),
    })
  })

  it('W17-like: brand A’s mapping is never offered for brand B; a sheet of two customers is no one’s memory', async () => {
    expect((await remembered('sales', S.asking, A.brandB)).body).toEqual({ remembered: null })
    // A person limited to brand B asking for brand A: nothing, and no hint that brand A has a mapping.
    expect((await remembered('brandBOnly', S.asking, A.brandA)).body).toEqual({ remembered: null })
    // The two-customer import is newer, but its "Pz → Customer PO" is never what brand A is offered.
    expect((await remembered('sales', S.asking, A.brandA)).body.remembered.fromImportId).toBe(S.applied)
  })

  it('other headers, an unread sheet or no right to import: nothing offered; another company’s import or a viewer: refused', async () => {
    const other = await job({ status: 'PLANNED', layout: layout(['Order', 'Customer', 'Style']), name: 'Other headers.xlsx' })
    expect((await remembered('sales', other, A.brandA)).body).toEqual({ remembered: null })
    const unread = await job({ status: 'PLANNED', layout: null, name: 'Not read yet.xlsx' })
    expect((await remembered('sales', unread, A.brandA)).body).toEqual({ remembered: null })
    expect((await remembered('companyBOnly', S.asking, A.brandA)).status).toBe(404)
    expect((await remembered('viewer', S.asking, A.brandA)).status).toBe(403)
    expect((await remembered('sales', newId(), A.brandA)).status).toBe(404)
  })

  it('a layout becomes the mapping an import starts with (header → column, a header left out → null)', () => {
    expect(mappingOf({ columns: [{ index: 0, header: 'Art.', column: 'style' }], ignored: [{ index: 1, header: 'Note', reason: 'x' }] })).toEqual({ 'Art.': 'style', Note: null })
  })
})
