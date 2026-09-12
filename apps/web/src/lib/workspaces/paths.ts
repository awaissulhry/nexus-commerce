/** Profile identity is part of the URL, so tabs and copied links keep their own context. */
export const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1'
const PREFIX = /^\/w\/([a-zA-Z0-9_-]{8,100})(?=\/|$)/
export function workspaceFromPath(path: string): string | null { return PREFIX.exec(path)?.[1] ?? null }
export function withoutWorkspace(path: string): string { return path.replace(PREFIX, '') || '/' }
export function isIdentityPath(path: string): boolean {
  return ['/login', '/403', '/accept-invite', '/accept-workspace-invite', '/forgot-password', '/reset-password', '/profiles', '/r', '/po', '/track', '/unsubscribed', '/settings/profile', '/settings/profiles', '/settings/security', '/settings/notifications'].some(p => path === p || path.startsWith(`${p}/`))
}
export function workspaceHref(id: string | null, href: string): string {
  if (!WORKSPACES_ENABLED || !id || !href.startsWith('/') || href.startsWith('//') || workspaceFromPath(href) || isIdentityPath(href.split(/[?#]/)[0]) || /^\/(?:api|backend|_next)(?:\/|$)/.test(href)) return href
  return `/w/${id}${href}`
}
export function browserWorkspaceId(): string | null {
  return typeof window === 'undefined' ? null : workspaceFromPath(window.location.pathname)
}

/** Preserve a section when switching, while leaving record IDs and account filters behind. */
export function workspaceSwitchPath(path: string): string {
  const current = withoutWorkspace(path).split(/[?#]/)[0]
  const sections = ['/settings/channels', '/settings/account', '/settings/company', '/settings/team', '/settings/terminology', '/settings/profiles', '/fulfillment/stock', '/fulfillment/inbound', '/fulfillment/outbound', '/fulfillment/purchase-orders', '/products', '/listings', '/orders', '/pricing', '/insights', '/sync-logs']
  return sections.find(section => current === section || current.startsWith(`${section}/`)) ?? '/dashboard/overview'
}
