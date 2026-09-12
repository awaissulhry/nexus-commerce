/** Shopify wizard publication shares the editor's native-family resolver and verified GraphQL publisher. */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { listActiveConnections, chooseConnection } from '../connection-resolver.service.js'
import { getContentWorkspace, saveContentWorkspace, object } from '../shopify/content-workspace.service.js'
import { previewContentSync, synchronizeContent } from '../shopify/content-sync.service.js'

interface ShopifyPayload {
  nexusProductId?: string; familyError?: string; axes?: string[]
  product: { title: string; body_html: string; vendor?: string; product_type?: string; tags?: string[]; status: string;
    variants: { nexusId?: string; sku: string; price: string; compare_at_price?: string; inventory_quantity?: number; options?: Record<string, string> }[]; images?: { src: string }[] }
}
export interface ShopifyPublishResult { ok: boolean; productId?: string; listingUrl?: string; firstVariantId?: string; variantCount?: number; error?: string; failedStep?: string }

export class ShopifyPublishAdapter {
  async publish(payload: ShopifyPayload): Promise<ShopifyPublishResult> {
    try {
      if (payload.familyError) throw new Error(payload.familyError)
      if (!payload.nexusProductId || !payload.product?.title || !payload.product.variants?.length) throw new Error('Compose the complete Shopify family before publishing.')
      // The legacy wizard has no account picker. Only a single unambiguous Shopify account is permitted.
      const accounts = await listActiveConnections('SHOPIFY')
      const account = chooseConnection(accounts, { channel: 'SHOPIFY' })
      const scope = { accountId: account.id, market: 'GLOBAL' }
      let workspace = await getContentWorkspace(payload.nexusProductId, scope)
      const expectedSkus = payload.product.variants.map(v => v.sku).sort()
      if (JSON.stringify(expectedSkus) !== JSON.stringify(workspace.variants.map(v => v.sku).sort())) throw new Error('The family changed after wizard composition. Refresh the wizard before publishing.')
      // Independent child prices and stock always come from the current canonical offer records.
      for (const variant of payload.product.variants) {
        const current = workspace.variants.find(v => v.sku === variant.sku)!
        if (workspace.variants.length > 1 && (Number(current.price) !== Number(variant.price) || current.stock !== variant.inventory_quantity)) throw new Error(`Price or inventory for ${variant.sku} changed. Refresh and review it in Shopify family content.`)
      }
      if (!workspace.initialized) {
        const draft = workspace.draft
        if (payload.product.images?.length) {
          draft.assets = [...new Set(payload.product.images.map(i => i.src))].map((url, index) => ({ id: `wizard-${index}`, url, alt: '', translations: {} }))
          draft.groups = [{ id: 'family-gallery', name: 'Family gallery', assetIds: draft.assets.map(a => a.id), featuredId: draft.assets[0]?.id ?? null }]
          draft.assignments[0].gallery = { mode: 'replace', groupIds: ['family-gallery'], featuredId: null }
        }
        workspace = await saveContentWorkspace(payload.nexusProductId, scope, { draft, expectedRevision: workspace.revision })
      }
      const listingId = workspace.destination.listingId!
      await prisma.$transaction(async tx => {
        const listing = await tx.channelListing.findUnique({ where: { id: listingId } })
        if (!listing || listing.channelConnectionId !== account.id) throw new Error('The Shopify listing destination changed.')
        const pa = object(listing.platformAttributes)
        if (pa._nexusContentPublish?.status === 'PUBLISHING') throw new Error('A Shopify synchronisation is already running.')
        await tx.channelListing.update({ where: { id: listingId }, data: { followMasterTitle: false, followMasterDescription: false, titleOverride: payload.product.title, descriptionOverride: payload.product.body_html,
          ...(workspace.variants.length === 1 ? { followMasterPrice: false, priceOverride: payload.product.variants[0].price, followMasterQuantity: false, quantityOverride: payload.product.variants[0].inventory_quantity } : {}),
          platformAttributes: { ...pa, ...(workspace.variants.length === 1 && payload.product.variants[0].compare_at_price !== undefined ? { shopifyCompareAtPrice: payload.product.variants[0].compare_at_price } : {}), tags: payload.product.tags ?? [], shopifyVendor: payload.product.vendor, shopifyProductType: payload.product.product_type } as Prisma.InputJsonValue, version: { increment: 1 } } })
      }, { isolationLevel: 'Serializable' })
      const preview = await previewContentSync(payload.nexusProductId, scope, true)
      if (preview.remote && preview.remote.status !== 'DRAFT') throw new Error('This Shopify product already exists outside draft status. Review and synchronise it from Shopify family content.')
      const locationId = preview.locations.length === 1 ? preview.locations[0].id : null
      if (!locationId) throw new Error('Choose the Shopify inventory location in the family content review. The complete wizard draft is saved in Nexus.')
      const result = await synchronizeContent(payload.nexusProductId, scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId })
      return { ok: true, productId: result.productId.split('/').at(-1), listingUrl: `https://${preview.domain}/admin/products/${result.productId.split('/').at(-1)}`,
        firstVariantId: Object.values(result.variantIds)[0]?.split('/').at(-1), variantCount: Object.keys(result.variantIds).length }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), failedStep: 'family-sync' } }
  }
}
