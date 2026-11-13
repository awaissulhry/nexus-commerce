'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { orderUnits } from '../../../mtm/api'
import { asksUnits, bannerProblem, reviewBannerOf, type ReviewBannerModel } from './model'

/**
 * The container part of the review banner (B-W2b-368, XF1:02): while the order waits and has a made-to-measure unit, GET
 * /sales/orders/:id/made-to-measure (orders.view), read again whenever the order is read again (its version moves: a review's
 * CONFIRM moves it on, live). Null: nothing to say (the order does not wait for a unit).
 */
export function useReviewBanner(api: ApiClient, order: { readonly id: string; readonly status: string; readonly version: number; readonly lines: readonly { readonly kind: string }[] } | null, permissions: readonly string[], prefix: string): { model: ReviewBannerModel | null; retry: () => void } {
  const [model, setModel] = useState<ReviewBannerModel | null>(null)
  const [attempt, setAttempt] = useState(0)
  const asks = order !== null && asksUnits(order)
  const orderId = order?.id ?? null
  const version = order?.version ?? 0
  useEffect(() => {
    if (!asks || !orderId) {
      setModel(null)
      return
    }
    const abort = new AbortController()
    setModel((current) => (current?.state === 'ready' ? current : { state: 'loading' }))
    orderUnits(api, orderId, abort.signal)
      .then((made) => setModel(reviewBannerOf(made, permissions, prefix)))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        setModel({ state: 'error', problem: bannerProblem(isApiError(error) ? error.kind : null) })
      })
    return () => abort.abort()
  }, [api, asks, orderId, version, permissions, prefix, attempt])
  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  return { model, retry }
}
