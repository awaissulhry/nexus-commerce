import { Activity, AlertTriangle, BarChart3, Image, LayoutTemplate, ListOrdered, Table2, Link2, FileText } from 'lucide-react'
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
  variants: 'Variants',
  'variation-order': 'Variation order',
  presentation: 'Description themes', sheet: 'Information', images: 'Media', analytics: 'Performance', activity: 'Activity', errors: 'Needs attention',
  'shopify-family': 'Product family', 'shopify-metafields': 'Metafields & content',
}
/** Glyphs read off the canvas's "Product navigation" artboard: `Link2` on Variants. */
export const STUDIO_TAB_ICONS: Record<StudioTabId, ReactNode> = {
  variants: <Link2 size={15} />,
  'variation-order': <ListOrdered size={15} />,
  presentation: <LayoutTemplate size={15} />, sheet: <Table2 size={15} />, images: <Image size={15} />, analytics: <BarChart3 size={15} />,
  activity: <Activity size={15} />, errors: <AlertTriangle size={15} />,
  'shopify-family': <Link2 size={15} />, 'shopify-metafields': <FileText size={15} />,
}
