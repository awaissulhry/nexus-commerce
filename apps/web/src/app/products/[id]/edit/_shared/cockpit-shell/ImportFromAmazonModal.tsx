'use client'

// MA.3 — Import from Amazon parent. Reverse-maps the parent ASIN's published
// attributes UP into the master: previews proposals (POST /master/import-from-
// channel), the operator reviews (skip-by-default on conflicts), and accepted
// values are written via PATCH /global (categoryAttributes + localizedContent,
// both partial-safe merges). Composes with BM auto-map: map the channel fields
// first, then pull their values into the master.

import { useState } from 'react'
import { X, Loader2, DownloadCloud, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Proposal {
  masterPath: string
  group: 'attribute' | 'content'
  label: string
  sourceField: string
  value: unknown
  conflict: boolean
}
interface Skipped {
  sourceField: string
  reason: string
}
interface Props {
  productId: string
  amazonMarkets?: string[]
  open: boolean
  onClose: () => void
  onApplied: () => void
}

const EU_DEFAULTS = ['IT', 'DE', 'ES', 'FR', 'NL', 'SE', 'PL', 'BE', 'IE', 'AT', 'UK']

function preview(v: unknown): string {
  if (Array.isArray(v)) return v.join(' · ')
  return String(v ?? '')
}

export default function ImportFromAmazonModal({ productId, amazonMarkets, open, onClose, onApplied }: Props) {
  const markets = amazonMarkets && amazonMarkets.length > 0 ? amazonMarkets : EU_DEFAULTS
  const [market, setMarket] = useState(markets[0] ?? 'IT')
  const [mode, setMode] = useState<'flatfile' | 'amazon'>('flatfile')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [skipped, setSkipped] = useState<Skipped[]>([])
  const [accepted, setAccepted] = useState<Set<string>>(new Set())

  const runPreview = async () => {
    setLoading(true)
    setError(null)
    setProposals(null)
    try {
      const endpoint = mode === 'flatfile' ? 'import-from-flat-file' : 'import-from-channel'
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/master/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ channel: 'AMAZON', marketplace: market }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      const props: Proposal[] = json.proposals ?? []
      setProposals(props)
      setSkipped(json.skipped ?? [])
      // skip-by-default on conflicts (don't overwrite operator data)
      setAccepted(new Set(props.filter((p) => !p.conflict).map((p) => p.masterPath)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const toggle = (path: string) =>
    setAccepted((prev) => {
      const n = new Set(prev)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })

  const apply = async () => {
    if (!proposals) return
    const chosen = proposals.filter((p) => accepted.has(p.masterPath))
    if (chosen.length === 0) return
    const technical: Record<string, unknown> = {}
    const content: Record<string, Record<string, unknown>> = {}
    for (const p of chosen) {
      if (p.group === 'attribute') {
        technical[p.masterPath.slice('categoryAttributes.'.length)] = p.value
      } else {
        const [, loc, field] = p.masterPath.split('.')
        content[loc] = content[loc] ?? {}
        content[loc][field] = p.value
      }
    }
    const patch: Record<string, unknown> = {}
    if (Object.keys(technical).length > 0) patch.technical = technical
    for (const [loc, fields] of Object.entries(content)) patch[loc] = fields

    setApplying(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/global`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ patch }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b?.error ?? `HTTP ${res.status}`)
        return
      }
      onApplied()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  if (!open) return null

  const acceptedCount = accepted.size

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => !applying && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import from Amazon parent"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <DownloadCloud className="h-4 w-4 text-blue-500" /> Import attributes to master
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {mode === 'flatfile'
                ? 'Fill the master from your flat-file data (read-only — nothing is written back to the flat file).'
                : "Pull the parent listing's attributes up via your mapping rules."}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={applying} aria-label="Close" className="rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs dark:border-slate-800">
          <div className="inline-flex overflow-hidden rounded border border-slate-300 dark:border-slate-700">
            <button
              type="button"
              onClick={() => {
                setMode('flatfile')
                setProposals(null)
              }}
              className={mode === 'flatfile' ? 'bg-blue-600 px-2 py-1 font-medium text-white' : 'px-2 py-1 text-slate-600 dark:text-slate-300'}
            >
              Flat file
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('amazon')
                setProposals(null)
              }}
              className={mode === 'amazon' ? 'bg-blue-600 px-2 py-1 font-medium text-white' : 'px-2 py-1 text-slate-600 dark:text-slate-300'}
            >
              Amazon rules
            </button>
          </div>
          <label className="text-slate-500">Source market</label>
          <select
            value={market}
            onChange={(e) => {
              setMarket(e.target.value)
              setProposals(null)
            }}
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          >
            {markets.map((m) => (
              <option key={m} value={m}>
                AMAZON · {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={runPreview}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <DownloadCloud className="h-3 w-3" />} Preview
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {error && <div className="mb-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
          {!proposals && !loading && !error && (
            <div className="py-12 text-center text-xs text-slate-500">Pick the source market and hit Preview to see what can be imported.</div>
          )}
          {proposals && proposals.length === 0 && (
            <div className="py-12 text-center text-xs text-slate-500">
              Nothing to import — the listing has no mapped values, or every rule is non-invertible. Map fields first (Mapping tab → Auto-map).
            </div>
          )}
          {proposals && proposals.length > 0 && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:bg-slate-900">
                <tr>
                  <th className="w-8 py-1"></th>
                  <th className="py-1">Master field</th>
                  <th className="py-1">Value (from {market})</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.masterPath} className="border-t border-slate-100 dark:border-slate-800/60">
                    <td className="py-1">
                      <input type="checkbox" checked={accepted.has(p.masterPath)} onChange={() => toggle(p.masterPath)} />
                    </td>
                    <td className="py-1 pr-2">
                      <span className="font-mono text-slate-700 dark:text-slate-300">{p.label}</span>
                      <span className="ml-1 text-[10px] text-slate-400">{p.group}</span>
                      {p.conflict && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400" title="master already has a value — unchecked by default">
                          <AlertTriangle className="h-3 w-3" /> has value
                        </span>
                      )}
                    </td>
                    <td className="py-1 max-w-[260px] truncate text-slate-600 dark:text-slate-300" title={preview(p.value)}>
                      {preview(p.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {skipped.length > 0 && (
            <div className="mt-3 rounded bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-slate-800/40">
              <div className="mb-1 font-medium">Skipped ({skipped.length})</div>
              {skipped.slice(0, 8).map((s) => (
                <div key={s.sourceField}>
                  <span className="font-mono">{s.sourceField}</span> — {s.reason}
                </div>
              ))}
              {skipped.length > 8 && <div>+{skipped.length - 8} more</div>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          {proposals && <span className="mr-auto text-xs text-slate-500">{acceptedCount} selected</span>}
          <button type="button" onClick={onClose} disabled={applying} className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            Cancel
          </button>
          {proposals && proposals.length > 0 && (
            <button
              type="button"
              onClick={apply}
              disabled={applying || acceptedCount === 0}
              className={cn('inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50')}
            >
              {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Import {acceptedCount} to master
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
