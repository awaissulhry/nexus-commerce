import { NextRequest, NextResponse } from 'next/server'
import { WORKSPACES_ENABLED, isIdentityPath, workspaceFromPath, withoutWorkspace, workspaceHref } from './lib/workspaces/paths'

export function proxy(request: NextRequest) {
  if (!WORKSPACES_ENABLED) return NextResponse.next()
  const visibleUrl = new URL(request.url)
  const host = request.headers.get('host') ?? ''
  // Next normalizes loopback aliases to localhost; keep a local rewrite on its original origin.
  if (visibleUrl.hostname === 'localhost' && /^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) visibleUrl.host = host
  const path = request.nextUrl.pathname
  const incoming = new Headers(request.headers)
  // These are server routing metadata, never caller-selected authority.
  incoming.delete('x-nexus-page-workspace')
  incoming.set('x-nexus-page-path', withoutWorkspace(path))
  incoming.set('x-nexus-page-method', request.method)
  if (/^\/(?:backend|api)(?:\/|$)/.test(path)) return NextResponse.next({ request: { headers: incoming } })
  const id = workspaceFromPath(path)
  if (id) {
    incoming.set('x-nexus-page-workspace', id)
    const destination = new URL(visibleUrl)
    destination.pathname = withoutWorkspace(path)
    const response = NextResponse.rewrite(destination, { request: { headers: incoming } })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  if (isIdentityPath(path) || path.startsWith('/design')) return NextResponse.next({ request: { headers: incoming } })
  let referringId: string | null = null
  try {
    const referer = new URL(request.headers.get('referer') ?? '')
    if (referer.origin === visibleUrl.origin) referringId = workspaceFromPath(referer.pathname)
  } catch { /* A bookmark has no referrer and starts at the profile picker. */ }
  if (referringId && request.method === 'POST' && request.headers.has('next-action')) {
    incoming.set('x-nexus-page-workspace', referringId)
    return NextResponse.next({ request: { headers: incoming } })
  }
  const destination = new URL(visibleUrl)
  if (referringId) destination.pathname = workspaceHref(referringId, path)
  else { destination.pathname = '/profiles'; destination.search = ''; destination.searchParams.set('next', path + request.nextUrl.search) }
  return NextResponse.redirect(destination, 307)
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|woff2?)$).*)'] }
