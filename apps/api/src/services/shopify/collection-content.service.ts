import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { z } from 'zod'
import { shopifyAdmin, assertShopifyResult as checked } from './admin-client.js'
import { digest, object } from './content-workspace.service.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

const KEY = '_nexusCollectionOrders'
const orderSchema = z.array(z.string().min(1).max(3000)).max(2000)
export async function listContentCollections(accountId: string) {
  const { graphql: gql } = await shopifyAdmin(accountId)
  const collections: { id: string; title: string; handle: string }[] = []; let after: string | null = null
  do {
    const data = await gql(`query NexusCollections($after:String) { collections(first:100,after:$after) { nodes { id title handle } pageInfo { hasNextPage endCursor } } }`, { after })
    collections.push(...data.collections.nodes); after = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null
    if (collections.length > 2000) throw new WorkspaceScopeError('This account exceeds the supported 2,000 collections.', 422)
  } while (after)
  return { collections }
}

export async function readCollectionContent(accountId: string, id: string) {
  if (!/^\d+$/.test(id)) throw new WorkspaceScopeError('Choose a Shopify collection.', 400)
  const { graphql: gql, domain } = await shopifyAdmin(accountId)
  const data = await gql(`query NexusCollection($id:ID!) { collection(id:$id) { id title handle updatedAt sortOrder metafield(namespace:"nexus",key:"card_order") { value compareDigest } products(first:250) { nodes { id title handle status metafield(namespace:"nexus",key:"resolved") { value } } pageInfo { hasNextPage } } } }`, { id: `gid://shopify/Collection/${id}` })
  const collection = data.collection
  if (!collection) throw new WorkspaceScopeError('The collection is unavailable in this Shopify account.', 404)
  if (collection.products.pageInfo.hasNextPage) throw new WorkspaceScopeError('Collection ordering supports up to 250 products. This collection exceeds that limit; no order was changed.', 422)
  // Keep each query below Shopify's single-query cost ceiling. A nested
  // 250-products × 250-variants query is rejected before Shopify executes it.
  for (const product of collection.products.nodes) {
    const result = await gql(`query NexusCollectionVariants($id:ID!) { product(id:$id) { variants(first:250) { nodes { id sku image { url } } pageInfo { hasNextPage } } } }`, { id: product.id })
    if (!result.product || result.product.variants.pageInfo.hasNextPage) throw new WorkspaceScopeError('A collection product changed or exceeds 250 variants. Refresh before arranging it.', 422)
    product.variants = result.product.variants
  }
  const cards = collection.products.nodes.flatMap((product: any) => {
    const manifest = product.metafield?.value ? JSON.parse(product.metafield.value) : null
    const groups = manifest?.managed && manifest?.cards?.length ? manifest.cards : [{ id: 'family', label: '', variantIds: product.variants.nodes.slice(0, 1).map((v: any) => v.id.split('/').at(-1)) }]
    return groups.map((card: any) => {
      const variants = product.variants.nodes.filter((v: any) => card.variantIds.includes(v.id.split('/').at(-1)))
      if (!variants.length) throw new WorkspaceScopeError(`${product.title}: a collection card references missing variants. Synchronise the family first.`, 422)
      return { key: `${product.id.split('/').at(-1)}:${card.id}`, productId: product.id, label: [product.title, card.label].filter(Boolean).join(' · '), image: variants[0]?.image?.url ?? null, skus: variants.map((v: any) => v.sku), variantId: variants[0].id, handle: product.handle }
    })
  }) as { key: string; productId: string; label: string; image: string | null; skus: string[]; variantId: string; handle: string }[]
  if (cards.length > 2000) throw new WorkspaceScopeError('Collection ordering supports up to 2,000 cards. Reduce the collection before arranging it.', 422)
  const connection = await prisma.channelConnection.findUniqueOrThrow({ where: { id: accountId }, select: { id: true, connectionMetadata: true, updatedAt: true } })
  const saved = object(object(connection.connectionMetadata)[KEY])[id]
  const remote = collection.metafield?.value ? JSON.parse(collection.metafield.value) : { version: 1, order: [] }
  const storedOrder: string[] = saved?.order ?? remote.order ?? []
  const keys = new Set(cards.map(c => c.key))
  const order = [...storedOrder.filter(key => keys.has(key)), ...cards.map(c => c.key).filter(key => !storedOrder.includes(key))]
  return { accountId, collectionId: id, title: collection.title, handle: collection.handle, domain, cards, order,
    revision: digest([saved ?? null, cards.map(c => c.key), remote]), remoteRevision: digest(collection), remoteDigest: collection.metafield?.compareDigest ?? null,
    publication: saved?.publication ?? null, connection, remote,
  }
}
export function publicCollection(data: Awaited<ReturnType<typeof readCollectionContent>>) { const { connection, remoteDigest, remote, ...view } = data; return view }

export async function saveCollectionContent(accountId: string, id: string, body: unknown) {
  const input = object(body), order = orderSchema.parse(input.order), current = await readCollectionContent(accountId, id)
  if (input.expectedRevision !== current.revision) throw new WorkspaceScopeError('The collection or its cards changed. Reload the order before saving.')
  if (new Set(order).size !== order.length || order.length !== current.cards.length || order.some(key => !current.cards.some(c => c.key === key))) throw new WorkspaceScopeError('Include each collection card exactly once. Reload after adding or removing products.', 422)
  const metadata = object(current.connection.connectionMetadata), drafts = object(metadata[KEY])
  const result = await prisma.channelConnection.updateMany({ where: { id: accountId, updatedAt: current.connection.updatedAt }, data: { connectionMetadata: { ...metadata, [KEY]: { ...drafts, [id]: { order, publication: drafts[id]?.publication ?? null } } } as Prisma.InputJsonValue } })
  if (result.count !== 1) throw new WorkspaceScopeError('A concurrent account update interrupted this save. Reload before retrying.')
  return publicCollection(await readCollectionContent(accountId, id))
}

export async function synchronizeCollectionContent(accountId: string, id: string, body: unknown) {
  const input = object(body), current = await readCollectionContent(accountId, id)
  if (input.expectedRevision !== current.revision || input.expectedRemoteRevision !== current.remoteRevision) throw new WorkspaceScopeError('The collection changed after review. Refresh the review before synchronising.')
  if (input.confirmCollection !== true) throw new WorkspaceScopeError('Review and approve the collection order before synchronising it.', 422)
  const { graphql: gql } = await shopifyAdmin(accountId)
  const { metafieldDefinitions } = await gql(`query NexusCollectionDefinition { metafieldDefinitions(ownerType:COLLECTION,namespace:"nexus",key:"card_order",first:2) { nodes { type { name } access { storefront } } } }`)
  const existing = metafieldDefinitions.nodes[0]
  if (existing && (existing.type.name !== 'json' || existing.access.storefront !== 'PUBLIC_READ')) throw new WorkspaceScopeError('The collection order definition has an incompatible type or storefront access.', 422)
  if (!existing) checked((await gql(`mutation NexusCollectionDefinitionCreate($definition:MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition:$definition) { userErrors { field message } } }`, { definition: { ownerType: 'COLLECTION', namespace: 'nexus', key: 'card_order', name: 'Nexus collection card order', type: 'json', access: { storefront: 'PUBLIC_READ' } } })).metafieldDefinitionCreate, 'Create collection order definition')
  const value = JSON.stringify({ version: 1, order: current.order })
  checked((await gql(`mutation NexusCollectionOrder($metafields:[MetafieldsSetInput!]!) { metafieldsSet(metafields:$metafields) { userErrors { field message } } }`, { metafields: [{ ownerId: `gid://shopify/Collection/${id}`, namespace: 'nexus', key: 'card_order', type: 'json', value, compareDigest: current.remoteDigest }] })).metafieldsSet, 'Save collection card order')
  const after = await readCollectionContent(accountId, id)
  if (JSON.stringify(after.remote) !== value) throw new WorkspaceScopeError('Shopify collection order readback differs. Refresh before retrying.', 502)
  if (digest(after.order) !== digest(current.order)) throw new WorkspaceScopeError('Shopify saved the reviewed order, but the Nexus draft changed during synchronisation. Reload to review the newer draft.', 409)
  const metadata = object(after.connection.connectionMetadata), drafts = object(metadata[KEY])
  const result = await prisma.channelConnection.updateMany({ where: { id: accountId, updatedAt: after.connection.updatedAt }, data: { connectionMetadata: { ...metadata, [KEY]: { ...drafts, [id]: { order: current.order, publication: { status: 'VERIFIED', verifiedAt: new Date().toISOString(), hash: digest(current.order) } } } } as Prisma.InputJsonValue } })
  if (result.count !== 1) throw new WorkspaceScopeError('Shopify saved the order, but the local checkpoint changed. Reload to reconcile.', 502)
  return publicCollection(await readCollectionContent(accountId, id))
}
