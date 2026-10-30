import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { applyPlan, planImport } from '../worker'

/**
 * The guided first load and the import templates (B-W2a-41; PLT-185, PLT-177) on the local stack, with the app's real
 * routes and the imports platform's real dry run and apply on the factory-db seeds: customers → suppliers → materials →
 * opening stock → open orders, each step's reconciliation (rows in the sheet against the records there now; opening stock:
 * quantities per unit and, with the cost grain only, the value), "Done" refused out of order, without an import or with
 * a difference (in words), kept as an audit row; open orders done as "nothing to load". Templates: every importer the
 * person may use, money columns only with the grain. Made-up codes only. Run: `node scripts/factory/run-pg-tests.mjs
 * platform/imports`.
 */

let h: Harness
let app: FastifyInstance

const ns = 'first-load-a'
const A = { tenant: seedUuid(ns, 'tenant'), companyA: seedUuid(ns, 'company:A') }
const BASE: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const LOADS: Permission[] = ['parties.view', 'parties.manage', 'product.materials.view', 'product.materials.manage', 'inventory.opening.import', 'inventory.stock.view']
interface Person {
  readonly permissions: readonly Permission[]
  readonly grains: readonly 'cost'[]
}
const PEOPLE: Record<string, Person> = {
  loader: { permissions: [...BASE, ...LOADS], grains: ['cost'] },
  /** Loads everything but sees no money. */
  clerk: { permissions: [...BASE, ...LOADS], grains: [] },
  /** Reads the imports, may not mark a step done. */
  reader: { permissions: ['imports.view', 'parties.view', 'product.materials.view', 'inventory.stock.view'], grains: [] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions, ...person.grains.map((grain) => `money.${grain}` as Permission)], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: A.tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let counter = 0
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': `first-load-${run}-${++counter}` }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const system = (): CommandCaller => callerFor(h.database, systemContext(A.tenant, newId()))
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')

/** The whole flow of one sheet: announce, send, confirm, dry run, apply (as the worker does). */
async function load(importerKey: string, body: Buffer, session = 'loader'): Promise<Json> {
  const started = await ok(session, 'POST', '/imports', { importerKey, companyId: A.companyA, file: { originalName: `${importerKey}.csv`, contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha(body) } }, 201)
  const sent = await app.inject({ method: 'PUT', url: started.upload.url, headers: started.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  await ok(session, 'POST', `/files/${started.job.fileId}/complete`)
  await planImport(system(), started.job.id, { lastAttempt: true })
  const planned = (await ok(session, 'GET', `/imports/${started.job.id}`)).job
  expect(planned.status, JSON.stringify(planned.issues ?? planned.error)).toBe('PLANNED')
  await ok(session, 'POST', `/imports/${planned.id}/apply`, { version: planned.version })
  await applyPlan(system(), planned.id, { lastAttempt: true })
  return (await ok(session, 'GET', `/imports/${planned.id}`)).job
}
const steps = async (session = 'loader'): Promise<Record<string, Json>> => {
  const body = await ok(session, 'GET', `/imports/first-load?companyId=${A.companyA}`)
  return Object.fromEntries((body.steps as Json[]).map((step) => [step.step, step]))
}
const done = (step: string, payload: Json = {}, session = 'loader') => call(session, 'POST', `/imports/first-load/${step}/done`, { companyId: A.companyA, ...payload })

beforeAll(async () => {
  h = await startHarness('imports_first_load')
  await seedCore({ db: h.database, namespace: ns })
  await seedProduction({ db: h.database, namespace: ns })
  await seedNumbering({ db: h.database, namespace: ns })
  await seedCompliance({ db: h.database, namespace: ns })
  await seedFiles({ db: h.database, namespace: ns })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], A.tenant, `${key}-${run}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, A.tenant, `custom.first_load_${key}`, key, person.permissions, person.grains])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), A.tenant, IDS[key], roleId])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('import templates (PLT-177)', () => {
  it('serves every importer the person may use as CSV and Excel; money columns only with the grain', async () => {
    const parties = await call('loader', 'GET', '/imports/importers/parties.parties/template?format=csv')
    expect(parties.statusCode).toBe(200)
    expect(parties.headers['content-type']).toMatch(/^text\/csv/)
    expect(parties.headers['content-disposition']).toBe('attachment; filename="parties-parties-template.csv"')
    expect(parties.body.split('\r\n')[0]).toMatch(/^Code;Legal name;Trade name;Kind;Roles;/)
    const withCost = await call('loader', 'GET', '/imports/importers/product.materials/template?format=csv&numberFormat=en')
    expect(withCost.body.split('\r\n')[0]).toContain('Standard cost')
    expect(withCost.body).toContain('18.50')
    const noCost = await call('clerk', 'GET', '/imports/importers/product.materials/template?format=csv')
    expect(noCost.body.split('\r\n')[0]).not.toContain('Standard cost')
    const excel = await call('loader', 'GET', '/imports/importers/inventory.opening/template?format=xlsx')
    expect(excel.statusCode).toBe(200)
    expect(excel.headers['content-type']).toBe(SHEET_TYPES.xlsx)
    expect((await call('reader', 'GET', '/imports/importers/product.operations/template')).statusCode).toBe(404)
    expect((await call('loader', 'GET', '/imports/importers/no.such/template')).statusCode).toBe(404)
  })
})

describe('the guided first load (PLT-185)', () => {
  it('starts with customers to do and every later step waiting; open orders have no importer', async () => {
    const start = await steps()
    expect(Object.entries(start).map(([step, facts]) => [step, facts.state])).toEqual([['customers', 'todo'], ['suppliers', 'waiting'], ['materials', 'waiting'], ['openingStock', 'waiting'], ['openOrders', 'waiting']])
    expect(start.suppliers!.waitingFor).toBe('customers')
    expect(start.openOrders).toMatchObject({ importerKey: null })
    const early = await done('materials')
    expect(early.statusCode).toBe(409)
    expect(early.json().error.issues[0]).toMatchObject({ path: 'step/waiting/customers' })
    expect((await done('customers')).json().error.issues).toEqual([{ path: 'step/noImport', message: expect.stringMatching(/Import the sheet/) }])
    expect((await done('customers', {}, 'reader')).statusCode).toBe(403)
  })

  it('customers and suppliers: a refused row is a difference that blocks Done; a clean sheet matches', async () => {
    await load('parties.parties', csv([
      'Codice;Ragione sociale;Tipo soggetto;Ruoli;Paese',
      `FL-C1-${run};Cliente Uno S.r.l.;ORGANISATION;cliente;IT`,
      `FL-C2-${run};Cliente Due S.r.l.;ORGANISATION;cliente;IT`,
      `FL-S1-${run};Conceria Uno S.p.A.;ORGANISATION;fornitore;IT`,
      `FL-X1-${run};;ORGANISATION;nessuno;IT`,
    ]))
    const mixed = await steps()
    expect(mixed.customers).toMatchObject({ state: 'mismatch', matches: false, reconciliation: { rows: 4, loaded: 3, refused: 1, skipped: 0, roles: { customers: 2, suppliers: 1 } } })
    expect(mixed.customers!.differences.map((issue: Json) => issue.path)).toEqual(['difference/refused'])
    const refused = await done('customers')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toMatch(/1 row was refused/)

    await load('parties.parties', csv([
      'Codice;Ragione sociale;Tipo soggetto;Ruoli;Paese',
      `FL-C1-${run};Cliente Uno S.r.l.;ORGANISATION;cliente;IT`,
      `FL-C2-${run};Cliente Due S.r.l.;ORGANISATION;cliente;IT`,
      `FL-S1-${run};Conceria Uno S.p.A.;ORGANISATION;fornitore;IT`,
    ]))
    const clean = await steps()
    expect(clean.customers).toMatchObject({ state: 'ready', matches: true, reconciliation: { rows: 3, loaded: 3, refused: 0 } })
    const after = await done('customers', { reason: 'Customers from the old system' })
    expect(after.statusCode, after.body).toBe(200)
    const view = Object.fromEntries((after.json().steps as Json[]).map((step) => [step.step, step]))
    expect(view.customers).toMatchObject({ state: 'done', done: { byId: IDS.loader, nothing: false, stillMatches: true } })
    expect(view.suppliers).toMatchObject({ state: 'ready' })
    expect((await done('customers')).json().error.issues[0]).toMatchObject({ path: 'step/done' })
    expect(await ok('loader', 'POST', `/imports/first-load/suppliers/done`, { companyId: A.companyA })).toMatchObject({ complete: false })
    const [audit] = await admin(`SELECT action, "recordType", reason, after FROM "AuditLog" WHERE action = 'imports.firstLoadStepDone' AND "companyId" = $1 ORDER BY at LIMIT 1`, [A.companyA])
    expect(audit).toMatchObject({ action: 'imports.firstLoadStepDone', recordType: 'ImportJob', reason: 'Customers from the old system', after: { step: 'customers', nothing: false, rows: 3, loaded: 3 } })
  })

  it('materials, then opening stock with its quantities per unit and the value only with the cost grain', async () => {
    await load('product.materials', csv([
      'Codice;Nome;Tipo;Approvvigionamento;Tracciabilità;UM',
      `FL-THR-${run};Filo di prova;THREAD;BUY;NONE;CONE`,
      `FL-BOX-${run};Scatola di prova;PACKAGING;BUY;NONE;PCS`,
    ]))
    expect((await steps()).materials).toMatchObject({ state: 'ready', reconciliation: { rows: 2, loaded: 2 } })
    await ok('loader', 'POST', '/imports/first-load/materials/done', { companyId: A.companyA })

    await load('inventory.opening', csv([
      'Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Costo unitario',
      `FL-0001-${run};A1;A1-STORE;SEED-LIN-200;GRY;FL-R1-${run};120;mt;2,5`,
      `FL-0002-${run};A1;A1-STORE;SEED-LIN-200;GRY;FL-R2-${run};10;mt;`,
    ]))
    const opening = (await steps()).openingStock!
    expect(opening).toMatchObject({ state: 'ready', matches: true, reconciliation: { rows: 2, loaded: 2, quantities: [{ unit: 'M', sheet: '130.0000', loaded: '130.0000' }] } })
    expect(opening.reconciliation.value).toMatchObject({ sheet: 30000, loaded: 30000, rowsAtStandard: 1, currency: 'EUR' })
    const clerk = (await steps('clerk')).openingStock!
    expect(clerk.reconciliation).not.toHaveProperty('value')
    expect(JSON.stringify(clerk)).not.toMatch(/30000/)
    await ok('loader', 'POST', '/imports/first-load/openingStock/done', { companyId: A.companyA })
  })

  it('open orders: no importer, done only as "nothing to load"; then the first load is complete', async () => {
    const held = (await steps()).openOrders!
    expect(held).toMatchObject({ state: 'held', canImport: false, canMarkDone: true })
    expect((await done('openOrders')).json().error.issues[0]).toMatchObject({ path: 'step/noImporter' })
    const finished = await ok('loader', 'POST', '/imports/first-load/openOrders/done', { companyId: A.companyA, nothing: true, reason: 'Open orders entered by hand' })
    expect(finished.complete).toBe(true)
    expect((finished.steps as Json[]).map((step) => step.state)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect((finished.steps as Json[]).at(-1)).toMatchObject({ done: { nothing: true, stillMatches: null } })
    expect((await call('loader', 'GET', `/imports/first-load?companyId=${newId()}`)).statusCode).toBe(404)
  })
})
