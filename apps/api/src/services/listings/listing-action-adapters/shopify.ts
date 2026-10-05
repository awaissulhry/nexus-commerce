/**
 * Sheet publish parity, step 7 (build shape v2, P3) — Shopify. Every call goes through the admin client → the channel
 * gateway; the Shopify publish mode refuses a write when it is not live. A family split into several Shopify products
 * (one per colour) is refused by the engine before this runs: the Shopify colour lane owns their status.
 *
 * - Pause offer, per variant: quantity 0 held by Nexus (the product page stays and shows "sold out"). Shopify is read
 *   first: a variant that sells when out of stock ("Continue selling when out of stock", inventoryPolicy CONTINUE) is
 *   NOT paused, because 0 would not stop its sales. Quantity 0 goes through the stock writer every linked Shopify
 *   listing uses (`syncShopifyLinkedListing`: the variant's exact ids, the location Nexus manages for it, compare-and-set,
 *   read back), then the hold (hold.ts) makes the push lock refuse every stock push.
 * - Resume offer: lift the hold and send the current stock (a pinned quantity comes back). A product that is a Draft
 *   (or Unlisted) in Shopify — set there, or by an older Nexus pause — is made Active first (`productUpdate`).
 * - End = ARCHIVED, Relist = ACTIVE: one status for the whole product, in every market of the store (`productUpdate`,
 *   read back). End clears the holds (an ended listing gets no pushes anyway); Relist sends the current stock.
 * - Delete listing = `productDelete` (Owner D8 A), read back as gone. Every row of the family here goes back to the inert
 *   draft shape, forgets the Shopify ids, and reads Not listed until its Status column lists it again (a new product).
 */
import { deleteDoneSentence, type ListingAction } from '@nexus/shared/listing-actions'
import prisma from '../../../db.js'
import { shopifyAdmin, assertShopifyResult, type ShopifyGraphql } from '../../shopify/admin-client.js'
import { syncShopifyLinkedListing } from '../../shopify/listing-write.service.js'
import { heldElsewhere, heldElsewhereSentence, holdRows, liftHoldOn, returnToDraft, sendCurrentStock } from './hold.js'
import type { ActionContext, ActionListing, AdapterRowResult, ListingActionAdapter } from './types.js'
import { messageOf, object, rowResult } from './types.js'

type ProductStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED'
export const SHOPIFY_TARGET_STATUS: Readonly<Partial<Record<ListingAction, ProductStatus>>> = { end: 'ARCHIVED', relist: 'ACTIVE' }

const listingStatusFor = (status: string) => status === 'ACTIVE' ? 'ACTIVE' : status === 'ARCHIVED' ? 'ENDED' : 'INACTIVE'
const productGid = (id: string) => id.startsWith('gid://') ? id : `gid://shopify/Product/${id}`
const shortId = (gid: string) => gid.split('/').at(-1)!
const SHOPIFY_IDS = ['shopifyProductId', 'variantId', 'inventoryItemId', 'status'] as const

/** The family's own listing (the Shopify product); else any row naming the product. */
export function shopifyProductRow(family: ActionListing[]): ActionListing | null {
  return family.find(row => row.isParent && row.externalListingId) ?? family.find(row => row.externalListingId) ?? null
}

/** A thrown Shopify call, as a row outcome: switched off → not sent; a lost answer → unknown; a refusal → failed. */
function outcomeOfError(err: unknown): Pick<AdapterRowResult, 'outcome' | 'message'> {
  const message = messageOf(err)
  if (/publish settings|disabled/i.test(message)) return { outcome: 'NOT_SENT', message: 'Shopify writes are switched off on this server. Nothing was sent.' }
  if (/HTTP 5|timeout|aborted|fetch failed|did not answer|read-back|readback/i.test(message)) return { outcome: 'UNKNOWN', message: `${message} Check the product in Shopify.` }
  return { outcome: 'FAILED', message }
}

/** One status for the whole product, read back; the Status column and every row's listing status follow Shopify. */
async function setProductStatus(graphql: ShopifyGraphql, ctx: ActionContext, owner: ActionListing, status: ProductStatus): Promise<string | null> {
  const id = productGid(owner.externalListingId!)
  const answer = await graphql<{ productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
    'mutation NexusListingStatus($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }',
    { product: { id, status } })
  assertShopifyResult(answer.productUpdate, 'Change the product status')
  const read = await graphql<{ product: { status: string } | null }>('query NexusListingStatusRead($id: ID!) { product(id: $id) { status } }', { id })
  const confirmed = read.product?.status ?? null
  if (confirmed !== status) return confirmed
  const row = await prisma.channelListing.findUnique({ where: { id: owner.id }, select: { platformAttributes: true } })
  await prisma.channelListing.update({ where: { id: owner.id }, data: { platformAttributes: { ...object(row?.platformAttributes), status } as never } })
  await prisma.channelListing.updateMany({
    where: { id: { in: ctx.family.map(r => r.id) }, channel: 'SHOPIFY', marketplace: ctx.destination.marketplace,
      channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey },
    data: { listingStatus: listingStatusFor(status), isPublished: status === 'ACTIVE' },
  })
  return status
}

interface ShopifyVariant { id: string; sku: string | null; inventoryPolicy: string | null; inventoryItem: { id: string } | null }

async function pauseVariants(graphql: ShopifyGraphql, targets: ActionListing[], ctx: ActionContext, owner: ActionListing): Promise<AdapterRowResult[]> {
  const productId = productGid(owner.externalListingId!)
  const read = await graphql<{ product: { id: string; variants: { nodes: ShopifyVariant[] } } | null }>(
    'query NexusPauseVariants($id: ID!) { product(id: $id) { id variants(first: 250) { nodes { id sku inventoryPolicy inventoryItem { id } } } } }', { id: productId })
  if (!read.product) return targets.map(row => rowResult(row, 'FAILED', 'Shopify has no such product any more. Nothing was sent.'))
  const variants = read.product.variants.nodes
  const results: AdapterRowResult[] = []
  const held: Array<{ id: string; evidence: Record<string, unknown> }> = []
  for (const row of targets) {
    const pa = object(row.platformAttributes)
    const stored = typeof pa.variantId === 'string' && pa.variantId ? (pa.variantId.startsWith('gid://') ? pa.variantId : `gid://shopify/ProductVariant/${pa.variantId}`) : null
    // S5 — `row.sku` is the SKU Shopify holds for this listing (the engine's `listingSendSku`), so a variant with its own
    // SKU is found, and the writer's identity read-back expects that SKU.
    const bySku = variants.filter(v => v.sku === row.sku)
    const variant = stored ? variants.find(v => v.id === stored) : bySku.length === 1 ? bySku[0] : undefined
    if (!variant?.inventoryItem?.id) { results.push(rowResult(row, 'FAILED', `This Shopify product has no single variant ${row.sku}. Nothing was sent.`)); continue }
    // SHOPIFY_PAUSE_CHECK: quantity 0 stops a variant only when it does not sell out of stock.
    if (variant.inventoryPolicy === 'CONTINUE') {
      results.push(rowResult(row, 'NOT_SENT', 'This variant sells when out of stock ("Continue selling when out of stock" in Shopify), so quantity 0 would not stop its sales. Nothing was sent; turn that off in Shopify, or set Ended.'))
      continue
    }
    if (variant.inventoryPolicy !== 'DENY') { results.push(rowResult(row, 'NOT_SENT', 'Shopify did not say whether this variant sells when out of stock, so nothing was sent.')); continue }
    try {
      // The exact ids just read, so the writer never looks the SKU up across the store.
      const answer = await syncShopifyLinkedListing({
        id: `listing-action:${ctx.previewId}:${row.id}`, syncType: 'QUANTITY_UPDATE', product: { id: row.productId, sku: row.sku }, sku: row.sku,
        channelListing: { id: row.id, offerClosedAt: row.offerClosedAt, listingStatus: row.listingStatus,
          platformAttributes: { ...pa, shopifyProductId: shortId(productId), variantId: shortId(variant.id), inventoryItemId: shortId(variant.inventoryItem.id) } },
      }, ctx.destination.accountId, { quantity: 0 })
      const evidence = { productId, variantId: variant.id, inventoryPolicy: variant.inventoryPolicy, answer }
      held.push({ id: row.id, evidence })
      results.push(rowResult(row, 'DONE', 'Shopify shows quantity 0 (the product page shows "sold out"); the product and the variant stay. Nexus holds its stock pushes.', evidence))
    } catch (err) {
      const { outcome, message } = outcomeOfError(err)
      results.push(rowResult(row, outcome, message))
    }
  }
  await holdRows(ctx, held)
  return results
}

async function resumeVariants(graphql: ShopifyGraphql, targets: ActionListing[], ctx: ActionContext, owner: ActionListing): Promise<AdapterRowResult[]> {
  const blocked = targets.filter(heldElsewhere)
  const productStatus = String(object(owner.platformAttributes).status ?? '').toUpperCase()
  let activated = false
  if (productStatus === 'DRAFT' || productStatus === 'UNLISTED') {
    const confirmed = await setProductStatus(graphql, ctx, owner, 'ACTIVE')
    if (confirmed !== 'ACTIVE') return targets.map(row => rowResult(row, 'UNKNOWN', `Shopify has not confirmed the status ACTIVE (it reads ${confirmed ?? 'nothing'}). Check the product in Shopify.`))
    activated = true
  }
  const lifted = new Set(await liftHoldOn(ctx, targets.filter(row => row.offerClosedAt && !heldElsewhere(row))))
  await sendCurrentStock([...lifted])
  return targets.map(row => {
    if (blocked.includes(row)) return rowResult(row, activated ? 'DONE' : 'SKIPPED', `${activated ? 'Active in every market of the store again. ' : ''}${heldElsewhereSentence(row)}`)
    if (lifted.has(row.id)) return rowResult(row, 'DONE', `${activated ? 'Active in every market of the store again. ' : ''}Hold lifted. Nexus queued the current stock for Shopify; it arrives within a minute.`)
    if (activated) return rowResult(row, 'DONE', 'Active in every market of the store again.', { status: 'ACTIVE' })
    return rowResult(row, 'SKIPPED', row.offerClosedAt ? 'Changed while resuming. Open the sheet again.' : 'Not inactive.')
  })
}

async function deleteProduct(graphql: ShopifyGraphql, targets: ActionListing[], ctx: ActionContext, owner: ActionListing): Promise<AdapterRowResult[]> {
  const id = productGid(owner.externalListingId!)
  const answer = await graphql<{ productDelete: { deletedProductId: string | null; userErrors: Array<{ field?: string[]; message: string }> } }>(
    'mutation NexusListingDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }', { input: { id } })
  assertShopifyResult(answer.productDelete, 'Delete the product')
  const read = await graphql<{ product: { id: string } | null }>('query NexusListingDeleteRead($id: ID!) { product(id: $id) { id } }', { id })
  if (read.product) return targets.map(row => rowResult(row, 'UNKNOWN', 'Shopify still shows the product after the delete. Check it in Shopify before trying again.'))
  // Forget the dead Shopify ids; the family identity and the reviewed stock location stay for the next Publish.
  await returnToDraft(ctx, ctx.family, row => {
    const pa = { ...object(row.platformAttributes) }
    for (const key of SHOPIFY_IDS) delete pa[key]
    return { platformAttributes: pa, platformProductId: null }
  })
  return targets.map(row => rowResult(row, 'DONE', `${deleteDoneSentence('Shopify')} Shopify deleted it in every market of the store.`,
    { oldExternalListingId: row.externalListingId ?? owner.externalListingId, deletedProductId: answer.productDelete.deletedProductId ?? id }))
}

export const shopifyListingActions: ListingActionAdapter = {
  async run(action, targets, ctx) {
    const owner = shopifyProductRow(ctx.family)
    if (!owner?.externalListingId) return targets.map(row => rowResult(row, 'FAILED', 'This product is not on Shopify yet.'))
    try {
      const { graphql } = await shopifyAdmin(ctx.destination.accountId)
      if (action === 'pause') return await pauseVariants(graphql, targets, ctx, owner)
      if (action === 'resume') return await resumeVariants(graphql, targets, ctx, owner)
      if (action === 'delete') return await deleteProduct(graphql, targets, ctx, owner)
      const status = SHOPIFY_TARGET_STATUS[action]!
      const confirmed = await setProductStatus(graphql, ctx, owner, status)
      if (confirmed !== status) {
        return targets.map(row => rowResult(row, 'UNKNOWN', `Shopify has not confirmed the status ${status} (it reads ${confirmed ?? 'nothing'}). Check the product in Shopify.`))
      }
      const rows = ctx.family.map(row => row.id)
      if (action === 'end') {
        // An archived product gets no pushes (its rows read Ended); a pause hold has nothing left to hold.
        await prisma.channelListing.updateMany({ where: { id: { in: rows }, channel: 'SHOPIFY', marketplace: ctx.destination.marketplace,
          channelConnectionId: ctx.destination.accountId, aliasKey: ctx.destination.aliasKey },
        data: { offerActive: false, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null } })
      } else await sendCurrentStock(ctx.family.filter(row => !row.isParent).map(row => row.id)) // the variants carry the stock
      const words = status === 'ACTIVE' ? 'Active in every market of the store; Nexus queued the current stock.' : 'Archived in Shopify. Relist makes it active again.'
      return targets.map((target): AdapterRowResult => rowResult(target, 'DONE', words, { productId: productGid(owner.externalListingId!), status }))
    } catch (err) {
      const { outcome, message } = outcomeOfError(err)
      return targets.map(row => rowResult(row, outcome, message))
    }
  },
}
