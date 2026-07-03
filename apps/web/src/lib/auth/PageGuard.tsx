'use client'

/**
 * Phase S3/S5 — client route guard. Renders a clean in-content 403 (keeping
 * the app chrome so the user can navigate away) when a signed-in user opens
 * a page their role doesn't permit — instead of the page shell filling with
 * "HTTP 403" errors and empty widgets. Reuses the same href→page-permission
 * map as the nav filter, so what's hidden in the nav is also blocked on
 * direct navigation. The server remains the real boundary; this is UX.
 */

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { useAuth, isPublicPath } from './AuthProvider'
import { navPagePermission } from './nav-permissions'

export function PageGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  const { status, has } = useAuth()

  // Only gate a resolved, signed-in user on a route with a known permission.
  // Anonymous (login redirect handles enforce) and public routes pass through.
  if (status === 'authed' && !isPublicPath(pathname)) {
    const required = navPagePermission(pathname)
    if (required && !has(required)) {
      return <Forbidden />
    }
  }
  return <>{children}</>
}

function Forbidden() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-500">
        <ShieldAlert size={26} />
      </div>
      <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        You don't have permission to view this page. Ask your workspace Owner if you need access.
      </p>
      <a
        href="/dashboard/overview"
        className="mt-5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
      >
        Back to dashboard
      </a>
    </div>
  )
}
