'use client'

/**
 * RRT.7 — the editable per-product-type "days after delivery" baseline.
 * One global table the operator edits directly; rules override it per
 * market/channel. Saved as a whole list (PUT) in one round-trip.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Trash2, ArrowUp, ArrowDown, RefreshCw, Save, RotateCcw, SlidersHorizontal } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../../../../marketing/reviews/_shared/ReviewsNav'

interface Row { id?: string; pattern: string; label: string; delayDays: number; isActive: boolean }
const toRows = (items: unknown): Row[] =>
  (Array.isArray(items) ? items : []).map((x) => {
    const r = x as Record<string, unknown>
    return { id: r.id as string, pattern: String(r.pattern ?? ''), label: String(r.label ?? ''), delayDays: Number(r.delayDays) || 12, isActive: r.isActive !== false }
  })

export default function TimingDefaultsClient() {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/review-timing-defaults`, { cache: 'no-store' })
      .then((r) => r.json()).then((d) => setRows(toRows(d.items)))
      .catch(() => {}).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const move = (i: number, dir: -1 | 1) => setRows((rs) => { const j = i + dir; if (j < 0 || j >= rs.length) return rs; const n = [...rs];[n[i], n[j]] = [n[j], n[i]]; return n })
  const addRow = () => setRows((rs) => [...rs, { pattern: '', label: '', delayDays: 12, isActive: true }])
  const delRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))

  const save = async () => {
    setSaving(true)
    try {
      const items = rows
        .map((r, i) => ({ pattern: r.pattern.trim().toLowerCase(), label: r.label.trim(), delayDays: Math.max(1, Math.min(60, Math.round(r.delayDays) || 12)), sortOrder: i * 10, isActive: r.isActive }))
        .filter((r) => r.pattern && r.label)
      const res = await fetch(`${getBackendUrl()}/api/review-timing-defaults`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })
      if (!res.ok) throw new Error('save failed')
      setRows(toRows((await res.json()).items))
      toast.success('Timing defaults saved')
    } catch { toast.error('Could not save timing defaults') } finally { setSaving(false) }
  }

  const reset = async () => {
    const ok = await confirm({ title: 'Reset to built-in defaults?', description: 'Restores the canonical per-product-type delays (helmet 21d, jacket 14d, gloves 10d…) and overwrites your edits.', confirmLabel: 'Reset', tone: 'danger' })
    if (!ok) return
    setSaving(true)
    try { setRows(toRows((await fetch(`${getBackendUrl()}/api/review-timing-defaults/seed?reset=1`, { method: 'POST' }).then((r) => r.json())).items)); toast.success('Reset to defaults') }
    catch { toast.error('Reset failed') } finally { setSaving(false) }
  }

  const labelCls = 'text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold'
  const inputCls = 'h-8 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review timing defaults"
        description="The baseline “days after delivery” per product type. Rules override these per market/channel. The first matching pattern (top-down) wins."
        breadcrumbs={[{ label: 'Marketing', href: '/marketing/reviews' }, { label: 'Reviews', href: '/marketing/reviews' }, { label: 'Rules', href: '/orders/reviews/rules' }, { label: 'Timing' }]}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/orders/reviews/rules" className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <SlidersHorizontal size={12} /> Rules
            </Link>
            <button type="button" onClick={reset} disabled={saving} className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <RotateCcw size={12} /> Reset
            </button>
            <button type="button" onClick={load} className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
            <button type="button" onClick={save} disabled={saving} className="h-8 px-3 text-sm font-semibold bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 dark:hover:bg-slate-200 inline-flex items-center gap-1.5 disabled:opacity-50">
              <Save size={12} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      />
      <ReviewsNav />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-default dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2"><span className={labelCls}>Order</span></th>
                <th className="px-3 py-2"><span className={labelCls}>Product type (display)</span></th>
                <th className="px-3 py-2"><span className={labelCls}>Match pattern</span></th>
                <th className="px-3 py-2 text-right"><span className={labelCls}>Days after delivery</span></th>
                <th className="px-3 py-2 text-center"><span className={labelCls}>Active</span></th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((r, i) => (
                <tr key={r.id ?? `new-${i}`} className="hover:bg-slate-50 dark:hover:bg-slate-950/40">
                  <td className="px-3 py-1.5">
                    <div className="flex flex-col">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="text-tertiary hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"><ArrowUp size={12} /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down" className="text-tertiary hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"><ArrowDown size={12} /></button>
                    </div>
                  </td>
                  <td className="px-3 py-1.5"><input value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Helmets" className={`${inputCls} w-full`} /></td>
                  <td className="px-3 py-1.5"><input value={r.pattern} onChange={(e) => setRow(i, { pattern: e.target.value })} placeholder="casco" className={`${inputCls} w-full font-mono`} /></td>
                  <td className="px-3 py-1.5 text-right"><input type="number" min={1} max={60} value={r.delayDays} onChange={(e) => setRow(i, { delayDays: Number(e.target.value) })} className={`${inputCls} w-20 text-right tabular-nums`} /></td>
                  <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={r.isActive} onChange={(e) => setRow(i, { isActive: e.target.checked })} aria-label="Active" /></td>
                  <td className="px-3 py-1.5 text-right"><button type="button" onClick={() => delRow(i)} aria-label="Delete row" className="text-tertiary hover:text-rose-600"><Trash2 size={13} /></button></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500 dark:text-slate-400">No timing defaults — add one, or Reset to restore the built-ins.</td></tr>}
            </tbody>
          </table>
        )}
        <div className="px-3 py-2 border-t border-default dark:border-slate-800">
          <button type="button" onClick={addRow} className="h-7 px-2 text-sm text-slate-700 dark:text-slate-300 border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"><Plus size={12} /> Add product type</button>
        </div>
      </Card>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Pattern = case-insensitive substring of the product type (e.g. <code className="font-mono">casco</code> matches “Casco Pro XL”). Order matters — the first active match top-down wins. Used when no rule sets its own delay; rules override per market/channel.
      </p>
    </div>
  )
}
