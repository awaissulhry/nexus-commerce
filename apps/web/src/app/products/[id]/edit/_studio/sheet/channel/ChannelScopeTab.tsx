'use client'

/**
 * PES.3 — the mountable entry point for a channel scope.
 *
 * The frame owns the scope bar and the URL (`?scope&market&locale&tab`); `ChannelSheet` owns the
 * grid and takes its coordinate as plain props, which keeps it testable and free of context. This
 * is the seam between them: it reads PES.1's published `useStudioScope()` and renders the sheet for
 * whatever channel×market the operator has selected.
 *
 * It renders NOTHING for the master scope — that is PES.2's sheet, and a lane that guessed at
 * another lane's surface would be the fork this programme exists to avoid.
 */
import { useEffect, useState } from 'react'
import { useAuth, usePermission } from '@/lib/auth/AuthProvider'
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { useLiveShopifySchema } from '../../shopify/useLiveShopifySchema'
import { useStudioProduct, useStudioScope } from '../../contracts'

import { ChannelSheet } from './ChannelSheet'
import type { ChannelScopeChannel } from './types'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'

export interface ChannelScopeTabProps {
  /** Override the frame's product — only a lab or a test passes this. */
  productId?: string
  shopifySchema?: ShopifyStoreSchema | null
}

export function ChannelScopeTab({ productId: override, shopifySchema }: ChannelScopeTabProps = {}) {
  const product = useStudioProduct()
  const { accountId, listingId, locale, scope, coordinate, registerShopifyLocales, setTab } = useStudioScope()
  const productId = override ?? product.id
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

  // Master is PES.2's. `coordinate` is null there by contract, so this is belt and braces.
  if (scope === 'master' || !coordinate) return null

  return (<>
    {recoveryAt && recoveryAt === recoveryKey && <Banner tone="warning" action={<Button size="sm" onClick={() => setTab('shopify-family')}>Review recovered changes</Button>}>A recovery copy from the previous Shopify editor is retained in this browser. Review it in Product family.</Banner>}
    {capabilities.error && <Banner tone="warning" action={<Button size="sm" onClick={() => void capabilities.refresh()}>Retry attributes</Button>}>{capabilities.error}</Banner>}
    <ChannelSheet
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
