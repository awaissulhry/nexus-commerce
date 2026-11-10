import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * BOM lines in depth on the local stack (B-W2b-228; PRD-083, PRD-084, PRD-099, PRD-108), with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security and B-W2b-211's
 * …_bom_options_w2b_guards are real), B-W2b-211's options seed (SEED-JKT-05 revision 1 DRAFT: the lining with the airflow
 * lining when short, the protector with a second protector on approval and a certificate check, the thread for the workshop,
 * the brand's label sent by the brand, the liner sub-assembly), the subcontract seed (WO-0001 sewn by the workshop P2,
 * SEED-SC-0001 DRAFT), and sessions from the test authenticator. Every code and name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/bom-lines`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let S: OptionsSeed
let SC: SubcontractSeed

const NS = 'bom-lines-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const P1 = seedId('party:P1')
const meshLining = newId()
const ppeProtector = newId()
const blockedLining = newId()
const supplier = newId()

const BOM: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release']
const PEOPLE: Record<string, { permissions: readonly Permission[]; companies: ScopeSet }> = {
  maker: { permissions: [...BOM, 'product.styles.view', 'product.materials.view', 'audit.read', 'costing.view'], companies: 'all' },
  viewer: { permissions: ['product.bom.view'], companies: 'all' },
  buyer: { permissions: ['purchasing.view', 'purchasing.subcontract.manage', 'money.cost'], companies: 'all' },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant] }]
  }),
)
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1'), deviceId: newId(), grants: [{ permissions: [...BOM, 'floor.work'], companies: 'all', sites: [seedId('site:A1')], parties: 'all' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `bom-lines-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const bom = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}/bom`
const jacket = () => bom(S.jacketStyleId, S.jacketRevisionId)
const depthOf = async (session = 'maker'): Promise<Json> => (await ok(session, 'GET', `${jacket()}/depth`)).depth
const lineOf = (depth: Json, seq: number): Json => depth.lines.find((line: Json) => line.seq === seq)
const eventsOf = async (subject: string, type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])
const item = (code: string): Promise<string> => admin<{ id: string }>('SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = $2', [tenant, code]).then((rows) => rows[0]!.id)

beforeAll(async () => {
  db = await migratedDatabase('bom_lines')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  S = await seedOptions({ db: database, namespace: NS })
  SC = await seedSubcontract({ db: database, namespace: NS })
  // Made-up materials: a second mesh lining, a second-source PPE protector, a lining refused for use.
  // A decided approval names when and by whom (B-W2b-206's rule).
  const insert = `INSERT INTO "Item" (id, "tenantId", code, name, kind, sourcing, tracking, "baseUom", "purchaseUom", "consumptionUom", "isPpeComponent", approval, "approvalNote", "approvedAt", "approvedById", "createdAt", "updatedAt")
                  VALUES ($1, $2, $3, $4, $5, 'BUY', 'NONE', $6, $6, $6, $7, $8::"MaterialApproval", $9,
                          CASE WHEN $8 = 'PENDING' THEN NULL ELSE now() END, CASE WHEN $8 = 'PENDING' THEN NULL ELSE $2::uuid END, now(), now())`
  await admin(insert, [meshLining, tenant, 'BL-LIN-901', 'Made-up mesh lining', 'LINING', 'M', false, 'APPROVED', null])
  await admin(insert, [ppeProtector, tenant, 'BL-PRO-902', 'Made-up level 2 protector', 'PROTECTOR', 'PCS', true, 'PENDING', null])
  await admin(insert, [blockedLining, tenant, 'BL-LIN-903', 'Made-up refused lining', 'LINING', 'M', false, 'BLOCKED', 'Colour fastness below the limit (made-up).'])
  // A made-up supplier of every company (the jacket is a style of every company).
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency, language) VALUES ($1, $2, NULL, 'BL-SUP-1', 'ORGANISATION', 'Made-up Trims Srl', '{SUPPLIER}', 'ACTIVE', 'IT', 'EUR', 'it')`, [supplier, tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 240_000)

describe('a draft BOM in depth', () => {
  it('reads each line’s alternates, who sends it, the workshop’s kit and the output', async () => {
    const depth = await depthOf('viewer')
    expect(depth).toMatchObject({ revision: { status: 'DRAFT' }, style: { code: 'SEED-JKT-05' }, editable: true, output: { quantity: 1, uom: 'PCS' } })
    expect(lineOf(depth, 20).alternates).toEqual([
      expect.objectContaining({ id: S.alternateIds.lining, priority: 1, item: expect.objectContaining({ code: 'SEED-LIN-210' }), allowedWhen: 'WHEN_SHORT', certificateCheck: false, certificateRequired: false, certificate: null, needs: ['ONLY_WHEN_SHORT'] }),
    ])
    expect(lineOf(depth, 30).alternates).toEqual([
      expect.objectContaining({ priority: 1, item: expect.objectContaining({ code: 'SEED-PRO-310', isPpeComponent: true }), allowedWhen: 'WITH_APPROVAL', certificateCheck: true, certificateRequired: true, needs: ['NEEDS_APPROVAL', 'NEEDS_CERTIFICATE_CHECK'] }),
    ])
    expect(lineOf(depth, 50)).toMatchObject({ customerSupplied: { id: P1, code: 'SEED-C1' }, issueToSubcontract: false })
    expect(lineOf(depth, 15)).toMatchObject({ issueToSubcontract: true, kit: 'KIT' })
    expect(lineOf(depth, 40)).toMatchObject({ subAssembly: true })
    expect(depth.kit).toEqual({ from: 'BOM', lineIds: [S.bomLineIds.thread], cutLineIds: [] })
    expect(depth.customers).toEqual([{ party: expect.objectContaining({ id: P1 }), lineIds: [S.bomLineIds.label] }])
    expect(depth.counts).toEqual({ lines: 6, alternates: 2, customerSupplied: 1, forWorkshop: 1 })
    expect((await call('floor', 'GET', `${jacket()}/depth`)).statusCode).toBe(403)
  })
})

describe('alternates (PRD-083)', () => {
  it('adds, orders, changes and removes alternates, each write at the revision’s version, with audit and event', async () => {
    let depth = await depthOf()
    const lining = S.bomLineIds.lining
    depth = (await ok('maker', 'POST', `${jacket()}/lines/${lining}/alternates`, { version: depth.revision.version, itemId: meshLining, note: 'Made-up second mesh.' }, 201)).depth
    const added = lineOf(depth, 20).alternates[1]
    expect(added).toMatchObject({ priority: 2, item: { code: 'BL-LIN-901' }, allowedWhen: 'WITH_APPROVAL', certificateCheck: false, qty: null, note: 'Made-up second mesh.' })

    depth = (await ok('maker', 'PUT', `${jacket()}/lines/${lining}/alternate-order`, { version: depth.revision.version, alternateIds: [added.id, S.alternateIds.lining] })).depth
    expect(lineOf(depth, 20).alternates.map((alternate: Json) => [alternate.priority, alternate.item.code])).toEqual([
      [1, 'BL-LIN-901'],
      [2, 'SEED-LIN-210'],
    ])
    depth = (await ok('maker', 'PATCH', `${jacket()}/lines/${lining}/alternates/${added.id}`, { version: depth.revision.version, allowedWhen: 'ALWAYS', qty: '1.9' })).depth
    expect(lineOf(depth, 20).alternates[0]).toMatchObject({ allowedWhen: 'ALWAYS', qty: '1.9', needs: [] })

    depth = (await ok('maker', 'DELETE', `${jacket()}/lines/${lining}/alternates/${added.id}?version=${depth.revision.version}`)).depth
    expect(lineOf(depth, 20).alternates.map((alternate: Json) => [alternate.priority, alternate.item.code])).toEqual([[1, 'SEED-LIN-210']])

    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'BomLineAlternate' AND "recordId" = $1 ORDER BY at, id`, [added.id])
    expect(audit.map((row) => row.after)).toEqual([
      expect.objectContaining({ priority: 2, itemId: meshLining }),
      { priority: 1 },
      expect.objectContaining({ allowedWhen: 'ALWAYS', qty: '1.9' }),
      expect.objectContaining({ removed: true }),
    ])
    expect((await eventsOf(S.jacketStyleId, 'style.bom_changed')).map((event) => event.payload.lineIds)).toEqual([[lining], [lining], [lining], [lining]])
  })

  it('refuses in words: the line’s own material, units that do not convert, a blocked material, no check on a PPE component, a stale version', async () => {
    const depth = await depthOf()
    const version = depth.revision.version
    const url = `${jacket()}/lines/${S.bomLineIds.lining}/alternates`
    const own = await refused('maker', 'POST', url, { version, itemId: await item('SEED-LIN-200') }, 400)
    expect(own.issues).toEqual([{ path: 'body/itemId', message: "SEED-LIN-200 is line 20's own material: an alternate is another one." }])
    const units = await refused('maker', 'POST', url, { version, itemId: ppeProtector }, 400)
    expect(units.issues[0].message).toContain("BL-PRO-902 does not convert m (line 20's unit) to its base unit pz")
    const blocked = await refused('maker', 'POST', url, { version, itemId: blockedLining }, 400)
    expect(blocked.issues[0].message).toBe('BL-LIN-903 is blocked (refused for use): it is no alternate. Why: Colour fastness below the limit (made-up).')
    const check = await refused('maker', 'PATCH', `${jacket()}/lines/${S.bomLineIds.protector}/alternates/${S.alternateIds.protector}`, { version, certificateCheck: false }, 400)
    expect(check.issues).toEqual([{ path: 'body/certificateCheck', message: "line 30's SEED-PRO-300 is a PPE component, so the alternate needs a certificate check before it is used (the notified body may have to agree)." }])
    const stale = await refused('maker', 'POST', url, { version: version - 1, itemId: meshLining }, 409)
    expect(stale.code).toBe('conflict')
    expect((await call('viewer', 'POST', url, { version, itemId: meshLining })).statusCode).toBe(403)
    expect((await depthOf()).revision.version).toBe(version)
  })

  it('switches the certificate check on by itself for a PPE component, never off', async () => {
    let depth = await depthOf()
    depth = (await ok('maker', 'POST', `${jacket()}/lines/${S.bomLineIds.protector}/alternates`, { version: depth.revision.version, itemId: ppeProtector }, 201)).depth
    expect(lineOf(depth, 30).alternates[1]).toMatchObject({ priority: 2, item: { code: 'BL-PRO-902' }, certificateCheck: true, certificateRequired: true, certificate: null })
  })
})

describe('customer-supplied material and the workshop mark (PRD-084, PRD-108)', () => {
  it('sets who sends a line and marks the selection for the workshop; refuses a supplier, a bought line and a sub-assembly in words', async () => {
    let depth = await depthOf()
    depth = (await ok('maker', 'PUT', `${jacket()}/lines/${S.bomLineIds.lining}/supply`, { version: depth.revision.version, customerSuppliedByPartyId: P1 })).depth
    expect(lineOf(depth, 20).customerSupplied).toMatchObject({ id: P1 })
    expect(depth.customers).toEqual([{ party: expect.objectContaining({ id: P1 }), lineIds: [S.bomLineIds.lining, S.bomLineIds.label] }])

    const notCustomer = await refused('maker', 'PUT', `${jacket()}/lines/${S.bomLineIds.shell}/supply`, { version: depth.revision.version, customerSuppliedByPartyId: supplier }, 400)
    expect(notCustomer.issues).toEqual([{ path: 'body/customerSuppliedByPartyId', message: 'BL-SUP-1 is neither a customer nor a brand: the material is sent by a party with the CUSTOMER or BRAND role.' }])
    const subAssembly = await refused('maker', 'PUT', `${jacket()}/lines/${S.bomLineIds.liner}/supply`, { version: depth.revision.version, customerSuppliedByPartyId: P1 }, 400)
    expect(subAssembly.issues[0].message).toBe('Line 40 is a sub-assembly we make: the customer does not send it. Clear the sub-assembly first.')
    // A line bought from a supplier (W1's line route) is not sent by the customer until its supplier is cleared.
    depth = (await ok('maker', 'PATCH', `${jacket()}/lines/${S.bomLineIds.shell}`, { version: depth.revision.version, supplierId: supplier })).bom
    const bought = await refused('maker', 'PUT', `${jacket()}/lines/${S.bomLineIds.shell}/supply`, { version: depth.revision.version, customerSuppliedByPartyId: P1 }, 400)
    expect(bought.issues[0].message).toBe('Line 10 is bought from BL-SUP-1: clear its supplier first (a material the customer sends is not bought).')

    depth = await depthOf()
    depth = (await ok('maker', 'POST', `${jacket()}/supply/change`, { version: depth.revision.version, lineIds: [S.bomLineIds.lining, S.bomLineIds.protector], issueToSubcontract: true })).depth
    expect(depth.kit).toEqual({ from: 'BOM', lineIds: [S.bomLineIds.thread, S.bomLineIds.lining, S.bomLineIds.protector], cutLineIds: [] })
    expect(depth.counts.forWorkshop).toBe(3)
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'BomLine' AND "recordId" = $1 ORDER BY at, id`, [S.bomLineIds.lining])
    expect(audit.map((row) => row.after)).toEqual([
      { customerSuppliedByPartyId: P1, issueToSubcontract: false },
      { customerSuppliedByPartyId: P1, issueToSubcontract: true },
    ])
  })

  it('leaves a customer’s material out of the cost sheet (no cost), and costs it again once we buy it', async () => {
    const costed = async () =>
      new Set(((await ok('maker', 'GET', `/costing/styles/${S.jacketStyleId}/revisions/${S.jacketRevisionId}/cost-sheet`)).sheet.cells as Json[]).flatMap((cell) => cell.material.lines.map((line: Json) => line.lineId)))
    let lines = await costed()
    expect(lines.has(S.bomLineIds.label)).toBe(false)
    expect(lines.has(S.bomLineIds.lining)).toBe(false)
    expect(lines.has(S.bomLineIds.protector)).toBe(true)
    const depth = await depthOf()
    await ok('maker', 'PUT', `${jacket()}/lines/${S.bomLineIds.lining}/supply`, { version: depth.revision.version, customerSuppliedByPartyId: null })
    lines = await costed()
    expect(lines.has(S.bomLineIds.lining)).toBe(true)
    expect(lines.has(S.bomLineIds.label)).toBe(false)
  })
})

describe('the output (PRD-099)', () => {
  it('makes a pair; refuses more than one unit and a frozen revision in words', async () => {
    let depth = await depthOf()
    depth = (await ok('maker', 'PUT', `${jacket()}/output`, { version: depth.revision.version, outputQuantity: 1, outputUom: 'PAIR' })).depth
    expect(depth.output).toEqual({ quantity: 1, uom: 'PAIR' })
    const structure = (await ok('maker', 'GET', `${jacket()}/structure`)).structure
    expect(structure).toMatchObject({ outputQuantity: 1, outputUom: 'PAIR' })
    const many = await refused('maker', 'PUT', `${jacket()}/output`, { version: depth.revision.version, outputQuantity: 10, outputUom: 'SET' }, 400)
    expect(many.issues).toEqual([{ path: 'body/outputQuantity', message: 'A BOM for more than one unit (here 10 set) is not counted by work orders, costing and planning yet: write its lines for 1 set.' }])
    expect((await call('maker', 'PUT', `${jacket()}/output`, { version: depth.revision.version, outputQuantity: 1, outputUom: 'M' })).statusCode).toBe(400)
    const liner = (await ok('maker', 'GET', `${bom(S.linerStyleId, S.linerRevisionId)}/depth`)).depth
    const frozen = await refused('maker', 'PUT', `${bom(S.linerStyleId, S.linerRevisionId)}/output`, { version: liner.revision.version, outputQuantity: 1, outputUom: 'SET' }, 409)
    expect(frozen.message).toContain('released')
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'StyleRevision' AND "recordId" = $1 AND after ? 'outputUom'`, [S.jacketRevisionId])
    expect(audit).toEqual([{ before: { outputQuantity: 1, outputUom: 'PCS' }, after: expect.objectContaining({ outputQuantity: 1, outputUom: 'PAIR' }) }])
  })
})

describe('the subcontract kit from the BOM (PRD-108)', () => {
  const order = (id: string) => `/purchasing/subcontracting/orders/${id}`
  const lineIdOf = async (seq: number) => (await admin<{ id: string }>('SELECT id FROM "BomLine" WHERE "revisionId" = $1 AND seq = $2', [SC.production.revisionId, seq]))[0]!.id
  /** The released revision is frozen: its guard is off while the made-up marks are written. */
  const mark = async (seq: number, issueToSubcontract: boolean, routingSeq: number) => {
    await admin(`ALTER TABLE "BomLine" DISABLE TRIGGER "BomLine_revision_guard"`)
    try {
      await admin(`UPDATE "BomLine" SET "issueToSubcontract" = $3, "routingSeq" = $4 WHERE "revisionId" = $1 AND seq = $2`, [SC.production.revisionId, seq, issueToSubcontract, routingSeq])
    } finally {
      await admin(`ALTER TABLE "BomLine" ENABLE TRIGGER "BomLine_revision_guard"`)
    }
  }
  const emptied = async () => {
    let detail = (await ok('buyer', 'GET', order(SC.orderId))).order
    for (const line of detail.kitLines.filter((row: Json) => row.status === 'PLANNED')) detail = (await ok('buyer', 'DELETE', order(`${SC.orderId}/kit/${line.id}?version=${detail.version}`))).order
    return detail
  }

  it('takes only the lines marked for the workshop, a step-bound line only with its step', async () => {
    // The sewing order (step 20): the lining is for the workshop at sewing, the protector at the final check (step 30).
    await mark(20, true, 20)
    await mark(30, true, 30)
    let detail = await emptied()
    detail = (await ok('buyer', 'POST', order(`${SC.orderId}/kit/from-work-order`), { version: detail.version })).order
    expect(detail.kitLines.filter((line: Json) => line.status === 'PLANNED').map((line: Json) => [line.item.id, line.note])).toEqual([[await item('SEED-LIN-200'), 'From the BOM’s lines for the workshop.']])
  })

  it('keeps W2a’s kit (every planned material but the hide-tracked leather) when the BOM marks no line', async () => {
    await mark(20, false, 20)
    await mark(30, false, 20)
    let detail = await emptied()
    detail = (await ok('buyer', 'POST', order(`${SC.orderId}/kit/from-work-order`), { version: detail.version })).order
    const planned = detail.kitLines.filter((line: Json) => line.status === 'PLANNED')
    expect(planned.map((line: Json) => line.item.id).sort()).toEqual([await item('SEED-LIN-200'), await item('SEED-PRO-300')].sort())
    expect(planned.every((line: Json) => line.note === 'From the work order’s planned materials.' && line.item.tracking !== 'HIDE')).toBe(true)
    expect(await lineIdOf(20)).toBeTruthy()
  })
})
