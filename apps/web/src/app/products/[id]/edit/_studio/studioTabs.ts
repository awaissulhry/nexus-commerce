/**
 * P2 (2026-09-30, I4-7) — each studio tab's code, loaded when the tab is opened.
 *
 * `StudioTabHost` imported all twelve tabs statically, so the eBay sheet shipped the images workspace, the Shopify
 * editors, the variants page and the master sheet besides its own code. Each loader is a separate chunk; the page asks
 * for the tab its URL opens at load (`StudioLoader`), in parallel with its data, so the first tab never waits on it.
 * Import paths only here: nothing in this module may import a tab statically.
 */
import type { ComponentType } from 'react'
import type { StudioTabId } from './types'

type Tab = ComponentType<Record<string, never>>

export const STUDIO_TAB_LOADERS: Record<StudioTabId, () => Promise<Tab>> = {
  sheet: () => import('./sheet/ProductSheetTab').then(m => m.ProductSheetTab as Tab),
  matrix: () => import('./matrix/MatrixTab').then(m => m.MatrixTab as Tab),
  variants: () => import('./variants/VariantsTab').then(m => m.VariantsTab as Tab),
  presentation: () => import('./PresentationTab').then(m => m.PresentationTab as Tab),
  'variation-order': () => import('./PresentationTab').then(m => m.VariationOrderTab as Tab),
  'shopify-family': () => import('./shopify/ShopifyLinkedRoute').then(m => m.ShopifyFamilyTab as Tab),
  'shopify-metafields': () => import('./shopify/ShopifyLinkedRoute').then(m => m.ShopifyMetafieldsTab as Tab),
  images: () => import('./images').then(m => m.ImagesTabRoute as Tab),
  sharing: () => import('./sharing/SharingTab').then(m => m.SharingTab as Tab),
  analytics: () => import('./ancillary/AnalyticsAdsTab').then(m => m.AnalyticsAdsTab as Tab),
  errors: () => import('./channel-ops/ErrorsSyncTab').then(m => m.ErrorsSyncTab as Tab),
  activity: () => import('./ancillary/ActivityTab').then(m => m.ActivityTab as Tab),
}

/** Start loading the tab a URL opens (`?tab=`, the sheet when absent or unknown). Errors surface when it renders. */
export function preloadStudioTab(tab: string | null): void {
  const load = STUDIO_TAB_LOADERS[(tab && tab in STUDIO_TAB_LOADERS ? tab : 'sheet') as StudioTabId]
  void load().catch(() => {})
}

/**
 * Audit B04 — a tab's code that did not arrive: the connection dropped, or a deploy removed the chunk this page asked for.
 * Webpack names it `ChunkLoadError`; a native dynamic import fails with the browser's own sentence.
 */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ChunkLoadError'
    || /Loading (CSS )?chunk \S+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(error.message))
}

/**
 * B04 — one component per tab, made again after it failed. `next/dynamic` wraps each loader in ONE `React.lazy`, which
 * keeps a rejected import and throws it on every later render, so retrying a tab needs a new component, not a re-render.
 */
export function studioTabCache<T>(make: (id: StudioTabId) => T): { get: (id: StudioTabId) => T; forget: (id: StudioTabId) => void } {
  const made = new Map<StudioTabId, T>()
  return {
    get: (id) => {
      if (!made.has(id)) made.set(id, make(id))
      return made.get(id)!
    },
    forget: (id) => { made.delete(id) },
  }
}
