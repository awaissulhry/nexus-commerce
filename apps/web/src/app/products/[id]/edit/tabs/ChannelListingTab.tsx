'use client'

import { useState } from 'react'
import {
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

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

const CHANNEL_LIMITS: Record<
  string,
  {
    title: number
    bulletCount?: number
    bulletLength?: number
    keywords?: number
    images?: number
    subtitle?: number
  }
> = {
  AMAZON: { title: 200, bulletCount: 5, bulletLength: 500, keywords: 250, images: 9 },
  EBAY: { title: 80, subtitle: 55, images: 12 },
  SHOPIFY: { title: 255, images: 250 },
  WOOCOMMERCE: { title: 255, images: 100 },
  ETSY: { title: 140, images: 10 },
}

const COUNTRY_FLAGS: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧',
  NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', US: '🇺🇸', GLOBAL: '🌍',
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

  const initialBullets = (() => {
    const arr = listing?.bulletPointsOverride ?? []
    const padded = [...arr]
    while (padded.length < (limits.bulletCount ?? 5)) padded.push('')
    return padded.slice(0, limits.bulletCount ?? 5)
  })()

  const [data, setData] = useState({
    title: listing?.title ?? product.name ?? '',
    description: listing?.description ?? '',
    bulletPoints: initialBullets,
    searchKeywords: '', // future: pull from platformAttributes
    price: listing?.price != null ? String(listing.price) : String(product.basePrice ?? ''),
    quantity:
      listing?.quantity != null ? listing.quantity : Number(product.totalStock ?? 0),
    isPublished: !!listing?.isPublished,
    listingStatus: listing?.listingStatus ?? 'DRAFT',
  })
  const [saving, setSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const update = <K extends keyof typeof data>(field: K, value: (typeof data)[K]) => {
    setData((prev) => ({ ...prev, [field]: value }))
    onChange()
  }

  const updateBullet = (idx: number, value: string) => {
    const next = [...data.bulletPoints]
    next[idx] = value
    update('bulletPoints', next)
  }

  async function handlePullFromChannel() {
    if (channel !== 'AMAZON') {
      setStatusMsg(`Pull not implemented for ${channel} yet`)
      return
    }
    if (!product.amazonAsin) {
      setStatusMsg('No ASIN on this product — cannot pull from Amazon.')
      return
    }
    try {
      setStatusMsg('Pulling from Amazon…')
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/test-catalog-api?asin=${product.amazonAsin}`
      )
      const result = await res.json()
      const summary = result?.data?.summaries?.[0] ?? result?.summaries?.[0]
      if (summary?.itemName) {
        update('title', summary.itemName)
        setStatusMsg('Pulled latest data from Amazon ✓')
      } else if (result?.error) {
        setStatusMsg(`Amazon error: ${result.error}`)
      } else {
        setStatusMsg('Pull returned no data.')
      }
    } catch (e) {
      setStatusMsg(`Pull failed: ${(e as Error).message}`)
    }
  }

  function handleAITranslate() {
    setStatusMsg('AI translation coming soon — Phase 4.')
  }

  async function handleSave() {
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
      setStatusMsg('Saved ✓')
    } catch (e) {
      setStatusMsg(`Save failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  function handlePushPlaceholder() {
    setStatusMsg(`Push to ${channel} coming in Phase 4.`)
  }

  const flag = COUNTRY_FLAGS[marketInfo.code] ?? '🌍'
  const margin =
    product.costPrice && Number(data.price) > 0
      ? ((1 - Number(product.costPrice) / Number(data.price)) * 100).toFixed(1)
      : null

  return (
    <div className="space-y-6">
      {/* ── Status bar ─────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="text-2xl">{flag}</div>
            <div>
              <div className="font-medium">{marketInfo.name}</div>
              <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                {isNew ? (
                  <span className="text-amber-600">⚠ Not yet listed on this marketplace</span>
                ) : (
                  <>
                    <span>
                      Status: <span className="font-medium">{data.listingStatus}</span>
                    </span>
                    {listing?.externalListingId && (
                      <>
                        <span>·</span>
                        <span>
                          ID: <span className="font-mono">{listing.externalListingId}</span>
                        </span>
                      </>
                    )}
                    <span>·</span>
                    <span>{marketInfo.currency}</span>
                    <span>·</span>
                    <span>{marketInfo.language.toUpperCase()}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handlePullFromChannel}
              className="px-3 py-1.5 text-xs border border-slate-200 rounded-md hover:bg-slate-50 flex items-center gap-1"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" /> Pull from {channel}
            </button>
            <button
              onClick={handleAITranslate}
              className="px-3 py-1.5 text-xs bg-purple-50 border border-purple-200 text-purple-700 rounded-md hover:bg-purple-100 flex items-center gap-1"
            >
              <Sparkles className="w-3.5 h-3.5" /> AI Translate
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save Draft'}
            </button>
            <button
              onClick={handlePushPlaceholder}
              className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 flex items-center gap-1"
            >
              <ArrowUpFromLine className="w-3.5 h-3.5" /> Push to {channel}
            </button>
          </div>
        </div>
        {statusMsg && (
          <div className="mt-3 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            {statusMsg}
          </div>
        )}
      </div>

      {/* ── Title ──────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium">Title</label>
          <span
            className={`text-xs ${
              data.title.length > limits.title ? 'text-red-600' : 'text-slate-500'
            }`}
          >
            {data.title.length} / {limits.title}
          </span>
        </div>
        <textarea
          value={data.title}
          onChange={(e) => update('title', e.target.value)}
          rows={2}
          className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={`Enter ${marketInfo.language ?? 'product'} title…`}
        />
      </div>

      {/* ── Bullets (Amazon only) ─────────────────────────────── */}
      {channel === 'AMAZON' && limits.bulletCount && (
        <div className="bg-white border border-slate-200 rounded-lg p-6">
          <h3 className="text-sm font-medium mb-3">Bullet Points</h3>
          <div className="space-y-2">
            {data.bulletPoints.map((bullet, idx) => (
              <div key={idx}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-slate-600">Bullet {idx + 1}</label>
                  <span
                    className={`text-[10px] ${
                      bullet.length > (limits.bulletLength ?? 500)
                        ? 'text-red-600'
                        : 'text-slate-400'
                    }`}
                  >
                    {bullet.length} / {limits.bulletLength}
                  </span>
                </div>
                <input
                  type="text"
                  value={bullet}
                  onChange={(e) => updateBullet(idx, e.target.value)}
                  className="w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={`Bullet point ${idx + 1}…`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Description ────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <label className="block text-sm font-medium mb-2">Description</label>
        <textarea
          value={data.description}
          onChange={(e) => update('description', e.target.value)}
          rows={6}
          className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder={`Enter ${marketInfo.language ?? 'product'} description (HTML supported)…`}
        />
      </div>

      {/* ── Pricing & Stock ──────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6">
          <h3 className="text-sm font-medium mb-3">Pricing</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">
                Price ({marketInfo.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={data.price}
                onChange={(e) => update('price', e.target.value)}
                className="w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {margin != null && (
              <div className="text-xs text-slate-600 bg-slate-50 p-2 rounded">
                Margin: <strong>{margin}%</strong> from cost {marketInfo.currency}
                {Number(product.costPrice).toFixed(2)}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-6">
          <h3 className="text-sm font-medium mb-3">Inventory</h3>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Stock</label>
            <input
              type="number"
              value={data.quantity}
              onChange={(e) => update('quantity', Number(e.target.value))}
              className="w-full border border-slate-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* ── Search Keywords (Amazon only) ────────────────────── */}
      {channel === 'AMAZON' && limits.keywords && (
        <div className="bg-white border border-slate-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">Search Keywords</label>
            <span
              className={`text-xs ${
                data.searchKeywords.length > limits.keywords
                  ? 'text-red-600'
                  : 'text-slate-500'
              }`}
            >
              {data.searchKeywords.length} / {limits.keywords}
            </span>
          </div>
          <textarea
            value={data.searchKeywords}
            onChange={(e) => update('searchKeywords', e.target.value)}
            rows={3}
            className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Comma-separated keywords (saved in Phase 4 once platformAttributes JSON support lands)…"
          />
        </div>
      )}
    </div>
  )
}
