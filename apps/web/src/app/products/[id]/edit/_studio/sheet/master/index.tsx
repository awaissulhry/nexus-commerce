'use client'

/**
 * PES.2 — what the studio frame mounts for the MASTER scope.
 *
 * A thin seam on purpose: `StudioTabHost` (PES.1) swaps one branch of its switch for this and
 * touches nothing else, exactly as its own comment asks. Everything the sheet needs it reads from
 * the frame's published hooks — the coordinate from `useStudioScope()`, the write reporting through
 * `useSaveReporter()`, the drawer through `useStudioRecord()`.
 *
 * ⚠ The product id comes from the ROUTE, not from the frame: `StudioStateProvider` is given a
 * `StudioProduct` but does not expose it, and `StudioTabHost()` takes no props, so there is no hook
 * to ask. Requested from PES.1 as `useStudioProduct()`; this reads `useParams()` until it lands,
 * which is correct for this route (`/products/[id]/edit`) but means the product's identity is
 * derived in two places rather than one.
 */
import { useParams } from 'next/navigation'

import { useStudioScope } from '../../contracts'
import { MasterSheet } from './MasterSheet'

export function MasterSheetTab() {
  const params = useParams<{ id: string }>()
  const { market, locale } = useStudioScope()
  const productId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''

  if (!productId) return <div style={{ padding: 24 }}>No product in the route.</div>
  // The frame resolves both from the marketplace table; before it answers there is no coordinate
  // to read, and a sheet fetched against a guessed market would show the wrong catalogue.
  if (!market || !locale) return <div style={{ padding: 24 }} className="nds-cell-muted">Waiting for the market…</div>

  return <MasterSheet key={`${productId}:${market}:${locale}`} productId={productId} market={market} locale={locale} />
}

export { MasterSheet } from './MasterSheet'
export type { StudioRow, StudioSheet, SheetColumn } from './types'
