/** Listing links retain the exact listing/account and open the shared product workspace. */
export function productWorkspaceHref(listing: { productId: string; id?: string; channel: string; marketplace: string; channelConnectionId?: string | null; aliasKey?: string }, field?: string) {
  const params = new URLSearchParams({ scope: listing.channel, market: listing.marketplace })
  if (listing.channelConnectionId) params.set('account', listing.channelConnectionId)
  if (listing.id) params.set('listing', listing.id)
  params.set('rec', `${listing.aliasKey || 'primary'}:${listing.productId}`)
  if (field) params.set('cell', field)
  return `/products/${encodeURIComponent(listing.productId)}/edit/studio?${params}`
}
