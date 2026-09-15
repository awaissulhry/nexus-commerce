'use client'

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { fetchStudioRead, StudioReadError, studioReadMessage } from './studio-read'

export interface WorkspaceDestination {
  productId: string
  familyId: string
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string | null
  listing: { id: string; productId: string; aliasKey: string; version: number } | null
}
export type DestinationState = { status: 'idle' | 'loading' } | { status: 'error'; message: string; retry?: () => void } | { status: 'ready'; data: WorkspaceDestination }

export function useWorkspaceDestination(productId: string, channel: string, market: string | null, accountId?: string, listingId?: string): DestinationState {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const key = JSON.stringify([productId, channel, market, accountId, listingId, attempt])
  const [result, setResult] = useState<{ key: string; state: DestinationState }>()
  const enabled = channel !== 'master' && !!market && (accountId !== undefined || listingId !== undefined)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const query = new URLSearchParams({ channel, market: market! })
    if (accountId !== undefined) query.set('accountId', accountId)
    if (listingId !== undefined) query.set('listingId', listingId)
    void fetchStudioRead(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/destination?${query}`, controller.signal).then(async response => {
      const body = await response.json()
      if (controller.signal.aborted) return
      setResult({ key, state: response.ok ? { status: 'ready', data: body } : { status: 'error', message: new StudioReadError(response.status, body).message } })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, state: { status: 'error', message: studioReadMessage(error) } })
    })
    return () => controller.abort()
  }, [productId, channel, market, accountId, listingId, key, enabled])
  const state: DestinationState = !enabled ? { status: 'idle' } : result?.key === key ? result.state : { status: 'loading' }
  return state.status === 'error' ? { ...state, retry } : state
}
