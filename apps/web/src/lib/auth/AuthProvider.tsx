'use client'

/**
 * Phase S3 — client-side session + permission provider.
 *
 * On the interim cross-site setup the Next server can't read the API-origin
 * session cookie, so we resolve auth in the browser: install the fetch
 * wrapper, fetch the CSRF token, then GET /api/auth/me for the user +
 * effective permission set. Everything downstream (usePermission, <Can>,
 * nav filtering) reads this context.
 *
 * DEPLOY-SAFE rollout: the anon→login redirect only fires when
 * NEXT_PUBLIC_AUTH_ENFORCE is on — flipped together with the API's
 * NEXUS_RBAC_MODE=enforce (S3 go-live). Until then the app stays open for
 * anonymous use (shadow), so shipping this changes nothing user-visible.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { installAuthFetch } from './install-fetch'
import { setCsrfToken } from './csrf-store'
import { setBrowserUserId } from '../workspaces/browser-identity'
import { isPublicPath } from './public-paths'
import { readSession, rendersBeforeSession } from './session-read'

export interface AuthUser {
  id: string
  email: string
  displayName: string
  roleKeys: string[]
  mfaEnabled: boolean
  mfaRequired: boolean
}

type Status = 'loading' | 'authed' | 'anon'

interface AuthContextValue {
  status: Status
  user: AuthUser | null
  isOwner: boolean
  permissions: Set<string>
  has: (permission: string) => boolean
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  status: 'loading',
  user: null,
  isOwner: false,
  permissions: new Set(),
  has: () => false,
  refresh: async () => {},
})

const ENFORCE = process.env.NEXT_PUBLIC_AUTH_ENFORCE === '1' || process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1'

// Routes reachable without a session live in ./public-paths — the profile routing reads the same list.
export { isPublicPath }

export function AuthProvider({ children }: { children: ReactNode }) {
  /*
   * 2026-09-30 — the fetch wrapper goes in HERE, during the first render, before any child renders.
   *
   * It used to be installed only inside `load()`, which runs from this component's mount EFFECT — and React runs a
   * child's effects BEFORE its parent's. So a child that fetches in its own mount effect went first, on the plain
   * `fetch`: no `credentials: 'include'`, no session cookie, a 401. The notifications bell did exactly that on every
   * page load wherever the app renders its children while auth is still loading (enforce off: local dev), and was
   * only right 30 s later. With enforce on, the splash below kept the children out until `load()` had run, which is
   * why production never showed it.
   *
   * Safe during render: `installAuthFetch` is idempotent (one install per page), a no-op on the server (no `window`),
   * and changes nothing React renders, so hydration is untouched.
   */
  installAuthFetch()
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [permissions, setPermissions] = useState<Set<string>>(new Set())
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const loadedOnce = useRef(false)

  // The fetch patch (credentials, workspace header, CSRF) must be in place before ANY child effect runs: a route that
  // draws while the session loads (`rendersBeforeSession`) starts its reads in effects that run before this provider's.
  useState(() => { installAuthFetch(); return null })

  async function load(): Promise<void> {
    installAuthFetch() // already installed by the first render; kept so `refresh` can never run without it
    const base = getBackendUrl()
    try {
      // CSRF and the session together (P2, I4-2): the token is needed by the first write, not by the session read.
      const { csrfToken, me } = await readSession(base)
      if (csrfToken) setCsrfToken(csrfToken)
      if (me) {
        const data = me as { user?: AuthUser | null; isOwner?: boolean; permissions?: string[] }
        setUser(data.user ?? null)
        setBrowserUserId(data.user?.id ?? null)
        setIsOwner(!!data.isOwner)
        setPermissions(new Set<string>(data.permissions ?? []))
        setStatus('authed')
      } else {
        setBrowserUserId(null)
        setUser(null)
        setIsOwner(false)
        setPermissions(new Set())
        setStatus('anon')
      }
    } catch {
      setBrowserUserId(null)
      setUser(null)
      setIsOwner(false)
      setPermissions(new Set())
      setStatus('anon')
    }
  }

  useEffect(() => {
    if (loadedOnce.current) return
    loadedOnce.current = true
    void load()
  }, [])

  // Enforce-only: bounce anonymous users off protected routes to login.
  useEffect(() => {
    if (!ENFORCE) return
    if (status === 'anon' && !isPublicPath(pathname)) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`)
    }
  }, [status, pathname, router])

  const has = (permission: string): boolean => isOwner || permissions.has(permission)

  // No flash of forbidden content: while resolving on a protected route in
  // enforce mode, render nothing (a splash) instead of the app chrome — except on a route that draws its frame and
  // starts its reads meanwhile (`rendersBeforeSession`); the API refuses those reads without a session either way.
  if (ENFORCE && status === 'loading' && !isPublicPath(pathname) && !rendersBeforeSession(pathname)) {
    return <div aria-busy="true" style={{ minHeight: '100vh' }} />
  }

  return (
    <AuthContext.Provider value={{ status, user, isOwner, permissions, has, refresh: load }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}

export function usePermission(permission: string): boolean {
  return useContext(AuthContext).has(permission)
}

export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: string
  children: ReactNode
  fallback?: ReactNode
}) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>
}
