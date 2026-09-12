'use client'

import { useEffect, useState } from 'react'
import { useStudioProduct, useStudioScope } from './contracts'
import { apiGet } from './images/api'

/** Mask prior data in render, and cancel both request and response processing on changes. */
export function useWorkspaceRead<T>(view: string, extra = '') {
  const product = useStudioProduct()
  const { scope, market, accountId, listingId } = useStudioScope()
  const query = new URLSearchParams(extra)
  query.set('scope', scope === 'master' ? 'master' : 'channel')
  query.set('channel', scope)
  if (market) query.set('market', market)
  if (accountId !== undefined) query.set('accountId', accountId)
  if (listingId !== undefined) query.set('listingId', listingId)
  const path = `/api/products/${encodeURIComponent(product.id)}/studio/${view}?${query}`
  const [result, setResult] = useState<{ path: string; data?: T; error?: string }>()
  useEffect(() => {
    const controller = new AbortController()
    void apiGet<T>(path, controller.signal).then(response => {
      if (controller.signal.aborted) return
      setResult(response.ok ? { path, data: response.data } : { path, error: response.message })
    })
    return () => controller.abort()
  }, [path])
  return result?.path === path ? { loading: false, ...result } : { loading: true, data: undefined, error: undefined }
}
