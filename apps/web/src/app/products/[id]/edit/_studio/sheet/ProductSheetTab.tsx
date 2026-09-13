'use client'

/** One studio entry point. Scope changes select a data adapter and preserve destination boundaries. */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useAuth, usePermission } from '@/lib/auth/AuthProvider'
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useLiveShopifySchema } from '../shopify/useLiveShopifySchema'
import { useStudioProduct, useStudioScope } from '../contracts'

import { ProductSheet } from './ProductSheet'
import type { ChannelScopeChannel } from './channel/types'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

export interface ProductSheetTabProps {
  /** Override the frame's product — only a lab or a test passes this. */
  productId?: string
  shopifySchema?: ShopifyStoreSchema | null
}

export function ProductSheetTab({ productId: override, shopifySchema }: ProductSheetTabProps = {}) {
  const product = useStudioProduct()
  const params = useParams<{ id: string }>()
  const { accountId, listingId, locale, market, scope, coordinate, registerShopifyLocales, setTab } = useStudioScope()
  const routeId = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''
  const productId = override ?? (scope === 'master' ? routeId : product.id)
  const canEdit = usePermission('products.edit')
  const path = scope === 'SHOPIFY' && accountId ? `/api/products/${encodeURIComponent(productId)}/shopify-linked?${new URLSearchParams({ accountId, market: 'GLOBAL', ...(listingId ? { listingId } : {}), ...(locale ? { locale } : {}) })}` : null
  const capabilities = useLiveShopifySchema(path, canEdit)
  const { user } = useAuth()
  const recoveryKey = path ? `nexus-shopify-draft:${user?.id ?? 'session'}:${path}` : null
  const [recoveryAt, setRecoveryAt] = useState<string | null>(null)
  useEffect(() => {
    try { setRecoveryAt(recoveryKey && sessionStorage.getItem(recoveryKey) ? recoveryKey : null) }
    catch { setRecoveryAt(null) }
  }, [recoveryKey])
  const schema = shopifySchema ?? capabilities.schema
  useEffect(() => { if (schema && accountId) registerShopifyLocales?.(accountId, schema.locales) }, [schema, accountId, registerShopifyLocales])

  if (scope === 'master') {
    if (!productId) return <div style={{ padding: 'var(--nds-space-24)' }}>No product in the route.</div>
    if (!market || !locale) return <div style={{ padding: 'var(--nds-space-24)' }} className="nds-cell-muted">Waiting for the market…</div>
    return <ProductSheet scope="master" productId={productId} market={market} locale={locale} />
  }
  if (!coordinate) return null

  return (<>
    {recoveryAt && recoveryAt === recoveryKey && <Banner tone="warning" action={<Button size="sm" onClick={() => setTab('shopify-family')}>Review recovered changes</Button>}>A recovery copy from the previous Shopify editor is retained in this browser. Review it in Product family.</Banner>}
    {capabilities.error && <Banner tone="warning" action={<Button size="sm" onClick={() => void capabilities.refresh()}>Retry attributes</Button>}>{capabilities.error}</Banner>}
    <ProductSheet
      scope="channel"
      // Remounting on a coordinate change is deliberate: an in-flight write belongs to the
      // coordinate it was made on, and carrying a half-saved grid across to another market would
      // paint one market's pending cells over another's.
      key={`${productId}:${coordinate.channel}:${coordinate.marketplace}:${accountId ?? 'primary'}:${listingId ?? ''}:${locale ?? ''}`}
      accountId={accountId}
      shopifySchema={schema}
      productId={productId}
      channel={coordinate.channel as ChannelScopeChannel}
      marketplace={coordinate.marketplace}
      locale={locale ?? undefined}
    />
  </>)
}
