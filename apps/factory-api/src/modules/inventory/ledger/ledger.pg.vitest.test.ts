import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { command } from '../../../core/command'
import { lockStock, postMoves } from './post-moves'
import { startInventoryFixture, type InventoryFixture } from './testing/fixture'
import { floorMoveValuationHandler } from './valuation'

/**
 * The stock ledger on the local stack (B-W1-22; SCM-189, SCM-192, SCM-193, SCM-194): adjustments, transfers, scraps,
 * reversals and counts through the app's routes and postMoves, the floor at its own site without costs, the values
 * with the cost grain only, the worker's valuation of a floor move, idempotent repeats and the tenant wall. Run with
 * `node scripts/factory/run-pg-tests.mjs inventory`.
 */

type Json = Record<string, any>
let f: InventoryFixture
let ids: InventoryFixture['ids']
let serial = 0
const key = () => `test-${Date.now()}-${++serial}-${newId().slice(-8)}`

const onHand = async (locationId: string, itemId: string, extra: { lotId?: string; hideId?: string } = {}): Promise<string> => {
  const rows = await f.admin<{ q: string }>(
    `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::numeric(18,4)::text AS q
       FROM "StockMove" WHERE ("toLocationId" = $1 OR "fromLocationId" = $1) AND "itemId" = $2
        AND "lotId" IS NOT DISTINCT FROM $3::uuid AND "hideId" IS NOT DISTINCT FROM $4::uuid`,
    [locationId, itemId, extra.lotId ?? null, extra.hideId ?? null],
  )
  return rows[0]!.q
}
const valuationOf = async (moveId: string) => (await f.admin('SELECT method, quantity::text, "unitCost"::text, "valueAmount", "createdById" FROM "StockValuation" WHERE "moveId" = $1', [moveId]))[0]
const eventOf = async (moveId: string) => (await f.admin('SELECT id, payload, "siteId", "companyId" FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['inventory.moved', moveId]))[0]

async function adjust(body: Json, session = 'manager', idempotencyKey = key()) {
  const response = await f.call(session, 'POST', '/inventory/adjustments', { siteId: ids.siteA1, note: 'Opening count for the test.', ...body }, idempotencyKey)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().move as Json
}

beforeAll(async () => {
  f = await startInventoryFixture('ledger')
  ids = f.ids
}, 60_000)

afterAll(async () => {
  await f?.close()
}, 60_000)

describe('adjustments (SCM-192)', () => {
  it('posts a correction with its reason, its audit row, its event and its value at the standard cost', async () => {
    const move = await adjust({ itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '10' })
    expect(move).toMatchObject({ reason: 'ADJUSTMENT', toLocationId: ids.store, fromLocationId: null, quantity: '10.0000', uom: 'PCS', baseQuantity: '10.0000', note: 'Opening count for the test.', valued: true })
    expect(await onHand(ids.store, ids.protector)).toBe('10.0000')
    expect(await valuationOf(move.id)).toMatchObject({ method: 'STANDARD_COST', quantity: '10.0000', unitCost: '4.000000', valueAmount: 4000, createdById: ids.user })
    const audit = await f.admin('SELECT action, "recordType", audience, reason FROM "AuditLog" WHERE "recordId" = $1', [move.id])
    expect(audit).toEqual([{ action: 'inventory.move', recordType: 'StockMove', audience: 'OFFICE', reason: 'Opening count for the test.' }])
    expect((await eventOf(move.id))?.payload).toMatchObject({ moveId: move.id, reason: 'ADJUSTMENT', postedBy: 'OFFICE', changesValue: true, valued: true, baseQuantity: '10.0000' })
    // The value's audit row keeps the cost marked with its grain.
    const valueAudit = await f.admin(`SELECT after FROM "AuditLog" WHERE action = 'inventory.value' AND after->>'moveId' = $1`, [move.id])
    expect(valueAudit[0]!.after).toMatchObject({ method: 'STANDARD_COST', unitCost: { $money: 'cost', value: '4.000000' }, valueAmount: { $money: 'cost', value: 4000 } })
  })

  it('says why, names the lot and hide as the item is tracked, and refuses a cost without the grain', async () => {
    const noReason = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: ' ' })
    expect(noReason.statusCode).toBe(400)
    const noLot = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.lining, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x' })
    expect(noLot.statusCode).toBe(400)
    expect(noLot.json().error.issues).toEqual([{ path: 'body/lotId', message: 'The item is tracked by LOT: name the lot.' }])
    const otherSite = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.storeA2, direction: 'IN', quantity: '1', note: 'x' })
    expect(otherSite.json().error.issues).toEqual([{ path: 'body/toLocationId', message: 'Not a location of this site.' }])
    const cost = await f.call('warehouse', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x', unitCost: '1.000000' })
    expect(cost.statusCode).toBe(403)
    expect((await f.call('viewer', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x' })).statusCode).toBe(403)
    expect((await f.call('company-two', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x' })).statusCode).toBe(403)
  })

  it('a hide alone names its lot and colour; a typed cost values it MANUAL; an untracked item without a cost stays unvalued', async () => {
    const hide = await adjust({ itemId: ids.leather, hideId: ids.hide1, locationId: ids.store, direction: 'IN', quantity: '53.2', unitCost: '7.000000' })
    expect(hide).toMatchObject({ lotId: ids.leatherLot, itemColourId: ids.leatherBlack, hideId: ids.hide1 })
    expect(await valuationOf(hide.id)).toMatchObject({ method: 'MANUAL', unitCost: '7.000000', valueAmount: 37_240 })
    const thread = await adjust({ itemId: ids.thread, locationId: ids.store, direction: 'IN', quantity: '4' })
    expect(thread.valued).toBe(false)
    expect(await valuationOf(thread.id)).toBeUndefined()
  })
})

describe('units (the product units module)', () => {
  it('ft² → m²: a quantity in another unit of the base unit’s dimension gets its base quantity computed; a wrong one is refused', async () => {
    const fabric = await adjust({ itemId: ids.fabric, locationId: ids.store, direction: 'IN', quantity: '10', uom: 'FT2' })
    expect(fabric).toMatchObject({ quantity: '10.0000', uom: 'FT2', baseQuantity: '0.9290' })
    expect(await onHand(ids.store, ids.fabric)).toBe('0.9290')
    // Valued per base unit (m²): 0.9290 × 12.00 = 11.148 → 11.15.
    expect(await valuationOf(fabric.id)).toMatchObject({ quantity: '0.9290', unitCost: '12.000000', valueAmount: 1115 })
    const same = await adjust({ itemId: ids.fabric, locationId: ids.store, direction: 'IN', quantity: '10', uom: 'FT2', baseQuantity: '0.929' })
    expect(same.baseQuantity).toBe('0.9290')
    const wrong = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.fabric, locationId: ids.store, direction: 'IN', quantity: '10', uom: 'FT2', baseQuantity: '1', note: 'x' }, key())
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues).toEqual([{ path: 'body/baseQuantity', message: '10.0000 FT2 is 0.9290 M2; the base quantity sent (1) does not match it.' }])
  })

  it('a hide counted as one HIDE needs its measured area; a unit the item cannot convert is refused', async () => {
    const hide = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.leather, hideId: ids.hide3, locationId: ids.store, direction: 'IN', quantity: '1', uom: 'HIDE', note: 'x' }, key())
    expect(hide.statusCode).toBe(400)
    expect(hide.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/baseQuantity'])
    const kilos = await f.call('manager', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.leather, hideId: ids.hide3, locationId: ids.store, direction: 'IN', quantity: '1', uom: 'KG', note: 'x' }, key())
    expect(kilos.json().error.issues).toEqual([{ path: 'body/uom', message: 'This item does not convert KG to its base unit FT2; use M2, DM2, FT2.' }])
  })
})

describe('never below zero (SCM-194)', () => {
  it('answers a clear 409 before the database, and the database refuses a direct insert too', async () => {
    const before = await onHand(ids.store, ids.protector)
    const response = await f.call('manager', 'POST', '/inventory/scraps', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.store, quantity: '1000', note: 'Damaged.' })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.message).toBe(`Location A1-STORE holds ${before} PCS of TEST-PROTECTOR; the move takes 1000.0000. Stock never goes below zero.`)
    expect(response.json().error.issues).toEqual([{ path: 'body/quantity', message: response.json().error.message }])

    const office = { audience: 'office' as const, tenantId: ids.tenantA, actorId: ids.user }
    await expect(
      f.database.withScope(office, (client) =>
        client.stockMove.create({
          data: { id: newId(), companyId: ids.companyA, siteId: ids.siteA1, reason: 'SCRAP', itemId: ids.protector, fromLocationId: ids.store, quantity: '1000', uom: 'PCS', baseQuantity: '1000', note: 'x', idempotencyKey: key(), occurredAt: new Date() },
          select: { id: true },
        }),
      ),
    ).rejects.toThrow()
    expect(await onHand(ids.store, ids.protector)).toBe(before)
  })

  it('two scans of the same hide at once: one moves it, the other is refused with a 409 (the stock lock, then the balance)', async () => {
    // Another session holds the hide's stock lock until both requests wait for it, so they truly overlap: the second
    // reads the balance only after the first committed (without postMoves' own lock it would read it before, pass,
    // and meet the trigger's refusal instead: a 500).
    const hideAtStore = { siteId: ids.siteA1, locationId: ids.store, itemId: ids.leather, itemColourId: ids.leatherBlack, lotId: ids.leatherLot, hideId: ids.hide1 }
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const office = { audience: 'office' as const, tenantId: ids.tenantA, actorId: ids.user }
    const holder = f.database.withScope(office, (client) =>
      client.$transaction(async (tx) => {
        await lockStock(tx, ids.tenantA, [hideAtStore])
        locked()
        await released
      }, { timeout: 20_000 }),
    )
    await holding
    const transfer = (to: string) =>
      f.call('floor-a1', 'POST', '/inventory/transfers', { itemId: ids.leather, hideId: ids.hide1, fromLocationId: ids.store, toLocationId: to, quantity: '53.2' }, key())
    const results = Promise.all([transfer(ids.cut), transfer(ids.bin1)])
    const waiting = async () =>
      (await f.admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
    for (let tries = 0; (await waiting()) < 2; tries++) {
      if (tries > 250) throw new Error('the two requests never waited for the stock lock')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    release()
    await holder
    const responses = await results
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(responses.find((response) => response.statusCode === 409)!.json().error.message).toBe('Location A1-STORE holds 0.0000 FT2 of TEST-LEATHER, lot TEST-LOT-LEA-1, hide TEST-HIDE-1; the move takes 53.2000. Stock never goes below zero.')
    expect(await onHand(ids.store, ids.leather, { lotId: ids.leatherLot, hideId: ids.hide1 })).toBe('0.0000')
  })
})

describe('transfers: office and the floor at its own site (A1 §2.2, §2.6)', () => {
  it('a floor device moves stock at its own site, with an Idempotency-Key, and never receives a cost', async () => {
    await adjust({ itemId: ids.lining, lotId: ids.liningLot, locationId: ids.store, direction: 'IN', quantity: '120' })
    const body = { itemId: ids.lining, lotId: ids.liningLot, fromLocationId: ids.store, toLocationId: ids.bin2, quantity: '20', occurredAt: '2026-10-28T08:15:00.000+01:00' }
    expect((await f.call('floor-a1', 'POST', '/inventory/transfers', body)).statusCode).toBe(400)
    const response = await f.call('floor-a1', 'POST', '/inventory/transfers', body, key())
    expect(response.statusCode, response.body).toBe(201)
    expect(response.body).not.toMatch(/cost|amount|value"|price/i)
    const move = response.json().move
    expect(move).toMatchObject({ reason: 'TRANSFER', siteId: ids.siteA1, itemColourId: ids.liningGrey, occurredAt: '2026-10-28T07:15:00.000Z', valued: false })
    const row = (await f.admin('SELECT "createdById", "deviceId" FROM "StockMove" WHERE id = $1', [move.id]))[0]
    expect(row).toEqual({ createdById: ids.worker, deviceId: ids.deviceA1 })
    expect((await eventOf(move.id))?.payload).toMatchObject({ postedBy: 'FLOOR', changesValue: false, valued: false })
    expect(await onHand(ids.bin2, ids.lining, { lotId: ids.liningLot })).toBe('20.0000')
    const audit = await f.admin('SELECT audience, "siteId", "deviceId" FROM "AuditLog" WHERE "recordId" = $1', [move.id])
    expect(audit).toEqual([{ audience: 'FLOOR', siteId: ids.siteA1, deviceId: ids.deviceA1 }])
  })

  it('a floor device reaches no other site, and no office read', async () => {
    const elsewhere = await f.call('floor-a1', 'POST', '/inventory/transfers', { siteId: ids.siteA2, itemId: ids.protector, fromLocationId: ids.storeA2, toLocationId: ids.storeA2, quantity: '1' }, key())
    expect(elsewhere.statusCode).toBe(404)
    const otherLocations = await f.call('floor-a2', 'POST', '/inventory/transfers', { itemId: ids.protector, fromLocationId: ids.store, toLocationId: ids.bin1, quantity: '1' }, key())
    expect(otherLocations.statusCode).toBe(400)
    expect(otherLocations.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/fromLocationId', 'body/toLocationId'])
    expect((await f.call('floor-a1', 'GET', '/inventory/moves')).statusCode).toBe(403)
    expect((await f.call('floor-a1', 'POST', '/inventory/scraps', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.store, quantity: '1', note: 'x' }, key())).statusCode).toBe(403)
  })

  it('a transfer moves no value; the site total stays', async () => {
    const response = await f.call('manager', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.store, toLocationId: ids.bin1, quantity: '3' }, key())
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().move.valued).toBe(false)
    expect(await valuationOf(response.json().move.id)).toBeUndefined()
    expect(await onHand(ids.bin1, ids.protector)).toBe('3.0000')
  })

  it('an archived location takes no stock', async () => {
    const archived = newId()
    await f.admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind, status) VALUES ($1, $2, $3, $4, 'A1-OLD', 'Old', 'BIN', 'ARCHIVED')`, [archived, ids.tenantA, ids.companyA, ids.siteA1])
    const response = await f.call('manager', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.store, toLocationId: archived, quantity: '1' }, key())
    expect(response.statusCode).toBe(400)
    expect(response.json().error.issues).toEqual([{ path: 'body/toLocationId', message: 'Location A1-OLD is archived; it takes no stock.' }])
  })
})

describe('scraps and reversals', () => {
  it('a scrap of a lot leaves at the lot’s cost; its reversal mirrors it and its value; one reversal per move', async () => {
    const scrap = await f.call('manager', 'POST', '/inventory/scraps', { siteId: ids.siteA1, itemId: ids.leather, hideId: ids.hide2, fromLocationId: ids.store, quantity: '1', note: 'Cut wrong.' }, key())
    expect(scrap.statusCode).toBe(409)
    await adjust({ itemId: ids.leather, hideId: ids.hide2, locationId: ids.store, direction: 'IN', quantity: '51.8', unitCost: '8.000000' })
    const scrapped = await f.call('manager', 'POST', '/inventory/scraps', { siteId: ids.siteA1, itemId: ids.leather, hideId: ids.hide2, fromLocationId: ids.store, quantity: '10.5', note: 'Scar near the neck.' }, key())
    expect(scrapped.statusCode, scrapped.body).toBe(201)
    const move = scrapped.json().move
    // The lot came in at 7 (hide 1: 53.2) and 8 (hide 2: 51.8): its moving average.
    expect(await valuationOf(move.id)).toMatchObject({ method: 'LOT_COST', quantity: '-10.5000', unitCost: '7.493333', valueAmount: -7868 })

    // Another company's person does not find it; one without the permission is refused.
    expect((await f.call('company-two', 'POST', `/inventory/moves/${move.id}/reverse`, { note: 'x' }, key())).statusCode).toBe(404)
    expect((await f.call('viewer', 'POST', `/inventory/moves/${move.id}/reverse`, { note: 'x' }, key())).statusCode).toBe(403)
    const reversed = await f.call('manager', 'POST', `/inventory/moves/${move.id}/reverse`, { note: 'Not scrapped after all.' }, key())
    expect(reversed.statusCode, reversed.body).toBe(201)
    const reversal = reversed.json().move
    expect(reversal).toMatchObject({ reason: 'SCRAP', reversalOfId: move.id, fromLocationId: null, toLocationId: ids.store, baseQuantity: '10.5000' })
    expect(await valuationOf(reversal.id)).toMatchObject({ method: 'LOT_COST', quantity: '10.5000', unitCost: '7.493333', valueAmount: 7868 })
    expect(await onHand(ids.store, ids.leather, { lotId: ids.leatherLot, hideId: ids.hide2 })).toBe('51.8000')

    const again = await f.call('manager', 'POST', `/inventory/moves/${move.id}/reverse`, { note: 'Twice.' }, key())
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toBe('This move was reversed already; a move has at most one reversal.')
    const ofReversal = await f.call('manager', 'POST', `/inventory/moves/${reversal.id}/reverse`, { note: 'Back.' }, key())
    expect(ofReversal.json().error.message).toBe('This move is itself a reversal; it is not reversed (post the move again instead).')
    expect((await f.call('manager', 'POST', `/inventory/moves/${newId()}/reverse`, { note: 'x' }, key())).statusCode).toBe(404)
  })

  it('reversing stock that came in and is gone again is refused', async () => {
    const found = await adjust({ itemId: ids.protector, locationId: ids.bin2, direction: 'IN', quantity: '2' })
    await f.call('manager', 'POST', '/inventory/transfers', { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.bin2, toLocationId: ids.cut, quantity: '2' }, key())
    const response = await f.call('manager', 'POST', `/inventory/moves/${found.id}/reverse`, { note: 'Found by mistake.' }, key())
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('conflict')
  })
})

describe('idempotent repeats (PLT-189)', () => {
  it('the same key and request posts once and answers the same; another request with it is refused', async () => {
    const idempotencyKey = key()
    const body = { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.cut, direction: 'IN', quantity: '1', note: 'Found under the table.' }
    const first = await f.call('manager', 'POST', '/inventory/adjustments', body, idempotencyKey)
    const second = await f.call('manager', 'POST', '/inventory/adjustments', body, idempotencyKey)
    expect(second.statusCode).toBe(201)
    expect(second.json()).toEqual(first.json())
    expect((await f.admin('SELECT count(*)::int AS n FROM "StockMove" WHERE "idempotencyKey" = $1', [`inventory.adjust:${idempotencyKey}:1`]))[0]!.n).toBe(1)
    expect((await f.call('manager', 'POST', '/inventory/adjustments', { ...body, quantity: '2' }, idempotencyKey)).statusCode).toBe(409)
  })
})

describe('the floor’s moves are valued by the worker (A1 §2.6)', () => {
  it('a floor move that enters the site’s stock is valued once, by the system, at the lot’s cost; an office move is left alone', async () => {
    // What a floor receipt or return (B-W1-33, B-W1-39) does: postMoves in a floor command.
    const floor = f.caller('floor-a1')
    const { result } = await command(floor, { name: 'test.floorFound', idempotencyKey: key(), input: {} }, (tools) =>
      postMoves(tools, [{ siteId: ids.siteA1, reason: 'ADJUSTMENT', itemId: ids.lining, lotId: ids.liningLot, toLocationId: ids.cut, quantity: '5', note: 'Found at the cutting table.' }]),
    )
    const move = result[0]!
    expect(move.valued).toBe(false)
    expect(await valuationOf(move.id)).toBeUndefined()
    const event = (await eventOf(move.id))!
    expect(event.payload).toMatchObject({ postedBy: 'FLOOR', changesValue: true, valued: false })

    const handler = floorMoveValuationHandler()
    const envelope = { eventId: event.id, payload: event.payload } as EventEnvelope
    await handler.handle(envelope, { caller: f.system(), attempt: 1 })
    await handler.handle(envelope, { caller: f.system(), attempt: 2 })
    const rows = await f.admin('SELECT method, "unitCost"::text, "valueAmount", "createdById" FROM "StockValuation" WHERE "moveId" = $1', [move.id])
    // The lining lot came in valued at its standard cost (3.10) by the office adjustment above.
    expect(rows).toEqual([{ method: 'LOT_COST', unitCost: '3.100000', valueAmount: 1550, createdById: null }])
    const audit = await f.admin(`SELECT audience FROM "AuditLog" WHERE action = 'inventory.value' AND after->>'moveId' = $1`, [move.id])
    expect(audit).toEqual([{ audience: 'SYSTEM' }])

    const office = await adjust({ itemId: ids.protector, locationId: ids.cut, direction: 'IN', quantity: '1' })
    await handler.handle({ eventId: (await eventOf(office.id))!.id, payload: (await eventOf(office.id))!.payload } as EventEnvelope, { caller: f.system(), attempt: 1 })
    expect((await f.admin('SELECT count(*)::int AS n FROM "StockValuation" WHERE "moveId" = $1', [office.id]))[0]!.n).toBe(1)
  })

  it('the floor never writes or reads a value, and never sets a cost', async () => {
    const floor = f.caller('floor-a1')
    await expect(
      command(floor, { name: 'test.floorCost', idempotencyKey: key(), input: {} }, (tools) =>
        postMoves(tools, [{ siteId: ids.siteA1, reason: 'ADJUSTMENT', itemId: ids.protector, toLocationId: ids.cut, quantity: '1', note: 'x', cost: { method: 'MANUAL', unitCost: '1' } }]),
      ),
    ).rejects.toThrow(/never sets a cost/)
    await expect(f.database.withScope({ audience: 'floor', tenantId: ids.tenantA, actorId: ids.worker, siteId: ids.siteA1 }, (client) => client.stockValuation.findMany({ select: { id: true } }))).rejects.toThrow(/permission denied/)
    await expect(f.database.withScope({ audience: 'floor', tenantId: ids.tenantA, actorId: ids.worker, siteId: ids.siteA1 }, (client) => client.item.findMany({ select: { standardCost: true } }))).rejects.toThrow(/permission denied/)
  })
})

describe('counts (PLAN §2.8: the year-end count)', () => {
  it('posts each difference as a COUNT move with the count’s reason; a line that agrees posts nothing', async () => {
    const fresh = newId()
    await f.admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'A1-BIN-09', 'Count bin', 'BIN')`, [fresh, ids.tenantA, ids.companyA, ids.siteA1])
    await adjust({ itemId: ids.protector, locationId: fresh, direction: 'IN', quantity: '7' })
    await adjust({ itemId: ids.lining, lotId: ids.liningLot, locationId: fresh, direction: 'IN', quantity: '12.5' })
    const response = await f.call(
      'manager',
      'POST',
      '/inventory/counts',
      {
        siteId: ids.siteA1,
        locationId: fresh,
        note: 'Year-end count 2026, sheet 4.',
        reference: 'COUNT-2026-04',
        lines: [
          { itemId: ids.protector, counted: '8' },
          { itemId: ids.lining, lotId: ids.liningLot, counted: '12' },
          { itemId: ids.thread, counted: '0' },
        ],
      },
      key(),
    )
    expect(response.statusCode, response.body).toBe(201)
    const body = response.json()
    expect(body.differences).toEqual([
      expect.objectContaining({ itemId: ids.protector, system: '7.0000', counted: '8.0000', difference: '1.0000', moveId: body.moves[0].id }),
      expect.objectContaining({ itemId: ids.lining, lotId: ids.liningLot, itemColourId: ids.liningGrey, system: '12.5000', counted: '12.0000', difference: '-0.5000', moveId: body.moves[1].id }),
      expect.objectContaining({ itemId: ids.thread, system: '0.0000', counted: '0.0000', difference: '0.0000', moveId: null }),
    ])
    expect(body.moves).toEqual([
      expect.objectContaining({ reason: 'COUNT', fromLocationId: null, toLocationId: fresh, baseQuantity: '1.0000', note: 'Year-end count 2026, sheet 4.', reference: 'COUNT-2026-04', valued: true }),
      expect.objectContaining({ reason: 'COUNT', fromLocationId: fresh, toLocationId: null, baseQuantity: '0.5000', lotId: ids.liningLot }),
    ])
    expect(await onHand(fresh, ids.protector)).toBe('8.0000')
    expect(await onHand(fresh, ids.lining, { lotId: ids.liningLot })).toBe('12.0000')

    const agrees = await f.call('manager', 'POST', '/inventory/counts', { siteId: ids.siteA1, locationId: fresh, note: 'Recount.', lines: [{ itemId: ids.protector, counted: '8' }] }, key())
    expect(agrees.statusCode).toBe(201)
    expect(agrees.json().moves).toEqual([])
    const twice = await f.call('manager', 'POST', '/inventory/counts', { siteId: ids.siteA1, locationId: fresh, note: 'x', lines: [{ itemId: ids.protector, counted: '1' }, { itemId: ids.protector, counted: '2' }] }, key())
    expect(twice.statusCode).toBe(400)
    expect((await f.call('manager', 'POST', '/inventory/counts', { siteId: ids.siteA1, locationId: ids.storeA2, note: 'x', lines: [{ itemId: ids.protector, counted: '1' }] }, key())).statusCode).toBe(400)
  })
})

describe('the moves list (SCM-195): values only with the cost grain', () => {
  it('lists newest first with labels, filters and pages; the value only for the cost grain', async () => {
    const withCost = await f.call('manager', 'GET', `/inventory/moves?siteId=${ids.siteA1}&itemId=${ids.protector}&limit=2`)
    expect(withCost.statusCode, withCost.body).toBe(200)
    const page = withCost.json()
    expect(page.moves).toHaveLength(2)
    expect(page.nextCursor).toBe(page.moves[1].id)
    expect(page.moves[0].id > page.moves[1].id).toBe(true)
    expect(page.moves[0].item).toEqual({ id: ids.protector, code: 'TEST-PROTECTOR', name: 'TEST-PROTECTOR', baseUom: 'PCS' })
    const valued = (await f.call('manager', 'GET', `/inventory/moves?reason=ADJUSTMENT&itemId=${ids.protector}&limit=1`)).json().moves[0]
    expect(valued.valuation).toMatchObject({ method: expect.any(String), unitCost: '4.000000', currency: 'EUR' })
    expect(typeof valued.valuation.valueAmount).toBe('number')

    const noCost = await f.call('warehouse', 'GET', `/inventory/moves?reason=ADJUSTMENT&itemId=${ids.protector}&limit=1`)
    expect(noCost.json().moves[0]).not.toHaveProperty('valuation')
    expect(noCost.body).not.toMatch(/unitCost|valueAmount/)
    const next = await f.call('manager', 'GET', `/inventory/moves?siteId=${ids.siteA1}&itemId=${ids.protector}&limit=2&cursor=${page.nextCursor}`)
    expect(next.json().moves[0].id < page.nextCursor).toBe(true)
    expect((await f.call('company-two', 'GET', '/inventory/moves')).json().moves).toEqual([])
  })
})

describe('the tenant wall', () => {
  it('another tenant neither sees nor moves this tenant’s stock', async () => {
    expect((await f.call('manager-b', 'POST', '/inventory/adjustments', { siteId: ids.siteA1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x' }, key())).statusCode).toBe(404)
    const sameSite = await f.call('manager-b', 'POST', '/inventory/adjustments', { siteId: ids.siteB1, itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1', note: 'x' }, key())
    expect(sameSite.statusCode).toBe(400)
    expect(sameSite.json().error.issues).toEqual([{ path: 'body/itemId', message: 'Not an item of the tenant.' }])
    expect((await f.call('manager-b', 'GET', '/inventory/moves')).json().moves).toEqual([])
    const office = { audience: 'office' as const, tenantId: ids.tenantB, actorId: ids.user }
    expect(await f.database.withScope(office, (client) => client.stockMove.count())).toBe(0)
  })
})

describe('a move dated in a month closed for good (a HARD period lock): 409 in words, not a 500 (B-W2a-F1)', () => {
  it("refuses an office transfer dated inside the lock before the database's StockMove_period_lock; the same move dated now posts", async () => {
    const lockId = newId()
    await f.admin(`INSERT INTO "PeriodLock" (id, "tenantId", "companyId", "periodStart", "periodEnd", level, "lockedAt", "lockedById") VALUES ($1, $2, $3, '2026-01-01', '2026-01-31', 'HARD', '2026-02-03T09:00:00Z', $4)`, [
      lockId,
      ids.tenantA,
      ids.companyA,
      ids.user,
    ])
    try {
      await adjust({ itemId: ids.protector, locationId: ids.store, direction: 'IN', quantity: '1' })
      const before = await onHand(ids.store, ids.protector)
      const body = { siteId: ids.siteA1, itemId: ids.protector, fromLocationId: ids.store, toLocationId: ids.bin1, quantity: '1', occurredAt: '2026-01-15T10:00:00.000Z' }
      const response = await f.call('manager', 'POST', '/inventory/transfers', body, key())
      expect(response.statusCode, response.body).toBe(409)
      expect(response.json().error).toMatchObject({
        message:
          'January 2026 is closed for good for Pelli Inventate S.r.l. (a hard lock since 3 Feb 2026): the stock move (transfer) dated 15 Jan 2026 is not posted. ' +
          'Only someone who may lift a hard lock (accounting.unlock: the owner, by default) reopens the month, with a reason, in Finance › Accounting; agree it with the accountant first.',
        issues: [{ path: 'body/occurredAt', message: 'Dated inside a month closed for good.' }],
      })
      expect(await onHand(ids.store, ids.protector)).toBe(before)
      const now = await f.call('manager', 'POST', '/inventory/transfers', { ...body, occurredAt: undefined }, key())
      expect(now.statusCode, now.body).toBe(201)
    } finally {
      await f.admin(`UPDATE "PeriodLock" SET status = 'UNLOCKED', "unlockedAt" = now(), "unlockedById" = $2, "unlockReason" = 'The test is over.', version = version + 1 WHERE id = $1`, [lockId, ids.user])
    }
  })
})
