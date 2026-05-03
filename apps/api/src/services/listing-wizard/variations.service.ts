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
  constructor(private readonly prisma: PrismaClient) {}

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
