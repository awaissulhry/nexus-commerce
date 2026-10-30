import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'

/**
 * The warehouse screens' reads on the local stack (reads-contract.ts: Hides, Lots & traceability, the Movements grid,
 * why a figure is what it is; A2 SCR-060, SCR-064; design warehouse.hides / warehouse.lots / warehouse.moves). Read only:
 * the figures are the ledger's sums, each read keeps to the caller's companies and sites, values only with the cost
 * grain, and a floor worker is never named in a list (Owner answer W1) — one move names them only where the site
 * records workers. Run with `node scripts/factory/run-pg-tests.mjs inventory/stock`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let serial = 0
const key = () => `reads-${Date.now()}-${++serial}`
const moveIds: Record<string, string> = {}

async function post(path: string, body: Json, session = 'manager'): Promise<Json> {
  const response = await f.call(session, 'POST', path, { siteId: ids.siteA1, ...body }, key())
  expect(response.statusCode, response.body).toBe(201)
  return response.json().move
}
const get = async (url: string, session = 'manager') => {
  const response = await f.call(session, 'GET', url)
  return { status: response.statusCode, body: response.json() as Json }
}
const ok = async (url: string, session = 'manager') => {
  const { status, body } = await get(url, session)
  expect(status, JSON.stringify(body)).toBe(200)
  return body
}

beforeAll(async () => {
  f = await startInventoryFixture('stock_reads')
  ids = f.ids
  await f.admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", locale) VALUES ($1, $2, 'anna@example.invalid', 'Anna Esempio', 'it')`, [ids.user, ids.tenantA])
  await f.admin(`INSERT INTO "Worker" (id, "tenantId", "companyId", "siteId", "displayName", locale) VALUES ($1, $2, $3, $4, 'Marco Prova', 'it')`, [ids.worker, ids.tenantA, ids.companyA, ids.siteA1])
  // Hides 1 and 2 of the released lot, hide 3 of the quarantined lot, 120 m of lining, 10 protectors; then hide 1 to the
  // cutting rack (from a tablet), 20 m of lining to bin 1, 2 protectors scrapped, and the scrap reversed.
  moveIds.hide1 = (await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide1, locationId: ids.store, direction: 'IN', quantity: '53.2', unitCost: '7.000000', note: 'Opening.' })).id
  await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide2, locationId: ids.store, direction: 'IN', quantity: '51.8', unitCost: '8.000000', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.leather, hideId: ids.hide3, locationId: ids.store, direction: 'IN', quantity: '40', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.lining, lotId: ids.liningLot, locationId: ids.store, direction: 'IN', quantity: '120', note: 'Opening.' })
  await post('/inventory/adjustments', { itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '10', note: 'Opening.' })
  const floor = await f.call('floor-a1', 'POST', '/inventory/transfers', { itemId: ids.leather, hideId: ids.hide1, fromLocationId: ids.store, toLocationId: ids.cut, quantity: '53.2' }, key())
  expect(floor.statusCode, floor.body).toBe(201)
  moveIds.floor = floor.json().move.id
  moveIds.lining = (await post('/inventory/transfers', { itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.store, toLocationId: ids.bin1, quantity: '20' })).id
  moveIds.scrap = (await post('/inventory/scraps', { itemId: ids.protector, fromLocationId: ids.store, quantity: '2', note: 'Cracked shell.' })).id
  const reversed = await f.call('manager', 'POST', `/inventory/moves/${moveIds.scrap}/reverse`, { note: 'Not cracked after all.' }, key())
  expect(reversed.statusCode, reversed.body).toBe(201)
  moveIds.reversal = reversed.json().move.id
}, 60_000)

afterAll(async () => {
  await f?.close()
}, 60_000)

describe('hides one by one (design warehouse.hides; SCM-233, SCM-253, SCM-258)', () => {
  it('lists every hide with its area, lot, state and where its stock lies, and the tiles with hides and area side by side', async () => {
    const { hides, counts, matching, nextCursor } = await ok(`/inventory/hides?siteId=${ids.siteA1}`)
    expect(nextCursor).toBeNull()
    expect(hides.map((hide: Json) => hide.code).sort()).toEqual(['TEST-HIDE-1', 'TEST-HIDE-2', 'TEST-HIDE-3'])
    const one = hides.find((hide: Json) => hide.code === 'TEST-HIDE-1')
    expect(one).toMatchObject({ area: '53.2000', areaUom: 'FT2', baseArea: '53.2000', onHand: '53.2000', left: '53.2000', state: 'FULL', location: { code: 'A1-CUT' }, lot: { code: 'TEST-LOT-LEA-1', qualityStatus: 'RELEASED' }, colour: { code: 'BLK' }, item: { code: 'TEST-LEATHER', tracking: 'HIDE' } })
    expect(hides.find((hide: Json) => hide.code === 'TEST-HIDE-3')).toMatchObject({ location: { code: 'A1-STORE' }, lot: { qualityStatus: 'QUARANTINE' } })
    expect(counts.full).toEqual({ hides: 3, area: [{ uom: 'FT2', quantity: '145.0000' }] })
    expect(counts.quarantine).toEqual({ hides: 1, area: [{ uom: 'FT2', quantity: '40.0000' }] })
    expect(counts.partlyCut).toEqual({ hides: 0, area: [] })
    expect(matching).toEqual({ hides: 3, area: [{ uom: 'FT2', quantity: '145.0000' }] })
  })

  it('filters by quality, place, text and state, and pages with a cursor', async () => {
    expect((await ok(`/inventory/hides?quality=QUARANTINE`)).hides.map((hide: Json) => hide.code)).toEqual(['TEST-HIDE-3'])
    const atCut = await ok(`/inventory/hides?locationId=${ids.cut}`)
    expect(atCut.hides.map((hide: Json) => hide.code)).toEqual(['TEST-HIDE-1'])
    expect(atCut.matching).toEqual({ hides: 1, area: [{ uom: 'FT2', quantity: '53.2000' }] })
    expect((await ok(`/inventory/hides?q=hide-2`)).hides.map((hide: Json) => hide.code)).toEqual(['TEST-HIDE-2'])
    expect((await ok(`/inventory/hides?q=lot-lea-2`)).hides.map((hide: Json) => hide.code)).toEqual(['TEST-HIDE-3'])
    expect((await ok(`/inventory/hides?state=REMNANT`)).hides).toEqual([])
    const first = await ok(`/inventory/hides?limit=2`)
    expect(first.hides).toHaveLength(2)
    const second = await ok(`/inventory/hides?limit=2&cursor=${first.nextCursor}`)
    expect(second.hides).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.hides, ...second.hides].map((hide: Json) => hide.id)).size).toBe(3)
  })

  it('one hide: its lot, what happened to its area, and its cuts; another company or tenant does not find it', async () => {
    const record = await ok(`/inventory/hides/${ids.hide1}`, 'viewer')
    expect(record.hide).toMatchObject({ code: 'TEST-HIDE-1', onHand: '53.2000' })
    expect(record.lot).toMatchObject({ code: 'TEST-LOT-LEA-1', qualityStatus: 'RELEASED', supplier: null, receipt: null, crVi: { status: 'NOT_REQUIRED' } })
    expect(record.area).toEqual({ measured: '53.2000', cut: '0.0000', remnant: '0.0000', onHand: '53.2000', uom: 'FT2' })
    expect(record.cuts).toEqual([])
    expect(record.stationOnly).toBe(false)
    expect((await get(`/inventory/hides/${ids.hide1}`, 'company-two')).status).toBe(404)
    expect((await get(`/inventory/hides/${ids.hide1}`, 'manager-b')).status).toBe(404)
    expect((await ok(`/inventory/hides`, 'company-two')).hides).toEqual([])
    expect((await get(`/inventory/hides`, 'floor-a1')).status).toBe(403)
  })
})

describe('lots with their stock and trace (design warehouse.lots; SCM-232, SCM-240, SCM-241)', () => {
  it('lists every lot with its stock, hides, documents and work orders, and the tiles', async () => {
    const { lots, counts } = await ok(`/inventory/lots?siteId=${ids.siteA1}`)
    expect(lots.map((lot: Json) => lot.code).sort()).toEqual(['TEST-LOT-LEA-1', 'TEST-LOT-LEA-2', 'TEST-LOT-LIN-1'])
    expect(lots.find((lot: Json) => lot.code === 'TEST-LOT-LEA-1')).toMatchObject({ onHand: '105.0000', hides: 2, documents: 0, issuedTo: 0, opening: true, receipt: null, qualityStatus: 'RELEASED', siteCode: 'A1', colour: { code: 'BLK' } })
    expect(lots.find((lot: Json) => lot.code === 'TEST-LOT-LIN-1')).toMatchObject({ onHand: '120.0000', hides: 0 })
    expect(counts).toEqual({ quarantine: 1, waitingCrVi: 0, crViFailed: 0, blocked: 0, rejected: 0, released: 2 })
    expect((await ok(`/inventory/lots?onHold=true`)).lots.map((lot: Json) => lot.code)).toEqual(['TEST-LOT-LEA-2'])
    expect((await ok(`/inventory/lots?q=lin`)).lots.map((lot: Json) => lot.code)).toEqual(['TEST-LOT-LIN-1'])
    expect((await ok(`/inventory/lots?inStock=true`)).lots).toHaveLength(3)
    expect((await ok(`/inventory/lots`, 'manager-b')).lots).toEqual([])
  })

  it('one lot: where its stock is, its hides and its trace (opening stock has no receipt; not used yet)', async () => {
    const record = await ok(`/inventory/lots/${ids.leatherLot}`)
    expect(record.stock).toEqual([
      { location: { id: ids.cut, code: 'A1-CUT', name: 'A1-CUT' }, onHand: '53.2000', held: '0.0000', hides: 1 },
      { location: { id: ids.store, code: 'A1-STORE', name: 'A1-STORE' }, onHand: '51.8000', held: '0.0000', hides: 1 },
    ])
    expect(record.hides).toEqual({ inStock: 2, consumed: 0, scrapped: 0 })
    expect(record.trace).toEqual({ backward: { supplier: null, receipt: null, purchaseOrder: null }, forward: { workOrders: [], shipments: [], customers: 0 } })
    expect(record.moves).toBe(3)
    const held = await ok(`/inventory/lots/${ids.quarantineLot}`)
    expect(held.stock).toEqual([{ location: expect.objectContaining({ code: 'A1-STORE' }), onHand: '40.0000', held: '40.0000', hides: 1 }])
    expect((await get(`/inventory/lots/${ids.leatherLot}`, 'company-two')).status).toBe(404)
    expect((await get(`/inventory/lots/not-a-lot`)).status).toBe(400)
  })
})

describe('the ledger as the Movements grid shows it (SCR-064; Owner answers W1, W2 B)', () => {
  it('reads newest first with names, sides, both clocks and the effect; the office user by name, a tablet by its device', async () => {
    const { moves, nextCursor, closing } = await ok(`/inventory/ledger?siteId=${ids.siteA1}`)
    expect(nextCursor).toBeNull()
    expect(closing).toBeNull()
    expect(moves).toHaveLength(9)
    expect(moves[0]).toMatchObject({ id: moveIds.reversal, reason: 'SCRAP', reversalOfId: moveIds.scrap, delta: '2.0000', from: { kind: 'SCRAP', location: null }, to: { kind: 'LOCATION', location: { code: 'A1-STORE' } } })
    const floor = moves.find((move: Json) => move.id === moveIds.floor)
    expect(floor).toMatchObject({ reason: 'TRANSFER', delta: '0.0000', hide: { code: 'TEST-HIDE-1' }, lot: { code: 'TEST-LOT-LEA-1' }, colour: { code: 'BLK' }, postedBy: { audience: 'FLOOR', name: null, device: { name: 'Test tablet' } } })
    expect(JSON.stringify(floor)).not.toContain('Marco Prova')
    expect(moves.find((move: Json) => move.id === moveIds.scrap)).toMatchObject({ delta: '-2.0000', reversedById: moveIds.reversal, note: 'Cracked shell.', postedBy: { audience: 'OFFICE', name: 'Anna Esempio' } })
    expect(moves.find((move: Json) => move.id === moveIds.hide1)).toMatchObject({ reason: 'ADJUSTMENT', from: { kind: 'ADJUSTMENT' }, delta: '53.2000', valuation: { method: 'MANUAL', unitCost: '7.000000', valueAmount: 37_240, currency: 'EUR' } })
  })

  it('answers the balance with one stock key (the running balance), filters by reason, note, reversal and pages', async () => {
    const leather = await ok(`/inventory/ledger?siteId=${ids.siteA1}&itemId=${ids.leather}`)
    expect(leather.closing).toBe('145.0000')
    const bin = await ok(`/inventory/ledger?siteId=${ids.siteA1}&itemId=${ids.lining}&locationId=${ids.bin1}`)
    expect(bin.closing).toBe('20.0000')
    expect(bin.moves.map((move: Json) => [move.reason, move.delta])).toEqual([['TRANSFER', '20.0000']])
    expect((await ok(`/inventory/ledger?reasons=SCRAP`)).moves).toHaveLength(2)
    expect((await ok(`/inventory/ledger?reasons=SCRAP,TRANSFER&reversed=false`)).moves).toHaveLength(2)
    expect((await ok(`/inventory/ledger?reversed=true`)).moves.map((move: Json) => move.id).sort()).toEqual([moveIds.scrap, moveIds.reversal].sort())
    expect((await ok(`/inventory/ledger?hasNote=false`)).moves.map((move: Json) => move.reason).sort()).toEqual(['TRANSFER', 'TRANSFER'])
    expect((await ok(`/inventory/ledger?deviceId=${ids.deviceA1}`)).moves.map((move: Json) => move.id)).toEqual([moveIds.floor])
    expect((await ok(`/inventory/ledger?reasons=SCRAP&itemId=${ids.protector}&siteId=${ids.siteA1}`)).closing).toBeNull()
    expect((await ok(`/inventory/ledger?siteId=${ids.siteA1}&itemId=${ids.protector}&from=2020-01-01T00:00:00.000Z`)).closing).toBe('10.0000')
    expect((await ok(`/inventory/ledger?siteId=${ids.siteA1}&itemId=${ids.protector}&to=2099-01-01T00:00:00.000Z`)).closing).toBeNull()
    expect((await get(`/inventory/ledger?reasons=STOLEN`)).status).toBe(400)
    const first = await ok(`/inventory/ledger?limit=4`)
    const rest = await ok(`/inventory/ledger?limit=10&cursor=${first.nextCursor}`)
    expect(first.moves).toHaveLength(4)
    expect(rest.moves).toHaveLength(5)
    expect(rest.nextCursor).toBeNull()
  })

  it('values only with the cost grain: absent, not blank, without it; another company sees nothing', async () => {
    const plain = await ok(`/inventory/ledger?siteId=${ids.siteA1}`, 'warehouse')
    expect(plain.moves.every((move: Json) => !('valuation' in move))).toBe(true)
    const counts = await ok(`/inventory/ledger/counts?siteId=${ids.siteA1}`, 'warehouse')
    expect(counts).toEqual({ adjustments7d: 5, scraps30d: 1, counts30d: 0, reversals30d: 1 })
    const withCost = await ok(`/inventory/ledger/counts?siteId=${ids.siteA1}`)
    // Hide 3 came in at the standard cost (valued); nothing is left unvalued but nothing either: all office moves.
    expect(withCost).toMatchObject({ adjustments7d: 5, scraps30d: 1, reversals30d: 1, unvalued: 0 })
    expect((await ok(`/inventory/ledger`, 'company-two')).moves).toEqual([])
    expect((await get(`/inventory/ledger`, 'floor-a1')).status).toBe(403)
  })

  it('one move: its key, its reversal both ways, and the worker only where the site records workers', async () => {
    const floor = await ok(`/inventory/ledger/${moveIds.floor}`, 'warehouse')
    expect(floor.move).toMatchObject({ id: moveIds.floor, worker: 'Marco Prova', stationOnly: false, postedBy: { audience: 'FLOOR', name: null } })
    expect(floor.move.idempotencyKey).toMatch(/^inventory\.transfer:/)
    const scrap = await ok(`/inventory/ledger/${moveIds.scrap}`)
    expect(scrap.reversal).toMatchObject({ id: moveIds.reversal })
    expect(scrap.original).toBeNull()
    expect((await ok(`/inventory/ledger/${moveIds.reversal}`)).original).toMatchObject({ id: moveIds.scrap })
    // The site records stations only: the same record names no worker.
    await f.admin(`INSERT INTO "ProductionSettings" (id, "tenantId", "companyId", "siteId", "scanSubject") VALUES ($1, $2, $3, $1, 'STATION')`, [ids.siteA1, ids.tenantA, ids.companyA])
    const station = await ok(`/inventory/ledger/${moveIds.floor}`, 'warehouse')
    expect(station.move).toMatchObject({ worker: null, stationOnly: true })
    expect((await get(`/inventory/ledger/${moveIds.floor}`, 'company-two')).status).toBe(404)
  })
})

describe('why is it this number (SCM-191; design mv-why)', () => {
  it('sums the moves of one stock key by reason and says the sum adds up to the balance', async () => {
    const lining = await ok(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.lining}`)
    expect(lining).toMatchObject({ onHand: '120.0000', sum: '120.0000', addsUp: true, gap: '0.0000', moves: 2, lot: null, location: null, item: { code: 'TEST-LINING' } })
    expect(lining.byReason).toEqual([
      { reason: 'TRANSFER', in: '20.0000', out: '20.0000', net: '0.0000', moves: 1 },
      { reason: 'ADJUSTMENT', in: '120.0000', out: '0.0000', net: '120.0000', moves: 1 },
    ])
    const bin = await ok(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.lining}&locationId=${ids.bin1}`)
    expect(bin).toMatchObject({ onHand: '20.0000', sum: '20.0000', addsUp: true, location: { code: 'A1-BIN-01' } })
    const protector = await ok(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.protector}`)
    expect(protector.byReason).toEqual([
      { reason: 'ADJUSTMENT', in: '10.0000', out: '0.0000', net: '10.0000', moves: 1 },
      { reason: 'SCRAP', in: '2.0000', out: '2.0000', net: '0.0000', moves: 2 },
    ])
    expect(protector.onHand).toBe('10.0000')
    const hide = await ok(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.leather}&hideId=${ids.hide1}&locationId=${ids.cut}`)
    expect(hide).toMatchObject({ onHand: '53.2000', hide: { code: 'TEST-HIDE-1' }, byReason: [{ reason: 'TRANSFER', in: '53.2000', out: '0.0000', net: '53.2000', moves: 1 }] })
    expect((await get(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.lining}`, 'company-two')).status).toBe(404)
    expect((await get(`/inventory/stock/explain?siteId=${ids.siteA1}&itemId=${ids.lining}&locationId=${ids.storeA2}`)).status).toBe(404)
  })
})
