import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Approved sources (B-W2a-10; SCM-005) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security, the grants and the …_supply_w2a_guards triggers are real),
 * the factory-db seeds up to production (the leather bought by the hide of 52.5 ft² from the supplier P2, its article
 * SEED-ART-100, black S-001; PO1 sent and confirmed with 420 ft² of black leather at 4.20), two more made-up suppliers,
 * and sessions from the test authenticator. Then the plan's Draft PO with a source: the source's unit, minimum, steps,
 * price and codes. Every name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs supplier-items`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'sources-a', b: 'sources-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  supplier: idOf('party:P2'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
}
/** Two more suppliers, made up here: one of company A, one of every company. */
const S2 = newId()
const S3 = newId()

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const KEEP: Permission[] = ['purchasing.view', 'purchasing.sources.manage', 'money.cost']
const SESSIONS: Record<string, () => SessionContext> = {
  buyer: () => office(A.tenant, [grant([...KEEP, 'purchasing.manage', 'purchasing.send', 'planning.view', 'planning.run'])]),
  planner: () => office(A.tenant, [grant(['purchasing.view', 'planning.view', 'planning.run'])]),
  keeperA: () => office(A.tenant, [grant(KEEP, [A.companyA])]),
  companyB: () => office(A.tenant, [grant(['purchasing.view', 'money.cost'], [A.companyB])]),
  brandOnly: () => office(A.tenant, [grant(KEEP, 'all', [A.brand])]),
  otherTenant: () => office(seedUuid(ns.b, 'tenant'), [grant(KEEP)]),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...KEEP], [A.companyA])] }),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.supplier, grants: [grant(['purchasing.view'], 'all', [A.supplier])] }),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `sources-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey = method === 'GET' ? undefined : key()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const url = (id: string, action = '') => `/purchasing/supplier-items/${id}${action}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)

beforeAll(async () => {
  db = await migratedDatabase('supplier_items')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  await seedProduction({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  for (const [id, companyId, code, name, lead] of [
    [S2, A.companyA, 'SRC-S2', 'Second Tannery Srl', 10],
    [S3, null, 'SRC-S3', 'Every Company Trims SpA', 7],
  ] as const) {
    await admin(
      `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency, language, "leadTimeDays") VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{SUPPLIER}', 'ACTIVE', 'IT', 'EUR', 'it', $6)`,
      [id, A.tenant, companyId, code, name, lead],
    )
  }
  // The jacket's revision is released: the plan explodes both orders (the Draft PO test at the end).
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [idOf('product:style:JKT-01')])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [idOf('product:revision:JKT-01:1'), A.actor])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

let p2Black: Json
let s2Black: Json
let s3Protector: Json

describe('approved sources (SCM-005)', () => {
  it('a buyer adds a supplier article: its unit, price and terms, the supplier currency and codes by default, PRIMARY as the first of its scope', async () => {
    const created = await ok('buyer', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: A.supplier, itemId: A.leather, itemColourId: A.leatherBLK, purchaseUom: 'FT2', unitPrice: '4.10', minOrderQty: '100', orderMultiple: '50', leadTimeDays: 18 }, 201)
    p2Black = created.item
    expect(created.demoted).toBeNull()
    expect(p2Black).toMatchObject({
      companyId: A.companyA,
      company: { code: 'SCA' },
      partyId: A.supplier,
      supplier: { code: 'SEED-S1', status: 'ACTIVE' },
      item: { code: 'SEED-LEA-100', baseUom: 'FT2', purchaseUom: 'HIDE' },
      colour: { code: 'BLK' },
      // The material's own article code (P2 is its default supplier) and the colour's code.
      supplierArticleCode: 'SEED-ART-100',
      supplierColourCode: 'S-001',
      purchaseUom: 'FT2',
      purchaseFactor: '1',
      unitUsable: true,
      unitPrice: '4.1',
      currency: 'EUR',
      minOrderQty: '100',
      orderMultiple: '50',
      leadTimeDays: 18,
      supplierLeadTimeDays: 21,
      preference: 'PRIMARY',
      status: 'ACTIVE',
      version: 1,
      // PO1 sent the black leather at 4.20 a ft².
      lastPurchase: { number: 'SEED-PO-0001', quantity: '420', uom: 'FT2', unitPrice: '4.2', currency: 'EUR' },
    })
    expect(await eventsOf(p2Black.id)).toEqual(['supplier_item.created'])
    const [audit] = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [p2Black.id])
    expect(audit).toMatchObject({ action: 'purchasing.sources.create', after: { purchaseUom: 'FT2', preference: 'PRIMARY', leadTimeDays: 18 } })
    expect((await ok('buyer', 'GET', url(p2Black.id))).item).toEqual(p2Black)
  })

  it('keeps one active source per supplier and scope, and one PRIMARY per scope: a new PRIMARY makes the old one a BACKUP', async () => {
    expect((await refused('buyer', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: A.supplier, itemId: A.leather, itemColourId: A.leatherBLK }, 409)).message).toBe(
      'Seed Leather Supplier S.p.A. already has an approved source of SEED-LEA-100 for this company and colour: change that one.',
    )
    s2Black = (await ok('buyer', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.leather, itemColourId: A.leatherBLK, purchaseUom: 'HIDE', unitPrice: '210' }, 201)).item
    expect(s2Black).toMatchObject({ preference: 'BACKUP', purchaseUom: 'HIDE', purchaseFactor: '52.5', supplierArticleCode: null, supplierColourCode: 'S-001', currency: 'EUR', lastPurchase: null })

    const promoted = await ok('buyer', 'PATCH', url(s2Black.id), { version: s2Black.version, preference: 'PRIMARY' })
    expect(promoted).toMatchObject({ item: { preference: 'PRIMARY', version: 2 }, demoted: { id: p2Black.id, partyId: A.supplier, supplierName: 'Seed Leather Supplier S.p.A.' } })
    s2Black = promoted.item
    expect((await ok('buyer', 'GET', url(p2Black.id))).item).toMatchObject({ preference: 'BACKUP', version: 2 })
    expect(await eventsOf(p2Black.id)).toEqual(['supplier_item.created', 'supplier_item.updated'])
    expect((await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [p2Black.id])).map((row) => row.action)).toEqual(['purchasing.sources.create', 'purchasing.sources.demote'])

    // An edit names the version it read; nothing to change is refused.
    expect((await refused('buyer', 'PATCH', url(p2Black.id), { version: 1, unitPrice: '4.00' }, 409)).message).toMatch(/changed since it was read/)
    expect((await refused('buyer', 'PATCH', url(p2Black.id), { version: 2 }, 400)).message).toBe('Nothing to change.')
    p2Black = (await ok('buyer', 'PATCH', url(p2Black.id), { version: 2, unitPrice: '4.00', supplierArticleCode: 'TAN-77' })).item
    expect(p2Black).toMatchObject({ unitPrice: '4', supplierArticleCode: 'TAN-77', preference: 'BACKUP', version: 3 })
  })

  it('refuses in words: a unit the material does not convert, a party that is not a supplier, a one-company supplier for every company, a colour of another material', async () => {
    const body = { companyId: A.companyA, partyId: S3, itemId: A.leather, itemColourId: A.leatherBLK }
    const unit = await refused('buyer', 'POST', '/purchasing/supplier-items', { ...body, purchaseUom: 'KG' }, 400)
    expect(unit.issues).toEqual([{ path: 'body/purchaseUom', message: "The material converts M2, DM2, FT2, HIDE: the supplier's unit must be one of them." }])
    expect((await refused('buyer', 'POST', '/purchasing/supplier-items', { ...body, partyId: A.brand }, 400)).message).toBe('Seed Racing is not a supplier.')
    expect((await refused('buyer', 'POST', '/purchasing/supplier-items', { ...body, companyId: null, partyId: S2 }, 400)).message).toBe('Second Tannery Srl supplies one company only: its source holds for that company.')
    expect((await refused('buyer', 'POST', '/purchasing/supplier-items', { ...body, itemColourId: A.liningGRY }, 400)).message).toBe('Not a colour of this material.')
    expect((await refused('buyer', 'POST', '/purchasing/supplier-items', { ...body, minOrderQty: '0' }, 400)).issues[0].path).toBe('body/minOrderQty')
  })

  it('a source for every company is kept only by a role over every company', async () => {
    s3Protector = (await ok('buyer', 'POST', '/purchasing/supplier-items', { companyId: null, partyId: S3, itemId: A.protector, unitPrice: '6.20', orderMultiple: '24' }, 201)).item
    expect(s3Protector).toMatchObject({ companyId: null, company: null, preference: 'PRIMARY', purchaseUom: 'PCS', supplierArticleCode: null })
    expect((await refused('keeperA', 'PATCH', url(s3Protector.id), { version: 1, unitPrice: '6.00' }, 403)).message).toBe('A source for every company is kept only by a role over every company.')
    expect((await refused('keeperA', 'POST', '/purchasing/supplier-items', { companyId: null, partyId: S3, itemId: A.lining }, 403)).message).toBe('A source for every company is kept only by a role over every company.')
    // Its own company's source it keeps.
    const own = (await ok('keeperA', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.protector, unitPrice: '6.40' }, 201)).item
    expect(own).toMatchObject({ companyId: A.companyA, preference: 'PRIMARY' }) // a company's scope is its own: S3's is every company's
  })

  it('archives a source and approves it again: refused while the supplier has another active one, back as a BACKUP when the scope has a PRIMARY', async () => {
    const archived = (await ok('buyer', 'POST', url(s2Black.id, '/archive'), { version: s2Black.version, reason: 'Hides too thin last season' })).item
    expect(archived).toMatchObject({ status: 'ARCHIVED', preference: 'PRIMARY', version: 3 })
    expect((await refused('buyer', 'POST', url(s2Black.id, '/archive'), { version: 3 }, 409)).message).toBe('The source is archived already.')
    expect((await refused('buyer', 'PATCH', url(s2Black.id), { version: 3, unitPrice: '1' }, 409)).message).toBe('The source is archived: approve it again first.')
    const active = (await ok('buyer', 'GET', `/purchasing/supplier-items?itemId=${A.leather}`)).items.map((row: Json) => row.id)
    expect(active).toEqual([p2Black.id])
    expect((await ok('buyer', 'GET', `/purchasing/supplier-items?itemId=${A.leather}&status=ALL`)).items.map((row: Json) => row.id).sort()).toEqual([p2Black.id, s2Black.id].sort())
    expect(await eventsOf(s2Black.id)).toEqual(['supplier_item.created', 'supplier_item.updated', 'supplier_item.archived'])

    p2Black = (await ok('buyer', 'PATCH', url(p2Black.id), { version: p2Black.version, preference: 'PRIMARY' })).item
    const restored = await ok('buyer', 'POST', url(s2Black.id, '/restore'), { version: 3 })
    expect(restored.item).toMatchObject({ status: 'ACTIVE', preference: 'BACKUP', version: 4 })
    s2Black = restored.item
    // A second active source of S2 for black is a duplicate: archive, add another, then the old one cannot come back.
    await ok('buyer', 'POST', url(s2Black.id, '/archive'), { version: 4 })
    const again = (await ok('buyer', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.leather, itemColourId: A.leatherBLK, unitPrice: '200' }, 201)).item
    expect((await refused('buyer', 'POST', url(s2Black.id, '/restore'), { version: 5 }, 409)).message).toBe('The supplier has another approved source of SEED-LEA-100 for this company and colour: archive that one first.')
    await ok('buyer', 'POST', url(again.id, '/archive'), { version: 1 })
  })

  it('the planner reads them without prices; another company, tenant or a role kept to other suppliers does not see them; the floor and partners have no route', async () => {
    const planned = (await ok('planner', 'GET', `/purchasing/supplier-items?itemId=${A.leather}`)).items as Json[]
    expect(planned.map((row) => row.id)).toEqual([p2Black.id])
    expect(planned[0]!).not.toHaveProperty('unitPrice')
    expect(planned[0]!.lastPurchase).toMatchObject({ number: 'SEED-PO-0001' })
    expect(planned[0]!.lastPurchase).not.toHaveProperty('unitPrice')
    expect((await refused('planner', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.lining }, 403)).code).toBe('forbidden')
    expect((await refused('planner', 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.lining, unitPrice: '1' }, 403)).code).toBe('forbidden')
    // Company B sees the sources of every company only.
    expect((await ok('companyB', 'GET', '/purchasing/supplier-items')).items.map((row: Json) => row.id)).toEqual([s3Protector.id])
    expect((await refused('companyB', 'GET', url(p2Black.id), undefined, 404)).message).toBe('Approved source not found.')
    expect((await ok('brandOnly', 'GET', '/purchasing/supplier-items')).items).toEqual([])
    expect((await call('otherTenant', 'GET', url(p2Black.id))).statusCode).toBe(404)
    for (const session of ['floor', 'partner']) {
      expect((await call(session, 'GET', '/purchasing/supplier-items')).statusCode, session).toBe(403)
      expect((await call(session, 'POST', '/purchasing/supplier-items', { companyId: A.companyA, partyId: S2, itemId: A.lining })).statusCode, session).toBe(403)
    }
  })
})

describe("the plan's Draft PO with an approved source", () => {
  let plan: Json
  const lineOf = (itemId: string, colourId: string | null = null) => (plan.lines as Json[]).find((line) => line.item.id === itemId && (line.colour?.id ?? null) === colourId)!

  it("buys in the source's unit after its minimum and steps, at its price and with its codes", async () => {
    await ok('buyer', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201)
    plan = await ok('buyer', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`)
    const black = lineOf(A.leather, A.leatherBLK)
    // B-W2a-22: the run itself follows P2's approved source, so the plan line and the PO line agree: 186.48 ft² short →
    // ft², at least 100 in steps of 50 → 200 ft².
    expect(black).toMatchObject({ netQuantity: '186.4800', suggestedQuantity: '200.0000', suggestedUom: 'FT2', supplier: { id: A.supplier } })
    const drafted = await ok('buyer', 'POST', '/purchasing/from-plan', { lines: [{ id: black.id, version: black.version }] })
    const order = (await ok('buyer', 'GET', `/purchasing/orders/${drafted.orders[0].id}`)).order
    // P2's source: ft², at least 100 in steps of 50 → 200 ft² at 4.00 = 800.00; its article code, the colour's code.
    expect(order.lines).toEqual([
      expect.objectContaining({ itemId: A.leather, quantity: '200.0000', uom: 'FT2', baseQuantity: '200.0000', unitPrice: '4.000000', netAmount: 80_000, estimatedHides: 4, supplierArticleCode: 'TAN-77', supplierColourCode: 'S-001' }),
    ])
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'purchasing.draftFromPlan' AND "recordType" = 'PurchaseOrderLine'`)
    expect(audit!.after).toMatchObject({ requirementId: black.id, quantityFrom: 'SOURCE', sourceId: p2Black.id })
  })

  it('refuses a supplier that is not one of the material’s approved sources once it has some (the plan line’s default supplier included)', async () => {
    const protector = lineOf(A.protector)
    // B-W2a-22: the run already takes the best approved source (S2, company A's own PRIMARY), not the material's default
    // supplier (P2).
    expect(protector.supplier.id).toBe(S2)
    const refusal = await refused('buyer', 'POST', '/purchasing/from-plan', { lines: [{ id: protector.id, version: protector.version, supplierId: A.supplier }] }, 400)
    expect(refusal.issues).toEqual([{ path: 'body/lines/0/supplierId', message: 'Seed Leather Supplier S.p.A. is not an approved source of SEED-PRO-300: pick one of its sources, or add this supplier to them first.' }])
    // Another approved one: S3 (every company), in steps of 24 at 6.20.
    const drafted = await ok('buyer', 'POST', '/purchasing/from-plan', { lines: [{ id: protector.id, version: protector.version, supplierId: S3 }] })
    const order = (await ok('buyer', 'GET', `/purchasing/orders/${drafted.orders[0].id}`)).order
    expect(order).toMatchObject({ partyId: S3, lines: [expect.objectContaining({ quantity: '24.0000', uom: 'PCS', unitPrice: '6.200000' })] })
  })
})
