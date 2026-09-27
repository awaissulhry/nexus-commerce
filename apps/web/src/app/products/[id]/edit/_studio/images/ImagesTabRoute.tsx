'use client'

/**
 * PES.7 — the route binding for the Images tab.
 *
 * `StudioTabHost` renders each tab as a zero-prop component, so the product id is resolved here
 * from the route rather than threaded through the host's switch. That keeps PES.7's mount to ONE
 * line inside PES.1's file, which is the contract the host states ("each lane replaces exactly one
 * branch of this switch with its own component and touches nothing else").
 *
 * The frame's provider does hold the product, but does not publish it as a hook; `useParams()`
 * needs nothing from PES.1 and cannot drift from the URL the frame is already keyed to.
 */
import type { ReactNode } from 'react'
import { TooltipPortalProvider } from '@/design-system/primitives'
import { useStudioProduct, useStudioScope } from '../contracts'
import { ImagesTab } from './ImagesTab'
import { EbayMediaRoute } from './ebay/EbayMediaRoute'
import { AmazonMediaRoute } from './amazon/AmazonMediaRoute'
import { ShopifyContentRoute } from './shopify/ShopifyContentRoute'
import { MediaPlanRoute } from './plan-page/MediaPlanRoute'

export function ImagesTabRoute() {
  const product = useStudioProduct()
  const { scope, destination } = useStudioScope()
  // Images rebuild P3b: a family on the photo plan gets the new Media page; the others keep these tools until P6.
  const fallback = (header?: ReactNode) => scope === 'EBAY' ? <EbayMediaRoute />
    : scope === 'AMAZON' ? <AmazonMediaRoute />
    : scope === 'SHOPIFY' ? <ShopifyContentRoute />
    : <ImagesTab header={header} productId={destination.status === 'ready' ? destination.data.listing?.productId ?? product.id : product.id} />
  // The tab is a scroll area: its tooltips draw in a portal, so a hidden one at the right edge cannot widen it (2026-09-28).
  return <TooltipPortalProvider><MediaPlanRoute productId={product.id} fallback={fallback} /></TooltipPortalProvider>
}
