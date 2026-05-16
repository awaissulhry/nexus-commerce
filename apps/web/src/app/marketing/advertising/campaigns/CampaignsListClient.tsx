'use client'

/**
 * AD.2 — Campaign list with inline edit + sortable columns + filter chips.
 *
 * Density follows the Salesforce/Airtable preference (MEMORY.md
 * feedback_visibility_over_minimalism). Inline edit on dailyBudget +
 * Pause/Resume status toggle. Successful PATCHes show a toast with the
 * 5-min undo handle (cancel via outboundQueueId).
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Pause, Play, Save, RotateCcw, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { formatEurAmount, formatNumber, formatPct } from '../_shared/formatters'

interface Campaign {
  id: string
  name: string
  type: 'SP' | 'SB' | 'SD'
  status: 'ENABLED' | 'PAUSED' | 'ARCHIVED' | 'DRAFT'
  marketplace: string | null
  externalCampaignId: string | null
  dailyBudget: string
  biddingStrategy: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
  impressions: number
  clicks: number
  spend: string
  sales: string
  acos: string | null
  roas: string | null
  trueProfitCents: number
  trueProfitMarginPct: string | null
  lastSyncedAt: string | null
  lastSyncStatus: string | null
}

interface UndoEntry {
  outboundQueueId: string
  campaignId: string
  description: string
  expiresAt: number
}

type SortKey = 'name' | 'marketplace' | 'spend' | 'sales' | 'acos' | 'roas' | 'margin'

export function CampaignsListClient({ initial }: { initial: { items: Campaign[]; count: number } }) {
  const [items, setItems] = useState<Campaign[]>(initial.items)
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])

  // Refresh every 30s so syncStatus + counters reflect worker activity.
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: { items: Campaign[] } | null) => {
          if (json) setItems(json.items)
        })
        .catch(() => {})
    }, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Prune expired undo entries every second.
  useEffect(() => {
    const interval = setInterval(() => {
      setUndoStack((stack) => stack.filter((u) => u.expiresAt > Date.now()))
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const marketplaces = useMemo(
    () => Array.from(new Set(items.map((c) => c.marketplace).filter((m): m is string => !!m))).sort(),
    [items],
  )

  const filtered = useMemo(() => {
    let list = items
    if (marketplaceFilter) list = list.filter((c) => c.marketplace === marketplaceFilter)
    if (statusFilter) list = list.filter((c) => c.status === statusFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const va = sortValue(a, sortKey)
      const vb = sortValue(b, sortKey)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
  }, [items, marketplaceFilter, statusFilter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  async function saveBudget(c: Campaign) {
    const v = budgetEdits[c.id]
    if (v == null) return
    const next = Number(v)
    if (!Number.isFinite(next) || next < 1) {
      setToast(`Invalid budget for ${c.name}`)
      return
    }
    if (Math.abs(next - Number(c.dailyBudget)) < 0.001) {
      setBudgetEdits((e) => ({ ...e, [c.id]: '' }))
      return
    }
    setSaving(c.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/campaigns/${c.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dailyBudget: next }),
        },
      )
      const json = (await res.json()) as { ok: boolean; outboundQueueId: string | null; error: string | null }
      if (json.ok && json.outboundQueueId) {
        setItems((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, dailyBudget: String(next) } : x)),
        )
        setBudgetEdits((e) => ({ ...e, [c.id]: '' }))
        setUndoStack((u) => [
          ...u,
          {
            outboundQueueId: json.outboundQueueId!,
            campaignId: c.id,
            description: `Budget ${c.name}: ${formatEurAmount(Number(c.dailyBudget))} → ${formatEurAmount(next)}`,
            expiresAt: Date.now() + 5 * 60 * 1000,
          },
        ])
      } else {
        setToast(`Errore: ${json.error ?? 'unknown'}`)
      }
    } finally {
      setSaving(null)
    }
  }

  async function toggleStatus(c: Campaign) {
    const nextStatus = c.status === 'ENABLED' ? 'PAUSED' : 'ENABLED'
    setSaving(c.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/campaigns/${c.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      )
      const json = (await res.json()) as { ok: boolean; outboundQueueId: string | null; error: string | null }
      if (json.ok && json.outboundQueueId) {
        setItems((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: nextStatus } : x)))
        setUndoStack((u) => [
          ...u,
          {
            outboundQueueId: json.outboundQueueId!,
            campaignId: c.id,
            description: `${nextStatus === 'PAUSED' ? 'Paused' : 'Resumed'}: ${c.name}`,
            expiresAt: Date.now() + 5 * 60 * 1000,
          },
        ])
      } else {
        setToast(`Errore: ${json.error ?? 'unknown'}`)
      }
    } finally {
      setSaving(null)
    }
  }

  async function undo(entry: UndoEntry) {
    const res = await fetch(
      `${getBackendUrl()}/api/advertising/mutations/${entry.outboundQueueId}`,
      { method: 'DELETE' },
    )
    const json = (await res.json()) as { ok: boolean; error: string | null }
    if (json.ok) {
      setUndoStack((u) => u.filter((x) => x.outboundQueueId !== entry.outboundQueueId))
      setToast('Change cancelled. Local state was already applied — review manually if needed.')
    } else {
      setToast(`Undo failed: ${json.error ?? 'unknown'}`)
    }
  }

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div className="mb-2 text-xs text-slate-600 dark:text-slate-400 px-2 py-1 bg-slate-100 dark:bg-slate-800 rounded inline-block">
          {toast}
        </div>
      )}

      {/* Undo stack */}
      {undoStack.length > 0 && (
        <div className="mb-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 space-y-1">
          <div className="text-xs font-medium text-blue-900 dark:text-blue-200">
            Changes in undo window ({undoStack.length})
          </div>
          {undoStack.map((u) => {
            const secsLeft = Math.max(0, Math.floor((u.expiresAt - Date.now()) / 1000))
            const mins = Math.floor(secsLeft / 60)
            const secs = secsLeft % 60
            return (
              <div key={u.outboundQueueId} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-blue-800 dark:text-blue-300 w-12">
                  {mins}:{String(secs).padStart(2, '0')}
                </span>
                <span className="flex-1 text-blue-900 dark:text-blue-200">{u.description}</span>
                <button
                  type="button"
                  onClick={() => undo(u)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded ring-1 ring-blue-300 bg-white text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-800"
                >
                  <RotateCcw className="h-3 w-3" />
                  Undo
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">All marketplaces</option>
          {marketplaces.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1"
        >
          <option value="">All statuses</option>
          <option value="ENABLED">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="ARCHIVED">Archived</option>
          <option value="DRAFT">Draft</option>
        </select>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          {filtered.length} of {items.length} campaigns
        </span>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <ThSort label="Name" k="name" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('name')} />
              <ThSort label="Mkt" k="marketplace" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('marketplace')} />
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Budget €/d</th>
              <th className="px-3 py-2">Status</th>
              <ThSort label="Spend" k="spend" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('spend')} />
              <ThSort label="Sales" k="sales" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('sales')} />
              <ThSort label="ACOS" k="acos" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('acos')} />
              <ThSort label="ROAS" k="roas" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('roas')} />
              <ThSort label="True Margin" k="margin" sortKey={sortKey} sortDir={sortDir} onClick={() => toggleSort('margin')} />
              <th className="px-3 py-2">Sync</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  No campaigns. Run sync (POST /api/advertising/cron/ads-sync/trigger) to import sandbox fixtures.
                </td>
              </tr>
            ) : (
              filtered.map((c) => {
                const editVal = budgetEdits[c.id]
                const editing = editVal !== undefined && editVal !== ''
                const margin = c.trueProfitMarginPct != null ? Number(c.trueProfitMarginPct) : null
                return (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-950/40">
                    <td className="px-3 py-2 max-w-[260px]">
                      <Link
                        href={`/marketing/advertising/campaigns/${c.id}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline truncate inline-flex items-center gap-1"
                      >
                        {c.name}
                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{c.marketplace ?? '—'}</td>
                    <td className="px-3 py-2 text-xs uppercase">{c.type}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500">€</span>
                        <input
                          type="number"
                          step="0.01"
                          min="1"
                          value={editVal ?? c.dailyBudget}
                          onChange={(e) =>
                            setBudgetEdits((m) => ({ ...m, [c.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveBudget(c)
                            if (e.key === 'Escape') setBudgetEdits((m) => ({ ...m, [c.id]: '' }))
                          }}
                          className="w-20 text-sm bg-transparent border-b border-slate-200 dark:border-slate-700 focus:border-blue-500 focus:outline-none"
                        />
                        {editing && (
                          <button
                            type="button"
                            onClick={() => saveBudget(c)}
                            disabled={saving === c.id}
                            className="text-blue-600 dark:text-blue-400 hover:text-blue-800"
                            title="Save (Enter)"
                          >
                            {saving === c.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={c.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEurAmount(Number(c.spend))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEurAmount(Number(c.sales))}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.acos != null ? formatPct(Number(c.acos)) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.roas != null ? Number(c.roas).toFixed(2) + '×' : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {margin != null ? (
                        <MarginBadge marginPct={margin} />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                      {c.lastSyncStatus ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => toggleStatus(c)}
                        disabled={saving === c.id || c.status === 'ARCHIVED'}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                        title={c.status === 'ENABLED' ? 'Pause' : 'Resume'}
                      >
                        {c.status === 'ENABLED' ? (
                          <>
                            <Pause className="h-3 w-3" />
                            Pause
                          </>
                        ) : (
                          <>
                            <Play className="h-3 w-3" />
                            Resume
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">
        Refreshes every 30s · {formatNumber(items.reduce((a, c) => a + c.impressions, 0))} total impressions
      </div>
    </div>
  )
}

function sortValue(c: Campaign, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return c.name
    case 'marketplace':
      return c.marketplace
    case 'spend':
      return Number(c.spend)
    case 'sales':
      return Number(c.sales)
    case 'acos':
      return c.acos != null ? Number(c.acos) : null
    case 'roas':
      return c.roas != null ? Number(c.roas) : null
    case 'margin':
      return c.trueProfitMarginPct != null ? Number(c.trueProfitMarginPct) : null
  }
}

function ThSort({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onClick: () => void
}) {
  const active = k === sortKey
  return (
    <th className="px-3 py-2">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 ${active ? 'text-slate-900 dark:text-slate-100' : ''}`}
      >
        {label}
        {active && <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
}

function StatusChip({ status }: { status: Campaign['status'] }) {
  const cls =
    status === 'ENABLED'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
      : status === 'PAUSED'
        ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
        : status === 'ARCHIVED'
          ? 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
          : 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900'
  const label =
    status === 'ENABLED' ? 'Active' : status === 'PAUSED' ? 'Paused' : status === 'ARCHIVED' ? 'Archived' : 'Draft'
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${cls}`}>
      {label}
    </span>
  )
}

function MarginBadge({ marginPct }: { marginPct: number }) {
  const cls =
    marginPct >= 0.15
      ? 'text-emerald-700 dark:text-emerald-300'
      : marginPct >= 0.05
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-rose-700 dark:text-rose-300'
  return <span className={`tabular-nums ${cls}`}>{formatPct(marginPct)}</span>
}
