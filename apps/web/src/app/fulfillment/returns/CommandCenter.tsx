'use client'

// RX.1 — Returns Command Center.
//
// The triage header that answers "what needs me right now". Replaces a
// flat-list-only top with clickable urgency queues, an Italian refund-
// deadline (D.Lgs. 21/2014, 14-day) SLA panel, a days-in-status aging
// strip, and per-channel refund-adapter health. The deadline summary
// and channel-adapter status existed in the API with zero UI before
// this; the queue counts are a single aggregate fetch (no per-tile
// round-trips). Every count is authoritative because the same backend
// owns both the tile number and the grid filter it opens.

import { useCallback, useEffect, useState } from 'react'
import {
  ClipboardCheck, Truck, PackageCheck, Microscope, RotateCcw,
  Euro, Clock, AlertTriangle, ChevronDown, ChevronRight, Activity, ShieldCheck,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { CHANNEL_TONE } from '@/app/_shared/returns'

type ChannelAdapter = {
  channel: string
  mode: 'real' | 'dryRun' | 'manual_required' | 'not_implemented'
  variant?: string
  notes: string
  envFlag?: string
}

type CommandCenterData = {
  queues: {
    awaitingApproval: number
    awaitingArrival: number
    awaitingInspection: number
    inspecting: number
    refundFailed: number
    highValue: number
    refundApproaching: number
    refundOverdue: number
    total: number
  }
  aging: { fresh: number; day2: number; day5: number; stale: number; staleMaxDays: number }
  deadlineSummary: {
    approaching: number
    overdue: number
    approachingPreview: Array<{ id: string; rmaNumber: string | null; daysUntilDeadline: number; channel: string }>
    overduePreview: Array<{ id: string; rmaNumber: string | null; daysOverdue: number; channel: string }>
  }
  channelStatus: ChannelAdapter[]
  highValueThresholdCents: number
  generatedAt: string
}

// Active-channel scope: Xavia ships Amazon + eBay + Shopify. Woo/Etsy
// adapters exist in the report but are noise on the operator surface.
const ACTIVE_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY'])

const ADAPTER_TONE: Record<ChannelAdapter['mode'], { label: string; cls: string }> = {
  real:            { label: 'Live',    cls: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900' },
  dryRun:          { label: 'Dry-run', cls: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900' },
  manual_required: { label: 'Manual',  cls: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900' },
  not_implemented: { label: 'N/A',     cls: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700' },
}

type TileSpec = {
  queue: string
  label: string
  icon: typeof ClipboardCheck
  count: number
  tone: 'slate' | 'amber' | 'rose' | 'blue' | 'violet'
}

const TILE_TONE: Record<TileSpec['tone'], { active: string; idle: string; ring: string; num: string }> = {
  slate:  { active: 'bg-slate-900 text-white border-slate-900', idle: 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-slate-400', ring: 'ring-slate-400', num: 'text-slate-900 dark:text-slate-100' },
  amber:  { active: 'bg-amber-600 text-white border-amber-600', idle: 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900 hover:border-amber-400', ring: 'ring-amber-400', num: 'text-amber-700 dark:text-amber-300' },
  rose:   { active: 'bg-rose-600 text-white border-rose-600', idle: 'bg-rose-50/60 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900 hover:border-rose-400', ring: 'ring-rose-400', num: 'text-rose-700 dark:text-rose-300' },
  blue:   { active: 'bg-blue-600 text-white border-blue-600', idle: 'bg-blue-50/60 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900 hover:border-blue-400', ring: 'ring-blue-400', num: 'text-blue-700 dark:text-blue-300' },
  violet: { active: 'bg-violet-600 text-white border-violet-600', idle: 'bg-violet-50/60 dark:bg-violet-950/20 border-violet-200 dark:border-violet-900 hover:border-violet-400', ring: 'ring-violet-400', num: 'text-violet-700 dark:text-violet-300' },
}

function euros(cents: number): string {
  return `€${Math.round(cents / 100).toLocaleString()}`
}

export default function CommandCenter({
  activeQueue,
  onQueue,
  reloadSignal,
  onOpenReturn,
}: {
  activeQueue: string | null
  onQueue: (queue: string) => void
  reloadSignal: number
  onOpenReturn: (id: string) => void
}) {
  const [data, setData] = useState<CommandCenterData | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('returns.cc.collapsed') === '1'
  })
  useEffect(() => {
    try { window.localStorage.setItem('returns.cc.collapsed', collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed])

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/command-center`, { cache: 'no-store' })
      if (res.ok) setData((await res.json()) as CommandCenterData)
    } catch { /* non-fatal — header is supplemental to the grid */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchData() }, [fetchData, reloadSignal])

  if (loading && !data) {
    return (
      <div className="h-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40 animate-pulse" aria-hidden="true" />
    )
  }
  if (!data) return null

  const q = data.queues
  const tiles: TileSpec[] = [
    { queue: 'awaiting-approval',   label: 'Awaiting approval',  icon: ClipboardCheck, count: q.awaitingApproval,   tone: 'amber' },
    { queue: 'awaiting-arrival',    label: 'Awaiting arrival',   icon: Truck,          count: q.awaitingArrival,    tone: 'slate' },
    { queue: 'awaiting-inspection', label: 'Awaiting inspection', icon: PackageCheck,  count: q.awaitingInspection, tone: 'amber' },
    { queue: 'inspecting',          label: 'Inspecting',         icon: Microscope,     count: q.inspecting,         tone: 'blue' },
    { queue: 'refund-failed',       label: 'Refund failed',      icon: RotateCcw,      count: q.refundFailed,       tone: 'rose' },
    { queue: 'high-value',          label: `High value (≥${euros(data.highValueThresholdCents)})`, icon: Euro, count: q.highValue, tone: 'violet' },
  ]

  const actionable = q.awaitingApproval + q.awaitingInspection + q.inspecting + q.refundFailed + q.refundOverdue
  const agingTotal = data.aging.fresh + data.aging.day2 + data.aging.day5 + data.aging.stale || 1
  const channels = data.channelStatus.filter((c) => ACTIVE_CHANNELS.has(c.channel))

  return (
    <section
      aria-label="Returns command center"
      className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
    >
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200"
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          <Activity size={14} className="text-slate-500 dark:text-slate-400" />
          Command center
        </button>
        <div className="flex items-center gap-3 text-xs">
          {actionable > 0 ? (
            <span className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-300">
              <AlertTriangle size={12} /> {actionable} need{actionable === 1 ? 's' : ''} action
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
              <ShieldCheck size={12} /> All clear
            </span>
          )}
          <span className="text-slate-400 dark:text-slate-500">{q.total} open</span>
        </div>
      </header>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {/* Urgency queues — clickable; each drives the grid filter. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {tiles.map((t) => {
              const isActive = activeQueue === t.queue
              const empty = t.count === 0
              const tone = TILE_TONE[t.tone]
              const Icon = t.icon
              return (
                <button
                  key={t.queue}
                  onClick={() => onQueue(t.queue)}
                  aria-pressed={isActive}
                  className={[
                    'group relative flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-all',
                    isActive ? tone.active : tone.idle,
                    empty && !isActive ? 'opacity-55' : '',
                    'focus:outline-none focus:ring-2 ' + tone.ring,
                  ].join(' ')}
                  title={isActive ? 'Clear this queue filter' : `Filter to ${t.label.toLowerCase()}`}
                >
                  <div className="flex items-center gap-1.5 w-full">
                    <Icon size={13} className={isActive ? 'text-white/90' : 'text-slate-500 dark:text-slate-400'} />
                    <span className={`text-[11px] font-medium leading-tight ${isActive ? 'text-white/90' : 'text-slate-600 dark:text-slate-400'}`}>{t.label}</span>
                  </div>
                  <span className={`text-xl font-bold tabular-nums ${isActive ? 'text-white' : tone.num}`}>{t.count}</span>
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Refund SLA panel (Italian 14-day refund deadline). */}
            <div className="lg:col-span-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                  <Clock size={12} /> Refund deadline (IT 14-day)
                </h3>
                <div className="flex items-center gap-2 text-xs">
                  <span className={`font-semibold ${data.deadlineSummary.overdue > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-slate-400'}`}>{data.deadlineSummary.overdue} overdue</span>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span className={`font-semibold ${data.deadlineSummary.approaching > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-400'}`}>{data.deadlineSummary.approaching} approaching</span>
                </div>
              </div>
              {data.deadlineSummary.overdue === 0 && data.deadlineSummary.approaching === 0 ? (
                <p className="text-sm text-slate-500 dark:text-slate-400">No refunds near the statutory deadline. 👍</p>
              ) : (
                <ul className="space-y-1">
                  {data.deadlineSummary.overduePreview.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => onOpenReturn(r.id)}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30 text-left"
                      >
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 border rounded shrink-0 ${CHANNEL_TONE[r.channel] ?? ''}`}>{r.channel}</span>
                          <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">{r.rmaNumber ?? r.id.slice(-6)}</span>
                        </span>
                        <span className="text-xs font-semibold text-rose-700 dark:text-rose-300 shrink-0">Overdue {r.daysOverdue}d</span>
                      </button>
                    </li>
                  ))}
                  {data.deadlineSummary.approachingPreview.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => onOpenReturn(r.id)}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-amber-50 dark:hover:bg-amber-950/30 text-left"
                      >
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <span className={`text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 border rounded shrink-0 ${CHANNEL_TONE[r.channel] ?? ''}`}>{r.channel}</span>
                          <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">{r.rmaNumber ?? r.id.slice(-6)}</span>
                        </span>
                        <span className="text-xs font-semibold text-amber-700 dark:text-amber-300 shrink-0">Due in {r.daysUntilDeadline}d</span>
                      </button>
                    </li>
                  ))}
                  {(data.deadlineSummary.overdue > data.deadlineSummary.overduePreview.length ||
                    data.deadlineSummary.approaching > data.deadlineSummary.approachingPreview.length) && (
                    <li className="px-2 pt-1 text-xs text-slate-400">
                      +{(data.deadlineSummary.overdue - data.deadlineSummary.overduePreview.length) +
                        (data.deadlineSummary.approaching - data.deadlineSummary.approachingPreview.length)} more —
                      use the inspection queues above
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* Aging + channel health. */}
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Open-return aging</h3>
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img" aria-label={`Aging: ${data.aging.fresh} under 2 days, ${data.aging.day2} 2-5 days, ${data.aging.day5} 5-10 days, ${data.aging.stale} over 10 days`}>
                  <div className="bg-emerald-400" style={{ width: `${(data.aging.fresh / agingTotal) * 100}%` }} />
                  <div className="bg-amber-300" style={{ width: `${(data.aging.day2 / agingTotal) * 100}%` }} />
                  <div className="bg-orange-400" style={{ width: `${(data.aging.day5 / agingTotal) * 100}%` }} />
                  <div className="bg-rose-500" style={{ width: `${(data.aging.stale / agingTotal) * 100}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1 align-middle" />&lt;2d · {data.aging.fresh}</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-amber-300 mr-1 align-middle" />2–5d · {data.aging.day2}</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1 align-middle" />5–10d · {data.aging.day5}</span>
                  <span className={data.aging.stale > 0 ? 'text-rose-600 dark:text-rose-400 font-medium' : ''}><span className="inline-block w-2 h-2 rounded-full bg-rose-500 mr-1 align-middle" />&gt;10d · {data.aging.stale}</span>
                </div>
                {data.aging.stale > 0 && (
                  <p className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">Oldest open return: {data.aging.staleMaxDays}d untouched.</p>
                )}
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Refund channel health</h3>
                <div className="flex flex-wrap gap-1.5">
                  {channels.map((c) => (
                    <span
                      key={`${c.channel}-${c.variant ?? ''}`}
                      title={c.notes}
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${ADAPTER_TONE[c.mode].cls}`}
                    >
                      {c.channel}{c.variant ? ` ${c.variant}` : ''} · {ADAPTER_TONE[c.mode].label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
