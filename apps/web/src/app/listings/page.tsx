// Universal /listings workspace — Grid · Health · Matrix · Drafts lenses
// All per-channel pages (/listings/amazon, /ebay, /shopify, /woocommerce,
// /etsy and their [market] subpaths) render this same client shell with
// channel/marketplace presets so users get one consistent surface.

import ListingsWorkspace from './ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ListingsPage() {
  return <ListingsWorkspace />
}
