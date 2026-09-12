'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { linkedEndpoint, linkedRequest } from './api'
import { createSchemaRefresh } from './schemaRefresh'

export function useLiveShopifySchema(path: string | null, canEdit: boolean) {
  const [resolved, setResolved] = useState<{ path: string; schema: ShopifyStoreSchema } | null>(null), [error, setError] = useState('')
  const schema = resolved?.path === path ? resolved.schema : null
  const [liveIssue, setLiveIssue] = useState('')
  const reader = useRef<ReturnType<typeof createSchemaRefresh<ShopifyStoreSchema>> | null>(null)
  const refreshConstraints = useRef(false)
  const accountId = new URLSearchParams(path?.split('?')[1]).get('accountId')
  const refresh = useCallback(() => { refreshConstraints.current = true; return reader.current?.refresh() ?? Promise.resolve() }, [])
  useEffect(() => {
    setResolved(null); setError(''); refreshConstraints.current = false
    if (!path) return
    const current = createSchemaRefresh(
      signal => {
        const force = refreshConstraints.current; refreshConstraints.current = false
        return linkedRequest<ShopifyStoreSchema>(linkedEndpoint(path, '/schema', { refreshConstraints: force ? '1' : undefined }), 'GET', undefined, signal)
      },
      next => { setResolved(previous => previous?.path === path && previous.schema.revision === next.revision ? previous : { path, schema: next }); setError('') },
      e => setError(e instanceof Error ? e.message : 'Store attributes could not be refreshed.'),
    )
    reader.current = current
    void current.refresh()
    const visible = () => { if (document.visibilityState === 'visible') void current.refresh() }
    const timer = setInterval(visible, 30_000)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    window.addEventListener('online', visible)
    return () => {
      current.dispose(); clearInterval(timer)
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible); window.removeEventListener('online', visible)
      if (reader.current === current) reader.current = null
    }
  }, [path])
  useInvalidationChannel(['shopify.schema.changed'], event => {
    if (event.id === accountId) void refresh()
  })
  useEffect(() => {
    if (!canEdit || !path) return
    const controller = new AbortController()
    setLiveIssue('')
    void linkedRequest<{ live: boolean; reason?: string }>(linkedEndpoint(path, '/schema-subscriptions'), 'POST', {}, controller.signal)
      .then(result => { if (!controller.signal.aborted) setLiveIssue(result.live ? '' : result.reason ?? 'Live attribute notifications are unavailable.') })
      .catch(e => { if (!controller.signal.aborted) setLiveIssue(e.message) })
    return () => controller.abort()
  }, [path, canEdit])
  return { schema, error, liveIssue, refresh }
}
