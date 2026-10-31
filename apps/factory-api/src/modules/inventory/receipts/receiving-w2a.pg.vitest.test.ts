import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Receiving every day (B-W2a-31; SCM-115, SCM-118, SCM-123, SCM-248) on the local stack, with the app's real routes, the
 * files and e-mail platforms on their FAKE providers (the auth harness: a local file store behind the files seed's FAKE
 * R2 account, FAKE SES) and the imports platform's real dry run and apply: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, the column grants and the …_supply_w2a_guards triggers are real),
 * the factory-db seeds of two tenants up to production (the black cowhide by the hide in ft², grey lining by the lot in
 * metres bought in rolls of 50 m, protectors by the lot; site A1 with its goods-in dock A1-RCV; the supplier P2 with its
 * order desk contact), the numbering seed, the reason lists (DISCREPANCY: SHORT, OVER, WRONG_ITEM, DAMAGED), the e-mail
 * identities. Purchase orders to P2 are made up here, CONFIRMED. People are Users with one custom role each (the import's
 * dry run judges rows for the starter's live roles) and the same grants in their test session. Every name, number and
 * price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/receipts`.
 */

let h: Harness
let app: FastifyInstance

const ns = { a: 'receiving-a', b: 'receiving-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  siteA1: idOf(ns.a, 'site:A1'),
  supplier: idOf(ns.a, 'party:P2'),
  orderDesk: idOf(ns.a, 'party-contact:P2:orders'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  dock: idOf(ns.a, 'inventory:location:A1-RCV'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const otherSite = newId()

const FILES: Permission[] = ['files.read', 'files.upload']
const RECEIVE: Permission[] = ['inventory.receive', 'inventory.stock.view', 'inventory.reverse']
const DISCREPANCIES: Permission[] = ['inventory.discrepancies.manage', 'inventory.discrepancies.report']
const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly grains: readonly 'cost'[]
}
const PEOPLE: Record<string, Person> = {
  /** The warehouse template's part of it: receives, records discrepancies and reports them, imports hide lists; no money. */
  warehouse: { tenantId: A.tenant, permissions: [...RECEIVE, ...DISCREPANCIES, ...FILES, ...IMPORTS, 'threads.read'], grains: [] },
  /** Receives with the cost grain (the order's prices value the moves). */
  manager: { tenantId: A.tenant, permissions: [...RECEIVE, ...FILES], grains: ['cost'] },
  /** Sees receipts only. */
  viewer: { tenantId: A.tenant, permissions: ['inventory.stock.view'], grains: [] },
  /** Records discrepancies but has no files.upload. */
  noFiles: { tenantId: A.tenant, permissions: [...RECEIVE, 'inventory.discrepancies.manage', 'files.read'], grains: [] },
  otherTenant: { tenantId: B.tenant, permissions: [...RECEIVE, ...DISCREPANCIES, ...FILES, ...IMPORTS], grains: ['cost'] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const grantOf = (person: Person): Grant => ({ permissions: [...person.permissions, ...person.grains.map((grain) => `money.${grain}` as Permission)], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  ...Object.fromEntries(Object.entries(PEOPLE).map(([key, person]) => [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grantOf(person)] } satisfies SessionContext])),
  reasons: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [{ permissions: ['reasons.view'], companies: 'all', sites: 'all', parties: 'all' }] },
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [{ permissions: ['floor.work', 'inventory.receive', 'inventory.locations.view'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
  floorElsewhere: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: otherSite, deviceId: A.deviceA1, grants: [{ permissions: ['floor.work', 'inventory.receive'], companies: [A.companyA], sites: [otherSite], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `rw2a-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const system = (): CommandCaller => callerFor(h.database, systemContext(A.tenant, newId()))
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

// ---- made-up purchase orders ---------------------------------------------------------------------------------------------------

interface LineSpec {
  readonly itemId: string
  readonly colourId: string | null
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly tolerancePct?: string
}
let orders = 0
/** A CONFIRMED purchase order of company A for site A1 to the supplier P2. */
async function makeOrder(lines: readonly LineSpec[]): Promise<{ id: string; number: string; lines: string[] }> {
  const id = newId()
  const number = `T-PO-${run}-${++orders}`
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [id, A.tenant, A.companyA, A.siteA1, number, A.supplier, A.actor])
  const lineIds: string[] = []
  let total = 0
  for (const [index, line] of lines.entries()) {
    const lineId = newId()
    lineIds.push(lineId)
    const amount = Math.round(Number(line.quantity) * Number(line.unitPrice) * 100)
    total += amount
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "areaTolerancePct", "supplierArticleCode", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, $11, $12, current_date + 20, $13, $14, $15)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom, line.unitPrice, amount, line.tolerancePct ?? null, line.itemId === A.leather ? 'VAC-NERO' : null, line.itemId === A.leather],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = $3, version = 2 WHERE id = $1`, [id, A.actor, total])
  await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [id])
  return { id, number, lines: lineIds }
}
const leatherLine = (quantity: string): LineSpec => ({ itemId: A.leather, colourId: A.leatherBLK, quantity, uom: 'FT2', unitPrice: '5.000000', tolerancePct: '5' })
const hides = (prefix: string, areas: readonly string[]) => areas.map((area, index) => ({ supplierCode: `${prefix}-${String(index + 1).padStart(2, '0')}`, area, grade: 'A' }))

/** A picture's bytes (made up) announced, sent to the local store and confirmed: the file. */
async function photo(session: string, url: string, name: string): Promise<Json> {
  const body = Buffer.from(`made-up jpeg bytes ${name} ${newId()}`)
  const announced = await ok(session, 'POST', url, { originalName: name, contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) }, 201)
  expect(announced.file).toMatchObject({ kind: 'PHOTO', status: 'PENDING_UPLOAD' })
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  const done = await ok(session, 'POST', `${url}/${announced.file.id}/complete`)
  expect(done.file).toMatchObject({ id: announced.file.id, status: 'AVAILABLE' })
  return done.file
}

beforeAll(async () => {
  h = await startHarness('receiving_w2a')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  for (const namespace of [ns.a, ns.b]) {
    await seedProduction({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    await seedReasons({ db: h.database, namespace })
    await seedFiles({ db: h.database, namespace })
    await seedEmail({ db: h.database, namespace })
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // The letterhead the report prints (c.c. art. 2250): made-up registration numbers.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  // Another site of company A (a tablet there sees none of A1's receipts).
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'A9', 'Other plant', 'PLANT')`, [otherSite, A.tenant, A.companyA])
  // The approved source of P2 for the lining: sold in rolls (B-W2a-10).
  await admin(
    `INSERT INTO "SupplierItem" (id, "tenantId", "companyId", "partyId", "itemId", "purchaseUom", "purchaseFactor", currency, preference, status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'ROLL', 50, 'EUR', 'PRIMARY', 'ACTIVE', now(), now())`,
    [newId(), A.tenant, A.companyA, A.supplier, A.lining],
  )
  // A reason of the tenant's own in the DISCREPANCY list, and an inactive one.
  await admin(`INSERT INTO "ReasonCode" (id, "tenantId", list, code, "labelIt", "labelEn", "sortOrder", active) VALUES ($1, $2, 'DISCREPANCY', 'STAINS', 'Macchie', 'Stains', 50, true), ($3, $2, 'DISCREPANCY', 'HOLES', 'Buchi', 'Holes', 60, false)`, [newId(), A.tenant, newId()])
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], person.tenantId, `${key}-${run}@example.com`, `Test ${key}`])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, person.tenantId, `custom.receiving_${key.toLowerCase()}`, key, person.permissions, person.grains])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), person.tenantId, IDS[key], roleId])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ---- SCM-123: the supplier's unit at receipt -----------------------------------------------------------------------------------

describe("received in the supplier's unit (SCM-123)", () => {
  it("lining in rolls: the source's unit and the material's factor, or a roll's own length; the lots' bases add up; the moves in metres", async () => {
    const order = await makeOrder([{ itemId: A.lining, colourId: A.liningGRY, quantity: '300', uom: 'M', unitPrice: '2.000000' }, { itemId: A.protector, colourId: null, quantity: '40', uom: 'PCS', unitPrice: '6.500000' }])
    const answer = await ok('manager', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      supplierDdtNumber: `DDT-U-${run}`,
      supplierDdtDate: '2026-10-28',
      lines: [
        // No unit named: P2's approved source sells it in ROLL; the material's factor is 50 m a roll.
        { purchaseOrderLineId: order.lines[0], receivedFactor: '48.5', lots: [{ supplierLotRef: 'R-1', quantity: '2' }, { supplierLotRef: 'R-2', quantity: '1' }] },
        // Protectors in boxes of 12 (BOX is a unit of its own size: the factor is given).
        { purchaseOrderLineId: order.lines[1], receivedUom: 'BOX', receivedFactor: '12', lots: [{ supplierLotRef: 'P-1', quantity: '3' }] },
      ],
    }, 201)
    const [lining, protectors] = answer.receipt.lines
    expect(lining).toMatchObject({ uom: 'M', quantity: '145.5000', baseQuantity: '145.5000', received: { quantity: '3.0000', uom: 'ROLL', factor: '48.50000000' } })
    expect(lining.lots.map((lot: Json) => lot.baseQuantity)).toEqual(['97.0000', '48.5000'])
    expect(protectors).toMatchObject({ uom: 'PCS', quantity: '36.0000', baseQuantity: '36.0000', received: { quantity: '3.0000', uom: 'BOX', factor: '12.00000000' } })
    expect(lining.difference).toMatchObject({ kind: 'SHORT', after: '145.5000' })
    // The receipt line as stored (the trigger checked base = round(quantity × factor, 4)), the moves in the base unit.
    const stored = await admin(`SELECT "receivedQuantity"::text AS q, "receivedUom"::text AS u, "receivedFactor"::text AS f, "baseQuantity"::text AS b FROM "GoodsReceiptLine" WHERE "receiptId" = $1 ORDER BY seq`, [answer.receipt.id])
    expect(stored).toEqual([
      { q: '3.0000', u: 'ROLL', f: '48.50000000', b: '145.5000' },
      { q: '3.0000', u: 'BOX', f: '12.00000000', b: '36.0000' },
    ])
    expect(answer.moves.map((move: Json) => [move.uom, move.quantity])).toEqual([
      ['M', '97.0000'],
      ['M', '48.5000'],
      ['PCS', '36.0000'],
    ])
    // Valued at the order's price per base unit (2.00 a metre, 6.50 a piece).
    expect(answer.receipt.value).toEqual({ currency: 'EUR', valueAmount: 29_100 + 23_400 })
  })

  it('refuses what cannot be converted, in words: a unit the material does not take, leather, a line quantity beside it', async () => {
    const order = await makeOrder([{ itemId: A.lining, colourId: A.liningGRY, quantity: '100', uom: 'M', unitPrice: '2.000000' }, leatherLine('100')])
    const error = await refused('manager', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: order.lines[0], receivedUom: 'KG', lots: [{ quantity: '2' }] },
        { purchaseOrderLineId: order.lines[1], receivedUom: 'M2', lots: [{ hides: hides('U', ['50']) }] },
      ],
    }, 400)
    expect(error.issues).toEqual([
      { path: 'body/lines/0/receivedFactor', message: expect.stringContaining('does not convert KG to its base unit M') },
      { path: 'body/lines/1/receivedUom', message: 'Leather is received hide by hide, each in the unit it was measured in: leave the received unit out.' },
    ])
    // The floor reads no source: it names the unit.
    const floor = await refused('floor', 'POST', `/inventory/receiving/orders/${order.id}/receipts`, { version: 3, lines: [{ purchaseOrderLineId: order.lines[0], receivedFactor: '50', lots: [{ quantity: '1' }] }], printerId: null }, 400)
    expect(floor.issues).toEqual([{ path: 'body/lines/0/receivedUom', message: 'Name the unit the supplier counts in.' }])
  })
})

// ---- SCM-115: the supplier's delivery note on the receipt -------------------------------------------------------------------------

describe("the supplier's delivery note: number, date and photo, office and floor (SCM-115)", () => {
  let receipt: Json

  beforeAll(async () => {
    const order = await makeOrder([leatherLine('200')])
    receipt = (await ok('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: `DDT-P-${run}`, supplierDdtDate: '2026-10-29', lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ dyeBatch: 'DB-P', hides: hides('P', ['50', '51']) }] }] }, 201)).receipt
  })

  it('the office photographs it: a PHOTO of the receipt, shown on the record; without files.upload refused', async () => {
    const file = await photo('warehouse', `/inventory/receipts/${receipt.id}/ddt-photos`, 'ddt-front.jpg')
    expect(file).toMatchObject({ recordType: 'GoodsReceipt', recordId: receipt.id, visibility: ['OFFICE'] })
    const record = (await ok('viewer', 'GET', `/inventory/receipts/${receipt.id}`)).receipt
    expect(record).toMatchObject({ supplierDdtNumber: `DDT-P-${run}`, supplierDdtDate: '2026-10-29', ddtPhotos: [{ id: file.id, originalName: 'ddt-front.jpg', status: 'AVAILABLE' }], discrepancies: { count: 0, open: 0, unsent: 0 } })
    expect((await refused('noFiles', 'POST', `/inventory/receipts/${receipt.id}/ddt-photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) }, 403)).message).toBe('Adding a photo needs files.upload over the company.')
    expect((await refused('viewer', 'POST', `/inventory/receipts/${receipt.id}/ddt-photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) }, 403)).code).toBe('forbidden')
  })

  it("the goods-in tablet photographs it too: the office's and the site's floor file; another site's tablet finds no receipt", async () => {
    const file = await photo('floor', `/inventory/receipts/${receipt.id}/ddt-photos`, 'ddt-tablet.jpg')
    expect(file).toMatchObject({ visibility: ['OFFICE', 'FLOOR'] })
    expect(await admin(`SELECT "floorSiteId", "createdById" FROM "StoredFile" WHERE id = $1`, [file.id])).toEqual([{ floorSiteId: A.siteA1, createdById: null }])
    await refused('floorElsewhere', 'POST', `/inventory/receipts/${receipt.id}/ddt-photos`, { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) }, 404)
    // Not a picture: the PHOTO kind refuses it.
    await refused('floor', 'POST', `/inventory/receipts/${receipt.id}/ddt-photos`, { originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 400)
    expect((await ok('viewer', 'GET', `/inventory/receipts/${receipt.id}`)).receipt.ddtPhotos).toHaveLength(2)
  })
})

// ---- SCM-118: discrepancies and the report to the supplier ---------------------------------------------------------------------

describe('what was wrong with a delivery, reported to the supplier, tracked to its end (SCM-118)', () => {
  let order: Awaited<ReturnType<typeof makeOrder>>
  let receipt: Json
  let short: Json
  let damaged: Json
  let stains: Json
  const url = () => `/inventory/receipts/${receipt.id}/discrepancies`

  beforeAll(async () => {
    order = await makeOrder([leatherLine('300'), { itemId: A.protector, colourId: null, quantity: '20', uom: 'PCS', unitPrice: '6.500000' }])
    receipt = (
      await ok('manager', 'POST', '/inventory/receipts', {
        purchaseOrderId: order.id,
        supplierDdtNumber: `DDT-D-${run}`,
        supplierDdtDate: '2026-10-29',
        lines: [
          { purchaseOrderLineId: order.lines[0], lots: [{ dyeBatch: 'DB-D', hides: hides('D', ['52.3', '48.9', '50']) }] },
          { purchaseOrderLineId: order.lines[1], lots: [{ supplierLotRef: 'P-D', quantity: '18' }] },
        ],
      }, 201)
    ).receipt
  })

  it('records them: the reason gives the kind (or the kind the reason), a line, a quantity and unit, a note; numbered 10, 20, 30', async () => {
    short = (await ok('warehouse', 'POST', url(), { reasonCode: 'SHORT', receiptLineId: receipt.lines[1].id, quantity: '2', uom: 'PCS', note: 'Two protectors missing from the box.' }, 201)).discrepancy
    expect(short).toMatchObject({ seq: 10, status: 'OPEN', kind: 'SHORT', reasonCode: 'SHORT', reason: { labelEn: 'Short', labelIt: 'Quantità mancante' }, quantity: '2.0000', uom: 'PCS', note: 'Two protectors missing from the box.', receiptLine: { seq: 20, item: { code: 'SEED-PRO-300' } }, photos: [], claims: [] })
    damaged = (await ok('warehouse', 'POST', url(), { kind: 'DAMAGED', receiptLineId: receipt.lines[0].id, quantity: '1', uom: 'HIDE' }, 201)).discrepancy
    expect(damaged).toMatchObject({ seq: 20, kind: 'DAMAGED', reasonCode: 'DAMAGED', note: null })
    // The tenant's own reason names its kind.
    stains = (await ok('warehouse', 'POST', url(), { reasonCode: 'STAINS', kind: 'DAMAGED', receiptLineId: receipt.lines[0].id, quantity: '12.5', uom: 'FT2', note: 'Stains on the grain side.' }, 201)).discrepancy
    expect(stains).toMatchObject({ seq: 30, kind: 'DAMAGED', reasonCode: 'STAINS', reason: { labelEn: 'Stains' } })
    // A missing document, for the delivery as a whole: a kind without a code of the list.
    const missing = (await ok('warehouse', 'POST', url(), { kind: 'MISSING_DOCUMENT', note: 'No Cr VI report in the box.' }, 201)).discrepancy
    expect(missing).toMatchObject({ seq: 40, kind: 'MISSING_DOCUMENT', reasonCode: null, receiptLine: null })
    // As stored: the code leads the note; the event; the audit; the tile and the list's column.
    expect(await admin(`SELECT note, kind::text AS kind FROM "ReceiptDiscrepancy" WHERE id = $1`, [stains.id])).toEqual([{ note: 'STAINS: Stains on the grain side.', kind: 'DAMAGED' }])
    expect(await admin(`SELECT payload->>'change' AS change, payload->>'status' AS status FROM "OutboxEvent" WHERE type = 'inventory.receipt_discrepancy_changed' AND payload->>'discrepancyId' = $1`, [short.id])).toEqual([{ change: 'RECORDED', status: 'OPEN' }])
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'ReceiptDiscrepancy' AND "recordId" = $1`, [short.id])).toEqual([{ action: 'inventory.discrepancyRecorded' }])
    expect((await ok('viewer', 'GET', `/inventory/receipts/counts?siteId=${A.siteA1}`)).counts.discrepanciesOpen).toBeGreaterThanOrEqual(4)
    const listed = (await ok('viewer', 'GET', `/inventory/receipts?discrepancies=open&siteId=${A.siteA1}`)).receipts as Json[]
    expect(listed.find((row) => row.id === receipt.id)?.discrepancies).toEqual({ count: 4, open: 4, unsent: 4 })
    // The reason list counts its uses (platform/reasons: the code that leads the note).
    const [list] = (await ok('reasons', 'GET', '/reasons/lists?list=DISCREPANCY')).lists as Json[]
    const used = Object.fromEntries((list!.reasons as Json[]).map((reason) => [reason.code, reason.usedCount]))
    expect(used).toMatchObject({ SHORT: 1, DAMAGED: 1, STAINS: 1, OVER: 0 })
  })

  it('refuses in words: an inactive or unknown reason, a reason of its own without a kind, a unit the line does not take, a quantity without unit; a reader may not write', async () => {
    expect((await refused('warehouse', 'POST', url(), { reasonCode: 'HOLES', kind: 'DAMAGED' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/reasonCode', message: expect.stringContaining('HOLES is not an active reason of the discrepancy list') })])
    expect((await refused('warehouse', 'POST', url(), { reasonCode: 'STAINS' }, 400)).issues).toEqual([expect.objectContaining({ path: 'body/kind' })])
    expect((await refused('warehouse', 'POST', url(), { kind: 'SHORT', receiptLineId: receipt.lines[0].id, quantity: '2', uom: 'KG' }, 400)).issues).toEqual([{ path: 'body/uom', message: 'SEED-LEA-100 is not counted in KG: use its base unit FT2 or a unit it converts.' }])
    expect((await refused('warehouse', 'POST', url(), { kind: 'SHORT', quantity: '2' }, 400)).issues).toEqual([{ path: 'body/uom', message: 'Give the quantity and its unit together, or neither.' }])
    expect((await refused('warehouse', 'POST', url(), { kind: 'SHORT', receiptLineId: newId() }, 400)).issues).toEqual([{ path: 'body/receiptLineId', message: 'Not a line of this receipt.' }])
    await refused('viewer', 'POST', url(), { kind: 'SHORT' }, 403)
    await refused('otherTenant', 'GET', url(), undefined, 404)
  })

  it('changes and removes only while OPEN, on the version read; photos on a discrepancy', async () => {
    const changed = (await ok('warehouse', 'PATCH', `${url()}/${damaged.id}`, { version: damaged.version, note: 'A cut across the back.' })).discrepancy
    expect(changed).toMatchObject({ note: 'A cut across the back.', reasonCode: 'DAMAGED', version: damaged.version + 1 })
    expect((await refused('warehouse', 'PATCH', `${url()}/${damaged.id}`, { version: damaged.version, note: 'stale' }, 409)).code).toBe('conflict')
    damaged = changed
    const picture = await photo('warehouse', `${url()}/${damaged.id}/photos`, 'cut.jpg')
    expect(picture).toMatchObject({ recordType: 'ReceiptDiscrepancy', recordId: damaged.id })
    // A discrepancy with a photo is not removed; one without is (recorded by mistake).
    const mistake = (await ok('warehouse', 'POST', url(), { kind: 'OVER', note: 'Typed by mistake' }, 201)).discrepancy
    expect((await ok('warehouse', 'DELETE', `${url()}/${mistake.id}?version=${mistake.version}`)).removed).toEqual({ id: mistake.id, seq: 50 })
    expect(await admin(`SELECT count(*)::int AS n FROM "ReceiptDiscrepancy" WHERE id = $1`, [mistake.id])).toEqual([{ n: 0 }])
    expect((await refused('warehouse', 'DELETE', `${url()}/${damaged.id}?version=${damaged.version}`, undefined, 409)).message).toMatch(/has a photo: delete it first/)
    const listed = (await ok('viewer', 'GET', url())).discrepancies as Json[]
    expect(listed.map((row) => row.seq)).toEqual([10, 20, 30, 40])
    expect(listed.find((row) => row.id === damaged.id)!.photos).toEqual([expect.objectContaining({ id: picture.id, status: 'AVAILABLE' })])
  })

  it('the report: what the send would do, the PDF preview without prices, then the mail with the PDF on the receipt thread; OPEN ones become SENT', async () => {
    const check = await ok('warehouse', 'GET', `/inventory/receipts/${receipt.id}/discrepancy-report/check`)
    expect(check).toMatchObject({ ready: true, problems: [], language: 'it', recipients: [{ contactId: A.orderDesk, email: 'orders.p2@example.com', suggested: true }] })
    expect(check.discrepancyIds).toHaveLength(4)
    expect(check.subject).toBe(`Difformità della consegna ${receipt.number} (vs. DDT DDT-D-${run})`)
    const preview = await call('viewer', 'GET', `/inventory/receipts/${receipt.id}/discrepancy-report?ids=${short.id},${stains.id}&language=en`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers['content-type']).toBe('application/pdf')
    const previewText = pdfFlatText(preview.rawPayload)
    expect(previewText).toContain('PREVIEW - not sent')
    expect(previewText).toContain('Delivery discrepancy report')
    expect(previewText).toContain('SEED-PRO-300')
    expect(previewText).toContain('Stains on the grain side.')
    // No price: the protectors' 6.50 and the leather's 5.00 a ft² appear nowhere (the company's share capital may).
    expect(previewText).not.toMatch(/6,50|6\.50|5\.000000|Prezzo|Price|Value/)

    // Send the first three (the missing document stays open).
    const ids = [short.id, damaged.id, stains.id]
    const sent = await ok('warehouse', 'POST', `/inventory/receipts/${receipt.id}/discrepancy-report`, { discrepancyIds: ids, contactIds: [A.orderDesk], message: 'Vi chiediamo una nota di credito.' }, 201)
    expect(sent.report).toMatchObject({ to: ['orders.p2@example.com'], language: 'it', discrepancyIds: ids, sentIds: ids, fileName: `Segnalazione-difformita-${receipt.number}.pdf` })
    expect((sent.discrepancies as Json[]).filter((row) => ids.includes(row.id)).every((row) => row.status === 'SENT' && row.sentAt !== null && row.sentById === IDS.warehouse)).toBe(true)
    // The PDF: a DOCUMENT of the receipt shared with the supplier's party, no price in it; the mail QUEUED with it.
    expect(await admin(`SELECT kind::text AS kind, visibility::text[] AS visibility, "partyId", status::text AS status FROM "StoredFile" WHERE id = $1`, [sent.report.documentFileId])).toEqual([{ kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER'], partyId: A.supplier, status: 'AVAILABLE' }])
    const [mail] = await admin(`SELECT status::text AS status, "to", subject, "recordType", "recordId" FROM "EmailOutbound" WHERE id = $1`, [sent.report.emailId])
    expect(mail).toEqual({ status: 'QUEUED', to: ['orders.p2@example.com'], subject: `Difformità della consegna ${receipt.number} (vs. DDT DDT-D-${run})`, recordType: 'GoodsReceipt', recordId: receipt.id })
    const [message] = await admin(`SELECT direction::text AS direction, "bodyText", "attachmentFileIds" AS attachments FROM "Message" WHERE "threadId" = $1`, [sent.report.threadId])
    expect(message).toMatchObject({ direction: 'OUTBOUND', attachments: [sent.report.documentFileId] })
    expect(message!.bodyText).toContain('Vi chiediamo una nota di credito.')
    const [stored] = await admin<{ storeAccountId: string; storageKey: string }>(`SELECT "storeAccountId", "storageKey" FROM "StoredFile" WHERE id = $1`, [sent.report.documentFileId])
    const pdf = await h.files.storage.read(system(), stored!.storeAccountId, stored!.storageKey, 10_000_000)
    const text = pdfFlatText(pdf!)
    expect(text).toContain('Segnalazione difformità della consegna')
    expect(text).not.toContain('ANTEPRIMA')
    expect(text).toContain('Macchie')
    expect(text).not.toMatch(/6,50|Prezzo/)
    expect(await admin(`SELECT payload->'sentIds' AS sent FROM "OutboxEvent" WHERE type = 'inventory.receipt_discrepancies_reported' AND subject = $1`, [receipt.id])).toEqual([{ sent: ids }])
    expect(keysOf(sent).filter((key) => /price|cost|value|amount/i.test(key))).toEqual([])
  })

  it('a reminder sends a SENT one again unchanged; the supplier agrees, credits; closed with what settled it; then it changes no more', async () => {
    const again = await ok('warehouse', 'POST', `/inventory/receipts/${receipt.id}/discrepancy-report`, { discrepancyIds: [stains.id], contactIds: [A.orderDesk] }, 201)
    expect(again.report).toMatchObject({ discrepancyIds: [stains.id], sentIds: [] })
    let row = (again.discrepancies as Json[]).find((entry) => entry.id === stains.id)!
    expect(row.status).toBe('SENT')
    // Not reported yet: it cannot be agreed.
    const missing = (again.discrepancies as Json[]).find((entry) => entry.seq === 40)!
    expect((await refused('warehouse', 'POST', `${url()}/${missing.id}/status`, { version: missing.version, to: 'AGREED' }, 409)).message).toBe('Only a discrepancy reported to the supplier (SENT) is agreed: send the report first.')
    row = (await ok('warehouse', 'POST', `${url()}/${stains.id}/status`, { version: row.version, to: 'AGREED', note: 'Supplier agrees by mail.' })).discrepancy
    row = (await ok('warehouse', 'POST', `${url()}/${stains.id}/status`, { version: row.version, to: 'CREDITED', note: 'Credit note NC-77.' })).discrepancy
    expect((await refused('warehouse', 'POST', `${url()}/${stains.id}/status`, { version: row.version, to: 'CLOSED' }, 400)).issues).toEqual([{ path: 'body/note', message: 'Say what settled it, or why it is not pursued.' }])
    row = (await ok('warehouse', 'POST', `${url()}/${stains.id}/status`, { version: row.version, to: 'CLOSED', note: 'Settled.' })).discrepancy
    expect(row).toMatchObject({ status: 'CLOSED', resolutionNote: 'Supplier agrees by mail. · Credit note NC-77. · Settled.' })
    expect(row.closedAt).not.toBeNull()
    expect((await refused('warehouse', 'PATCH', `${url()}/${stains.id}`, { version: row.version, note: 'later' }, 409)).message).toMatch(/closed: what was found no longer changes/)
    await refused('warehouse', 'POST', `/inventory/receipts/${receipt.id}/discrepancy-report`, { discrepancyIds: [stains.id], contactIds: [A.orderDesk] }, 409)
    // A reported one is never removed; one of another supplier's contacts refuses.
    const reported = (again.discrepancies as Json[]).find((entry) => entry.id === short.id)!
    expect((await refused('warehouse', 'DELETE', `${url()}/${short.id}?version=${reported.version}`, undefined, 409)).message).toMatch(/never removed/)
    expect((await refused('warehouse', 'POST', `/inventory/receipts/${receipt.id}/discrepancy-report`, { contactIds: [newId()] }, 400)).issues[0].path).toBe('body/contactIds/0')
  })

  it('a reversed receipt takes no new discrepancy', async () => {
    const other = await makeOrder([leatherLine('100')])
    const posted = (await ok('manager', 'POST', '/inventory/receipts', { purchaseOrderId: other.id, lines: [{ purchaseOrderLineId: other.lines[0], lots: [{ hides: hides('R', ['50']) }] }] }, 201)).receipt
    await ok('manager', 'POST', `/inventory/receipts/${posted.id}/reverse`, { version: posted.version, reason: 'Test: wrong order' }, 201)
    expect((await refused('warehouse', 'POST', `/inventory/receipts/${posted.id}/discrepancies`, { kind: 'SHORT' }, 409)).message).toMatch(/is reversed: its goods are no longer in stock as received/)
  })
})

// ---- SCM-248: the tannery's hide list ------------------------------------------------------------------------------------------

describe("the tannery's hide list, imported as one receipt (SCM-248)", () => {
  let order: Awaited<ReturnType<typeof makeOrder>>
  const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
  const HEADER = 'Ordine;Numero pelle;Superficie;UM;Bagno;Scelta;Spessore;DDT;Data DDT;Motivo differenza'

  async function dryRun(body: Buffer): Promise<Json> {
    const started = await ok('warehouse', 'POST', '/imports', { importerKey: 'inventory.hideList', companyId: A.companyA, file: { originalName: 'pelli.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha(body) } }, 201)
    const sent = await app.inject({ method: 'PUT', url: started.upload.url, headers: started.upload.headers, payload: body })
    expect(sent.statusCode, sent.body).toBe(200)
    await ok('warehouse', 'POST', `/files/${started.job.fileId}/complete`)
    await planImport(system(), started.job.id, { lastAttempt: true })
    return (await ok('warehouse', 'GET', `/imports/${started.job.id}`)).job
  }
  async function apply(job: Json): Promise<Json> {
    await ok('warehouse', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    await applyPlan(system(), job.id, { lastAttempt: true })
    return (await ok('warehouse', 'GET', `/imports/${job.id}`)).job
  }
  const rowsOf = async (jobId: string): Promise<Json[]> => (await ok('warehouse', 'GET', `/imports/${jobId}/rows`)).rows

  beforeAll(async () => {
    // 200 ft² ± 5 %.
    order = await makeOrder([leatherLine('200')])
  })

  it('the dry run: rows checked against the order, totals against what it expects; nothing written', async () => {
    const before = (await admin(`SELECT count(*)::int AS n FROM "GoodsReceipt" WHERE "purchaseOrderId" = $1`, [order.id]))[0]!.n
    const job = await dryRun(
      csv([
        HEADER,
        `${order.number};T-01;52,3;ft2;DB-1;A;1,2;DDT-HL-${run};28/10/2026;`,
        `${order.number};T-02;48,9;ft2;DB-1;A;1,2;;;`,
        `${order.number};T-03;4,8;mq;DB-2;B;;;;`,
        `${order.number};T-02;50;ft2;DB-1;A;;;;`,
        `${order.number};T-05;50;kg;DB-1;A;;;;`,
      ]),
    )
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 5, createCount: 3, errorCount: 2 })
    const rows = await rowsOf(job.id)
    expect(rows.find((row) => row.rowNumber === 5)!.errors).toEqual([{ column: 'tanneryNumber', message: 'Hide T-02 is on the list twice (row 3 too).' }])
    expect(rows.find((row) => row.rowNumber === 6)!.errors).toEqual([expect.objectContaining({ column: 'unit' })])
    const summary = await ok('warehouse', 'GET', `/inventory/receipts/hide-lists/${job.id}`)
    // 52.3 + 48.9 + 4.8 m² (= 51.6668 ft²) = 152.8668 ft² of 200: short, no reason needed.
    expect(summary).toMatchObject({ status: 'PLANNED', counts: { rows: 5, toReceive: 3, receivedBefore: 0, errors: 2 }, order: { id: order.id, number: order.number }, receipt: null })
    expect(summary.lines).toEqual([expect.objectContaining({ seq: 10, hides: 3, lots: 2, baseArea: '152.8668', expected: '200.0000', kind: 'SHORT', needsReason: false })])
    expect((await admin(`SELECT count(*)::int AS n FROM "GoodsReceipt" WHERE "purchaseOrderId" = $1`, [order.id]))[0]!.n).toBe(before)
  })

  it('the apply: ONE receipt with lots by dye batch, hides one by one tagged, the order moved on; a re-import receives only the rest', async () => {
    const job = await dryRun(
      csv([HEADER, `${order.number};T-01;52,3;ft2;DB-1;A;1,2;DDT-HL-${run};28/10/2026;`, `${order.number};T-02;48,9;ft2;DB-1;A;1,2;;;`, `${order.number};T-03;4,8;mq;DB-2;B;;;;`]),
    )
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 3, errorCount: 0 })
    const done = await apply(job)
    expect(done).toMatchObject({ status: 'APPLIED', appliedCount: 3, skippedCount: 0 })
    const summary = await ok('warehouse', 'GET', `/inventory/receipts/hide-lists/${job.id}`)
    expect(summary.receipt).toMatchObject({ status: 'POSTED' })
    // A reader without imports.view finds no list.
    await refused('viewer', 'GET', `/inventory/receipts/hide-lists/${job.id}`, undefined, 404)
    const receipt = (await ok('manager', 'GET', `/inventory/receipts/${summary.receipt.id}`)).receipt
    expect(receipt).toMatchObject({ supplierDdtNumber: `DDT-HL-${run}`, supplierDdtDate: '2026-10-28', purchaseOrder: { id: order.id, status: 'PARTLY_RECEIVED' }, summary: { lots: 2, hides: 3, quantities: [{ uom: 'FT2', baseQuantity: '152.8668' }] } })
    expect(receipt.value).toEqual({ currency: 'EUR', valueAmount: 76_433 })
    const lots = (await ok('viewer', 'GET', `/inventory/receipts/${receipt.id}/lots`)).lots as Json[]
    expect(lots.map((lot) => [lot.dyeBatch, lot.hides.map((hide: Json) => hide.supplierCode)])).toEqual([
      ['DB-1', ['T-01', 'T-02']],
      ['DB-2', ['T-03']],
    ])
    // Every row of the import answers its own hide.
    const rows = await rowsOf(job.id)
    const hideIds = new Set(lots.flatMap((lot) => lot.hides.map((hide: Json) => hide.id)))
    expect(rows.every((row) => row.outcome === 'APPLIED' && hideIds.has(row.recordId))).toBe(true)
    expect(await admin(`SELECT after->>'importJobId' AS job FROM "AuditLog" WHERE action = 'inventory.hideListReceived' AND "recordId" = $1`, [receipt.id])).toEqual([{ job: job.id }])

    // The same list again with one more hide: the three received are UNCHANGED, only the fourth is received.
    const again = await dryRun(
      csv([HEADER, `${order.number};T-01;52,3;ft2;DB-1;A;1,2;;;`, `${order.number};T-02;48,9;ft2;DB-1;A;1,2;;;`, `${order.number};T-03;4,8;mq;DB-2;B;;;;`, `${order.number};T-04;45;ft2;DB-1;A;;DDT-HL2-${run};;`]),
    )
    expect(again).toMatchObject({ createCount: 1, unchangedCount: 3, errorCount: 0 })
    const second = await apply(again)
    expect(second).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    expect((await admin(`SELECT count(*)::int AS n FROM "GoodsReceipt" WHERE "purchaseOrderId" = $1 AND status = 'POSTED'`, [order.id]))[0]!.n).toBe(2)
    // A received hide with another area: an error, never a second receipt of it.
    const wrong = await dryRun(csv([HEADER, `${order.number};T-01;60;ft2;DB-1;A;;;;`]))
    expect(wrong).toMatchObject({ createCount: 0, errorCount: 1 })
    expect((await rowsOf(wrong.id))[0]!.errors[0].message).toMatch(/^Hide T-01 was received on this order before \(GR-/)
  })

  it('over the tolerance the rows give the reason; a list of an order not receiving refuses every row', async () => {
    const big = await makeOrder([leatherLine('100')])
    const over = await dryRun(csv([HEADER, `${big.number};O-01;60;ft2;DB-9;A;;;;`, `${big.number};O-02;60;ft2;DB-9;A;;;;`]))
    expect(over).toMatchObject({ createCount: 0, errorCount: 2 })
    expect((await rowsOf(over.id))[0]!.errors).toEqual([expect.objectContaining({ column: 'differenceReason', message: expect.stringContaining('tolerance 5%: at most 105.0000') })])
    const reasoned = await dryRun(csv([HEADER, `${big.number};O-01;60;ft2;DB-9;A;;;;Taken: the whole batch`, `${big.number};O-02;60;ft2;DB-9;A;;;;`]))
    expect(reasoned).toMatchObject({ createCount: 2, errorCount: 0 })
    const applied = await apply(reasoned)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    expect(await admin(`SELECT o.status::text AS status FROM "PurchaseOrder" o WHERE o.id = $1`, [big.id])).toEqual([{ status: 'RECEIVED' }])
    // The order is received in full now: a list for it refuses every row in the order's words.
    const late = await dryRun(csv([HEADER, `${big.number};O-03;10;ft2;DB-9;A;;;;`]))
    expect((await rowsOf(late.id))[0]!.errors).toEqual([expect.objectContaining({ column: 'order', message: expect.stringContaining('received in full') })])
    const unknown = await dryRun(csv([HEADER, `NO-SUCH-PO;X-01;10;ft2;;;;;;`]))
    expect((await rowsOf(unknown.id))[0]!.errors).toEqual([{ column: 'order', message: 'No purchase order NO-SUCH-PO in this company.' }])
  })
})
