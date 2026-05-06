'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowRight,
  Clock,
  FileEdit,
  RefreshCw,
  Search,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

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
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)

  // 250ms debounce on search to avoid hammering the endpoint while
  // the user is still typing.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250)
    return () => window.clearTimeout(t)
  }, [search])

  const fetchDrafts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (staleOnly) params.set('stale', '1')
      params.set('limit', '100')
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/drafts?${params.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setDrafts(json.drafts ?? [])
      setTotal(json.total ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load drafts')
      setDrafts([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, staleOnly])

  useEffect(() => {
    fetchDrafts()
  }, [fetchDrafts])

  // Refetch on tab focus so a wizard saved in another tab shows up
  // here without needing a manual refresh.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchDrafts()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [fetchDrafts])

  const staleCount = useMemo(
    () => drafts.filter((d) => d.isStale).length,
    [drafts],
  )

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto">
      <header className="mb-5">
        <h1 className="text-[24px] font-semibold text-slate-900">
          Listing wizard drafts
        </h1>
        <p className="text-[13px] text-slate-600 mt-0.5">
          In-progress wizards that haven&rsquo;t been submitted yet. Click any
          row to resume where you left off. Wizards expire after 30 days of
          inactivity.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU or product name…"
            className="w-full h-8 pl-8 pr-3 text-[12px] border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-300"
          />
        </div>
        <button
          type="button"
          onClick={() => setStaleOnly((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-2.5 text-[12px] rounded-md border transition-colors',
            staleOnly
              ? 'bg-amber-50 border-amber-300 text-amber-800'
              : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300',
          )}
          title="Show only wizards untouched for more than 7 days"
        >
          <Clock className="w-3 h-3" />
          Stale only
          {staleCount > 0 && !staleOnly && (
            <span className="text-[10px] text-amber-700 font-semibold ml-1">
              {staleCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={fetchDrafts}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 text-[12px] rounded-md border border-slate-200 bg-white text-slate-700 hover:border-slate-300"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>Failed to load drafts: {error}</span>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500">
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
                  <div className="mt-1 text-[11px] text-slate-400">
                    Wizards started from /products/:id/list-wizard appear here
                    until submitted.
                  </div>
                </td>
              </tr>
            )}
            {drafts.map((d) => (
              <tr
                key={d.id}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/products/${d.productId}/list-wizard`}
                    className="block min-w-0"
                  >
                    <div className="text-slate-900 truncate max-w-[420px]">
                      {d.productName ?? <em className="text-slate-400">Untitled</em>}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5 flex items-center gap-2">
                      <span>{d.productSku ?? '—'}</span>
                      {d.productIsParent && (
                        <span className="inline-flex items-center h-4 px-1 rounded text-[10px] font-medium bg-blue-50 text-blue-700">
                          parent
                        </span>
                      )}
                    </div>
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {d.channels.length === 0 && (
                      <span className="text-slate-400 text-[11px]">none yet</span>
                    )}
                    {d.channels.map((c, i) => (
                      <span
                        key={`${c.platform}:${c.marketplace}:${i}`}
                        className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700"
                      >
                        <span className="font-mono">{c.platform}</span>
                        <span className="text-slate-400 mx-0.5">·</span>
                        <span>{c.marketplace}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700">
                    {d.currentStep}/9
                  </span>
                  <span className="text-slate-500 ml-1.5 text-[11px]">
                    {STEP_LABELS[d.currentStep] ?? `Step ${d.currentStep}`}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={cn(
                      'text-[11px]',
                      d.isStale ? 'text-amber-700' : 'text-slate-500',
                    )}
                    title={new Date(d.updatedAt).toLocaleString()}
                  >
                    {formatRelative(d.updatedAt)}
                    {d.isStale && (
                      <span className="ml-1 text-[10px] uppercase tracking-wide font-semibold text-amber-700">
                        stale
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Link
                    href={`/products/${d.productId}/list-wizard`}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:underline"
                  >
                    Resume
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && drafts.length > 0 && (
        <div className="text-[11px] text-slate-500 mt-3">
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
