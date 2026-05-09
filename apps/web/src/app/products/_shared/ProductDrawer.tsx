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
      aria-label="Product details"
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
                {data?.name ?? (loading ? 'Loading…' : 'Product')}
              </h2>
              {data?.isParent && (
                <a
                  href={`/products/${data.id}/matrix`}
                  className="inline-flex items-center h-5 px-1.5 rounded text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/40"
                  title="Open the variant matrix editor"
                >
                  Parent · {data._count?.variations ?? 0} variants
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
            </div>
          </div>
          <IconButton
            onClick={onClose}
            aria-label="Close drawer"
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
          <div className="flex items-center border-b border-slate-200 dark:border-slate-800 px-5 overflow-x-auto scroll-smooth [scrollbar-width:thin]">
          <DrawerTab active={tab === 'details'} onClick={() => setTab('details')}>
            <Edit3 className="w-3 h-3" /> Details
          </DrawerTab>
          <DrawerTab
            active={tab === 'listings'}
            onClick={() => setTab('listings')}
            count={data?._count?.channelListings}
          >
            <Boxes className="w-3 h-3" /> Listings
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
              <Layers className="w-3 h-3" /> Variations
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
            <ImageIcon className="w-3 h-3" /> Images
          </DrawerTab>
          <DrawerTab
            active={tab === 'translations'}
            onClick={() => setTab('translations')}
            count={data?._count?.translations}
          >
            <Globe className="w-3 h-3" /> Translations
          </DrawerTab>
          {/* U.32 — Pricing tab. Per-marketplace price summary +
              deep-link to /pricing?search=<sku>. The drawer is the
              per-product hub; until now operators had to leave it to
              see the price matrix. */}
          <DrawerTab
            active={tab === 'pricing'}
            onClick={() => setTab('pricing')}
          >
            <DollarSign className="w-3 h-3" /> Pricing
          </DrawerTab>
          <DrawerTab
            active={tab === 'related'}
            onClick={() => setTab('related')}
            count={data?._count?.relationsFrom}
          >
            <Network className="w-3 h-3" /> Related
          </DrawerTab>
          {/* U.30 — Activity is higher-traffic ("what changed?"); the
              Schedule tab is rare, only used after a bulk-schedule
              ran. Swapped so the daily tab sits closer to the
              center of the row. */}
          <DrawerTab
            active={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            <Activity className="w-3 h-3" /> Activity
          </DrawerTab>
          {/* F.3.c — pending scheduled changes for this product. */}
          <DrawerTab
            active={tab === 'schedule'}
            onClick={() => setTab('schedule')}
          >
            <Calendar className="w-3 h-3" /> Schedule
          </DrawerTab>
          {/* W3.6 — Wave 3 workflow tab. Current stage + transition
              controls + comment thread + transition history. Only
              meaningful when the product has a workflowStage; tab
              renders an "attach workflow" CTA when stageless. */}
          <DrawerTab
            active={tab === 'workflow'}
            onClick={() => setTab('workflow')}
          >
            <GitBranch className="w-3 h-3" /> Workflow
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
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Health
        </div>
        {score != null && (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center h-6 px-2 rounded border text-base font-semibold tabular-nums',
                scoreTone,
              )}
              title="Composite score 0-100. Each error -10, warning -3, info -1, capped at 0."
            >
              {score}
              <span className="text-xs opacity-60 ml-0.5">/100</span>
            </span>
            <span className="text-sm text-slate-500 tabular-nums">
              {errors.length > 0 && (
                <span className="text-rose-700">{errors.length}E</span>
              )}
              {errors.length > 0 && warnings.length > 0 && ' · '}
              {warnings.length > 0 && (
                <span className="text-amber-700">{warnings.length}W</span>
              )}
              {(errors.length > 0 || warnings.length > 0) &&
                infos.length > 0 &&
                ' · '}
              {infos.length > 0 && (
                <span className="text-slate-500">{infos.length}I</span>
              )}
            </span>
          </div>
        )}
      </div>

      {issues.length === 0 ? (
        <div className="text-base text-slate-500 italic">
          No issues. The product passes every readiness check.
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
          label="Base price"
          value={basePrice}
          onChange={setBasePrice}
          onCommit={(v) => save('basePrice', v)}
          saving={saving === 'basePrice'}
          numeric
          prefix="€"
        />
        <QuickField
          label="Total stock"
          value={totalStock}
          onChange={setTotalStock}
          onCommit={(v) => save('totalStock', v)}
          saving={saving === 'totalStock'}
          numeric
        />
        <QuickField
          label="Low-stock threshold"
          value={threshold}
          onChange={setThreshold}
          onCommit={(v) => save('threshold', v)}
          saving={saving === 'threshold'}
          numeric
        />
      </div>
      {savedAt && (
        <div className="text-sm text-emerald-700">Saved.</div>
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
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
            Description
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
      <div className="border border-slate-200 rounded-md p-3 text-sm text-slate-400 italic">
        <Loader2 className="w-3 h-3 animate-spin inline mr-1.5" /> Loading
        forecast…
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
          Forecast
        </div>
        <span
          className={`text-xs font-semibold uppercase tracking-wider ${tone.text}`}
        >
          {projection.urgency}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Days of cover
          </div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {projection.daysOfCover != null
              ? `${projection.daysOfCover}d`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Velocity
          </div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {projection.velocity != null
              ? `${projection.velocity.toFixed(1)}/d`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-xs">
            Stocks out
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
          ? `Based on ${projection.forecastDays} days of demand data.`
          : projection.basis === 'threshold'
            ? 'No demand signal yet — using stock threshold.'
            : 'No demand signal yet. Generate sales history to project a stockout date.'}
      </div>
    </div>
  )
}

function DetailGrid({ product }: { product: ProductDetail }) {
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
    { label: 'Brand', value: product.brand ?? <em className="text-slate-400">—</em> },
    { label: 'Type', value: product.productType ?? <em className="text-slate-400">—</em> },
    { label: 'Fulfillment', value: product.fulfillmentMethod ?? <em className="text-slate-400">—</em> },
    {
      label: 'Weight',
      value:
        product.weightValue != null
          ? `${product.weightValue} ${product.weightUnit ?? ''}`.trim()
          : (<em className="text-slate-400">—</em>),
    },
    {
      label: 'Images',
      value: (
        <span className="inline-flex items-center gap-1">
          <ImageIcon className="w-3 h-3 text-slate-400" />
          {product._count?.images ?? 0}
        </span>
      ),
    },
    {
      label: 'Listings',
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
                ? 'Asking AI…'
                : `Suggest ${needsBrand && needsType ? 'brand + type' : needsBrand ? 'brand' : 'type'} with AI`}
            </button>
          )}
          {suggestion && (
            <>
              <div className="text-xs uppercase tracking-wider text-purple-700 font-semibold">
                AI suggestion
              </div>
              {suggestion.brand && needsBrand && (
                <div className="flex items-center justify-between gap-2 text-base">
                  <span className="text-slate-700">
                    Brand: <span className="font-medium">{suggestion.brand}</span>
                  </span>
                  {applied.has('brand') ? (
                    <span className="text-emerald-700 inline-flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> Applied
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => apply('brand', suggestion.brand!)}
                      disabled={applying === 'brand'}
                      className="text-sm text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {applying === 'brand' ? 'Applying…' : 'Apply'}
                    </button>
                  )}
                </div>
              )}
              {suggestion.productType && needsType && (
                <div className="flex items-center justify-between gap-2 text-base">
                  <span className="text-slate-700">
                    Type: <span className="font-medium">{suggestion.productType}</span>
                  </span>
                  {applied.has('productType') ? (
                    <span className="text-emerald-700 inline-flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> Applied
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => apply('productType', suggestion.productType!)}
                      disabled={applying === 'productType'}
                      className="text-sm text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {applying === 'productType' ? 'Applying…' : 'Apply'}
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
                Dismiss
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
        No listings yet.
        <div className="text-sm text-slate-400 mt-1">
          Use the listing wizard to publish this product.
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
                  <th className="px-3 py-1.5 text-left">Market</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right">Price</th>
                  <th className="px-3 py-1.5 text-right">Qty</th>
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
                              ? 'Both price and quantity differ from the master snapshot'
                              : priceDrift
                              ? `Listing price €${Number(l.price).toFixed(2)} differs from master €${Number(l.masterPrice).toFixed(2)} (followMasterPrice=false)`
                              : `Listing qty ${l.quantity} differs from master ${l.masterQuantity} (followMasterQuantity=false)`
                          }
                        >
                          DRIFT
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
                              ? 'Price + quantity overridden (manual values; happen to match master)'
                              : l.followMasterPrice === false
                              ? 'Price overridden (manual value; happens to match master)'
                              : 'Quantity overridden (manual value; happens to match master)'
                          }
                        >
                          OVERRIDE
                        </span>
                      )}
                      {/* P.11 — last sync timestamp + error visibility.
                          The badge already encodes status; this surfaces
                          the WHEN and the WHY so triage doesn't need to
                          open the dedicated /listings/<id> page. */}
                      <div className="text-xs text-slate-500 mt-1">
                        {l.lastSyncedAt
                          ? `Synced ${new Date(l.lastSyncedAt).toLocaleString()}`
                          : 'Not yet synced'}
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
                          master €{Number(l.masterPrice).toFixed(2)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums align-top">
                      {l.quantity ?? '—'}
                      {qtyDrift && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          master {l.masterQuantity}
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
                          title="Re-queue this listing for the next sync tick"
                          className="text-sm text-slate-500 hover:text-blue-700 disabled:opacity-50 inline-flex items-center gap-0.5"
                        >
                          {isResyncing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3" />
                          )}
                          {isResyncing ? 'Queuing…' : 'Sync now'}
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
                            title="Re-enable follow-master for every field. Next sync resets local values to master."
                            className="text-sm text-amber-700 hover:text-amber-900 disabled:opacity-50 inline-flex items-center gap-0.5"
                          >
                            {isSnapping ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : null}
                            {isSnapping ? 'Snapping…' : 'Snap to master'}
                          </button>
                        )}
                        <Link
                          href={`/listings/${l.id}`}
                          className="text-sm text-blue-700 hover:underline inline-flex items-center gap-0.5"
                        >
                          Open <ChevronRight className="w-3 h-3" />
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
      {failed ? 'SYNC FAILED' : listingStatus}
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
      toast.success('Stage moved')
    } catch (e: any) {
      toast.error(`Move failed: ${e?.message ?? String(e)}`)
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
      toast.error(`Comment failed: ${e?.message ?? String(e)}`)
    } finally {
      setCommenting(false)
    }
  }

  if (loading) {
    return (
      <div className="p-4 text-base text-slate-500 dark:text-slate-400">
        Loading workflow…
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
          No workflow attached.
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
          Attach a family that has a workflow, or use the bulk
          attach-workflow flow when it lands. Workflow lives in
          /settings/pim/workflows.
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
          Current stage · {stage.workflow.label}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-base font-medium bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded">
            {stage.label}
          </span>
          {stage.isInitial && (
            <span className="text-xs text-slate-500 dark:text-slate-400 italic">initial</span>
          )}
          {stage.isTerminal && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300 italic">terminal</span>
          )}
          {stage.isPublishable && (
            <span className="text-xs text-amber-700 dark:text-amber-300 italic">publishable</span>
          )}
          {snap.sla && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded font-medium ${SLA_TONE[snap.sla.state]}`}
              title={
                snap.sla.dueAt
                  ? `Due ${new Date(snap.sla.dueAt).toLocaleString()}`
                  : 'No SLA on this stage'
              }
            >
              {snap.sla.state === 'no_sla'
                ? 'no SLA'
                : snap.sla.state === 'overdue'
                ? `overdue ${Math.abs(Math.round(snap.sla.hoursRemaining ?? 0))}h`
                : `${Math.round(snap.sla.hoursRemaining ?? 0)}h left`}
            </span>
          )}
        </div>
      </div>

      {/* Move stage controls */}
      {otherStages.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
            Move to
          </div>
          <div className="flex items-center gap-2">
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="flex-1 h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="">— pick a stage —</option>
              {otherStages
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.isTerminal ? ' (terminal)' : ''}
                    {s.isPublishable ? ' · publishable' : ''}
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
              Move
            </Button>
          </div>
          <input
            type="text"
            value={moveComment}
            onChange={(e) => setMoveComment(e.target.value)}
            placeholder="Optional reason / note for the audit log"
            className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
      )}

      {/* Comment thread (current stage) */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Comments on {stage.label}
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
              No comments on this stage yet.
            </div>
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            rows={2}
            placeholder="Add a comment for this stage…"
            className="flex-1 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={addComment}
            disabled={!commentBody.trim()}
            loading={commenting}
          >
            Post
          </Button>
        </div>
      </div>

      {/* Transition history */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Transition history
        </div>
        {snap.transitions.length === 0 ? (
          <div className="text-sm italic text-slate-500 dark:text-slate-400">
            No transitions recorded.
          </div>
        ) : (
          <ul className="space-y-1">
            {snap.transitions.slice(0, 10).map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
              >
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums w-32 flex-shrink-0">
                  {new Date(t.createdAt).toLocaleString()}
                </span>
                <span className="truncate">
                  {t.fromStage ? (
                    <>
                      <span className="text-slate-500 dark:text-slate-400">{t.fromStage.label}</span>
                      <span className="mx-1 text-slate-400 dark:text-slate-500">→</span>
                    </>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500 italic mr-1">entry →</span>
                  )}
                  <span className="text-slate-900 dark:text-slate-100">{t.toStage.label}</span>
                  {t.comment && (
                    <span className="ml-2 text-slate-500 dark:text-slate-400 italic">
                      "{t.comment}"
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
      <div className="flex items-center justify-center py-12 text-slate-400 text-base">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading activity…
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>Failed to load activity: {error}</span>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-base text-slate-500">
        <Activity className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        No activity recorded yet.
        <div className="text-sm text-slate-400 mt-1">
          Edits, bulk operations, and master-data changes show up here.
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-3">
      {total > items.length && (
        <div className="text-sm text-slate-500">
          Showing {items.length} of {total} entries (most recent first)
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
        <div className="mt-1.5 text-xs text-slate-400">
          via bulk operation <span className="font-mono">{bulkOpId.slice(0, 12)}…</span>
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
      toast.success('Scheduled change cancelled')
      refresh()
    } catch (e) {
      toast.error(
        `Cancel failed: ${e instanceof Error ? e.message : String(e)}`,
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
        className="flex items-center justify-center py-12 text-slate-400 dark:text-slate-500 text-base"
      >
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading
        scheduled changes…
      </div>
    )
  }
  if (error) {
    return (
      <div
        role="alert"
        className="m-5 border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300"
      >
        Failed to load scheduled changes: {error}
      </div>
    )
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="px-5 py-12 text-center text-base text-slate-500 dark:text-slate-400">
        <Calendar className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
        No scheduled changes for this product.
        <div className="text-sm text-slate-400 dark:text-slate-500 mt-1">
          Use the bulk Schedule action on the main grid to defer a
          status flip or price change to a future time.
        </div>
      </div>
    )
  }

  const renderPayload = (kind: string, payload: Record<string, unknown>) => {
    if (kind === 'STATUS') {
      const status = payload.status as string | undefined
      return (
        <span>
          Set status →{' '}
          <span className="font-mono font-semibold">{status ?? '—'}</span>
        </span>
      )
    }
    if (kind === 'PRICE') {
      if (typeof payload.basePrice === 'number') {
        return (
          <span>
            Set basePrice →{' '}
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
            Adjust basePrice by{' '}
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
        {rows.length} scheduled change{rows.length === 1 ? '' : 's'}
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
                  Cancel
                </Button>
              )}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 inline-flex items-center gap-2 flex-wrap">
              <Clock size={11} />
              <span>
                {r.status === 'PENDING' ? 'Scheduled for' : 'Was scheduled for'}{' '}
                <span className="text-slate-700 dark:text-slate-300 font-medium">
                  {new Date(r.scheduledFor).toLocaleString()}
                </span>
              </span>
              {r.appliedAt && (
                <>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span>
                    {r.status === 'APPLIED' ? 'Applied at ' : 'Resolved at '}
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
  if (images.length === 0) {
    return (
      <div className="px-5 py-12 text-center text-base text-slate-500 dark:text-slate-400">
        <ImageIcon className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
        No images yet for this product.
        <div className="text-sm text-slate-400 dark:text-slate-500 mt-1">
          Drop a folder of photos onto the bulk image-upload modal on
          the main grid, or upload individually from the full image
          manager below.
        </div>
        <div className="mt-3">
          <Link
            href={`/products/${productId}/images`}
            className="h-8 px-3 text-sm bg-slate-900 text-white rounded hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
          >
            <ExternalLink size={11} /> Open image manager
          </Link>
        </div>
      </div>
    )
  }
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {images.length} image{images.length === 1 ? '' : 's'}
        </div>
        <Link
          href={`/products/${productId}/images`}
          className="h-7 px-2.5 text-sm border border-slate-200 dark:border-slate-800 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
        >
          <ExternalLink size={11} /> Manage images
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
        Drag-reorder, slot assignment (MAIN / ALT / LIFESTYLE), and
        bulk upload happen in the full image manager.
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
            Master basePrice
          </div>
          <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {baseNum == null ? '—' : `€${baseNum.toFixed(2)}`}
          </div>
        </div>
        <div className="ml-auto">
          <Link
            href={`/pricing?search=${encodeURIComponent(sku)}`}
            className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-800 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5"
            title="Open the full pricing matrix (rules, overrides, clamps, history)"
          >
            <ExternalLink size={11} /> Open pricing matrix
          </Link>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md py-8 text-center text-base text-slate-500 dark:text-slate-400 italic">
          No channel listings yet — once this product is published the
          per-marketplace prices appear here.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Channel
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Marketplace
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Listing price
                </th>
                <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Δ vs master
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Status
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
        Δ vs master shows how each channel listing's published price
        differs from this product's basePrice. Push / explain / clamp
        rules live in the full pricing matrix.
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

  const onDelete = async (t: TierPriceRow) => {
    const ok = await confirm({
      title: `Delete tier at qty=${t.minQty}${t.customerGroup ? ` (${t.customerGroup.label})` : ''}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/tier-prices/${t.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('Tier deleted')
      refresh()
    } catch (e: any) {
      toast.error(`Delete failed: ${e?.message ?? String(e)}`)
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
          Tier pricing
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setAdding(true)}
        >
          Add tier
        </Button>
      </div>

      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {tiers === null ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          Loading…
        </div>
      ) : tiers.length === 0 ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
          No tier prices. Base price is €{basePrice?.toFixed(2) ?? '—'}{' '}
          for everyone, every quantity.
        </div>
      ) : (
        <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
          <thead className="bg-slate-50 dark:bg-slate-900">
            <tr className="text-left">
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">Min qty</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">Customer group</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">Price</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">vs base</th>
              <th className="px-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {tiers
              .slice()
              .sort((a, b) => a.minQty - b.minQty)
              .map((t) => {
                const priceNum = Number(t.price)
                const delta =
                  basePrice != null
                    ? Math.round(((priceNum - basePrice) / basePrice) * 100)
                    : null
                return (
                  <tr
                    key={t.id}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-2 py-1.5 tabular-nums text-slate-900 dark:text-slate-100">
                      ≥ {t.minQty}
                    </td>
                    <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300">
                      {t.customerGroup?.label ?? (
                        <span className="text-xs italic text-slate-500 dark:text-slate-400">
                          everyone
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
                        aria-label="Delete tier"
                        size="sm"
                        tone="danger"
                        onClick={() => onDelete(t)}
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
          Compute price preview
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number"
            min={1}
            value={previewQty}
            onChange={(e) => setPreviewQty(e.target.value)}
            placeholder="qty"
            className="w-20 h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 tabular-nums"
          />
          <select
            value={previewGroupId}
            onChange={(e) => setPreviewGroupId(e.target.value)}
            className="h-7 px-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">no group (anonymous)</option>
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
            Compute
          </Button>
          {previewResult && (
            <div className="text-sm tabular-nums text-slate-900 dark:text-slate-100">
              <span className="font-semibold">€{previewResult.price.toFixed(2)}</span>
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {previewResult.source === 'tier'
                  ? `tier (≥ ${previewResult.appliedTier?.minQty})`
                  : 'base price'}
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
      toast.success('Tier created')
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
      title="Add tier price"
    >
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Min qty
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
              Price (€)
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
            Customer group
          </label>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">— everyone (no group) —</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Group-specific tiers beat generic at the same minQty.
            Generic tiers (no group) apply to everyone.
          </p>
        </div>
        {conflict && (
          <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 rounded px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            A tier already exists at this (min qty, group). The server
            will reject the create with a 409 — change one of the
            fields or delete the existing tier first.
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
          Cancel
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
          Create
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

const STRATEGY_LABELS: Record<string, string> = {
  match_buy_box: 'Match buy-box',
  beat_lowest_by_pct: 'Beat lowest by %',
  beat_lowest_by_amount: 'Beat lowest by amount',
  fixed_to_buy_box_minus: 'Buy-box minus fixed',
  manual: 'Manual (engine off)',
}

function RepricingRulesSection({
  productId,
  channelListings,
}: {
  productId: string
  channelListings: NonNullable<ProductDetail['channelListings']>
}) {
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
    const ok = await confirm({
      title: `Delete repricing rule for ${rule.channel}${rule.marketplace ? ` ${rule.marketplace}` : ''}?`,
      description:
        'Decision history is cascade-deleted. The product price stays where it is — engine just stops moving it.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/repricing-rules/${rule.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('Rule deleted')
      refresh()
    } catch (e: any) {
      toast.error(`Delete failed: ${e?.message ?? String(e)}`)
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
      toast.error(`Toggle failed: ${e?.message ?? String(e)}`)
    }
  }

  return (
    <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm uppercase tracking-wider font-semibold text-slate-700 dark:text-slate-300">
          Repricing rules
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setAdding(true)}
        >
          Add rule
        </Button>
      </div>

      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {rules === null ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400">
          Loading rules…
        </div>
      ) : rules.length === 0 ? (
        <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-4 text-center">
          No repricing rules yet. Add one to track the buy-box or undercut competitors automatically.
        </div>
      ) : (
        <table className="w-full text-sm border border-slate-200 dark:border-slate-800 rounded overflow-hidden">
          <thead className="bg-slate-50 dark:bg-slate-900">
            <tr className="text-left">
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">Channel · MP</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">Strategy</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">Floor / Ceiling</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">Last decision</th>
              <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-center">Enabled</th>
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
                    {STRATEGY_LABELS[r.strategy] ?? r.strategy}
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
                      title={r.lastDecisionReason ?? 'View decision history'}
                    >
                      €{Number(r.lastDecisionPrice).toFixed(2)}
                    </button>
                  ) : (
                    <span className="text-xs italic text-slate-400 dark:text-slate-500">never</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={() => onToggleEnabled(r)}
                    title={r.enabled ? 'Engine evaluating' : 'Paused'}
                  />
                </td>
                <td className="px-1 py-1.5">
                  <IconButton
                    aria-label="Delete rule"
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
      setErr('pick a channel')
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
      toast.success('Rule created')
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
      title="New repricing rule"
      description="One rule per (channel, marketplace). The engine evaluates active rules on each tick + writes a decision row regardless of whether the price actually changed."
    >
      <div className="p-5 space-y-3">
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Channel · marketplace
          </label>
          <select
            value={channelKey}
            onChange={(e) => setChannelKey(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            {channelOpts.map((o) => (
              <option key={o.key} value={o.key}>
                {o.channel}
                {o.marketplace ? ` · ${o.marketplace}` : ' · all marketplaces'}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Strategy
          </label>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            {Object.entries(STRATEGY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Floor (min €)
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
              Ceiling (max €)
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
              Beat by (%)
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
              Beat by (€)
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
          Cancel
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
          Create
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
      title="Recent repricing decisions"
      description="Append-only log of every engine evaluation. `applied=false` means the engine considered the move but didn't push (typically because the price was unchanged from the previous tick)."
    >
      <div className="p-5 space-y-2 max-h-[60vh] overflow-y-auto">
        {err && (
          <div className="text-sm text-rose-700 dark:text-rose-300">{err}</div>
        )}
        {decisions === null ? (
          <div className="text-base text-slate-500 dark:text-slate-400">
            Loading…
          </div>
        ) : decisions.length === 0 ? (
          <div className="text-base italic text-slate-500 dark:text-slate-400">
            No decisions yet — this rule hasn't been evaluated.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">When</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-right">Old → New</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">Reason</th>
                <th className="px-2 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 text-center">Applied</th>
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
          Close
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
            message: `Another change landed first (v${errJson.currentVersion ?? '?'}) — refreshing.`,
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
      <div className="flex items-center justify-center py-12 text-slate-400 text-base">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading variations…
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>Failed to load variations: {error}</span>
      </div>
    )
  }
  if (children.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-base text-slate-500">
        <Layers className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        No variations under {parentSku} yet.
        <div className="text-sm text-slate-400 mt-1">
          Add child products from the catalog organize page.
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
        {children.length} variation{children.length === 1 ? '' : 's'} under{' '}
        <span className="font-mono text-slate-700">{parentSku}</span>. Click
        price or stock to edit inline.
      </div>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-base">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="text-left py-1.5 px-2 font-semibold">SKU</th>
              {axisKeys.map((k) => (
                <th key={k} className="text-left py-1.5 px-2 font-semibold">
                  {k}
                </th>
              ))}
              <th className="text-right py-1.5 px-2 font-semibold">Price</th>
              <th className="text-right py-1.5 px-2 font-semibold">Stock</th>
              <th className="text-center py-1.5 px-2 font-semibold">Status</th>
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
                        label={`price for ${c.sku}`}
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
                        label={`stock for ${c.sku}`}
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
        Bulk variant operations live on{' '}
        <Link
          href={`/products/${parentId}/matrix`}
          className="text-blue-700 hover:underline"
        >
          the matrix view
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

const KNOWN_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'it', label: 'Italian' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
]

function languageLabel(code: string): string {
  const m = KNOWN_LANGUAGES.find((l) => l.code === code)
  return m ? `${m.label} (${code.toUpperCase()})` : code.toUpperCase()
}

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
        `${code} is the primary language — edit the master fields directly`,
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
    if (!(await askConfirm({ title: `Delete the ${languageLabel(language)} translation?`, description: 'The translation row will be removed; the master content stays intact.', confirmLabel: 'Delete', tone: 'danger' }))) return
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
      <div className="px-5 py-8 text-center text-base text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
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
              Master
            </span>
            <span className="text-base font-medium text-slate-900">
              {languageLabel(primaryLanguage)}
            </span>
          </div>
          <span className="text-xs text-blue-600 italic">
            Edit on the Details tab
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
          <div>No translations yet.</div>
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
            Add translation
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
                  {l.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newLangCustom}
              onChange={(e) => setNewLangCustom(e.target.value)}
              placeholder="or type code"
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
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={create}
              disabled={busy}
              className="bg-purple-600 text-white border-purple-600 hover:bg-purple-700"
            >
              Create
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
          Add translation
        </Button>
      )}

      <div className="text-xs text-slate-500 pt-2 border-t border-slate-100">
        AI-generated translations stay marked &ldquo;unreviewed&rdquo; until
        you confirm them. Generation happens via /products bulk AI fill —
        pick a non-{primaryLanguage.toUpperCase()} marketplace and the
        result lands here.
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
              <Sparkles className="w-2.5 h-2.5" /> AI · review
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
              Name
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
              Description
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
              Bullets · one per line
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
              Keywords · comma-separated
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
              Source: <span className="font-mono">{row.source}</span>
              {row.sourceModel && <> · {row.sourceModel}</>}
              {row.reviewedAt && (
                <>
                  {' · reviewed '}
                  {new Date(row.reviewedAt).toLocaleDateString()}
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
                Mark reviewed
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
              Delete
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={busy || !dirty}
              className="ml-auto !h-7 !px-3 !text-sm !bg-slate-900 hover:!bg-slate-800 !border-slate-900"
            >
              Save
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

const RELATION_TYPES: Array<{ code: string; label: string; hint: string }> = [
  { code: 'CROSS_SELL', label: 'Cross-sell', hint: 'You might also like' },
  { code: 'ACCESSORY', label: 'Accessory', hint: 'Works with this' },
  { code: 'UPSELL', label: 'Upsell', hint: 'Step up to this tier' },
  { code: 'REPLACEMENT', label: 'Replacement', hint: 'Supersedes' },
  { code: 'BUNDLE_PART', label: 'Bundle part', hint: 'Member of bundle' },
  { code: 'RECOMMENDED', label: 'Recommended', hint: 'Generic suggestion' },
]

function relationLabel(code: string): string {
  return RELATION_TYPES.find((t) => t.code === code)?.label ?? code
}

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
    if (!(await askConfirm({ title: 'Remove this related-product link?', confirmLabel: 'Remove', tone: 'danger' }))) return
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
    for (const t of RELATION_TYPES) m.set(t.code, [])
    for (const r of outgoing) {
      const arr = m.get(r.type) ?? []
      arr.push(r)
      m.set(r.type, arr)
    }
    return m
  }, [outgoing])

  if (loading) {
    return (
      <div className="px-5 py-8 text-center text-base text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
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

      {RELATION_TYPES.map((t) => {
        const rows = outgoingByType.get(t.code) ?? []
        if (rows.length === 0) return null
        return (
          <section key={t.code} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-semibold text-slate-700">
                  {t.label}
                </div>
                <div className="text-xs text-slate-500">{t.hint}</div>
              </div>
              <span className="text-xs text-slate-400">
                {rows.length} item{rows.length === 1 ? '' : 's'}
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
                    title="Open"
                    aria-label="Open related"
                    className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <IconButton
                    aria-label="Remove related"
                    size="md"
                    tone="danger"
                    onClick={() => remove(r.id)}
                    disabled={busy}
                    title="Remove"
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
          <div>No related products yet.</div>
        </div>
      )}

      {adding ? (
        <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
          <div className="text-sm font-semibold text-purple-700 uppercase tracking-wider">
            Add related
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Type
            </label>
            <select
              value={pickedType}
              onChange={(e) => setPickedType(e.target.value)}
              className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
            >
              {RELATION_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Search product
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU, name, brand…"
                className="w-full h-8 pl-7 pr-2 text-base border border-slate-200 rounded bg-white"
              />
            </div>
            {searching && (
              <div className="text-xs text-slate-400 mt-1 italic">
                Searching…
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
                  aria-label="Clear selection"
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
              <div>Create the reverse link too</div>
              <div className="text-xs text-slate-500">
                Most cross-sells should be symmetric. Untick for asymmetric
                relations like Replacement.
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
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={create}
              disabled={busy || !selectedTo}
              className="!h-7 !px-3 !text-sm !bg-purple-600 hover:!bg-purple-700 !border-purple-600"
            >
              Add
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full h-8 text-base border border-dashed border-slate-300 rounded text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3 h-3" /> Add related product
        </button>
      )}

      {/* Incoming awareness — read-only list of products that link
          to this one. Useful when editing/removing this product. */}
      {incoming.length > 0 && (
        <section className="pt-3 border-t border-slate-100 space-y-1.5">
          <div className="text-sm font-semibold text-slate-700">
            Linked from {incoming.length} product
            {incoming.length === 1 ? '' : 's'}
          </div>
          <div className="text-xs text-slate-500">
            These products have an outgoing link to this one. Editing
            them happens in their own drawer.
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
                    <span className="uppercase">{relationLabel(r.type)}</span>
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
