'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { usePathname } from 'next/navigation'
import { WORKSPACES_ENABLED, workspaceFromPath } from '@/lib/workspaces/paths'
import { fetchProfilePage } from '@/lib/workspaces/profile-directory'

export interface BusinessProfile {
  id: string
  name: string
  version: number
  status: string
  membershipId: string
  roleNames: string[]
  isOwner: boolean
  canConnectAccounts?: boolean
}
interface ProfileScopeValue {
  profiles: BusinessProfile[]
  activeProfile: BusinessProfile | null
  loaded: boolean
  error: string | null
  hasMore: boolean
  refresh: () => Promise<void>
  has: (permission: string) => boolean
}
const Context = createContext<ProfileScopeValue>({ profiles: [], activeProfile: null, loaded: false, error: null, hasMore: false, refresh: async () => {}, has: () => false })
export function ProfileScopeProvider({ children }: { children: ReactNode }) {
  const { status, user, has } = useAuth()
  const generation = useRef(0)
  const pathname = usePathname() ?? '/'
  const [profiles, setProfiles] = useState<BusinessProfile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [selectedProfile, setSelectedProfile] = useState<BusinessProfile | null>(null)
  const id = workspaceFromPath(pathname)
  const refresh = useCallback(async () => {
    const requestId = ++generation.current
    if (!WORKSPACES_ENABLED || status !== 'authed') { setProfiles([]); setSelectedProfile(null); setHasMore(false); setError(null); setLoaded(status !== 'loading'); return }
    setError(null)
    try {
      const [data, selected] = await Promise.all([
        fetchProfilePage({ limit: 12 }),
        id ? fetch(`${getBackendUrl()}/api/workspaces/${encodeURIComponent(id)}`, { credentials: 'include', cache: 'no-store' }).then(async response => {
          const result = await response.json()
          if (!response.ok) throw new Error(result.error ?? 'The selected profile is unavailable.')
          if (result.workspace?.id !== id) throw new Error('The selected profile could not be verified.')
          return result.workspace as BusinessProfile
        }) : Promise.resolve(null),
      ])
      if (requestId === generation.current) { setProfiles(data.workspaces); setHasMore(!!data.nextCursor); setSelectedProfile(selected) }
    } catch (err) { if (requestId === generation.current) { setProfiles([]); setSelectedProfile(null); setHasMore(false); setError(err instanceof Error ? err.message : 'Business profiles could not be loaded.') } }
    finally { if (requestId === generation.current) setLoaded(true) }
  }, [status, user?.id, id])
  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])
  const activeProfile = selectedProfile?.id === id ? selectedProfile : profiles.find(profile => profile.id === id) ?? null
  const value = useMemo(() => ({ profiles, activeProfile, loaded, error, hasMore, refresh, has }), [profiles, activeProfile, loaded, error, hasMore, refresh, has])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useProfileScope() { return useContext(Context) }
