import ListingsWorkspace from '../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function WooCommerceListingsPage() {
  return (
    <ListingsWorkspace
      lockChannel="WOOCOMMERCE"
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'WooCommerce' }]}
    />
  )
}
