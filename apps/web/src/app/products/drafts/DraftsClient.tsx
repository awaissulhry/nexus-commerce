'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowRight,
  Box,
  Clock,
  FileEdit,
  Hourglass,
  Layers,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePolledList } from '@/lib/sync/use-polled-list'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import PageHeader from '@/components/layout/PageHeader'
import { CHANNEL_TONE } from '@/lib/theme'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ChannelTuple {
  platform: string
  marketplace: string
}

interface Draft {
  /** C.3 — discriminator: 'wizard' = ListingWizard DRAFT row,
   *  'product' = Product status='DRAFT' row (no wizard yet). */
  kind: 'wizard' | 'product'
  id: string
  productId: string
  productSku: string | null
  productName: string | null
  productIsParent: boolean
  /** Wizard rows: 1..9 step number. Product rows: null. */
  currentStep: number | null
  channels: ChannelTuple[]
  createdAt: string
  updatedAt: string
  isStale: boolean
  /** DR-S.2 — 0..100 product-data completeness, separate from wizard
   *  step progress. Same 7 factors used by the audit script. */
  completenessPct: number
  missingFactors: string[]
}

interface DraftsResponse {
  success: boolean
  total: number
  drafts: Draft[]
}

// DR-S.1 — KPI strip data shape, mirrors GET /api/listing-wizard/drafts/summary.
interface DraftsSummary {
  total: number
  wizards: number
  productDrafts: number
  stale: number
  expiring: number
  byStep: Record<string, number>
  oldestCreatedAt: string | null
}

function formatAgeDays(iso: string | null): string {
  if (!iso) return '—'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return '<1d'
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

const STEP_LABELS: Record<number, string> = {
  1: 'Channels',
  2: 'Type',
  3: 'Identifiers',
  4: 'Variations',
  5: 'Attributes',
  6: 'Images',
  7: 'Pricing',
  8: 'Review',
  9: 'Submit',
}

type SortOption = 'recency' | 'age-asc' | 'age-desc' | 'name' | 'completion'
type SourceFilter = 'all' | 'wizards' | 'products'

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'recency', label: 'Most recent' },
  { value: 'age-asc', label: 'Oldest first' },
  { value: 'age-desc', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'completion', label: 'Most complete' },
]

const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: 'Wizards + products' },
  { value: 'wizards', label: 'Wizards only' },
  { value: 'products', label: 'Product drafts only' },
]

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const month = Math.floor(day / 30)
  return `${month} month${month === 1 ? '' : 's'} ago`
}

// C.3 — composite row id for selection. Wizards and products can
// theoretically share the same uuid (separate tables) so we prefix.
function selectionKey(d: Draft): string {
  return `${d.kind}:${d.id}`
}

// DR-S.2 — product-data completeness badge. Colour-codes by bucket
// so the operator can scan a list and immediately see which drafts
// are nearly-publishable vs. stub-only.
//
// DR-S.3 — paired with up to 2 missing-factor chips so the operator
// can see at a glance what's holding the draft back. Tooltip on the
// badge lists the full set of missing factors when there are >2.
function CompletenessBadge({
  pct,
  missing,
}: {
  pct: number
  missing?: string[]
}) {
  let toneClasses: string
  if (pct >= 100)
    toneClasses =
      'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
  else if (pct >= 75)
    toneClasses =
      'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
  else if (pct >= 50)
    toneClasses =
      'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
  else
    toneClasses =
      'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
  return (
    <span
      className={cn(
        'inline-flex items-center h-4 px-1.5 rounded text-xs font-semibold tabular-nums self-start',
        toneClasses,
      )}
      title={
        missing && missing.length > 0
          ? `Missing: ${missing.join(', ')}`
          : undefined
      }
    >
      {pct}%
    </span>
  )
}

// DR-S.3 — labels for the 7 completeness factors. Italian translations
// pulled from the i18n bundle; the keys themselves stay stable
// (drafts.factor.<key>) so future factors plug in without touching
// the rendering code.
const FACTOR_LABEL_KEYS: Record<string, string> = {
  name: 'drafts.factor.name',
  price: 'drafts.factor.price',
  brand: 'drafts.factor.brand',
  type: 'drafts.factor.type',
  description: 'drafts.factor.description',
  gtin: 'drafts.factor.gtin',
  image: 'drafts.factor.image',
}

// DR-A.3 — chips for `brand` and `type` are AI-suggestable via the
// existing /api/products/:id/ai/suggest-fields endpoint. When the
// row carries a name + description (signal for the LLM), make the
// chip a button so the operator can fire the suggestion inline.
const AI_SUGGESTABLE_FACTORS = new Set(['brand', 'type'])

function MissingFactorChips({
  missing,
  t,
  onSuggest,
  canSuggest,
  suggesting,
}: {
  missing: string[]
  t: (key: string, vars?: Record<string, string | number>) => string
  onSuggest?: () => void
  canSuggest?: boolean
  suggesting?: boolean
}) {
  if (missing.length === 0) return null
  // Show the top 2 most-impactful factors inline; fold the rest
  // into a "+N" pill that summarises them. Order matches the
  // server-side scoring sequence so the same fields surface
  // consistently across rows.
  const visible = missing.slice(0, 2)
  const overflow = missing.length - visible.length
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((f) => {
        const isAiSuggestable =
          AI_SUGGESTABLE_FACTORS.has(f) && canSuggest && !!onSuggest
        const label = t(FACTOR_LABEL_KEYS[f] ?? `drafts.factor.${f}`)
        if (!isAiSuggestable) {
          return (
            <span
              key={f}
              className="inline-flex items-center h-4 px-1.5 rounded text-xs font-medium bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
            >
              {label}
            </span>
          )
        }
        return (
          <Tooltip
            key={f}
            content={t('drafts.suggestTooltip')}
            placement="top"
          >
            <button
              type="button"
              onClick={onSuggest}
              disabled={suggesting}
              className="inline-flex items-center gap-0.5 h-4 px-1.5 rounded text-xs font-medium bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 hover:bg-violet-50 hover:text-violet-700 dark:hover:bg-violet-950/40 dark:hover:text-violet-300 transition-colors disabled:opacity-60"
            >
              {suggesting ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <Sparkles className="w-2.5 h-2.5" />
              )}
              {label}
            </button>
          </Tooltip>
        )
      })}
      {overflow > 0 && (
        <span
          className="inline-flex items-center h-4 px-1.5 rounded text-xs font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
          title={missing.slice(2).map((f) => t(FACTOR_LABEL_KEYS[f] ?? `drafts.factor.${f}`)).join(', ')}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

// DR-S.1 — KPI tile for the drafts summary strip. Compact card,
// optional click-through (used by the Stale tile to scope the list).
function KpiTile({
  icon: Icon,
  label,
  value,
  help,
  loading,
  tone = 'default',
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
  help?: string
  loading?: boolean
  tone?: 'default' | 'warn'
  onClick?: () => void
}) {
  const toneClasses =
    tone === 'warn'
      ? 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30'
      : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
  const valueClasses =
    tone === 'warn'
      ? 'text-amber-800 dark:text-amber-200'
      : 'text-slate-900 dark:text-slate-100'
  const Body = (
    <div
      className={cn(
        'flex flex-col gap-0.5 rounded-md border px-3 py-2 transition-colors',
        toneClasses,
        onClick && 'cursor-pointer hover:border-slate-400 dark:hover:border-slate-600',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <Icon className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        {loading ? (
          <Skeleton variant="text" width={48} />
        ) : (
          <span className={cn('text-2xl font-semibold tabular-nums', valueClasses)}>
            {value}
          </span>
        )}
        {help && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {help}
          </span>
        )}
      </div>
    </div>
  )
  if (!onClick) return Body
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left"
      aria-label={`${label}: ${value} — click to filter`}
    >
      {Body}
    </button>
  )
}

// DR-A.1 — fields the per-row AI fill action targets. Title (name)
// gets generated when the product is still on the NEW-…/Untitled
// stub; description always benefits from a regenerate when missing
// or under-length. Bullets + keywords land in Product columns the
// downstream wizard reads, so they're worth populating eagerly even
// when the operator hasn't reached those steps yet.
const AI_FILL_FIELDS = ['title', 'description', 'bullets', 'keywords'] as const

// Heuristic: AI fill is only useful when there's actually room to
// fill. Don't show the button on rows that are already 100% — the
// action would overwrite good data with regenerated text.
function canAiFill(d: Draft): boolean {
  if (d.completenessPct >= 100) return false
  return d.missingFactors.some(
    (f) => f === 'name' || f === 'description',
  )
}

// DR-A.3 — AI category suggest needs a working name to ground the
// LLM. Without a name (operator hasn't filled the title yet) the
// model has nothing to derive brand/type from, so the chip stays
// non-interactive.
function canAiSuggest(d: Draft): boolean {
  return !d.missingFactors.includes('name')
}

// E.18 — memoized draft row. Was a 150-line inline `<tr>` inside
// drafts.map(...) which re-rendered every row on every parent state
// change (selection, search-typing, filter changes). Now extracted
// as a real component with stable callback props + isSelected
// boolean — React.memo skips the row when its data + boolean
// haven't changed.
const DraftRow = memo(function DraftRow({
  draft: d,
  isSelected,
  onToggleSelect,
  onDelete,
  onAiFill,
  aiFilling,
  onAiSuggest,
  aiSuggesting,
}: {
  draft: Draft
  isSelected: boolean
  onToggleSelect: (d: Draft) => void
  onDelete: (d: Draft) => void
  onAiFill: (d: Draft) => void
  aiFilling: boolean
  onAiSuggest: (d: Draft) => void
  aiSuggesting: boolean
}) {
  // useTranslations() is stable across renders (the t function is
  // memoized in the provider) so the memo equality check holds.
  const { t } = useTranslations()
  const totalSteps = 9
  const pct =
    d.kind === 'wizard' && typeof d.currentStep === 'number'
      ? Math.min(100, Math.round((d.currentStep / totalSteps) * 100))
      : 0
  const resumeHref =
    d.kind === 'wizard'
      ? `/products/${d.productId}/list-wizard`
      : `/products/${d.productId}/edit`
  return (
    <tr
      className={cn(
        'border-b border-slate-100 dark:border-slate-800 last:border-0 transition-colors',
        d.isStale
          ? 'bg-amber-50/50 hover:bg-amber-50 dark:bg-amber-950/20 dark:hover:bg-amber-950/30'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
        isSelected && 'bg-blue-50/40 dark:bg-blue-950/30',
      )}
    >
      <td className="px-4 py-2.5">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(d)}
          aria-label={`Select ${d.productName ?? d.productSku ?? 'draft'}`}
          className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-2 focus:ring-blue-500"
        />
      </td>
      <td className="px-4 py-2.5">
        <Link href={resumeHref} className="block min-w-0">
          <div className="text-slate-900 dark:text-slate-100 truncate max-w-[420px] flex items-center gap-2">
            {d.kind === 'product' && (
              <Tooltip
                content="Standalone product without a wizard yet"
                placement="top"
              >
                <span className="inline-flex items-center justify-center w-4 h-4 text-slate-400 dark:text-slate-500">
                  <Box className="w-3 h-3" aria-hidden="true" />
                </span>
              </Tooltip>
            )}
            {d.productName ?? <em className="text-slate-400 dark:text-slate-500">Untitled</em>}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 font-mono mt-0.5 flex items-center gap-2">
            <span>{d.productSku ?? '—'}</span>
            {d.productIsParent && (
              <span className="inline-flex items-center h-4 px-1 rounded text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                parent
              </span>
            )}
          </div>
        </Link>
      </td>
      <td className="px-4 py-2.5">
        <div className="flex flex-wrap gap-1">
          {d.channels.length === 0 && (
            <span className="text-slate-400 dark:text-slate-500 text-sm">
              {d.kind === 'product' ? 'no wizard yet' : 'none yet'}
            </span>
          )}
          {d.channels.map((c, i) => {
            const tone =
              CHANNEL_TONE[c.platform] ??
              'bg-slate-100 text-slate-700 border-slate-200'
            return (
              <span
                key={`${c.platform}:${c.marketplace}:${i}`}
                className={cn(
                  'inline-flex items-center h-5 px-1.5 rounded text-xs font-medium border',
                  tone,
                )}
              >
                <span className="font-mono">{c.platform}</span>
                <span className="opacity-50 mx-0.5">·</span>
                <span>{c.marketplace}</span>
              </span>
            )
          })}
        </div>
      </td>
      <td className="px-4 py-2.5">
        {d.kind === 'wizard' && typeof d.currentStep === 'number' ? (
          <div className="flex flex-col gap-1 min-w-[140px]">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center h-5 px-1.5 rounded text-xs font-semibold tabular-nums bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                {d.currentStep}/{totalSteps}
              </span>
              <span className="text-slate-600 dark:text-slate-300 text-sm truncate">
                {STEP_LABELS[d.currentStep] ?? `Step ${d.currentStep}`}
              </span>
            </div>
            <div className="h-1 w-full bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
              <div
                className="h-full bg-blue-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            {/* DR-S.2 — product-data completeness, separate signal
                from wizard step progress. DR-S.3 — top missing
                factors inline so the operator knows what's blocking
                this draft from being publishable. */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <CompletenessBadge
                pct={d.completenessPct}
                missing={d.missingFactors}
              />
              <MissingFactorChips
                missing={d.missingFactors}
                t={t}
                canSuggest={canAiSuggest(d)}
                suggesting={aiSuggesting}
                onSuggest={() => onAiSuggest(d)}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1 min-w-[140px]">
            <span className="inline-flex items-center h-5 px-1.5 rounded text-xs font-semibold uppercase tracking-wide bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 self-start">
              Product · DRAFT
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <CompletenessBadge
                pct={d.completenessPct}
                missing={d.missingFactors}
              />
              <MissingFactorChips
                missing={d.missingFactors}
                t={t}
                canSuggest={canAiSuggest(d)}
                suggesting={aiSuggesting}
                onSuggest={() => onAiSuggest(d)}
              />
            </div>
          </div>
        )}
      </td>
      <td className="px-4 py-2.5">
        <Tooltip
          content={new Date(d.updatedAt).toLocaleString()}
          placement="top"
        >
          <span
            className={cn(
              'text-sm cursor-default',
              d.isStale
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-slate-500 dark:text-slate-400',
            )}
          >
            {formatRelative(d.updatedAt)}
            {d.isStale && (
              <span className="ml-1 text-xs uppercase tracking-wide font-semibold text-amber-700 dark:text-amber-300">
                stale
              </span>
            )}
          </span>
        </Tooltip>
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="inline-flex items-center gap-1.5">
          {/* DR-A.1 — per-row AI fill. Hidden on rows at 100% (no
              gaps to fill) or where the missing factors are
              non-AI-fillable (price, brand, etc — those need the
              operator). Spinner replaces the icon while the call
              is in flight. */}
          {canAiFill(d) && (
            <Tooltip content={t('drafts.aiFillTooltip')} placement="top">
              <IconButton
                onClick={() => onAiFill(d)}
                aria-label={t('drafts.aiFill')}
                disabled={aiFilling}
                size="md"
                className="h-11 w-11 sm:h-7 sm:w-7 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-60"
              >
                {aiFilling ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip
            content={
              d.kind === 'wizard'
                ? 'Discard this draft'
                : 'Delete this DRAFT product'
            }
            placement="top"
          >
            {/* DR-S.5 — touch-target sweep: bump destructive + primary
                row actions to ≥44×44 on mobile, keep desktop density
                via the sm: breakpoint so power-users on a mouse get
                the same compact rows as before. */}
            <IconButton
              onClick={() => onDelete(d)}
              aria-label="Delete draft"
              size="md"
              className="h-11 w-11 sm:h-7 sm:w-7 text-slate-400 dark:text-slate-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:text-rose-300 dark:hover:bg-rose-950/40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </IconButton>
          </Tooltip>
          <Link
            href={resumeHref}
            className="inline-flex items-center gap-1 h-11 sm:h-7 px-3 sm:px-2.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            {d.kind === 'wizard' ? t('drafts.resume') : t('drafts.configure')}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </td>
    </tr>
  )
})

export default function DraftsClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { t } = useTranslations()

  // C.3 — URL state. Filters, sort, and source are now bookmarkable
  // and reload-stable. The mounting read of `params` seeds local
  // state; subsequent updates write back to the URL via replace
  // (no scroll, no history bump per change).
  const initialSearch = params.get('q') ?? ''
  const initialStale = params.get('stale') === '1'
  const initialSort = ((): SortOption => {
    const s = (params.get('sort') ?? 'recency').toLowerCase()
    return SORT_OPTIONS.some((o) => o.value === s)
      ? (s as SortOption)
      : 'recency'
  })()
  const initialSource = ((): SourceFilter => {
    const s = (params.get('source') ?? 'all').toLowerCase()
    return SOURCE_OPTIONS.some((o) => o.value === s)
      ? (s as SourceFilter)
      : 'all'
  })()

  const [search, setSearch] = useState(initialSearch)
  const [staleOnly, setStaleOnly] = useState(initialStale)
  const [sort, setSort] = useState<SortOption>(initialSort)
  const [source, setSource] = useState<SourceFilter>(initialSource)

  // 250ms search debounce — keeps the input snappy while batching the
  // network round-trip. Same pattern as UniversalFilterBar.
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Sync local state → URL via router.replace. scroll: false avoids
  // jumping the page on every keystroke; the empty-string check
  // strips empty params for clean URLs.
  useEffect(() => {
    const next = new URLSearchParams()
    if (debouncedSearch) next.set('q', debouncedSearch)
    if (staleOnly) next.set('stale', '1')
    if (sort !== 'recency') next.set('sort', sort)
    if (source !== 'all') next.set('source', source)
    const qs = next.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [debouncedSearch, staleOnly, sort, source, router])

  const url = useMemo(() => {
    const p = new URLSearchParams()
    if (debouncedSearch) p.set('search', debouncedSearch)
    if (staleOnly) p.set('stale', '1')
    p.set('sort', sort)
    p.set(
      'include',
      source === 'all' ? 'all' : source === 'wizards' ? 'wizards' : 'products',
    )
    p.set('limit', '100')
    return `/api/listing-wizard/drafts?${p.toString()}`
  }, [debouncedSearch, staleOnly, sort, source])

  const { data, loading, error, lastFetchedAt, refetch } =
    usePolledList<DraftsResponse>({
      url,
      intervalMs: 30_000,
      // wizard.* keeps wizard rows fresh; product.deleted/created/updated
      // keeps the Product DRAFT side in sync. wizard.created (C.7) lets
      // a fresh wizard opened in another tab appear here within ~200ms
      // instead of waiting for the 30s polling tick.
      invalidationTypes: [
        'wizard.created',
        'wizard.submitted',
        'wizard.deleted',
        'product.deleted',
        'product.created',
        'product.updated',
      ],
    })

  // DR-S.1 — KPI strip. Separate fetch from the list so the strip
  // shows aggregate counts independent of the active filters (an
  // operator filtered to staleOnly should still see the global
  // total). Polled on the same 30s cadence and refreshed on the
  // same invalidation events.
  const [summary, setSummary] = useState<DraftsSummary | null>(null)
  const summaryUrl = useMemo(
    () => `${getBackendUrl()}/api/listing-wizard/drafts/summary`,
    [],
  )
  const fetchSummary = useCallback(async () => {
    try {
      const r = await fetch(summaryUrl, { cache: 'no-store' })
      if (r.ok) setSummary((await r.json()) as DraftsSummary)
    } catch {
      // Strip is informational; swallow errors so the list stays usable.
    }
  }, [summaryUrl])
  useEffect(() => {
    void fetchSummary()
    const id = window.setInterval(() => void fetchSummary(), 30_000)
    return () => window.clearInterval(id)
  }, [fetchSummary])
  useInvalidationChannel(
    [
      'wizard.created',
      'wizard.submitted',
      'wizard.deleted',
      'product.deleted',
      'product.created',
      'product.updated',
    ],
    () => {
      void fetchSummary()
    },
  )

  const draftsRaw = data?.drafts ?? []
  // C.12 — optimistic-delete state. Keys hidden here disappear from
  // the displayed list immediately on a delete attempt, before the
  // server confirms. On success the next poll cycle naturally drops
  // them from `drafts` (server side gone too), so the hidden set
  // can clear without a flicker. On error we clear the hidden set
  // so the rows reappear and the operator sees the error toast.
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(
    new Set(),
  )
  const drafts = useMemo(
    () =>
      optimisticallyHidden.size === 0
        ? draftsRaw
        : draftsRaw.filter((d) => !optimisticallyHidden.has(selectionKey(d))),
    [draftsRaw, optimisticallyHidden],
  )
  // When the server's drafts list refreshes, drop any hidden keys
  // that the server has already removed — keeps the hidden set from
  // growing unbounded across many delete cycles.
  useEffect(() => {
    if (optimisticallyHidden.size === 0) return
    const presentKeys = new Set(draftsRaw.map(selectionKey))
    setOptimisticallyHidden((prev) => {
      const next = new Set<string>()
      for (const k of prev) if (presentKeys.has(k)) next.add(k)
      return next.size === prev.size ? prev : next
    })
  }, [draftsRaw, optimisticallyHidden.size])
  const total = data?.total ?? 0
  const staleCount = useMemo(
    () => drafts.filter((d) => d.isStale).length,
    [drafts],
  )

  // Selection state — composite keys so wizard+product ids can coexist.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // When the underlying list changes, drop selections for rows no
  // longer present (e.g. a draft was discarded in another tab).
  useEffect(() => {
    setSelectedKeys((prev) => {
      const presentKeys = new Set(drafts.map(selectionKey))
      const next = new Set<string>()
      for (const k of prev) if (presentKeys.has(k)) next.add(k)
      return next.size === prev.size ? prev : next
    })
  }, [drafts])

  const toggleSelect = useCallback((d: Draft) => {
    setSelectedKeys((prev) => {
      const k = selectionKey(d)
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const allVisibleSelected =
    drafts.length > 0 && drafts.every((d) => selectedKeys.has(selectionKey(d)))
  const someVisibleSelected = drafts.some((d) =>
    selectedKeys.has(selectionKey(d)),
  )
  const toggleSelectAll = useCallback(() => {
    setSelectedKeys((prev) => {
      if (drafts.every((d) => prev.has(selectionKey(d)))) {
        const next = new Set(prev)
        for (const d of drafts) next.delete(selectionKey(d))
        return next
      }
      const next = new Set(prev)
      for (const d of drafts) next.add(selectionKey(d))
      return next
    })
  }, [drafts])

  // Delete plumbing.
  const confirm = useConfirm()
  const { toast } = useToast()
  const [busyDelete, setBusyDelete] = useState(false)

  const performBulkDelete = useCallback(
    async (rows: Draft[]) => {
      if (rows.length === 0) return
      const wizardIds = rows
        .filter((d) => d.kind === 'wizard')
        .map((d) => d.id)
      const productIds = rows
        .filter((d) => d.kind === 'product')
        .map((d) => d.id)
      // C.12 — optimistic remove: hide rows immediately so the
      // operator sees the result before the server confirms. We
      // remember the set so we can restore on error.
      const optimisticKeys = rows.map(selectionKey)
      setOptimisticallyHidden((prev) => {
        const next = new Set(prev)
        for (const k of optimisticKeys) next.add(k)
        return next
      })
      setBusyDelete(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/drafts/bulk-delete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wizardIds, productIds }),
          },
        )
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean
          wizardsDiscarded?: number
          productsDeleted?: number
          productsSkipped?: number
          error?: string
        }
        if (!res.ok || !json.success) {
          // Roll back: rows reappear in the list.
          setOptimisticallyHidden((prev) => {
            const next = new Set(prev)
            for (const k of optimisticKeys) next.delete(k)
            return next
          })
          toast({
            tone: 'error',
            title: 'Delete failed',
            description: json.error ?? `HTTP ${res.status}`,
          })
          return
        }
        const wd = json.wizardsDiscarded ?? 0
        const pd = json.productsDeleted ?? 0
        const total = wd + pd
        toast({
          tone: 'success',
          title: `Deleted ${total} draft${total === 1 ? '' : 's'}`,
          description:
            (json.productsSkipped ?? 0) > 0
              ? `${json.productsSkipped} non-DRAFT product${json.productsSkipped === 1 ? '' : 's'} skipped.`
              : undefined,
        })
        // Local clear + cross-tab broadcast.
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          for (const r of rows) next.delete(selectionKey(r))
          return next
        })
        for (const id of wizardIds) {
          emitInvalidation({ type: 'wizard.deleted', id })
        }
        for (const id of productIds) {
          emitInvalidation({ type: 'product.deleted', id })
        }
        await refetch()
      } catch (err) {
        // Network error or unexpected throw — roll back optimistic
        // hide so the rows reappear, and surface the failure.
        setOptimisticallyHidden((prev) => {
          const next = new Set(prev)
          for (const k of optimisticKeys) next.delete(k)
          return next
        })
        toast({
          tone: 'error',
          title: 'Delete failed',
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setBusyDelete(false)
      }
    },
    [toast, refetch],
  )

  // DR-A.1 — per-row AI fill plumbing. The set tracks which productIds
  // are currently in-flight so the spinner only shows on the matching
  // row (operator can fire AI fill on multiple rows in parallel and
  // each one shows its own state).
  const [aiBusyIds, setAiBusyIds] = useState<Set<string>>(new Set())
  const onAiFillRow = useCallback(
    async (d: Draft) => {
      if (aiBusyIds.has(d.productId)) return
      setAiBusyIds((prev) => new Set(prev).add(d.productId))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/ai/bulk-generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              productIds: [d.productId],
              fields: AI_FILL_FIELDS,
              // Awa's primary marketplace; future commit can let the
              // operator pick when wizard.channels[].marketplace
              // diverges from IT.
              marketplace: 'IT',
            }),
          },
        )
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          if (res.status === 503) {
            toast({
              tone: 'error',
              title: t('drafts.aiFillUnavailable'),
              description: json.error,
            })
          } else if (res.status === 429) {
            toast({
              tone: 'warning',
              title: t('drafts.aiFillRateLimited'),
            })
          } else {
            toast({
              tone: 'error',
              title: t('drafts.aiFillFailed'),
              description: json.error ?? `HTTP ${res.status}`,
            })
          }
          return
        }
        const json = (await res.json()) as {
          results?: Array<{ ok: boolean; error?: string; written?: string[] }>
        }
        const r = json.results?.[0]
        if (!r?.ok) {
          toast({
            tone: 'error',
            title: t('drafts.aiFillFailed'),
            description: r?.error,
          })
          return
        }
        toast({
          tone: 'success',
          title: t('drafts.aiFillDone'),
          description: r.written?.join(', '),
        })
        // Cross-tab broadcast + local refresh.
        emitInvalidation({ type: 'product.updated', id: d.productId })
        await refetch()
        await fetchSummary()
      } catch (err) {
        toast({
          tone: 'error',
          title: t('drafts.aiFillFailed'),
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setAiBusyIds((prev) => {
          const next = new Set(prev)
          next.delete(d.productId)
          return next
        })
      }
    },
    [aiBusyIds, toast, refetch, fetchSummary, t],
  )

  const onDeleteRow = useCallback(
    async (d: Draft) => {
      const ok = await confirm({
        title: d.kind === 'wizard' ? 'Discard this draft?' : 'Delete this DRAFT product?',
        description:
          d.kind === 'wizard'
            ? `The wizard's progress for ${d.productName ?? d.productSku ?? 'this product'} will be removed. This can't be undone.`
            : `${d.productName ?? d.productSku ?? 'This product'} will be deleted permanently. Only DRAFT-status products are removable here.`,
        confirmLabel: 'Delete draft',
        tone: 'danger',
      })
      if (!ok) return
      await performBulkDelete([d])
    },
    [confirm, performBulkDelete],
  )

  // DR-A.3 — AI brand+type suggestion. Hits the existing P.14
  // /api/products/:id/ai/suggest-fields endpoint, which returns
  // { brand, productType, reasoning } without applying anything;
  // operator gets a toast with the suggested values + an Apply
  // action button that PATCHes the product. Re-uses the aiBusyIds
  // set so a row already running per-row AI fill blocks suggest
  // until that finishes (avoids stale-write conflicts).
  const [aiSuggestBusyIds, setAiSuggestBusyIds] = useState<Set<string>>(
    new Set(),
  )
  const onAiSuggestRow = useCallback(
    async (d: Draft) => {
      if (aiSuggestBusyIds.has(d.productId)) return
      setAiSuggestBusyIds((prev) => new Set(prev).add(d.productId))
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${d.productId}/ai/suggest-fields`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          if (res.status === 503) {
            toast({
              tone: 'error',
              title: t('drafts.aiFillUnavailable'),
              description: json.error,
            })
          } else if (res.status === 429) {
            toast({ tone: 'warning', title: t('drafts.aiFillRateLimited') })
          } else {
            toast({
              tone: 'error',
              title: t('drafts.aiSuggestFailed'),
              description: json.error ?? `HTTP ${res.status}`,
            })
          }
          return
        }
        const json = (await res.json()) as {
          suggestions?: {
            brand?: string | null
            productType?: string | null
            reasoning?: string
          }
        }
        const s = json.suggestions ?? {}
        const proposed: Record<string, string> = {}
        if (s.brand && d.missingFactors.includes('brand')) proposed.brand = s.brand
        if (s.productType && d.missingFactors.includes('type'))
          proposed.productType = s.productType
        if (Object.keys(proposed).length === 0) {
          toast({
            tone: 'info',
            title: t('drafts.aiSuggestEmpty'),
            description: s.reasoning,
          })
          return
        }
        // Build a human-readable summary for the toast and an Apply
        // action that PATCHes the product. PATCH is best-effort: on
        // failure show another toast, don't try to roll back the
        // suggestion display.
        const summary = Object.entries(proposed)
          .map(([k, v]) => `${k} = ${v}`)
          .join(', ')
        toast({
          tone: 'info',
          title: t('drafts.aiSuggestReady'),
          description: `${summary}${s.reasoning ? ` — ${s.reasoning}` : ''}`,
          action: {
            label: t('drafts.aiSuggestApply'),
            onClick: async () => {
              try {
                const patch = await fetch(
                  `${getBackendUrl()}/api/products/${d.productId}`,
                  {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(proposed),
                  },
                )
                if (!patch.ok) {
                  const j = (await patch.json().catch(() => ({}))) as {
                    error?: string
                  }
                  toast({
                    tone: 'error',
                    title: t('drafts.aiSuggestApplyFailed'),
                    description: j.error ?? `HTTP ${patch.status}`,
                  })
                  return
                }
                toast({
                  tone: 'success',
                  title: t('drafts.aiSuggestApplied'),
                  description: summary,
                })
                emitInvalidation({
                  type: 'product.updated',
                  id: d.productId,
                })
                await refetch()
                await fetchSummary()
              } catch (err) {
                toast({
                  tone: 'error',
                  title: t('drafts.aiSuggestApplyFailed'),
                  description: err instanceof Error ? err.message : String(err),
                })
              }
            },
          },
        })
      } catch (err) {
        toast({
          tone: 'error',
          title: t('drafts.aiSuggestFailed'),
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setAiSuggestBusyIds((prev) => {
          const next = new Set(prev)
          next.delete(d.productId)
          return next
        })
      }
    },
    [aiSuggestBusyIds, toast, refetch, fetchSummary, t],
  )

  // DR-A.2 — bulk AI fill across the current selection. Filters to
  // rows where AI fill makes sense (canAiFill) so the action doesn't
  // overwrite already-complete drafts. Fans out a single
  // /api/products/ai/bulk-generate call (capped at 50 per request
  // by the endpoint, rate-limited at 5/min) so the operator sees
  // one toast for the batch instead of N.
  const [busyBulkAi, setBusyBulkAi] = useState(false)
  const onBulkAiFill = useCallback(async () => {
    const selectedRows = drafts.filter((d) =>
      selectedKeys.has(selectionKey(d)),
    )
    const eligible = selectedRows.filter(canAiFill)
    if (eligible.length === 0) {
      toast({
        tone: 'info',
        title: t('drafts.aiFillNoneEligible'),
      })
      return
    }
    if (eligible.length > 50) {
      toast({
        tone: 'warning',
        title: t('drafts.aiFillTooMany', { n: eligible.length }),
      })
      return
    }
    setBusyBulkAi(true)
    // Mark every eligible row as in-flight for the spinner UX.
    setAiBusyIds((prev) => {
      const next = new Set(prev)
      for (const r of eligible) next.add(r.productId)
      return next
    })
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/ai/bulk-generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds: eligible.map((d) => d.productId),
            fields: AI_FILL_FIELDS,
            marketplace: 'IT',
          }),
        },
      )
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (res.status === 503) {
          toast({
            tone: 'error',
            title: t('drafts.aiFillUnavailable'),
            description: json.error,
          })
        } else if (res.status === 429) {
          toast({ tone: 'warning', title: t('drafts.aiFillRateLimited') })
        } else {
          toast({
            tone: 'error',
            title: t('drafts.aiFillFailed'),
            description: json.error ?? `HTTP ${res.status}`,
          })
        }
        return
      }
      const json = (await res.json()) as {
        results?: Array<{ productId: string; ok: boolean; error?: string }>
      }
      const results = json.results ?? []
      const okCount = results.filter((r) => r.ok).length
      const failCount = results.length - okCount
      toast({
        tone: failCount === 0 ? 'success' : 'warning',
        title: t('drafts.aiFillBulkDone', { ok: okCount, fail: failCount }),
        description:
          failCount > 0
            ? results
                .filter((r) => !r.ok)
                .slice(0, 3)
                .map((r) => `${r.productId}: ${r.error ?? '?'}`)
                .join('; ')
            : undefined,
      })
      for (const r of results) {
        if (r.ok) emitInvalidation({ type: 'product.updated', id: r.productId })
      }
      await refetch()
      await fetchSummary()
    } catch (err) {
      toast({
        tone: 'error',
        title: t('drafts.aiFillFailed'),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setBusyBulkAi(false)
      setAiBusyIds((prev) => {
        const next = new Set(prev)
        for (const r of eligible) next.delete(r.productId)
        return next
      })
    }
  }, [drafts, selectedKeys, toast, refetch, fetchSummary, t])

  const onBulkDelete = useCallback(async () => {
    const selectedRows = drafts.filter((d) =>
      selectedKeys.has(selectionKey(d)),
    )
    if (selectedRows.length === 0) return
    const wizardCount = selectedRows.filter((d) => d.kind === 'wizard').length
    const productCount = selectedRows.length - wizardCount
    const summary = [
      wizardCount > 0 ? `${wizardCount} wizard draft${wizardCount === 1 ? '' : 's'}` : null,
      productCount > 0 ? `${productCount} DRAFT product${productCount === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' and ')
    const ok = await confirm({
      title: `Delete ${selectedRows.length} draft${selectedRows.length === 1 ? '' : 's'}?`,
      description: `${summary} will be removed. Wizard progress can't be recovered; product DRAFTs will be hard-deleted.`,
      confirmLabel: 'Delete drafts',
      tone: 'danger',
    })
    if (!ok) return
    await performBulkDelete(selectedRows)
  }, [drafts, selectedKeys, confirm, performBulkDelete])

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title={t('drafts.title')}
        description={t('drafts.description')}
        breadcrumbs={[
          { label: t('nav.products'), href: '/products' },
          { label: t('nav.drafts') },
        ]}
        actions={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={refetch}
            loading={loading}
            error={!!error}
          />
        }
      />

      {/* DR-S.1 — KPI strip. Numbers reflect the unfiltered total
          set so the operator sees scope at a glance, regardless of
          which filters are active. Stale tile is clickable: tapping
          it scopes the list to stale-only as a quick triage path. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KpiTile
          icon={Layers}
          label={t('drafts.kpi.total')}
          value={summary?.total ?? '—'}
          help={t('drafts.kpi.totalHelp')}
          loading={!summary}
        />
        <KpiTile
          icon={Clock}
          label={t('drafts.kpi.stale')}
          value={summary?.stale ?? '—'}
          help={t('drafts.kpi.staleHelp')}
          loading={!summary}
          tone={(summary?.stale ?? 0) > 0 ? 'warn' : 'default'}
          onClick={
            (summary?.stale ?? 0) > 0
              ? () => setStaleOnly(true)
              : undefined
          }
        />
        <KpiTile
          icon={Hourglass}
          label={t('drafts.kpi.expiring')}
          value={summary?.expiring ?? '—'}
          help={t('drafts.kpi.expiringHelp')}
          loading={!summary}
          tone={(summary?.expiring ?? 0) > 0 ? 'warn' : 'default'}
        />
        <KpiTile
          icon={FileEdit}
          label={t('drafts.kpi.oldest')}
          value={formatAgeDays(summary?.oldestCreatedAt ?? null)}
          help={t('drafts.kpi.oldestHelp')}
          loading={!summary}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('drafts.searchPlaceholder')}
            className="w-full h-8 pl-8 pr-3 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
          />
        </div>

        <Tooltip
          content="Show only drafts untouched for more than 7 days"
          placement="bottom"
        >
          <button
            type="button"
            onClick={() => setStaleOnly((v) => !v)}
            className={cn(
              // DR-S.5 — 44px on mobile, original 32px on desktop.
              'inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 sm:px-2.5 text-base rounded-md border transition-colors',
              staleOnly
                ? 'bg-amber-50 border-amber-300 text-amber-800 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200'
                : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600',
            )}
            aria-pressed={staleOnly}
          >
            <Clock className="w-3 h-3" />
            {t('drafts.staleOnly')}
            {staleCount > 0 && !staleOnly && (
              <span className="text-xs text-amber-700 dark:text-amber-300 font-semibold ml-1">
                {staleCount}
              </span>
            )}
          </button>
        </Tooltip>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceFilter)}
          aria-label="Filter by source"
          className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:focus:border-blue-500"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          aria-label="Sort drafts"
          className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:focus:border-blue-500"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk-action toolbar — appears only with active selection. */}
      {selectedKeys.size > 0 && (() => {
        // DR-A.2 — count selected rows that AI fill can actually
        // help. Surfaced on the bulk button so the operator sees
        // exactly how many rows the action will touch.
        const eligibleAiCount = drafts.filter(
          (d) => selectedKeys.has(selectionKey(d)) && canAiFill(d),
        ).length
        return (
          <div
            role="toolbar"
            aria-label="Bulk draft actions"
            className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-md bg-blue-50 border border-blue-200 text-blue-900 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-100"
          >
            <span className="text-base font-medium tabular-nums">
              {t('drafts.bulkSelected', { n: selectedKeys.size })}
            </span>
            <span className="text-blue-300 dark:text-blue-700">·</span>
            {eligibleAiCount > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onBulkAiFill}
                disabled={busyBulkAi}
                className="!bg-violet-600 !text-white hover:!bg-violet-700 disabled:opacity-60"
              >
                {busyBulkAi ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {t('drafts.aiFillN', { n: eligibleAiCount })}
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={onBulkDelete}
              disabled={busyDelete}
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('drafts.deleteN', { n: selectedKeys.size })}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSelectedKeys(new Set())}
            >
              <X className="w-3.5 h-3.5" />
              {t('drafts.clearSelection')}
            </Button>
          </div>
        )
      })()}

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>Failed to load drafts: {error}</span>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg bg-white overflow-x-auto dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[720px] text-base">
          <thead className="bg-slate-50 border-b border-slate-200 dark:bg-slate-900 dark:border-slate-800">
            <tr className="text-left text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <th className="px-4 py-2.5 w-[40px]">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  // Indeterminate state can't be set via attribute alone;
                  // ref callback toggles the DOM property when partial.
                  ref={(el) => {
                    if (el) {
                      el.indeterminate =
                        someVisibleSelected && !allVisibleSelected
                    }
                  }}
                  onChange={toggleSelectAll}
                  aria-label="Select all visible drafts"
                  className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-2 focus:ring-blue-500"
                />
              </th>
              <th className="px-4 py-2.5">{t('drafts.col.product')}</th>
              <th className="px-4 py-2.5">{t('drafts.col.channels')}</th>
              <th className="px-4 py-2.5">{t('drafts.col.step')}</th>
              <th className="px-4 py-2.5">{t('drafts.col.lastUpdated')}</th>
              <th className="px-4 py-2.5 w-[140px]" />
            </tr>
          </thead>
          <tbody>
            {loading && drafts.length === 0 && (
              <>
                {Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-3">
                      <Skeleton variant="block" width={16} height={16} />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton variant="text" lines={2} />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton variant="pill" width={80} />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton variant="text" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton variant="text" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton variant="block" width={100} height={28} />
                    </td>
                  </tr>
                ))}
              </>
            )}

            {!loading && drafts.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center">
                  <FileEdit className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600" />
                  <div className="mt-2 text-slate-500 dark:text-slate-400">
                    {debouncedSearch || staleOnly || source !== 'all'
                      ? t('common.noResults')
                      : t('drafts.empty')}
                  </div>
                  <div className="mt-1 text-sm text-slate-400 dark:text-slate-500">
                    {t('drafts.emptyHint')}
                  </div>
                </td>
              </tr>
            )}

            {drafts.map((d) => {
              const k = selectionKey(d)
              const isSelected = selectedKeys.has(k)
              return (
                <DraftRow
                  key={k}
                  draft={d}
                  isSelected={isSelected}
                  onToggleSelect={toggleSelect}
                  onDelete={onDeleteRow}
                  onAiFill={onAiFillRow}
                  aiFilling={aiBusyIds.has(d.productId)}
                  onAiSuggest={onAiSuggestRow}
                  aiSuggesting={aiSuggestBusyIds.has(d.productId)}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {!loading && drafts.length > 0 && (
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Showing {drafts.length} of {total} drafts
          {staleCount > 0 && !staleOnly && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setStaleOnly(true)}
                className="text-amber-700 dark:text-amber-300 hover:underline"
              >
                {staleCount} stale (&gt; 7 days)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
