/**
 * W3.10 — ChannelReadinessService (Salsify cornerstone).
 *
 * "Is this product ready to publish on Channel X?" — per-channel
 * score + missing-field list, used by the readiness UI to surface
 * "47/50 ready on Amazon" badges and "Add bullet_4" quick-fix
 * actions.
 *
 * Two scoring paths:
 *
 *   1. Family path (preferred). Product has a familyId → reuse
 *      FamilyCompletenessService.compute() which already returns
 *      byChannel scores via the W2.4 hierarchy resolver. The
 *      family declares which attrs are required per channel; this
 *      service just surfaces that data with channel-friendly
 *      labels.
 *
 *   2. Fallback path (no family). For products without a family,
 *      we don't know which attrs apply, so we use a hard-coded
 *      per-channel minimum-fields list (brand, gtin, description,
 *      photos, etc.). This matches operator expectations without
 *      requiring every product to be familied first.
 *
 * The fallback list is intentionally thin — it's a "is the product
 * vaguely listable?" gate, not a comprehensive Amazon/eBay/Shopify
 * required-attribute matrix. Wave 4+ will add per-marketplace
 * validators driven by category schemas. For now operator gets a
 * clear signal that switches over to the rich family-driven score
 * once they categorise the product.
 *
 * Score semantics:
 *   100 — every required field has a value
 *   N   — N% of required fields filled (round)
 *   0   — nothing filled (or no requirements known)
 *
 * Output is the same shape regardless of path so callers don't
 * need to branch on familyId.
 */

import type { PrismaClient } from '@prisma/client'
import prisma from '../db.js'
import {
  familyCompletenessService,
} from './family-completeness.service.js'

export type ChannelCode = 'AMAZON' | 'EBAY' | 'SHOPIFY'

export const ACTIVE_CHANNELS: readonly ChannelCode[] = [
  'AMAZON',
  'EBAY',
  'SHOPIFY',
] as const

export interface ChannelReadinessRow {
  channel: ChannelCode
  score: number
  filled: number
  totalRequired: number
  missing: Array<{
    /** Attribute identifier — when family-driven, this is the
     *  CustomAttribute.id; when fallback, it's the hard-coded
     *  field key ('brand', 'gtin', 'photos'). */
    key: string
    /** Human label for the missing field (e.g., "GTIN", "Brand"). */
    label: string
    /** Source — 'family' when it came from a FamilyAttribute, or
     *  'channel_minimum' for the no-family fallback. */
    source: 'family' | 'channel_minimum'
  }>
}

export interface ChannelReadinessResult {
  productId: string
  /** Per-channel rows, one per ACTIVE_CHANNELS member. */
  channels: ChannelReadinessRow[]
  /** Headline = average of the per-channel scores. Useful for the
   *  grid column rollup; the per-channel breakdown lives in the
   *  drawer. */
  averageScore: number
  /** True when the product has a family + we used the rich family
   *  path. False when we fell back to channel minimums. */
  familyDriven: boolean
}

/**
 * Hard-coded per-channel minimum-field checks for the no-family
 * fallback path. Each entry is a key + label + a function that
 * decides whether the field is filled given the product row +
 * counts.
 *
 * The list is intentionally lean — see file header.
 */
interface ProductForFallback {
  brand: string | null
  productType: string | null
  description: string | null
  gtin: string | null
  upc: string | null
  ean: string | null
  basePrice: { toString(): string } | number
  weightValue: { toString(): string } | number | null
  imageCount: number
}

interface FallbackField {
  key: string
  label: string
  isFilledFor(p: ProductForFallback): boolean
}

const HAS_GTIN: FallbackField['isFilledFor'] = (p) =>
  !!(p.gtin || p.upc || p.ean)

const HAS_DESCRIPTION: FallbackField['isFilledFor'] = (p) =>
  !!p.description && p.description.trim().length > 50

const HAS_PHOTOS: FallbackField['isFilledFor'] = (p) => p.imageCount > 0

const HAS_BRAND: FallbackField['isFilledFor'] = (p) =>
  !!p.brand && p.brand.trim().length > 0

const HAS_TYPE: FallbackField['isFilledFor'] = (p) =>
  !!p.productType && p.productType.trim().length > 0

const HAS_WEIGHT: FallbackField['isFilledFor'] = (p) =>
  p.weightValue != null && Number(p.weightValue) > 0

const HAS_PRICE: FallbackField['isFilledFor'] = (p) => Number(p.basePrice) > 0

export const FALLBACK_FIELDS_BY_CHANNEL: Record<ChannelCode, FallbackField[]> = {
  AMAZON: [
    { key: 'brand', label: 'Brand', isFilledFor: HAS_BRAND },
    { key: 'productType', label: 'Product type', isFilledFor: HAS_TYPE },
    { key: 'gtin', label: 'GTIN / UPC / EAN', isFilledFor: HAS_GTIN },
    { key: 'description', label: 'Description (50+ chars)', isFilledFor: HAS_DESCRIPTION },
    { key: 'photos', label: 'At least 1 photo', isFilledFor: HAS_PHOTOS },
    { key: 'weight', label: 'Weight', isFilledFor: HAS_WEIGHT },
    { key: 'price', label: 'Base price > 0', isFilledFor: HAS_PRICE },
  ],
  EBAY: [
    { key: 'brand', label: 'Brand', isFilledFor: HAS_BRAND },
    { key: 'description', label: 'Description (50+ chars)', isFilledFor: HAS_DESCRIPTION },
    { key: 'photos', label: 'At least 1 photo', isFilledFor: HAS_PHOTOS },
    { key: 'price', label: 'Base price > 0', isFilledFor: HAS_PRICE },
  ],
  SHOPIFY: [
    { key: 'description', label: 'Description', isFilledFor: HAS_DESCRIPTION },
    { key: 'photos', label: 'At least 1 photo', isFilledFor: HAS_PHOTOS },
    { key: 'price', label: 'Base price > 0', isFilledFor: HAS_PRICE },
  ],
}

export class ChannelReadinessService {
  constructor(private readonly client: PrismaClient = prisma) {}

  async compute(productId: string): Promise<ChannelReadinessResult> {
    const product = await this.client.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        familyId: true,
        brand: true,
        productType: true,
        description: true,
        gtin: true,
        upc: true,
        ean: true,
        basePrice: true,
        weightValue: true,
        _count: { select: { images: true } },
      },
    })
    if (!product) {
      throw new Error(
        `ChannelReadinessService: product ${productId} not found`,
      )
    }

    if (product.familyId) {
      // Family path — reuse W2.14 byChannel scoring.
      const completeness = await familyCompletenessService.compute(productId)
      // Resolve missing-attribute labels in one round-trip.
      const missingIds = completeness.missing.map((m) => m.attributeId)
      const labelLookup = missingIds.length
        ? await this.client.customAttribute.findMany({
            where: { id: { in: missingIds } },
            select: { id: true, label: true },
          })
        : []
      const labelById = new Map(labelLookup.map((a) => [a.id, a.label]))

      const channels: ChannelReadinessRow[] = ACTIVE_CHANNELS.map((ch) => {
        const bc =
          completeness.byChannel[ch] ??
          completeness.byChannel.all
        // Missing list filtered to attrs that apply to this channel.
        // We don't have per-attr channel info on `missing` here, so
        // fall back to "the global missing list" for the per-channel
        // surface. This is conservative — surfaces a missing attr on
        // every channel even if it's only required on Amazon. Wave
        // 4+ refines via FamilyAttribute.channels lookup.
        const missing = completeness.missing.map((m) => ({
          key: m.attributeId,
          label: labelById.get(m.attributeId) ?? m.attributeId,
          source: 'family' as const,
        }))
        return {
          channel: ch,
          score: bc.score,
          filled: bc.filled,
          totalRequired: bc.totalRequired,
          missing,
        }
      })

      const averageScore = Math.round(
        channels.reduce((acc, c) => acc + c.score, 0) /
          Math.max(channels.length, 1),
      )

      return {
        productId,
        channels,
        averageScore,
        familyDriven: true,
      }
    }

    // Fallback path — hard-coded per-channel minimums.
    const projected: ProductForFallback = {
      brand: product.brand,
      productType: product.productType,
      description: product.description,
      gtin: product.gtin,
      upc: product.upc,
      ean: product.ean,
      basePrice: product.basePrice as never,
      weightValue: product.weightValue as never,
      imageCount: product._count.images,
    }

    const channels: ChannelReadinessRow[] = ACTIVE_CHANNELS.map((ch) => {
      const fields = FALLBACK_FIELDS_BY_CHANNEL[ch]
      const missing: ChannelReadinessRow['missing'] = []
      let filled = 0
      for (const f of fields) {
        if (f.isFilledFor(projected)) filled++
        else
          missing.push({
            key: f.key,
            label: f.label,
            source: 'channel_minimum',
          })
      }
      const total = fields.length
      return {
        channel: ch,
        score: total === 0 ? 100 : Math.round((filled / total) * 100),
        filled,
        totalRequired: total,
        missing,
      }
    })

    const averageScore = Math.round(
      channels.reduce((acc, c) => acc + c.score, 0) /
        Math.max(channels.length, 1),
    )

    return {
      productId,
      channels,
      averageScore,
      familyDriven: false,
    }
  }
}

export const channelReadinessService = new ChannelReadinessService()
