import { notFound } from 'next/navigation'
import { ShoppingBag } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListingsTable, type Listing } from './ListingsTable'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'

interface Props {
  channel: 'AMAZON' | 'EBAY'
  channelLabel: string
  marketCodeRaw: string
}

interface Marketplace {
  code: string
  name: string
  currency: string
  language: string
}

/**
 * Per-channel-per-market server view. Verifies the marketplace is
 * configured (404 otherwise), then renders ListingsTable scoped to
 * (channel, marketplace).
 */
export default async function ChannelMarketView({
  channel,
  channelLabel,
  marketCodeRaw,
}: Props) {
  const marketCode = marketCodeRaw.toUpperCase()
  const backend = getBackendUrl()

  const [mpRes, listingsRes] = await Promise.all([
    fetch(`${backend}/api/marketplaces?channel=${channel}`, { cache: 'no-store' }),
    fetch(`${backend}/api/listings/all`, { cache: 'no-store' }),
  ])

  const marketplaces: Marketplace[] = mpRes.ok ? await mpRes.json() : []
  const marketplace = marketplaces.find((m) => m.code === marketCode)
  if (!marketplace) notFound()

  const all: Listing[] = listingsRes.ok ? (await listingsRes.json()).listings ?? [] : []
  const listings = all.filter(
    (l) => l.channel === channel && l.marketplace === marketCode
  )

  const friendly = COUNTRY_NAMES[marketCode] ?? marketplace.name

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${channelLabel} ${friendly}`}
        description={`${listings.length} listing${listings.length === 1 ? '' : 's'} · ${
          marketplace.currency
        } · ${marketplace.language.toUpperCase()}`}
        breadcrumbs={[
          { label: 'Listings', href: '/listings' },
          { label: channelLabel, href: `/listings/${channel.toLowerCase()}` },
          { label: marketCode },
        ]}
      />

      {listings.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title={`No listings on ${channelLabel} ${friendly}`}
          description="Publish products to this marketplace to see listings here."
          action={{ label: 'Go to Catalog', href: '/products' }}
        />
      ) : (
        <ListingsTable listings={listings} scopedToChannel scopedToMarket />
      )}
    </div>
  )
}
