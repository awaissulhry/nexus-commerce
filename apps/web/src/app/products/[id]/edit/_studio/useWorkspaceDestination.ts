'use client'

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

export interface WorkspaceDestination {
  productId: string
  familyId: string
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string | null
  listing: { id: string; productId: string; aliasKey: string; version: number } | null
}
export type DestinationState = { status: 'idle' | 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: WorkspaceDestination }

export function useWorkspaceDestination(productId: string, channel: string, market: string | null, accountId?: string, listingId?: string): DestinationState {
  const key = JSON.stringify([productId, channel, market, accountId, listingId])
  const [result, setResult] = useState<{ key: string; state: DestinationState }>()
  const enabled = channel !== 'master' && !!market && (accountId !== undefined || listingId !== undefined)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const query = new URLSearchParams({ channel, market: market! })
    if (accountId !== undefined) query.set('accountId', accountId)
    if (listingId !== undefined) query.set('listingId', listingId)
    void fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/destination?${query}`, {
      signal: controller.signal, credentials: 'include', cache: 'no-store',
    }).then(async response => {
      const body = await response.json()
      if (controller.signal.aborted) return
      setResult({ key, state: response.ok ? { status: 'ready', data: body } : { status: 'error', message: body.message ?? body.error ?? 'The selected destination could not be read.' } })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, state: { status: 'error', message: error instanceof Error ? error.message : 'The selected destination could not be read.' } })
    })
    return () => controller.abort()
  }, [productId, channel, market, accountId, listingId, key, enabled])
  return !enabled ? { status: 'idle' } : result?.key === key ? result.state : { status: 'loading' }
}
