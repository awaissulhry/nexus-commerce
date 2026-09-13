'use client'
import { EmptyState } from '@/design-system/components'
import { useStudioProduct, useStudioScope } from '../contracts'
import { ShopifyLinkedWorkspace } from './ShopifyLinkedWorkspace'

export function ShopifyLinkedRoute({ view }: { view: 'family' | 'content' }) {
  const product = useStudioProduct(), { accountId, listingId, destination, scopeError, accounts, locale } = useStudioScope()
  if (scopeError) return <EmptyState title="Shopify destination unavailable" description={scopeError} />
  if (destination.status !== 'ready') return <p role="status">Loading Shopify destination…</p>
  if (!accountId) return <EmptyState title="Choose a Shopify account" description="Select the connected store to manage its family and custom content." />
  const query = new URLSearchParams({ accountId, market: 'GLOBAL', ...(listingId ? { listingId } : {}), ...(locale ? { locale } : {}) })
  const path = `/api/products/${encodeURIComponent(product.id)}/shopify-linked?${query}`
  const selectedAccount = accounts.find(a => a.id === accountId)
  return <ShopifyLinkedWorkspace key={path} path={path} accountLabel={selectedAccount?.label == null ? 'Account label not reported' : selectedAccount.label} view={view} />
}
export function ShopifyFamilyTab() { return <ShopifyLinkedRoute view="family" /> }
export function ShopifyMetafieldsTab() { return <ShopifyLinkedRoute view="content" /> }

