import ListingsWorkspace from '../ListingsWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AmazonListingsPage() {
  return (
    <ListingsWorkspace
      lockChannel="AMAZON"
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Amazon' }]}
    />
  )
}
