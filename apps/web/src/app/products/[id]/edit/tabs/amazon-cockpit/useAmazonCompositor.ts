// AC.1 — useAmazonCompositor.
//
// Folds the in-memory product + active Amazon ChannelListing into a
// single ComposedAmazonListing the preview / cards can render against.
//
// AC.1 walks parent-fetched props (`product`, `listing`, `marketInfo`).
// AC.5 layers the in-page draft bus on top so unsaved edits in
// MasterDataTab (and later ImagesTab / LocalesTab / MatrixTab) feed
// straight into the preview + health panel WITHOUT a save. Cross-
// window updates ride a separate rail (SSE + invalidation channel)
// already plumbed by ProductEditClient.

import { useMemo } from 'react'
import type { ComposedAmazonListing, ComposedField, FieldSource } from './types'
import { useProductDraft } from '../../_shared/draft-bus/useProductDraftBus'

interface MarketInfo {
  code: string
  name: string
  currency: string
  language: string
  domainUrl?: string | null
}

interface Listing {
  id?: string
  title?: string | null
  titleOverride?: string | null
  description?: string | null
  descriptionOverride?: string | null
  bulletPointsOverride?: string[] | null
  price?: string | number | null
  priceOverride?: string | number | null
  quantity?: number | null
  quantityOverride?: number | null
  followMasterTitle?: boolean
  followMasterDescription?: boolean
  followMasterPrice?: boolean
  followMasterQuantity?: boolean
  isPublished?: boolean
  listingStatus?: string
  externalListingId?: string | null
  listingUrl?: string | null
  platformAttributes?: Record<string, unknown> | null
  updatedAt?: string | null
}

interface ProductLike {
  id: string
  sku: string
  name?: string | null
  description?: string | null
  brand?: string | null
  basePrice?: string | number | null
  productType?: string | null
  amazonAsin?: string | null
  gtin?: string | null
  upc?: string | null
  ean?: string | null
  images?: Array<{ url: string; type?: string; sortOrder?: number; isPrimary?: boolean }>
  variationAxes?: string[]
  updatedAt?: string | null
}

interface ChildLike {
  id: string
  isPublished?: boolean
}

interface Args {
  product: ProductLike
  listing: Listing | undefined
  marketInfo: MarketInfo
  children?: ChildLike[]
}

function field<T>(value: T, source: FieldSource): ComposedField<T> {
  return { value, source }
}

function pickPrimaryImage(images?: ProductLike['images']): string | null {
  if (!images || images.length === 0) return null
  const explicit = images.find((i) => i.isPrimary)
  if (explicit) return explicit.url
  const main = [...images]
    .filter((i) => (i.type ?? '').toUpperCase() === 'MAIN')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
  if (main) return main.url
  return images[0]?.url ?? null
}

function pickGallery(images?: ProductLike['images'], limit = 9): string[] {
  // Amazon allows up to 9 images per ASIN (1 main + 8 alts); the
  // cockpit preview echoes that cap. The IE-series channel strip in
  // AC.5 will refine selection further (color-locked per child).
  if (!images || images.length === 0) return []
  return [...images]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .slice(0, limit)
    .map((i) => i.url)
}

function conditionLabelFromType(value: unknown): string {
  // Amazon condition_type enum (subset commonly used on apparel/gear).
  // Falls back to "New" because Xavia's catalogue is 100% new.
  const map: Record<string, string> = {
    new_new: 'New',
    new_open_box: 'New — open box',
    new_oem: 'New — OEM',
    refurbished_refurbished: 'Refurbished',
    used_like_new: 'Used — Like new',
    used_very_good: 'Used — Very good',
    used_good: 'Used — Good',
    used_acceptable: 'Used — Acceptable',
  }
  if (value == null) return 'New'
  return map[String(value)] ?? 'New'
}

export function useAmazonCompositor({
  product,
  listing,
  marketInfo,
  children = [],
}: Args): ComposedAmazonListing {
  // AC.5 — subscribe to the in-page draft bus so an unsaved keystroke
  // in MasterDataTab (or any other tab pushing to the bus) re-runs
  // the compositor and updates the preview + health panel live.
  const draft = useProductDraft(product.id)
  return useMemo<ComposedAmazonListing>(() => {
    const platform = (listing?.platformAttributes ?? {}) as Record<string, unknown>

    // AC.5 — overlay master draft fields onto the product props.
    // Empty string is treated as a real value (operator explicitly
    // cleared the field); undefined means no draft. The draft snapshot
    // is shallow-cloned in the bus so reads here are stable.
    const draftName = typeof draft.name === 'string' ? draft.name : undefined
    const draftBrand = typeof draft.brand === 'string' ? draft.brand : undefined
    const draftUpc = typeof draft.upc === 'string' ? draft.upc : undefined
    const draftEan = typeof draft.ean === 'string' ? draft.ean : undefined
    const effectiveProductName = draftName !== undefined ? draftName : product.name
    const effectiveProductBrand =
      draftBrand !== undefined ? draftBrand : product.brand
    const effectiveProductUpc = draftUpc !== undefined ? draftUpc : product.upc
    const effectiveProductEan = draftEan !== undefined ? draftEan : product.ean
    // AC.7 — CategoryCard pushes productType + browseNodeId drafts
    // when the operator clicks Apply on a suggestion. The compositor
    // mirrors them straight into the read so the preview, health
    // panel, and Variation Matrix theme chip all reflect the
    // suggestion immediately even before the operator saves.
    const draftProductType =
      typeof draft.productType === 'string' ? draft.productType : undefined
    const draftBrowseNode =
      typeof draft.browseNodeId === 'string' ? draft.browseNodeId : undefined

    // Title — override > listing.title > master.name (with AC.5
    // draft overlay applied above on effectiveProductName).
    let titleField: ComposedField<string>
    if (listing?.titleOverride) {
      titleField = field(listing.titleOverride, 'manual')
    } else if (listing?.followMasterTitle === false && listing?.title) {
      titleField = field(listing.title, 'manual')
    } else if (listing?.title) {
      titleField = field(listing.title, listing.followMasterTitle === false ? 'manual' : 'master')
    } else {
      titleField = field(effectiveProductName ?? '', 'master')
    }

    // Description.
    let descField: ComposedField<string>
    if (listing?.descriptionOverride) {
      descField = field(listing.descriptionOverride, 'manual')
    } else if (listing?.description) {
      descField = field(
        listing.description,
        listing.followMasterDescription === false ? 'manual' : 'master',
      )
    } else {
      descField = field(product.description ?? '', 'master')
    }

    // Bullet points — Amazon's 5-bullet block lives on
    // listing.bulletPointsOverride; if absent we surface an empty
    // array (master doesn't have a bullet field today).
    const bulletList = Array.isArray(listing?.bulletPointsOverride)
      ? listing!.bulletPointsOverride!.filter((s): s is string => typeof s === 'string')
      : []
    const bulletsField: ComposedField<string[]> = field(
      bulletList,
      bulletList.length > 0 ? 'manual' : 'default',
    )

    // Price.
    const priceNumber = (() => {
      const raw =
        listing?.priceOverride != null
          ? listing.priceOverride
          : listing?.price != null
          ? listing.price
          : product.basePrice
      if (raw == null || raw === '') return null
      const n = typeof raw === 'string' ? parseFloat(raw) : raw
      return Number.isFinite(n) ? n : null
    })()
    const priceSource: FieldSource =
      listing?.priceOverride != null
        ? 'manual'
        : listing?.price != null
        ? 'master'
        : product.basePrice != null
        ? 'master'
        : 'default'
    const priceField: ComposedField<number | null> = field(priceNumber, priceSource)

    // Quantity.
    const quantityNumber =
      listing?.quantityOverride ?? listing?.quantity ?? null
    const quantityField: ComposedField<number | null> = field(
      quantityNumber,
      listing?.quantityOverride != null
        ? 'manual'
        : listing?.quantity != null
        ? 'master'
        : 'default',
    )

    // Images.
    const primaryImageUrl = pickPrimaryImage(product.images)
    const gallery = pickGallery(product.images)
    const primaryImgField: ComposedField<string | null> = field(
      primaryImageUrl,
      primaryImageUrl ? 'master' : 'default',
    )
    const galleryField: ComposedField<string[]> = field(
      gallery,
      gallery.length > 0 ? 'master' : 'default',
    )

    // Catalogue identifiers.
    const asin = listing?.externalListingId ?? product.amazonAsin ?? null
    const asinField: ComposedField<string | null> = field(
      asin,
      asin ? (listing?.externalListingId ? 'manual' : 'master') : 'default',
    )

    const gtin =
      (platform.externally_assigned_product_identifier as string | null) ??
      product.gtin ??
      // AC.5 — draft overlay on UPC/EAN if MasterDataTab has unsaved
      // edits to either identifier.
      effectiveProductEan ??
      effectiveProductUpc ??
      null
    const gtinField: ComposedField<string | null> = field(
      gtin,
      gtin ? 'master' : 'default',
    )

    const productType =
      // AC.7 draft overlay beats listing + master.
      draftProductType ??
      (platform.productType as string | null) ??
      product.productType ??
      null
    const productTypeField: ComposedField<string | null> = field(
      productType,
      productType
        ? draftProductType !== undefined
          ? 'ai'
          : 'master'
        : 'default',
    )

    const browseNode =
      draftBrowseNode ??
      (platform.browseNodeId as string | null) ??
      (platform.browse_node_id as string | null) ??
      null
    const browseNodeField: ComposedField<string | null> = field(
      browseNode,
      browseNode
        ? draftBrowseNode !== undefined
          ? 'ai'
          : 'manual'
        : 'default',
    )

    const variationTheme = (platform.variation_theme as string | null) ??
      (platform.variationTheme as string | null) ?? null
    const variationThemeField: ComposedField<string | null> = field(
      variationTheme,
      variationTheme ? 'manual' : 'default',
    )

    // Brand — AC.5 draft overlay applied above.
    const brandField: ComposedField<string | null> = field(
      effectiveProductBrand ?? null,
      effectiveProductBrand ? 'master' : 'default',
    )

    // Fulfillment channel — pull from platformAttributes; otherwise
    // leave null and let AC.9 prompt the operator to pick.
    const fulfillmentRaw = (platform.fulfillment_channel as string | null) ??
      (platform.fulfillmentChannel as string | null) ?? null
    const fulfillment: 'FBA' | 'FBM' | null =
      fulfillmentRaw === 'AFN' || fulfillmentRaw === 'FBA'
        ? 'FBA'
        : fulfillmentRaw === 'MFN' || fulfillmentRaw === 'FBM' || fulfillmentRaw === 'MERCHANT'
        ? 'FBM'
        : null
    const fulfillmentField: ComposedField<'FBA' | 'FBM' | null> = field(
      fulfillment,
      fulfillment ? 'manual' : 'default',
    )

    // Condition type.
    const conditionField: ComposedField<string> = field(
      conditionLabelFromType(platform.condition_type ?? platform.conditionType),
      platform.condition_type || platform.conditionType ? 'manual' : 'default',
    )

    // Variation summary — counters and axes for AC.1; AC.6 builds the
    // full matrix off the same shape.
    const variationSummary = {
      axes: product.variationAxes ?? [],
      variantCount: children.length,
      publishedVariantCount: children.filter((c) => c.isPublished).length,
    }

    // A+ Content summary — placeholder until AC.8 wires the MC-series
    // module registry. Surfaces zero/NONE on the AC.1 card stub.
    const aplusSummary = {
      moduleCount: 0,
      brandStoryAttached: false,
      approvalStatus: 'NONE' as const,
    }

    // Stale check.
    const masterIsNewer = (() => {
      if (!product.updatedAt || !listing?.updatedAt) return false
      return new Date(product.updatedAt) > new Date(listing.updatedAt)
    })()

    // Public Amazon URL: https://www.amazon.<tld>/dp/<ASIN>, with the
    // domain from marketInfo.domainUrl set by the Marketplace seed.
    const publicUrl = (() => {
      if (!asin) return listing?.listingUrl ?? null
      const domain = marketInfo.domainUrl?.replace(/\/$/, '')
      if (!domain) return listing?.listingUrl ?? null
      return `${domain}/dp/${asin}`
    })()

    return {
      title: titleField,
      description: descField,
      bullets: bulletsField,
      price: priceField,
      currency: marketInfo.currency,
      quantity: quantityField,
      primaryImageUrl: primaryImgField,
      galleryUrls: galleryField,
      asin: asinField,
      gtin: gtinField,
      productType: productTypeField,
      browseNodeId: browseNodeField,
      variationTheme: variationThemeField,
      brand: brandField,
      fulfillmentChannel: fulfillmentField,
      conditionType: conditionField,
      sku: product.sku,
      marketplace: {
        code: marketInfo.code,
        name: marketInfo.name,
        currency: marketInfo.currency,
        language: marketInfo.language,
        domainUrl: marketInfo.domainUrl ?? null,
      },
      status: {
        isPublished: !!listing?.isPublished,
        listingStatus: listing?.listingStatus ?? 'DRAFT',
        externalListingId: asin,
        publicUrl,
      },
      variationSummary,
      aplusSummary,
      healthHints: {
        masterIsNewer,
        titleLength: titleField.value.length,
        descriptionLength: descField.value.length,
        bulletCount: bulletList.length,
        imageCount: gallery.length,
        hasGtin: !!gtin,
        hasBrand: !!effectiveProductBrand,
        hasProductType: !!productType,
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, listing, marketInfo, children, draft])
}
