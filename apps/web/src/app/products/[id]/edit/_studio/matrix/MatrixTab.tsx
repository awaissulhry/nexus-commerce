'use client'

/**
 * MX.P — where `tab=matrix` mounts (`StudioTabHost` → `TABS.matrix`).
 *
 * ONE state, every coordinate at once; the scope bar filters the groups inside the surface, so the
 * surface is keyed on the PRODUCT only — a market change must not remount it, or the in-memory
 * preview store (every edit the operator made this session) would be thrown away with it.
 */
import { useParams } from 'next/navigation'

import { useStudioScope } from '../contracts'
import { NoMarketState } from '../NoMarketState'

import { MatrixSurface } from './MatrixSurface'

export function MatrixTab() {
  const params = useParams<{ id: string }>()
  const { market, locale } = useStudioScope()
  const productId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''
  if (!productId) return <div style={{ padding: 'var(--nds-space-24)' }}>No product in the route.</div>
  // A-53: the frame has answered by now; no market means none exists or the read failed — say which.
  if (!market || !locale) return <NoMarketState />
  return <MatrixSurface key={productId} productId={productId} />
}
