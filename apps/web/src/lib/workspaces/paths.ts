import { isPublicPath } from '../auth/public-paths'

/** Profile identity is part of the URL, so tabs and copied links keep their own context. */
export const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1'
const PREFIX = /^\/w\/([a-zA-Z0-9_-]{8,100})(?=\/|$)/
export function workspaceFromPath(path: string): string | null { return PREFIX.exec(path)?.[1] ?? null }
export function withoutWorkspace(path: string): string { return path.replace(PREFIX, '') || '/' }
/** Profile-free routes: every public route (one list, lib/auth/public-paths) plus the personal pages. */
export function isIdentityPath(path: string): boolean {
  return isPublicPath(path) || ['/login', '/403', '/accept-invite', '/accept-workspace-invite', '/forgot-password', '/reset-password', '/profiles', '/r', '/po', '/track', '/unsubscribed', '/settings/profile', '/settings/profiles', '/settings/security', '/settings/notifications'].some(p => path === p || path.startsWith(`${p}/`))
}
export function workspaceHref(id: string | null, href: string): string {
  if (!WORKSPACES_ENABLED || !id || !href.startsWith('/') || href.startsWith('//') || workspaceFromPath(href) || isIdentityPath(href.split(/[?#]/)[0]) || /^\/(?:api|backend|_next)(?:\/|$)/.test(href)) return href
  return `/w/${id}${href}`
}

/**
 * Next's own query parameters, which never belong in an address. `_rsc` rides on every React Server Component request
 * (a client-side navigation or a prefetch), so a redirect built from such a request carried it into `next` and the
 * address bar: `/profiles?next=%2Fdashboard%2Foverview%3F_rsc%3D…` after every sign-in (2026-09-30). It is the whole of
 * the list Next strips itself (INTERNAL_QUERY_NAMES, next/dist/server/internal-utils.js, Next 16.3).
 */
export const NEXT_INTERNAL_QUERY: readonly string[] = ['_rsc']

/** `href` without Next's internal query parameters. Everything else (path, other parameters, their order and spelling, hash) is kept as it is. */
export function withoutNextInternals(href: string): string {
  const hashAt = href.indexOf('#')
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt)
  const queryAt = beforeHash.indexOf('?')
  if (queryAt < 0) return href
  const parts = beforeHash.slice(queryAt + 1).split('&')
  const internal = (part: string) => {
    const name = part.split('=')[0].replace(/\+/g, ' ')
    try { return NEXT_INTERNAL_QUERY.includes(decodeURIComponent(name)) } catch { return false }
  }
  if (!parts.some(internal)) return href
  const kept = parts.filter(part => !internal(part))
  return `${beforeHash.slice(0, queryAt)}${kept.length ? `?${kept.join('&')}` : ''}${hashAt < 0 ? '' : href.slice(hashAt)}`
}

/** Where sign-in goes: a same-site `next` path (never another site, never a backslash trick) without Next's internals, else the dashboard. */
export function afterSignInPath(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? withoutNextInternals(next) : '/dashboard/overview'
}

export function browserWorkspaceId(): string | null {
  return typeof window === 'undefined' ? null : workspaceFromPath(window.location.pathname)
}

/** Preserve a section when switching, while leaving record IDs and account filters behind. */
export function workspaceSwitchPath(path: string): string {
  const current = withoutWorkspace(path).split(/[?#]/)[0]
  const sections = ['/settings/channels', '/settings/account', '/settings/company', '/settings/team', '/settings/terminology', '/settings/sharing', '/settings/profiles', '/fulfillment/stock', '/fulfillment/inbound', '/fulfillment/outbound', '/fulfillment/purchase-orders', '/products', '/listings', '/orders', '/pricing', '/insights', '/sync-logs']
  return sections.find(section => current === section || current.startsWith(`${section}/`)) ?? '/dashboard/overview'
}

/**
 * Where "Open profile" on the picker goes: the page the person asked for (`next`, which the proxy sets when a page
 * without a business in its URL sends them here) inside the chosen business, else that business's dashboard. Only a
 * same-site path is followed (never another site, never a backslash trick), a business already in `next` is replaced
 * by the chosen one, and a page that belongs to no business (the picker itself, sign-in, personal settings) is not.
 */
export function profileEntryHref(profileId: string, next: string | null | undefined): string {
  const dashboard = `/w/${profileId}/dashboard/overview`
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return dashboard
  next = withoutNextInternals(next)
  const at = next.search(/[?#]/)
  const path = withoutWorkspace(at < 0 ? next : next.slice(0, at))
  if (path === '/' || isIdentityPath(path) || /^\/(?:api|backend|_next)(?:\/|$)/.test(path)) return dashboard
  return `/w/${profileId}${path}${at < 0 ? '' : next.slice(at)}`
}
