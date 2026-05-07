import EtsyListingsClient from './EtsyListingsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function EtsyListingsPage() {
  return (
    <EtsyListingsClient
      breadcrumbs={[{ label: 'Listings', href: '/listings' }, { label: 'Etsy' }]}
    />
  )
}
