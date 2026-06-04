'use client'

/**
 * TC.4 — Tab visibility + order preference hook for /products/[id]/edit.
 *
 * Replaces the binary `product-edit:show-all-tabs` localStorage flag
 * with a per-user, per-browser ordered list of `{ key, visible }`
 * entries. The Customize Tabs modal (TC.5) writes through this hook;
 * the tab strip (TC.6) reads from it.
 *
 * Storage shape (versioned for future migration):
 *
 *   localStorage['product-edit:tab-prefs:v1'] = {
 *     v: 1,
 *     items: [
 *       { key: 'master',  visible: true },
 *       { key: 'images',  visible: true },
 *       { key: 'workflow', visible: false },
 *       …
 *     ]
 *   }
 *
 * Reconciliation: any saved key not in CANONICAL_TABS is dropped
 * silently (e.g. an old key from a removed tab); any canonical key
 * not in saved is appended to the end as hidden (new tabs land at
 * the back of the queue rather than surprising the operator at the
 * front). This means an operator who installed a year-old localStorage
 * entry still gets sensible behaviour after a release that added two
 * new tabs and removed one.
 *
 * Minimum-visible guard: the setter rejects any state that would
 * leave zero visible tabs. Operators who accidentally uncheck
 * everything in the modal hit a soft veto rather than wedge the page.
 *
 * Active-tab safety: NOT enforced here. The render layer (TC.6) is
 * responsible for showing the currently-active tab even when prefs
 * mark it hidden, with a visual cue. Keeps this hook pure.
 *
 * TC.7 — First-time-user behavior: a brand-new operator with no
 * localStorage entry gets DEFAULT_TAB_PREFS held in memory only. The
 * actual localStorage write happens only via `setOrderedPrefs` or
 * `resetToDefaults` (i.e. an explicit Save in the modal). Until then
 * the operator's default-tab state persists across reloads via the
 * reconcile-null-returns-defaults path — no eager writes.
 */

import { useCallback, useState } from 'react'

/**
 * Canonical catalog of every top-tab on /edit, in default display
 * order. The first 8 entries are the operator-confirmed pinned set;
 * everything after is hidden by default but still part of the
 * catalog so the modal can offer to toggle them on.
 *
 * Channel tabs (AMAZON / EBAY / SHOPIFY / WOOCOMMERCE / ETSY) are
 * listed here even though the strip only renders the ones returned
 * from `orderedChannels`. That keeps prefs portable across products
 * — an operator who hides WOOCOMMERCE on one product still sees it
 * hidden on a product that has Woo listings (without re-toggling).
 */
export const CANONICAL_TABS = [
  // Pinned-by-default 8
  'master',
  'images',
  'matrix',
  'analytics',
  'ads',
  'mapping',
  'AMAZON',
  'EBAY',
  'SHOPIFY',
  // Hidden-by-default rest, in roughly authoring-flow order
  'locales',
  'seo',
  'compliance',
  'workflow',
  'relations',
  'activity',
  'WOOCOMMERCE',
  'ETSY',
] as const

export type TabKey = (typeof CANONICAL_TABS)[number]

export interface TabPref {
  key: TabKey
  visible: boolean
}

const DEFAULT_VISIBLE_KEYS = new Set<TabKey>([
  'master',
  'images',
  'matrix',
  'analytics',
  'ads',
  'mapping',
  'AMAZON',
  'EBAY',
  'SHOPIFY',
])

/** Frozen defaults. Always returns a fresh array via the spread in callers. */
export const DEFAULT_TAB_PREFS: ReadonlyArray<TabPref> = CANONICAL_TABS.map((key) => ({
  key,
  visible: DEFAULT_VISIBLE_KEYS.has(key),
}))

const STORAGE_KEY = 'product-edit:tab-prefs:v1'
// TC.8 — legacy key the pre-TC binary "+ More tabs / Show less"
// toggle persisted to. Read once during hook initialisation, mapped
// to v1 prefs, then deleted so the migration never re-runs.
const LEGACY_KEY = 'product-edit:show-all-tabs'

interface StoredV1 {
  v: 1
  items: TabPref[]
}

function readFromStorage(): TabPref[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredV1>
    if (parsed?.v !== 1 || !Array.isArray(parsed.items)) return null
    return parsed.items.filter(
      (it): it is TabPref =>
        it !== null &&
        typeof it === 'object' &&
        typeof (it as TabPref).key === 'string' &&
        typeof (it as TabPref).visible === 'boolean',
    )
  } catch {
    return null
  }
}

function writeToStorage(items: TabPref[]): void {
  if (typeof window === 'undefined') return
  try {
    const stored: StoredV1 = { v: 1, items }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Quota or private-browsing — preferences just don't persist
    // across sessions. Functionality still works in-memory.
  }
}

/**
 * TC.8 — Migrate from the legacy `product-edit:show-all-tabs` key.
 *
 * Pre-TC the strip had a binary toggle stored as "1" / "0":
 *   - "1" = operator was on "show all 14 tabs" mode → preserve by
 *     marking every canonical tab visible in default order.
 *   - "0" or absent = operator was on the default 8-tab strip → fall
 *     through to DEFAULT_TAB_PREFS (no-op migration).
 *
 * Runs exactly once per browser: legacy key is deleted after read so
 * the migration never re-runs. Returns null when there's nothing to
 * migrate (legacy key absent), letting the caller fall through to
 * the no-write defaults path.
 *
 * Eager-write justification: unlike the first-time-user case (TC.7),
 * a returning operator with the legacy key had an *explicit*
 * preference. Persisting it to v1 immediately preserves that
 * preference across the next reload — without the write, the legacy
 * delete would orphan their "show all" state.
 */
function migrateFromLegacy(): TabPref[] | null {
  if (typeof window === 'undefined') return null
  try {
    const legacy = window.localStorage.getItem(LEGACY_KEY)
    if (legacy === null) return null
    window.localStorage.removeItem(LEGACY_KEY)
    if (legacy === '1') {
      const allVisible = CANONICAL_TABS.map((key) => ({ key, visible: true }))
      writeToStorage(allVisible)
      return allVisible
    }
    // legacy === '0' (or anything malformed) — fall through to defaults
    // without an eager write. First-time-user contract still applies.
    return null
  } catch {
    return null
  }
}

/**
 * Merge saved prefs with the canonical catalog so:
 *   - Saved entries keep their order + visibility.
 *   - Stale keys (saved but no longer canonical) are dropped.
 *   - Newly-added canonical keys are appended at the end as hidden.
 */
function reconcile(saved: TabPref[] | null): TabPref[] {
  if (!saved || saved.length === 0) return DEFAULT_TAB_PREFS.map((p) => ({ ...p }))
  const knownKeys = new Set<string>(CANONICAL_TABS)
  const ordered: TabPref[] = saved.filter((p) => knownKeys.has(p.key))
  const seen = new Set(ordered.map((p) => p.key))
  for (const key of CANONICAL_TABS) {
    if (!seen.has(key)) ordered.push({ key, visible: false })
  }
  return ordered
}

/**
 * TC.5 — Label resolver for the Customize Tabs modal + the strip.
 *
 * Splits between i18n keys (existing localized tabs) and fixed
 * strings (channel names + tabs that never got i18n'd in their
 * original wave). Centralises the lookup so the modal, strip, and
 * any future "tab picker" UI all read the same name for a given key.
 */
const TAB_I18N_KEYS: Partial<Record<TabKey, string>> = {
  master: 'products.edit.tab.master',
  images: 'products.edit.tab.images',
  locales: 'products.edit.tab.locales',
  seo: 'products.edit.tab.seo',
  compliance: 'products.edit.tab.compliance',
  workflow: 'products.edit.tab.workflow',
  relations: 'products.edit.tab.relations',
}

const TAB_FIXED_LABELS: Partial<Record<TabKey, string>> = {
  activity: 'Timeline',
  matrix: 'Matrix',
  analytics: 'Analytics',
  ads: 'Ads',
  mapping: 'Mapping',
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

export function resolveTabLabel(
  key: TabKey,
  t: (k: string, vars?: Record<string, string | number>) => string,
): string {
  const i18nKey = TAB_I18N_KEYS[key]
  if (i18nKey) return t(i18nKey)
  return TAB_FIXED_LABELS[key] ?? key
}

export interface UseTabPrefsResult {
  /** Current prefs in display order, reconciled with the canonical catalog. */
  orderedPrefs: TabPref[]
  /** Set the full ordered list. Rejects (no-op) when the new list has zero visible tabs. */
  setOrderedPrefs: (next: TabPref[]) => void
  /** Replace prefs with `DEFAULT_TAB_PREFS` and persist. */
  resetToDefaults: () => void
}

export function useTabPrefs(): UseTabPrefsResult {
  const [items, setItems] = useState<TabPref[]>(() => {
    // TC.8 — v1 key wins if present. Otherwise check the legacy
    // "show all tabs" key; if it was set to "1" the migration
    // returns + persists an all-visible prefs array (and deletes
    // the legacy key). Anything else falls through to defaults.
    const saved = readFromStorage()
    if (saved) return reconcile(saved)
    const migrated = migrateFromLegacy()
    if (migrated) return reconcile(migrated)
    return reconcile(null)
  })

  const setOrderedPrefs = useCallback((next: TabPref[]) => {
    if (!next.some((p) => p.visible)) {
      // Min-visible guard. Refuse to wedge the page on empty state.
      return
    }
    const reconciled = reconcile(next)
    setItems(reconciled)
    writeToStorage(reconciled)
  }, [])

  const resetToDefaults = useCallback(() => {
    const fresh = DEFAULT_TAB_PREFS.map((p) => ({ ...p }))
    setItems(fresh)
    writeToStorage(fresh)
  }, [])

  return { orderedPrefs: items, setOrderedPrefs, resetToDefaults }
}
