import prisma from '../../../db.js'
import { resolveBatch } from './resolve-batch.service.js'
import { loadAmazonSpec } from '../channel-specs/index.js'
import { attributesFromCells } from './schema-requirements.js'
import { valuesEqual } from '../resolver-shadow.js'
import { primaryConnectionIds } from '../../connection-resolver.service.js'

/** Revalidate queued mapping values at dispatch. A stale proposal cannot overwrite
 * a newer product edit, alias override or mapping during the queue's grace window. */
export async function prepareMappingDispatch(item: any) {
  const listing = item.channelListingId ? await prisma.channelListing.findUnique({ where: { id: item.channelListingId } }) : null
  if (!listing || !listing.channelConnectionId || listing.productId !== item.productId || listing.channel !== item.targetChannel || !listing.marketplace) {
    throw new Error('Mapping dispatch requires an existing listing and its exact account.')
  }
  if (listing.syncPaused || listing.offerClosedAt) throw new Error('This listing is paused or closed. Mapping publication is blocked.')
  if (!['AMAZON', 'EBAY'].includes(listing.channel)) throw new Error('Publish mapped fields through this channel’s listing editor.')
  const resolved = await resolveBatch({ channel: listing.channel, marketplace: listing.marketplace,
    channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey, productIds: [listing.productId] })
  const product = resolved.products[0]
  if (!product || !resolved.catalogue?.schema.present || product.readiness?.schemaValidation === 'unavailable') throw new Error('Channel schema validation is unavailable.')
  const requested = Object.entries(item.payload?.fields ?? {})
  if (!requested.length || requested.length > 500) throw new Error('Mapping dispatch requires 1–500 reviewed fields.')
  const selected = requested.map(([key, value]) => {
    const field = resolved.catalogue!.fields.find(f => f.fieldKey === key)
    const cell = product.cells[key]
    if (!field || field.sourceOwner || field.schemaKnown === false || !cell || cell.errors.length || cell.needsTranslation) throw new Error(`Mapping field ${key} cannot be published: ${cell?.errors.join('; ') || 'Missing, pending translation or owned by another workflow'}`)
    if (!valuesEqual(value, cell.value)) throw new Error(`Mapping field ${key} changed after queueing. Review and queue the current value.`)
    return { field, cell }
  })
  const payload: Record<string, unknown> = { source: 'FM_CATALOG_CASCADE', fields: item.payload.fields, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey,
    marketplaceId: listing.channel === 'EBAY' ? `EBAY_${listing.marketplace}` : listing.marketplace,
    productType: product.category.channelCategoryId }
  if (listing.channel === 'AMAZON') {
    if ((await primaryConnectionIds(['AMAZON'])).get('AMAZON') !== listing.channelConnectionId) throw new Error('This outbound adapter supports the primary Amazon account only.')
    const spec = await loadAmazonSpec(listing.marketplace, product.category.channelCategoryId ?? '')
    const roots = new Set(spec.fields.filter(f => selected.some(s => s.field.fieldKey === f.key)).map(f => f.attribute))
    if (spec.fields.some(f => roots.has(f.attribute) && resolved.catalogue!.fields.some(field => field.fieldKey === f.key && field.sourceOwner))) {
      throw new Error('A mapped compound attribute contains listing-owned values. Publish it through the structured listing editor.')
    }
    const values = Object.fromEntries(Object.values(product.cells).filter(c => spec.fields.some(f => f.key === c.fieldKey && roots.has(f.attribute))).map(c => [c.fieldKey, c.value]))
    const attributes = attributesFromCells(spec, values)
    payload.mappingAttributePatches = [...roots].map(root => attributes[root] === undefined
      ? { op: 'delete', path: `/attributes/${root}` }
      : { op: 'replace', path: `/attributes/${root}`, value: attributes[root] })
  } else {
    const aspects: Record<string, string[] | null> = {}
    for (const { field, cell } of selected) {
      const store = field.channelStore
      if (store?.kind === 'listingColumn' && ['title', 'description'].includes(store.column)) {
        if (cell.value == null) throw new Error(`Clear ${field.label} through the listing editor; this adapter cannot safely clear it.`)
        payload[store.column] = cell.value
      }
      else if (store?.kind === 'platformAttributes' && store.path[0] === 'itemSpecifics' && store.path.length === 2) {
        aspects[store.path[1]] = cell.value == null ? null : (Array.isArray(cell.value) ? cell.value : [cell.value]).map(String)
      } else throw new Error(`Publish ${field.label} through its channel listing editor; this adapter has no safe serializer.`)
    }
    if (Object.keys(aspects).length) payload.mappingAspects = aspects
  }
  return { ...item, payload }
}
