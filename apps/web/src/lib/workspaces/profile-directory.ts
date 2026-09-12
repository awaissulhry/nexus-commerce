'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { useAuth } from '@/lib/auth/AuthProvider'
import { WORKSPACES_ENABLED } from './paths'
import type { BusinessProfile } from '@/app/_shared/ProfileScope'

export interface ProfileDirectoryQuery {
  q?: string
  cursor?: string
  limit?: number
  status?: 'active' | 'archived'
  permission?: 'connect' | 'owner'
}
export interface ProfileDirectoryPage { workspaces: BusinessProfile[]; nextCursor: string | null }

export async function fetchProfilePage(query: ProfileDirectoryQuery = {}, signal?: AbortSignal): Promise<ProfileDirectoryPage> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
  const response = await fetch(`${getBackendUrl()}/api/workspaces?${params}`, { credentials: 'include', cache: 'no-store', signal })
  const data = await response.json()
  if (!response.ok || !Array.isArray(data.workspaces)) throw new Error(data.error ?? 'Business profiles could not be loaded.')
  if (data.nextCursor != null && typeof data.nextCursor !== 'string') throw new Error('Business profiles could not be loaded.')
  return { workspaces: data.workspaces, nextCursor: data.nextCursor ?? null }
}

/** Only the current page is retained; search changes hide stale choices immediately. */
export function useProfileDirectory({ q = '', status = 'active', permission, limit = 24, enabled = true }: ProfileDirectoryQuery & { enabled?: boolean } = {}) {
  const auth = useAuth()
  const filter = JSON.stringify([auth.user?.id, q.trim(), status, permission, limit])
  const [navigation, setNavigation] = useState<{ filter: string; cursors: Array<string | undefined> }>({ filter, cursors: [undefined] })
  const cursors = navigation.filter === filter ? navigation.cursors : [undefined]
  const cursor = cursors[cursors.length - 1]
  const key = JSON.stringify([filter, cursor])
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; page: ProfileDirectoryPage; loading: boolean; error: string | null } | null>(null)
  const generation = useRef(0)
  const active = enabled && WORKSPACES_ENABLED && auth.status === 'authed'
  useEffect(() => {
    const requestId = ++generation.current
    if (!active) return
    const abort = new AbortController()
    setState({ key, page: { workspaces: [], nextCursor: null }, loading: true, error: null })
    const timer = window.setTimeout(() => {
      void fetchProfilePage({ q: q.trim(), cursor, status, permission, limit }, abort.signal).then(page => {
        if (generation.current === requestId) setState({ key, page, loading: false, error: null })
      }).catch(error => {
        if (!abort.signal.aborted && generation.current === requestId) setState({ key, page: { workspaces: [], nextCursor: null }, loading: false, error: error instanceof Error ? error.message : 'Profiles could not be loaded.' })
      })
    }, q.trim() ? 250 : 0)
    return () => { generation.current++; window.clearTimeout(timer); abort.abort() }
  }, [key, active, revision, q, cursor, status, permission, limit])
  const current = active && state?.key === key ? state : null
  const refresh = useCallback(async () => { setRevision(value => value + 1) }, [])
  return {
    profiles: current?.page.workspaces ?? [], nextCursor: current?.page.nextCursor ?? null,
    loading: active && (!current || current.loading), error: current?.error ?? null,
    page: cursors.length, refresh,
    next: () => { if (!current?.loading && current?.page.nextCursor) setNavigation({ filter, cursors: [...cursors, current.page.nextCursor] }) },
    previous: () => { if (cursors.length > 1) setNavigation({ filter, cursors: cursors.slice(0, -1) }) },
  }
}
