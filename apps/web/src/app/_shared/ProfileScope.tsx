'use client'

/**
 * TB.6 — the active PROFILE, and what switching one actually does.
 *
 * "Profile" is `Role` in the schema: a named permission bundle (`Role { key, name, permissions[] }`),
 * assigned through `UserRole`, managed at /settings/team, served by `GET /api/team/roles`.
 *
 * ── 🔴 Read this before changing what a switch means ─────────────────────────────────────────
 *
 * A user's effective permissions are the **UNION** of their role assignments — `AuthProvider`
 * resolves that union and the API's `rbac-hook` enforces it. There is therefore no server-side
 * "active role" to select, and this provider does not invent one.
 *
 * What selecting a profile does is **narrow the VIEW**: `has()` below answers as if only that
 * profile's permissions were held, and the rail filters through it (`filterNavByPermission`).
 * What it does NOT do is change what the server allows — the union still governs every request.
 *
 * That asymmetry is safe in exactly one direction. Narrowing a view can only ever HIDE things the
 * user is still permitted to do; it can never reveal something they are not. Were it reversed —
 * a switcher that appeared to GRANT access the server would refuse — it would be a lying UI, and
 * a security theatre one at that.
 *
 * The menu says this in plain words rather than leaving it implied. If per-account or per-profile
 * enforcement is wanted later, that is MAP.8, and the 2026-08-19 finding stands: `channelScope`
 * is inert end to end, the RBAC hook runs before the handler so it cannot know which account a
 * request will touch, and half-built authorization is worse than none.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'

export interface Profile {
  id: string
  key: string
  name: string
  description: string
  permissions: string[]
  isSystem: boolean
  isOwner: boolean
  memberCount: number
}

interface ProfileScopeValue {
  /** Every profile, when the session may read them. Empty otherwise — never a partial guess. */
  profiles: Profile[]
  /** The profile whose view is active, or null for "all my access" (the union). */
  activeKey: string | null
  activeProfile: Profile | null
  setActiveKey: (key: string | null) => void
  /**
   * `false` when there is nothing a selection could change — one profile, or no readable
   * permission lists. The AccountSwitcher precedent (MAP.4) applies: a dropdown that cannot
   * change anything is worse than no dropdown, so the control renders informational instead.
   */
  canSwitch: boolean
  /** Permission predicate, narrowed to `activeProfile` when one is selected. */
  has: (permission: string) => boolean
  loaded: boolean
}

const STORAGE_KEY = 'nexus.profile.active'

const ProfileScopeContext = createContext<ProfileScopeValue>({
  profiles: [],
  activeKey: null,
  activeProfile: null,
  setActiveKey: () => {},
  canSwitch: false,
  has: () => true,
  loaded: false,
})

export function ProfileScopeProvider({ children }: { children: ReactNode }) {
  const { status, has: unionHas } = useAuth()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeKey, setActiveKeyState] = useState<string | null>(null)

  // Restore the last selection. localStorage is read after mount so SSR and the first client
  // render agree — the same hydration rule the rail's recently-viewed list follows.
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY)
      if (v) setActiveKeyState(v)
    } catch {
      /* private mode / blocked storage — the union default is correct anyway */
    }
  }, [])

  useEffect(() => {
    if (status !== 'authed') {
      setLoaded(true)
      return
    }
    let cancelled = false
    // `GET /api/team/roles` requires the roles-manage permission. A member without it gets a
    // 401/403, which is not an error condition here — it means "no roster to show", and the
    // control falls back to informational. Never surface it as a failure.
    fetch(`${getBackendUrl()}/api/team/roles`, { cache: 'no-store', credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        setProfiles(Array.isArray(data?.roles) ? data.roles : [])
      })
      .catch(() => {
        /* chrome must never crash the shell */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [status])

  const setActiveKey = useCallback((key: string | null) => {
    setActiveKeyState(key)
    try {
      if (key) localStorage.setItem(STORAGE_KEY, key)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* selection still applies for this session */
    }
  }, [])

  const activeProfile = useMemo(
    () => (activeKey ? (profiles.find((p) => p.key === activeKey) ?? null) : null),
    [activeKey, profiles],
  )

  // A stored key for a profile that has since been deleted or become unreadable must not leave
  // the view silently narrowed by a profile nobody can see. Fall back to the union.
  useEffect(() => {
    if (loaded && activeKey && profiles.length > 0 && !activeProfile) setActiveKey(null)
  }, [loaded, activeKey, profiles, activeProfile, setActiveKey])

  const canSwitch = profiles.length > 1

  const has = useCallback(
    (permission: string) => {
      if (!activeProfile) return unionHas(permission)
      // OWNER is implicit-all: enforcement never reads its permission list, so neither does this.
      if (activeProfile.isOwner) return true
      return activeProfile.permissions.includes(permission)
    },
    [activeProfile, unionHas],
  )

  const value = useMemo<ProfileScopeValue>(
    () => ({ profiles, activeKey, activeProfile, setActiveKey, canSwitch, has, loaded }),
    [profiles, activeKey, activeProfile, setActiveKey, canSwitch, has, loaded],
  )

  return <ProfileScopeContext.Provider value={value}>{children}</ProfileScopeContext.Provider>
}

export function useProfileScope(): ProfileScopeValue {
  return useContext(ProfileScopeContext)
}
