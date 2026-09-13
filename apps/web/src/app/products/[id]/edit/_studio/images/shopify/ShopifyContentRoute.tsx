'use client'
import { EmptyState } from '@/design-system/components'
import { useStudioProduct, useStudioScope } from '../../contracts'
import { ShopifyContentWorkspace } from './ShopifyContentWorkspace'

export function ShopifyContentRoute() {
  const product = useStudioProduct()
  const { accountId, destination, scopeError, accounts } = useStudioScope()
  if (scopeError) return <EmptyState title="Shopify destination unavailable" description={scopeError} />
  if (destination.status !== 'ready') return <p role="status">Loading Shopify destination…</p>
  if (!accountId) return <EmptyState title="Choose a Shopify account" description="Select the connected store to manage its family content." />
  const path = `/api/products/${encodeURIComponent(product.id)}/shopify-content?accountId=${encodeURIComponent(accountId)}&market=GLOBAL`
  const selectedAccount = accounts.find(a => a.id === accountId)
  return <ShopifyContentWorkspace key={path} path={path} accountLabel={selectedAccount?.label == null ? 'Account label not reported' : selectedAccount.label} />
}
