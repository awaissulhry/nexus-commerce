'use client'

/**
 * STO.4 — the editable per-weekday "best time to send" grid.
 *
 * The resolver pins each review request's local send hour to that weekday's
 * value here (after the send date is fixed). '*' is the global default; pick a
 * marketplace to override it for that market. Hours are in the buyer's local
 * timezone. dayRank (lower = better) drives the per-rule "shift to best day".
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, Save, RotateCcw, SlidersHorizontal, Clock } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../../../../marketing/reviews/_shared/ReviewsNav'
import SendHourReport from './SendHourReport'

const MARKETS = [
  { code: '*', label: 'Global default' },
  { code: 'IT', label: 'Italy' },
  { code: 'DE', label: 'Germany' },
  { code: 'FR', label: 'France' },
  { code: 'ES', label: 'Spain' },
  { code: 'UK', label: 'United Kingdom' },
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Row { dayOfWeek: number; hourLocal: number; dayRank: number; isActive: boolean }
const emptyRows = (): Row[] => DAYS.map((_, d) => ({ dayOfWeek: d, hourLocal: 19, dayRank: 5, isActive: true }))
const fromApi = (items: unknown): Row[] => {
  const map = new Map<number, Row>()
  ;(Array.isArray(items) ? items : []).forEach((x) => {
    const r = x as Record<string, unknown>
    const d = Number(r.dayOfWeek)
    if (d >= 0 && d <= 6) map.set(d, { dayOfWeek: d, hourLocal: Number(r.hourLocal) || 0, dayRank: Number(r.dayRank) || 0, isActive: r.isActive !== false })
  })
  return DAYS.map((_, d) => map.get(d) ?? null).filter(Boolean) as Row[]
}
const hhmm = (h: number) => `${String(Math.max(0, Math.min(23, h))).padStart(2, '0')}:00`

export default function SendTimesClient() {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [marketplace, setMarketplace] = useState('*')
  const [rows, setRows] = useState<Row[]>([])
  const [inheriting, setInheriting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback((mk: string) => {
    setLoading(true)
    const g = fetch(`${getBackendUrl()}/api/review-send-windows?marketplace=*`, { cache: 'no-store' }).then((r) => r.json())
    const m = mk === '*' ? g : fetch(`${getBackendUrl()}/api/review-send-windows?marketplace=${mk}`, { cache: 'no-store' }).then((r) => r.json())
    Promise.all([g, m])
      .then(([gd, md]) => {
        const gr = fromApi(gd.windows)
        const mr = fromApi(md.windows)
        if (mk !== '*' && mr.length === 0) {
          setInheriting(true)
          setRows((gr.length ? gr : emptyRows()).map((r) => ({ ...r })))
        } else {
          setInheriting(false)
          setRows(mr.length ? mr : emptyRows())
        }
      })
      .catch(() => setRows(emptyRows()))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load(marketplace) }, [load, marketplace])

  const setRow = (d: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.dayOfWeek === d ? { ...r, ...patch } : r)))
    if (inheriting) setInheriting(false) // first edit creates the override
  }

  const save = async () => {
    setSaving(true)
    try {
      const windows = rows.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        hourLocal: Math.max(0, Math.min(23, Math.round(r.hourLocal) || 0)),
        dayRank: Math.max(0, Math.min(99, Math.round(r.dayRank) || 0)),
        isActive: r.isActive,
      }))
      const res = await fetch(`${getBackendUrl()}/api/review-send-windows`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace, windows }),
      })
      if (!res.ok) throw new Error('save failed')
      toast.success(marketplace === '*' ? 'Global send times saved' : `${marketplace} override saved`)
      load(marketplace)
    } catch { toast.error('Could not save send times') } finally { setSaving(false) }
  }

  const reset = async () => {
    if (marketplace === '*') {
      const ok = await confirm({ title: 'Reset global send times?', description: 'Restores the built-in pattern (weekday evenings ~19:00, weekend late-mornings ~11:00) and overwrites your edits.', confirmLabel: 'Reset', tone: 'danger' })
      if (!ok) return
      setSaving(true)
      try { await fetch(`${getBackendUrl()}/api/review-send-windows/seed?reset=1`, { method: 'POST' }); toast.success('Reset to defaults'); load('*') }
      catch { toast.error('Reset failed') } finally { setSaving(false) }
    } else {
      const ok = await confirm({ title: `Remove the ${marketplace} override?`, description: `${marketplace} will fall back to the global default send times.`, confirmLabel: 'Remove override', tone: 'danger' })
      if (!ok) return
      setSaving(true)
      try { await fetch(`${getBackendUrl()}/api/review-send-windows`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketplace, windows: [] }) }); toast.success('Override removed'); load(marketplace) }
      catch { toast.error('Could not remove override') } finally { setSaving(false) }
    }
  }

  const labelCls = 'text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold'
  const inputCls = 'h-8 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review send times"
        description="The best local hour to ask for a review, per weekday. The resolver pins each request to that day’s hour after the send date is set. Hours are in the buyer’s timezone."
        breadcrumbs={[{ label: 'Marketing', href: '/marketing/reviews' }, { label: 'Reviews', href: '/marketing/reviews' }, { label: 'Rules', href: '/orders/reviews/rules' }, { label: 'Send times' }]}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/orders/reviews/rules/timing" className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <SlidersHorizontal size={12} /> Timing defaults
            </Link>
            <button type="button" onClick={reset} disabled={saving} className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <RotateCcw size={12} /> {marketplace === '*' ? 'Reset' : 'Remove override'}
            </button>
            <button type="button" onClick={() => load(marketplace)} className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
            <button type="button" onClick={save} disabled={saving} className="h-8 px-3 text-sm font-semibold bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 dark:hover:bg-slate-200 inline-flex items-center gap-1.5 disabled:opacity-50">
              <Save size={12} /> {saving ? 'Saving…' : inheriting ? 'Create override' : 'Save'}
            </button>
          </div>
        }
      />
      <ReviewsNav />

      {/* marketplace tabs */}
      <div className="flex flex-wrap gap-2">
        {MARKETS.map((m) => (
          <button
            key={m.code}
            type="button"
            onClick={() => setMarketplace(m.code)}
            aria-pressed={marketplace === m.code}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${marketplace === m.code ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-300'}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {inheriting && marketplace !== '*' && (
        <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {marketplace} is inheriting the global default. Edit any row to create a {marketplace}-specific override.
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-default dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2"><span className={labelCls}>Day</span></th>
                <th className="px-3 py-2"><span className={labelCls}>Send at (local)</span></th>
                <th className="px-3 py-2 text-right"><span className={labelCls}>Day rank (lower = better)</span></th>
                <th className="px-3 py-2 text-center"><span className={labelCls}>Active</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((r) => (
                <tr key={r.dayOfWeek} className={`hover:bg-slate-50 dark:hover:bg-slate-950/40 ${inheriting ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-200">{DAYS[r.dayOfWeek]}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <input type="number" min={0} max={23} value={r.hourLocal} onChange={(e) => setRow(r.dayOfWeek, { hourLocal: Number(e.target.value) })} className={`${inputCls} w-20 text-right tabular-nums`} aria-label={`${DAYS[r.dayOfWeek]} hour`} />
                      <span className="text-slate-500 dark:text-slate-400 tabular-nums">{hhmm(r.hourLocal)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right"><input type="number" min={0} max={99} value={r.dayRank} onChange={(e) => setRow(r.dayOfWeek, { dayRank: Number(e.target.value) })} className={`${inputCls} w-16 text-right tabular-nums`} aria-label={`${DAYS[r.dayOfWeek]} rank`} /></td>
                  <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={r.isActive} onChange={(e) => setRow(r.dayOfWeek, { isActive: e.target.checked })} aria-label={`${DAYS[r.dayOfWeek]} active`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Clock size={14} className="shrink-0 mt-0.5" />
        <p>
          A request whose send date lands on a given weekday is asked at that day’s hour, in the buyer’s timezone.
          A per-rule “preferred hour” still overrides this. <strong>Day rank</strong> only matters for rules with
          “shift to best day” on — they move the send to the lowest-ranked nearby weekday. On Amazon the 4–30 day
          window always wins. Inactive rows fall back to the global default (or the order’s delivery time).
        </p>
      </div>

      <SendHourReport />
    </div>
  )
}
