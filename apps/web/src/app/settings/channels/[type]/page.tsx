import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import ChannelDetailClient, {
  type ChannelDetail,
} from './ChannelDetailClient'

export const dynamic = 'force-dynamic'

const KNOWN = new Set(['amazon', 'ebay', 'shopify', 'woocommerce', 'etsy'])

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ type: string }>
}) {
  const { type } = await params
  const lower = type.toLowerCase()
  if (!KNOWN.has(lower)) notFound()

  const backend = getBackendUrl()
  let detail: ChannelDetail | null = null
  let loadError: string | null = null
  try {
    const res = await fetch(
      `${backend}/api/settings/channels/${lower}/detail`,
      { cache: 'no-store' },
    )
    if (!res.ok) {
      loadError = `Failed to load channel detail (HTTP ${res.status})`
    } else {
      detail = (await res.json()) as ChannelDetail
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <ChannelDetailClient
      channelType={lower}
      initial={detail}
      initialError={loadError}
    />
  )
}
