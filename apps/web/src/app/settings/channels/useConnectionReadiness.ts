'use client'

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'

type SetupState = { key: string; ready: boolean; error: string | null }

/** Check before the user opens a provider tab. Start still revalidates on the server. */
export function useConnectionReadiness(channelKey: string, workspaceId?: string) {
  const checked = channelKey === 'SHOPIFY' || channelKey === 'ETSY'
  const key = `${channelKey}:${workspaceId ?? ''}`
  const [state, setState] = useState<SetupState | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!checked || (WORKSPACES_ENABLED && !workspaceId)) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let cancelled = false
    setState(null)
    void (async () => {
      try {
        const response = await fetch(`${getBackendUrl()}/api/cx/connect/${channelKey.toLowerCase()}/readiness`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
          headers: WORKSPACES_ENABLED && workspaceId ? { 'x-nexus-workspace-id': workspaceId } : {},
        })
        const data = await response.json() as { ready?: boolean; error?: string }
        if (!response.ok || data.ready !== true) {
          throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Nexus could not check the connection setup. Try again in a moment.')
        }
        if (!cancelled) setState({ key, ready: true, error: null })
      } catch (err) {
        if (!cancelled) setState({ key, ready: false, error: err instanceof Error && err.name === 'Error' ? err.message : 'Nexus could not check the connection setup. Check your connection and try again.' })
      } finally { clearTimeout(timeout) }
    })()
    return () => { cancelled = true; clearTimeout(timeout); controller.abort() }
  }, [checked, channelKey, workspaceId, key, attempt])
  const current = state?.key === key ? state : null
  return {
    ready: !checked || current?.ready === true,
    checking: checked && (!WORKSPACES_ENABLED || !!workspaceId) && !current,
    error: checked ? current?.error ?? null : null,
    retry: () => { setState(null); setAttempt(value => value + 1) },
  }
}
