'use client'

import { EmptyState } from '@/design-system/components'
import { useStudioProduct, useStudioScope } from '../../contracts'
import { EbayMediaWorkspace } from './EbayMediaWorkspace'

export function EbayMediaRoute() {
  const product = useStudioProduct()
  const { market, accountId, listingId, destination, setListing, scopeError, accounts } = useStudioScope()
  const productId = destination.status === 'ready' ? destination.data.listing?.productId ?? product.id : product.id
  const params = new URLSearchParams()
  if (market) params.set('market', market)
  if (accountId !== undefined) params.set('accountId', accountId)
  const selectedListingId = destination.status === 'ready' ? destination.data.listing?.id ?? listingId : listingId
  if (selectedListingId !== undefined) params.set('listingId', selectedListingId)
  const path = `/api/products/${encodeURIComponent(productId)}/images-workspace/ebay?${params}`
  if (scopeError) return <EmptyState title="Listing destination unavailable" description={scopeError} />
  if (destination.status !== 'ready') return <p role="status">Loading listing destination…</p>
  return <EbayMediaWorkspace key={path} path={path} productId={productId} onListingChange={setListing} accountLabel={accounts.find(account => account.id === accountId)?.label ?? accountId ?? 'Selected account'} />
}
