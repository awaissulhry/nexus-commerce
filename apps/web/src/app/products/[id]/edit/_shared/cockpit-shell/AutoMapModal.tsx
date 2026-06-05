'use client'

// BM.3 — Auto-map review modal. The answer to "hundreds of fields, can't map
// them manually": one click runs the (free) heuristic suggester across all
// unmapped fields, optionally "Enhance with AI" for the long tail, then the
// operator reviews a dense table (accept-all-high / accept-all / per-row),
// optionally auto-translates text fields, and bulk-applies in ONE revision.
//
// Reuses: GET /suggest (FM.13) + POST /suggest-ai (BM.2) + POST /bulk (BM.1).
// Review-gated — nothing is written until Apply.

import { useCallback, useEffect, useState } from 'react'
import { X, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Suggestion {
  fieldKey: string
  label: string | null
  suggestedSource: string
  confidence: 'high' | 'medium'
  reason: string
}
interface Row {
  fieldKey: string
  source: string
  confidence: 'high' | 'medium'
  reason: string
  ai: boolean
  accepted: boolean
}
interface Coordinate {
  channel: string
  marketplace: string
}

interface Props {
  coordinates: Coordinate[]
  productType?: string | null
  open: boolean
  onClose: () => void
  onApplied: () => void
}

// Text fields worth auto-translating when the market language differs.
const TEXT_FIELD_RE = /title|name|description|bullet|keyword|feature|search_term|caption/i

export default function AutoMapModal({ coordinates, productType, open, onClose, onApplied }: Props) {
  const [coord, setCoord] = useState<Coordinate | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [translate, setTranslate] = useState(true)
  // BM.5 — write to the productType overlay (default) or the channel-wide
  // default bucket (every productType then inherits these rules).
  const [scope, setScope] = useState<'productType' | 'channel'>('productType')
  const [error, setError] = useState<string | null>(null)

  const qs = productType ? `?productType=${encodeURIComponent(productType)}` : ''

  useEffect(() => {
    if (open) {
      setCoord(coordinates[0] ?? null)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const loadHeuristic = useCallback(
    async (c: Coordinate) => {
      setLoading(true)
      setError(null)
      setRows([])
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/pim/mappings/${c.channel}/${c.marketplace}/suggest${qs}`,
          { credentials: 'include' },
        )
        const json = await res.json()
        if (!res.ok) {
          setError(json?.error ?? `HTTP ${res.status}`)
          return
        }
        const sugg: Suggestion[] = json.suggestions ?? []
        setRows(
          sugg.map((s) => ({
            fieldKey: s.fieldKey,
            source: s.suggestedSource,
            confidence: s.confidence,
            reason: s.reason,
            ai: false,
            accepted: s.confidence === 'high', // default-accept the confident ones
          })),
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [qs],
  )

  useEffect(() => {
    if (open && coord) void loadHeuristic(coord)
  }, [open, coord, loadHeuristic])

  const enhanceAI = useCallback(async () => {
    if (!coord) return
    setAiBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}/suggest-ai${qs}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      const aiSugg: Suggestion[] = json.suggestions ?? []
      setRows((prev) => {
        const have = new Set(prev.map((r) => r.fieldKey))
        const add = aiSugg
          .filter((s) => !have.has(s.fieldKey))
          .map((s) => ({
            fieldKey: s.fieldKey,
            source: s.suggestedSource,
            confidence: s.confidence,
            reason: s.reason,
            ai: true,
            accepted: false, // AI guesses default to unchecked — review first
          }))
        if (add.length === 0 && !json.aiUsed) setError(json.reason ?? 'AI added no new suggestions.')
        return [...prev, ...add]
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }, [coord, qs])

  const acceptedCount = rows.filter((r) => r.accepted && r.source.trim()).length
  const setAll = (pred: (r: Row) => boolean) => setRows((rs) => rs.map((r) => ({ ...r, accepted: pred(r) })))

  const apply = useCallback(async () => {
    if (!coord) return
    const accepted = rows.filter((r) => r.accepted && r.source.trim())
    if (accepted.length === 0) return
    setApplying(true)
    setError(null)
    const rules = accepted.map((r) => ({
      fieldKey: r.fieldKey,
      rule: {
        source: r.source.trim(),
        ...(translate && TEXT_FIELD_RE.test(r.fieldKey) ? { transforms: [{ type: 'translate' }] } : {}),
      },
    }))
    const applyQs = scope === 'channel' ? '' : qs // channel-wide → default bucket
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}/bulk${applyQs}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ rules }) },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const details = Array.isArray(json?.details) ? ` — ${json.details.join('; ')}` : ''
        setError((json?.error ?? `HTTP ${res.status}`) + details)
        return
      }
      onApplied()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }, [coord, rows, translate, scope, qs, onApplied, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={() => !applying && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Auto-map fields"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <Wand2 className="h-4 w-4 text-blue-500" /> Auto-map fields
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              Review suggested rules + apply in one go
              {scope === 'channel' ? ' · channel-wide (all product types inherit)' : productType ? ` · for all ${productType}` : ''}.
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={applying} aria-label="Close" className="rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-xs dark:border-slate-800">
          <select
            value={coord ? `${coord.channel}:${coord.marketplace}` : ''}
            onChange={(e) => {
              const [channel, marketplace] = e.target.value.split(':')
              setCoord({ channel, marketplace })
            }}
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          >
            {coordinates.map((c) => (
              <option key={`${c.channel}:${c.marketplace}`} value={`${c.channel}:${c.marketplace}`}>
                {c.channel} · {c.marketplace}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={enhanceAI}
            disabled={aiBusy || loading}
            className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
          >
            {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Enhance with AI
          </button>
          <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
          <button type="button" onClick={() => setAll((r) => r.confidence === 'high')} className="rounded px-1.5 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            Accept high
          </button>
          <button type="button" onClick={() => setAll(() => true)} className="rounded px-1.5 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            Accept all
          </button>
          <button type="button" onClick={() => setAll(() => false)} className="rounded px-1.5 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            Clear
          </button>
          {productType && (
            <>
              <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'productType' | 'channel')}
                title="Where to write the accepted rules"
                className="rounded border border-slate-300 bg-white px-1.5 py-1 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="productType">Apply to: {productType}</option>
                <option value="channel">Apply to: all product types (channel-wide)</option>
              </select>
            </>
          )}
          <label className="ml-auto inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
            <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} /> Auto-translate text fields
          </label>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading suggestions…
            </div>
          )}
          {error && <div className="mb-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
          {!loading && rows.length === 0 && !error && (
            <div className="py-12 text-center text-xs text-slate-500">
              No suggestions — every field may already be mapped, or none matched. Try “Enhance with AI”.
            </div>
          )}
          {rows.length > 0 && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:bg-slate-900">
                <tr>
                  <th className="w-8 py-1"></th>
                  <th className="py-1">Field</th>
                  <th className="py-1">Source (master attribute)</th>
                  <th className="w-20 py-1">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.fieldKey} className="border-t border-slate-100 dark:border-slate-800/60">
                    <td className="py-1">
                      <input
                        type="checkbox"
                        checked={r.accepted}
                        onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, accepted: e.target.checked } : x)))}
                      />
                    </td>
                    <td className="py-1 pr-2 font-mono text-slate-700 dark:text-slate-300" title={r.reason}>
                      {r.fieldKey}
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        value={r.source}
                        onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))}
                        className="w-full rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                      />
                    </td>
                    <td className="py-1">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-medium',
                          r.ai
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                            : r.confidence === 'high'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
                        )}
                      >
                        {r.ai ? 'AI' : r.confidence}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          <span className="mr-auto text-xs text-slate-500">{acceptedCount} of {rows.length} selected</span>
          <button type="button" onClick={onClose} disabled={applying} className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={applying || acceptedCount === 0}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Apply {acceptedCount} rule{acceptedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
