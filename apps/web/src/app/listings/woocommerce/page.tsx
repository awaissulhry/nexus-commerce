import WooCommerceListingsClient from './WooCommerceListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function WooCommerceListingsPage() {
  return (
    <WooCommerceListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'WooCommerce' }]}
    />
  )
}
