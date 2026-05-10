'use client'

import { useRef, useState } from 'react'
import { Sparkles, ArrowDownToLine, AlertTriangle, Copy, DollarSign, Save, Send, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useTranslations } from '@/lib/i18n/use-translations'
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
  pricingRule?: string | null
  priceOverride?: string | number | null
  priceAdjustmentPercent?: string | number | null
  followMasterPrice?: boolean
  [key: string]: any
}

interface Props {
  product: any
  channel: string
  marketplace: string
  marketInfo: MarketInfo
  siblingMarkets?: MarketInfo[]
  listing: Listing | undefined
  onDirtyChange: (count: number) => void
  onSave: (updated: Listing) => void
}

export default function ChannelListingTab({
  product,
  channel,
  marketplace,
  marketInfo,
  siblingMarkets = [],
  listing,
  onDirtyChange,
  onSave,
}: Props) {
  const { t } = useTranslations()
  const [pulling, setPulling] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [showPublishModal, setShowPublishModal] = useState(false)
  const translateAllRef = useRef<
    | (() => Promise<{ translated: number; skipped: number }>)
    | null
  >(null)
  const flushRef = useRef<(() => Promise<void>) | null>(null)
  const [statusMsg, setStatusMsg] = useState<{
    kind: 'info' | 'error' | 'success'
    text: string
  } | null>(null)
  const isNew = !listing

  async function fetchWithRateLimitRetry(
    url: string,
    onWaiting: (seconds: number) => void,
  ): Promise<Response> {
    const res = await fetch(url)
    if (res.status !== 429) return res
    const retryAfter = res.headers.get('Retry-After')
    const seconds = (() => {
      if (!retryAfter) return 3
      const n = Number(retryAfter)
      if (Number.isFinite(n)) return Math.min(8, Math.max(1, n))
      const date = Date.parse(retryAfter)
      if (!Number.isFinite(date)) return 3
      return Math.min(8, Math.max(1, Math.ceil((date - Date.now()) / 1000)))
    })()
    onWaiting(seconds)
    await new Promise((r) => window.setTimeout(r, seconds * 1000))
    return await fetch(url)
  }

  async function handlePullFromChannel() {
    if (channel === 'AMAZON') {
      if (!product.amazonAsin) {
        setStatusMsg({ kind: 'error', text: 'No ASIN on this product — cannot pull from Amazon.' })
        return
      }
      setPulling(true)
      try {
        const res = await fetchWithRateLimitRetry(
          `${getBackendUrl()}/api/amazon/test-catalog-api?asin=${product.amazonAsin}`,
          (sec) =>
            setStatusMsg({
              kind: 'info',
              text: `Amazon rate-limited — retrying in ${sec}s…`,
            }),
        )
        if (res.status === 429) {
          setStatusMsg({ kind: 'error', text: 'Amazon: still rate-limited after retry — try again in a minute.' })
          return
        }
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
      return
    }
    if (channel === 'EBAY') {
      const sku = product.sku
      if (!sku) {
        setStatusMsg({ kind: 'error', text: 'No SKU on this product — cannot pull from eBay.' })
        return
      }
      setPulling(true)
      try {
        const url = new URL(`${getBackendUrl()}/api/ebay/pull-listing`)
        url.searchParams.set('sku', sku)
        url.searchParams.set('marketplace', marketplace)
        const res = await fetchWithRateLimitRetry(url.toString(), (sec) =>
          setStatusMsg({ kind: 'info', text: `eBay rate-limited — retrying in ${sec}s…` }),
        )
        if (res.status === 429) {
          setStatusMsg({ kind: 'error', text: 'eBay: still rate-limited after retry — try again in a minute.' })
          return
        }
        const result = await res.json()
        if (!res.ok || !result?.success) {
          setStatusMsg({ kind: 'error', text: `eBay: ${result?.error ?? `HTTP ${res.status}`}` })
        } else if (!result.found) {
          setStatusMsg({ kind: 'info', text: result.message ?? 'No eBay item for this SKU yet.' })
        } else if (result.summary?.title) {
          setStatusMsg({ kind: 'success', text: `Pulled latest title: "${result.summary.title}"` })
        } else {
          setStatusMsg({ kind: 'info', text: 'eBay returned the item with no title set.' })
        }
      } catch (e) {
        setStatusMsg({ kind: 'error', text: `Pull failed: ${(e as Error).message}` })
      } finally {
        setPulling(false)
      }
      return
    }
    setStatusMsg({ kind: 'info', text: `Pull from ${channel} ships when its adapter lands.` })
  }

  async function handleAITranslate() {
    const fn = translateAllRef.current
    if (!fn) {
      setStatusMsg({ kind: 'info', text: t('products.edit.translate.editorLoading') })
      return
    }
    setTranslating(true)
    setStatusMsg({ kind: 'info', text: t('products.edit.translate.running', { marketplace: marketInfo.code }) })
    try {
      const { translated, skipped } = await fn()
      if (translated === 0 && skipped === 0) {
        setStatusMsg({ kind: 'info', text: t('products.edit.translate.noFields') })
      } else if (translated === 0) {
        setStatusMsg({ kind: 'error', text: t('products.edit.translate.allSkipped', { count: skipped }) })
      } else if (skipped === 0) {
        setStatusMsg({ kind: 'success', text: t('products.edit.translate.success', { count: translated }) })
      } else {
        setStatusMsg({ kind: 'success', text: t('products.edit.translate.partial', { translated, skipped }) })
      }
    } catch (e) {
      setStatusMsg({ kind: 'error', text: t('products.edit.translate.failed', { error: e instanceof Error ? e.message : String(e) }) })
    } finally {
      setTranslating(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await flushRef.current?.()
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      setStatusMsg({ kind: 'error', text: `Save failed: ${(e as Error).message}` })
    } finally {
      setSaving(false)
    }
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
              <div className="text-md font-semibold text-slate-900 dark:text-slate-100 truncate">
                {marketInfo.name}
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                {isNew ? (
                  <span>Not yet listed on this marketplace</span>
                ) : (
                  <>
                    <span>
                      Status:{' '}
                      <span className="font-medium text-slate-700 dark:text-slate-300">
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
              loading={translating}
              icon={<Sparkles className="w-3.5 h-3.5" />}
              onClick={handleAITranslate}
              title={t('products.edit.translate.tooltip', { marketplace: marketInfo.code })}
            >
              {t('products.edit.translate.button')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={saving}
              icon={savedFlash ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Save className="w-3.5 h-3.5" />}
              onClick={handleSave}
              title="Save all pending changes immediately"
            >
              {savedFlash ? 'Saved' : 'Save'}
            </Button>
            <Button
              size="sm"
              icon={<Send className="w-3.5 h-3.5" />}
              onClick={() => setShowPublishModal(true)}
              title={`Publish to ${marketInfo.name}`}
            >
              Publish
            </Button>
          </div>
        </div>
        {statusMsg && (
          <div
            className={cn(
              'border-t px-4 py-2 text-base flex items-center gap-2',
              statusMsg.kind === 'success' && 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300',
              statusMsg.kind === 'error' && 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
              statusMsg.kind === 'info' && 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
            )}
          >
            {statusMsg.kind === 'error' && <AlertTriangle className="w-3.5 h-3.5" />}
            {statusMsg.text}
          </div>
        )}
      </Card>

      {/* ── Pricing panel ──────────────────────────────────────── */}
      <PricingPanel
        productId={product.id}
        channel={channel}
        marketplace={marketplace}
        currency={marketInfo.currency}
        listing={listing}
        onSaved={onSave}
      />

      {/* ── Replication panel (multi-market only) ──────────────── */}
      {siblingMarkets.length > 0 && (
        <ReplicationPanel
          productId={product.id}
          channel={channel}
          marketplace={marketplace}
          siblingMarkets={siblingMarkets}
          onDone={() => onSave(listing as Listing)}
        />
      )}

      {/* ── Readiness checklist (W5.1) ────────────────────────── */}
      <ReadinessChecklist listing={listing} t={t} />

      {/* ── Schema-driven editor (Q.2 + Q.3) ──────────────────── */}
      <ChannelFieldEditor
        productId={product.id}
        channel={channel}
        marketplace={marketplace}
        product={product}
        onDirtyChange={onDirtyChange}
        onSaved={(updated) => {
          onSave(updated as Listing)
        }}
        bindTranslateAll={(fn) => {
          translateAllRef.current = fn
        }}
        bindFlushAll={(fn) => {
          flushRef.current = fn
        }}
      />

      {/* ── Publish review modal ───────────────────────────────── */}
      {showPublishModal && (
        <PublishReviewModal
          productId={product.id}
          channel={channel}
          marketplace={marketplace}
          marketInfo={marketInfo}
          listing={listing}
          product={product}
          onClose={() => setShowPublishModal(false)}
        />
      )}
    </div>
  )
}

// ── Pricing panel ─────────────────────────────────────────────────────
// Lets operators set a per-marketplace price override, pricing rule, and
// optional adjustment percentage. All three map directly to ChannelListing
// columns and are saved via POST /api/products/:id/listings/:ch/:mp/pricing.
function PricingPanel({
  productId,
  channel,
  marketplace,
  currency,
  listing,
  onSaved,
}: {
  productId: string
  channel: string
  marketplace: string
  currency: string
  listing: Listing | undefined
  onSaved: (updated: any) => void
}) {
  const [rule, setRule] = useState<string>(listing?.pricingRule ?? 'FIXED')
  const [price, setPrice] = useState<string>(
    listing?.priceOverride != null ? String(listing.priceOverride) : '',
  )
  const [adj, setAdj] = useState<string>(
    listing?.priceAdjustmentPercent != null ? String(listing.priceAdjustmentPercent) : '',
  )
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [open, setOpen] = useState(false)

  async function save() {
    setSaving(true)
    setMsg(null)
    try {
      const body: Record<string, any> = { pricingRule: rule }
      if (rule === 'FIXED' || rule === 'MATCH_AMAZON') {
        body.priceOverride = price !== '' ? parseFloat(price) : null
      }
      if (rule === 'PERCENT_OF_MASTER') {
        body.priceAdjustmentPercent = adj !== '' ? parseFloat(adj) : null
      }
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/pricing`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      onSaved(updated)
      setMsg({ kind: 'success', text: 'Pricing saved' })
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const currentDisplay = listing?.priceOverride != null
    ? `${currency} ${Number(listing.priceOverride).toFixed(2)}`
    : listing?.price != null
    ? `${currency} ${Number(listing.price).toFixed(2)}`
    : 'Not set'

  return (
    <Card noPadding>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-slate-400" />
          <span className="text-md font-medium text-slate-900 dark:text-slate-100">
            Marketplace Pricing
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {currentDisplay}
            {listing?.pricingRule && listing.pricingRule !== 'FIXED' && (
              <span className="ml-1 text-xs text-slate-400">({listing.pricingRule})</span>
            )}
          </span>
        </div>
        <span className="text-slate-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Pricing rule */}
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Pricing rule
              </label>
              <select
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="FIXED">Fixed price</option>
                <option value="MATCH_AMAZON">Match Amazon</option>
                <option value="PERCENT_OF_MASTER">% of master price</option>
              </select>
            </div>

            {/* Price override (FIXED / MATCH_AMAZON) */}
            {(rule === 'FIXED' || rule === 'MATCH_AMAZON') && (
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Price ({currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
            )}

            {/* Adjustment % (PERCENT_OF_MASTER) */}
            {rule === 'PERCENT_OF_MASTER' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Adjustment %
                </label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="0"
                  value={adj}
                  onChange={(e) => setAdj(e.target.value)}
                  className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
                <p className="text-xs text-slate-400 mt-1">
                  e.g. 10 = master + 10%. Negative = discount.
                </p>
              </div>
            )}

            <div className="flex items-end">
              <Button size="sm" onClick={save} loading={saving}>
                Save pricing
              </Button>
            </div>
          </div>

          {msg && (
            <div
              className={cn(
                'text-sm px-3 py-2 rounded',
                msg.kind === 'success' && 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300',
                msg.kind === 'error' && 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
              )}
            >
              {msg.text}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Replication panel ─────────────────────────────────────────────────
// Copy content from the current market to one or more sibling markets.
// Three modes: All fields / Text only (title+desc+bullets) / Attributes only.
function ReplicationPanel({
  productId,
  channel,
  marketplace,
  siblingMarkets,
  onDone,
}: {
  productId: string
  channel: string
  marketplace: string
  siblingMarkets: MarketInfo[]
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'all' | 'text' | 'attributes' | 'price'>('all')
  const [includePrice, setIncludePrice] = useState(false)
  const [replicating, setReplicating] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const TEXT_FIELDS = ['item_name', 'product_description', 'bullet_point']
  const ATTR_FIELDS = undefined // all schema attributes

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === siblingMarkets.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(siblingMarkets.map((m) => m.code)))
    }
  }

  async function replicate() {
    if (selected.size === 0) return
    setReplicating(true)
    setMsg(null)
    try {
      const fields = mode === 'text' ? TEXT_FIELDS : ATTR_FIELDS
      const body: Record<string, any> = {
        targetMarketplaces: Array.from(selected),
        includeSetup: mode === 'all' || mode === 'attributes',
        includePrice,
      }
      if (fields) body.fields = fields

      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/replicate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)

      const { replicated, total, results } = json
      const failed = (results as any[]).filter((r: any) => !r.ok)
      if (failed.length > 0) {
        setMsg({
          kind: 'error',
          text: `${replicated}/${total} replicated. Failed: ${failed.map((r: any) => r.marketplace).join(', ')}`,
        })
      } else {
        setMsg({ kind: 'success', text: `Replicated to ${replicated} market${replicated !== 1 ? 's' : ''}` })
      }
      onDone()
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setReplicating(false)
    }
  }

  return (
    <Card noPadding>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Copy className="w-4 h-4 text-slate-400" />
          <span className="text-md font-medium text-slate-900 dark:text-slate-100">
            Replicate to Markets
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Push {marketplace} content to other {channel} markets
          </span>
        </div>
        <span className="text-slate-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-4 space-y-4">
          {/* Target markets */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Target markets
              </span>
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                {selected.size === siblingMarkets.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {siblingMarkets.map((m) => (
                <button
                  key={m.code}
                  type="button"
                  onClick={() => toggle(m.code)}
                  className={cn(
                    'px-2.5 py-1 rounded text-sm font-mono border transition-colors',
                    selected.has(m.code)
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400',
                  )}
                >
                  {m.code}
                </button>
              ))}
            </div>
          </div>

          {/* Mode */}
          <div>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400 block mb-2">
              What to replicate
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  { value: 'all', label: 'All fields', desc: 'Title, bullets, desc, attributes, setup' },
                  { value: 'text', label: 'Text only', desc: 'Title, bullets, description' },
                  { value: 'attributes', label: 'Attributes', desc: 'Schema attributes + setup' },
                  { value: 'price', label: 'Price only', desc: 'Price override + rule' },
                ] as const
              ).map(({ value, label, desc }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setMode(value)
                    if (value === 'price') setIncludePrice(true)
                    else setIncludePrice(false)
                  }}
                  className={cn(
                    'text-left px-3 py-2 rounded border text-sm transition-colors',
                    mode === value
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300',
                  )}
                >
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{desc}</div>
                </button>
              ))}
            </div>

            {mode !== 'price' && (
              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePrice}
                  onChange={(e) => setIncludePrice(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Also replicate price override
                </span>
              </label>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={replicate}
              loading={replicating}
              disabled={selected.size === 0}
            >
              Replicate to {selected.size > 0 ? `${selected.size} market${selected.size !== 1 ? 's' : ''}` : '…'}
            </Button>
            {selected.size === 0 && (
              <span className="text-xs text-slate-400">Select at least one target market</span>
            )}
          </div>

          {msg && (
            <div
              className={cn(
                'text-sm px-3 py-2 rounded',
                msg.kind === 'success' && 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300',
                msg.kind === 'error' && 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
              )}
            >
              {msg.text}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── PublishReviewModal ─────────────────────────────────────────
function PublishReviewModal({
  productId,
  channel,
  marketplace,
  marketInfo,
  listing,
  product,
  onClose,
}: {
  productId: string
  channel: string
  marketplace: string
  marketInfo: MarketInfo
  listing: Listing | undefined
  product: any
  onClose: () => void
}) {
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const title = listing?.title ?? product?.name ?? ''
  const description = listing?.description ?? ''
  const bullets = Array.isArray(listing?.bulletPointsOverride) ? listing!.bulletPointsOverride : []
  const rawPrice = listing?.price != null ? Number(listing.price) : (product?.basePrice != null ? Number(product.basePrice) : null)
  const price = rawPrice != null && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null
  const quantity = typeof listing?.quantity === 'number' ? listing.quantity : null
  const productType = (listing as any)?.platformAttributes?.productType ?? product?.productType ?? ''

  const checks = [
    {
      key: 'title',
      label: 'Title',
      done: typeof title === 'string' && title.trim().length > 0,
      preview: title ? title.slice(0, 60) + (title.length > 60 ? '…' : '') : null,
      critical: true,
    },
    {
      key: 'description',
      label: 'Description',
      done: typeof description === 'string' && description.trim().length > 0,
      preview: description ? `${description.trim().length} chars` : null,
      critical: false,
    },
    {
      key: 'bullets',
      label: 'Bullet points',
      done: bullets.length >= 3,
      preview: `${bullets.length}/3 required`,
      critical: false,
    },
    {
      key: 'price',
      label: 'Price',
      done: price !== null,
      preview: price !== null ? `${marketInfo.currency} ${price.toFixed(2)}` : null,
      critical: true,
    },
    {
      key: 'quantity',
      label: 'Quantity',
      done: quantity !== null && quantity >= 0,
      preview: quantity !== null ? String(quantity) : null,
      critical: false,
    },
    {
      key: 'productType',
      label: 'Product type',
      done: typeof productType === 'string' && productType.trim().length > 0,
      preview: productType || null,
      critical: true,
    },
  ]

  const hasCriticalMissing = checks.some((c) => c.critical && !c.done)
  const hasAnyMissing = checks.some((c) => !c.done)

  // Build the full field review list — everything that will be sent to the channel.
  // Direct columns first, then all non-empty schema attributes from platformAttributes.
  const attrs = (listing as any)?.platformAttributes?.attributes as Record<string, unknown> | undefined
  const fieldRows: { label: string; value: string }[] = []

  if (title) fieldRows.push({ label: 'Title', value: title })
  if (description) fieldRows.push({ label: 'Description', value: description.trim().slice(0, 200) + (description.trim().length > 200 ? '…' : '') })
  if (bullets.length > 0) {
    bullets.forEach((b, i) => fieldRows.push({ label: `Bullet ${i + 1}`, value: b }))
  }
  if (price !== null) fieldRows.push({ label: 'Price', value: `${marketInfo.currency} ${price.toFixed(2)}` })
  if (quantity !== null) fieldRows.push({ label: 'Quantity', value: String(quantity) })
  if (productType) fieldRows.push({ label: 'Product type', value: productType })
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === null || val === undefined || val === '') continue
      // Skip internal keys already shown above
      if (['item_name', 'product_description', 'bullet_point'].includes(key)) continue
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      let display = ''
      if (typeof val === 'string') display = val
      else if (typeof val === 'number' || typeof val === 'boolean') display = String(val)
      else if (Array.isArray(val)) display = (val as string[]).filter(Boolean).join(', ')
      else {
        try { display = JSON.stringify(val) } catch { display = String(val) }
      }
      if (display) fieldRows.push({ label, value: display.slice(0, 120) + (display.length > 120 ? '…' : '') })
    }
  }

  async function handlePublish() {
    setPublishing(true)
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/${channel}/${marketplace}/publish`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      )
      const json = await res.json()
      if (!res.ok) {
        setResult({ ok: false, message: json?.error ?? `HTTP ${res.status}` })
      } else {
        setResult({ ok: json.ok ?? true, message: json.message ?? 'Published successfully' })
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setPublishing(false)
    }
  }

  const CHANNEL_LABEL: Record<string, string> = {
    AMAZON: 'Amazon',
    EBAY: 'eBay',
    SHOPIFY: 'Shopify',
    WOOCOMMERCE: 'WooCommerce',
    ETSY: 'Etsy',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={result?.ok ? onClose : undefined}
        aria-hidden="true"
      />
      {/* Modal card */}
      <div className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Publish to {CHANNEL_LABEL[channel] ?? channel} {marketplace}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            aria-label="Close"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Readiness checklist */}
          <div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Readiness checklist
            </div>
            <ul className="space-y-2">
              {checks.map((item) => (
                <li key={item.key} className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      'flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-xs mt-0.5',
                      item.done
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : item.critical
                        ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
                    )}
                  >
                    {item.done ? '✓' : '✗'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className={cn(
                      'text-sm',
                      item.done
                        ? 'text-slate-700 dark:text-slate-300'
                        : item.critical
                        ? 'text-rose-700 dark:text-rose-300 font-medium'
                        : 'text-amber-700 dark:text-amber-300',
                    )}>
                      {item.label}
                    </span>
                    {item.preview && (
                      <span className="ml-2 text-xs text-slate-400 dark:text-slate-500 truncate">
                        {item.preview}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Fields being published */}
          {fieldRows.length > 0 && (
            <div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Fields to publish ({fieldRows.length})
              </div>
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800 max-h-64 overflow-y-auto">
                {fieldRows.map((row, i) => (
                  <div key={i} className="flex gap-3 px-3 py-2 text-sm">
                    <span className="flex-shrink-0 w-32 text-slate-500 dark:text-slate-400 font-medium truncate">
                      {row.label}
                    </span>
                    <span className="flex-1 min-w-0 text-slate-800 dark:text-slate-200 break-words">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Warning banner */}
          {hasAnyMissing && (
            <div className={cn(
              'rounded-lg px-4 py-3 text-sm flex items-start gap-2',
              hasCriticalMissing
                ? 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                : 'bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
            )}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                {hasCriticalMissing
                  ? 'Fix the items above before publishing'
                  : 'Some optional fields are missing — you can still publish'}
              </span>
            </div>
          )}

          {/* Price display */}
          {price !== null && (
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Will publish at:{' '}
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {marketInfo.currency} {price.toFixed(2)}
              </span>
            </div>
          )}

          {/* Result banner */}
          {result && (
            <div className={cn(
              'rounded-lg px-4 py-3 text-sm flex items-start gap-2',
              result.ok
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                : 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300',
            )}>
              {result.ok
                ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
              <span>{result.message}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex items-center justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {result?.ok ? 'Close' : 'Cancel'}
          </Button>
          {!result?.ok && (
            <Button
              size="sm"
              onClick={handlePublish}
              loading={publishing}
              disabled={hasCriticalMissing || publishing}
              icon={publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── W5.1 Readiness checklist (Salsify cornerstone) ────────────
function ReadinessChecklist({
  listing,
  t,
}: {
  listing: Listing | undefined
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const items = [
    {
      key: 'title',
      label: t('products.edit.readiness.title'),
      done: !!listing && typeof listing.title === 'string' && listing.title.trim().length > 0,
    },
    {
      key: 'description',
      label: t('products.edit.readiness.description'),
      done: !!listing && typeof listing.description === 'string' && listing.description.trim().length > 0,
    },
    {
      key: 'bullets',
      label: t('products.edit.readiness.bullets'),
      done: !!listing && Array.isArray(listing.bulletPointsOverride) && listing.bulletPointsOverride.length >= 3,
      hint: t('products.edit.readiness.bulletsHint'),
    },
    {
      key: 'price',
      label: t('products.edit.readiness.price'),
      done: !!listing && listing.price != null && Number.isFinite(Number(listing.price)) && Number(listing.price) > 0,
    },
    {
      key: 'quantity',
      label: t('products.edit.readiness.quantity'),
      done: !!listing && typeof listing.quantity === 'number' && listing.quantity >= 0,
      hint: t('products.edit.readiness.quantityHint'),
    },
  ]
  const score = items.filter((i) => i.done).length * 20
  const tone = score >= 100 ? 'success' : score >= 60 ? 'warning' : 'danger'

  return (
    <Card noPadding>
      <div className="px-4 py-3 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {t('products.edit.readiness.label')}
          </div>
          <div className="text-md font-medium text-slate-900 dark:text-slate-100 mt-0.5">
            {t('products.edit.readiness.summary', {
              done: items.filter((i) => i.done).length,
              total: items.length,
            })}
          </div>
        </div>
        <div className="flex-shrink-0">
          <span
            className={cn(
              'inline-flex items-center justify-center px-2.5 py-1 rounded font-mono text-md tabular-nums',
              tone === 'success' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
              tone === 'warning' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
              tone === 'danger' && 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
            )}
          >
            {score}%
          </span>
        </div>
      </div>
      <ul className="px-4 py-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-md">
            <span
              className={cn(
                'inline-flex items-center justify-center w-4 h-4 rounded-full flex-shrink-0 mt-0.5 text-xs font-mono',
                item.done
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
              )}
            >
              {item.done ? '✓' : ' '}
            </span>
            <div className="flex-1 min-w-0">
              <div className={cn(item.done ? 'text-slate-700 dark:text-slate-300' : 'text-slate-500 dark:text-slate-400')}>
                {item.label}
              </div>
              {'hint' in item && item.hint && !item.done && (
                <div className="text-xs text-slate-500 dark:text-slate-400">{item.hint}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
