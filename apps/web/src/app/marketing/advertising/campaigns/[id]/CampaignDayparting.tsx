'use client'

/**
 * CD.12 — Dayparting heatmap (weekday × hour, Europe/Rome) + convert-aware
 * scheduling. Reads /advertising/campaigns/:id/dayparting (the CD.11 hourly
 * store). Cells colour by orders / spend / ACOS; the "Create peak-hours
 * schedule" action derives a contiguous high-conversion window and writes an
 * AdSchedule (POST /advertising/schedules). Empty until AMS hourly data lands.
 */

import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Cell { dow: number; hour: number; costCents: number; salesCents: number; orders: number; impressions: number; clicks: number; acos: number | null }
type Metric = 'orders' | 'spend' | 'acos'

const DAYS = [{ dow: 1, l: 'Mon' }, { dow: 2, l: 'Tue' }, { dow: 3, l: 'Wed' }, { dow: 4, l: 'Thu' }, { dow: 5, l: 'Fri' }, { dow: 6, l: 'Sat' }, { dow: 0, l: 'Sun' }]
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)

export function CampaignDayparting({ campaignId, marketplace, refreshKey }: { campaignId: string; marketplace: string | null; refreshKey?: number }) {
  const [cells, setCells] = useState<Cell[] | null>(null)
  const [metric, setMetric] = useState<Metric>('orders')
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/dayparting?windowDays=30`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ cells: [] }))
    setCells(r.cells ?? [])
  }, [campaignId])
  useEffect(() => { void load() }, [load, refreshKey])

  const map = new Map<string, Cell>()
  for (const c of cells ?? []) map.set(`${c.dow}:${c.hour}`, c)
  const val = (c: Cell | undefined): number | null => {
    if (!c) return null
    if (metric === 'orders') return c.orders
    if (metric === 'spend') return c.costCents
    return c.acos
  }
  const all = (cells ?? []).map((c) => val(c)).filter((v): v is number => v != null && v > 0)
  const max = all.length ? Math.max(...all) : 1

  const cellStyle = (c: Cell | undefined): string => {
    const v = val(c)
    if (v == null || v === 0) return 'bg-slate-50 dark:bg-slate-900/40'
    const t = Math.min(1, v / max)
    if (metric === 'acos') {
      // lower ACOS = better (green) → higher = worse (red)
      return t < 0.33 ? 'bg-emerald-400/70' : t < 0.66 ? 'bg-amber-400/70' : 'bg-rose-500/70'
    }
    // orders/spend: deeper = more
    const op = t < 0.25 ? '/30' : t < 0.5 ? '/50' : t < 0.75 ? '/70' : ''
    return `bg-emerald-500${op}`
  }

  // Convert-aware: derive a contiguous high-order window across the day.
  const createSchedule = useCallback(async () => {
    setCreating(true); setMsg('')
    try {
      const byHour = new Array(24).fill(0)
      for (const c of cells ?? []) byHour[c.hour] += c.orders
      const totalOrders = byHour.reduce((s, v) => s + v, 0)
      if (totalOrders === 0) { setMsg('No order data yet to derive peak hours'); setCreating(false); return }
      const mean = totalOrders / 24
      const goodHours = byHour.map((v, h) => ({ v, h })).filter((x) => x.v >= mean).map((x) => x.h)
      const startHour = Math.min(...goodHours), endHour = Math.max(...goodHours)
      const r = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, name: `Peak hours (${startHour}:00–${endHour}:00)`, windows: [{ days: [1, 2, 3, 4, 5, 6, 0], startHour, endHour }], timezone: 'Europe/Rome', enabled: false }) }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setMsg(`✓ Created schedule "${r.name ?? 'peak hours'}" (disabled — review + enable in Automation)`)
    } catch (e) { setMsg((e as Error).message) } finally { setCreating(false) }
  }, [cells, campaignId])

  if (cells == null) return <div className="p-6 text-center text-tertiary text-sm">Loading…</div>
  if (cells.length === 0) return (
    <div className="p-6 text-center text-tertiary text-sm">
      No hourly data yet. Dayparting populates once an Amazon Marketing Stream subscription is pushing hourly performance (see docs/MARKETING-OS.md).
    </div>
  )

  return (
    <div className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200"><CalendarClock size={14} className="text-violet-500" /> Dayparting <span className="text-xs font-normal text-tertiary">· last 30d · Europe/Rome</span></div>
        <div className="inline-flex items-center gap-1">
          {(['orders', 'spend', 'acos'] as const).map((m) => (
            <button key={m} onClick={() => setMetric(m)} className={`px-2 py-0.5 text-xs rounded border ${metric === m ? 'border-blue-500 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40' : 'border-default dark:border-slate-700 text-slate-500'}`}>{m === 'acos' ? 'ACOS' : m[0].toUpperCase() + m.slice(1)}</button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr><th className="w-10"></th>{Array.from({ length: 24 }, (_, h) => <th key={h} className="text-[9px] text-tertiary font-normal w-5">{h % 3 === 0 ? h : ''}</th>)}</tr>
          </thead>
          <tbody>
            {DAYS.map((d) => (
              <tr key={d.dow}>
                <td className="text-[11px] text-slate-500 pr-1 text-right">{d.l}</td>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = map.get(`${d.dow}:${h}`)
                  const v = val(c)
                  const title = c ? `${d.l} ${h}:00 · ${c.orders} orders · ${eur(c.costCents)} spend${c.acos != null ? ` · ${c.acos}% ACOS` : ''}` : `${d.l} ${h}:00 · no data`
                  return <td key={h} title={title} className={`w-5 h-5 rounded-sm ${cellStyle(c)}`} aria-label={title}>{v != null && v > 0 ? <span className="sr-only">{v}</span> : null}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-3">
        <button onClick={createSchedule} disabled={creating} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
          <Sparkles size={13} /> {creating ? 'Creating…' : 'Create peak-hours schedule'}
        </button>
        {msg && <span className={`text-xs ${msg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600'}`}>{msg}</span>}
        <span className="text-xs text-tertiary">Schedule is created disabled — review windows and enable in Automation. {marketplace ? `(${marketplace})` : ''}</span>
      </div>
    </div>
  )
}
