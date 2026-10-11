'use client'

/**
 * Ads wave 4c — why a write control is off on a market Nexus only reads, reachable by keyboard.
 *
 * A disabled button cannot take focus, so its `title` never reaches a keyboard or screen-reader user. The reason sits
 * beside it in the DS `InfoTip`: a focusable info icon whose accessible name is the reason, and whose tooltip opens on
 * focus as well as on hover. Every write control that a reading-only market switches off uses this, so the reason
 * reads the same everywhere. The write gate still refuses any write that gets through, with its own reason.
 */
import { useCallback } from 'react'
import { InfoTip } from '@/design-system/primitives'
import { useAdsMarketplaceOptional } from './MarketplaceContext'
import { writeBlockFor } from './adsMarkets'

/** The reason a write touching these markets is off, or null. Outside the ads provider: null (nothing to say). */
export function useWriteBlock(codes: Iterable<string | null | undefined>): string | null {
  const ads = useAdsMarketplaceOptional()
  return ads ? writeBlockFor(ads.markets, codes) : null
}

/**
 * The same reason per row, for a table whose rows sit in different markets (the Bid page under All markets): a function of
 * the markets one write touches. Outside the ads provider: always null.
 */
export function useWriteBlockOf(): (codes: Iterable<string | null | undefined>) => string | null {
  const ads = useAdsMarketplaceOptional()
  const markets = ads?.markets
  return useCallback((codes: Iterable<string | null | undefined>) => (markets ? writeBlockFor(markets, codes) : null), [markets])
}

export function WriteBlockedTip({ reason }: { reason: string | null | undefined }) {
  if (!reason) return null
  return <InfoTip tip={reason} />
}
