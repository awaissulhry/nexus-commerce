'use client'

/**
 * Reviews area — the markets each channel page exists for (GET /api/reviews/area/channel-markets), so the sub-sidebar
 * shows "Amazon Italy", "eBay Germany" … under Amazon and eBay. Read when the shell mounts and again after reviews are
 * imported (an import can bring a new market). A failed read shows no market rows: the channel rows ("all markets")
 * still lead to every market.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { reviewsGet } from '../_lib/reviewsFetch'
import type { ReviewsChannelMarkets } from './reviews-nav'

interface MarketsAnswer {
  AMAZON?: Array<{ code: string }>
  EBAY?: Array<{ code: string }>
}

export function useReviewsChannelMarkets(): ReviewsChannelMarkets | undefined {
  const [markets, setMarkets] = useState<ReviewsChannelMarkets | undefined>(undefined)
  const alive = useRef(true)

  const read = useCallback(async () => {
    const res = await reviewsGet<MarketsAnswer>('/reviews/area/channel-markets')
    if (!alive.current || !res.data) return
    setMarkets({
      AMAZON: (res.data.AMAZON ?? []).map((m) => m.code),
      EBAY: (res.data.EBAY ?? []).map((m) => m.code),
    })
  }, [])

  useEffect(() => {
    alive.current = true
    void read()
    return () => {
      alive.current = false
    }
  }, [read])

  useInvalidationChannel(['review.imported'], () => void read())

  return markets
}
