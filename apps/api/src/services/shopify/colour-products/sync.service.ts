import { Prisma, type ShopifyColourProduct } from '@prisma/client'
import type { ColourPlanProduct } from '@nexus/shared/shopify-colour-products'
import { assertPushAllowed, isStillDraftListing } from '@nexus/shared/push-lock'
import prisma from '../../../db.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import { draftListingFields, ensureDraftListings } from '../../pim/draft-listing.service.js'
import { validateAliasWriteTargets } from '../../pim/listing-alias.service.js'
import { getShopifyPublishMode } from '../../shopify-publish-gate.service.js'
import { productReadCacheService } from '../../product-read-cache.service.js'
import { shopifyAdmin, assertShopifyResult as checked, type ShopifyGraphql } from '../admin-client.js'
import { contentDestination, object, type ContentScope } from '../content-workspace.service.js'
import { shortId } from '../content-publisher.js'
import { syncNativeShopifyOffer } from '../offer-sync.service.js'
import { colourProductIdentity } from './confirm.service.js'
import { linkColourProducts } from './link.service.js'
import { planFor, rowsWhere, type Destination } from './find.service.js'
import { assertColourSyncCurrent, commitColourSyncChange, guardedColourGraphql, withColourSyncLock } from './sync-work.js'
import { colourIsPublished, readOnlineStorePublication, readColourRemote, planColourVariants, COLOUR_SIZE_CREATE, COLOUR_SIZE_ORDER, type ColourRemoteProduct } from './variants.js'
import { NO_LISTING_PRICE_FACTS, listingMarketCurrency, listingSendPrice } from '../../pim/follower-price.js'
import { marketCurrencyRows } from '../../pim/market-currency.js'

const listingWhere = (d: Destination) => ({ channel: 'SHOPIFY', marketplace: d.marketplace, channelConnectionId: d.accountId, aliasKey: d.aliasKey ?? '' })
const ownedListings = (d: Destination, row: ShopifyColourProduct) => prisma.channelListing.findMany({ where: { ...listingWhere(d), platformAttributes: { path: ['shopifyColourProductId'], equals: row.id } }, include: { product: true }, orderBy: { id: 'asc' } })

/** Reconcile only already confirmed colour products. Creating a new colour remains an explicit action (PR 6). */
export async function syncColourProducts(productId: string, scope: ContentScope) {
  if (getShopifyPublishMode() !== 'live') throw new WorkspaceScopeError('Shopify writes are switched off on this server.', 409)
  const d = await contentDestination(productId, scope, true)
  return withColourSyncLock(d, async () => {
    const { plan, settings } = await planFor(d)
    if (!settings.enabled) return { checked: 0, waiting: [] as string[] }
    const retiredRoot = !!(await prisma.product.findUniqueOrThrow({ where: { id: d.familyId }, select: { deletedAt: true } })).deletedAt
    if (!retiredRoot && (plan.mode !== 'colour-products' || !plan.splitAxis || plan.issues.some(i => i.severity === 'error')))
      throw new WorkspaceScopeError(plan.issues.filter(i => i.severity === 'error').map(i => i.message).join(' ') || 'The colour axes changed. Review the family before syncing sizes.')
    const rows = await prisma.shopifyColourProduct.findMany({ where: rowsWhere(d), orderBy: { id: 'asc' } })
    if (!rows.some(r => r.shopifyProductId && ['LINKED', 'NOT_FOUND'].includes(r.state))) return { checked: 0, waiting: retiredRoot ? [] : plan.products.map(p => p.key) }
    const gql = guardedColourGraphql((await shopifyAdmin(d.accountId)).graphql)
    const publication = await readOnlineStorePublication(gql)
    let checkedCount = 0
    const errors: string[] = []
    for (const row of rows.filter(r => r.state === 'LINKED' && r.shopifyProductId)) {
      try {
        const remote = await readColourRemote(gql, row.shopifyProductId!, publication)
        if (remote === null) {
          await forgetDeletedColour(d, row)
          row.state = 'DELETED'; row.shopifyProductId = null
          checkedCount++
          continue
        }
        if (remote.id !== row.shopifyProductId || remote.identity?.value !== colourProductIdentity(row))
          throw new WorkspaceScopeError(`The Shopify identity of ${row.colourName ?? row.valueKey} changed. No size was changed.`)
        const wanted = retiredRoot ? undefined : plan.products.find(p => p.key === row.valueKey)
        errors.push(...await syncOneColour(gql, d, row, remote, publication, wanted))
        checkedCount++
      } catch (error) { errors.push(`${row.colourName ?? row.valueKey}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const waiting = retiredRoot ? [] : plan.products.filter(p => !rows.some(r => r.valueKey === p.key && r.state === 'LINKED' && r.shopifyProductId)).map(p => p.key)
    if (!errors.length && !retiredRoot && !waiting.length) await linkColourProducts(d.familyId, { accountId: d.accountId, market: d.marketplace, aliasKey: d.aliasKey ?? '' })
    await productReadCacheService.refreshMany([d.familyId]).catch(() => undefined)
    if (errors.length) throw new WorkspaceScopeError(errors.join(' '))
    return { checked: checkedCount, waiting }
  })
}

async function syncOneColour(gql: ShopifyGraphql, d: Destination, row: ShopifyColourProduct, first: ColourRemoteProduct, publication: string, wanted?: ColourPlanProduct) {
  let remote = first
  const old = await ownedListings(d, row)
  const mapped = new Map(old.map(l => [l.productId, object(l.platformAttributes)]))
  const planned = wanted ? planColourVariants(wanted, remote, mapped) : null
  const errors: string[] = []
  let held = false
  if (planned?.missing.length || planned?.reordered || !wanted && remote.status !== 'ARCHIVED') {
    const listing = old.find(l => assertPushAllowed(l) || l.syncLocked)
    held = !!listing
    if (listing) errors.push(`${listing.product.sku}: sync is paused. Resume it before changing its Shopify sizes.`)
  }
  // Local alias scope and draft creation are checked BEFORE a remote size can be created or reordered.
  if (!held && wanted) await prepareSizeListings(d, wanted.variants.filter(v => !mapped.has(v.productId)).map(v => v.productId))
  if (!held && planned?.missing.length) {
    const locations = [...new Set(old.map(l => object(l.platformAttributes).inventoryLocationId).filter(Boolean))]
    if (locations.length !== 1 || !/^gid:\/\/shopify\/Location\/\d+$/.test(locations[0]))
      throw new WorkspaceScopeError('This colour has no single reviewed stock location. Confirm its location before adding sizes.')
    const location = (await gql(`query NexusColourLocation($id:ID!) { location(id:$id) { id isActive } }`, { id: locations[0] })).location
    if (!location?.isActive) throw new WorkspaceScopeError('The reviewed Shopify stock location is no longer active.')
    const products = await prisma.product.findMany({ where: { id: { in: planned.missing.map(v => v.productId) }, parentId: d.familyId, deletedAt: null } })
    const drafts = await prisma.channelListing.findMany({ where: { ...listingWhere(d), productId: { in: planned.missing.map(v => v.productId) } } })
    // Round 6 — the market's currency, read as the price door reads it (`listingSendPrice` below).
    const marketCur = listingMarketCurrency({ channel: 'SHOPIFY', marketplace: d.marketplace }, await marketCurrencyRows('SHOPIFY'))
    const variants = planned.missing.map(v => {
      const child = products.find(p => p.id === v.productId), draft = drafts.find(l => l.productId === v.productId)
      if (!child || child.sku !== v.sku) throw new WorkspaceScopeError('The new size changed. Sync the current family again.')
      const pa = object(draft?.platformAttributes)
      if (draft && (draft.externalListingId || pa.variantId || pa.shopifyColourProductId && pa.shopifyColourProductId !== row.id))
        throw new WorkspaceScopeError(`${v.sku} already has a Shopify mapping. Review it before creating a size.`)
      // Round 6 — THE send price (`listingSendPrice`): a pin's own price, a follower's rule price from the current master
      // in the master currency, else the price the listing holds. It created every following size at the master price.
      const send = listingSendPrice(draft ?? NO_LISTING_PRICE_FACTS, { masterPrice: child.basePrice, marketCurrency: marketCur, where: `Shopify ${d.marketplace}` })
      if (send.price == null) throw new WorkspaceScopeError(`${v.sku}: ${send.reason} Its size was not created.`)
      const price = send.price.toFixed(2)
      if (!/^\d+(\.\d{1,2})?$/.test(String(price))) throw new WorkspaceScopeError(`${v.sku} needs a valid price before its size is created.`)
      return { optionValues: v.optionValues, price: String(price), inventoryPolicy: 'DENY', inventoryItem: { sku: v.sku, tracked: true },
        inventoryQuantities: [{ locationId: locations[0], availableQuantity: 0 }] }
    })
    checked((await gql(COLOUR_SIZE_CREATE, { id: remote.id, variants })).productVariantsBulkCreate, 'Add Shopify sizes')
    remote = await readColourRemote(gql, remote.id, publication) ?? (() => { throw new WorkspaceScopeError('The colour disappeared while its sizes were read back.') })()
  }
  const final = wanted ? planColourVariants(wanted, remote, mapped) : null
  if (!held && final?.missing.length) throw new WorkspaceScopeError('Shopify did not return every new size. The next run checks before creating anything again.', 502)
  if (!held && final?.reordered) {
    checked((await gql(COLOUR_SIZE_ORDER, { id: remote.id, options: final.order })).productOptionsReorder, 'Order Shopify sizes')
    remote = await readColourRemote(gql, remote.id, publication) ?? (() => { throw new WorkspaceScopeError('The colour disappeared during size order verification.') })()
    if (planColourVariants(wanted!, remote, mapped).reordered) throw new WorkspaceScopeError('Shopify did not keep the size order. This work remains pending.', 502)
  }
  const match = new Map(final?.matched.map(v => [v.productId, v.remote]) ?? [])
  const locations = [...new Set(old.map(l => object(l.platformAttributes).inventoryLocationId).filter(Boolean))]
  await prisma.$transaction(async tx => {
    await assertColourSyncCurrent(tx)
    const listings = await tx.channelListing.findMany({ where: { ...listingWhere(d), id: { in: old.map(l => l.id) } } })
    const current = match.size ? await tx.channelListing.findMany({ where: { ...listingWhere(d), productId: { in: [...match.keys()] } } }) : []
    for (const listing of new Map([...listings, ...current].map(l => [l.id, l])).values()) {
      const pa = object(listing.platformAttributes), variant = match.get(listing.productId), retired = !variant
      if (variant && (pa.shopifyColourProductId && pa.shopifyColourProductId !== row.id
        || listing.externalListingId && listing.externalListingId !== shortId(remote.id))) throw new WorkspaceScopeError('A size became another Shopify listing while sync was running.')
      const published = !retired && colourIsPublished(remote)
      const next = { ...pa, nexusFamilyId: d.familyId, shopifyColourProductId: row.id,
        ...(variant ? { shopifyProductId: shortId(remote.id), variantId: shortId(variant.id), inventoryItemId: shortId(variant.inventoryItem.id), inventoryLocationId: pa.inventoryLocationId ?? locations[0] } : {}),
        shopifyColourRetired: retired, shopifyColourStockPending: pa.shopifyColourStockPending === true || (!pa.variantId && !!variant)
          || published && !listing.isPublished || retired && pa.shopifyColourRetired !== true || !retired && pa.shopifyColourRetired === true }
      if (JSON.stringify(pa) !== JSON.stringify(next) || listing.isPublished !== published) await tx.channelListing.update({ where: { id: listing.id }, data: {
        platformAttributes: next as Prisma.InputJsonValue, isPublished: published, listingStatus: listing.listingStatus.trim().toUpperCase() === 'ENDED' ? 'ENDED' : published ? 'ACTIVE' : 'INACTIVE',
        ...(variant ? { externalListingId: shortId(remote.id), platformProductId: shortId(remote.id) } : {}),
        ...(variant && isStillDraftListing(listing) ? { syncPaused: false } : {}), version: { increment: 1 },
      } })
    }
    await tx.shopifyColourProduct.update({ where: { id: row.id }, data: { remoteStatus: remote.status, checkedAt: new Date() } })
  })
  // The pending bit is saved before sending stock. A failure never disappears merely because status is now Active.
  for (const listing of await ownedListings(d, row)) {
    const pa = object(listing.platformAttributes)
    if (!pa.shopifyColourStockPending || !listing.isPublished && !pa.shopifyColourRetired) continue
    try {
      const refusal = assertPushAllowed(listing)
      if (refusal || listing.syncLocked) throw new Error(refusal?.sentence ?? 'Listing sync is locked.')
      await assertColourSyncCurrent()
      await syncNativeShopifyOffer({ id: `colour-stock-${listing.id}-${listing.version}`, product: listing.product, channelListing: listing,
        channelConnectionId: d.accountId, syncType: 'QUANTITY_UPDATE' })
      await prisma.$transaction(async tx => {
        await assertColourSyncCurrent(tx)
        const won = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { platformAttributes: { ...pa, shopifyColourStockPending: false }, version: { increment: 1 } } })
        if (won.count !== 1) throw new WorkspaceScopeError('This size changed during its stock push. Its current stock remains pending.')
      })
    } catch (error) { errors.push(`${listing.product.sku}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (!held && !errors.length && !wanted && remote.status !== 'ARCHIVED') {
    checked((await gql(`mutation NexusColourArchive($product:ProductUpdateInput!) { productUpdate(product:$product) { userErrors { field message } } }`, { product: { id: remote.id, status: 'ARCHIVED' } })).productUpdate, 'Archive retired colour')
    const back = await readColourRemote(gql, remote.id, publication)
    if (back?.status !== 'ARCHIVED') throw new WorkspaceScopeError('Shopify did not confirm that this retired colour is archived.', 502)
    await prisma.shopifyColourProduct.update({ where: { id: row.id }, data: { remoteStatus: 'ARCHIVED', checkedAt: new Date() } })
  }
  return errors
}

async function prepareSizeListings(d: Destination, productIds: string[]) {
  if (!productIds.length) return
  await commitColourSyncChange(async tx => {
    if (!d.aliasKey) {
      await ensureDraftListings(tx, { channel: 'SHOPIFY', market: d.marketplace, accountId: d.accountId, productIds, family: true })
      return
    }
    await validateAliasWriteTargets(productIds.map(productId => ({ productId, channel: 'SHOPIFY', marketplace: d.marketplace, connectionId: d.accountId, aliasKey: d.aliasKey! })), tx)
    await tx.channelListing.createMany({ data: [...productIds].sort().map(productId => draftListingFields({ productId, channel: 'SHOPIFY', market: d.marketplace, accountId: d.accountId, aliasKey: d.aliasKey! })), skipDuplicates: true })
  })
}

async function forgetDeletedColour(d: Destination, row: ShopifyColourProduct) {
  await commitColourSyncChange(async tx => {
    const listings = await tx.channelListing.findMany({ where: { ...listingWhere(d), platformAttributes: { path: ['shopifyColourProductId'], equals: row.id } } })
    for (const listing of listings) {
      const pa = { ...object(listing.platformAttributes) }
      for (const key of ['shopifyProductId', 'variantId', 'inventoryItemId', 'inventoryLocationId', 'shopifyColourStockPending', 'shopifyColourRetired']) delete pa[key]
      // Internal family/colour references remain as a tombstone: a stale job cannot fall back to a SKU search.
      await tx.channelListing.update({ where: { id: listing.id }, data: { platformAttributes: pa, externalListingId: null, platformProductId: null,
        isPublished: false, listingStatus: 'INACTIVE', syncPaused: true, version: { increment: 1 } } })
    }
    await tx.outboundSyncQueue.updateMany({ where: { channelListingId: { in: listings.map(l => l.id) }, syncStatus: { in: ['PENDING', 'FAILED'] } }, data: { syncStatus: 'CANCELLED', nextRetryAt: null } })
    await tx.shopifyColourProduct.update({ where: { id: row.id }, data: { state: 'DELETED', shopifyProductId: null, proposal: Prisma.JsonNull, remoteStatus: null, checkedAt: new Date(), linkVerifiedAt: null } })
  })
}
