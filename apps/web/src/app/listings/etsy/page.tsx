import ListingsWorkspace from '../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function EtsyListingsPage() {
  return (
    <ListingsWorkspace
      lockChannel="ETSY"
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Etsy' }]}
    />
  )
}
