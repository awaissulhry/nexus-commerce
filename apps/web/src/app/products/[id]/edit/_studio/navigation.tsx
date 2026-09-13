import { Activity, AlertTriangle, BarChart3, Image, LayoutGrid, LayoutTemplate, ListOrdered, Table2, Link2, FileText } from 'lucide-react'
import type { ReactNode } from 'react'
import type { StudioTabId } from './types'

/**
 * Shared by the scope strip, secondary navigation and related-view menu.
 *
 * The words are the variants spec's §9 copy table, verbatim — one source for every lane. A channel group
 * offers `Listing information` and nothing that duplicates a page the scope bar already re-projects (§1.2).
 * `Relationships` is gone entirely (Owner, 2026-09-12), so it has no entry here either.
 */
export const STUDIO_TAB_LABELS: Record<StudioTabId, string> = {
  matrix: 'Matrix',
  variants: 'Variants',
  'variation-order': 'Variation order',
  presentation: 'Description themes', sheet: 'Information', images: 'Media', analytics: 'Performance', activity: 'Activity', errors: 'Needs attention',
  'shopify-family': 'Product family', 'shopify-metafields': 'Metafields & content',
}
/**
 * Glyphs read off the canvas's "Product navigation" artboard: `Link2` on Variants.
 *
 * 🔴 `LayoutGrid` on Matrix, not `Grid3x3`. MEASURED in the copy apps/web actually resolves
 * (`apps/web/node_modules/lucide-react` **0.263.1**, not the 0.469 hoisted at the repo root):
 * `Grid3x3` appears NOWHERE in its `.d.ts`; `LayoutGrid` is declared at `lucide-react.d.ts:8643`
 * and exported. Reaching for the newer name would typecheck against the root copy and fail here —
 * the trap `provenanceMark.tsx` already records for `Waypoints`.
 */
export const STUDIO_TAB_ICONS: Record<StudioTabId, ReactNode> = {
  matrix: <LayoutGrid size={15} />,
  variants: <Link2 size={15} />,
  'variation-order': <ListOrdered size={15} />,
  presentation: <LayoutTemplate size={15} />, sheet: <Table2 size={15} />, images: <Image size={15} />, analytics: <BarChart3 size={15} />,
  activity: <Activity size={15} />, errors: <AlertTriangle size={15} />,
  'shopify-family': <Link2 size={15} />, 'shopify-metafields': <FileText size={15} />,
}
