/** Exercises real account validation/read APIs. Never calls a listing submission method. */
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.ts'
import { amazonSpApiClient } from '../../../apps/api/src/clients/amazon-sp-api.client.ts'
import { resolveBatch } from '../../../apps/api/src/services/pim/mapping/resolve-batch.service.ts'
import { prepareMappingDispatch } from '../../../apps/api/src/services/pim/mapping/prepare-dispatch.ts'
import { amazonMarketplaceId } from '../../../apps/api/src/services/categories/marketplace-ids.ts'
import { getAccessToken } from '../../../apps/api/src/services/cx/token.service.ts'
import '../../../apps/api/src/services/cx/connectors/index.ts'

const report: any = { checkedAt: new Date().toISOString(), listingWrites: 0, amazon: [], ebay: [] }
try {
  const amazon = await prisma.channelConnection.findFirst({ where: { channelType: 'AMAZON', isActive: true, managedBy: 'env', externalAccountId: process.env.AMAZON_SELLER_ID } })
  if (!amazon) throw new Error('Primary Amazon account does not match the configured seller')
  const listings = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace: 'IT', channelConnectionId: amazon.id, aliasKey: '', product: { deletedAt: null } }, include: { product: true }, orderBy: { id: 'asc' } })
  const sampled = new Set<string>()
  for (const listing of listings) {
    if (sampled.has(listing.product.productType)) continue
    sampled.add(listing.product.productType)
    const result = await resolveBatch({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: amazon.id, aliasKey: '', productIds: [listing.productId] })
    const product = result.products[0]
    const fields = result.catalogue?.fields.filter(f => !f.sourceOwner && f.schemaKnown !== false && ['brand', 'color', 'size'].includes(f.fieldKey)
      && product.cells[f.fieldKey]?.value != null && !product.cells[f.fieldKey].errors.length && !product.cells[f.fieldKey].needsTranslation) ?? []
    const record: any = { sku: product.sku, listingId: listing.id, accountId: amazon.id, marketplace: 'IT', productType: product.category.channelCategoryId, fields: fields.map(f => f.fieldKey) }
    try {
      if (!fields.length) throw new Error('No locally valid representative mapped fields')
      const prepared = await prepareMappingDispatch({ channelListingId: listing.id, productId: listing.productId, targetChannel: 'AMAZON', payload: { fields: Object.fromEntries(fields.map(f => [f.fieldKey, product.cells[f.fieldKey].value])) } })
      const check = await amazonSpApiClient.validateListing({ sellerId: amazon.externalAccountId!, sku: product.sku, marketplaceId: amazonMarketplaceId('IT'), productType: product.category.channelCategoryId!, patches: prepared.payload.mappingAttributePatches as any })
      Object.assign(record, { available: check.available, ok: check.ok, status: check.status, issues: check.issues ?? [], errors: check.errors, mode: 'VALIDATION_PREVIEW', validationScope: 'selected mapped attribute patches' })
    } catch (error: any) { Object.assign(record, { ok: false, error: String(error?.message ?? error) }) }
    report.amazon.push(record)
    console.log(JSON.stringify(record))
    await writeFile('/tmp/nexus-live-mapping-validation.json', JSON.stringify(report, null, 2) + '\n')
  }
  // A structurally incomplete request must be blocked, even when the HTTP error
  // body has `errors` rather than the listing response's `issues` array.
  if (report.amazon.length) {
    const first = report.amazon[0]
    const check = await amazonSpApiClient.validateListing({ sellerId: amazon.externalAccountId!, sku: first.sku, marketplaceId: amazonMarketplaceId('IT'), productType: first.productType, attributes: {} })
    report.amazonNegativeControl = { control: 'incomplete full request', available: check.available, blocked: !check.ok, status: check.status, issues: check.issues, errors: check.errors, mode: 'VALIDATION_PREVIEW' }
    if (check.ok) process.exitCode = 1
  }
  const ebayRows = await prisma.channelListing.findMany({ where: { channel: 'EBAY', marketplace: 'IT', product: { deletedAt: null, sku: { in: ['AIRMESH-JACKET-BLACK-MEN-XL', '1J-EYE5-Y0TW', 'UD-LVLM-1H8T', 'xracing'] } } }, include: { product: true, channelConnection: true } })
  for (const listing of ebayRows) {
    const record: any = { sku: listing.product.sku, listingId: listing.id, accountId: listing.channelConnectionId, marketplace: 'IT', validationPreview: 'unsupported-by-inventory-api' }
    try {
      if (!listing.channelConnectionId) throw new Error('Missing account')
      const token = await getAccessToken(listing.channelConnectionId)
      const base = (listing.channelConnection?.connectionMetadata as any)?.environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
      const headers = { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US', 'Accept-Language': 'en-US' }
      const inventory = await fetch(`${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(listing.product.sku)}`, { headers, signal: AbortSignal.timeout(20_000) })
      const item: any = await inventory.json()
      const offers = await fetch(`${base}/sell/inventory/v1/offer?sku=${encodeURIComponent(listing.product.sku)}&marketplace_id=EBAY_IT`, { headers, signal: AbortSignal.timeout(20_000) })
      const offerBody: any = await offers.json()
      Object.assign(record, { inventoryStatus: inventory.status, inventorySkuMatches: item.sku === listing.product.sku,
        titleLength: item.product?.title?.length ?? null, descriptionPresent: !!item.product?.description,
        aspectNames: Object.keys(item.product?.aspects ?? {}), offerStatus: offers.status,
        categories: [...new Set((offerBody.offers ?? []).filter((o: any) => o.sku === listing.product.sku && o.marketplaceId === 'EBAY_IT').map((o: any) => o.categoryId))] })
    } catch (error: any) { record.error = String(error?.message ?? error) }
    report.ebay.push(record)
    console.log(JSON.stringify(record))
  }
  await writeFile('/tmp/nexus-live-mapping-validation.json', JSON.stringify(report, null, 2) + '\n')
  if (report.amazon.some((r: any) => !r.ok)) process.exitCode = 1
} catch (error: any) { console.error(error?.code ?? error?.message ?? 'validation_failed'); process.exitCode = 1 }
finally { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) }
