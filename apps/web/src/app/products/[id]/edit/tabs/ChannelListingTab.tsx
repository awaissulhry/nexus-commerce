'use client'

import { useRef, useState } from 'react'
import { Sparkles, ArrowDownToLine, ArrowUpFromLine, AlertTriangle } from 'lucide-react'
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
  [key: string]: any
}

interface Props {
  product: any
  channel: string
  marketplace: string
  marketInfo: MarketInfo
  listing: Listing | undefined
  /** W1.1 — number of unsaved fields in the schema-driven editor.
   *  Bubbles to ProductEditClient's per-tab dirty aggregation. */
  onDirtyChange: (count: number) => void
  onSave: (updated: Listing) => void
}

export default function ChannelListingTab({
  product,
  channel,
  marketplace,
  marketInfo,
  listing,
  onDirtyChange,
  onSave,
}: Props) {
  const { t } = useTranslations()
  const [pulling, setPulling] = useState(false)
  // W1.5 — translate-all is debounced to one in-flight call at a
  // time; the editor below drives the actual fan-out via the ref
  // ChannelFieldEditor binds when its schema manifest loads.
  const [translating, setTranslating] = useState(false)
  const translateAllRef = useRef<
    | (() => Promise<{ translated: number; skipped: number }>)
    | null
  >(null)
  const [statusMsg, setStatusMsg] = useState<{
    kind: 'info' | 'error' | 'success'
    text: string
  } | null>(null)
  const isNew = !listing

  // NN.18 — fetch wrapper with 429 handling. Amazon SP-API and eBay
  // Inventory API both rate-limit per-account. Without retry, a
  // simple click that lands during a throttle window fails with a
  // generic "HTTP 429" — useless to the user. We catch 429, parse
  // Retry-After, surface a clear message, and retry once after the
  // server-suggested delay (capped at 8s so the UI doesn't hang).
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
          setStatusMsg({
            kind: 'error',
            text: 'Amazon: still rate-limited after retry — try again in a minute.',
          })
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
      // DD.3 — eBay Inventory API is seller-account-scoped and keyed by
      // SKU (the same SKU we sent on createOrReplace). The product's
      // master SKU is the natural lookup key for the canonical listing.
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
          setStatusMsg({
            kind: 'info',
            text: `eBay rate-limited — retrying in ${sec}s…`,
          }),
        )
        if (res.status === 429) {
          setStatusMsg({
            kind: 'error',
            text: 'eBay: still rate-limited after retry — try again in a minute.',
          })
          return
        }
        const result = await res.json()
        if (!res.ok || !result?.success) {
          setStatusMsg({ kind: 'error', text: `eBay: ${result?.error ?? `HTTP ${res.status}`}` })
        } else if (!result.found) {
          setStatusMsg({ kind: 'info', text: result.message ?? 'No eBay item for this SKU yet.' })
        } else if (result.summary?.title) {
          setStatusMsg({
            kind: 'success',
            text: `Pulled latest title: "${result.summary.title}"`,
          })
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

  // W1.5 — translate every AI-supported string field on the active
  // listing in one click. ChannelFieldEditor binds the imperative
  // handle when its manifest loads; if the user clicks before that,
  // we say so rather than no-op silently.
  async function handleAITranslate() {
    const fn = translateAllRef.current
    if (!fn) {
      setStatusMsg({
        kind: 'info',
        text: t('products.edit.translate.editorLoading'),
      })
      return
    }
    setTranslating(true)
    setStatusMsg({
      kind: 'info',
      text: t('products.edit.translate.running', {
        marketplace: marketInfo.code,
      }),
    })
    try {
      const { translated, skipped } = await fn()
      if (translated === 0 && skipped === 0) {
        setStatusMsg({
          kind: 'info',
          text: t('products.edit.translate.noFields'),
        })
      } else if (translated === 0) {
        setStatusMsg({
          kind: 'error',
          text: t('products.edit.translate.allSkipped', {
            count: skipped,
          }),
        })
      } else if (skipped === 0) {
        setStatusMsg({
          kind: 'success',
          text: t('products.edit.translate.success', {
            count: translated,
          }),
        })
      } else {
        setStatusMsg({
          kind: 'success',
          text: t('products.edit.translate.partial', {
            translated,
            skipped,
          }),
        })
      }
    } catch (e) {
      setStatusMsg({
        kind: 'error',
        text: t('products.edit.translate.failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      })
    } finally {
      setTranslating(false)
    }
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
              title={t('products.edit.translate.tooltip', {
                marketplace: marketInfo.code,
              })}
            >
              {t('products.edit.translate.button')}
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
      />
    </div>
  )
}

// ── W5.1 Readiness checklist (Salsify cornerstone) ────────────
//
// Five top-level dimensions, 20% each. ReadinessChecklist mirrors
// the same scoring as channelReadiness() in ProductEditClient so
// the per-tab badge and the per-listing hero can never diverge.
// Per-listing schema-required attributes (platformAttributes) aren't
// surfaced here — those land in the schema-driven editor below this
// card and contribute to the per-tab "Unsaved" counter when dirty.
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
      done:
        !!listing &&
        typeof listing.title === 'string' &&
        listing.title.trim().length > 0,
    },
    {
      key: 'description',
      label: t('products.edit.readiness.description'),
      done:
        !!listing &&
        typeof listing.description === 'string' &&
        listing.description.trim().length > 0,
    },
    {
      key: 'bullets',
      label: t('products.edit.readiness.bullets'),
      done:
        !!listing &&
        Array.isArray(listing.bulletPointsOverride) &&
        listing.bulletPointsOverride.length >= 3,
      hint: t('products.edit.readiness.bulletsHint'),
    },
    {
      key: 'price',
      label: t('products.edit.readiness.price'),
      done:
        !!listing &&
        listing.price != null &&
        Number.isFinite(Number(listing.price)) &&
        Number(listing.price) > 0,
    },
    {
      key: 'quantity',
      label: t('products.edit.readiness.quantity'),
      done:
        !!listing &&
        typeof listing.quantity === 'number' &&
        listing.quantity >= 0,
      hint: t('products.edit.readiness.quantityHint'),
    },
  ]
  const score = items.filter((i) => i.done).length * 20
  const tone =
    score >= 100 ? 'success' : score >= 60 ? 'warning' : 'danger'

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
              tone === 'success' &&
                'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
              tone === 'warning' &&
                'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
              tone === 'danger' &&
                'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
            )}
          >
            {score}%
          </span>
        </div>
      </div>
      <ul className="px-4 py-2 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-start gap-2 text-md"
          >
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
              <div
                className={cn(
                  item.done
                    ? 'text-slate-700 dark:text-slate-300'
                    : 'text-slate-500 dark:text-slate-400',
                )}
              >
                {item.label}
              </div>
              {item.hint && !item.done && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {item.hint}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
