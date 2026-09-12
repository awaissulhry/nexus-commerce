import { createHash } from 'node:crypto'
import { inventoryEditError, type InformationInventory, type NativeEdit } from '@nexus/shared/shopify-information'
import { collectShopifyPages } from './linked-products-gateway.js'
import { assertShopifyResult, type ShopifyGraphql } from './admin-client.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

const levels = 'nodes { location { id name isActive } quantities(names:["available","on_hand"]) { name quantity } } pageInfo { hasNextPage endCursor }'
const value = (item: any, nodes: any[]): InformationInventory => ({ inventoryItemId: item.id, tracked: item.tracked,
  locations: nodes.map(l => ({ locationId: l.location.id, name: l.location.name, active: l.location.isActive,
    available: l.quantities.find((q: any) => q.name === 'available')?.quantity, onHand: l.quantities.find((q: any) => q.name === 'on_hand')?.quantity })).sort((a, b) => a.locationId.localeCompare(b.locationId)),
})
/** Bounded owner batches, independent of visible columns/cells. Follow every location page. */
export async function readInformationInventory(gql: ShopifyGraphql, variantIds: string[]) {
  const result = new Map<string, { productId: string; value: InformationInventory }>()
  const ids = [...new Set(variantIds)]
  for (let offset = 0; offset < ids.length; offset += 10) {
    const batch = ids.slice(offset, offset + 10)
    const { nodes } = await gql(`query NexusInformationInventory($ids:[ID!]!) { nodes(ids:$ids) { ... on ProductVariant {
      id product { id } inventoryItem { id tracked inventoryLevels(first:50) { ${levels} } }
    } } }`, { ids: batch })
    if (!Array.isArray(nodes) || nodes.length !== batch.length || nodes.some((n: any, i: number) => n?.id !== batch[i] || !n.inventoryItem?.inventoryLevels)) throw new WorkspaceScopeError('Inventory is unavailable for a selected variant in this store.', 409)
    for (const node of nodes) {
      const item = node.inventoryItem
      const all = item.inventoryLevels.pageInfo.hasNextPage ? await collectShopifyPages<any>(async after => {
        if (!after) return item.inventoryLevels
        const { inventoryItem } = await gql(`query NexusInformationInventoryPage($id:ID!,$after:String) { inventoryItem(id:$id) { inventoryLevels(first:50,after:$after) { ${levels} } } }`, { id: item.id, after })
        return inventoryItem?.inventoryLevels
      }, 1000) : item.inventoryLevels.nodes
      result.set(node.id, { productId: node.product.id, value: value(item, all) })
    }
  }
  return result
}
/** Shopify 2026-07 uses changeFromQuantity and requires @idempotent. Each operation
 * has a durable key; an interrupted retry cannot repeat a stock adjustment. */
export async function applyInformationInventory(gql: ShopifyGraphql, edit: NativeEdit, operationId: string) {
  const error = inventoryEditError(edit.value, edit.nextValue)
  if (error) throw new WorkspaceScopeError(error, 422)
  const before: InformationInventory = JSON.parse(edit.value!), after: InformationInventory = JSON.parse(edit.nextValue!)
  const current = (await readInformationInventory(gql, [edit.ownerId])).get(edit.ownerId)
  if (current?.productId !== edit.productId || current.value.inventoryItemId !== before.inventoryItemId || !current.value.tracked) throw new WorkspaceScopeError('The inventory owner or tracking changed. Review inventory again.', 409)
  for (const key of ['available', 'onHand'] as const) {
    const changed = after.locations.filter(l => l[key] !== before.locations.find(b => b.locationId === l.locationId)![key])
    const quantities = changed.flatMap(l => {
      const old = before.locations.find(b => b.locationId === l.locationId)!, live = current.value.locations.find(b => b.locationId === l.locationId)
      if (!live?.active) throw new WorkspaceScopeError('A stocking location is unavailable or inactive.', 409)
      if (live[key] === l[key]) return []
      if (live[key] !== old[key]) throw new WorkspaceScopeError(`${l.name}: stock changed in Shopify. Review the current quantity.`, 409)
      return [{ inventoryItemId: before.inventoryItemId, locationId: l.locationId, quantity: l[key], changeFromQuantity: old[key] }]
    })
    for (let offset = 0; offset < quantities.length; offset += 250) {
      const batch = quantities.slice(offset, offset + 250)
      const idempotencyKey = createHash('sha256').update(JSON.stringify([operationId, edit.ownerId, key, batch])).digest('hex')
      assertShopifyResult((await gql(`mutation NexusInformationSetInventory($input:InventorySetQuantitiesInput!,$idempotencyKey:String!) {
        inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey) { userErrors { field message } }
      }`, { input: { name: key === 'onHand' ? 'on_hand' : 'available', reason: 'correction', referenceDocumentUri: `nexus://shopify-information/${operationId}`, quantities: batch }, idempotencyKey })).inventorySetQuantities, 'Set Shopify inventory')
    }
  }
  const verified = (await readInformationInventory(gql, [edit.ownerId])).get(edit.ownerId)?.value
  for (const location of after.locations) for (const key of ['available', 'onHand'] as const) {
    if (before.locations.find(l => l.locationId === location.locationId)![key] !== location[key] && verified?.locations.find(l => l.locationId === location.locationId)?.[key] !== location[key]) throw new WorkspaceScopeError('Shopify has not confirmed the requested stock. The saved intent is retained.', 502)
  }
}
