/**
 * The product studio of one product: the one page that edits a product and publishes it (the Owner's (a), 2026-10-02 —
 * every link that opened the old listing wizard, `/products/<id>/list-wizard`, opens this instead).
 *
 * Workspace-relative on purpose: render it through the workspace `Link` / `useRouter` (`@/lib/workspaces/*`), or
 * `workspaceHref`, which add the business (`/w/<id>`). `channel` / `market` open the studio on that channel · market,
 * as the wizard's `?channel=&marketplace=` did.
 */
export function productStudioPath(productId: string, at: { channel?: string | null; market?: string | null } = {}): string {
  const query = new URLSearchParams()
  if (at.channel) query.set('scope', at.channel.toUpperCase())
  if (at.channel && at.market) query.set('market', at.market.toUpperCase())
  const search = query.toString()
  return `/products/${encodeURIComponent(productId)}/edit/studio${search ? `?${search}` : ''}`
}
