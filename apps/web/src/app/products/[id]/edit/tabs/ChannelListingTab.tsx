'use client'

import { useMemo, useState } from 'react'
import { Sparkles, ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

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

interface ChannelLimits {
  title: number
  bulletCount?: number
  bulletLength?: number
  keywords?: number
  images?: number
  subtitle?: number
}

const CHANNEL_LIMITS: Record<string, ChannelLimits> = {
  AMAZON: { title: 200, bulletCount: 5, bulletLength: 500, keywords: 250, images: 9 },
  EBAY: { title: 80, subtitle: 55, images: 12 },
  SHOPIFY: { title: 255, images: 250 },
  WOOCOMMERCE: { title: 255, images: 100 },
  ETSY: { title: 140, images: 10 },
}

interface FormState {
  title: string
  description: string
  bulletPoints: string[]
  searchKeywords: string
  price: string
  quantity: number
  isPublished: boolean
  listingStatus: string
}

interface ValidationErrors {
  title?: string
  bulletPoints?: string
  description?: string
  price?: string
  quantity?: string
}

function validate(data: FormState, channel: string, limits: ChannelLimits): ValidationErrors {
  const errors: ValidationErrors = {}
  if (!data.title.trim()) {
    errors.title = 'Title is required'
  } else if (data.title.length > limits.title) {
    errors.title = `Title exceeds ${limits.title} character limit`
  }
  if (channel === 'AMAZON' && limits.bulletLength) {
    const tooLong = data.bulletPoints.find((b) => b.length > limits.bulletLength!)
    if (tooLong) errors.bulletPoints = `Bullets cannot exceed ${limits.bulletLength} characters`
  }
  if (data.price === '' || Number(data.price) <= 0) {
    errors.price = 'A valid price is required'
  }
  if (Number.isNaN(data.quantity) || data.quantity < 0) {
    errors.quantity = 'Stock cannot be negative'
  }
  return errors
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
  const limits = CHANNEL_LIMITS[channel] ?? { title: 200 }
  const isNew = !listing

  const initialBullets = useMemo(() => {
    const arr = listing?.bulletPointsOverride ?? []
    const padded = [...arr]
    while (padded.length < (limits.bulletCount ?? 5)) padded.push('')
    return padded.slice(0, limits.bulletCount ?? 5)
  }, [listing, limits.bulletCount])

  const [data, setData] = useState<FormState>({
    title: listing?.title ?? product.name ?? '',
    description: listing?.description ?? '',
    bulletPoints: initialBullets,
    searchKeywords: '',
    price: listing?.price != null ? String(listing.price) : String(product.basePrice ?? ''),
    quantity: listing?.quantity != null ? listing.quantity : Number(product.totalStock ?? 0),
    isPublished: !!listing?.isPublished,
    listingStatus: listing?.listingStatus ?? 'DRAFT',
  })
  const [saving, setSaving] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [statusMsg, setStatusMsg] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [touched, setTouched] = useState(false)

  const errors = validate(data, channel, limits)
  const hasErrors = Object.keys(errors).length > 0

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setData((prev) => ({ ...prev, [field]: value }))
    setTouched(true)
    onChange()
  }
  const updateBullet = (idx: number, value: string) => {
    const next = [...data.bulletPoints]
    next[idx] = value
    update('bulletPoints', next)
  }

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
        `${getBackendUrl()}/api/amazon/test-catalog-api?asin=${product.amazonAsin}`
      )
      const result = await res.json()
      const summary = result?.data?.summaries?.[0] ?? result?.summaries?.[0]
      if (summary?.itemName) {
        update('title', summary.itemName)
        setStatusMsg({ kind: 'success', text: 'Pulled latest title from Amazon.' })
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
    setStatusMsg({ kind: 'info', text: 'AI translation ships in Phase 4.' })
  }

  async function handleSave() {
    if (hasErrors) {
      setTouched(true)
      setStatusMsg({ kind: 'error', text: 'Fix the errors above before saving.' })
      return
    }
    setSaving(true)
    setStatusMsg(null)
    try {
      const payload = {
        title: data.title,
        description: data.description,
        bulletPointsOverride: data.bulletPoints.filter((b) => b.trim()),
        price: data.price === '' ? null : Number(data.price),
        quantity: Number(data.quantity),
        isPublished: data.isPublished,
        listingStatus: data.listingStatus,
      }
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/listings/${channel}/${marketplace}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      onSave(updated)
      setStatusMsg({ kind: 'success', text: 'Saved.' })
    } catch (e) {
      setStatusMsg({ kind: 'error', text: `Save failed: ${(e as Error).message}` })
    } finally {
      setSaving(false)
    }
  }

  function handlePushPlaceholder() {
    setStatusMsg({ kind: 'info', text: `Push to ${channel} ships in Phase 4.` })
  }

  const margin =
    product.costPrice && Number(data.price) > 0
      ? ((1 - Number(product.costPrice) / Number(data.price)) * 100).toFixed(1)
      : null

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
                      Status: <span className="font-medium text-slate-700">{data.listingStatus}</span>
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
              variant="primary"
              size="sm"
              loading={saving}
              disabled={hasErrors}
              onClick={handleSave}
            >
              Save Draft
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
              statusMsg.kind === 'info' && 'border-slate-200 bg-slate-50 text-slate-700'
            )}
          >
            {statusMsg.kind === 'error' && <AlertTriangle className="w-3.5 h-3.5" />}
            {statusMsg.text}
          </div>
        )}
      </Card>

      {/* ── Title ──────────────────────────────────────────────── */}
      <Card title="Title">
        <Input
          value={data.title}
          onChange={(e) => update('title', e.target.value)}
          charLimit={limits.title}
          placeholder={`Enter ${marketInfo.language?.toUpperCase() ?? 'product'} title`}
          error={touched ? errors.title : undefined}
        />
      </Card>

      {/* ── Bullets (Amazon only) ─────────────────────────────── */}
      {channel === 'AMAZON' && limits.bulletCount && (
        <Card title="Bullet Points" description={`Up to ${limits.bulletCount} bullets, ${limits.bulletLength} chars each`}>
          <div className="space-y-3">
            {data.bulletPoints.map((bullet, idx) => (
              <Input
                key={idx}
                label={`Bullet ${idx + 1}`}
                value={bullet}
                charLimit={limits.bulletLength}
                onChange={(e) => updateBullet(idx, e.target.value)}
                placeholder={`Bullet point ${idx + 1}`}
              />
            ))}
            {touched && errors.bulletPoints && (
              <p className="text-[11px] text-red-600">{errors.bulletPoints}</p>
            )}
          </div>
        </Card>
      )}

      {/* ── Description ────────────────────────────────────────── */}
      <Card title="Description">
        <textarea
          value={data.description}
          onChange={(e) => update('description', e.target.value)}
          rows={6}
          className="w-full border border-slate-200 hover:border-slate-300 rounded-md px-3 py-2 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors font-mono"
          placeholder={`Enter ${marketInfo.language?.toUpperCase() ?? 'product'} description (HTML supported)`}
        />
      </Card>

      {/* ── Pricing & Stock ──────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Pricing">
          <div className="space-y-3">
            <Input
              label={`Price (${marketInfo.currency})`}
              type="number"
              step="0.01"
              value={data.price}
              onChange={(e) => update('price', e.target.value)}
              error={touched ? errors.price : undefined}
            />
            {margin != null && (
              <div className="text-[12px] text-slate-600 bg-slate-50 border border-slate-200 px-3 py-2 rounded">
                Margin <span className="font-semibold tabular-nums">{margin}%</span> from cost{' '}
                <span className="tabular-nums">
                  {marketInfo.currency} {Number(product.costPrice).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </Card>

        <Card title="Inventory">
          <Input
            label="Stock"
            type="number"
            value={String(data.quantity)}
            onChange={(e) => update('quantity', Number(e.target.value))}
            error={touched ? errors.quantity : undefined}
          />
        </Card>
      </div>

      {/* ── Search Keywords (Amazon only) ────────────────────── */}
      {channel === 'AMAZON' && limits.keywords && (
        <Card
          title="Search Keywords"
          description="Comma-separated. Persistence in Phase 4 once platformAttributes JSON shape is locked."
        >
          <textarea
            value={data.searchKeywords}
            onChange={(e) => update('searchKeywords', e.target.value)}
            rows={3}
            maxLength={limits.keywords + 50}
            className="w-full border border-slate-200 hover:border-slate-300 rounded-md px-3 py-2 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
            placeholder="motorcycle jacket, summer, mesh, breathable"
          />
          <div className="text-[10px] text-slate-500 text-right mt-1 tabular-nums">
            {data.searchKeywords.length} / {limits.keywords}
          </div>
        </Card>
      )}
    </div>
  )
}
