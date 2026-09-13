'use client'

/**
 * PES.1 — the studio's client root: the subtree's providers, then the frame.
 *
 * ## Why `ToastProvider` is here
 *
 * 🔴 The root layout mounts the LEGACY `@/components/ui/Toast` provider, which is a different
 * React context from the design system's. So `useToast()` from `@/design-system/components` finds
 * no provider anywhere above this route and **throws** — `useToast must be used within
 * <ToastProvider>` — which takes the whole route down as a white screen rather than degrading to
 * "no toast". Any DS component that reports an outcome is therefore a landmine for every lane
 * mounting into this frame: `GridViewsMenu` is the one that found it (PES.2).
 *
 * `/products/next` hit exactly this and solved it exactly this way — `ProductsNextClient` wraps its
 * inner tree and says so in one line. This is that precedent, and it is the right layering
 * regardless: a frame owns the providers its own subtree needs, rather than every tab discovering
 * the gap on its own.
 *
 * Assigned by the PES.0 hub, ruling #22. PES.2 holds the longer-term substrate fix (providers baked
 * into the grid hosts, so a future consumer cannot hit it at all); this mount is wanted either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadStudioData } from './studio-data'
import { StudioPlaceholder } from './StudioPlaceholder'
import { when } from './drawer/format'
import { ToastProvider } from '@/design-system/components'

import { StudioStateProvider } from './contracts'
import { StudioFrame } from './StudioFrame'
import type { MarketplaceLite, StudioFamily, StudioProduct } from './types'

export interface StudioClientProps {
  product: StudioProduct
  family: StudioFamily | null
  primaryLanguage: string | null
  marketplaces: MarketplaceLite[]
  marketplacesFailed: boolean
}

export function StudioClient({ product, family, marketplaces, primaryLanguage, marketplacesFailed }: StudioClientProps) {
  const [discovery, setDiscovery] = useState<{ productId: string; marketplaces: MarketplaceLite[]; failed: boolean } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current += 1; return () => { generation.current += 1 } }, [product.id])
  const retryDiscovery = useCallback(async () => {
    const mine = generation.current
    setRetrying(true)
    try {
      const result = await loadStudioData(product.id)
      if (mine !== generation.current) return
      if (result.kind === 'ok') setDiscovery({ productId: product.id, marketplaces: result.data.marketplaces, failed: result.data.marketplacesFailed })
    } finally { if (mine === generation.current) setRetrying(false) }
  }, [product.id])
  const current = discovery?.productId === product.id ? discovery : null
  if (product.deletedAt != null) return <StudioPlaceholder title="This product is in the bin">
    {product.sku} · Moved to the bin <time dateTime={product.deletedAt}>{when(product.deletedAt)}</time>.
  </StudioPlaceholder>
  return (
    <ToastProvider>
      <StudioStateProvider key={product.id} product={product} family={family} marketplaces={current?.marketplaces ?? marketplaces} marketplacesFailed={current?.failed ?? marketplacesFailed}
        discoveryRetry={retryDiscovery} discoveryRetrying={retrying} primaryLanguage={primaryLanguage}>
        <StudioFrame />
      </StudioStateProvider>
    </ToastProvider>
  )
}
