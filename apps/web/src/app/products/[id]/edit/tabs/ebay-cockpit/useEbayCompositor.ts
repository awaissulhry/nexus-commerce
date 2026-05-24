// EC.1 — useEbayCompositor
//
// Reads the in-memory product + active eBay ChannelListing and folds them
// into a single ComposedListing the preview / cards can render against.
//
// EC.1 deliberately keeps the read surface local: it only walks props
// the parent has already fetched (`product`, `listing`, `marketInfo`).
// Cross-tab data sources (LocalesTab, ImagesTab live state, MatrixTab
// edits in flight) land in EC.3 alongside the cross-tab SSE pipe.

import { useMemo } from 'react'
import type { ComposedField, ComposedListing, FieldSource } from './types'

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
  htmlDescriptionOverride?: string | null
  price?: string | number | null
  priceOverride?: string | number | null
  quantity?: number | null
  quantityOverride?: number | null
  followMasterTitle?: boolean
  followMasterDescription?: boolean
  followMasterPrice?: boolean
  followMasterQuantity?: boolean
  followMasterImages?: boolean
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

function pickGallery(images?: ProductLike['images'], limit = 6): string[] {
  if (!images || images.length === 0) return []
  return [...images]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .slice(0, limit)
    .map((i) => i.url)
}

function conditionLabelFromId(id: unknown): string {
  // eBay condition IDs: https://developer.ebay.com/api-docs/sell/static/metadata/condition-ids.html
  const map: Record<string, string> = {
    '1000': 'New',
    '1500': 'New other',
    '1750': 'New with defects',
    '2000': 'Certified refurbished',
    '2500': 'Seller refurbished',
    '3000': 'Used',
    '4000': 'Very Good',
    '5000': 'Good',
    '6000': 'Acceptable',
    '7000': 'For parts or not working',
  }
  if (id == null) return 'New'
  return map[String(id)] ?? 'New'
}

export function useEbayCompositor({
  product,
  listing,
  marketInfo,
  children = [],
}: Args): ComposedListing {
  return useMemo<ComposedListing>(() => {
    const platform = (listing?.platformAttributes ?? {}) as Record<string, unknown>

    // Title — explicit override beats listing.title beats master.name.
    let titleField: ComposedField<string>
    if (listing?.titleOverride) {
      titleField = field(listing.titleOverride, 'manual')
    } else if (listing?.followMasterTitle === false && listing?.title) {
      titleField = field(listing.title, 'manual')
    } else if (listing?.title) {
      titleField = field(listing.title, listing.followMasterTitle === false ? 'manual' : 'master')
    } else {
      titleField = field(product.name ?? '', 'master')
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

    const htmlField: ComposedField<string | null> = field(
      listing?.htmlDescriptionOverride ?? null,
      listing?.htmlDescriptionOverride ? 'manual' : 'default',
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

    // Condition (eBay-specific, lives on platformAttributes).
    const conditionField: ComposedField<string> = field(
      conditionLabelFromId(platform.conditionId),
      platform.conditionId ? 'manual' : 'default',
    )

    // Category (eBay-specific, also lives on platformAttributes).
    const categoryIdField: ComposedField<string | null> = field(
      (platform.categoryId as string | null) ?? null,
      platform.categoryId ? 'manual' : 'default',
    )
    const categoryLabelField: ComposedField<string | null> = field(
      (platform.categoryName as string | null) ?? null,
      platform.categoryName ? 'manual' : 'default',
    )

    // Brand.
    const brandField: ComposedField<string | null> = field(
      product.brand ?? null,
      product.brand ? 'master' : 'default',
    )

    // Variation summary — just counters and axes for EC.1; EC.6 builds
    // the matrix off the same shape.
    const variationSummary = {
      axes: product.variationAxes ?? [],
      variantCount: children.length,
      publishedVariantCount: children.filter((c) => c.isPublished).length,
    }

    // Stale check.
    const masterIsNewer = (() => {
      if (!product.updatedAt || !listing?.updatedAt) return false
      return new Date(product.updatedAt) > new Date(listing.updatedAt)
    })()

    // Public eBay URL guess from itemId. eBay's per-site item URLs follow
    // https://www.ebay.<tld>/itm/<itemId> — the domain comes from
    // marketInfo.domainUrl set by the Marketplace seed.
    const publicUrl = (() => {
      if (!listing?.externalListingId) return listing?.listingUrl ?? null
      const domain = marketInfo.domainUrl?.replace(/\/$/, '')
      if (!domain) return listing.listingUrl ?? null
      return `${domain}/itm/${listing.externalListingId}`
    })()

    return {
      title: titleField,
      description: descField,
      htmlDescription: htmlField,
      price: priceField,
      currency: marketInfo.currency,
      quantity: quantityField,
      primaryImageUrl: primaryImgField,
      galleryUrls: galleryField,
      conditionLabel: conditionField,
      categoryId: categoryIdField,
      categoryLabel: categoryLabelField,
      brand: brandField,
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
        externalListingId: listing?.externalListingId ?? null,
        publicUrl,
      },
      variationSummary,
      healthHints: {
        masterIsNewer,
        titleLength: titleField.value.length,
        descriptionLength: descField.value.length,
      },
    }
  }, [product, listing, marketInfo, children])
}
