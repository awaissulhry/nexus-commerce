'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowRight,
  Box,
  Clock,
  FileEdit,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePolledList } from '@/lib/sync/use-polled-list'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import PageHeader from '@/components/layout/PageHeader'
import { CHANNEL_TONE } from '@/lib/theme'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
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
}

interface DraftsResponse {
  success: boolean
  total: number
  drafts: Draft[]
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

  const drafts = data?.drafts ?? []
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
        description={t('drafts.emptyHint')}
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

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
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
              'inline-flex items-center gap-1.5 h-8 px-2.5 text-base rounded-md border transition-colors',
              staleOnly
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
            )}
            aria-pressed={staleOnly}
          >
            <Clock className="w-3 h-3" />
            {t('drafts.staleOnly')}
            {staleCount > 0 && !staleOnly && (
              <span className="text-xs text-amber-700 font-semibold ml-1">
                {staleCount}
              </span>
            )}
          </button>
        </Tooltip>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourceFilter)}
          aria-label="Filter by source"
          className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
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
          className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk-action toolbar — appears only with active selection. */}
      {selectedKeys.size > 0 && (
        <div
          role="toolbar"
          aria-label="Bulk draft actions"
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-blue-50 border border-blue-200 text-blue-900"
        >
          <span className="text-base font-medium tabular-nums">
            {t('drafts.bulkSelected', { n: selectedKeys.size })}
          </span>
          <span className="text-blue-300">·</span>
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
      )}

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>Failed to load drafts: {error}</span>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-base">
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
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
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
                  <tr key={i} className="border-b border-slate-100">
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
                  <FileEdit className="w-6 h-6 mx-auto text-slate-300" />
                  <div className="mt-2 text-slate-500">
                    {debouncedSearch || staleOnly || source !== 'all'
                      ? t('common.noResults')
                      : t('drafts.empty')}
                  </div>
                  <div className="mt-1 text-sm text-slate-400">
                    {t('drafts.emptyHint')}
                  </div>
                </td>
              </tr>
            )}

            {drafts.map((d) => {
              const totalSteps = 9
              const pct =
                d.kind === 'wizard' && typeof d.currentStep === 'number'
                  ? Math.min(
                      100,
                      Math.round((d.currentStep / totalSteps) * 100),
                    )
                  : 0
              const k = selectionKey(d)
              const isSelected = selectedKeys.has(k)
              const resumeHref =
                d.kind === 'wizard'
                  ? `/products/${d.productId}/list-wizard`
                  : `/products/${d.productId}/edit`
              return (
                <tr
                  key={k}
                  className={cn(
                    'border-b border-slate-100 last:border-0 transition-colors',
                    d.isStale
                      ? 'bg-amber-50/50 hover:bg-amber-50'
                      : 'hover:bg-slate-50',
                    isSelected && 'bg-blue-50/40',
                  )}
                >
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(d)}
                      aria-label={`Select ${d.productName ?? d.productSku ?? 'draft'}`}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={resumeHref}
                      className="block min-w-0"
                    >
                      <div className="text-slate-900 truncate max-w-[420px] flex items-center gap-2">
                        {d.kind === 'product' && (
                          <Tooltip
                            content="Standalone product without a wizard yet"
                            placement="top"
                          >
                            <span className="inline-flex items-center justify-center w-4 h-4 text-slate-400">
                              <Box className="w-3 h-3" aria-hidden="true" />
                            </span>
                          </Tooltip>
                        )}
                        {d.productName ?? (
                          <em className="text-slate-400">Untitled</em>
                        )}
                      </div>
                      <div className="text-sm text-slate-500 font-mono mt-0.5 flex items-center gap-2">
                        <span>{d.productSku ?? '—'}</span>
                        {d.productIsParent && (
                          <span className="inline-flex items-center h-4 px-1 rounded text-xs font-medium bg-blue-50 text-blue-700">
                            parent
                          </span>
                        )}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {d.channels.length === 0 && (
                        <span className="text-slate-400 text-sm">
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
                      <div className="flex flex-col gap-1 min-w-[120px]">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center h-5 px-1.5 rounded text-xs font-semibold tabular-nums bg-blue-50 text-blue-700">
                            {d.currentStep}/{totalSteps}
                          </span>
                          <span className="text-slate-600 text-sm truncate">
                            {STEP_LABELS[d.currentStep] ?? `Step ${d.currentStep}`}
                          </span>
                        </div>
                        <div className="h-1 w-full bg-slate-100 rounded overflow-hidden">
                          <div
                            className="h-full bg-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center h-5 px-1.5 rounded text-xs font-semibold uppercase tracking-wide bg-slate-100 text-slate-600">
                        Product · DRAFT
                      </span>
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
                          d.isStale ? 'text-amber-700' : 'text-slate-500',
                        )}
                      >
                        {formatRelative(d.updatedAt)}
                        {d.isStale && (
                          <span className="ml-1 text-xs uppercase tracking-wide font-semibold text-amber-700">
                            stale
                          </span>
                        )}
                      </span>
                    </Tooltip>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <Tooltip
                        content={
                          d.kind === 'wizard'
                            ? 'Discard this draft'
                            : 'Delete this DRAFT product'
                        }
                        placement="top"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            void onDeleteRow(d)
                          }}
                          aria-label="Delete draft"
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:text-rose-700 hover:bg-rose-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                      <Link
                        href={resumeHref}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                      >
                        {d.kind === 'wizard'
                          ? t('drafts.resume')
                          : t('drafts.configure')}
                        <ArrowRight className="w-3 h-3" />
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!loading && drafts.length > 0 && (
        <div className="text-sm text-slate-500">
          Showing {drafts.length} of {total} drafts
          {staleCount > 0 && !staleOnly && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setStaleOnly(true)}
                className="text-amber-700 hover:underline"
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
