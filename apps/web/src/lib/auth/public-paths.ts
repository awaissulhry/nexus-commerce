/**
 * Routes reachable without a session — the ONE list. Keep in sync with the API manifest's PUBLIC set
 * + the auth pages.
 *
 * No imports and no React: the client auth guard (AuthProvider, PageGuard) and the profile routing
 * (lib/workspaces/paths → proxy.ts) both read it. A page reachable without a session can never need a
 * business profile, so paths.ts treats every entry here as profile-free. 2026-09-16: the two lived
 * apart, `/settings/channels/ebay-callback` was only in this one, and turning profiles on sent eBay's
 * return (code + state) to the profile picker — no eBay account could be connected.
 */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/login',
  '/403',
  '/accept-invite',
  '/accept-workspace-invite',
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
