'use client'

// BM.4 — Clone a coordinate's mapping rules to other markets in one shot.
// Map Amazon IT once, then clone to DE/ES/FR (filtered to each market's
// fields, optionally adding `translate` for cross-language markets). Calls
// POST /api/pim/mappings/clone (BM.4); each target is FM.13-versioned.

import { useEffect, useState } from 'react'
import { X, Loader2, Copy, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { Listbox } from '@/design-system/components/Listbox'

interface Coordinate {
  channel: string
  marketplace: string
}
interface CloneResult {
  channel: string
  marketplace: string
  cloned: number
  skipped: number
  error?: string
}
interface Props {
  coordinates: Coordinate[]
  productType?: string | null
  open: boolean
  onClose: () => void
  onApplied: () => void
}

const ckey = (c: Coordinate) => `${c.channel}:${c.marketplace}`

export default function CloneMappingModal({ coordinates, productType, open, onClose, onApplied }: Props) {
  const [from, setFrom] = useState('')
  const [targets, setTargets] = useState<Set<string>>(new Set())
  const [addTranslate, setAddTranslate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<CloneResult[] | null>(null)

  useEffect(() => {
    if (!open) return
    setFrom(coordinates[0] ? ckey(coordinates[0]) : '')
    setTargets(new Set())
    setResults(null)
    setError(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) =>
    setTargets((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const clone = async () => {
    if (!from || targets.size === 0) return
    const [fc, fm] = from.split(':')
    const tlist = [...targets].map((k) => {
      const [channel, marketplace] = k.split(':')
      return { channel, code: marketplace }
    })
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pim/mappings/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          from: { channel: fc, code: fm },
          targets: tlist,
          productType: productType ?? undefined,
          addTranslate,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      setResults(
        (json.results ?? []).map((r: { channel: string; code: string; cloned: number; skipped: number; error?: string }) => ({
          channel: r.channel,
          marketplace: r.code,
          cloned: r.cloned,
          skipped: r.skipped,
          error: r.error,
        })),
      )
      onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const targetOptions = coordinates.filter((c) => ckey(c) !== from)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Clone mapping to other markets"
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-default bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3 dark:border-slate-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Copy className="h-4 w-4 text-blue-500" /> Clone mapping to other markets
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">Copy rules from</div>
            <Listbox
              value={from}
              onChange={(v) => {
                setFrom(v)
                setTargets((prev) => {
                  const n = new Set(prev)
                  n.delete(v)
                  return n
                })
              }}
              ariaLabel="Copy rules from"
              className="w-full"
              options={coordinates.map((c) => ({ value: ckey(c), label: `${c.channel} · ${c.marketplace}` }))}
            />
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">To ({targets.size} selected)</div>
            <div className="space-y-1 rounded border border-default p-2 dark:border-slate-700">
              {targetOptions.length === 0 && <div className="text-xs text-tertiary">No other coordinates on this product.</div>}
              {targetOptions.map((c) => (
                <label key={ckey(c)} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={targets.has(ckey(c))} onChange={() => toggle(ckey(c))} />
                  <span className="text-slate-700 dark:text-slate-300">{c.channel} · {c.marketplace}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={addTranslate} onChange={(e) => setAddTranslate(e.target.checked)} />
            Auto-translate text fields (for different-language markets)
          </label>

          {error && <div className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}

          {results && (
            <div className="space-y-1">
              {results.map((r) => (
                <div
                  key={`${r.channel}:${r.marketplace}`}
                  className={cn(
                    'flex items-center gap-2 rounded border px-2 py-1.5 text-xs',
                    r.error
                      ? 'border-rose-200 bg-rose-50/40 text-rose-700 dark:border-rose-800 dark:bg-rose-950/20 dark:text-rose-300'
                      : 'border-emerald-100 text-slate-700 dark:border-emerald-900/40 dark:text-slate-300',
                  )}
                >
                  {!r.error && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  <span className="font-medium">{r.channel} · {r.marketplace}</span>
                  {r.error ? <span>— {r.error}</span> : <span className="text-slate-500">— {r.cloned} cloned{r.skipped ? `, ${r.skipped} skipped (not in this market)` : ''}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-subtle px-4 py-3 dark:border-slate-800">
          <button type="button" onClick={onClose} disabled={busy} className="rounded border border-default px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            {results ? 'Close' : 'Cancel'}
          </button>
          {!results && (
            <button
              type="button"
              onClick={clone}
              disabled={busy || !from || targets.size === 0}
              className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
              Clone to {targets.size}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
