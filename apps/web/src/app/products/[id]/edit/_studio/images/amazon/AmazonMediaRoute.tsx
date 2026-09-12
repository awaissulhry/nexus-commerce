'use client'
import { EmptyState } from '@/design-system/components'
import { useStudioProduct, useStudioScope } from '../../contracts'
import { AmazonMediaWorkspace } from './AmazonMediaWorkspace'

export function AmazonMediaRoute() {
  const product = useStudioProduct()
  const { market, accountId, listingId, destination, setListing, scopeError, accounts } = useStudioScope()
  const productId = destination.status === 'ready' ? destination.data.listing?.productId ?? product.id : product.id
  const params = new URLSearchParams()
  if (market) params.set('market', market)
  if (accountId) params.set('accountId', accountId)
  const selected = destination.status === 'ready' ? destination.data.listing?.id ?? listingId : listingId
  if (selected) params.set('listingId', selected)
  const path = `/api/products/${encodeURIComponent(productId)}/images-workspace/amazon?${params}`
  if (scopeError) return <EmptyState title="Listing destination unavailable" description={scopeError} />
  if (destination.status !== 'ready') return <p role="status">Loading listing destination…</p>
  return <AmazonMediaWorkspace key={path} path={path} productId={productId} onListingChange={setListing}
    accountLabel={accounts.find(a => a.id === accountId)?.label ?? 'Selected account'} />
}
