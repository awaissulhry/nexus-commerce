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
import { useStudioProduct, useStudioScope } from '../contracts'
import { ImagesTab } from './ImagesTab'
import { EbayMediaRoute } from './ebay/EbayMediaRoute'
import { AmazonMediaRoute } from './amazon/AmazonMediaRoute'
import { ShopifyContentRoute } from './shopify/ShopifyContentRoute'

export function ImagesTabRoute() {
  const product = useStudioProduct()
  const { scope, destination } = useStudioScope()
  if (scope === 'EBAY') return <EbayMediaRoute />
  if (scope === 'AMAZON') return <AmazonMediaRoute />
  if (scope === 'SHOPIFY') return <ShopifyContentRoute />
  return <ImagesTab productId={destination.status === 'ready' ? destination.data.listing?.productId ?? product.id : product.id} />
}
