'use client'
import { useMemo } from 'react'
import { usePathname as useNextPathname, useRouter as useNextRouter } from 'next/navigation'
import { browserWorkspaceId, withoutWorkspace, workspaceHref } from './paths'
export { useSearchParams, useParams, notFound, redirect, permanentRedirect, useSelectedLayoutSegment, useSelectedLayoutSegments } from 'next/navigation'
export function usePathname() { const path = useNextPathname(); return path ? withoutWorkspace(path) : path }
export function useRouter() {
  const router = useNextRouter()
  return useMemo(() => ({
    ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(workspaceHref(browserWorkspaceId(), href), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(workspaceHref(browserWorkspaceId(), href), options),
    prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(workspaceHref(browserWorkspaceId(), href), options),
  }), [router])
}
