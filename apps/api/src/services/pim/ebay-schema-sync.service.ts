/**
 * eBay GetCategorySpecifics → ChannelSchema.
 *
 * The built-in eBay seed only covers the 7 listing fields (title/description/
 * condition/…). This pulls the REAL per-category Item Aspects from eBay's
 * Taxonomy API (reusing EbayCategoryService.getCategoryAspectsRich) for every
 * eBay category the marketplace's listings actually use, and unions them into
 * ChannelSchema so the mapping matrix + rule editor get the full aspect set.
 *
 * Aspect fieldKeys + labels use the ENGLISH aspect name (englishName, fetched
 * by the service with Accept-Language: en-US) so operators who don't read the
 * marketplace language can still map them, and so the same aspect keys line up
 * across markets (aspect_Brand on IT == aspect_Brand on DE).
 *
 * Writes use a non-null marketplace, so the plain (channel, marketplace,
 * fieldKey) unique index makes the upsert idempotent (no dup on re-sync).
 */

import prisma from '../../db.js'
import { EbayCategoryService } from '../ebay-category.service.js'

export async function syncEbayCategoryAspects(marketplace: string): Promise<{
  upserted: number
  categories: number
  aspects: number
}> {
  // 1. Distinct eBay leaf categories actually used by this marketplace's
  //    listings (platformAttributes.categoryId, set by the EC.4 Category tab).
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', marketplace },
    select: { platformAttributes: true },
  })
  const categoryIds = [
    ...new Set(
      listings
        .map((l) => (l.platformAttributes as { categoryId?: unknown } | null)?.categoryId)
        .filter((c): c is string => typeof c === 'string' && c.length > 0),
    ),
  ]
  if (categoryIds.length === 0) return { upserted: 0, categories: 0, aspects: 0 }

  // 2. Fetch + union aspects across those categories (prefer the English name).
  const svc = new EbayCategoryService()
  const byKey = new Map<
    string,
    { fieldKey: string; label: string; maxLength: number | null; required: boolean; allowedValues: string[] | null; notes: string | null }
  >()
  for (const categoryId of categoryIds) {
    let aspects
    try {
      aspects = await svc.getCategoryAspectsRich(categoryId, marketplace)
    } catch {
      continue // best-effort per category; one bad category shouldn't fail the sync
    }
    for (const a of aspects) {
      const english = a.englishName || a.name
      const fieldKey = `aspect_${english}`
      if (byKey.has(fieldKey)) continue
      const noteBits: string[] = []
      if (a.usage) noteBits.push(a.usage)
      if (a.cardinality === 'MULTI') noteBits.push('multi-value')
      if (a.variantEligible) noteBits.push('variant')
      if (a.englishName && a.name !== a.englishName) noteBits.push(`eBay: ${a.name}`)
      byKey.set(fieldKey, {
        fieldKey,
        label: english,
        maxLength: a.maxLength ?? null,
        required: !!a.required,
        allowedValues: a.mode === 'SELECTION_ONLY' && a.values.length > 0 ? a.values : null,
        notes: noteBits.length ? noteBits.join(' · ') : null,
      })
    }
  }

  // 3. Upsert into ChannelSchema (EBAY, marketplace, aspect_<EnglishName>).
  let upserted = 0
  for (const f of byKey.values()) {
    await prisma.channelSchema.upsert({
      where: { channel_marketplace_fieldKey: { channel: 'EBAY', marketplace, fieldKey: f.fieldKey } },
      create: {
        channel: 'EBAY',
        marketplace,
        fieldKey: f.fieldKey,
        label: f.label,
        maxLength: f.maxLength,
        required: f.required,
        allowedValues: f.allowedValues as object | null,
        notes: f.notes,
      },
      update: {
        label: f.label,
        maxLength: f.maxLength,
        required: f.required,
        allowedValues: f.allowedValues as object | null,
        notes: f.notes,
      },
    })
    upserted++
  }
  return { upserted, categories: categoryIds.length, aspects: byKey.size }
}
