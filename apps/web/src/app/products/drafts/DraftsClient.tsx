'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowRight,
  Clock,
  FileEdit,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePolledList } from '@/lib/sync/use-polled-list'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import PageHeader from '@/components/layout/PageHeader'
import { CHANNEL_TONE } from '@/lib/theme'

interface ChannelTuple {
  platform: string
  marketplace: string
}

interface Draft {
  id: string
  productId: string
  productSku: string | null
  productName: string | null
  productIsParent: boolean
  currentStep: number
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

export default function DraftsClient() {
  const [search, setSearch] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)
  // Local 250ms debounce — keeps the input snappy while batching the
  // network round-trip. Same pattern UniversalFilterBar uses internally.
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  // Phase 10 — usePolledList centralises the fetch + ETag + 30s
  // interval polling + visibility refresh + invalidation listening.
  // We listen for wizard.* invalidations so a draft saved or deleted
  // in another tab (e.g. user submits the wizard on /products/:id)
  // refreshes here within ~200ms.
  const url = useMemo(() => {
    const params = new URLSearchParams()
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (staleOnly) params.set('stale', '1')
    params.set('limit', '100')
    return `/api/listing-wizard/drafts?${params.toString()}`
  }, [debouncedSearch, staleOnly])

  const { data, loading, error, lastFetchedAt, refetch } = usePolledList<DraftsResponse>({
    url,
    intervalMs: 30_000,
    invalidationTypes: ['wizard.submitted', 'wizard.deleted', 'product.deleted'],
  })

  const drafts = data?.drafts ?? []
  const total = data?.total ?? 0
  const staleCount = useMemo(
    () => drafts.filter((d) => d.isStale).length,
    [drafts],
  )

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto space-y-5">
      {/* U.7 — switched from a custom h1 (text-[24px] arbitrary value)
          to the shared PageHeader for chrome consistency with /products
          and to keep the header on the U.1 typography scale. The
          freshness indicator slides into PageHeader's actions slot. */}
      <PageHeader
        title="Listing wizard drafts"
        description="In-progress wizards that haven't been submitted yet. Click any row to resume where you left off. Wizards expire after 30 days of inactivity."
        breadcrumbs={[{ label: 'Products', href: '/products' }, { label: 'Drafts' }]}
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
            placeholder="Search by SKU or product name…"
            className="w-full h-8 pl-8 pr-3 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
          />
        </div>
        <button
          type="button"
          onClick={() => setStaleOnly((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 text-base rounded-md border transition-colors',
            staleOnly
              ? 'bg-amber-50 border-amber-300 text-amber-800'
              : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
          )}
          title="Show only wizards untouched for more than 7 days"
        >
          <Clock className="w-3 h-3" />
          Stale only
          {staleCount > 0 && !staleOnly && (
            <span className="text-xs text-amber-700 font-semibold ml-1">
              {staleCount}
            </span>
          )}
        </button>
      </div>

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>Failed to load drafts: {error}</span>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-base">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-sm font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5">Product</th>
              <th className="px-4 py-2.5">Channels</th>
              <th className="px-4 py-2.5">Step</th>
              <th className="px-4 py-2.5">Last updated</th>
              <th className="px-4 py-2.5 w-[100px]" />
            </tr>
          </thead>
          <tbody>
            {loading && drafts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                  Loading drafts…
                </td>
              </tr>
            )}
            {!loading && drafts.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center">
                  <FileEdit className="w-6 h-6 mx-auto text-slate-300" />
                  <div className="mt-2 text-slate-500">
                    {debouncedSearch || staleOnly
                      ? 'No drafts match these filters.'
                      : 'No drafts in progress.'}
                  </div>
                  <div className="mt-1 text-sm text-slate-400">
                    Wizards started from /products/:id/list-wizard appear here
                    until submitted.
                  </div>
                </td>
              </tr>
            )}
            {drafts.map((d) => {
              // U.7 — completion ratio drives both the badge label
              // ("4/9 Variations") and a tiny progress bar under it,
              // so the user sees how far along the draft is at a
              // glance. Total step count is 9 (Step1 → Step10Submit).
              const totalSteps = 9
              const pct = Math.min(100, Math.round((d.currentStep / totalSteps) * 100))
              return (
              <tr
                key={d.id}
                className={cn(
                  'border-b border-slate-100 last:border-0 transition-colors',
                  // U.7 — stale rows get an amber tint so the visual
                  // weight of the warning isn't carried by a single
                  // word of copy on the date column. Hover overrides
                  // so the affordance is consistent with non-stale.
                  d.isStale ? 'bg-amber-50/50 hover:bg-amber-50' : 'hover:bg-slate-50',
                )}
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/products/${d.productId}/list-wizard`}
                    className="block min-w-0"
                  >
                    <div className="text-slate-900 truncate max-w-[420px]">
                      {d.productName ?? <em className="text-slate-400">Untitled</em>}
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
                      <span className="text-slate-400 text-sm">none yet</span>
                    )}
                    {d.channels.map((c, i) => {
                      // U.7 — per-platform color via the shared
                      // CHANNEL_TONE map so AMAZON/eBay/etc. read at
                      // a glance instead of all looking like generic
                      // grey chips. Falls back to slate for unknown
                      // platforms.
                      const tone = CHANNEL_TONE[c.platform] ?? 'bg-slate-100 text-slate-700 border-slate-200'
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
                  <div className="flex flex-col gap-1 min-w-[120px]">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center h-5 px-1.5 rounded text-xs font-semibold tabular-nums bg-blue-50 text-blue-700">
                        {d.currentStep}/{totalSteps}
                      </span>
                      <span className="text-slate-600 text-sm truncate">
                        {STEP_LABELS[d.currentStep] ?? `Step ${d.currentStep}`}
                      </span>
                    </div>
                    {/* U.7 — mini progress bar visualises how far
                        along the wizard is. Caps at 100% so a finished
                        draft (currentStep=9) reads as full. */}
                    <div className="h-1 w-full bg-slate-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-blue-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      'text-sm',
                      d.isStale ? 'text-amber-700' : 'text-slate-500',
                    )}
                    title={new Date(d.updatedAt).toLocaleString()}
                  >
                    {formatRelative(d.updatedAt)}
                    {d.isStale && (
                      <span className="ml-1 text-xs uppercase tracking-wide font-semibold text-amber-700">
                        stale
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {/* U.7 — Resume promoted from text-link to a button-
                      shaped CTA. The action is the primary affordance
                      on every row, so it deserves the visual weight of
                      a button, not a hyperlink. */}
                  <Link
                    href={`/products/${d.productId}/list-wizard`}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                  >
                    Resume
                    <ArrowRight className="w-3 h-3" />
                  </Link>
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
