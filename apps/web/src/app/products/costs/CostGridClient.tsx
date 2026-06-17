'use client'

/**
 * R4.1 — bulk cost-entry grid.
 *
 * Key or paste per-SKU costs (paste a column straight from a sheet), with
 * a live TRUE-margin preview using the real Amazon fee rate (R1). Writes
 * Product.costPrice via PATCH /api/products/costs — which the profit calc
 * and Pricing Watchdog already consume.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Save, Loader2, RefreshCw, Coins, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Row {
  id: string
  sku: string
  name: string
  basePrice: number | null
  costPrice: number | null
  unitsSold90d: number
}

const parseCost = (raw: string): number | null => {
  const t = raw.trim().replace(/[€$\s]/g, '').replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function trueMargin(
  base: number | null,
  cost: number | null,
  feePct: number | null,
): number | null {
  if (base == null || base <= 0 || cost == null) return null
  const fee = feePct != null ? base * (feePct / 100) : 0
  return ((base - fee - cost) / base) * 100
}

export default function CostGridClient() {
  const backend = getBackendUrl()
  const [rows, setRows] = useState<Row[]>([])
  const [feePct, setFeePct] = useState<number | null>(null)
  const [edits, setEdits] = useState<Map<string, number | null>>(new Map())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${backend}/api/products/costs`, { cache: 'no-store' })
      const d = await r.json().catch(() => null)
      setRows(d?.products ?? [])
      setFeePct(d?.amazonFeePct ?? null)
      setEdits(new Map())
    } catch {
      setError('Could not load costs.')
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) => r.sku.toLowerCase().includes(s) || r.name.toLowerCase().includes(s),
    )
  }, [rows, q])

  const costOf = (r: Row) => (edits.has(r.id) ? edits.get(r.id)! : r.costPrice)

  const setCost = useCallback((id: string, value: number | null) => {
    setEdits((prev) => {
      const next = new Map(prev)
      next.set(id, value)
      return next
    })
  }, [])

  // Paste a column of costs → fill down from the focused row.
  const onPaste = useCallback(
    (e: React.ClipboardEvent, startIdx: number) => {
      const text = e.clipboardData.getData('text')
      const lines = text.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1)
      if (lines.length <= 1) return // single value — let the input handle it
      e.preventDefault()
      setEdits((prev) => {
        const next = new Map(prev)
        lines.forEach((line, k) => {
          const row = filtered[startIdx + k]
          if (row) next.set(row.id, parseCost(line))
        })
        return next
      })
      setNote(`Pasted ${lines.length} costs`)
    },
    [filtered],
  )

  const save = useCallback(async () => {
    if (edits.size === 0) return
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const updates = [...edits.entries()].map(([productId, costPrice]) => ({
        productId,
        costPrice,
      }))
      const r = await fetch(`${backend}/api/products/costs`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) {
        setError(d?.error ?? 'Save failed.')
        return
      }
      setNote(`Saved ${d?.updated ?? 0} cost${d?.updated === 1 ? '' : 's'}`)
      await load()
    } catch {
      setError('Save failed.')
    } finally {
      setSaving(false)
    }
  }, [edits, backend, load])

  const missing = rows.filter((r) => costOf(r) == null).length

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
            <Coins className="w-5 h-5" /> Product costs (COGS)
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Enter or paste a column of per-unit costs. True margin uses your
            real Amazon fee rate
            {feePct != null ? ` (${feePct.toFixed(1)}%)` : ''}. Saved costs feed
            the profit calc and the Pricing Watchdog.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => void load()}
            className="h-9 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" /> Reload
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || edits.size === 0}
            className="h-9 px-4 text-base rounded bg-emerald-600 text-white inline-flex items-center gap-1.5 hover:bg-emerald-700 disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save{edits.size > 0 ? ` (${edits.size})` : ''}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-2.5 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter SKU / name…"
            className="h-8 pl-7 pr-3 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 w-64"
          />
        </div>
        <span className="text-slate-500 dark:text-slate-400">
          {missing} of {rows.length} still missing cost
        </span>
        {note && <span className="text-emerald-600 dark:text-emerald-400">{note}</span>}
        {error && (
          <span className="text-rose-600 dark:text-rose-400" role="alert">
            {error}
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> loading…
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 text-sm sticky top-0">
              <tr>
                <th className="text-left font-medium px-3 py-2">SKU</th>
                <th className="text-left font-medium px-3 py-2">Name</th>
                <th className="text-right font-medium px-3 py-2">Base €</th>
                <th className="text-right font-medium px-3 py-2">Cost €</th>
                <th className="text-right font-medium px-3 py-2">True margin</th>
                <th className="text-right font-medium px-3 py-2">Units 90d</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const cost = costOf(r)
                const m = trueMargin(r.basePrice, cost, feePct)
                const dirty = edits.has(r.id)
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-slate-100 dark:border-slate-800 ${dirty ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''}`}
                  >
                    <td className="px-3 py-1.5 font-mono text-sm text-slate-700 dark:text-slate-300">
                      {r.sku}
                    </td>
                    <td className="px-3 py-1.5 text-slate-700 dark:text-slate-200 max-w-xs truncate">
                      {r.name}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                      {r.basePrice != null ? r.basePrice.toFixed(2) : '—'}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input
                        ref={(el) => {
                          inputsRef.current[i] = el
                        }}
                        inputMode="decimal"
                        value={cost != null ? String(cost) : ''}
                        onChange={(e) => setCost(r.id, parseCost(e.target.value))}
                        onPaste={(e) => onPaste(e, i)}
                        placeholder="—"
                        className="w-20 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 focus:border-blue-400 focus:outline-none"
                      />
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        m == null
                          ? 'text-slate-400'
                          : m < 0
                            ? 'text-rose-600 dark:text-rose-400 font-medium'
                            : m < 15
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {m != null ? `${m.toFixed(0)}%` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">
                      {r.unitsSold90d || ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
