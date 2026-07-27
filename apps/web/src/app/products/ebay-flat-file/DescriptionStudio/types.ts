/**
 * DS-1 — shared shapes for the Description Studio. Extracted VERBATIM from
 * EbayDescriptionThemesModal.tsx so the Studio and the legacy modal agree on
 * every wire format until DS-2 retires the modal.
 */

export interface Theme {
  id: string
  name: string
  notes?: string | null
  html: string
  isDefault: boolean
  active: boolean
  builtIn: boolean
  version: number
}

export interface ThemeUsage {
  total: number
  /** Listings with no explicit pick — the default theme wraps them at push. */
  default: number
  /** Listings explicitly set to 'none' — raw body on purpose. */
  raw: number
  byThemeId: Record<string, number>
}

// ── ED v2 P4b — POST /ebay/description-push shapes (mirror of
// apps/api/src/services/ebay-description-push.service.ts result types) ───────

export interface PushListingResult {
  itemId: string
  parentSku: string
  lane: 'inventory' | 'trading'
  outcome: 'revised' | 'inventory-managed' | 'skipped-empty-body' | 'dry-run' | 'failed'
  /** Whether a theme wrapped the body. */
  themed: boolean
  themeName?: string
  bodySource?: 'membership' | 'parent'
  warnings: string[]
  message?: string
}

export interface PushProductSummary {
  productId: string
  parentSku?: string
  themePersisted?: boolean
  listings: number
  warnings: string[]
  error?: string
}

export interface PushResult {
  marketplace: string
  listings: PushListingResult[]
  products: PushProductSummary[]
}

/** Server-side cap (MAX_PRODUCTS_PER_CALL in the route) — mirrored here so the
 *  picker refuses the 51st product instead of earning a 400. */
export const MAX_PUSH_PRODUCTS = 50

// ── ED v2 P5 — description staleness (D8: badge + manual re-push, never auto) ─

export interface StalenessEntry {
  productId: string
  stale: boolean
  reasons: string[]
  stampedAt?: string
}

// ── Product lookup (GET /api/products/lookup) ────────────────────────────────
// Family roots (parents + standalones), drafts included.

export interface LookupItem {
  id: string
  sku: string
  title: string
  isParent: boolean
  hasEbayListing: boolean
}

export interface PreviewProduct { id: string; sku: string; title?: string; hasEbayListing?: boolean }

// ── DS-0 — POST /ebay/description-preview response ───────────────────────────
// (RenderListingDescriptionResult in ebay-description-theme.service.ts.)

export interface PreviewResponse {
  html: string
  themed: boolean
  themeId?: string
  themeName?: string
  themeVersion?: number
  warnings: string[]
}
