'use client'

// AC.9 — Pricing & Offers card.
//
// Replaces the AC.1 Pricing placeholder with a dense pricing
// dashboard for the active marketplace. Four sections:
//
//   1. Price block — regular + sale (with Save% math), currency, qty,
//      last-synced. The price/qty values are seeded from the
//      cockpit's composed listing so they react to live edits via
//      the draft bus (AC.5).
//
//   2. Buy Box state — pulls from BuyBoxHistory via the new
//      /api/products/:id/buybox endpoint (AC.9.1). Renders a won/
//      lost pill, current Buy Box price, lowest competitor, our
//      margin %, winning fulfillment method, and a small recent-
//      observations sparkline (won/lost dots).
//
//   3. Repricing rule + decision tail — the active RepricingRule
//      for (product, channel, marketplace) plus the last 5
//      decisions with timestamps and decided price.
//
//   4. Offer add-ons — placeholder chips for Subscribe & Save +
//      Business pricing. SP-API exposes neither cleanly today; the
//      chips surface "not available" honestly until AC.9.2 wires
//      the real subscription/business-pricing checks.

import { useEffect, useState } from 'react'
import {
  DollarSign,
  Trophy,
  Target,
  Loader2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Lock,
  Pencil,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface BuyBoxObservation {
  id: string
  observedAt: string
  buyBoxPrice: number | string | null
  lowestCompetitorPrice: number | string | null
  isOurOffer: boolean
  winnerSellerId: string | null
  fulfillmentMethod: string | null
  marginAtObservation: number | string | null
}

interface RepricingRule {
  id: string
  channel: string
  marketplace: string | null
  strategy: string
  enabled: boolean
  minPrice: number | string
  maxPrice: number | string
  beatPct: number | string | null
  beatAmount: number | string | null
  updatedAt: string
}

interface RepricingDecisionRow {
  id: string
  createdAt: string
  applied: boolean
  decidedPrice: number | string | null
  reason: string | null
  oldPrice: number | string | null
  newPrice: number | string | null
}

interface BuyboxResponse {
  current: BuyBoxObservation | null
  history: BuyBoxObservation[]
  rule: RepricingRule | null
  decisions: RepricingDecisionRow[]
}

interface Props {
  productId: string
  marketplace: string
  currency: string
  price: number | null
  /** Sale price from the listing (when active). */
  salePrice?: number | null
  quantity: number | null
  /** When the listing was last synced to Amazon (lastSyncedAt). */
  lastSyncedAt?: string | null
  /** AC.9.2 — active ChannelListing id for this (product, AMAZON,
   *  marketplace). Drives the inline PATCH that persists
   *  priceOverride + salePrice. Edit affordance is hidden when null. */
  listingId?: string | null
  /** AC.9.2 — fires after a successful PATCH so the parent can
   *  router.refresh() and pick up the new price values in props. */
  onSaved?: () => void
  /** Click-to-jump to the classic field editor. */
  onJumpToClassic?: () => void
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

function formatPrice(value: number | null, currency: string): string {
  if (value == null) return '—'
  const sym =
    currency === 'EUR' ? '€'
    : currency === 'GBP' ? '£'
    : currency === 'USD' ? '$'
    : currency === 'JPY' ? '¥'
    : `${currency} `
  return `${sym}${value.toFixed(2)}`
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const STRATEGY_LABEL: Record<string, string> = {
  beat_lowest_by_pct: 'Beat lowest by %',
  beat_lowest_by_amount: 'Beat lowest by amount',
  fixed_to_buy_box_minus: 'Buy Box minus',
  manual: 'Manual only',
}

export default function PricingCard({
  productId,
  marketplace,
  currency,
  price,
  salePrice,
  quantity,
  lastSyncedAt,
  listingId,
  onSaved,
  onJumpToClassic,
}: Props) {
  const { t } = useTranslations()
  const [data, setData] = useState<BuyboxResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // AC.9.2 — inline price editor state.
  const [editingPrice, setEditingPrice] = useState(false)
  const [editPrice, setEditPrice] = useState('')
  const [editSalePrice, setEditSalePrice] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [priceBusy, setPriceBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)

  async function handleSavePrice() {
    if (!listingId) {
      setEditError('No listing on this market yet — publish first.')
      return
    }
    const priceParsed = editPrice.trim() === '' ? null : Number(editPrice)
    const saleParsed =
      editSalePrice.trim() === '' ? null : Number(editSalePrice)
    if (priceParsed != null && (!Number.isFinite(priceParsed) || priceParsed < 0)) {
      setEditError('Price must be a non-negative number.')
      return
    }
    if (saleParsed != null && (!Number.isFinite(saleParsed) || saleParsed < 0)) {
      setEditError('Sale price must be a non-negative number.')
      return
    }
    if (priceParsed != null && saleParsed != null && saleParsed >= priceParsed) {
      setEditError(
        'Sale price must be less than the regular price (or leave blank).',
      )
      return
    }
    setPriceBusy(true)
    setEditError(null)
    try {
      const body: Record<string, unknown> = {}
      // Always include both keys so the server can clear a value with
      // explicit null. priceOverride === current price → keep field
      // but no-op.
      body.priceOverride = priceParsed
      body.salePrice = saleParsed
      const res = await fetch(
        `${getBackendUrl()}/api/listings/${encodeURIComponent(listingId)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = await res.json().catch(() => null)
        throw new Error(errBody?.error ?? `HTTP ${res.status}`)
      }
      setEditingPrice(false)
      setSavedFlash(
        saleParsed != null
          ? `Saved — sale price set to ${formatPrice(saleParsed, currency)}.`
          : priceParsed != null
            ? `Saved — price set to ${formatPrice(priceParsed, currency)}.`
            : 'Saved — pricing cleared.',
      )
      window.setTimeout(() => setSavedFlash(null), 3000)
      onSaved?.()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setPriceBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const url = `${getBackendUrl()}/api/products/${productId}/buybox?marketplace=${encodeURIComponent(marketplace)}`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = (await res.json()) as BuyboxResponse
        if (!cancelled) setData(j)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [productId, marketplace, tick])

  // Save% math when sale price is active.
  const savePct = (() => {
    if (price == null || salePrice == null || price <= 0) return null
    if (salePrice >= price) return null
    return Math.round(((price - salePrice) / price) * 100)
  })()

  const buyBox = data?.current ?? null
  const bbPrice = toNum(buyBox?.buyBoxPrice ?? null)
  const lowestComp = toNum(buyBox?.lowestCompetitorPrice ?? null)
  const margin = toNum(buyBox?.marginAtObservation ?? null)

  return (
    <div
      data-jump-target="pricing"
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <DollarSign className="w-4 h-4 text-slate-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.cockpit.amazon.cards.pricing')}
          </span>
          {loading && (
            <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          className="inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          title="Refresh Buy Box + repricing state"
          disabled={loading}
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          {t('products.edit.cockpit.amazon.pricing.refresh')}
        </button>
      </div>

      {/* ── 1. Price block (AC.9.2 inline editor) ─────────────────── */}
      <div className="rounded border border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-2.5">
        {editingPrice ? (
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10.5px] text-slate-500 dark:text-slate-400">
                Price
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  className="mt-0.5 w-full h-7 px-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-[13px] font-mono"
                  autoFocus
                />
              </label>
              <label className="text-[10.5px] text-slate-500 dark:text-slate-400">
                Sale price <span className="text-slate-400">(blank = none)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editSalePrice}
                  onChange={(e) => setEditSalePrice(e.target.value)}
                  className="mt-0.5 w-full h-7 px-1.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-[13px] font-mono"
                />
              </label>
            </div>
            {editError && (
              <div className="text-[10.5px] text-rose-700 dark:text-rose-400">
                {editError}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleSavePrice}
                disabled={priceBusy}
                className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {priceBusy ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : null}
                {priceBusy
                  ? t('products.edit.cockpit.amazon.pricing.saving')
                  : t('products.edit.cockpit.amazon.pricing.save')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingPrice(false)
                  setEditError(null)
                }}
                disabled={priceBusy}
                className="inline-flex items-center h-6 px-2 rounded text-[11px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {t('products.edit.cockpit.amazon.pricing.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100 leading-none">
                {formatPrice(salePrice ?? price, currency)}
              </span>
              {salePrice != null && price != null && salePrice < price && (
                <>
                  <span className="text-sm line-through text-slate-400">
                    {formatPrice(price, currency)}
                  </span>
                  {savePct != null && (
                    <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
                      Save {savePct}%
                    </span>
                  )}
                </>
              )}
              {listingId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditPrice(price != null ? price.toFixed(2) : '')
                    setEditSalePrice(
                      salePrice != null ? salePrice.toFixed(2) : '',
                    )
                    setEditError(null)
                    setEditingPrice(true)
                  }}
                  className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  title="Edit price + sale price"
                >
                  <Pencil className="w-3 h-3" />
                  {t('products.edit.cockpit.amazon.pricing.edit')}
                </button>
              )}
            </div>
            {savedFlash && (
              <div className="mt-1 text-[10.5px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <Check className="w-3 h-3" /> {savedFlash}
              </div>
            )}
          </>
        )}
        <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-slate-500 dark:text-slate-400">
          <span>
            Qty{' '}
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              {quantity ?? 0}
            </span>
          </span>
          <span>·</span>
          <span>Synced {formatRelative(lastSyncedAt)}</span>
          {price == null && (
            <span className="text-rose-600 dark:text-rose-400">
              · No price set
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── 2. Buy Box state ──────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-1.5">
            <Trophy className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Buy Box
            </span>
            {buyBox && (
              <span
                className={cn(
                  'inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wide',
                  buyBox.isOurOffer
                    ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                    : 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300',
                )}
              >
                {buyBox.isOurOffer ? 'WON' : 'LOST'}
              </span>
            )}
          </div>
          {buyBox && (
            <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
              {formatRelative(buyBox.observedAt)}
            </span>
          )}
        </div>
        {!buyBox ? (
          <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 p-2 text-[11px] text-slate-500 dark:text-slate-400 italic">
            No Buy Box observations yet for this product on{' '}
            {marketplace}. The sp-api-pricing cron populates BuyBoxHistory
            every few hours.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <KpiBox
              label="Buy Box price"
              value={formatPrice(bbPrice, currency)}
            />
            <KpiBox
              label="Lowest comp"
              value={formatPrice(lowestComp, currency)}
              tone={
                bbPrice != null && lowestComp != null && lowestComp < bbPrice
                  ? 'warn'
                  : undefined
              }
            />
            <KpiBox
              label="Our margin"
              value={margin != null ? `${(margin * 100).toFixed(1)}%` : '—'}
              tone={
                margin != null && margin < 0.1
                  ? 'warn'
                  : margin != null && margin >= 0.3
                  ? 'good'
                  : undefined
              }
            />
            <KpiBox
              label="Winner FBA/FBM"
              value={buyBox.fulfillmentMethod ?? '—'}
            />
          </div>
        )}

        {/* Recent observations sparkline (won/lost dots). */}
        {data && data.history.length > 0 && (
          <div className="flex items-center gap-1 pt-1">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 mr-1">
              Last 10:
            </span>
            {data.history.slice().reverse().map((o) => (
              <span
                key={o.id}
                title={`${formatRelative(o.observedAt)} · ${o.isOurOffer ? 'won' : 'lost'} · BB ${formatPrice(toNum(o.buyBoxPrice), currency)}`}
                className={cn(
                  'w-2 h-2 rounded-sm',
                  o.isOurOffer
                    ? 'bg-emerald-500'
                    : 'bg-rose-500',
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 3. Repricing rule + decisions ─────────────────────────── */}
      <div className="space-y-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Repricing rule
            </span>
            {data?.rule && (
              <span
                className={cn(
                  'inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wide',
                  data.rule.enabled
                    ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
                )}
              >
                {data.rule.enabled ? 'ENABLED' : 'PAUSED'}
              </span>
            )}
          </div>
          <a
            href={`/pricing/rules?productId=${productId}`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
          >
            Manage <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        {!data?.rule ? (
          <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 p-2 text-[11px] text-slate-500 dark:text-slate-400">
            No repricing rule for this product on {marketplace}. Set one in{' '}
            <a
              href={`/pricing/rules?productId=${productId}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Pricing → Rules
            </a>
            .
          </div>
        ) : (
          <>
            <div className="rounded border border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 p-2 text-[11.5px] text-slate-700 dark:text-slate-300 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">
                  {STRATEGY_LABEL[data.rule.strategy] ?? data.rule.strategy}
                </span>
                {data.rule.beatPct != null && (
                  <span className="font-mono text-[10.5px]">
                    by {toNum(data.rule.beatPct)}%
                  </span>
                )}
                {data.rule.beatAmount != null && (
                  <span className="font-mono text-[10.5px]">
                    by {formatPrice(toNum(data.rule.beatAmount), currency)}
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-slate-500 dark:text-slate-400 flex items-center gap-2">
                <Lock className="w-2.5 h-2.5" />
                Floor {formatPrice(toNum(data.rule.minPrice), currency)} ·
                ceiling {formatPrice(toNum(data.rule.maxPrice), currency)}
              </div>
            </div>
            {data.decisions.length > 0 && (
              <ul className="space-y-0.5">
                {data.decisions.slice(0, 5).map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between gap-2 text-[10.5px] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800/60"
                  >
                    <span className="text-slate-500 dark:text-slate-400 w-[64px] flex-shrink-0">
                      {formatRelative(d.createdAt)}
                    </span>
                    <span
                      className={cn(
                        'font-mono flex-1 min-w-0 truncate',
                        d.applied
                          ? 'text-slate-900 dark:text-slate-100'
                          : 'text-slate-400 line-through',
                      )}
                      title={d.reason ?? ''}
                    >
                      {formatPrice(toNum(d.oldPrice), currency)} →{' '}
                      {formatPrice(toNum(d.newPrice ?? d.decidedPrice), currency)}
                    </span>
                    <span
                      className={cn(
                        'text-[9.5px] uppercase tracking-wide px-1 rounded',
                        d.applied
                          ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
                      )}
                    >
                      {d.applied ? 'applied' : 'skipped'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* ── 4. Offer add-ons (placeholder) ────────────────────────── */}
      <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Add-ons
          </span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[10.5px] text-slate-500 dark:text-slate-400">
            Subscribe & Save
            <span className="ml-1 text-[9px] text-slate-400">AC.9.2</span>
          </span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[10.5px] text-slate-500 dark:text-slate-400">
            Business pricing
            <span className="ml-1 text-[9px] text-slate-400">AC.9.2</span>
          </span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-[10.5px] text-slate-500 dark:text-slate-400">
            Coupons / Lightning Deals
            <span className="ml-1 text-[9px] text-slate-400">AC.9.2</span>
          </span>
        </div>
      </div>

      {onJumpToClassic && (
        <div className="pt-1 text-[10.5px] text-slate-400 italic flex items-center justify-between">
          <span>
            S&S / business pricing / coupons need SP-API surfaces — deferred to AC.9.3.
          </span>
          <button
            type="button"
            onClick={onJumpToClassic}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Classic editor →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Tiny KPI tile ──────────────────────────────────────────────────────
function KpiBox({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}) {
  return (
    <div
      className={cn(
        'rounded border p-1.5',
        tone === 'good'
          ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30'
          : tone === 'warn'
          ? 'border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30'
          : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40',
      )}
    >
      <div className="text-[9.5px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="text-[12px] font-semibold text-slate-900 dark:text-slate-100 font-mono">
        {value}
      </div>
    </div>
  )
}
