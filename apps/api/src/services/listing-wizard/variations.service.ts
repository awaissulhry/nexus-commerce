/**
 * Step 5 — Variations.
 *
 * Pulls children for the master product and derives the variation
 * theme. The theme list comes from Amazon's variation_theme enum
 * (already cached on CategorySchema.variationThemes from D.3f). Each
 * theme requires a specific set of attributes per variation
 * (SIZE_COLOR → size + color); we surface validation status so the
 * user knows up front which children are submission-ready.
 *
 * The wizard doesn't edit variations here — that's what /products
 * does. This step is a confirm-and-pick: which theme to publish under,
 * which children to include in the listing.
 */

import type { PrismaClient } from '@nexus/database'
import { bundledThemesFor } from './product-types.constants.js'
import { EbayCategoryService } from '../ebay-category.service.js'

export interface VariationChild {
  id: string
  sku: string
  attributes: Record<string, string>
  price: number
  stock: number
  /** Whether this child's attributes satisfy the picked theme. Empty
   *  array when no theme is picked yet. */
  missingAttributes: string[]
}

export interface ThemeOption {
  /** Amazon's enum value, e.g. "SIZE_COLOR". */
  id: string
  /** Human display, e.g. "Size and Color". */
  label: string
  /** Lowercased attribute keys this theme requires per variation. */
  requiredAttributes: string[]
}

export interface VariationsPayload {
  isParent: boolean
  parentSku: string
  parentName: string
  themes: ThemeOption[]
  children: VariationChild[]
  /** Convenience: the union of attribute keys used across all
   *  children. Helps the frontend default-pick a theme. */
  presentAttributes: string[]
}

/**
 * Phase E — multi-channel variations payload.
 *
 * Per-channel theme lists (with intersection convenience), per-child
 * attribute-completeness annotations keyed by channel, and a list of
 * channels we couldn't fetch themes for (no productType selected, or
 * a non-Amazon channel without a wired schema source).
 */
export interface MultiChannelVariationsPayload {
  isParent: boolean
  parentSku: string
  parentName: string
  channels: Array<{
    platform: string
    marketplace: string
    productType: string
  }>
  /** ChannelKey ("PLATFORM:MARKET") → themes available for that
   *  channel. Channels with no themes are listed with an empty array. */
  themesByChannel: Record<string, ThemeOption[]>
  /** Themes supported by EVERY successfully-fetched channel — the
   *  recommended "applies everywhere" picks. Computed by intersection
   *  on theme.id. */
  commonThemes: ThemeOption[]
  /** Per-channel selected theme (from wizardState.channelStates[key].
   *  variations.theme). Used to annotate `children[].missingByChannel`. */
  selectedThemeByChannel: Record<string, string | null>
  children: MultiChannelVariationChild[]
  presentAttributes: string[]
  channelsMissingThemes: Array<{
    channelKey: string
    reason: 'no_product_type' | 'unsupported_channel' | 'no_themes_in_schema'
  }>
}

export interface MultiChannelVariationChild {
  id: string
  sku: string
  attributes: Record<string, string>
  price: number
  stock: number
  /** ChannelKey → list of attributes this child is missing for the
   *  theme selected on that channel. Empty array when no theme picked
   *  yet OR when the child satisfies the theme. */
  missingByChannel: Record<string, string[]>
}

const KNOWN_THEME_LABELS: Record<string, string> = {
  SIZE_COLOR: 'Size and Color',
  COLOR_SIZE: 'Color and Size',
  SIZE_NAME: 'Size',
  COLOR_NAME: 'Color',
  SIZE: 'Size',
  COLOR: 'Color',
  SIZE_COLOR_NAME: 'Size and Color',
  COLOR_NAME_SIZE_NAME: 'Color and Size',
  STYLE: 'Style',
  STYLE_NAME: 'Style',
  PATTERN_NAME: 'Pattern',
  MATERIAL_TYPE: 'Material',
}

export class VariationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ebayCategoryService: EbayCategoryService = new EbayCategoryService(),
  ) {}

  async getVariationsPayload(opts: {
    productId: string
    selectedTheme: string | null
    cachedThemes: unknown
  }): Promise<VariationsPayload> {
    const product = await this.prisma.product.findUnique({
      where: { id: opts.productId },
      select: {
        id: true,
        sku: true,
        name: true,
        isParent: true,
        variations: {
          select: {
            id: true,
            sku: true,
            variationAttributes: true,
            price: true,
            stock: true,
          },
        },
      },
    })
    if (!product) {
      throw new Error('Product not found')
    }

    const themes = parseThemes(opts.cachedThemes)
    const selected = opts.selectedTheme
      ? themes.find((t) => t.id === opts.selectedTheme) ?? null
      : null

    const children: VariationChild[] = (product.variations ?? []).map((v) => {
      const rawAttrs =
        (v.variationAttributes as Record<string, unknown> | null) ?? {}
      const attrs = lowerKeyMap(rawAttrs)
      const missing = selected
        ? selected.requiredAttributes.filter((k) => isEmptyValue(attrs[k]))
        : []
      return {
        id: v.id,
        sku: v.sku,
        attributes: attrs,
        price: Number(v.price ?? 0),
        stock: v.stock ?? 0,
        missingAttributes: missing,
      }
    })

    const presentAttributes = uniqueKeys(children)

    return {
      isParent: !!product.isParent || children.length > 0,
      parentSku: product.sku,
      parentName: product.name,
      themes,
      children,
      presentAttributes,
    }
  }

  /**
   * Phase E — per-channel variation themes + per-child attribute
   * completeness across every selected channel.
   *
   * For Amazon channels we read the cached `variation_theme` enum
   * from CategorySchema.variationThemes (already populated by
   * D.3f's schema-sync service). Non-Amazon channels are listed in
   * `channelsMissingThemes` with reason='unsupported_channel' until
   * Phase 2A wires eBay's category aspects.
   */
  async getMultiChannelVariationsPayload(opts: {
    productId: string
    channels: Array<{ platform: string; marketplace: string }>
    /** ChannelKey → productType (from wizardState). */
    productTypeByChannel: Record<string, string | undefined>
    fallbackProductType?: string
    /** ChannelKey → currently-selected theme id (from
     *  wizardState.channelStates[key].variations.theme). */
    selectedThemeByChannel: Record<string, string | null>
  }): Promise<MultiChannelVariationsPayload> {
    const product = await this.prisma.product.findUnique({
      where: { id: opts.productId },
      select: {
        id: true,
        sku: true,
        name: true,
        isParent: true,
        variations: {
          select: {
            id: true,
            sku: true,
            variationAttributes: true,
            price: true,
            stock: true,
          },
        },
      },
    })
    if (!product) {
      throw new Error('Product not found')
    }

    const channels = opts.channels.map((c) => ({
      ...c,
      platform: c.platform.toUpperCase(),
      marketplace: c.marketplace.toUpperCase(),
    }))

    // Collect theme lists per channel + missing-themes reasons.
    const themesByChannel: Record<string, ThemeOption[]> = {}
    const missing: MultiChannelVariationsPayload['channelsMissingThemes'] = []
    const channelOut: MultiChannelVariationsPayload['channels'] = []

    for (const c of channels) {
      const channelKey = `${c.platform}:${c.marketplace}`
      const productType =
        opts.productTypeByChannel[channelKey] ?? opts.fallbackProductType ?? ''
      channelOut.push({
        platform: c.platform,
        marketplace: c.marketplace,
        productType,
      })
      if (!productType) {
        themesByChannel[channelKey] = []
        missing.push({ channelKey, reason: 'no_product_type' })
        continue
      }
      if (c.platform === 'EBAY') {
        // DD.1 — eBay themes derived from category aspects flagged
        // aspectEnabledForVariations. Each variant-eligible aspect
        // becomes a single-axis theme; if 2+ exist, also offer a
        // combined "all axes" theme so multi-axis SKUs don't have to
        // pick one. productType for eBay is the eBay categoryId.
        const aspects = await this.ebayCategoryService.getCategoryAspectsRich(
          productType,
          c.marketplace,
        )
        const themes = ebayThemesFromAspects(aspects)
        themesByChannel[channelKey] = themes
        if (themes.length === 0) {
          missing.push({ channelKey, reason: 'no_themes_in_schema' })
        }
        continue
      }
      if (c.platform !== 'AMAZON') {
        themesByChannel[channelKey] = []
        missing.push({ channelKey, reason: 'unsupported_channel' })
        continue
      }
      const schema = await this.prisma.categorySchema.findFirst({
        where: {
          channel: 'AMAZON',
          marketplace: c.marketplace,
          productType,
          isActive: true,
        },
        orderBy: { fetchedAt: 'desc' },
        select: { variationThemes: true },
      })
      let themes = parseThemes(schema?.variationThemes ?? null)
      // Phase K.2 — when SP-API hasn't been hit (or this productType
      // isn't in cache yet) the schema's variationThemes is null and
      // the picker would be empty. Fall back to the bundled common-
      // theme map so the user can keep moving without configuration.
      if (themes.length === 0) {
        themes = parseThemes(bundledThemesFor(productType))
      }
      themesByChannel[channelKey] = themes
      if (themes.length === 0) {
        missing.push({ channelKey, reason: 'no_themes_in_schema' })
      }
    }

    // Common themes = intersection across every channel that
    // successfully returned themes. Channels in `missing` are
    // excluded from the intersection (they couldn't contribute).
    const fetchedKeys = Object.keys(themesByChannel).filter(
      (k) => themesByChannel[k]!.length > 0,
    )
    let commonIds: Set<string> | null = null
    for (const key of fetchedKeys) {
      const ids = new Set((themesByChannel[key] ?? []).map((t) => t.id))
      if (commonIds === null) {
        commonIds = ids
      } else {
        for (const id of Array.from(commonIds)) {
          if (!ids.has(id)) commonIds.delete(id)
        }
      }
    }
    const commonThemeIds = commonIds ?? new Set<string>()
    // Pick metadata from the first channel that has the theme — same
    // shape as Phase D's union: first occurrence wins for consistency.
    const commonThemes: ThemeOption[] = []
    for (const id of Array.from(commonThemeIds)) {
      let theme: ThemeOption | undefined
      for (const key of fetchedKeys) {
        theme = (themesByChannel[key] ?? []).find((t) => t.id === id)
        if (theme) break
      }
      if (theme) commonThemes.push(theme)
    }
    commonThemes.sort((a, b) => {
      if (a.id === 'SIZE_COLOR') return -1
      if (b.id === 'SIZE_COLOR') return 1
      return a.id.localeCompare(b.id)
    })

    // Per-child attribute annotations: for each channel with a
    // selected theme, compute which required attributes the child is
    // missing.
    const children: MultiChannelVariationChild[] = (
      product.variations ?? []
    ).map((v) => {
      const rawAttrs =
        (v.variationAttributes as Record<string, unknown> | null) ?? {}
      const attrs = lowerKeyMap(rawAttrs)
      const missingByChannel: Record<string, string[]> = {}
      for (const [channelKey, selectedThemeId] of Object.entries(
        opts.selectedThemeByChannel,
      )) {
        if (!selectedThemeId) {
          missingByChannel[channelKey] = []
          continue
        }
        const theme = (themesByChannel[channelKey] ?? []).find(
          (t) => t.id === selectedThemeId,
        )
        if (!theme) {
          missingByChannel[channelKey] = []
          continue
        }
        missingByChannel[channelKey] = theme.requiredAttributes.filter((k) =>
          isEmptyValue(attrs[k]),
        )
      }
      return {
        id: v.id,
        sku: v.sku,
        attributes: attrs,
        price: Number(v.price ?? 0),
        stock: v.stock ?? 0,
        missingByChannel,
      }
    })

    const presentAttributes = uniqueKeysMc(children)

    return {
      isParent: !!product.isParent || children.length > 0,
      parentSku: product.sku,
      parentName: product.name,
      channels: channelOut,
      themesByChannel,
      commonThemes,
      selectedThemeByChannel: opts.selectedThemeByChannel,
      children,
      presentAttributes,
      channelsMissingThemes: missing,
    }
  }
}

function uniqueKeysMc(
  children: Array<{ attributes: Record<string, string> }>,
): string[] {
  const set = new Set<string>()
  for (const c of children) {
    for (const k of Object.keys(c.attributes)) set.add(k)
  }
  return Array.from(set).sort()
}

// ── helpers ─────────────────────────────────────────────────────

function parseThemes(cached: unknown): ThemeOption[] {
  if (!Array.isArray(cached)) return []
  const out: ThemeOption[] = []
  for (const raw of cached) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    out.push({
      id: raw,
      label: KNOWN_THEME_LABELS[raw] ?? humaniseTheme(raw),
      requiredAttributes: themeAttributes(raw),
    })
  }
  // Some marketplaces return alternate casing or multi-axis combos;
  // keep them but always surface the canonical SIZE_COLOR first when
  // present, since it's what most fashion productTypes use.
  out.sort((a, b) => {
    if (a.id === 'SIZE_COLOR') return -1
    if (b.id === 'SIZE_COLOR') return 1
    return a.id.localeCompare(b.id)
  })
  return out
}

function themeAttributes(themeId: string): string[] {
  // The theme id encodes the attributes — split on `_NAME`, `_NAMES`,
  // and `_` boundaries. SIZE_COLOR → ['size', 'color']; SIZE_NAME →
  // ['size']; STYLE_NAME → ['style']. Defensive against odd casings.
  const cleaned = themeId
    .replace(/_NAMES?$/i, '')
    .replace(/_NAME(?=_)/gi, '')
  const parts = cleaned
    .split(/[_-]/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  // Dedupe.
  return Array.from(new Set(parts))
}

function humaniseTheme(themeId: string): string {
  return themeAttributes(themeId)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(' / ')
}

function lowerKeyMap(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.toLowerCase()] = String(v)
  }
  return out
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

function uniqueKeys(children: Array<{ attributes: Record<string, string> }>): string[] {
  const set = new Set<string>()
  for (const c of children) {
    for (const k of Object.keys(c.attributes)) set.add(k)
  }
  return Array.from(set).sort()
}

// DD.1 — derive ThemeOption[] from eBay aspects. eBay has no
// "variation theme" concept like Amazon; instead each aspect is
// flagged aspectEnabledForVariations. We mirror Amazon's UI by
// generating one single-axis theme per variant-eligible aspect, and
// when 2+ are present, an extra combined-axes theme so multi-axis
// listings don't have to pick a single dimension.
function ebayThemesFromAspects(
  aspects: Array<{ name: string; variantEligible: boolean }>,
): ThemeOption[] {
  const eligible = aspects.filter((a) => a.variantEligible)
  if (eligible.length === 0) return []
  const out: ThemeOption[] = eligible.map((a) => {
    const key = aspectIdFromName(a.name)
    return {
      id: key.toUpperCase(),
      label: a.name,
      requiredAttributes: [key],
    }
  })
  if (eligible.length > 1) {
    const keys = eligible.map((a) => aspectIdFromName(a.name))
    out.push({
      id: keys.map((k) => k.toUpperCase()).join('_'),
      label: eligible.map((a) => a.name).join(' and '),
      requiredAttributes: keys,
    })
  }
  // Same ordering rule as Amazon: SIZE/COLOR-style first when present.
  out.sort((a, b) => {
    const aIsCombined = a.requiredAttributes.length > 1
    const bIsCombined = b.requiredAttributes.length > 1
    if (aIsCombined !== bIsCombined) return aIsCombined ? -1 : 1
    return a.label.localeCompare(b.label)
  })
  return out
}

function aspectIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
