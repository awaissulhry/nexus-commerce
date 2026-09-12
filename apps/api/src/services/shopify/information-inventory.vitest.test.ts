import { describe, expect, it } from 'vitest'
import { applyInformationInventory } from './information-inventory.js'
import type { NativeEdit } from '@nexus/shared/shopify-information'
const productId = 'gid://shopify/Product/1', ownerId = 'gid://shopify/ProductVariant/2', inventoryItemId = 'gid://shopify/InventoryItem/3'
const baseline = { inventoryItemId, tracked: true, locations: [1, 2].map(n => ({ locationId: `gid://shopify/Location/${n}`, name: `Store ${n}`, active: true, available: 5, onHand: 7 })) }
function setup() {
  const live = structuredClone(baseline), writes: any[] = []
  let failAfterWrite = false
  const gql = async (query: string, vars: any) => {
    if (query.includes('NexusInformationInventory(')) return { nodes: [{ id: ownerId, product: { id: productId }, inventoryItem: { id: inventoryItemId, tracked: live.tracked, inventoryLevels: { nodes: live.locations.map(l => ({ location: { id: l.locationId, name: l.name, isActive: l.active }, quantities: [{ name: 'available', quantity: l.available }, { name: 'on_hand', quantity: l.onHand }] })), pageInfo: { hasNextPage: false } } } }] }
    if (query.includes('NexusInformationSetInventory')) {
      expect(query).toContain('@idempotent(key:$idempotencyKey)'); writes.push(vars)
      for (const q of vars.input.quantities) { const l = live.locations.find(l => l.locationId === q.locationId)!; const key = vars.input.name === 'available' ? 'available' : 'onHand'; expect(l[key]).toBe(q.changeFromQuantity); const delta = q.quantity - l[key]; l.available += delta; l.onHand += delta }
      if (failAfterWrite) { failAfterWrite = false; throw new Error('Connection interrupted after acceptance') }
      return { inventorySetQuantities: { userErrors: [] } }
    }
    throw new Error(query)
  }
  const next = structuredClone(baseline); next.locations[0].available = 0
  const edit: NativeEdit = { productId, ownerId, ownerLabel: 'Variant', field: 'inventory', value: JSON.stringify(baseline), nextValue: JSON.stringify(next) }
  return { gql: gql as any, live, edit, writes, interrupt: () => { failAfterWrite = true } }
}
describe('Inventory narrow CAS writer', () => {
  it('sets zero at the exact location, accepts the related Shopify state change, and preserves another location', async () => {
    const s = setup(); await applyInformationInventory(s.gql, s.edit, 'operation-1')
    expect(s.writes).toHaveLength(1); expect(s.writes[0].input.quantities).toEqual([{ inventoryItemId, locationId: baseline.locations[0].locationId, quantity: 0, changeFromQuantity: 5 }])
    expect(s.live.locations[1]).toEqual(baseline.locations[1]); expect(s.live.locations[0].onHand).toBe(2)
  })
  it('reconciles an interrupted accepted write without submitting it again', async () => {
    const s = setup(); s.interrupt(); await expect(applyInformationInventory(s.gql, s.edit, 'operation-2')).rejects.toThrow('interrupted')
    await applyInformationInventory(s.gql, s.edit, 'operation-2'); expect(s.writes).toHaveLength(1)
  })
  it('rejects stale stock before any mutation and retains the submitted intent', async () => {
    const s = setup(), intent = structuredClone(s.edit); s.live.locations[0].available = 4
    await expect(applyInformationInventory(s.gql, s.edit, 'operation-3')).rejects.toThrow('stock changed')
    expect(s.writes).toEqual([]); expect(s.edit).toEqual(intent)
  })
  it('rejects another product owner or inactive location', async () => {
    const s = setup(); await expect(applyInformationInventory(s.gql, { ...s.edit, productId: 'gid://shopify/Product/99' }, 'op')).rejects.toThrow('owner')
    s.live.locations[0].active = false; await expect(applyInformationInventory(s.gql, s.edit, 'op')).rejects.toThrow('inactive'); expect(s.writes).toEqual([])
  })
})
