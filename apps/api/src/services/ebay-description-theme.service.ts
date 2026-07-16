/**
 * ED.1/ED.2 (eBay dynamic descriptions) — theme storage + render orchestration.
 *
 * The flat file's per-market description stays the operator's BODY copy
 * (ChannelListing.description, one row per market — the P9e model). Themes
 * wrap that body at PUSH time; nothing here ever rewrites the stored body.
 *
 * Assignment: ChannelListing.platformAttributes.descriptionThemeId on the
 * market's own row — so a listing can use a different theme per market.
 *   themeId string → that theme;  'none' → raw body even when a default
 *   exists;  absent → the global default theme (isDefault), else raw body.
 *
 * Invariant: rendering must NEVER block a push — any error falls back to the
 * raw body and reports a warning.
 */

import type { PrismaClient } from '@prisma/client'
import {
  renderDescriptionTheme,
  BUILT_IN_THEMES,
  type DescriptionRenderData,
  type DescriptionGalleryGroup,
} from './ebay-description-render.js'

export interface RenderListingDescriptionArgs {
  productId: string
  /** Flat-file market code (IT/DE/FR/ES/UK…). UK maps to region GB like P9e. */
  marketplace: string
  mode: 'single' | 'group'
  /** The already-resolved per-market body (push sites have it in hand). */
  body: string
  title?: string
  subtitle?: string
  sku?: string
  /** Business-policy display names when the push site has them resolved. */
  policies?: { shipping?: string; returns?: string; payment?: string }
  /** Preview-only: try a specific theme instead of the listing's assignment. */
  themeIdOverride?: string
}

export interface RenderListingDescriptionResult {
  html: string
  themed: boolean
  themeId?: string
  themeName?: string
  warnings: string[]
}

const regionOf = (mp: string): string => (mp.toUpperCase() === 'UK' ? 'GB' : mp.toUpperCase())

// ── Theme CRUD ───────────────────────────────────────────────────────────────

/** Insert the starter themes that don't exist yet (never overwrites edits). */
export async function ensureBuiltInThemes(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.ebayDescriptionTheme.findMany({ select: { name: true } })
  const have = new Set(existing.map((t) => t.name))
  for (const t of BUILT_IN_THEMES) {
    if (have.has(t.name)) continue
    await prisma.ebayDescriptionTheme.create({
      data: { name: t.name, notes: t.notes, html: t.html, builtIn: true },
    })
  }
}

export async function listThemes(prisma: PrismaClient) {
  await ensureBuiltInThemes(prisma)
  return prisma.ebayDescriptionTheme.findMany({ orderBy: [{ builtIn: 'desc' }, { name: 'asc' }] })
}

export async function setDefaultTheme(prisma: PrismaClient, id: string | null) {
  await prisma.$transaction(async (tx) => {
    await tx.ebayDescriptionTheme.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    if (id) await tx.ebayDescriptionTheme.update({ where: { id }, data: { isDefault: true } })
  })
}

// ── Render-data assembly ─────────────────────────────────────────────────────

/**
 * Mirror of the canonical curated-gallery resolution
 * (images/ebay-inventory-image-publish.service.ts): shared gallery =
 * ListingImage rows with no group key; per-group galleries keyed by
 * variantGroupValue; per-SKU pins via variationId. Falls back to the master
 * ProductImage gallery when nothing is curated.
 */
async function loadGalleries(prisma: PrismaClient, productId: string, sku?: string): Promise<{
  shared: string[]
  byGroup: DescriptionGalleryGroup[]
  rowImages?: string[]
}> {
  const curated = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true },
  })
  const shared: string[] = []
  const groups = new Map<string, string[]>()
  const byVariationId = new Map<string, string[]>()
  for (const r of curated) {
    if (r.variationId) {
      if (!byVariationId.has(r.variationId)) byVariationId.set(r.variationId, [])
      byVariationId.get(r.variationId)!.push(r.url)
    } else if (r.variantGroupKey && r.variantGroupValue) {
      const key = r.variantGroupValue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r.url)
    } else {
      shared.push(r.url)
    }
  }

  let rowImages: string[] | undefined
  if (sku) {
    const variant = await prisma.product.findFirst({ where: { sku }, select: { id: true, variantAttributes: true } })
    if (variant && byVariationId.has(variant.id)) {
      rowImages = byVariationId.get(variant.id)
    } else if (variant) {
      // match the variant's own group by any axis value it carries
      const attrs = (variant.variantAttributes ?? {}) as Record<string, unknown>
      for (const v of Object.values(attrs)) {
        const hit = typeof v === 'string' ? groups.get(v) : undefined
        if (hit && hit.length > 0) {
          rowImages = hit
          break
        }
      }
    }
    if (!rowImages || rowImages.length === 0) rowImages = shared.length > 0 ? shared : undefined
  }

  if (shared.length === 0 && groups.size === 0) {
    // nothing curated for eBay — fall back to the master gallery
    const master = await prisma.productImage.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
      select: { url: true },
      take: 12,
    })
    return { shared: master.map((m) => m.url), byGroup: [], rowImages: rowImages ?? master.map((m) => m.url) }
  }
  return {
    shared,
    byGroup: [...groups.entries()].map(([value, urls]) => ({ value, urls })),
    rowImages,
  }
}

/** Item specifics from the market row's snapshot (aspect_* keys, deduped). */
function aspectsFromSnapshot(snapshot: unknown): Array<{ name: string; value: string }> {
  if (!snapshot || typeof snapshot !== 'object') return []
  const out = new Map<string, { name: string; value: string }>()
  for (const [key, val] of Object.entries(snapshot as Record<string, unknown>)) {
    if (!key.startsWith('aspect_') || typeof val !== 'string' || !val.trim()) continue
    const display = key.slice('aspect_'.length).replace(/_/g, ' ')
    const lk = display.toLowerCase()
    // buildFlatRow writes both cased and lowercase keys — prefer the cased one.
    const existing = out.get(lk)
    if (!existing || (existing.name === existing.name.toLowerCase() && display !== lk)) {
      out.set(lk, { name: display, value: val.trim() })
    }
  }
  return [...out.values()]
}

// ── The safe entry point every push site calls ───────────────────────────────

export async function renderListingDescriptionSafe(
  prisma: PrismaClient,
  args: RenderListingDescriptionArgs,
): Promise<RenderListingDescriptionResult> {
  const raw: RenderListingDescriptionResult = { html: args.body ?? '', themed: false, warnings: [] }
  try {
    const region = regionOf(args.marketplace)
    const listing = await prisma.channelListing.findFirst({
      where: { productId: args.productId, channel: 'EBAY', region },
      select: { title: true, description: true, platformAttributes: true, flatFileSnapshot: true },
    })
    const attrs = (listing?.platformAttributes ?? {}) as Record<string, unknown>
    const assigned = typeof attrs.descriptionThemeId === 'string' ? attrs.descriptionThemeId : undefined

    let themeId = args.themeIdOverride ?? assigned
    if (themeId === 'none') return raw
    let theme = themeId
      ? await prisma.ebayDescriptionTheme.findUnique({ where: { id: themeId } })
      : null
    if (!theme && !args.themeIdOverride) {
      theme = await prisma.ebayDescriptionTheme.findFirst({ where: { isDefault: true, active: true } })
    }
    if (!theme || !theme.active) return raw

    const galleries = await loadGalleries(prisma, args.productId, args.sku)
    const data: DescriptionRenderData = {
      market: args.marketplace.toUpperCase(),
      title: args.title ?? listing?.title ?? '',
      subtitle: args.subtitle ?? (typeof attrs.subtitle === 'string' ? attrs.subtitle : undefined),
      body: args.body ?? listing?.description ?? '',
      sku: args.sku,
      brand: aspectsFromSnapshot(listing?.flatFileSnapshot).find((a) =>
        ['marca', 'marke', 'marque', 'brand'].includes(a.name.toLowerCase()),
      )?.value,
      mode: args.mode,
      sharedImages: galleries.shared,
      imagesByGroup: galleries.byGroup,
      rowImages: galleries.rowImages,
      aspects: aspectsFromSnapshot(listing?.flatFileSnapshot),
      policies: args.policies,
    }
    const rendered = renderDescriptionTheme(theme.html, data)
    return { html: rendered.html, themed: true, themeId: theme.id, themeName: theme.name, warnings: rendered.warnings }
  } catch (err) {
    raw.warnings.push(
      `description theme render failed — pushed the raw body (${err instanceof Error ? err.message : String(err)})`,
    )
    return raw
  }
}
