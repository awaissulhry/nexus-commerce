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
import { usePathname, useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { installAuthFetch } from './install-fetch'
import { setCsrfToken } from './csrf-store'

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

const ENFORCE = process.env.NEXT_PUBLIC_AUTH_ENFORCE === '1'

// Routes reachable without a session. Keep in sync with the API manifest's
// PUBLIC set + the auth pages.
const PUBLIC_PREFIXES = [
  '/login',
  '/403',
  '/accept-invite',
  '/reset-password',
  '/forgot-password',
  '/r/',
  '/po/',
  '/track/',
  '/unsubscribed',
  '/settings/channels/ebay-callback',
]
export function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [permissions, setPermissions] = useState<Set<string>>(new Set())
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const loadedOnce = useRef(false)

  async function load(): Promise<void> {
    installAuthFetch()
    const base = getBackendUrl()
    try {
      const csrf = await fetch(`${base}/api/auth/csrf`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
      if (csrf?.csrfToken) setCsrfToken(csrf.csrfToken)

      const res = await fetch(`${base}/api/auth/me`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setUser(data.user ?? null)
        setIsOwner(!!data.isOwner)
        setPermissions(new Set<string>(data.permissions ?? []))
        setStatus('authed')
      } else {
        setUser(null)
        setIsOwner(false)
        setPermissions(new Set())
        setStatus('anon')
      }
    } catch {
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
  // enforce mode, render nothing (a splash) instead of the app chrome.
  if (ENFORCE && status === 'loading' && !isPublicPath(pathname)) {
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
