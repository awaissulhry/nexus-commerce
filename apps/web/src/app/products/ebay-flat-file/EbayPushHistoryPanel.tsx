'use client'

/**
 * eBay push history — durable submissions panel (the eBay parallel of Amazon's
 * FeedSubmissionsPanel). Reads server-backed EbayPushJob rows
 * (GET /api/ebay/flat-file/pushes) so every "Push to eBay" + its full per-SKU
 * result is visible after a reload, a tab close, or on another device — not a
 * 3-second toast that vanishes. Drill into any push for the per-SKU
 * PUSHED/ERROR breakdown with eBay messages; search, filter, export CSV, copy
 * errored SKUs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, RefreshCw, ChevronRight, ChevronDown, Download, Copy, X, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type SkuStatus = 'PUSHED' | 'ERROR'
interface PerSku { sku: string; market?: string; status: SkuStatus; listingId?: string; message?: string }
interface PushJob {
  id: string
  mode: string
  taskId?: string | null
  markets?: string[] | null
  status: string // DONE | PARTIAL | FATAL | SUBMITTED
  skuCount: number
  pushed: number
  failed: number
  perSkuResults?: PerSku[] | null
  warnings?: Array<{ sku: string; requested?: number; published?: number; reason?: string }> | null
  errorMessage?: string | null
  submittedAt: string
  completedAt?: string | null
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function statusChip(job: PushJob): { cls: string; label: string } {
  const errs = job.failed ?? (job.perSkuResults ?? []).filter((p) => p.status === 'ERROR').length
  if (job.status === 'FATAL') return { cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300', label: errs > 0 ? `FATAL · ${errs} error${errs === 1 ? '' : 's'}` : 'FATAL' }
  if (job.status === 'PARTIAL') return { cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300', label: `PARTIAL · ${errs} error${errs === 1 ? '' : 's'}` }
  if (job.status === 'DONE') return { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300', label: `DONE · ${job.pushed} pushed` }
  // SUBMITTED (feed mode, pending eBay processing)
  return { cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300', label: job.status || '…' }
}

const skuCls: Record<SkuStatus, string> = {
  PUSHED: 'text-emerald-600 dark:text-emerald-400',
  ERROR: 'text-red-600 dark:text-red-400',
}

export function EbayPushHistoryPanel({ onClose, refreshKey }: { onClose: () => void; refreshKey?: number }) {
  const [jobs, setJobs] = useState<PushJob[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | SkuStatus>('all')

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/ebay/flat-file/pushes?limit=50`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setJobs(Array.isArray(d?.pushes) ? d.pushes : []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false))
  }, [])
  // refetch on open and whenever a fresh push bumps refreshKey
  useEffect(() => { load() }, [load, refreshKey])

  const expandedJob = jobs.find((j) => j.id === expanded) ?? null
  const rows = useMemo(() => {
    const all = expandedJob?.perSkuResults ?? []
    const q = query.trim().toLowerCase()
    return all.filter((r) => {
      if (filter !== 'all' && r.status !== filter) return false
      if (!q) return true
      return r.sku?.toLowerCase().includes(q) || r.message?.toLowerCase().includes(q) || r.market?.toLowerCase().includes(q)
    })
  }, [expandedJob, query, filter])

  function exportCsv(job: PushJob) {
    const lines = [['sku', 'market', 'status', 'listingId', 'message'].join(',')]
    for (const r of job.perSkuResults ?? []) {
      lines.push([r.sku, r.market ?? '', r.status, r.listingId ?? '', `"${(r.message ?? '').replace(/"/g, '""')}"`].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ebay-push-${(job.markets ?? []).join('-') || 'multi'}-${job.id.slice(0, 8)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  function copyErrored(job: PushJob) {
    const skus = (job.perSkuResults ?? []).filter((r) => r.status === 'ERROR').map((r) => r.sku)
    if (skus.length) void navigator.clipboard?.writeText(skus.join('\n'))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end pt-16 pr-4" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-xl max-h-[82vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Push history</h2>
            <span className="text-xs text-slate-400">({jobs.length})</span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700 rounded px-1">durable · all devices</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && jobs.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-400">Loading…</p>
          ) : jobs.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">No pushes yet. When you push to eBay, every attempt appears here with its full per-SKU result — and stays, even if the push fails or you close the tab.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {jobs.map((job) => {
                const chip = statusChip(job)
                const isOpen = expanded === job.id
                return (
                  <li key={job.id}>
                    <button type="button" onClick={() => setExpanded(isOpen ? null : job.id)}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">{(job.markets ?? []).join(', ') || '—'}</span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${chip.cls}`}>{chip.label}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">{job.mode} · {job.skuCount} SKU{job.skuCount === 1 ? '' : 's'}</span>
                      <span className="text-[11px] text-slate-400 shrink-0">{fmtTime(job.submittedAt)}</span>
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-3 bg-slate-50/50 dark:bg-slate-950/30">
                        {/* summary line */}
                        <div className="text-xs text-slate-500 dark:text-slate-400 mb-2 flex flex-wrap gap-x-3">
                          <span>{job.skuCount} row{job.skuCount === 1 ? '' : 's'}</span>
                          <span className="text-emerald-600 dark:text-emerald-400">{job.pushed} pushed</span>
                          {job.failed > 0 && <span className="text-red-600 dark:text-red-400">{job.failed} error{job.failed === 1 ? '' : 's'}</span>}
                          {job.taskId && <span className="font-mono text-slate-400" title={job.taskId}>task {job.taskId.slice(0, 14)}…</span>}
                        </div>
                        {job.errorMessage && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{job.errorMessage}</p>}
                        {(job.warnings?.length ?? 0) > 0 && (
                          <div className="text-[11px] text-amber-600 dark:text-amber-400 mb-2 space-y-0.5">
                            {job.warnings!.slice(0, 4).map((w, i) => <p key={i}>⚠ <span className="font-mono">{w.sku}</span>: {w.reason}</p>)}
                            {job.warnings!.length > 4 && <p>+{job.warnings!.length - 4} more warning{job.warnings!.length - 4 === 1 ? '' : 's'}</p>}
                          </div>
                        )}

                        {(job.perSkuResults?.length ?? 0) > 0 ? (
                          <>
                            {/* controls */}
                            <div className="flex items-center gap-2 mb-2">
                              <div className="relative flex-1">
                                <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU / message / market"
                                  className="w-full h-7 pl-7 pr-2 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
                              </div>
                              <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | SkuStatus)}
                                className="h-7 px-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900">
                                <option value="all">All</option>
                                <option value="ERROR">Errors</option>
                                <option value="PUSHED">Pushed</option>
                              </select>
                              <button type="button" onClick={() => exportCsv(job)} title="Export CSV" className="h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1"><Download className="w-3 h-3" />CSV</button>
                              {job.failed > 0 && (
                                <button type="button" onClick={() => copyErrored(job)} title="Copy errored SKUs" className="h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-white dark:hover:bg-slate-800 inline-flex items-center gap-1"><Copy className="w-3 h-3" />SKUs</button>
                              )}
                            </div>
                            {/* per-SKU table */}
                            <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded">
                              <table className="w-full text-xs">
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                  {rows.map((r, i) => (
                                    <tr key={`${r.sku}-${i}`} className="hover:bg-white dark:hover:bg-slate-800/40">
                                      <td className="px-2 py-1 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">{r.sku}</td>
                                      <td className="px-2 py-1 text-slate-400 whitespace-nowrap">{r.market ?? ''}</td>
                                      <td className={`px-2 py-1 font-medium ${skuCls[r.status] ?? ''}`}>{r.status}</td>
                                      <td className="px-2 py-1 text-slate-500 dark:text-slate-400">{r.message ?? ''}</td>
                                    </tr>
                                  ))}
                                  {rows.length === 0 && <tr><td colSpan={4} className="px-2 py-3 text-center text-slate-400">No rows match.</td></tr>}
                                </tbody>
                              </table>
                            </div>
                          </>
                        ) : (
                          <p className="text-xs text-slate-400">{job.status === 'SUBMITTED' ? 'Feed submitted — per-SKU result appears when eBay finishes processing.' : 'No per-SKU detail recorded.'}</p>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
