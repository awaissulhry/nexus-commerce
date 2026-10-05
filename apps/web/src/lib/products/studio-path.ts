/**
 * The product studio of one product: the one page that edits a product and publishes it (the Owner's (a), 2026-10-02 —
 * every link that opened the old listing wizard, `/products/<id>/list-wizard`, opens this instead).
 *
 * Workspace-relative on purpose: render it through the workspace `Link` / `useRouter` (`@/lib/workspaces/*`), or
 * `workspaceHref`, which add the business (`/w/<id>`). `channel` / `market` open the studio on that channel · market,
 * as the wizard's `?channel=&marketplace=` did. `account` and `listing` (aliases, Owner 2026-10-05) open it on one
 * account and one listing of that market — `listing` is an alias id, which the studio resolves only inside its
 * account, so it is carried only with the channel, market and account it belongs to.
 */
export function productStudioPath(productId: string, at: { channel?: string | null; market?: string | null; account?: string | null; listing?: string | null } = {}): string {
  const query = new URLSearchParams()
  if (at.channel) query.set('scope', at.channel.toUpperCase())
  if (at.channel && at.market) query.set('market', at.market.toUpperCase())
  if (at.channel && at.market && at.account) {
    query.set('account', at.account)
    if (at.listing) query.set('listing', at.listing)
  }
  const search = query.toString()
  return `/products/${encodeURIComponent(productId)}/edit/studio${search ? `?${search}` : ''}`
}
