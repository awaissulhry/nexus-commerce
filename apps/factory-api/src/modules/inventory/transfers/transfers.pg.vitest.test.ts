import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { transferDdtDocument } from '@nexus/factory-domain/inventory/transfers/ddt'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { transferDdtFactsOf } from '../../shipping/ddt/transfer'
import { ALL_INVENTORY, startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'

/**
 * Transfers between sites on the local stack (B-W2b-326; SCM-219, SCM-220), through the app's real routes on the inventory
 * fixture's made-up data (ledger/testing/fixture.ts: company A with plants A1 and A2, company A2 with plant C1), with a transit
 * place at A1, the series and the legal data the DDT needs, and sessions of its own:
 *   - the draft: New transfer (one transit place: it is taken), the stock picker, lines from it (a hide whole, never more
 *     than the place holds), a cell changed on its version, a line removed, a draft cancelled; who may (the sender) and
 *     who sees it (either end; the others find nothing);
 *   - the ship: a TRANSFER per line onto the transit place, the DDT's number from the sending company's series, the PDF
 *     stored on the transfer (and the DDT's words), every refusal in words before a number is taken;
 *   - the receipt at the other company's site: a lot of that site (its company's LOT series, the quality copied), the hide
 *     re-tagged, TRANSFER_OUT and TRANSFER_IN valued at the same cost, a short line with its reason (RECEIVED), the rest still
 *     on the transit place; a receipt in two parts (PARTLY_RECEIVED); refusals (the sender, more than in transit, a part of a
 *     hide, an unknown reason);
 *   - the differences: written off off the transit place (valued), sent back (the ship reversed), settled once;
 *   - the list: its tiles and filters; the events.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/transfers/`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot = ''
let serial = 0
const idem = () => `transfers-${Date.now()}-${++serial}`
const YEAR = String(new Date().getUTCFullYear())
const extra = { transit: newId(), transitA2: newId(), user: newId(), receiverUser: newId() }

const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const MANAGE: Permission[] = ['inventory.transfers.manage', 'files.read']

function sessions(): Record<string, SessionContext> {
  const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenantA, actorId, grants })
  return {
    manager: office(extra.user, [grant([...ALL_INVENTORY, ...MANAGE, 'money.cost'])]),
    /** Company A's plants only (the sending side). */
    sender: office(extra.user, [grant([...ALL_INVENTORY, ...MANAGE], [ids.companyA])]),
    /** Plant C1 of company A2 only (the receiving side). */
    receiver: office(extra.receiverUser, [grant([...ALL_INVENTORY, ...MANAGE], [ids.companyA2], [ids.siteC1])]),
    viewer: office(extra.user, [grant(['inventory.stock.view', 'files.read'])]),
    /** Sees plant A2 only: a transfer A1 → C1 is not its. */
    'a2-only': office(extra.user, [grant(['inventory.stock.view', 'inventory.transfers.manage'], [ids.companyA], [ids.siteA2])]),
    'floor-a1': { audience: 'floor', tenantId: ids.tenantA, actorId: newId(), siteId: ids.siteA1, deviceId: ids.deviceA1, grants: [grant(['inventory.locations.view', 'inventory.transfer'], [ids.companyA], [ids.siteA1])] },
  }
}

const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key: string | null = method === 'GET' ? null : idem()): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refused = async (response: Promise<LightMyRequestResponse>, status: number): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json().error as Json
}
const refusal = (error: Json): string | null => ((error.issues ?? []) as Json[]).map((issue) => String(issue.path)).find((path) => path.startsWith('refusal/'))?.slice('refusal/'.length) ?? null
const events = async (subject: string) => (await f.admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.transfer_changed' AND subject = $1 ORDER BY "occurredAt", id`, [subject])).map((row) => row.payload)
const moves = async (lineIds: readonly string[]) =>
  f.admin(
    `SELECT m.id, m.reason::text AS reason, m."siteId", m."fromLocationId", m."toLocationId", m."lotId", m."hideId", m."baseQuantity"::text AS quantity, m."transferLineId", m."reversalOfId", v."unitCost"::text AS "unitCost", v.method::text AS method
       FROM "StockMove" m LEFT JOIN "StockValuation" v ON v."moveId" = m.id
      WHERE m."transferLineId" = ANY($1::uuid[]) ORDER BY m."createdAt", m.id`,
    [lineIds],
  )
const balance = async (locationId: string, itemId: string) => Number((await f.admin<{ q: string | null }>(`SELECT (coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" END), 0) - coalesce(sum(CASE WHEN "fromLocationId" = $1 THEN "baseQuantity" END), 0))::text AS q FROM "StockMove" WHERE "itemId" = $2 AND ($1 IN ("toLocationId", "fromLocationId"))`, [locationId, itemId]))[0]!.q ?? 0)
const adjustIn = (body: Json) => ok(call('manager', 'POST', '/inventory/adjustments', { direction: 'IN', note: 'Opening count for the transfers test.', ...body }), 201)

beforeAll(async () => {
  f = await startInventoryFixture('transfers')
  ids = f.ids
  const address = JSON.stringify({ line1: 'Via Inventata 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' })
  for (const companyId of [ids.companyA, ids.companyA2]) {
    await f.admin(`UPDATE "Company" SET address = $2::jsonb, "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId, address])
    await f.admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'LOT', 'MAIN', 'ALL', 'NEVER', $4, false)`, [newId(), ids.tenantA, companyId, `TL${companyId.slice(-3).toUpperCase()}-{N:5}`])
  }
  await f.admin(`UPDATE "Site" SET address = $2::jsonb WHERE id = $1`, [ids.siteC1, JSON.stringify({ line1: 'Via Seconda 2', postalCode: '35100', city: 'Padova', country: 'IT' })])
  await f.admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'TRANSFER', 'MAIN', $4, 'YEARLY', 'TRF-{YYYY}-{N:4}', false)`, [newId(), ids.tenantA, ids.companyA, YEAR])
  await f.admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true)`, [newId(), ids.tenantA, ids.companyA, YEAR])
  await f.admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'A1-TRANSIT', 'In transit from A1', 'TRANSIT')`, [extra.transit, ids.tenantA, ids.companyA, ids.siteA1])
  await f.admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), ids.tenantA])

  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-transfers-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  const SESSIONS = sessions()
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: f.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // Stock at A1: 30 m of the grey lining lot in BIN-01, hide 1 (53.2 ft²) in BIN-02, 10 protectors in BIN-01.
  await adjustIn({ siteId: ids.siteA1, itemId: ids.lining, lotId: ids.liningLot, locationId: ids.bin1, quantity: '30' })
  await adjustIn({ siteId: ids.siteA1, itemId: ids.leather, hideId: ids.hide1, locationId: ids.bin2, quantity: '53.2' })
  await adjustIn({ siteId: ids.siteA1, itemId: ids.protector, locationId: ids.bin1, quantity: '10' })
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await f?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

let transfer: Json
let liningLine: Json
let hideLine: Json

describe('the draft (SCM-219)', () => {
  it('offers the sites the caller sends from, with their transit places', async () => {
    const { sites, ddtReasons, transport } = await ok(call('sender', 'GET', '/inventory/transfer-orders/options'))
    const a1 = (sites as Json[]).find((site) => site.id === ids.siteA1)!
    expect(a1).toMatchObject({ send: true, transitPlaces: [{ id: extra.transit, code: 'A1-TRANSIT' }] })
    expect((a1.places as Json[]).some((place) => place.id === extra.transit)).toBe(false)
    expect((sites as Json[]).find((site) => site.id === ids.siteC1)).toMatchObject({ send: false, companyId: ids.companyA2 })
    expect(ddtReasons).toEqual(['TRANSFER', 'SALE', 'WORK_ON_ACCOUNT', 'OTHER'])
    expect(transport).toEqual(['SENDER', 'RECIPIENT', 'CARRIER'])
  })

  it('drafts a transfer to another company’s plant on the site’s only transit place, numbered from the TRANSFER series', async () => {
    expect(refusal(await refused(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteA1 }), 409))).toBe('SAME_SITE')
    expect(refusal(await refused(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA2, toSiteId: ids.siteC1 }), 409))).toBe('NO_TRANSIT_PLACE')
    // The receiver may not send from A1; the floor never drafts one.
    await refused(call('receiver', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteC1 }), 404)
    await refused(call('floor-a1', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteC1 }), 403)
    const today = businessDate(new Date())
    transfer = (await ok(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteC1, toLocationId: ids.storeC1, shipOn: today, expectedOn: today, note: 'Lining and a hide for plant C1 (test).' }), 201)).transfer
    expect(transfer).toMatchObject({ number: `TRF-${YEAR}-0001`, status: 'DRAFT', interCompany: true, transit: { id: extra.transit }, toLocation: { id: ids.storeC1 }, lines: [], ddt: null })
    expect(transfer.actions).toMatchObject({ ship: { allowed: false, refusal: 'NO_LINES' }, receive: { allowed: false, refusal: 'NO_RIGHT_TO' }, printDdt: { refusal: 'NO_DDT' } })
    expect((await events(transfer.id)).map((event) => event.change)).toEqual(['CREATED'])
  })

  it('the stock picker shows what A1 holds, never its transit place', async () => {
    const { rows } = await ok(call('sender', 'GET', `/inventory/transfer-orders/${transfer.id}/stock`))
    const lining = (rows as Json[]).find((row) => row.lot?.id === ids.liningLot)!
    expect(lining).toMatchObject({ location: { id: ids.bin1 }, onHand: '30', onLines: '0', available: '30', colour: { id: ids.liningGrey } })
    expect((rows as Json[]).find((row) => row.hide?.id === ids.hide1)).toMatchObject({ location: { id: ids.bin2 }, available: '53.2' })
    const filtered = await ok(call('sender', 'GET', `/inventory/transfer-orders/${transfer.id}/stock?q=TEST-HIDE-1`))
    expect(filtered.rows).toHaveLength(1)
  })

  it('adds lines from it: a lot from its bin, a hide whole (its place found); never more than the place holds', async () => {
    expect(refusal(await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.bin1, quantity: '31' }), 409))).toBe('NOT_ENOUGH_STOCK')
    expect(refusal(await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.lining, fromLocationId: ids.bin1, quantity: '3' }), 409))).toBe('LOT_REQUIRED')
    expect(refusal(await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.leather, hideId: ids.hide1, quantity: '20' }), 409))).toBe('HIDE_WHOLE')
    await refused(call('viewer', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.bin1, quantity: '3' }), 403)
    transfer = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.bin1, quantity: '20' }), 201)).transfer
    transfer = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.leather, hideId: ids.hide1 }), 201)).transfer
    transfer = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.protector, fromLocationId: ids.bin1, quantity: '2' }), 201)).transfer
    expect(transfer.lines.map((line: Json) => [line.seq, line.quantity, line.available, line.state])).toEqual([
      [10, '20', '30', 'DRAFT'],
      [20, '53.2', '53.2', 'DRAFT'],
      [30, '2', '10', 'DRAFT'],
    ])
    liningLine = transfer.lines[0]
    hideLine = transfer.lines[1]
    expect(hideLine).toMatchObject({ hide: { id: ids.hide1 }, lot: { id: ids.leatherLot }, fromLocation: { id: ids.bin2 }, colour: { id: ids.leatherBlack } })
    // The same hide on another draft is refused.
    const other = (await ok(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteA2 }), 201)).transfer
    expect(refusal(await refused(call('sender', 'POST', `/inventory/transfer-orders/${other.id}/lines`, { version: other.version, itemId: ids.leather, hideId: ids.hide1 }), 409))).toBe('HIDE_ON_ANOTHER_LINE')
    await ok(call('sender', 'POST', `/inventory/transfer-orders/${other.id}/cancel`, { version: other.version, reason: 'Made by mistake (test).' }))
  })

  it('a cell is saved on its line’s version; a line is removed on the transfer’s', async () => {
    const changed = (await ok(call('sender', 'PATCH', `/inventory/transfer-orders/${transfer.id}/lines/${liningLine.id}`, { version: liningLine.version, quantity: '25' }))).transfer
    expect(changed.lines[0]).toMatchObject({ quantity: '25', version: liningLine.version + 1 })
    await refused(call('sender', 'PATCH', `/inventory/transfer-orders/${transfer.id}/lines/${liningLine.id}`, { version: liningLine.version, quantity: '24' }), 409)
    const protector = changed.lines[2] as Json
    transfer = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines/${protector.id}/remove`, { version: changed.version }))).transfer
    expect(transfer.lines).toHaveLength(2)
    liningLine = transfer.lines[0]
  })

  it('either end sees it; a session of neither finds nothing', async () => {
    await ok(call('viewer', 'GET', `/inventory/transfer-orders/${transfer.id}`))
    await ok(call('receiver', 'GET', `/inventory/transfer-orders/${transfer.id}`))
    await refused(call('a2-only', 'GET', `/inventory/transfer-orders/${transfer.id}`), 404)
    const list = await ok(call('a2-only', 'GET', '/inventory/transfer-orders'))
    expect((list.rows as Json[]).some((row) => row.id === transfer.id)).toBe(false)
  })
})

describe('the ship and its DDT (SCM-219, SCM-220)', () => {
  it('is refused in words before a number is taken: a carrier unnamed, the receiver, a stale version', async () => {
    await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/ship`, { version: transfer.version, transportBy: 'CARRIER', packages: 2, grossWeightKg: '18.5' }), 400)
    await refused(call('receiver', 'POST', `/inventory/transfer-orders/${transfer.id}/ship`, { version: transfer.version, transportBy: 'SENDER', packages: 2, grossWeightKg: '18.5' }), 403)
    await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/ship`, { version: transfer.version - 1, transportBy: 'SENDER', packages: 2, grossWeightKg: '18.5' }), 409)
    expect((await f.admin(`SELECT 1 FROM "NumberAllocation" WHERE "recordType" = 'TransferOrder' AND "recordId" = $1 AND kind = 'DDT'`, [transfer.id])).length).toBe(0)
  })

  it('moves every line onto the transit place, issues the DDT from company A’s series and stores its PDF', async () => {
    const answer = await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/ship`, { version: transfer.version, transportBy: 'SENDER', packages: 2, grossWeightKg: '18.5', trackingRef: 'VAN-07' }))
    transfer = answer.transfer
    expect(answer.pdfProblem).toBeNull()
    expect(answer.fileId).toEqual(expect.any(String))
    expect(transfer).toMatchObject({ status: 'SHIPPED', trackingRef: 'VAN-07', ddt: { number: `1/${YEAR}`, reason: 'TRANSFER', transportBy: 'SENDER', packages: 2, grossWeightKg: '18.5', appearance: 'colli', fileId: answer.fileId } })
    expect(transfer.lines.map((line: Json) => [line.shippedQuantity, line.inTransit, line.state])).toEqual([
      ['25', '25', 'IN_TRANSIT'],
      ['53.2', '53.2', 'IN_TRANSIT'],
    ])
    expect(transfer.actions).toMatchObject({ ship: { refusal: 'NOT_DRAFT' }, cancel: { refusal: 'NOT_DRAFT' }, printDdt: { allowed: true } })
    const shipped = await moves(transfer.lines.map((line: Json) => line.id))
    expect(shipped.map((move) => [move.reason, move.fromLocationId, move.toLocationId, move.quantity])).toEqual([
      ['TRANSFER', ids.bin1, extra.transit, '25.0000'],
      ['TRANSFER', ids.bin2, extra.transit, '53.2000'],
    ])
    expect(await balance(extra.transit, ids.lining)).toBe(25)
    expect(await balance(ids.bin1, ids.lining)).toBe(5)
    expect((await f.admin(`SELECT "recordType", "recordId", kind::text AS kind FROM "StoredFile" WHERE id = $1`, [answer.fileId]))[0]).toMatchObject({ recordType: 'TransferOrder', recordId: transfer.id, kind: 'FISCAL_ARCHIVE' })
    expect((await events(transfer.id)).map((event) => event.change)).toEqual(['CREATED', 'LINES', 'LINES', 'LINES', 'LINES', 'LINES', 'SHIPPED', 'PRINTED'])
    // Its lines and the draft's fields are fixed now.
    expect(refusal(await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/lines`, { version: transfer.version, itemId: ids.protector, fromLocationId: ids.bin1, quantity: '1' }), 409))).toBe('NOT_DRAFT')
    expect(refusal(await refused(call('sender', 'PATCH', `/inventory/transfer-orders/${transfer.id}`, { version: transfer.version, shipOn: businessDate(new Date()) }), 409))).toBe('NOT_DRAFT')
  })

  it('the DDT prints the two companies, the plant it goes to and the goods; its PDF opens; printing again gives the same file', async () => {
    const caller = callerFor(f.database, { audience: 'office', tenantId: ids.tenantA, actorId: extra.user, grants: [grant([...ALL_INVENTORY, ...MANAGE])], requestId: newId() } as RequestContext)
    const facts = await caller.withClient((client) => transferDdtFactsOf(client, transfer.id, 'it'))
    expect(facts).toMatchObject({ number: `1/${YEAR}`, reason: 'TRANSFER', toSite: { code: 'C1' }, recipient: { vatNumber: 'IT12345670009' } })
    const text = pdfFlatText(await renderDocumentPdf(composeDocument({ ...transferDdtDocument(facts), company: await companyLegalOf(caller, ids.companyA), sample: false })))
    expect(text).toContain(`Trasferimento ${transfer.number}`)
    expect(text).toContain('Padova')
    expect(text).toContain('TEST-LOT-LIN-1')
    const opened = await ok(call('viewer', 'GET', `/inventory/transfer-orders/${transfer.id}/ddt/pdf`))
    expect(opened.download.method).toBe('GET')
    expect((await ok(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/ddt/pdf`, {}))).file.id).toBe(transfer.ddt.fileId)
  })
})

describe('the receipt at the other site (SCM-220)', () => {
  it('is refused: the sender, more than in transit, a part of a hide, an unknown reason', async () => {
    const body = (lines: Json[]) => ({ version: transfer.version, lines })
    await refused(call('sender', 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, body([{ lineId: liningLine.id, quantity: '25' }])), 403)
    expect(refusal(await refused(call('receiver', 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, body([{ lineId: liningLine.id, quantity: '26' }])), 409))).toBe('MORE_THAN_IN_TRANSIT')
    expect(refusal(await refused(call('receiver', 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, body([{ lineId: hideLine.id, quantity: '20' }])), 409))).toBe('HIDE_WHOLE')
    expect(refusal(await refused(call('receiver', 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, body([{ lineId: liningLine.id, quantity: '23', differenceReasonCode: 'LOST_AT_SEA' }])), 409))).toBe('REASON_UNKNOWN')
  })

  it('receives at C1: a lot of company A2, the hide re-tagged, both legs valued at the same cost; a short line with its reason', async () => {
    transfer = (await ok(call('receiver', 'POST', `/inventory/transfer-orders/${transfer.id}/receive`, { version: transfer.version, lines: [{ lineId: liningLine.id, quantity: '23', differenceReasonCode: 'SHORT', differenceNote: 'Two metres missing from the roll.' }, { lineId: hideLine.id, quantity: '53.2' }] }))).transfer
    expect(transfer.status).toBe('RECEIVED')
    expect(transfer.receivedAt).toEqual(expect.any(String))
    const [lining, hide] = transfer.lines as [Json, Json]
    expect(lining).toMatchObject({ receivedQuantity: '23', inTransit: '2', difference: '2', state: 'SHORT', differenceReasonCode: 'SHORT', toLocation: { id: ids.storeC1 } })
    expect(hide).toMatchObject({ receivedQuantity: '53.2', inTransit: '0', state: 'RECEIVED' })
    expect(hide.toHide.code).not.toBe('TEST-HIDE-1')
    const lot = (await f.admin(`SELECT "companyId", "siteId", code, "qualityStatus"::text AS status, "itemColourId" FROM "Lot" WHERE id = $1`, [lining.toLot.id]))[0]!
    expect(lot).toMatchObject({ companyId: ids.companyA2, siteId: ids.siteC1, status: 'RELEASED', itemColourId: ids.liningGrey })
    expect(lot.code).toMatch(/^TL/)
    const legs = await moves([lining.id])
    const out = legs.find((move) => move.reason === 'TRANSFER_OUT')!
    const into = legs.find((move) => move.reason === 'TRANSFER_IN')!
    expect([out.siteId, out.fromLocationId, out.toLocationId, out.lotId, out.quantity]).toEqual([ids.siteA1, extra.transit, null, ids.liningLot, '23.0000'])
    expect([into.siteId, into.fromLocationId, into.toLocationId, into.lotId, into.quantity]).toEqual([ids.siteC1, null, ids.storeC1, lining.toLot.id, '23.0000'])
    expect(out.unitCost).toEqual(expect.any(String))
    expect(into).toMatchObject({ method: 'LOT_COST', unitCost: out.unitCost })
    expect(await balance(extra.transit, ids.lining)).toBe(2)
    expect(await balance(ids.storeC1, ids.lining)).toBe(23)
    expect(transfer.actions).toMatchObject({ receive: { refusal: 'NOT_IN_TRANSIT' }, settle: { allowed: true } })
    expect((await ok(call('sender', 'GET', `/inventory/transfer-orders/${transfer.id}`))).transfer.actions.settle).toEqual({ allowed: false, refusal: 'NO_RIGHT_TO' })
  })

  it('settles the short line: written off the transit place (valued), once', async () => {
    const settle = (session: string, resolution: string, version = transfer.version) => call(session, 'POST', `/inventory/transfer-orders/${transfer.id}/lines/${liningLine.id}/settle`, { version, resolution, note: 'Lost on the way (test).' })
    expect(refusal(await refused(settle('receiver', 'SENT_BACK'), 409))).toBe('SENT_BACK_PART')
    transfer = (await ok(settle('receiver', 'ADJUSTMENT'))).transfer
    expect(transfer.lines[0]).toMatchObject({ state: 'SETTLED', differenceResolution: 'ADJUSTMENT', inTransit: '0' })
    expect(transfer.totals).toMatchObject({ openDifferences: 0, settled: 1 })
    const written = (await moves([liningLine.id])).find((move) => move.reason === 'ADJUSTMENT')!
    expect([written.fromLocationId, written.toLocationId, written.quantity]).toEqual([extra.transit, null, '2.0000'])
    expect(written.unitCost).toEqual(expect.any(String))
    expect(await balance(extra.transit, ids.lining)).toBe(0)
    expect(refusal(await refused(settle('receiver', 'ADJUSTMENT'), 409))).toBe('SETTLED')
    expect((await events(transfer.id)).map((event) => event.change).slice(-2)).toEqual(['RECEIVED', 'SETTLED'])
  })
})

describe('a receipt in two parts, a line sent back, a draft cancelled, the list', () => {
  let second: Json
  it('A1 → A2: part now (PARTLY_RECEIVED), the rest said short; the short line sent back to its bin', async () => {
    const extraTransit = (await f.admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'A1-TRANSIT-A2', 'In transit to A2', 'TRANSIT') RETURNING id`, [extra.transitA2, ids.tenantA, ids.companyA, ids.siteA1]))[0]!.id as string
    // Two transit places now: the one that names the receiving site is taken.
    second = (await ok(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteA2, fromLocationId: ids.bin1, toLocationId: ids.storeA2 }), 201)).transfer
    expect(second).toMatchObject({ interCompany: false, transit: { id: extraTransit } })
    second = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${second.id}/lines`, { version: second.version, itemId: ids.protector, quantity: '4' }), 201)).transfer
    second = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${second.id}/lines`, { version: second.version, itemId: ids.lining, lotId: ids.liningLot, quantity: '5' }), 201)).transfer
    expect(second.lines.map((line: Json) => line.available)).toEqual(['10', '5'])
    second = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${second.id}/ship`, { version: second.version, transportBy: 'CARRIER', carrierName: 'Corriere Inventato', packages: 1, grossWeightKg: '4' }))).transfer
    expect(second.ddt).toMatchObject({ number: `2/${YEAR}`, carrier: { name: 'Corriere Inventato' } })
    const [protector, lining] = second.lines as [Json, Json]
    second = (await ok(call('manager', 'POST', `/inventory/transfer-orders/${second.id}/receive`, { version: second.version, lines: [{ lineId: protector.id, quantity: '4' }] }))).transfer
    expect(second.status).toBe('PARTLY_RECEIVED')
    expect(await balance(ids.storeA2, ids.protector)).toBe(4)
    second = (await ok(call('manager', 'POST', `/inventory/transfer-orders/${second.id}/receive`, { version: second.version, lines: [{ lineId: lining.id, quantity: '0', differenceReasonCode: 'WRONG_ITEM' }] }))).transfer
    expect(second.status).toBe('RECEIVED')
    second = (await ok(call('manager', 'POST', `/inventory/transfer-orders/${second.id}/lines/${lining.id}/settle`, { version: second.version, resolution: 'SENT_BACK' }))).transfer
    expect(second.lines[1]).toMatchObject({ state: 'SETTLED', differenceResolution: 'SENT_BACK' })
    const back = (await moves([lining.id])).find((move) => move.reversalOfId !== null)!
    expect([back.reason, back.fromLocationId, back.toLocationId, back.quantity]).toEqual(['TRANSFER', extraTransit, ids.bin1, '5.0000'])
    expect(await balance(ids.bin1, ids.lining)).toBe(5)
  })

  it('a draft is cancelled with why; the list shows the tiles and filters', async () => {
    // Two transit places at A1 and none names C1: the request names the route's.
    expect((await refused(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteC1 }), 400)).issues[0].path).toBe('body/transitLocationId')
    const draft = (await ok(call('sender', 'POST', '/inventory/transfer-orders', { fromSiteId: ids.siteA1, toSiteId: ids.siteC1, transitLocationId: extra.transit }), 201)).transfer
    await refused(call('sender', 'POST', `/inventory/transfer-orders/${draft.id}/cancel`, { version: draft.version, reason: '' }), 400)
    const cancelled = (await ok(call('sender', 'POST', `/inventory/transfer-orders/${draft.id}/cancel`, { version: draft.version, reason: 'Not needed any more (test).' }))).transfer
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Not needed any more (test).' })
    const list = await ok(call('manager', 'GET', '/inventory/transfer-orders'))
    expect(list.counts).toMatchObject({ IN_TRANSIT: 0, WITH_DIFFERENCES: 0, ALL: 4 })
    expect((list.rows as Json[]).map((row) => row.status)).toEqual(['CANCELLED', 'RECEIVED', 'CANCELLED', 'RECEIVED'])
    expect((list.rows as Json[]).find((row) => row.id === transfer.id)).toMatchObject({ ddtNumber: `1/${YEAR}`, lines: 2, differences: 0, interCompany: true })
    expect((await ok(call('manager', 'GET', `/inventory/transfer-orders?q=${encodeURIComponent(transfer.number)}`))).rows).toHaveLength(1)
    expect((await ok(call('manager', 'GET', '/inventory/transfer-orders?status=CANCELLED'))).rows).toHaveLength(2)
    expect((await ok(call('receiver', 'GET', '/inventory/transfer-orders'))).rows.map((row: Json) => row.to.id)).toEqual([ids.siteC1, ids.siteC1])
  })
})
