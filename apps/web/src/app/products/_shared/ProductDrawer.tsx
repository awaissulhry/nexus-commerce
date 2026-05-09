/**
 * F1 — Product drawer.
 *
 * Slide-in panel mounted from the /products grid. Click a product row,
 * the drawer opens with that product's full state without a route
 * navigation. Esc closes; clicking the dim overlay closes; the URL
 * carries `?drawer=<productId>` so direct links work and back/forward
 * behave naturally.
 *
 * Tabs:
 *   Details   master data + image gallery + quick-edit price/stock
 *             (the same PATCH /api/products/:id the inline grid uses,
 *             with the same atomic guarantees from B4).
 *   Listings  per-channel + per-marketplace summary; click-through to
 *             /listings/:id for the deep-dive.
 *   Activity  AuditLog rows for this product. F3 populates the data
 *             fetch; the tab structure ships now so the empty state
 *             is in place.
 *
 * Footer:
 *   "Open full edit" link to /products/:id/edit for power-user work
 *   that doesn't fit the drawer.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  X,
  ExternalLink,
  Package,
  ChevronRight,
  AlertCircle,
  Loader2,
  Activity,
  Boxes,
  Edit3,
  Image as ImageIcon,
  Globe,
  Plus,
  Sparkles,
  Check,
  Trash2,
  Network,
  Search,
  Layers,
  RefreshCw,
  CheckCircle2,
  Calendar,
  XCircle,
  Clock,
  DollarSign,
  GitBranch,
  Send,
} from 'lucide-react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { InlineEditTrigger } from '@/components/ui/InlineEditTrigger'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { StatusBadge } from '@/components/ui/StatusBadge'

// U.1 — focusable-element selector for the drawer's a11y focus trap.
// Standard set of natively-tabbable elements. We additionally filter
// disabled + hidden (offsetParent === null) at query time so the trap
// stays accurate to the currently-visible UI (inactive tab content is
// excluded). [tabindex="-1"] is excluded because those are
// programmatically focusable but not in the tab cycle.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface ProductDetail {
  id: string
  sku: string
  name: string
  brand: string | null
  productType: string | null
  status: string
  basePrice: string | number | null
  totalStock: number | null
  lowStockThreshold: number | null
  amazonAsin: string | null
  ebayItemId: string | null
  isParent: boolean
  parentId: string | null
  weightValue: number | null
  weightUnit: string | null
  description: string | null
  bulletPoints?: string[]
  keywords?: string[]
  fulfillmentMethod: string | null
  updatedAt: string
  createdAt: string
  _count?: {
    images: number
    channelListings: number
    variations: number
    /** P.6 — counts for tab badges (translations + outgoing relations). */
    translations?: number
    relationsFrom?: number
    /** P.8 — count of child Products (parentId), shown on the
     *  Variations tab badge for parent products. */
    children?: number
  }
  /** P.18 — health score 0-100 + per-issue list. Computed
   *  server-side in /api/products/:id/health and surfaced in the
   *  DetailsTab as a Health card. */
  score?: number
  issues?: Array<{
    severity: 'error' | 'warning' | 'info'
    message: string
    channel?: string
    marketplace?: string
  }>
  channelListings?: Array<{
    id: string
    channel: string
    marketplace: string
    listingStatus: string
    syncStatus: string | null
    lastSyncStatus: string | null
    lastSyncError: string | null
    lastSyncedAt: string | null
    isPublished: boolean
    price: string | number | null
    quantity: number | null
    // F9 — drift signals from Phase 13. masterPrice / masterQuantity
    // are the snapshots maintained by MasterPriceService and
    // applyStockMovement; they tell us what the listing thinks the
    // master value was at last sync. Drift = followMasterPrice=false
    // AND the snapshot differs from the published price.
    masterPrice?: string | number | null
    masterQuantity?: number | null
    followMasterPrice?: boolean
    followMasterQuantity?: boolean
    title: string | null
    externalListingId: string | null
  }>
  images?: Array<{ url: string; type: string | null }>
}

export interface ProductDrawerProps {
  productId: string | null
  onClose: () => void
  /** Called after a successful in-drawer mutation so the parent can
   *  refetch the grid. Phase 10 invalidation already broadcasts; this
   *  is the in-tab signal. */
  onChanged?: () => void
}

type Tab =
  | 'details'
  | 'listings'
  | 'variations'
  | 'images'
  | 'translations'
  | 'pricing'
  | 'related'
  | 'activity'
  | 'schedule'
  | 'workflow'

export default function ProductDrawer({
  productId,
  onClose,
  onChanged,
}: ProductDrawerProps) {
  const { t } = useTranslations()
  // P.6 — tab persisted in the URL (?drawerTab=<name>) so a refresh
  // keeps the user on the tab they were reading. Falls back to
  // 'details' for any unknown / missing value. Writes are scroll: false
  // so switching tabs doesn't yank the page.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlTab = searchParams.get('drawerTab') as Tab | null
  const tab: Tab =
    urlTab && ['details', 'listings', 'variations', 'translations', 'related', 'activity', 'workflow'].includes(urlTab)
      ? urlTab
      : 'details'
  const setTab = useCallback(
    (next: Tab) => {
      const sp = new URLSearchParams(searchParams.toString())
      if (next === 'details') sp.delete('drawerTab')
      else sp.set('drawerTab', next)
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const [data, setData] = useState<ProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // U.1 — captures the element that had focus at the moment the drawer
  // opened (typically a row's "View" button or a Cmd+K palette item).
  // The cleanup branch of the focus-management effect returns focus to
  // it on close so keyboard users don't get stranded at <body>.
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Reset state when productId changes (e.g. user clicks a different
  // row while the drawer is open). We do NOT reset the tab — the user
  // probably wants to keep their context (e.g. always check Listings
  // when scanning multiple products).
  useEffect(() => {
    if (!productId) return
    setData(null)
    setError(null)
  }, [productId])

  const fetchDetail = useCallback(async () => {
    if (!productId) return
    setLoading(true)
    setError(null)
    try {
      // Reuses /api/products/:id/health which now (P.6) returns the
      // full master product + nested ChannelListings + images +
      // counts in one round-trip, ETag-cached. Before P.6 the
      // endpoint only returned the health-badge fields; the drawer
      // silently rendered empty Description / Listings cards.
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/health`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json as ProductDetail)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (productId) fetchDetail()
  }, [productId, fetchDetail])

  // P.6 — cross-tab refresh. If another tab edits this product (or a
  // listing belonging to it), refetch so the drawer doesn't show
  // stale master data. Matches when:
  //   - event.id === productId (single-subject events)
  //   - event.meta.productIds includes productId (bulk events)
  //   - event.meta.productId === productId (some emitters use the
  //     singular form on listing.updated)
  useInvalidationChannel(
    ['product.updated', 'listing.updated'],
    (event) => {
      if (!productId) return
      const meta = event.meta as Record<string, unknown> | undefined
      const metaIds = meta?.productIds
      const metaSingleId = meta?.productId
      const matches =
        event.id === productId ||
        metaSingleId === productId ||
        (Array.isArray(metaIds) && metaIds.includes(productId))
      if (matches) void fetchDetail()
    },
  )

  // U.1 — full a11y focus trap. Replaces the prior Esc-only effect.
  // On open: capture trigger element, focus first focusable inside the
  // panel (deferred 10ms so children mount first). On Tab/Shift+Tab:
  // cycle within the panel — when the active element is the last, Tab
  // wraps to first; Shift+Tab from the first wraps to last. Tab from
  // outside the panel (shouldn't happen since the dialog is modal but
  // covers the focus-stolen-by-async-render edge case) lands on first.
  // On Escape: close. On unmount/productId-clear: return focus to the
  // captured trigger if it's still in the DOM (virtualized rows that
  // scrolled out of view get the body-contains guard, falling through
  // to browser default focus).
  useEffect(() => {
    if (!productId) return
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null

    const initialFocusTimer = window.setTimeout(() => {
      const first = containerRef.current?.querySelector<HTMLElement>(
        FOCUSABLE_SELECTOR,
      )
      first?.focus()
    }, 10)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = containerRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (el) =>
          !el.hasAttribute('disabled') &&
          // offsetParent === null catches display:none (e.g. inactive
          // tab content) without triggering layout via getBoundingClientRect.
          el.offsetParent !== null,
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.clearTimeout(initialFocusTimer)
      window.removeEventListener('keydown', onKey)
      const trigger = previouslyFocused.current
      // Guard: trigger may have been removed (virtualized row scrolled
      // off, modal dismissed, etc). Skipping the focus call lets the
      // browser fall back to body — better than throwing.
      if (trigger && document.body.contains(trigger)) {
        trigger.focus()
      }
    }
  }, [productId, onClose])

  if (!productId) return null

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/30 dark:bg-slate-950/60 flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('products.drawer.aria')}
    >
      <div
        ref={containerRef}
        className="w-full max-w-[640px] bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 flex flex-col h-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex-shrink-0 w-12 h-12 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden">
            {data?.images?.[0]?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.images[0].url}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <Package className="w-5 h-5 text-slate-400 dark:text-slate-500" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
                {data?.name ?? (loading ? t('products.drawer.loading') : t('products.drawer.fallback'))}
              </h2>
              {data?.isParent && (
                <a
                  href={`/products/${data.id}/matrix`}
                  className="inline-flex items-center h-5 px-1.5 rounded text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
                  title={t('products.drawer.parentBadgeTitle')}
                >
                  {t(
                    (data._count?.variations ?? 0) === 1
                      ? 'products.drawer.parentBadge.one'
                      : 'products.drawer.parentBadge.other',
                    { count: data._count?.variations ?? 0 },
                  )}
                </a>
              )}
              {data?.status && (
                <StatusBadge status={data.status} />
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400 font-mono mt-0.5">
              <span>{data?.sku ?? '—'}</span>
              {data?.amazonAsin && (
                <a
                  href={`https://amazon.com/dp/${data.amazonAsin}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  ASIN {data.amazonAsin} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {data?.ebayItemId && <span>eBay {data.ebayItemId}</span>}
              {/* L.25.0 — drill-through into /sync-logs/api-calls
                  scoped to this product. Link is unconditional even
                  if no calls are recorded yet — the empty state
                  there explains the absence rather than us hiding
                  the affordance. */}
              {data?.id && (
                <a
                  href={`/sync-logs/api-calls?productId=${encodeURIComponent(data.id)}`}
                  className="inline-flex items-center gap-0.5 hover:text-blue-600 dark:hover:text-blue-400"
                  title={t('products.drawer.syncActivityTitle')}
                >
                  {t('products.drawer.syncActivity')} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
          <IconButton
            onClick={onClose}
            aria-label={t('products.drawer.close')}
            size="md"
            className="-mr-1 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Tabs — U.60: 9 tabs in a narrow drawer overflowed. Container
            now scrolls horizontally; tabs themselves get whitespace-nowrap
            + flex-shrink-0 below so labels never wrap and the row stays
            scannable. Right-edge fade gradient hints at hidden tabs. */}
        <div className="relative">
          <div
            role="tablist"
            aria-label={t('products.drawer.tablistAria')}
            onKeyDown={(e) => {
              // W5.17 — WAI-ARIA tablist keyboard pattern: arrows move
              // focus between tabs (left/right wrap), Home/End jump to
              // ends. Tab itself escapes the tablist (handled by
              // tabIndex=-1 on inactive tabs). Without this, screen-
              // reader users can reach tabs but can't navigate between
              // them — they'd have to Shift-Tab back out + re-Tab in.
              if (
                e.key !== 'ArrowLeft' &&
                e.key !== 'ArrowRight' &&
                e.key !== 'Home' &&
                e.key !== 'End'
              )
                return
              const tabs = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              )
              if (tabs.length === 0) return
              const idx = tabs.findIndex((t) => t === document.activeElement)
              let next = idx
              if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length
              else if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length
              else if (e.key === 'Home') next = 0
              else if (e.key === 'End') next = tabs.length - 1
              if (next !== idx) {
                e.preventDefault()
                tabs[next]?.click()
                tabs[next]?.focus()
              }
            }}
            className="flex items-center border-b border-slate-200 dark:border-slate-800 px-5 overflow-x-auto scroll-smooth [scrollbar-width:thin]"
          >
          <DrawerTab active={tab === 'details'} onClick={() => setTab('details')}>
            <Edit3 className="w-3 h-3" /> {t('products.drawer.tabs.details')}
          </DrawerTab>
          <DrawerTab
            active={tab === 'listings'}
            onClick={() => setTab('listings')}
            count={data?._count?.channelListings}
          >
            <Boxes className="w-3 h-3" /> {t('products.drawer.tabs.listings')}
          </DrawerTab>
          {/* P.8 — Variations tab only renders for parent products.
              Children render under their parent's drawer; standalone
              products don't have variants by definition. */}
          {data?.isParent && (
            <DrawerTab
              active={tab === 'variations'}
              onClick={() => setTab('variations')}
              count={data?._count?.children}
            >
              <Layers className="w-3 h-3" /> {t('products.drawer.tabs.variations')}
            </DrawerTab>
          )}
          {/* U.32 — Images tab. Shows thumbnails of the product's
              ProductImage rows + a deep-link to the full image
              manager at /products/[id]/images for drag-reorder + bulk
              upload. The drawer has always claimed (in its header
              docblock) to surface the image gallery; this tab finally
              fulfils that promise. */}
          <DrawerTab
            active={tab === 'images'}
            onClick={() => setTab('images')}
            count={data?._count?.images}
          >
            <ImageIcon className="w-3 h-3" /> {t('products.drawer.tabs.images')}
          </DrawerTab>
          <DrawerTab
            active={tab === 'translations'}
            onClick={() => setTab('translations')}
            count={data?._count?.translations}
          >
            <Globe className="w-3 h-3" /> {t('products.drawer.tabs.translations')}
          </DrawerTab>
          {/* U.32 — Pricing tab. Per-marketplace price summary +
              deep-link to /pricing?search=<sku>. The drawer is the
              per-product hub; until now operators had to leave it to
              see the price matrix. */}
          <DrawerTab
            active={tab === 'pricing'}
            onClick={() => setTab('pricing')}
          >
            <DollarSign className="w-3 h-3" /> {t('products.drawer.tabs.pricing')}
          </DrawerTab>
          <DrawerTab
            active={tab === 'related'}
            onClick={() => setTab('related')}
            count={data?._count?.relationsFrom}
          >
            <Network className="w-3 h-3" /> {t('products.drawer.tabs.related')}
          </DrawerTab>
          {/* U.30 — Activity is higher-traffic ("what changed?"); the
              Schedule tab is rare, only used after a bulk-schedule
              ran. Swapped so the daily tab sits closer to the
              center of the row. */}
          <DrawerTab
            active={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            <Activity className="w-3 h-3" /> {t('products.drawer.tabs.activity')}
          </DrawerTab>
          {/* F.3.c — pending scheduled changes for this product. */}
          <DrawerTab
            active={tab === 'schedule'}
            onClick={() => setTab('schedule')}
          >
            <Calendar className="w-3 h-3" /> {t('products.drawer.tabs.schedule')}
          </DrawerTab>
          {/* W3.6 — Wave 3 workflow tab. Current stage + transition
              controls + comment thread + transition history. Only
              meaningful when the product has a workflowStage; tab
              renders an "attach workflow" CTA when stageless. */}
          <DrawerTab
            active={tab === 'workflow'}
            onClick={() => setTab('workflow')}
          >
            <GitBranch className="w-3 h-3" /> {t('products.drawer.tabs.workflow')}
          </DrawerTab>
          </div>
          {/* Right-edge fade hints at scrollable overflow without
              competing for click space (pointer-events-none). */}
          <div className="pointer-events-none absolute top-0 bottom-px right-0 w-8 bg-gradient-to-l from-white dark:from-slate-900 to-transparent" />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && !data && (
            <div className="flex items-center justify-center py-12 text-slate-400 dark:text-slate-500 text-base">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          )}
          {error && (
            <div className="m-5 border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Failed to load: {error}</span>
            </div>
          )}
          {data && tab === 'details' && (
            <DetailsTab
              product={data}
              onSaved={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'listings' && (
            <ListingsTab
              listings={data.channelListings ?? []}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'variations' && data.isParent && (
            <VariationsTab
              parentId={data.id}
              parentSku={data.sku}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'images' && (
            <ImagesTab
              productId={data.id}
              images={data.images ?? []}
            />
          )}
          {data && tab === 'translations' && (
            <TranslationsTab
              productId={data.id}
              masterName={data.name}
              masterDescription={data.description ?? null}
              masterBullets={data.bulletPoints ?? []}
              masterKeywords={data.keywords ?? []}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'pricing' && (
            <PricingTab
              productId={data.id}
              sku={data.sku}
              basePrice={data.basePrice}
              channelListings={data.channelListings ?? []}
            />
          )}
          {data && tab === 'related' && (
            <RelatedTab
              productId={data.id}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'schedule' && <ScheduleTab productId={data.id} />}
          {data && tab === 'workflow' && <WorkflowTab productId={data.id} />}
          {data && tab === 'activity' && <ActivityTab productId={data.id} />}
        </div>

        {/* Footer */}
        {data && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 gap-3">
            <span className="text-sm text-slate-500 dark:text-slate-400 truncate">
              Updated {new Date(data.updatedAt).toLocaleString()}
            </span>
            <div className="flex items-center gap-3 flex-shrink-0">
              {/* F.6 — datasheet deep-link. Opens in a new tab so the
                  drawer + grid context isn't lost when the operator
                  prints / saves-as-PDF. */}
              <Link
                href={`/products/${data.id}/datasheet`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:underline"
              >
                Datasheet
              </Link>
              <Link
                href={`/products/${data.id}/edit`}
                className="inline-flex items-center gap-1 text-base font-medium text-blue-700 dark:text-blue-400 hover:underline"
              >
                Open full edit
                <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DrawerTab({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  count?: number | null
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn(
        // U.60 — whitespace-nowrap stops labels like "Translations"
        // wrapping to two lines when the drawer is at min width;
        // flex-shrink-0 keeps each tab's intrinsic width so the row
        // pushes into the parent's overflow-x-auto instead of
        // squishing.
        'inline-flex items-center gap-1.5 px-3 py-2.5 text-base font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0',
        active
          ? 'border-blue-500 text-blue-700'
          : 'border-transparent text-slate-600 hover:text-slate-900',
      )}
    >
      {children}
      {count != null && count > 0 && (
        <span className="text-xs text-slate-500 font-normal">{count}</span>
      )}
    </button>
  )
}

/**
 * P.18 — health rollup card. Score 0-100 with three-tone band
 * (≥80 emerald, ≥50 amber, else rose) plus a deduped issue list
 * grouped by severity. Issue rows show a small icon + the message
 * + (channel, marketplace) when present so per-listing problems
 * stay attributable.
 *
 * Read-only today. The "Quick fixes" the audit asked for are deferred
 * because each issue type maps to a different remediation surface
 * (AI fill for missing description, BulkImageUpload for no images,
 * AI suggest for brand/productType — already inline elsewhere). A
 * separate commit can add per-issue action buttons once the patterns
 * stabilise.
 */
function HealthCard({
  score,
  issues,
}: {
  score?: number
  issues: Array<{
    severity: 'error' | 'warning' | 'info'
    message: string
    channel?: string
    marketplace?: string
  }>
}) {
  const { t } = useTranslations()
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  const infos = issues.filter((i) => i.severity === 'info')

  // Three-tone score band. Mirrors the CoverageLens header's
  // emerald/amber/rose thresholds for visual consistency across
  // the workspace — operators learn one colour scale.
  const scoreTone =
    score == null
      ? 'text-slate-400'
      : score >= 80
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : score >= 50
      ? 'text-amber-700 bg-amber-50 border-amber-200'
      : 'text-rose-700 bg-rose-50 border-rose-200'

  return (
    <div className="border border-slate-200 rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          {t('products.drawer.health.title')}
        </div>
        {score != null && (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center h-6 px-2 rounded border text-base font-semibold tabular-nums',
                scoreTone,
              )}
              title={t('products.drawer.health.scoreTitle')}
            >
              {score}
              <span className="text-xs opacity-60 ml-0.5">{t('products.drawer.health.scoreSuffix')}</span>
            </span>
            <span className="text-sm text-slate-500 tabular-nums">
              {errors.length > 0 && (
                <span className="text-rose-700">
                  {t('products.drawer.health.abbr.errors', { count: errors.length })}
                </span>
              )}
              {errors.length > 0 && warnings.length > 0 && ' · '}
              {warnings.length > 0 && (
                <span className="text-amber-700">
                  {t('products.drawer.health.abbr.warnings', { count: warnings.length })}
                </span>
              )}
              {(errors.length > 0 || warnings.length > 0) &&
                infos.length > 0 &&
                ' · '}
              {infos.length > 0 && (
                <span className="text-slate-500">
                  {t('products.drawer.health.abbr.infos', { count: infos.length })}
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {issues.length === 0 ? (
        <div className="text-base text-slate-500 italic">
          {t('products.drawer.health.empty')}
        </div>
      ) : (
        <ul className="space-y-1">
          {[...errors, ...warnings, ...infos].map((i, idx) => {
            const tone =
              i.severity === 'error'
                ? 'text-rose-700'
                : i.severity === 'warning'
                ? 'text-amber-700'
                : 'text-slate-500'
            const Icon =
              i.severity === 'error'
                ? AlertCircle
                : i.severity === 'warning'
                ? AlertCircle
                : CheckCircle2
            return (
              <li
                key={idx}
                className={cn('flex items-start gap-1.5 text-base', tone)}
              >
                <Icon className="w-3 h-3 mt-0.5 flex-shrink-0" />
                <span className="min-w-0">
                  {i.message}
                  {(i.channel || i.marketplace) && (
                    <span className="text-slate-500 text-xs ml-1">
                      ({[i.channel, i.marketplace].filter(Boolean).join(' / ')})
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// U.5 — local StatusBadge replaced by the shared primitive (imported
// at module top). The local impl mapped INACTIVE → rose; the
// primitive uses STATUS_VARIANT (lib/theme) which renders INACTIVE
// as default-slate to match the grid's badge. Net result: one
// status→color source of truth across /products surfaces.

/* ─────────────────────────── tabs ─────────────────────────── */

function DetailsTab({
  product,
  onSaved,
}: {
  product: ProductDetail
  onSaved: () => void
}) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [basePrice, setBasePrice] = useState(
    product.basePrice != null ? String(Number(product.basePrice)) : '',
  )
  const [totalStock, setTotalStock] = useState(
    product.totalStock != null ? String(product.totalStock) : '',
  )
  const [threshold, setThreshold] = useState(
    product.lowStockThreshold != null ? String(product.lowStockThreshold) : '',
  )
  const [saving, setSaving] = useState<'basePrice' | 'totalStock' | 'threshold' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const save = useCallback(
    async (
      field: 'basePrice' | 'totalStock' | 'threshold',
      raw: string,
    ) => {
      setSaving(field)
      try {
        const body: Record<string, unknown> = {}
        if (field === 'basePrice') body.basePrice = Number(raw)
        else if (field === 'totalStock') body.totalStock = Number(raw)
        else body.lowStockThreshold = Number(raw)
        const res = await fetch(`${getBackendUrl()}/api/products/${product.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setSavedAt(Date.now())
        emitInvalidation({
          type: 'product.updated',
          id: product.id,
          fields: [field === 'threshold' ? 'lowStockThreshold' : field],
          meta: { source: 'product-drawer' },
        })
        if (field === 'basePrice' || field === 'totalStock') {
          emitInvalidation({
            type: 'listing.updated',
            meta: { productIds: [product.id], source: 'product-drawer', field },
          })
        }
        onSaved()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(null)
      }
    },
    [product.id, onSaved],
  )

  return (
    <div className="p-5 space-y-5">
      {/* Quick-edit row */}
      <div className="grid grid-cols-3 gap-3">
        <QuickField
          label={t('products.drawer.detail.basePrice')}
          value={basePrice}
          onChange={setBasePrice}
          onCommit={(v) => save('basePrice', v)}
          saving={saving === 'basePrice'}
          numeric
          prefix="€"
        />
        <QuickField
          label={t('products.drawer.detail.totalStock')}
          value={totalStock}
          onChange={setTotalStock}
          onCommit={(v) => save('totalStock', v)}
          saving={saving === 'totalStock'}
          numeric
        />
        <QuickField
          label={t('products.drawer.detail.lowStockThreshold')}
          value={threshold}
          onChange={setThreshold}
          onCommit={(v) => save('threshold', v)}
          saving={saving === 'threshold'}
          numeric
        />
      </div>
      {savedAt && (
        <div className="text-sm text-emerald-700">{t('products.drawer.detail.saved')}</div>
      )}

      {/* Master read-only summary */}
      <DetailGrid product={product} />

      {/* P.18 — Health card. Server-side scoring + issue list have
          existed since the /health endpoint shipped but the drawer
          never surfaced them; operators only saw issues by clicking
          into per-listing rows. Now they see a compact rollup at a
          glance + can scan the full list before deciding what to
          fix first. Read-only — quick-fix wiring is its own commit. */}
      {(product.score != null || (product.issues && product.issues.length > 0)) && (
        <HealthCard
          score={product.score}
          issues={product.issues ?? []}
        />
      )}

      {/* Description */}
      {product.description && (
        <div>
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
            {t('products.drawer.detail.description')}
          </div>
          <p className="text-base text-slate-700 whitespace-pre-line">
            {product.description}
          </p>
        </div>
      )}

      {/* H.12 — stock-out projection card. Pulls daysOfCover +
          stockoutDate + velocity from the F.4 forecast tables. */}
      <ForecastCard productId={product.id} />
    </div>
  )
}

function ForecastCard({ productId }: { productId: string }) {
  const { t } = useTranslations()
  const [projection, setProjection] = useState<{
    daysOfCover: number | null
    stockoutDate: string | null
    velocity: number | null
    urgency: string
    basis: string
    forecastDays: number
    totalStock: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/forecast`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setProjection(j)
      })
      .catch(() => {
        if (!cancelled) setProjection(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId])

  if (loading) {
    return (
      <div className="border border-slate-200 rounded-md p-3 text-sm text-slate-500 dark:text-slate-400 italic">
        <Loader2 className="w-3 h-3 animate-spin inline mr-1.5" /> {t('products.drawer.forecast.loading')}
      </div>
    )
  }
  if (!projection) return null

  const tone =
    projection.urgency === 'critical'
      ? { ring: 'border-rose-200 bg-rose-50/40', text: 'text-rose-700' }
      : projection.urgency === 'warn'
        ? { ring: 'border-amber-200 bg-amber-50/40', text: 'text-amber-700' }
        : projection.urgency === 'unknown'
          ? { ring: 'border-slate-200 bg-slate-50/40', text: 'text-slate-600' }
          : { ring: 'border-emerald-200 bg-emerald-50/40', text: 'text-emerald-700' }

  return (
    <div className={`border rounded-md p-3 ${tone.ring}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700">
          {t('products.drawer.forecast.title')}
        </div>
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${tone.text}`}
        >
          {t(`products.drawer.forecast.urgency.${projection.urgency}`)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wider text-xs">
            {t('products.drawer.forecast.daysOfCover')}
          </div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {projection.daysOfCover != null
              ? t('products.drawer.forecast.dayUnit', { count: projection.daysOfCover })
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wider text-xs">
            {t('products.drawer.forecast.velocity')}
          </div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {projection.velocity != null
              ? t('products.drawer.forecast.velocityUnit', { value: projection.velocity.toFixed(1) })
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wider text-xs">
            {t('products.drawer.forecast.stocksOut')}
          </div>
          <div className="text-base font-medium tabular-nums text-slate-900">
            {projection.stockoutDate
              ? new Date(projection.stockoutDate).toLocaleDateString()
              : '—'}
          </div>
        </div>
      </div>
      <div className="text-xs text-slate-500 mt-2 pt-2 border-t border-slate-200/50">
        {projection.basis === 'forecast'
          ? t('products.drawer.forecast.basis.forecast', { days: projection.forecastDays })
          : projection.basis === 'threshold'
            ? t('products.drawer.forecast.basis.threshold')
            : t('products.drawer.forecast.basis.none')}
      </div>
    </div>
  )
}

function DetailGrid({ product }: { product: ProductDetail }) {
  const { t } = useTranslations()
  // P.14 — AI suggest state. When either brand or productType is
  // empty, the operator can hit "Suggest with AI" to call
  // /api/products/:id/ai/suggest-fields. Suggestions surface inline
  // with [Apply] [Skip] buttons; Apply does a regular PATCH so the
  // existing optimistic-concurrency + cascade machinery handles it.
  const [suggesting, setSuggesting] = useState(false)
  const [suggestion, setSuggestion] = useState<{
    brand?: string
    productType?: string
    reasoning?: string
  } | null>(null)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [applying, setApplying] = useState<'brand' | 'productType' | null>(null)
  const [applied, setApplied] = useState<Set<'brand' | 'productType'>>(new Set())

  const needsBrand = !product.brand
  const needsType = !product.productType
  const canSuggest = needsBrand || needsType

  const runSuggest = async () => {
    setSuggesting(true)
    setSuggestError(null)
    setApplied(new Set())
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/ai/suggest-fields`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        suggestions: { brand?: string; productType?: string; reasoning?: string }
      }
      setSuggestion(json.suggestions)
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : String(e))
    } finally {
      setSuggesting(false)
    }
  }

  const apply = async (field: 'brand' | 'productType', value: string) => {
    setApplying(field)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      emitInvalidation({
        type: 'product.updated',
        id: product.id,
        fields: [field],
        meta: { source: 'drawer-ai-suggest-apply' },
      })
      setApplied((s) => new Set(s).add(field))
    } catch (e) {
      setSuggestError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(null)
    }
  }

  const fields: Array<{ label: string; value: React.ReactNode }> = [
    { label: t('products.drawer.detail.field.brand'), value: product.brand ?? <em className="text-slate-400">—</em> },
    { label: t('products.drawer.detail.field.type'), value: product.productType ?? <em className="text-slate-400">—</em> },
    { label: t('products.drawer.detail.field.fulfillment'), value: product.fulfillmentMethod ?? <em className="text-slate-400">—</em> },
    {
      label: t('products.drawer.detail.field.weight'),
      value:
        product.weightValue != null
          ? `${product.weightValue} ${product.weightUnit ?? ''}`.trim()
          : (<em className="text-slate-400">—</em>),
    },
    {
      label: t('products.drawer.detail.field.images'),
      value: (
        <span className="inline-flex items-center gap-1">
          <ImageIcon className="w-3 h-3 text-slate-400" />
          {product._count?.images ?? 0}
        </span>
      ),
    },
    {
      label: t('products.drawer.detail.field.listings'),
      value: (
        <span className="inline-flex items-center gap-1">
          <Boxes className="w-3 h-3 text-slate-400" />
          {product._count?.channelListings ?? 0}
        </span>
      ),
    },
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-base">
        {fields.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-2">
            <span className="text-slate-500 dark:text-slate-400">{f.label}</span>
            <span className="text-slate-900 dark:text-slate-100 text-right">{f.value}</span>
          </div>
        ))}
      </div>
      {/* P.14 — AI suggest CTA + inline result. Only renders when at
          least one of brand/productType is empty so a complete
          product doesn't see an irrelevant button. */}
      {canSuggest && (
        <div className="border border-purple-100 bg-purple-50/40 rounded-md p-2 space-y-2">
          {!suggestion && (
            <button
              type="button"
              onClick={runSuggest}
              disabled={suggesting}
              className="text-sm text-purple-700 hover:text-purple-900 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {suggesting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              {suggesting
                ? t('products.drawer.detail.ai.asking')
                : t(
                    needsBrand && needsType
                      ? 'products.drawer.detail.ai.suggest.both'
                      : needsBrand
                        ? 'products.drawer.detail.ai.suggest.brand'
                        : 'products.drawer.detail.ai.suggest.type',
                  )}
            </button>
          )}
          {suggestion && (
            <>
              <div className="text-xs uppercase tracking-wider text-purple-700 font-semibold">
                {t('products.drawer.detail.ai.heading')}
              </div>
              {suggestion.brand && needsBrand && (
                <div className="flex items-center justify-between gap-2 text-base">
                  <span className="text-slate-700">
                    {t('products.drawer.detail.ai.brandLabel')}<span className="font-medium">{suggestion.brand}</span>
                  </span>
                  {applied.has('brand') ? (
                    <span className="text-emerald-700 inline-flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> {t('products.drawer.detail.ai.applied')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => apply('brand', suggestion.brand!)}
                      disabled={applying === 'brand'}
                      className="text-sm text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {applying === 'brand' ? t('products.drawer.detail.ai.applying') : t('products.drawer.detail.ai.apply')}
                    </button>
                  )}
                </div>
              )}
              {suggestion.productType && needsType && (
                <div className="flex items-center justify-between gap-2 text-base">
                  <span className="text-slate-700">
                    {t('products.drawer.detail.ai.typeLabel')}<span className="font-medium">{suggestion.productType}</span>
                  </span>
                  {applied.has('productType') ? (
                    <span className="text-emerald-700 inline-flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> {t('products.drawer.detail.ai.applied')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => apply('productType', suggestion.productType!)}
                      disabled={applying === 'productType'}
                      className="text-sm text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {applying === 'productType' ? t('products.drawer.detail.ai.applying') : t('products.drawer.detail.ai.apply')}
                    </button>
                  )}
                </div>
              )}
              {suggestion.reasoning && (
                <div className="text-xs text-slate-500 italic">
                  {suggestion.reasoning}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setSuggestion(null)
                  setApplied(new Set())
                }}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                {t('products.drawer.detail.ai.dismiss')}
              </button>
            </>
          )}
          {suggestError && (
            <div className="text-xs text-rose-700">{suggestError}</div>
          )}
        </div>
      )}
    </div>
  )
}

function QuickField({
  label,
  value,
  onChange,
  onCommit,
  saving,
  numeric,
  prefix,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: (v: string) => void
  saving: boolean
  numeric?: boolean
  prefix?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div>
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-slate-500 pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type={numeric ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false)
            onCommit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
          className={cn(
            'w-full h-8 text-base border rounded-md bg-white focus:outline-none transition-colors',
            prefix ? 'pl-6 pr-2' : 'px-2',
            focused
              ? 'border-blue-300 ring-1 ring-blue-200'
              : 'border-slate-200',
            saving && 'opacity-60',
          )}
          disabled={saving}
        />
      </div>
    </div>
  )
}

function ListingsTab({
  listings,
  onChanged,
}: {
  listings: NonNullable<ProductDetail['channelListings']>
  /** Called after a successful resync so the parent refetches and
   *  the row's status pill flips to PENDING. */
  onChanged: () => void
}) {
  const { t } = useTranslations()
  const grouped = useMemo(() => {
    const map = new Map<string, typeof listings>()
    for (const l of listings) {
      const arr = map.get(l.channel) ?? []
      arr.push(l)
      map.set(l.channel, arr)
    }
    return Array.from(map.entries())
  }, [listings])

  // P.11 — per-listing sync state. Tracks the listing currently being
  // resynced + any per-listing error so the row can show inline
  // feedback without an alert(). Only one resync at a time per drawer
  // open — operators don't typically need to fan out from here, the
  // dashboard's bulk surface handles that.
  const [resyncing, setResyncing] = useState<string | null>(null)
  const [resyncError, setResyncError] = useState<{
    listingId: string
    message: string
  } | null>(null)
  // P.12 — same shape for the "Snap to master" action. Calls
  // /api/listings/bulk-action with action='follow-master' for a
  // single listing id, which flips every followMaster* flag back to
  // true. Next sync tick resets the listing's local values to the
  // master snapshots.
  const [snapping, setSnapping] = useState<string | null>(null)
  const [snapError, setSnapError] = useState<{
    listingId: string
    message: string
  } | null>(null)

  const snapToMaster = async (listingId: string) => {
    setSnapping(listingId)
    setSnapError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'follow-master',
          listingIds: [listingId],
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      emitInvalidation({
        type: 'listing.updated',
        id: listingId,
        meta: { source: 'drawer-listings-snap-to-master' },
      })
      onChanged()
    } catch (e) {
      setSnapError({
        listingId,
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSnapping(null)
    }
  }

  const resync = async (listingId: string) => {
    setResyncing(listingId)
    setResyncError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/${listingId}/resync`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      // Tell the rest of the app this listing is in a new state so
      // the dashboard health card and any other open tabs refresh.
      emitInvalidation({
        type: 'listing.updated',
        id: listingId,
        meta: { source: 'drawer-listings-resync' },
      })
      onChanged()
    } catch (e) {
      setResyncError({
        listingId,
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setResyncing(null)
    }
  }

  if (listings.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-base text-slate-500">
        <Boxes className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        {t('products.drawer.listings.empty')}
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t('products.drawer.listings.emptyHint')}
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-4">
      {grouped.map(([channel, rows]) => (
        <section key={channel}>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {channel}
          </div>
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-base">
              <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 text-left">{t('products.drawer.listings.col.market')}</th>
                  <th className="px-3 py-1.5 text-left">{t('products.drawer.listings.col.status')}</th>
                  <th className="px-3 py-1.5 text-right">{t('products.drawer.listings.col.price')}</th>
                  <th className="px-3 py-1.5 text-right">{t('products.drawer.listings.col.qty')}</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  // F9 — drift detection. masterPrice/Quantity are
                  // the snapshots Phase 13 maintains. A divergence
                  // when followMaster* is false means the seller has
                  // a per-marketplace override that's drifted from
                  // master.
                  const priceDrift =
                    l.followMasterPrice === false &&
                    l.masterPrice != null &&
                    l.price != null &&
                    Number(l.masterPrice) !== Number(l.price)
                  const qtyDrift =
                    l.followMasterQuantity === false &&
                    l.masterQuantity != null &&
                    l.quantity != null &&
                    Number(l.masterQuantity) !== Number(l.quantity)
                  // P.11 — surface the last sync timestamp + error
                  // inline so triage doesn't need a navigation. Falls
                  // back to em-dash when the listing has never synced.
                  const isResyncing = resyncing === l.id
                  const cellResyncErr =
                    resyncError?.listingId === l.id ? resyncError : null
                  // P.12 — any followMaster=false flag means there's
                  // an active per-listing override, even if the value
                  // happens to match master right now (DRIFT only
                  // fires on actual divergence). Show a subtle
                  // OVERRIDE pill alongside DRIFT so the operator
                  // knows the listing is in manual mode.
                  const hasOverride =
                    l.followMasterPrice === false ||
                    l.followMasterQuantity === false
                  const isSnapping = snapping === l.id
                  const cellSnapErr =
                    snapError?.listingId === l.id ? snapError : null
                  return (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 align-top">
                      {l.marketplace}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ListingStatusBadge
                        listingStatus={l.listingStatus}
                        lastSyncStatus={l.lastSyncStatus}
                      />
                      {(priceDrift || qtyDrift) && (
                        <span
                          className="ml-1 inline-flex items-center h-5 px-1.5 rounded text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200"
                          title={
                            priceDrift && qtyDrift
                              ? t('products.drawer.listings.driftTitle.both')
                              : priceDrift
                              ? t('products.drawer.listings.driftTitle.price', {
                                  price: Number(l.price).toFixed(2),
                                  master: Number(l.masterPrice).toFixed(2),
                                })
                              : t('products.drawer.listings.driftTitle.qty', {
                                  qty: l.quantity ?? 0,
                                  master: l.masterQuantity ?? 0,
                                })
                          }
                        >
                          {t('products.drawer.listings.drift')}
                        </span>
                      )}
                      {/* P.12 — OVERRIDE pill. Shows whenever any
                          followMaster=false even if values match;
                          DRIFT is the subset that has actual
                          divergence. Lets the operator distinguish
                          "deliberately overridden, currently equal"
                          from "deliberately overridden AND drifted". */}
                      {hasOverride && !priceDrift && !qtyDrift && (
                        <span
                          className="ml-1 inline-flex items-center h-5 px-1.5 rounded text-xs font-medium bg-blue-50 text-blue-800 border border-blue-200"
                          title={
                            l.followMasterPrice === false &&
                            l.followMasterQuantity === false
                              ? t('products.drawer.listings.overrideTitle.both')
                              : l.followMasterPrice === false
                              ? t('products.drawer.listings.overrideTitle.price')
                              : t('products.drawer.listings.overrideTitle.qty')
                          }
                        >
                          {t('products.drawer.listings.override')}
                        </span>
                      )}
                      {/* P.11 — last sync timestamp + error visibility.
                          The badge already encodes status; this surfaces
                          the WHEN and the WHY so triage doesn't need to
                          open the dedicated /listings/<id> page. */}
                      <div className="text-xs text-slate-500 mt-1">
                        {l.lastSyncedAt
                          ? t('products.drawer.listings.synced', { when: new Date(l.lastSyncedAt).toLocaleString() })
                          : t('products.drawer.listings.notSynced')}
                      </div>
                      {l.lastSyncError && l.lastSyncStatus === 'FAILED' && (
                        <div
                          className="text-xs text-rose-700 mt-0.5 truncate max-w-[200px]"
                          title={l.lastSyncError}
                        >
                          {l.lastSyncError}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums align-top">
                      {l.price != null ? `€${Number(l.price).toFixed(2)}` : '—'}
                      {priceDrift && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          {t('products.drawer.listings.masterPrice', { price: Number(l.masterPrice).toFixed(2) })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums align-top">
                      {l.quantity ?? '—'}
                      {qtyDrift && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          {t('products.drawer.listings.masterQty', { qty: l.masterQuantity ?? 0 })}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right align-top">
                      <div className="inline-flex items-center gap-2 flex-wrap justify-end">
                        {/* P.11 — Sync now action. Calls
                            POST /api/listings/:id/resync which flips
                            the row to PENDING + resets retryCount; the
                            BullMQ worker picks it up next tick. The
                            row's status pill flips to PENDING after
                            the parent's onChanged() refetch. */}
                        <button
                          type="button"
                          onClick={() => resync(l.id)}
                          disabled={isResyncing}
                          title={t('products.drawer.listings.resyncTitle')}
                          className="text-sm text-slate-500 hover:text-blue-700 disabled:opacity-50 inline-flex items-center gap-0.5"
                        >
                          {isResyncing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3" />
                          )}
                          {isResyncing
                            ? t('products.drawer.listings.queuing')
                            : t('products.drawer.listings.syncNow')}
                        </button>
                        {/* P.12 — Snap to master. Only shown when the
                            listing has at least one active override.
                            Flips every followMaster* flag back to true
                            via /api/listings/bulk-action. The next
                            sync tick will reset values to the master
                            snapshots. Single-button, no confirm — the
                            action is reversible (operator can
                            re-override any field) and the listing
                            stays in PENDING for ~5min before push. */}
                        {hasOverride && (
                          <button
                            type="button"
                            onClick={() => snapToMaster(l.id)}
                            disabled={isSnapping}
                            title={t('products.drawer.listings.snapTitle')}
                            className="text-sm text-amber-700 hover:text-amber-900 disabled:opacity-50 inline-flex items-center gap-0.5"
                          >
                            {isSnapping ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : null}
                            {isSnapping
                              ? t('products.drawer.listings.snapping')
                              : t('products.drawer.listings.snap')}
                          </button>
                        )}
                        <Link
                          href={`/listings/${l.id}`}
                          className="text-sm text-blue-700 hover:underline inline-flex items-center gap-0.5"
                        >
                          {t('products.drawer.listings.open')} <ChevronRight className="w-3 h-3" />
                        </Link>
                      </div>
                      {cellResyncErr && (
                        <div className="text-xs text-rose-700 mt-1 max-w-[200px] truncate" title={cellResyncErr.message}>
                          {cellResyncErr.message}
                        </div>
                      )}
                      {cellSnapErr && (
                        <div className="text-xs text-rose-700 mt-1 max-w-[200px] truncate" title={cellSnapErr.message}>
                          {cellSnapErr.message}
                        </div>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}

function ListingStatusBadge({
  listingStatus,
  lastSyncStatus,
}: {
  listingStatus: string
  lastSyncStatus: string | null
}) {
  const { t } = useTranslations()
  const failed = lastSyncStatus === 'FAILED'
  const tone = failed
    ? 'bg-rose-50 text-rose-700'
    : listingStatus === 'ACTIVE'
    ? 'bg-emerald-50 text-emerald-700'
    : listingStatus === 'DRAFT'
    ? 'bg-slate-100 text-slate-600'
    : 'bg-amber-50 text-amber-700'
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-xs font-medium',
        tone,
      )}
    >
      {failed ? t('products.drawer.listings.syncFailed') : listingStatus}
    </span>
  )
}

/**
 * Activity tab (F3) — AuditLog timeline for the product.
 *
 * Reads GET /api/products/:id/activity (ETag-cached). Each row is a
 * slim before/after diff captured by AuditLogService writers
 * (PATCH /api/products/:id, PATCH /api/products/bulk, the master-
 * data services, etc.). Bulk operations also write per-row Product
 * audit rows; metadata.bulkOperationId is shown so users can
 * trace a change back to the bulk job that emitted it.
 */
interface ActivityEntry {
  id: string
  action: string
  userId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

/**
 * W3.6 — Workflow tab. Current stage chip + transition dropdown +
 * comment thread + last 10 transitions. Falls back to "no workflow"
 * empty state when the product has no workflowStage (the operator
 * can attach a workflow via the family editor or the bulk modal).
 */
interface WorkflowSnapshot {
  productId: string
  sku: string
  currentStage: {
    id: string
    code: string
    label: string
    slaHours: number | null
    isPublishable: boolean
    isInitial: boolean
    isTerminal: boolean
    workflowId: string
    workflow: {
      id: string
      code: string
      label: string
      stages: Array<{ id: string; code: string; label: string; sortOrder: number; isPublishable: boolean; isTerminal: boolean }>
    }
  } | null
  sla: {
    state: 'on_track' | 'soon' | 'overdue' | 'no_sla'
    dueAt: string | null
    hoursRemaining: number | null
  } | null
  transitions: Array<{
    id: string
    fromStage: { id: string; code: string; label: string } | null
    toStage: { id: string; code: string; label: string }
    comment: string | null
    createdAt: string
  }>
  comments: Array<{
    id: string
    body: string
    createdAt: string
    stage: { id: string; code: string; label: string }
  }>
}

const SLA_TONE: Record<string, string> = {
  on_track: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  soon: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  overdue: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  no_sla: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

function WorkflowTab({ productId }: { productId: string }) {
  const { t } = useTranslations()
  const [snap, setSnap] = useState<WorkflowSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const [moveComment, setMoveComment] = useState('')
  const [commenting, setCommenting] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const { toast } = useToast()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/workflow`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as WorkflowSnapshot
      setSnap(data)
      setErr(null)
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const moveStage = async () => {
    if (!moveTo) return
    setMoving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/workflow/move`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toStageId: moveTo,
            comment: moveComment.trim() || null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setMoveTo('')
      setMoveComment('')
      await refresh()
      toast.success(t('products.drawer.workflow.toast.moved'))
    } catch (e: any) {
      toast.error(t('products.drawer.workflow.toast.moveFailed', { msg: e?.message ?? String(e) }))
    } finally {
      setMoving(false)
    }
  }

  const addComment = async () => {
    if (!snap?.currentStage || !commentBody.trim()) return
    setCommenting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/workflow/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stageId: snap.currentStage.id,
            body: commentBody.trim(),
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setCommentBody('')
      await refresh()
    } catch (e: any) {
      toast.error(t('products.drawer.workflow.toast.commentFailed', { msg: e?.message ?? String(e) }))
    } finally {
      setCommenting(false)
    }
  }

  if (loading) {
    return (
      <div className="p-4 text-base text-slate-500 dark:text-slate-400">
        {t('products.drawer.workflow.loading')}
      </div>
    )
  }
  if (err) {
    return (
      <div className="p-4 text-base text-rose-700 dark:text-rose-300">{err}</div>
    )
  }
  if (!snap?.currentStage) {
    return (
      <div className="p-6 text-center">
        <GitBranch className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
        <div className="text-md text-slate-700 dark:text-slate-300">
          {t('products.drawer.workflow.empty.title')}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
          {t('products.drawer.workflow.empty.body')}
        </div>
      </div>
    )
  }

  const stage = snap.currentStage
  const otherStages = stage.workflow.stages.filter((s) => s.id !== stage.id)

  return (
    <div className="p-4 space-y-5">
      {/* Current stage card */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3 bg-slate-50/50 dark:bg-slate-900/40">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          {t('products.drawer.workflow.currentStage')} · {stage.workflow.label}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-base font-medium bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded">
            {stage.label}
          </span>
          {stage.isInitial && (
            <span className="text-xs text-slate-500 dark:text-slate-400 italic">{t('products.drawer.workflow.tag.initial')}</span>
          )}
          {stage.isTerminal && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300 italic">{t('products.drawer.workflow.tag.terminal')}</span>
          )}
          {stage.isPublishable && (
            <span className="text-xs text-amber-700 dark:text-amber-300 italic">{t('products.drawer.workflow.tag.publishable')}</span>
          )}
          {snap.sla && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded font-medium ${SLA_TONE[snap.sla.state]}`}
              title={
                snap.sla.dueAt
                  ? t('products.drawer.workflow.sla.due', { when: new Date(snap.sla.dueAt).toLocaleString() })
                  : t('products.drawer.workflow.sla.none')
              }
            >
              {snap.sla.state === 'no_sla'
                ? t('products.drawer.workflow.sla.noSla')
                : snap.sla.state === 'overdue'
                ? t('products.drawer.workflow.sla.overdue', { hours: Math.abs(Math.round(snap.sla.hoursRemaining ?? 0)) })
                : t('products.drawer.workflow.sla.left', { hours: Math.round(snap.sla.hoursRemaining ?? 0) })}
            </span>
          )}
        </div>
      </div>

      {/* Move stage controls */}
      {otherStages.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            {t('products.drawer.workflow.moveTo')}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="flex-1 h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">{t('products.drawer.workflow.movePicker')}</option>
              {otherStages
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.isTerminal ? t('products.drawer.workflow.moveSuffix.terminal') : ''}
                    {s.isPublishable ? t('products.drawer.workflow.moveSuffix.publishable') : ''}
                  </option>
                ))}
            </select>
            <Button
              variant="primary"
              size="sm"
              onClick={moveStage}
              disabled={!moveTo}
              loading={moving}
              icon={<Send className="w-3 h-3" />}
            >
              {t('products.drawer.workflow.move')}
            </Button>
          </div>
          <input
            type="text"
            value={moveComment}
            onChange={(e) => setMoveComment(e.target.value)}
            placeholder={t('products.drawer.workflow.movePlaceholder')}
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
      )}

      {/* Comment thread (current stage) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {t('products.drawer.workflow.commentsOn', { stage: stage.label })}
        </div>
        <div className="space-y-1.5">
          {snap.comments
            .filter((c) => c.stage.id === stage.id)
            .slice(0, 10)
            .map((c) => (
              <div
                key={c.id}
                className="border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 text-base text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900"
              >
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-0.5 tabular-nums">
                  {new Date(c.createdAt).toLocaleString()}
                </div>
                {c.body}
              </div>
            ))}
          {snap.comments.filter((c) => c.stage.id === stage.id).length === 0 && (
            <div className="text-sm italic text-slate-500 dark:text-slate-400">
              {t('products.drawer.workflow.commentsEmpty')}
            </div>
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            rows={2}
            placeholder={t('products.drawer.workflow.commentPlaceholder')}
            className="flex-1 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={addComment}
            disabled={!commentBody.trim()}
            loading={commenting}
          >
            {t('products.drawer.workflow.post')}
          </Button>
        </div>
      </div>

      {/* Transition history */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {t('products.drawer.workflow.history')}
        </div>
        {snap.transitions.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400">
            {t('products.drawer.workflow.historyEmpty')}
          </div>
        ) : (
          <ul className="space-y-1">
            {snap.transitions.slice(0, 10).map((tr) => (
              <li
                key={tr.id}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
              >
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums w-32 flex-shrink-0">
                  {new Date(tr.createdAt).toLocaleString()}
                </span>
                <span className="truncate">
                  {tr.fromStage ? (
                    <>
                      <span className="text-slate-500 dark:text-slate-400">{tr.fromStage.label}</span>
                      <span className="mx-1 text-slate-400 dark:text-slate-500">→</span>
                    </>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400 italic mr-1">{t('products.drawer.workflow.entry')}</span>
                  )}
                  <span className="text-slate-900 dark:text-slate-100">{tr.toStage.label}</span>
                  {tr.comment && (
                    <span className="ml-2 text-slate-500 dark:text-slate-400 italic">
                      "{tr.comment}"
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ActivityTab({ productId }: { productId: string }) {
  const { t } = useTranslations()
  const [items, setItems] = useState<ActivityEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/activity?limit=100`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setItems(json.items ?? [])
        setTotal(json.total ?? 0)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    return () => {
      cancelled = true
    }
  }, [productId])

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400 text-base">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('products.drawer.activity.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>{t('products.drawer.activity.failed', { error })}</span>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-base text-slate-500">
        <Activity className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        {t('products.drawer.activity.empty')}
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t('products.drawer.activity.emptyHint')}
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-3">
      {total > items.length && (
        <div className="text-sm text-slate-500">
          {t('products.drawer.activity.showing', { shown: items.length, total })}
        </div>
      )}
      <ol className="space-y-2">
        {items.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ol>
    </div>
  )
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const { t } = useTranslations()
  const diff = useMemo(() => buildDiff(entry.before, entry.after), [entry.before, entry.after])
  const actor = entry.userId ?? 'system'
  const bulkOpId =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).bulkOperationId
      : null
  const source =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).source
      : null
  const reason =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).reason
      : null

  return (
    <li className="border border-slate-200 rounded-md bg-white px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-sm text-slate-500">
        <span>
          <span className="font-semibold text-slate-700 capitalize">{entry.action}</span>
          {' · '}
          <span className="font-mono">{actor}</span>
          {(source || reason) ? (
            <span className="text-slate-400 ml-1">
              ({String(source ?? reason)})
            </span>
          ) : null}
        </span>
        <time dateTime={entry.createdAt} className="font-mono">
          {new Date(entry.createdAt).toLocaleString()}
        </time>
      </div>
      {diff.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-base">
          {diff.map((d) => (
            <li key={d.field} className="flex items-baseline gap-2">
              <span className="text-slate-500 font-mono text-sm flex-shrink-0">
                {d.field}
              </span>
              <span className="text-rose-700 line-through">{formatValue(d.before)}</span>
              <span className="text-slate-400">→</span>
              <span className="text-emerald-700">{formatValue(d.after)}</span>
            </li>
          ))}
        </ul>
      )}
      {typeof bulkOpId === 'string' && (
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {t('products.drawer.activity.viaBulk')} <span className="font-mono">{bulkOpId.slice(0, 12)}…</span>
        </div>
      )}
    </li>
  )
}

interface DiffEntry {
  field: string
  before: unknown
  after: unknown
}

function buildDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffEntry[] {
  // Slim diffs from the writers: before/after are usually
  // single-key objects (e.g. { basePrice: 100 } → { basePrice: 105 }).
  // For bulk-edit per-row entries, after is { field, value }; we
  // surface those too.
  const out: DiffEntry[] = []
  const keys = new Set<string>()
  if (before && typeof before === 'object') for (const k of Object.keys(before)) keys.add(k)
  if (after && typeof after === 'object') for (const k of Object.keys(after)) keys.add(k)
  // Special case: bulk-patch writers store after = { field, value }.
  // Surface that as a single diff entry keyed by the field name.
  if (
    after &&
    typeof after === 'object' &&
    'field' in after &&
    'value' in after
  ) {
    const a = after as { field: unknown; value: unknown }
    if (typeof a.field === 'string') {
      return [{ field: a.field, before: undefined, after: a.value }]
    }
  }
  for (const k of keys) {
    out.push({
      field: k,
      before: before?.[k],
      after: after?.[k],
    })
  }
  return out
}

function formatValue(v: unknown): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const json = JSON.stringify(v)
    return json.length > 60 ? `${json.slice(0, 60)}…` : json
  } catch {
    return String(v)
  }
}

// ────────────────────────────────────────────────────────────────────
// VariationsTab (P.8) — child Products of a parent, with quick-edit
// ────────────────────────────────────────────────────────────────────
/**
 * F.3.c — pending / applied scheduled changes for this product.
 *
 * Reads GET /api/products/:id/scheduled-changes (returns up to 100
 * rows, ordered by scheduledFor asc). Operator sees what's queued
 * for this SKU and can cancel any PENDING row in one click.
 *
 * No "schedule a new change" form here — that flow lives on the
 * BulkActionBar's Schedule modal where the operator can target N
 * products at once. Coming back here from the bulk flow is the
 * verification step.
 */
interface ScheduledChange {
  id: string
  productId: string
  kind: string
  payload: Record<string, unknown>
  scheduledFor: string
  status: string
  appliedAt: string | null
  error: string | null
  createdBy: string | null
  createdAt: string
}

function ScheduleTab({ productId }: { productId: string }) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [rows, setRows] = useState<ScheduledChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/scheduled-changes`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setRows(j.changes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const cancel = async (id: string) => {
    setCancelling(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/scheduled-changes/${id}/cancel`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.drawer.schedule.toast.cancelled'))
      refresh()
    } catch (e) {
      toast.error(
        t('products.drawer.schedule.toast.cancelFailed', { msg: e instanceof Error ? e.message : String(e) }),
      )
    } finally {
      setCancelling(null)
    }
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400 text-base"
      >
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('products.drawer.schedule.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div
        role="alert"
        aria-atomic="true"
        className="m-5 border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300"
      >
        {t('products.drawer.schedule.failed', { error })}
      </div>
    )
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="px-5 py-12 text-center text-base text-slate-500 dark:text-slate-400">
        <Calendar className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
        {t('products.drawer.schedule.empty')}
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t('products.drawer.schedule.emptyHint')}
        </div>
      </div>
    )
  }

  const renderPayload = (kind: string, payload: Record<string, unknown>) => {
    if (kind === 'STATUS') {
      const status = payload.status as string | undefined
      return (
        <span>
          {t('products.drawer.schedule.payload.setStatus')}{' '}
          <span className="font-mono font-semibold">{status ?? '—'}</span>
        </span>
      )
    }
    if (kind === 'PRICE') {
      if (typeof payload.basePrice === 'number') {
        return (
          <span>
            {t('products.drawer.schedule.payload.setBasePrice')}{' '}
            <span className="font-mono font-semibold tabular-nums">
              €{payload.basePrice.toFixed(2)}
            </span>
          </span>
        )
      }
      if (typeof payload.adjustPercent === 'number') {
        const v = payload.adjustPercent
        return (
          <span>
            {t('products.drawer.schedule.payload.adjustBasePrice')}{' '}
            <span className="font-mono font-semibold tabular-nums">
              {v >= 0 ? '+' : ''}
              {v}%
            </span>
          </span>
        )
      }
    }
    return <span className="font-mono text-xs">{JSON.stringify(payload)}</span>
  }

  const statusTone = (s: string) => {
    if (s === 'PENDING')
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
    if (s === 'APPLIED')
      return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
    if (s === 'FAILED')
      return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
    if (s === 'CANCELLED')
      return 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800'
    return 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800'
  }
  const statusIcon = (s: string) => {
    if (s === 'PENDING') return <Clock size={11} />
    if (s === 'APPLIED') return <CheckCircle2 size={11} />
    if (s === 'FAILED') return <AlertCircle size={11} />
    if (s === 'CANCELLED') return <XCircle size={11} />
    return null
  }

  return (
    <div className="px-5 py-4 space-y-2">
      <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        {t(
          rows.length === 1
            ? 'products.drawer.schedule.count.one'
            : 'products.drawer.schedule.count.other',
          { count: rows.length },
        )}
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.id}
            className="border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-base bg-white dark:bg-slate-900"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider border rounded ${statusTone(r.status)}`}
              >
                {statusIcon(r.status)}
                {r.status}
              </span>
              <span className="text-slate-900 dark:text-slate-100">
                {renderPayload(r.kind, r.payload)}
              </span>
              {r.status === 'PENDING' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cancel(r.id)}
                  loading={cancelling === r.id}
                  icon={cancelling === r.id ? undefined : <X size={11} />}
                  className="ml-auto !h-7 !px-2 !text-sm !text-rose-600 hover:!bg-rose-50 dark:hover:!bg-rose-950/40"
                >
                  {t('products.drawer.schedule.cancel')}
                </Button>
              )}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 inline-flex items-center gap-2 flex-wrap">
              <Clock size={11} />
              <span>
                {t(
                  r.status === 'PENDING'
                    ? 'products.drawer.schedule.scheduledFor'
                    : 'products.drawer.schedule.wasScheduledFor',
                )}{' '}
                <span className="text-slate-700 dark:text-slate-300 font-medium">
                  {new Date(r.scheduledFor).toLocaleString()}
                </span>
              </span>
              {r.appliedAt && (
                <>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span>
                    {t(
                      r.status === 'APPLIED'
                        ? 'products.drawer.schedule.appliedAt'
                        : 'products.drawer.schedule.resolvedAt',
                    )}{' '}
                    {new Date(r.appliedAt).toLocaleString()}
                  </span>
                </>
              )}
            </div>
            {r.error && (
              <div className="mt-1.5 text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded px-2 py-1">
                {r.error}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * U.32 — Images tab. Renders the product's existing image set as a
 * clickable thumbnail grid + a deep-link to the full image manager
 * at /products/[id]/images for drag-reorder, scope picker, and bulk
 * upload. Operators get a one-glance check of which photos exist
 * without leaving the drawer.
 *
 * "MAIN" tag pins to the first slot (the primary product photo);
 * other types render the type label as an overlay so the operator
 * can tell ALT vs LIFESTYLE shots at a glance.
 */
function ImagesTab({
  productId,
  images,
}: {
  productId: string
  images: Array<{ url: string; type: string | null }>
}) {
  const { t } = useTranslations()
  if (images.length === 0) {
    return (
      <div className="px-5 py-12 text-center text-base text-slate-500 dark:text-slate-400">
        <ImageIcon className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
        {t('products.drawer.images.empty')}
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t('products.drawer.images.emptyHint')}
        </div>
        <div className="mt-3">
          <Link
            href={`/products/${productId}/images`}
            className="h-8 px-3 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
          >
            <ExternalLink size={11} /> {t('products.drawer.images.openManager')}
          </Link>
        </div>
      </div>
    )
  }
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {t(
            images.length === 1
              ? 'products.drawer.images.count.one'
              : 'products.drawer.images.count.other',
            { count: images.length },
          )}
        </div>
        <Link
          href={`/products/${productId}/images`}
          className="h-7 px-2.5 text-sm border border-slate-200 dark:border-slate-800 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
        >
          <ExternalLink size={11} /> {t('products.drawer.images.manage')}
        </Link>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {images.map((img, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <div
            key={`${img.url}-${i}`}
            className="relative aspect-square rounded border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-800"
          >
            <img
              src={img.url}
              alt=""
              className="w-full h-full object-cover"
            />
            {img.type && img.type !== 'ALT' && (
              <span className="absolute top-1 left-1 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-slate-900/80 text-white rounded">
                {img.type}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
        {t('products.drawer.images.footer')}
      </div>
    </div>
  )
}

/**
 * U.32 — Pricing tab. Per-marketplace summary of the current
 * channel listing prices vs the master basePrice + a deep-link to
 * /pricing?search=<sku> for the full matrix (rules, overrides,
 * clamps, history, push). Drawer is the per-product hub; this tab
 * surfaces the read-side without making the operator navigate
 * elsewhere first.
 */
function PricingTab({
  productId,
  sku,
  basePrice,
  channelListings,
}: {
  productId: string
  sku: string
  basePrice: string | number | null
  channelListings: NonNullable<ProductDetail['channelListings']>
}) {
  const { t } = useTranslations()
  const baseNum = basePrice == null ? null : Number(basePrice)
  const sorted = [...channelListings].sort((a, b) => {
    if (a.channel !== b.channel) return a.channel.localeCompare(b.channel)
    return a.marketplace.localeCompare(b.marketplace)
  })

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            {t('products.drawer.pricing.master')}
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {baseNum == null ? '—' : `€${baseNum.toFixed(2)}`}
          </div>
        </div>
        <div className="ml-auto">
          <Link
            href={`/pricing?search=${encodeURIComponent(sku)}`}
            className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-800 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
            title={t('products.drawer.pricing.openMatrixTitle')}
          >
            <ExternalLink size={11} /> {t('products.drawer.pricing.openMatrix')}
          </Link>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md py-8 text-center text-base text-slate-500 dark:text-slate-400 italic">
          {t('products.drawer.pricing.empty')}
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('products.drawer.pricing.col.channel')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('products.drawer.pricing.col.marketplace')}
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('products.drawer.pricing.col.listingPrice')}
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('products.drawer.pricing.col.deltaVsMaster')}
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  {t('products.drawer.pricing.col.status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => {
                const price = l.price == null ? null : Number(l.price)
                const delta =
                  baseNum == null || price == null ? null : price - baseNum
                const tone =
                  delta == null
                    ? 'text-slate-400 dark:text-slate-500'
                    : Math.abs(delta) < 0.01
                      ? 'text-slate-500 dark:text-slate-400'
                      : delta > 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                return (
                  <tr
                    key={l.id}
                    className="border-b border-slate-100 dark:border-slate-800 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <td className="px-3 py-2 text-slate-900 dark:text-slate-100 font-medium">
                      {l.channel}
                    </td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300 font-mono text-sm">
                      {l.marketplace}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      {price == null ? '—' : `€${price.toFixed(2)}`}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${tone}`}>
                      {delta == null
                        ? '—'
                        : Math.abs(delta) < 0.01
                          ? '0.00'
                          : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider rounded ${
                          l.listingStatus === 'ACTIVE' && l.isPublished
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                            : l.listingStatus === 'DRAFT'
                              ? 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800'
                              : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                        }`}
                      >
                        {l.listingStatus}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-sm text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
        {t('products.drawer.pricing.footer')}
      </div>
      {/* W4.13 — Tier / customer-group pricing for this product.
          Sits between the master listings and the repricing rules
          because it's a pure-pricing concern (volume + segment),
          while repricing is a market-reactive concern. */}
      <TierPricingSection productId={productId} basePrice={baseNum} />

      {/* W4.9 — Repricing rules per (channel, marketplace) for this
          product. Sub-section, not a separate drawer tab, because
          repricing is part of the pricing story. */}
      <RepricingRulesSection
        productId={productId}
        channelListings={channelListings}
      />
    </div>
  )
}

/**
 * W4.13 — Tier pricing section.
 *
 * Sub-component of PricingTab. Lists ProductTierPrice rows for this
 * product (volume / customer-group discounts) + a compute-price
 * preview ("what would a wholesale buyer pay for 50?").
 *
 * Add-tier flow uses an inline form (no modal) — tier rows are
 * compact + the operator typically adds 2-5 rows in a row when
 * setting up a B2B price ladder, so a modal would feel heavy.
 */
interface TierPriceRow {
  id: string
  minQty: number
  price: string
  customerGroupId: string | null
  customerGroup: { id: string; code: string; label: string } | null
}

interface CustomerGroupOpt {
  id: string
  code: string
  label: string
}

function TierPricingSection({
  productId,
  basePrice,
}: {
  productId: string
  basePrice: number | null
}) {
  const { t } = useTranslations()
  const [tiers, setTiers] = useState<TierPriceRow[] | null>(null)
  const [groups, setGroups] = useState<CustomerGroupOpt[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [previewQty, setPreviewQty] = useState('')
  const [previewGroupId, setPreviewGroupId] = useState<string>('')
  const [previewResult, setPreviewResult] = useState<{
    price: number
    source: 'base' | 'tier'
    appliedTier: { minQty: number; customerGroupId: string | null } | null
  } | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()

  const refresh = useCallback(async () => {
    try {
      const [t, g] = await Promise.all([
        fetch(`${getBackendUrl()}/api/products/${productId}/tier-prices`, {
          cache: 'no-store',
        }),
        fetch(`${getBackendUrl()}/api/customer-groups`, { cache: 'no-store' }),
      ])
      if (!t.ok) throw new Error(`tiers HTTP ${t.status}`)
      if (!g.ok) throw new Error(`groups HTTP ${g.status}`)
      const tdata = (await t.json()) as { tierPrices?: TierPriceRow[] }
      const gdata = (await g.json()) as { groups?: CustomerGroupOpt[] }
      setTiers(tdata.tierPrices ?? [])
      setGroups(gdata.groups ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [productId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onDelete = async (tier: TierPriceRow) => {
    const ok = await confirm({
      title: t('products.drawer.tier.deleteTitle', {
        qty: tier.minQty,
        groupSuffix: tier.customerGroup ? ` (${tier.customerGroup.label})` : '',
      }),
      confirmLabel: t('products.drawer.tier.deleteLabel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/tier-prices/${tier.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t('products.drawer.tier.toast.deleted'))
      refresh()
    } catch (e: any) {
      toast.error(t('products.drawer.tier.toast.deleteFailed', { msg: e?.message ?? String(e) }))
    }
  }

  const computePreview = async () => {
    const qty = Number(previewQty)
    if (!(qty > 0)) {
      setPreviewResult(null)
      return
    }
    try {
      const qs = new URLSearchParams()
      qs.set('qty', String(qty))
      if (previewGroupId) qs.set('customerGroup', previewGroupId)
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/resolve-price?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPreviewResult(await res.json())
    } catch (e: any) {
      toast.error(e?.message ?? String(e))
    }
  }

  return (
    <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm uppercase tracking-wider font-semibold text-slate-700 dark:text-slate-300">
          {t('products.drawer.tier.title')}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setAdding(true)}
        >
          {t('products.drawer.tier.add')}
        </Button>
      </div>

      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {tiers === null ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          {t('products.drawer.tier.loading')}
        </div>
      ) : tiers.length === 0 ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
          {t('products.drawer.tier.empty', { base: basePrice?.toFixed(2) ?? '—' })}
        </div>
      ) : (
        <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
          <thead className="bg-slate-50 dark:bg-slate-900">
            <tr className="text-left">
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.tier.col.minQty')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.tier.col.customerGroup')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">{t('products.drawer.tier.col.price')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">{t('products.drawer.tier.col.vsBase')}</th>
              <th className="px-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {tiers
              .slice()
              .sort((a, b) => a.minQty - b.minQty)
              .map((tier) => {
                const priceNum = Number(tier.price)
                const delta =
                  basePrice != null
                    ? Math.round(((priceNum - basePrice) / basePrice) * 100)
                    : null
                return (
                  <tr
                    key={tier.id}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-2 py-1.5 tabular-nums text-slate-900 dark:text-slate-100">
                      ≥ {tier.minQty}
                    </td>
                    <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300">
                      {tier.customerGroup?.label ?? (
                        <span className="text-xs italic text-slate-500 dark:text-slate-400">
                          {t('products.drawer.tier.everyone')}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-900 dark:text-slate-100">
                      €{priceNum.toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-xs">
                      {delta == null ? (
                        <span className="text-slate-400 dark:text-slate-500">—</span>
                      ) : delta < 0 ? (
                        <span className="text-emerald-700 dark:text-emerald-300">
                          {delta}%
                        </span>
                      ) : delta > 0 ? (
                        <span className="text-rose-700 dark:text-rose-300">
                          +{delta}%
                        </span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          0%
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-1.5">
                      <IconButton
                        aria-label={t('products.drawer.tier.deleteAria')}
                        size="sm"
                        tone="danger"
                        onClick={() => onDelete(tier)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      )}

      {/* Compute-price preview. Useful for "what would a wholesale
          buyer pay for 50?" ad-hoc checks. */}
      <div className="border border-slate-200 dark:border-slate-800 rounded p-2 bg-slate-50/50 dark:bg-slate-900/40">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
          {t('products.drawer.tier.preview.title')}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number"
            min={1}
            value={previewQty}
            onChange={(e) => setPreviewQty(e.target.value)}
            placeholder={t('products.drawer.tier.preview.qtyPlaceholder')}
            className="w-20 h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
          />
          <select
            value={previewGroupId}
            onChange={(e) => setPreviewGroupId(e.target.value)}
            className="h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">{t('products.drawer.tier.preview.noGroup')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            onClick={computePreview}
            disabled={!previewQty}
          >
            {t('products.drawer.tier.preview.compute')}
          </Button>
          {previewResult && (
            <div className="text-sm tabular-nums text-slate-900 dark:text-slate-100">
              <span className="font-semibold">€{previewResult.price.toFixed(2)}</span>
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {previewResult.source === 'tier'
                  ? t('products.drawer.tier.preview.tier', { minQty: previewResult.appliedTier?.minQty ?? 0 })
                  : t('products.drawer.tier.preview.base')}
              </span>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <AddTierForm
          productId={productId}
          groups={groups}
          existingTiers={tiers ?? []}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function AddTierForm({
  productId,
  groups,
  existingTiers,
  onClose,
  onCreated,
}: {
  productId: string
  groups: CustomerGroupOpt[]
  existingTiers: TierPriceRow[]
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslations()
  const [minQty, setMinQty] = useState('1')
  const [price, setPrice] = useState('')
  const [groupId, setGroupId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  // Help the operator avoid duplicates by surfacing existing tuples.
  const conflict = existingTiers.find(
    (t) =>
      t.minQty === Number(minQty) &&
      (t.customerGroupId ?? null) === (groupId || null),
  )

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/tier-prices`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            minQty: Number(minQty),
            price: Number(price),
            customerGroupId: groupId || null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.drawer.tier.toast.created'))
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="md"
      title={t('products.drawer.tier.form.title')}
    >
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.tier.form.minQty')}
            </label>
            <input
              type="number"
              min={1}
              value={minQty}
              onChange={(e) => setMinQty(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.tier.form.price')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            {t('products.drawer.tier.form.customerGroup')}
          </label>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">{t('products.drawer.tier.form.everyoneOption')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('products.drawer.tier.form.help')}
          </p>
        </div>
        {conflict && (
          <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 rounded px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            {t('products.drawer.tier.form.conflict')}
          </div>
        )}
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          {t('products.drawer.tier.form.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={
            submitting ||
            !minQty ||
            Number(minQty) < 1 ||
            !price ||
            Number(price) < 0
          }
          loading={submitting}
        >
          {t('products.drawer.tier.form.create')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/**
 * W4.9 — Repricing rules section.
 *
 * Sub-component of PricingTab. Lists per-(channel, marketplace)
 * RepricingRule rows for this product, lets the operator add/edit/
 * delete + opens a recent-decisions popover so they can answer "why
 * did my price drop yesterday at 14:00?".
 *
 * Strategy params (beatPct, beatAmount, schedule) are inline-edited
 * via a small form per rule. Channel + marketplace are immutable
 * once a rule is created (they're the @@unique key) — to "move" a
 * rule the operator deletes + creates.
 */
interface RepricingRuleSnapshot {
  id: string
  channel: string
  marketplace: string | null
  enabled: boolean
  minPrice: string
  maxPrice: string
  strategy: string
  beatPct: string | null
  beatAmount: string | null
  activeFromHour: number | null
  activeToHour: number | null
  activeDays: number[]
  notes: string | null
  lastEvaluatedAt: string | null
  lastDecisionPrice: string | null
  lastDecisionReason: string | null
}

// W5.38 — STRATEGY_LABELS reduced to a code list. Display labels
// resolve via t(`products.drawer.repricing.strategy.${code}`) at
// use-site so the dropdown + table cell read in the operator's
// locale.
const STRATEGY_CODES = [
  'match_buy_box',
  'beat_lowest_by_pct',
  'beat_lowest_by_amount',
  'fixed_to_buy_box_minus',
  'manual',
] as const

function RepricingRulesSection({
  productId,
  channelListings,
}: {
  productId: string
  channelListings: NonNullable<ProductDetail['channelListings']>
}) {
  const { t } = useTranslations()
  const [rules, setRules] = useState<RepricingRuleSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [decisionsOpenFor, setDecisionsOpenFor] = useState<string | null>(null)
  const { toast } = useToast()
  const confirm = useConfirm()

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/repricing-rules`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { rules?: RepricingRuleSnapshot[] }
      setRules(data.rules ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [productId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const onDelete = async (rule: RepricingRuleSnapshot) => {
    const scope = `${rule.channel}${rule.marketplace ? ` ${rule.marketplace}` : ''}`
    const ok = await confirm({
      title: t('products.drawer.repricing.deleteTitle', { scope }),
      description: t('products.drawer.repricing.deleteBody'),
      confirmLabel: t('products.drawer.repricing.deleteLabel'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/repricing-rules/${rule.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t('products.drawer.repricing.toast.deleted'))
      refresh()
    } catch (e: any) {
      toast.error(t('products.drawer.repricing.toast.deleteFailed', { msg: e?.message ?? String(e) }))
    }
  }

  const onToggleEnabled = async (rule: RepricingRuleSnapshot) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/repricing-rules/${rule.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !rule.enabled }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      refresh()
    } catch (e: any) {
      toast.error(t('products.drawer.repricing.toast.toggleFailed', { msg: e?.message ?? String(e) }))
    }
  }

  return (
    <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm uppercase tracking-wider font-semibold text-slate-700 dark:text-slate-300">
          {t('products.drawer.repricing.title')}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setAdding(true)}
        >
          {t('products.drawer.repricing.add')}
        </Button>
      </div>

      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {rules === null ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          {t('products.drawer.repricing.loading')}
        </div>
      ) : rules.length === 0 ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
          {t('products.drawer.repricing.empty')}
        </div>
      ) : (
        <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
          <thead className="bg-slate-50 dark:bg-slate-900">
            <tr className="text-left">
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.repricing.col.channelMp')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.repricing.col.strategy')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">{t('products.drawer.repricing.col.floorCeiling')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">{t('products.drawer.repricing.col.lastDecision')}</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-center">{t('products.drawer.repricing.col.enabled')}</th>
              <th className="px-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr
                key={r.id}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <td className="px-2 py-1.5 font-mono text-xs">
                  <span className="text-slate-900 dark:text-slate-100">{r.channel}</span>
                  {r.marketplace && (
                    <span className="text-slate-500 dark:text-slate-400">
                      {' · '}{r.marketplace}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="text-slate-900 dark:text-slate-100">
                    {STRATEGY_CODES.includes(r.strategy as (typeof STRATEGY_CODES)[number])
                      ? t(`products.drawer.repricing.strategy.${r.strategy}`)
                      : r.strategy}
                  </div>
                  {(r.beatPct || r.beatAmount) && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {r.beatPct ? `${r.beatPct}%` : `€${r.beatAmount}`}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                  €{Number(r.minPrice).toFixed(2)} / €{Number(r.maxPrice).toFixed(2)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {r.lastDecisionPrice ? (
                    <button
                      type="button"
                      onClick={() => setDecisionsOpenFor(r.id)}
                      className="text-blue-700 dark:text-blue-300 hover:underline"
                      title={r.lastDecisionReason ?? t('products.drawer.repricing.viewHistory')}
                    >
                      €{Number(r.lastDecisionPrice).toFixed(2)}
                    </button>
                  ) : (
                    <span className="text-xs italic text-slate-500 dark:text-slate-400">{t('products.drawer.repricing.never')}</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => onToggleEnabled(r)}
                    title={r.enabled ? t('products.drawer.repricing.evaluating') : t('products.drawer.repricing.paused')}
                  />
                </td>
                <td className="px-1 py-1.5">
                  <IconButton
                    aria-label={t('products.drawer.repricing.deleteAria')}
                    size="sm"
                    tone="danger"
                    onClick={() => onDelete(r)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddRepricingRuleForm
          productId={productId}
          channelListings={channelListings}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
      {decisionsOpenFor && (
        <DecisionsModal
          ruleId={decisionsOpenFor}
          onClose={() => setDecisionsOpenFor(null)}
        />
      )}
    </div>
  )
}

function AddRepricingRuleForm({
  productId,
  channelListings,
  onClose,
  onCreated,
}: {
  productId: string
  channelListings: NonNullable<ProductDetail['channelListings']>
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslations()
  // Pre-populate channel + marketplace options from the product's
  // existing listings so the operator picks from a real list.
  const channelOpts = useMemo(() => {
    const seen = new Set<string>()
    const opts: Array<{ channel: string; marketplace: string | null; key: string }> = []
    for (const cl of channelListings) {
      const key = `${cl.channel}|${cl.marketplace}`
      if (seen.has(key)) continue
      seen.add(key)
      opts.push({ channel: cl.channel, marketplace: cl.marketplace, key })
    }
    if (opts.length === 0) {
      // Fallback: hardcoded major channels.
      return [
        { channel: 'AMAZON', marketplace: null, key: 'AMAZON|' },
        { channel: 'EBAY', marketplace: null, key: 'EBAY|' },
        { channel: 'SHOPIFY', marketplace: null, key: 'SHOPIFY|' },
      ]
    }
    return opts
  }, [channelListings])

  const [channelKey, setChannelKey] = useState(channelOpts[0]?.key ?? '')
  const [strategy, setStrategy] = useState<string>('match_buy_box')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [beatPct, setBeatPct] = useState('')
  const [beatAmount, setBeatAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  const needsPct = strategy === 'beat_lowest_by_pct'
  const needsAmount =
    strategy === 'beat_lowest_by_amount' || strategy === 'fixed_to_buy_box_minus'

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    const opt = channelOpts.find((o) => o.key === channelKey)
    if (!opt) {
      setErr(t('products.drawer.repricing.form.pickChannel'))
      setSubmitting(false)
      return
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/repricing-rules`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: opt.channel,
            marketplace: opt.marketplace,
            strategy,
            minPrice: Number(minPrice),
            maxPrice: Number(maxPrice),
            beatPct: needsPct && beatPct ? Number(beatPct) : null,
            beatAmount: needsAmount && beatAmount ? Number(beatAmount) : null,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.drawer.repricing.toast.created'))
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title={t('products.drawer.repricing.form.title')}
      description={t('products.drawer.repricing.form.description')}
    >
      <div className="p-5 space-y-3">
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            {t('products.drawer.repricing.form.channelMp')}
          </label>
          <select
            value={channelKey}
            onChange={(e) => setChannelKey(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            {channelOpts.map((o) => (
              <option key={o.key} value={o.key}>
                {o.channel}
                {o.marketplace ? ` · ${o.marketplace}` : ` · ${t('products.drawer.repricing.form.allMarketplaces')}`}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            {t('products.drawer.repricing.form.strategy')}
          </label>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            {STRATEGY_CODES.map((code) => (
              <option key={code} value={code}>
                {t(`products.drawer.repricing.strategy.${code}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.repricing.form.floor')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.repricing.form.ceiling')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
        </div>

        {needsPct && (
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.repricing.form.beatPct')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={beatPct}
              onChange={(e) => setBeatPct(e.target.value)}
              placeholder="e.g. 2.5"
              className="w-32 h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
        )}
        {needsAmount && (
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              {t('products.drawer.repricing.form.beatAmount')}
            </label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={beatAmount}
              onChange={(e) => setBeatAmount(e.target.value)}
              placeholder="e.g. 2.00"
              className="w-32 h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
            />
          </div>
        )}

        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          {t('products.drawer.repricing.form.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={
            submitting ||
            !minPrice ||
            !maxPrice ||
            (needsPct && !beatPct) ||
            (needsAmount && !beatAmount)
          }
          loading={submitting}
        >
          {t('products.drawer.repricing.form.create')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function DecisionsModal({
  ruleId,
  onClose,
}: {
  ruleId: string
  onClose: () => void
}) {
  const { t } = useTranslations()
  const [decisions, setDecisions] = useState<
    | Array<{
        id: string
        oldPrice: string
        newPrice: string
        reason: string
        applied: boolean
        capped: string | null
        buyBoxPrice: string | null
        lowestCompPrice: string | null
        createdAt: string
      }>
    | null
  >(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${getBackendUrl()}/api/repricing-rules/${ruleId}/decisions?limit=50`, {
      cache: 'no-store',
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => setDecisions(data.decisions ?? []))
      .catch((e) => setErr(e?.message ?? String(e)))
  }, [ruleId])

  return (
    <Modal
      open={true}
      onClose={onClose}
      size="2xl"
      title={t('products.drawer.repricing.decisions.title')}
      description={t('products.drawer.repricing.decisions.description')}
    >
      <div className="p-5 space-y-2 max-h-[60vh] overflow-y-auto">
        {err && (
          <div className="text-sm text-rose-700 dark:text-rose-300">{err}</div>
        )}
        {decisions === null ? (
          <div className="text-base text-slate-500 dark:text-slate-400">
            {t('products.drawer.repricing.decisions.loading')}
          </div>
        ) : decisions.length === 0 ? (
          <div className="text-base italic text-slate-500 dark:text-slate-400">
            {t('products.drawer.repricing.decisions.empty')}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.repricing.decisions.col.when')}</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">{t('products.drawer.repricing.decisions.col.oldNew')}</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{t('products.drawer.repricing.decisions.col.reason')}</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-center">{t('products.drawer.repricing.decisions.col.applied')}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr
                  key={d.id}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {new Date(d.createdAt).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    €{Number(d.oldPrice).toFixed(2)} → €{Number(d.newPrice).toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300">
                    {d.reason}
                    {d.capped && (
                      <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">
                        ({d.capped})
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center text-xs">
                    {d.applied ? (
                      <span className="text-emerald-700 dark:text-emerald-300">
                        ✓
                      </span>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('products.drawer.repricing.decisions.close')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/**
 * For parent products only. Reads /api/products/:parentId/children,
 * lists each child's sku, name, axis values, basePrice, totalStock,
 * status. Inline-edit price + stock per child via the same
 * PATCH /api/products/:id pattern the grid uses; sends If-Match
 * for optimistic concurrency. On 409 we surface inline + refresh.
 *
 * Click the child's SKU → open it in the drawer (replaces current).
 * Click "Open full edit" → /products/<childId>/edit.
 *
 * No bulk operations here — the dedicated /products/[id]/matrix +
 * the bulk-action bar on the main grid are where multi-row work
 * happens. This tab is the "scan + tweak one or two cells" surface.
 */
interface ChildProduct {
  id: string
  sku: string
  name: string
  basePrice: string | number | null
  totalStock: number | null
  status: string
  version?: number
  variations: Record<string, string> | null
}

function VariationsTab({
  parentId,
  parentSku,
  onChanged,
}: {
  parentId: string
  parentSku: string
  onChanged: () => void
}) {
  const { t } = useTranslations()
  const [children, setChildren] = useState<ChildProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    childId: string
    field: 'price' | 'stock'
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [savingError, setSavingError] = useState<{
    childId: string
    field: 'price' | 'stock'
    message: string
  } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${parentId}/children`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setChildren(json.children ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Cross-tab refresh — same pattern as the parent drawer. If
  // another tab edits one of the children we re-pull the list so
  // this tab doesn't show stale price/stock.
  useInvalidationChannel(
    ['product.updated', 'product.created', 'product.deleted'],
    () => { void refresh() },
  )

  const startEdit = (child: ChildProduct, field: 'price' | 'stock') => {
    setSavingError(null)
    setDraft(
      String(field === 'price' ? Number(child.basePrice ?? 0) : child.totalStock ?? 0),
    )
    setEditing({ childId: child.id, field })
  }

  const commit = async (child: ChildProduct, field: 'price' | 'stock') => {
    const value = draft.trim()
    setEditing(null)
    if (value === '') return
    const body: Record<string, unknown> =
      field === 'price'
        ? { basePrice: Number(value) }
        : { totalStock: Number(value) }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (typeof child.version === 'number') headers['If-Match'] = String(child.version)
      const res = await fetch(`${getBackendUrl()}/api/products/${child.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        if (res.status === 409 && errJson?.code === 'VERSION_CONFLICT') {
          setSavingError({
            childId: child.id,
            field,
            message: t('products.drawer.variations.versionConflict', { version: errJson.currentVersion ?? '?' }),
          })
          void refresh()
          return
        }
        throw new Error(errJson?.error ?? `Update failed (${res.status})`)
      }
      emitInvalidation({
        type: 'product.updated',
        id: child.id,
        fields: [field === 'price' ? 'basePrice' : 'totalStock'],
        meta: { source: 'drawer-variations' },
      })
      // basePrice + totalStock both cascade to ChannelListing.
      emitInvalidation({
        type: 'listing.updated',
        meta: { productIds: [child.id], source: 'drawer-variations', field },
      })
      setSavingError(null)
      void refresh()
      onChanged()
    } catch (e) {
      setSavingError({
        childId: child.id,
        field,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (loading && children.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400 text-base">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> {t('products.drawer.variations.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>{t('products.drawer.variations.failed', { error })}</span>
      </div>
    )
  }
  if (children.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-base text-slate-500">
        <Layers className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        {t('products.drawer.variations.empty', { sku: parentSku })}
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t('products.drawer.variations.emptyHint')}
        </div>
      </div>
    )
  }

  // Collect axis names across all children so the table header is
  // stable even if some children are missing an axis value.
  const axisKeys = Array.from(
    children.reduce((set, c) => {
      if (c.variations) for (const k of Object.keys(c.variations)) set.add(k)
      return set
    }, new Set<string>()),
  )

  return (
    <div className="p-5 space-y-3">
      <div className="text-sm text-slate-500">
        {t(
          children.length === 1
            ? 'products.drawer.variations.summary.one'
            : 'products.drawer.variations.summary.other',
          { count: children.length },
        )}{' '}
        <span className="font-mono text-slate-700">{parentSku}</span>{t('products.drawer.variations.clickToEdit')}
      </div>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-base">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="text-left py-1.5 px-2 font-semibold">{t('products.drawer.variations.col.sku')}</th>
              {axisKeys.map((k) => (
                <th key={k} className="text-left py-1.5 px-2 font-semibold">
                  {k}
                </th>
              ))}
              <th className="text-right py-1.5 px-2 font-semibold">{t('products.drawer.variations.col.price')}</th>
              <th className="text-right py-1.5 px-2 font-semibold">{t('products.drawer.variations.col.stock')}</th>
              <th className="text-center py-1.5 px-2 font-semibold">{t('products.drawer.variations.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {children.map((c) => {
              const editingPrice =
                editing?.childId === c.id && editing.field === 'price'
              const editingStock =
                editing?.childId === c.id && editing.field === 'stock'
              const cellErr =
                savingError?.childId === c.id ? savingError : null
              return (
                <tr
                  key={c.id}
                  className="border-b border-slate-100 hover:bg-slate-50/50"
                >
                  <td className="py-1.5 px-2 align-top">
                    <button
                      type="button"
                      onClick={() => {
                        // Replace current drawer with this child via
                        // the same custom-event channel the grid uses.
                        window.dispatchEvent(
                          new CustomEvent('nexus:open-product-drawer', {
                            detail: { productId: c.id },
                          }),
                        )
                      }}
                      className="text-left text-blue-700 hover:underline font-mono text-sm"
                    >
                      {c.sku}
                    </button>
                  </td>
                  {axisKeys.map((k) => (
                    <td key={k} className="py-1.5 px-2 text-slate-700 align-top">
                      {c.variations?.[k] ?? <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                  <td className="py-1.5 px-2 text-right tabular-nums align-top">
                    {editingPrice ? (
                      <input
                        autoFocus
                        type="number"
                        step="0.01"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(c, 'price')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(c, 'price')
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="w-20 h-6 px-1.5 text-base text-right tabular-nums border border-blue-300 rounded"
                      />
                    ) : (
                      <InlineEditTrigger
                        onClick={() => startEdit(c, 'price')}
                        label={t('products.drawer.variations.priceEditAria', { sku: c.sku })}
                        align="right"
                        size="sm"
                      >
                        <span className="tabular-nums text-slate-900">€{Number(c.basePrice ?? 0).toFixed(2)}</span>
                      </InlineEditTrigger>
                    )}
                    {cellErr?.field === 'price' && (
                      <div className="text-xs text-rose-700 mt-0.5">
                        {cellErr.message}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums align-top">
                    {editingStock ? (
                      <input
                        autoFocus
                        type="number"
                        min="0"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(c, 'stock')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(c, 'stock')
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="w-16 h-6 px-1.5 text-base text-right tabular-nums border border-blue-300 rounded"
                      />
                    ) : (
                      <InlineEditTrigger
                        onClick={() => startEdit(c, 'stock')}
                        label={t('products.drawer.variations.stockEditAria', { sku: c.sku })}
                        align="right"
                        size="sm"
                      >
                        <span className={cn(
                          'tabular-nums font-semibold',
                          (c.totalStock ?? 0) === 0 ? 'text-rose-600' : 'text-slate-900',
                        )}>
                          {c.totalStock ?? 0}
                        </span>
                      </InlineEditTrigger>
                    )}
                    {cellErr?.field === 'stock' && (
                      <div className="text-xs text-rose-700 mt-0.5">
                        {cellErr.message}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-center align-top">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="text-sm text-slate-500">
        {t('products.drawer.variations.bulkLink')}{' '}
        <Link
          href={`/products/${parentId}/matrix`}
          className="text-blue-700 hover:underline"
        >
          {t('products.drawer.variations.matrixLink')}
        </Link>
        .
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// TranslationsTab (H.10) — per-language master content editor
// ────────────────────────────────────────────────────────────────────
/**
 * Lists every ProductTranslation row plus the Master (primary
 * language) row up top so the user has a single surface for all
 * language variants. Each row collapses to a one-line summary;
 * expand to edit. AI-sourced rows show an "AI · review" pill until
 * the user marks reviewed.
 */

interface TranslationRow {
  id: string
  language: string
  name: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  source: string | null
  sourceModel: string | null
  reviewedAt: string | null
  updatedAt: string
}

// W5.36 — KNOWN_LANGUAGES is now code-only; the operator-facing
// label resolves via t(`products.lens.translations.locale.${code}`)
// at use-site through the catalog already populated by W5.19.
const KNOWN_LANGUAGES: Array<{ code: string }> = [
  { code: 'it' },
  { code: 'de' },
  { code: 'fr' },
  { code: 'es' },
  { code: 'en' },
  { code: 'nl' },
  { code: 'sv' },
  { code: 'pl' },
]

function TranslationsTab({
  productId,
  masterName,
  masterDescription,
  masterBullets,
  masterKeywords,
  onChanged,
}: {
  productId: string
  masterName: string
  masterDescription: string | null
  masterBullets: string[]
  masterKeywords: string[]
  onChanged: () => void
}) {
  const askConfirm = useConfirm()
  const { t } = useTranslations()
  const langLabel = (code: string): string => {
    const known = KNOWN_LANGUAGES.find((l) => l.code === code)
    return known
      ? `${t(`products.lens.translations.locale.${code}`)} (${code.toUpperCase()})`
      : code.toUpperCase()
  }
  const [primaryLanguage, setPrimaryLanguage] = useState<string>('it')
  const [rows, setRows] = useState<TranslationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [newLang, setNewLang] = useState('de')
  const [newLangCustom, setNewLangCustom] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setPrimaryLanguage((json.primaryLanguage ?? 'it').toLowerCase())
      setRows(json.translations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const create = async () => {
    const code = (newLangCustom.trim() || newLang).toLowerCase()
    if (!code) return
    if (code === primaryLanguage) {
      setError(
        t('products.drawer.translations.error.primaryLang', { code }),
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${code}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'manual' }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setAdding(false)
      setNewLangCustom('')
      setExpanded((s) => new Set(s).add(code))
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async (
    language: string,
    payload: Partial<TranslationRow>,
  ) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      onChanged()
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const markReviewed = async (language: string) => {
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}/review`,
        { method: 'POST' },
      )
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (language: string) => {
    if (!(await askConfirm({ title: t('products.drawer.translations.delete.title', { language: langLabel(language) }), description: t('products.drawer.translations.delete.body'), confirmLabel: t('products.drawer.translations.delete.label'), tone: 'danger' }))) return
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}`,
        { method: 'DELETE' },
      )
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="px-5 py-8 text-center text-base text-slate-500 dark:text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> {t('products.drawer.translations.loading')}
      </div>
    )
  }

  return (
    <div className="px-5 py-4 space-y-3">
      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800">
          {error}
        </div>
      )}

      {/* Master row — read-only here. Editing happens in Details. */}
      <div className="border border-blue-200 bg-blue-50/40 rounded-md p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="inline-flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider font-semibold text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">
              {t('products.drawer.translations.master')}
            </span>
            <span className="text-base font-medium text-slate-900">
              {langLabel(primaryLanguage)}
            </span>
          </div>
          <span className="text-xs text-blue-600 italic">
            {t('products.drawer.translations.editOnDetails')}
          </span>
        </div>
        <div className="text-base text-slate-700 truncate">
          {masterName || <span className="text-slate-400">—</span>}
        </div>
        {masterDescription && (
          <div className="text-sm text-slate-500 mt-0.5 line-clamp-2">
            {masterDescription.replace(/<[^>]+>/g, ' ').trim()}
          </div>
        )}
      </div>

      {rows.length === 0 && !adding && (
        <div className="text-center py-6 text-base text-slate-500 space-y-2">
          <Globe className="w-5 h-5 mx-auto text-slate-300" />
          <div>{t('products.drawer.translations.empty')}</div>
        </div>
      )}

      {rows.map((r) => {
        const isExpanded = expanded.has(r.language)
        const isAi = r.source?.startsWith('ai-')
        const needsReview = isAi && !r.reviewedAt
        return (
          <TranslationRowCard
            key={r.id}
            row={r}
            expanded={isExpanded}
            needsReview={!!needsReview}
            masterFallback={{
              name: masterName,
              description: masterDescription,
              bulletPoints: masterBullets,
              keywords: masterKeywords,
            }}
            busy={busy}
            onToggle={() => toggle(r.language)}
            onSave={(payload) => save(r.language, payload)}
            onReview={() => markReviewed(r.language)}
            onDelete={() => remove(r.language)}
          />
        )
      })}

      {adding ? (
        <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
          <div className="text-sm font-semibold text-purple-700 uppercase tracking-wider">
            {t('products.drawer.translations.addSection')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={newLang}
              onChange={(e) => setNewLang(e.target.value)}
              className="h-8 px-2 text-base border border-slate-200 rounded bg-white"
            >
              {KNOWN_LANGUAGES.filter(
                (l) =>
                  l.code !== primaryLanguage &&
                  !rows.some((r) => r.language === l.code),
              ).map((l) => (
                <option key={l.code} value={l.code}>
                  {t(`products.lens.translations.locale.${l.code}`)}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newLangCustom}
              onChange={(e) => setNewLangCustom(e.target.value)}
              placeholder={t('products.drawer.translations.codePlaceholder')}
              className="h-8 px-2 text-base border border-slate-200 rounded bg-white font-mono uppercase"
            />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
              className="text-slate-600"
            >
              {t('products.drawer.translations.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={create}
              disabled={busy}
              className="bg-purple-600 text-white border-purple-600 hover:bg-purple-700"
            >
              {t('products.drawer.translations.create')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          onClick={() => setAdding(true)}
          className="w-full border-dashed border-slate-300 text-slate-600"
          icon={<Plus className="w-3 h-3" />}
        >
          {t('products.drawer.translations.add')}
        </Button>
      )}

      <div className="text-xs text-slate-500 pt-2 border-t border-slate-100">
        {t('products.drawer.translations.aiNote', { primary: primaryLanguage.toUpperCase() })}
      </div>
    </div>
  )
}

function TranslationRowCard({
  row,
  expanded,
  needsReview,
  masterFallback,
  busy,
  onToggle,
  onSave,
  onReview,
  onDelete,
}: {
  row: TranslationRow
  expanded: boolean
  needsReview: boolean
  masterFallback: {
    name: string
    description: string | null
    bulletPoints: string[]
    keywords: string[]
  }
  busy: boolean
  onToggle: () => void
  onSave: (payload: Partial<TranslationRow>) => void
  onReview: () => void
  onDelete: () => void
}) {
  const { t } = useTranslations()
  const [name, setName] = useState(row.name ?? '')
  const [description, setDescription] = useState(row.description ?? '')
  const [bullets, setBullets] = useState((row.bulletPoints ?? []).join('\n'))
  const [keywords, setKeywords] = useState((row.keywords ?? []).join(', '))
  useEffect(() => {
    setName(row.name ?? '')
    setDescription(row.description ?? '')
    setBullets((row.bulletPoints ?? []).join('\n'))
    setKeywords((row.keywords ?? []).join(', '))
  }, [row.name, row.description, row.bulletPoints, row.keywords])

  const dirty =
    (name || '') !== (row.name ?? '') ||
    (description || '') !== (row.description ?? '') ||
    bullets !== (row.bulletPoints ?? []).join('\n') ||
    keywords !== (row.keywords ?? []).join(', ')

  const summaryName = row.name?.trim() || masterFallback.name
  const summaryDesc =
    row.description?.replace(/<[^>]+>/g, ' ').trim() ||
    masterFallback.description?.replace(/<[^>]+>/g, ' ').trim() ||
    ''

  const save = () => {
    onSave({
      name: name.trim() ? name : null,
      description: description.trim() ? description : null,
      bulletPoints: bullets
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean),
      keywords: keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      source: 'manual',
    } as Partial<TranslationRow>)
  }

  return (
    <div
      className={`border rounded-md ${
        needsReview ? 'border-amber-200' : 'border-slate-200'
      } bg-white`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
      >
        <span className="text-xs uppercase tracking-wider font-semibold text-slate-700 bg-slate-100 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">
          {row.language.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-slate-900 truncate">
            {summaryName}
          </div>
          {summaryDesc && (
            <div className="text-sm text-slate-500 line-clamp-1 mt-0.5">
              {summaryDesc}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {needsReview && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
              <Sparkles className="w-2.5 h-2.5" /> {t('products.drawer.translations.row.aiReview')}
            </span>
          )}
          <ChevronRight
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 p-3 space-y-2">
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.translations.row.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={masterFallback.name}
              className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.translations.row.description')}
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={masterFallback.description ?? ''}
              className="w-full px-2 py-1.5 text-base border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.translations.row.bullets')}
            </label>
            <textarea
              rows={5}
              value={bullets}
              onChange={(e) => setBullets(e.target.value)}
              className="w-full px-2 py-1.5 text-base border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.translations.row.keywords')}
            </label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
            />
          </div>

          {row.source && (
            <div className="text-xs text-slate-500 pt-1 border-t border-slate-100">
              {t('products.drawer.translations.row.source')}<span className="font-mono">{row.source}</span>
              {row.sourceModel && <> · {row.sourceModel}</>}
              {row.reviewedAt && (
                <>
                  {t('products.drawer.translations.row.reviewedOn', { date: new Date(row.reviewedAt).toLocaleDateString() })}
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5 pt-1">
            {needsReview && (
              <Button
                size="sm"
                onClick={onReview}
                disabled={busy}
                icon={<Check className="w-3 h-3" />}
                className="!h-7 !px-2 !text-sm !bg-amber-50 !text-amber-800 !border-amber-200 hover:!bg-amber-100"
              >
                {t('products.drawer.translations.row.markReviewed')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={busy}
              icon={<Trash2 className="w-3 h-3" />}
              className="!h-7 !px-2 !text-sm !text-rose-700 hover:!bg-rose-50"
            >
              {t('products.drawer.translations.row.delete')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={busy || !dirty}
              className="ml-auto !h-7 !px-3 !text-sm !bg-slate-900 hover:!bg-slate-800 !border-slate-900"
            >
              {t('products.drawer.translations.row.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// RelatedTab (H.11) — cross-sells, accessories, replacements
// ────────────────────────────────────────────────────────────────────
/**
 * Lists outgoing relations grouped by type (cross-sells, accessories,
 * etc.) plus an "Add related" search picker.
 *
 * Reciprocal toggle is on by default — most cross-sells should be
 * symmetric (if jacket links gloves, gloves should link jacket too).
 * The user can untick it for asymmetric relations like REPLACEMENT
 * (the new product replaces the old one, not the other way around).
 *
 * The search picker hits /api/products?search=... and shows up to 10
 * results, lazily — fires on debounce (250ms).
 */

interface RelatedRow {
  id: string
  type: string
  displayOrder: number
  notes: string | null
  toProduct: {
    id: string
    sku: string
    name: string
    basePrice: number | null
    totalStock: number | null
    status: string
    imageUrl: string | null
  } | null
  fromProduct?: {
    id: string
    sku: string
    name: string
    basePrice: number | null
    totalStock: number | null
    status: string
    imageUrl: string | null
  } | null
}

// W5.34 — RELATION_TYPES collapsed to code-only; label + hint are
// resolved via t() at use-site through products.drawer.related.kind.*
// keys. relationLabel() is no longer needed (dead — all callers
// translate inline).
const RELATION_TYPES: Array<{ code: string }> = [
  { code: 'CROSS_SELL' },
  { code: 'ACCESSORY' },
  { code: 'UPSELL' },
  { code: 'REPLACEMENT' },
  { code: 'BUNDLE_PART' },
  { code: 'RECOMMENDED' },
]

interface SearchResult {
  id: string
  sku: string
  name: string
  imageUrl?: string | null
}

function RelatedTab({
  productId,
  onChanged,
}: {
  productId: string
  onChanged: () => void
}) {
  const askConfirm = useConfirm()
  const { t } = useTranslations()
  const [outgoing, setOutgoing] = useState<RelatedRow[]>([])
  const [incoming, setIncoming] = useState<RelatedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  // Picker state
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedTo, setSelectedTo] = useState<SearchResult | null>(null)
  const [pickedType, setPickedType] = useState<string>('CROSS_SELL')
  const [reciprocal, setReciprocal] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/relations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOutgoing(json.outgoing ?? [])
      setIncoming(json.incoming ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Debounced search → /api/products?search=
  useEffect(() => {
    if (!adding) return
    const term = search.trim()
    if (term.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products?search=${encodeURIComponent(term)}&limit=10`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        const rows = (json.products ?? []) as Array<{
          id: string
          sku: string
          name: string
          imageUrl?: string | null
        }>
        setResults(
          rows
            .filter((r) => r.id !== productId)
            .map((r) => ({
              id: r.id,
              sku: r.sku,
              name: r.name,
              imageUrl: r.imageUrl ?? null,
            })),
        )
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [adding, search, productId])

  const create = async () => {
    if (!selectedTo) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/relations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toProductId: selectedTo.id,
            type: pickedType,
            reciprocal,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setAdding(false)
      setSelectedTo(null)
      setSearch('')
      setResults([])
      onChanged()
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (relationId: string) => {
    if (!(await askConfirm({ title: t('products.drawer.related.removeConfirm'), confirmLabel: t('products.drawer.related.removeTitle'), tone: 'danger' }))) return
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/relations/${relationId}?reciprocal=true`,
        { method: 'DELETE' },
      )
      onChanged()
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  // Group outgoing by type for the rendered sections.
  const outgoingByType = useMemo(() => {
    const m = new Map<string, RelatedRow[]>()
    for (const rt of RELATION_TYPES) m.set(rt.code, [])
    for (const r of outgoing) {
      const arr = m.get(r.type) ?? []
      arr.push(r)
      m.set(r.type, arr)
    }
    return m
  }, [outgoing])

  if (loading) {
    return (
      <div className="px-5 py-8 text-center text-base text-slate-500 dark:text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> {t('products.drawer.related.loading')}
      </div>
    )
  }

  return (
    <div className="px-5 py-4 space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800">
          {error}
        </div>
      )}

      {RELATION_TYPES.map((rt) => {
        const rows = outgoingByType.get(rt.code) ?? []
        if (rows.length === 0) return null
        return (
          <section key={rt.code} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-700">
                  {t(`products.drawer.related.kind.${rt.code}.label`)}
                </div>
                <div className="text-xs text-slate-500">{t(`products.drawer.related.kind.${rt.code}.hint`)}</div>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t(
                  rows.length === 1
                    ? 'products.drawer.related.itemCount.one'
                    : 'products.drawer.related.itemCount.other',
                  { count: rows.length },
                )}
              </span>
            </div>
            {rows.map((r) => {
              const p = r.toProduct
              if (!p) return null
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-2 px-2 py-1.5 border border-slate-200 rounded bg-white"
                >
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="w-8 h-8 rounded object-cover bg-slate-100 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0">
                      <Package className="w-4 h-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-base text-slate-900 font-medium truncate">
                      {p.name}
                    </div>
                    <div className="text-xs text-slate-500 font-mono truncate">
                      {p.sku}
                      {p.basePrice != null && (
                        <span className="ml-1.5 tabular-nums">
                          · €{p.basePrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('nexus:open-product-drawer', {
                          detail: { productId: p.id },
                        }),
                      )
                    }
                    title={t('products.drawer.related.openTitle')}
                    aria-label={t('products.drawer.related.openAria')}
                    className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <IconButton
                    aria-label={t('products.drawer.related.removeAria')}
                    size="md"
                    tone="danger"
                    onClick={() => remove(r.id)}
                    disabled={busy}
                    title={t('products.drawer.related.removeTitle')}
                    className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              )
            })}
          </section>
        )
      })}

      {outgoing.length === 0 && !adding && (
        <div className="text-center py-6 text-base text-slate-500 space-y-2">
          <Network className="w-5 h-5 mx-auto text-slate-300" />
          <div>{t('products.drawer.related.empty')}</div>
        </div>
      )}

      {adding ? (
        <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
          <div className="text-sm font-semibold text-purple-700 uppercase tracking-wider">
            {t('products.drawer.related.addSection')}
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.related.type')}
            </label>
            <select
              value={pickedType}
              onChange={(e) => setPickedType(e.target.value)}
              className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
            >
              {RELATION_TYPES.map((rt) => (
                <option key={rt.code} value={rt.code}>
                  {t(`products.drawer.related.kind.${rt.code}.label`)} — {t(`products.drawer.related.kind.${rt.code}.hint`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              {t('products.drawer.related.searchProduct')}
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('products.drawer.related.searchPlaceholder')}
                className="w-full h-8 pl-7 pr-2 text-base border border-slate-200 rounded bg-white"
              />
            </div>
            {searching && (
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic">
                {t('products.drawer.related.searching')}
              </div>
            )}
            {results.length > 0 && !selectedTo && (
              <div className="mt-1 border border-slate-200 rounded bg-white max-h-48 overflow-y-auto">
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelectedTo(r)
                      setResults([])
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 text-left"
                  >
                    {r.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.imageUrl}
                        alt=""
                        className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-base text-slate-900 truncate">
                        {r.name}
                      </div>
                      <div className="text-xs text-slate-500 font-mono truncate">
                        {r.sku}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {selectedTo && (
              <div className="mt-1 flex items-center gap-2 px-2 py-1.5 border border-purple-300 rounded bg-white">
                {selectedTo.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selectedTo.imageUrl}
                    alt=""
                    className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-base text-slate-900 truncate font-medium">
                    {selectedTo.name}
                  </div>
                  <div className="text-xs text-slate-500 font-mono truncate">
                    {selectedTo.sku}
                  </div>
                </div>
                <IconButton
                  aria-label={t('products.drawer.related.clearSelection')}
                  size="sm"
                  onClick={() => setSelectedTo(null)}
                  className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                >
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={reciprocal}
              onChange={() => setReciprocal((v) => !v)}
              className="mt-0.5"
            />
            <div>
              <div>{t('products.drawer.related.reciprocal.title')}</div>
              <div className="text-xs text-slate-500">
                {t('products.drawer.related.reciprocal.body')}
              </div>
            </div>
          </label>
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false)
                setSelectedTo(null)
                setSearch('')
                setResults([])
              }}
              className="!h-7 !px-2 !text-sm"
            >
              {t('products.drawer.related.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={create}
              disabled={busy || !selectedTo}
              className="!h-7 !px-3 !text-sm !bg-purple-600 hover:!bg-purple-700 !border-purple-600"
            >
              {t('products.drawer.related.addBtn')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full h-8 text-base border border-dashed border-slate-300 rounded text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3 h-3" /> {t('products.drawer.related.add')}
        </button>
      )}

      {/* Incoming awareness — read-only list of products that link
          to this one. Useful when editing/removing this product. */}
      {incoming.length > 0 && (
        <section className="pt-3 border-t border-slate-100 space-y-1.5">
          <div className="text-sm font-semibold text-slate-700">
            {t(
              incoming.length === 1
                ? 'products.drawer.related.linkedFrom.one'
                : 'products.drawer.related.linkedFrom.other',
              { count: incoming.length },
            )}
          </div>
          <div className="text-xs text-slate-500">
            {t('products.drawer.related.linkedFromBody')}
          </div>
          {incoming.map((r) => {
            const p = r.fromProduct
            if (!p) return null
            return (
              <div
                key={r.id}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('nexus:open-product-drawer', {
                      detail: { productId: p.id },
                    }),
                  )
                }
                className="flex items-center gap-2 px-2 py-1.5 border border-slate-100 rounded bg-slate-50/40 cursor-pointer hover:bg-slate-50"
              >
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.imageUrl}
                    alt=""
                    className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-base text-slate-700 truncate">
                    {p.name}
                  </div>
                  <div className="text-xs text-slate-500 font-mono truncate">
                    {p.sku} ·{' '}
                    <span className="uppercase">{t(`products.drawer.related.kind.${r.type}.label`)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
