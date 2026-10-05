import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { ownSkuIn } from './write-account-guard.js'

export interface PushControlLookup {
  channel: string
  listingIds?: readonly string[]
  productIds?: readonly string[]
  skus?: readonly string[]
  externalIds?: readonly string[]
  /** Only a caller creating a new listing may explicitly allow no stored controls. */
  allowAbsent?: boolean
}

/** Legacy refusal lookup, never a transport target resolver or authorization grant.
 * Callers without account/alias context conservatively inspect every matching row. */
export async function readPushControls(input: PushControlLookup) {
  const clean = (values: readonly string[] = []) => [...new Set(values.map(v => v.trim()).filter(Boolean))]
  const listingIds = clean(input.listingIds), productIds = clean(input.productIds), skus = clean(input.skus)
  const externalIds = clean(input.externalIds?.flatMap(id => /^gid:\/\/shopify\/\w+\/\d+$/.test(id) ? [id, id.split('/').at(-1)!] : [id]))
  const unavailable = () => Object.assign(new Error('PUSH_CONTROL_UNAVAILABLE: The stored listing controls could not be established.'), { code: 'PUSH_CONTROL_UNAVAILABLE' })
  const OR: Prisma.ChannelListingWhereInput[] = []
  if (listingIds.length) OR.push({ id: { in: listingIds } })
  if (productIds.length) OR.push({ productId: { in: productIds } })
  if (skus.length) {
    OR.push({ product: { OR: [{ sku: { in: skus } }, { variations: { some: { sku: { in: skus } } } }] } })
    // The eBay flat file's imported seller SKU is carried in the raw listing snapshot.
    for (const sku of skus) OR.push({ flatFileSnapshot: { path: ['sku'], equals: sku } })
    // S8 — a listing's own channel SKU (channelSku / confirmed liveChannelSku), in the same statement: a lock found only
    // through the product SKU was missed for a listing that carries another SKU. The indexed columns only; a SKU only an
    // old store holds is matched once the backfill copies it into these columns.
    OR.push(ownSkuIn(skus))
  }
  if (externalIds.length) {
    OR.push({ externalListingId: { in: externalIds } }, { platformProductId: { in: externalIds } })
    if (input.channel.toUpperCase() === 'SHOPIFY') for (const id of externalIds) {
      OR.push({ platformAttributes: { path: ['variantId'], equals: id } }, { platformAttributes: { path: ['inventoryItemId'], equals: id } })
    }
  }
  if (!OR.length) throw unavailable()
  const rows = await prisma.channelListing.findMany({ where: { channel: input.channel.toUpperCase(), OR } }).catch(() => { throw unavailable() })
  // Full rows include syncPaused and offerClosedAt today, plus optional intent
  // when Wave 2's migration and generated client actually exist.
  if (!rows.length && input.allowAbsent !== true) throw unavailable()
  return rows
}
