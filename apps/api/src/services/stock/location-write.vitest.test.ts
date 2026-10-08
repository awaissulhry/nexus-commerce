/**
 * Step 2 "Sells from" — switching a stock location on or off (`updateStockLocation`, `deactivateStockLocation`).
 *
 * A switched-off warehouse feeds no listing (loadSyncLedgers), so: a location that still holds units (on hand, or held
 * for an order) is never switched off — its markets would lose that stock while showing a number nothing re-sends —
 * and every switch on or off re-works the quantities of the products stocked there, in the background. A rename re-works
 * nothing. The built-in refusals are unchanged. Real SQL (PGlite with the production schema).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const stand = vi.hoisted(() => ({ recascaded: [] as Array<{ productIds: string[]; actor: string }> }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../stock-movement.service.js', () => ({
  recascadeAfterSyncControlChange: vi.fn(async (productIds: string[], actor: string) => {
    stand.recascaded.push({ productIds: [...productIds].sort(), actor })
    return { ok: productIds.length, noLedger: 0, failed: 0, heldPricesSent: 0 }
  }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const ids: Record<string, string> = {}
const isActive = async (id: string) => (await inside(() => db().stockLocation.findUniqueOrThrow({ where: { id } }))).isActive

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    ids.main = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'IT-MAIN', name: 'Main' } })).id
    ids.full = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-LW-FULL', name: 'Holds units' } })).id
    ids.held = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-LW-HELD', name: 'Holds an order hold' } })).id
    ids.empty = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-LW-EMPTY', name: 'Counted out' } })).id
    ids.a = (await c.product.create({ data: { sku: 'TEST-SKU-LW-A', name: 'A', basePrice: '10.00' } })).id
    ids.b = (await c.product.create({ data: { sku: 'TEST-SKU-LW-B', name: 'B', basePrice: '10.00' } })).id
    await c.stockLevel.create({ data: { productId: ids.a, locationId: ids.full, quantity: 3, reserved: 0, available: 3 } })
    await c.stockLevel.create({ data: { productId: ids.a, locationId: ids.held, quantity: 0, reserved: 0, available: 0 } })
    await c.stockLevel.create({ data: { productId: ids.a, locationId: ids.empty, quantity: 0, reserved: 0, available: 0 } })
    await c.stockLevel.create({ data: { productId: ids.b, locationId: ids.empty, quantity: 0, reserved: 0, available: 0 } })
  })
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 60_000)

beforeEach(() => {
  stand.recascaded = []
})

describe('Step 2 — switching a location on or off', () => {
  it('a location that still holds units is not switched off, by PATCH or DELETE: 409, nothing changed, nothing re-pushed', async () => {
    const { deactivateStockLocation, updateStockLocation } = await import('./location-write.service.js')
    await expect(inside(() => updateStockLocation(ids.full, { isActive: false }))).rejects.toMatchObject({
      status: 409, message: 'TEST-LW-FULL still holds 3 units: move or count them out first. A location is switched off only at 0.',
    })
    await expect(inside(() => deactivateStockLocation(ids.full))).rejects.toMatchObject({ status: 409 })
    expect(await isActive(ids.full)).toBe(true)
    expect(stand.recascaded).toEqual([])
  })

  it('a unit held for an order counts as held: refused too', async () => {
    const { deactivateStockLocation } = await import('./location-write.service.js')
    // A data shape the CHECK allows only with quantity ≥ reserved: put one unit on hand and hold it.
    await inside(() => db().stockLevel.updateMany({ where: { locationId: ids.held }, data: { quantity: 1, reserved: 1, available: 0 } }))
    await expect(inside(() => deactivateStockLocation(ids.held))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('TEST-LW-HELD still holds 1 units') })
    expect(await isActive(ids.held)).toBe(true)
  })

  it('a counted-out location is switched off, and the products stocked there are re-worked', async () => {
    const { updateStockLocation } = await import('./location-write.service.js')
    await inside(() => updateStockLocation(ids.empty, { isActive: false }, 'person:test'))
    expect(await isActive(ids.empty)).toBe(false)
    await vi.waitFor(() => expect(stand.recascaded).toEqual([{ productIds: [ids.a, ids.b].sort(), actor: 'person:test' }]))
  })

  it('switching it back on re-works them again; a rename, or "on" when already on, re-works nothing', async () => {
    const { updateStockLocation } = await import('./location-write.service.js')
    await inside(() => updateStockLocation(ids.empty, { isActive: true }))
    expect(await isActive(ids.empty)).toBe(true)
    await vi.waitFor(() => expect(stand.recascaded).toEqual([{ productIds: [ids.a, ids.b].sort(), actor: 'stock-location' }]))
    stand.recascaded = []
    await inside(() => updateStockLocation(ids.empty, { name: 'Renamed', isActive: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stand.recascaded).toEqual([])
  })

  it('DELETE switches a counted-out location off and re-works its products; a second DELETE is a no-op', async () => {
    const { deactivateStockLocation } = await import('./location-write.service.js')
    await inside(() => deactivateStockLocation(ids.empty))
    expect(await isActive(ids.empty)).toBe(false)
    await vi.waitFor(() => expect(stand.recascaded).toHaveLength(1))
    stand.recascaded = []
    await inside(() => deactivateStockLocation(ids.empty))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stand.recascaded).toEqual([])
  })

  it('the built-in refusals are unchanged', async () => {
    const { deactivateStockLocation, updateStockLocation } = await import('./location-write.service.js')
    await expect(inside(() => updateStockLocation(ids.main, { isActive: false }))).rejects.toMatchObject({ status: 409, message: 'Choose another default warehouse before deactivating this location.' })
    await expect(inside(() => deactivateStockLocation(ids.main))).rejects.toMatchObject({ status: 409, message: 'Built-in location IT-MAIN cannot be deactivated here' })
  })
})
