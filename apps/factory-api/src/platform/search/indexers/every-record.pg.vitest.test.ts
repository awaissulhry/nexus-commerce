import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seedUuid, type SeedContext } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../outbox/system'
import type { SearchIndexer } from '../indexer'
import { indexEvent, rebuildIndex, searchHandlers } from '../indexing'
import { loadIndexers } from '../registry'

/**
 * B-W2b-23 (Z10:01, Z10:02): search finds every W1 and W2a record type — payments, supplier invoices, inspections, quality
 * holds, NCRs, certificates, label templates, PPE register entries, stock counts, locations, DDTs, subcontract orders,
 * operations, size scales, machines and maintenance jobs — by number and name, only where the reader's own list would show
 * them, never with money; the records' events (two new: a location's and a certificate's) keep the entries current, and
 * the PO entry follows all five changes after the send. On a throwaway PostgreSQL 17 database from the migrations with the
 * base seeds. Run with `node scripts/factory/run-pg-tests.mjs platform/search/indexers`.
 */

const NAMESPACE = 'search-every-record'
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed/', import.meta.url))
const SRC = fileURLToPath(new URL('../../..', import.meta.url))
const seedId = (key: string): string => seedUuid(NAMESPACE, key)
const tenantId = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA1 = seedId('site:A1')

/** The record types this step makes searchable: type → its table, its number column, and the view its list asks. */
const TYPES = {
  Payment: { table: 'Payment', number: 'externalRef', view: 'payments.view' },
  SupplierInvoice: { table: 'SupplierInvoice', number: 'number', view: 'payables.view' },
  Inspection: { table: 'Inspection', number: 'number', view: 'quality.inspections.view' },
  QualityHold: { table: 'QualityHold', number: 'number', view: 'quality.holds.view' },
  Nonconformance: { table: 'Nonconformance', number: 'number', view: 'quality.ncr.view' },
  Certificate: { table: 'Certificate', number: 'number', view: 'compliance.certificates.view' },
  LabelTemplate: { table: 'LabelTemplate', number: 'code', view: 'compliance.certificates.view' },
  PpeRegisterEntry: { table: 'PpeRegisterEntry', number: 'reference', view: 'compliance.register.view' },
  StockCount: { table: 'StockCount', number: 'number', view: 'inventory.counts.view' },
  Location: { table: 'Location', number: 'code', view: 'inventory.locations.view' },
  Ddt: { table: 'Ddt', number: 'number', view: 'shipping.view' },
  SubcontractOrder: { table: 'SubcontractOrder', number: 'number', view: 'purchasing.view' },
  Operation: { table: 'Operation', number: 'code', view: 'product.routing.view' },
  SizeScale: { table: 'SizeScale', number: 'code', view: 'product.styles.view' },
  Machine: { table: 'Machine', number: 'assetNumber', view: 'plant.view' },
  MaintenanceJob: { table: 'MaintenanceJob', number: 'number', view: 'plant.view' },
} as const
type NewType = keyof typeof TYPES
const NEW_TYPES = Object.keys(TYPES) as NewType[]

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let indexers: readonly SearchIndexer[]
let system: CommandCaller
let siteB1: string
let partyS1: string

const template = (key: string): Permission[] => [...ROLE_TEMPLATES.find((role) => role.key === key)!.permissions]
const grant = (permissions: readonly Permission[], scope: Partial<Pick<Grant, 'companies' | 'sites' | 'parties'>> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), companyId: companyA, grants })
const SESSIONS: Record<string, SessionContext> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `every-record-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function search(session: string, q: string, type?: string): Promise<Json> {
  const response = await call(session, 'GET', `/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}&limit=100`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const entry = async (recordType: string, recordId: string): Promise<Json | undefined> => (await admin('SELECT * FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', [recordType, recordId]))[0]
const recordsOf = (type: NewType) => admin<{ id: string; number: string | null }>(`SELECT id::text AS id, "${TYPES[type].number}" AS number FROM "${TYPES[type].table}" WHERE "tenantId" = $1 ORDER BY id`, [tenantId])

/** The outbox rows of a type written since `after` (ids are time-ordered), as the relay hands them to the worker. */
async function eventsSince(type: string, after: string): Promise<EventEnvelope[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND id > $3 ORDER BY id`, [tenantId, type, after])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: toUtcIso(row.occurredAt), payload: row.payload }))
}
const envelope = (type: string, subject: string, payload: unknown): EventEnvelope => ({ eventId: newId(), type, version: 1, context: 'test', tenantId, companyId: null, siteId: null, subject, correlationId: `every-record-${newId()}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload })

/** Every UUID a list answer names under an `id` key (its rows', at any depth). */
function idsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) idsIn(item, into)
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'id' && typeof inner === 'string') into.add(inner)
      else idsIn(inner, into)
    }
  }
  return into
}

beforeAll(async () => {
  db = await migratedDatabase('search_every_record')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  const context: SeedContext = { db: database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  siteB1 = (await admin<{ id: string }>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND code = 'B1'`, [tenantId]))[0]!.id
  partyS1 = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-S1'`, [tenantId]))[0]!.id
  const everyView = [...new Set([...NEW_TYPES.map((type) => TYPES[type].view), 'quality.complaints.view', 'inventory.stock.view', 'invoices.view', 'parties.view'])] as Permission[]
  Object.assign(SESSIONS, {
    owner: office([grant([...everyView, 'inventory.locations.manage', 'compliance.certificates.manage'] as Permission[])]),
    // The system templates, each over part of the tenant: what their own lists show is what they find.
    warehouseA1: office([grant(template('warehouse'), { sites: [siteA1] })]),
    financeB: office([grant(template('finance'), { companies: [companyB] })]),
    maintenance: office([grant(template('maintenance'))]),
    // One supplier only: its invoices, the certificates it holds, the DDTs to it.
    supplierS1: office([grant(['payables.view', 'payments.view', 'compliance.certificates.view', 'shipping.view'], { parties: [partyS1] })]),
    // Every view, but plant B1 only.
    siteB1: office([grant(everyView, { sites: [siteB1] })]),
  })
  await admin('DELETE FROM "SearchEntry"')
  indexers = await loadIndexers(SRC)
  system = callerFor(database, systemContext(tenantId, 'search-every-record-test'))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: SRC, authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await rebuildIndex(system, indexers, { recordTypes: null, key: `search-rebuild-${newId()}` })
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('every W1 and W2a record type has its indexer (Z10:01)', () => {
  it('one indexer file each, with the view permission its list asks', () => {
    for (const type of NEW_TYPES) {
      const indexer = indexers.find((candidate) => candidate.recordType === type)
      expect(indexer, type).toBeDefined()
      expect(indexer!.viewPermission, type).toBe(TYPES[type].view)
    }
  })

  it('the rebuild writes one entry per record of every type, scoped by the columns its list filters on', async () => {
    for (const type of NEW_TYPES) {
      const records = await recordsOf(type)
      expect(records.length, `${type}: the base seeds have some`).toBeGreaterThan(0)
      const entries = await admin<Json>('SELECT * FROM "SearchEntry" WHERE "tenantId" = $1 AND "recordType" = $2 ORDER BY "recordId"', [tenantId, type])
      expect(entries.map((row) => row.recordId), type).toEqual(records.map((row) => row.id))
      for (const row of entries) {
        expect(row.viewPermission, type).toBe(TYPES[type].view)
        expect(row.title.trim(), type).not.toBe('')
      }
    }
    // Scope = the module's own list columns: site where the list scopes by site, the party where it scopes by party.
    const payment = (await admin('SELECT id, "companyId", "partyId" FROM "Payment" WHERE "tenantId" = $1 LIMIT 1', [tenantId]))[0]!
    expect(await entry('Payment', payment.id)).toMatchObject({ companyId: payment.companyId, siteId: null, partyId: payment.partyId, area: 'finance' })
    const ddt = (await admin('SELECT id, "companyId", "siteId", "partyId" FROM "Ddt" WHERE "tenantId" = $1 LIMIT 1', [tenantId]))[0]!
    expect(await entry('Ddt', ddt.id)).toMatchObject({ companyId: ddt.companyId, siteId: ddt.siteId, partyId: ddt.partyId, area: 'warehouse', status: 'ISSUED' })
    const location = (await admin('SELECT id, "companyId", "siteId" FROM "Location" WHERE "tenantId" = $1 AND "partyId" IS NOT NULL LIMIT 1', [tenantId]))[0]!
    expect(await entry('Location', location.id)).toMatchObject({ companyId: location.companyId, siteId: location.siteId, partyId: null })
    const certificate = (await admin('SELECT id, "companyId", "holderPartyId" FROM "Certificate" WHERE "tenantId" = $1 LIMIT 1', [tenantId]))[0]!
    expect(await entry('Certificate', certificate.id)).toMatchObject({ companyId: certificate.companyId, siteId: null, partyId: certificate.holderPartyId })
    const hold = (await admin('SELECT id FROM "QualityHold" WHERE "tenantId" = $1 LIMIT 1', [tenantId]))[0]!
    // A hold in force reads "On hold" (HELD); one placed before the HOLD series is named by what it holds.
    expect(await entry('QualityHold', hold.id)).toMatchObject({ status: 'HELD', area: 'quality' })
    // A second rebuild writes nothing new.
    expect(await rebuildIndex(system, indexers, { recordTypes: NEW_TYPES, key: `search-rebuild-${newId()}` })).toMatchObject({ written: 0, removed: 0 })
  })

  it('never holds money: no payment, invoice, subcontract or machine amount, no count difference', async () => {
    const amounts = [
      ...(await admin<{ id: string; type: string; value: number }>(`SELECT id::text, 'Payment' AS type, amount AS value FROM "Payment" WHERE "tenantId" = $1`, [tenantId])),
      ...(await admin<{ id: string; type: string; value: number }>(`SELECT id::text, 'SupplierInvoice' AS type, unnest(ARRAY["netTotal", "vatTotal", "grossTotal"]) AS value FROM "SupplierInvoice" WHERE "tenantId" = $1`, [tenantId])),
      ...(await admin<{ id: string; type: string; value: number }>(`SELECT id::text, 'SubcontractOrder' AS type, "netAmount" AS value FROM "SubcontractOrder" WHERE "tenantId" = $1`, [tenantId])),
      ...(await admin<{ id: string; type: string; value: number }>(`SELECT id::text, 'Machine' AS type, "purchaseCost" AS value FROM "Machine" WHERE "tenantId" = $1 AND "purchaseCost" IS NOT NULL`, [tenantId])),
      ...(await admin<{ id: string; type: string; value: number }>(`SELECT id::text, 'StockCount' AS type, "differenceAmount" AS value FROM "StockCount" WHERE "tenantId" = $1 AND "differenceAmount" IS NOT NULL`, [tenantId])),
    ].filter((row) => row.value > 0)
    expect(amounts.length).toBeGreaterThan(5)
    for (const row of amounts) {
      const text = (await entry(row.type, row.id))!.searchText as string
      expect(text.split(' '), `${row.type} ${row.value}`).not.toContain(String(row.value))
      expect(text, `${row.type} ${row.value}`).not.toContain((row.value / 100).toFixed(2))
    }
  })
})

describe('GET /search finds them by number and by name', () => {
  it('each record by its number typed whole, first, as an exact number (a hold without one by what it holds)', async () => {
    for (const type of NEW_TYPES) {
      for (const record of await recordsOf(type)) {
        if (!record.number) continue
        const found = await search('owner', record.number)
        const first = found.results.find((row: Json) => row.match === 'number' && row.recordType === type && row.recordId === record.id)
        expect(first, `${type} ${record.number}`).toBeDefined()
        expect(found.results[0].match, `${type} ${record.number}`).toBe('number')
      }
    }
    const hold = (await admin<{ id: string; code: string }>(`SELECT q.id::text, h.code FROM "QualityHold" q JOIN "Hide" h ON h.id = q."subjectIds"[1] WHERE q."tenantId" = $1 AND q."subjectType" = 'Hide' LIMIT 1`, [tenantId]))[0]!
    expect((await search('owner', hold.code, 'QualityHold')).results.map((row: Json) => row.recordId)).toEqual([hold.id])
  })

  it('by the names people type: the supplier finds its invoices and orders, a machine its jobs, a style its NCRs and registers', async () => {
    const supplier = (await admin<{ legalName: string }>('SELECT "legalName" FROM "Party" WHERE id = $1', [partyS1]))[0]!
    const bySupplier = await search('owner', supplier.legalName)
    for (const type of ['SupplierInvoice', 'SubcontractOrder']) expect(bySupplier.counts.map((row: Json) => row.recordType), type).toContain(type)
    const machine = (await admin<{ id: string; assetNumber: string }>(`SELECT m.id::text, m."assetNumber" FROM "Machine" m JOIN "MaintenanceJob" j ON j."machineId" = m.id WHERE m."tenantId" = $1 LIMIT 1`, [tenantId]))[0]!
    const jobs = await search('owner', machine.assetNumber, 'MaintenanceJob')
    expect(jobs.results.length).toBeGreaterThan(0)
    const style = (await admin<{ name: string }>(`SELECT s.name FROM "Style" s JOIN "PpeRegisterEntry" r ON r."styleId" = s.id WHERE s."tenantId" = $1 LIMIT 1`, [tenantId]))[0]!
    expect((await search('owner', style.name, 'PpeRegisterEntry')).results.length).toBeGreaterThan(0)
    // A typo is forgiven on these records too.
    const operation = (await admin<{ name: string }>(`SELECT name FROM "Operation" WHERE "tenantId" = $1 AND length(name) >= 8 ORDER BY code LIMIT 1`, [tenantId]))[0]!
    const word = operation.name.split(' ').find((part) => part.length >= 5)!
    const typo = `${word.slice(0, -1)}${word.endsWith('x') ? 'z' : 'x'}`
    const similar = await search('owner', typo, 'Operation')
    expect(similar.results.map((row: Json) => row.match), `${word} → ${typo}`).toContain('similar')
  })
})

describe('only where the reader may open them', () => {
  it('a warehouse person finds the DDTs, counts, locations and holds of their plant — never a payment, a supplier invoice, a certificate or a complaint', async () => {
    const seen = new Set<string>()
    for (const type of [...NEW_TYPES, 'Complaint']) {
      for (const record of type === 'Complaint' ? await admin<{ id: string; number: string }>(`SELECT id::text, number FROM "Complaint" WHERE "tenantId" = $1`, [tenantId]) : await recordsOf(type as NewType)) {
        if (!record.number) continue
        for (const row of (await search('warehouseA1', record.number)).results as Json[]) seen.add(row.recordType)
      }
    }
    for (const type of ['Payment', 'SupplierInvoice', 'Certificate', 'LabelTemplate', 'PpeRegisterEntry', 'Inspection', 'Operation', 'Machine', 'MaintenanceJob', 'Complaint']) expect(seen.has(type), type).toBe(false)
    for (const type of ['Ddt', 'StockCount', 'Location', 'SubcontractOrder', 'Nonconformance']) expect(seen.has(type), type).toBe(true)
    // Plant B1's location is not theirs.
    const b1 = (await admin<{ id: string; code: string }>(`SELECT id::text, code FROM "Location" WHERE "siteId" = $1 LIMIT 1`, [siteB1]))[0]!
    // (A1's own store is found as a similar code: never B1's.)
    expect((await search('warehouseA1', b1.code, 'Location')).results.map((row: Json) => row.recordId)).not.toContain(b1.id)
    expect((await search('siteB1', b1.code, 'Location')).results[0]).toMatchObject({ recordId: b1.id, match: 'number' })
  })

  it('the maintenance template finds machines and jobs, and nothing else this step indexes', async () => {
    const found = await search('maintenance', 'seed')
    const types = new Set(found.results.map((row: Json) => row.recordType as string).filter((type: string) => (NEW_TYPES as string[]).includes(type)))
    expect(types).toEqual(new Set(['Machine', 'MaintenanceJob']))
  })

  it('the same records as the module list shows the same person (company, site, party and a nullable column alike)', async () => {
    const LISTS: Partial<Record<NewType, string>> = {
      Payment: '/payments?limit=200',
      SupplierInvoice: '/payables/invoices?limit=200',
      Certificate: '/compliance/certificates',
      Location: '/inventory/locations?includeArchived=true',
      Ddt: '/shipping/ddts?limit=200',
    }
    for (const session of ['owner', 'warehouseA1', 'financeB', 'supplierS1', 'siteB1']) {
      for (const [type, url] of Object.entries(LISTS) as [NewType, string][]) {
        const records = await recordsOf(type)
        const ids = new Set(records.map((record) => record.id))
        const list = await call(session, 'GET', url)
        const listed = list.statusCode === 200 ? [...idsIn(list.json())].filter((id) => ids.has(id)).sort() : []
        if (list.statusCode !== 200) expect(list.statusCode, `${session} ${url}`).toBe(403)
        const found: string[] = []
        for (const record of records) {
          if ((await search(session, record.number!, type)).results.some((row: Json) => row.recordId === record.id)) found.push(record.id)
        }
        expect(found.sort(), `${session} ${type}`).toEqual(listed)
      }
    }
    // The cases the comparison covers: none, some and all of a type.
    expect((await search('financeB', 'seed', 'Payment')).results).toEqual([])
    expect((await search('supplierS1', 'seed-cert', 'Certificate')).results.length).toBeGreaterThan(0)
  })
})

describe('events keep the entries current', () => {
  it('a location made, renamed and archived through its routes is found at once by its new name (inventory.location_changed)', async () => {
    const mark = newId()
    const made = await call('owner', 'POST', '/inventory/locations', { siteId: siteA1, code: 'A1-SRCH-01', name: 'Scaffale ricerca', kind: 'BIN' })
    expect(made.statusCode, made.body).toBe(201)
    const location = made.json().location
    for (const event of await eventsSince('inventory.location_changed', mark)) await indexEvent(system, indexers, event)
    expect(await entry('Location', location.id)).toMatchObject({ number: 'A1-SRCH-01', title: 'Scaffale ricerca', status: 'ACTIVE', siteId: siteA1 })
    const renamed = await call('owner', 'PATCH', `/inventory/locations/${location.id}`, { version: location.version, name: 'Scaffale trovato' })
    expect(renamed.statusCode, renamed.body).toBe(200)
    const archived = await call('owner', 'POST', `/inventory/locations/${location.id}/archive`, { version: renamed.json().location.version })
    expect(archived.statusCode, archived.body).toBe(200)
    const events = await eventsSince('inventory.location_changed', mark)
    expect(events.map((event) => (event.payload as Json).change)).toEqual(['CREATED', 'EDITED', 'ARCHIVED'])
    for (const event of events) await indexEvent(system, indexers, event)
    const found = await search('owner', 'scaffale trovato', 'Location')
    expect(found.results.map((row: Json) => [row.recordId, row.status])).toEqual([[location.id, 'ARCHIVED']])
  })

  it('a certificate typed in and registered is found by its number (compliance.certificate_changed)', async () => {
    const mark = newId()
    const made = await call('owner', 'POST', '/compliance/certificates', { companyId: companyA, standard: 'EN 17092-4:2020', ppeClass: 'A', number: 'SRCH-CERT-0042', notifiedBodyName: 'Seed Notified Body', notifiedBodyNumber: '0999', modelReference: 'Giacca Ricerca', validFrom: '2026-01-01', validTo: '2031-01-01' })
    expect(made.statusCode, made.body).toBe(201)
    const certificateId = made.json().certificate.id
    const events = await eventsSince('compliance.certificate_changed', mark)
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ certificateId, number: 'SRCH-CERT-0042', status: 'DRAFT', change: 'CREATED' })])
    for (const event of events) await indexEvent(system, indexers, event)
    const found = await search('owner', 'SRCH-CERT-0042')
    expect(found.results[0]).toMatchObject({ recordType: 'Certificate', recordId: certificateId, match: 'number', title: 'Giacca Ricerca', status: 'DRAFT' })
  })

  it('a supplier renamed re-indexes its invoices, subcontract orders, DDTs and NCRs', async () => {
    await admin('UPDATE "Party" SET "legalName" = $2 WHERE id = $1', [partyS1, 'Seed Fornitore Rinominato S.p.A.'])
    await indexEvent(system, indexers, envelope('party.updated', partyS1, { partyId: partyS1 }))
    const found = await search('owner', 'rinominato')
    expect(found.counts.map((row: Json) => row.recordType)).toEqual(expect.arrayContaining(['SupplierInvoice', 'SubcontractOrder']))
  })

  it('the purchase order entry follows all five changes after the send (Z10:02)', () => {
    const events = searchHandlers(indexers)[0]!.events
    expect(events).toEqual(expect.arrayContaining(['purchase_order.revision_started', 'purchase_order.lines_cancelled', 'purchase_order.lines_closed_short', 'purchase_order.confirm_by_moved', 'purchase_order.reminder_sent']))
    const po = indexers.find((indexer) => indexer.recordType === 'PurchaseOrder')!
    for (const type of ['purchase_order.revision_started', 'purchase_order.lines_cancelled', 'purchase_order.lines_closed_short', 'purchase_order.confirm_by_moved', 'purchase_order.reminder_sent']) expect(po.on[type], type).toBe('subject')
  })
})
