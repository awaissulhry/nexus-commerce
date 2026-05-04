'use client'

import { useState } from 'react'
import { Sparkles, ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import ChannelFieldEditor from '../../../_shared/ChannelFieldEditor'

interface MarketInfo {
  code: string
  name: string
  channel: string
  marketplaceId?: string | null
  region: string
  currency: string
  language: string
  domainUrl?: string | null
}

interface Listing {
  id: string
  channel: string
  marketplace: string
  channelMarket: string
  region: string
  title: string | null
  description: string | null
  price: string | number | null
  quantity: number | null
  isPublished: boolean
  listingStatus: string
  externalListingId: string | null
  bulletPointsOverride: string[] | null
  [key: string]: any
}

interface Props {
  product: any
  channel: string
  marketplace: string
  marketInfo: MarketInfo
  listing: Listing | undefined
  onChange: () => void
  onSave: (updated: Listing) => void
}

export default function ChannelListingTab({
  product,
  channel,
  marketplace,
  marketInfo,
  listing,
  onChange,
  onSave,
}: Props) {
  const [pulling, setPulling] = useState(false)
  const [statusMsg, setStatusMsg] = useState<{
    kind: 'info' | 'error' | 'success'
    text: string
  } | null>(null)
  const isNew = !listing

  async function handlePullFromChannel() {
    if (channel !== 'AMAZON') {
      setStatusMsg({ kind: 'info', text: `Pull from ${channel} ships in Phase 4.` })
      return
    }
    if (!product.amazonAsin) {
      setStatusMsg({ kind: 'error', text: 'No ASIN on this product — cannot pull from Amazon.' })
      return
    }
    setPulling(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/test-catalog-api?asin=${product.amazonAsin}`,
      )
      const result = await res.json()
      const summary = result?.data?.summaries?.[0] ?? result?.summaries?.[0]
      if (summary?.itemName) {
        setStatusMsg({ kind: 'success', text: `Pulled latest title: "${summary.itemName}"` })
      } else if (result?.error) {
        setStatusMsg({ kind: 'error', text: `Amazon: ${result.error}` })
      } else {
        setStatusMsg({ kind: 'info', text: 'Amazon returned no usable data.' })
      }
    } catch (e) {
      setStatusMsg({ kind: 'error', text: `Pull failed: ${(e as Error).message}` })
    } finally {
      setPulling(false)
    }
  }

  function handleAITranslate() {
    setStatusMsg({ kind: 'info', text: 'Q.9 — AI translate ships next.' })
  }

  function handlePushPlaceholder() {
    setStatusMsg({
      kind: 'info',
      text: `Push to ${channel} ships when channel adapters land (TECH_DEBT #35).`,
    })
  }

  return (
    <div className="space-y-4">
      {/* ── Status bar ─────────────────────────────────────────── */}
      <Card noPadding>
        <div className="px-4 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Badge mono variant={isNew ? 'warning' : 'info'}>
              {marketInfo.code}
            </Badge>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-900 truncate">
                {marketInfo.name}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                {isNew ? (
                  <span>Not yet listed on this marketplace</span>
                ) : (
                  <>
                    <span>
                      Status:{' '}
                      <span className="font-medium text-slate-700">
                        {listing!.listingStatus}
                      </span>
                    </span>
                    {listing?.externalListingId && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{listing.externalListingId}</span>
                      </>
                    )}
                  </>
                )}
                <span>·</span>
                <span>{marketInfo.currency}</span>
                <span>·</span>
                <span className="uppercase tracking-wide">{marketInfo.language}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="secondary"
              size="sm"
              loading={pulling}
              icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
              onClick={handlePullFromChannel}
            >
              Pull
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Sparkles className="w-3.5 h-3.5" />}
              onClick={handleAITranslate}
            >
              Translate
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowUpFromLine className="w-3.5 h-3.5" />}
              onClick={handlePushPlaceholder}
            >
              Push
            </Button>
          </div>
        </div>
        {statusMsg && (
          <div
            className={cn(
              'border-t px-4 py-2 text-[12px] flex items-center gap-2',
              statusMsg.kind === 'success' && 'border-green-200 bg-green-50 text-green-700',
              statusMsg.kind === 'error' && 'border-red-200 bg-red-50 text-red-700',
              statusMsg.kind === 'info' && 'border-slate-200 bg-slate-50 text-slate-700',
            )}
          >
            {statusMsg.kind === 'error' && <AlertTriangle className="w-3.5 h-3.5" />}
            {statusMsg.text}
          </div>
        )}
      </Card>

      {/* ── Schema-driven editor (Q.2) ────────────────────────── */}
      <ChannelFieldEditor
        productId={product.id}
        channel={channel}
        marketplace={marketplace}
        onSaved={(updated) => {
          onChange()
          onSave(updated as Listing)
        }}
      />
    </div>
  )
}
