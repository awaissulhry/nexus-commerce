'use client'

/**
 * FX.5b — Smart Import Wizard.
 *
 * Brings an EXTERNAL file (supplier CSV/XLSX/TSV/JSON) into the flat-file grid
 * in three reviewed steps, on top of the FX.2–FX.5a backend:
 *   1. Upload / paste → POST /parse (raw headers + rows)
 *   2. Review mapping → POST /suggest-mapping (auto-mapped; operator overrides
 *      each header→column; "skip" a header to exclude that column entirely)
 *   3. Preview → POST /coerce (values fit the column) → POST /plan-import (diff
 *      vs the grid by item_sku); choose fill-missing | overwrite, deselect any
 *      row/cell, then apply.
 *
 * The apply itself is handed to the parent (onApply) — like PullDiffModal — so
 * the grid mutation + ⌘Z snapshot live with the row state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload, X, ChevronRight, ChevronDown, ArrowRight, CheckCircle2,
  AlertTriangle, Loader2, Sparkles, Wand2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'

interface Row { _rowId: string; [key: string]: unknown }

type MappingSource = 'exact-id' | 'exact-label' | 'normalized' | 'alias' | 'ai' | 'none'
interface HeaderMapping { header: string; columnId: string | null; confidence: number; source: MappingSource; reason: string }
interface SuggestResponse { mappings: HeaderMapping[]; unmappedHeaders: string[]; unmappedColumns: string[]; columnCount: number }

interface CoerceIssue { rowIndex: number; columnId: string; status: 'coerced' | 'flagged'; from: string; to: string; note?: string }
interface CoerceResponse { rows: Record<string, unknown>[]; issues: CoerceIssue[]; counts: { ok: number; coerced: number; flagged: number } }

type PlanReason = 'fill' | 'overwrite' | 'skip-existing' | 'skip-column'
interface PlanCell { columnId: string; from: string; to: string; willApply: boolean; reason: PlanReason }
interface PlanNewRow { sku: string; cells: PlanCell[] }
interface PlanUpdate { sku: string; rowId: string; cells: PlanCell[] }
interface ImportPlan {
  newRows: PlanNewRow[]; updates: PlanUpdate[]; skippedNoSku: number; duplicateSkus: number; unmatchedSkipped: string[]
  stats: { newRows: number; updatedRows: number; cellsToApply: number; cellsToSkip: number }
}

export interface ImportApplyResult {
  newRows: Array<{ sku: string; cells: Record<string, string> }>
  updates: Array<{ rowId: string; cells: Record<string, string> }>
  cellCount: number
}

export interface ImportWizardModalProps {
  open: boolean
  marketplace: string
  productType: string
  productTypes?: string[]
  currentRows: Row[]
  columnLabels: Map<string, string>
  /** All flat-file column ids (for the mapping dropdown), in grid order. */
  columnIds: string[]
  onApply: (result: ImportApplyResult) => void
  onClose: () => void
}

type Step = 'upload' | 'mapping' | 'preview'
type Mode = 'fill-missing' | 'overwrite'

async function fileToPayload(file: File): Promise<{ filename: string; text?: string; bytesBase64?: string }> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    return { filename: file.name, bytesBase64: btoa(bin) }
  }
  return { filename: file.name, text: await file.text() }
}

// FX.6b — per-source mapping presets (localStorage). A preset captures the
// operator's header→column mapping + AI toggle for a recurring supplier file,
// keyed by its header set, so a re-import auto-applies last time's choices.
interface ImportPreset { name: string; headers: string[]; mapping: Record<string, string | null>; useAi: boolean; createdAt: number }
const PRESETS_KEY = 'ff-import-presets'
const headerKey = (h: string[]) => [...h].map((s) => s.toLowerCase().trim()).sort().join('|')
function loadPresets(): ImportPreset[] {
  try { const v = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
function persistPresets(p: ImportPreset[]) { try { localStorage.setItem(PRESETS_KEY, JSON.stringify(p)) } catch { /* quota */ } }

const SOURCE_BADGE: Record<MappingSource, { label: string; cls: string }> = {
  'exact-id': { label: 'exact', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
  'exact-label': { label: 'label', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
  'normalized': { label: 'fuzzy', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300' },
  'alias': { label: 'alias', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300' },
  'ai': { label: 'AI', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300' },
  'none': { label: 'none', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
}

export function ImportWizardModal({
  open, marketplace, productType, productTypes, currentRows, columnLabels, columnIds, onApply, onClose,
}: ImportWizardModalProps) {
  const [step, setStep] = useState<Step>('upload')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, unknown>[] } | null>(null)
  const [suggest, setSuggest] = useState<SuggestResponse | null>(null)
  const [mapping, setMapping] = useState<Map<string, string | null>>(new Map())
  const [useAi, setUseAi] = useState(true)
  const [coerced, setCoerced] = useState<CoerceResponse | null>(null)
  const [mode, setMode] = useState<Mode>('fill-missing')
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({}) // `${rowKey}::${columnId}` → willApply
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [presets, setPresets] = useState<ImportPreset[]>([])
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null)
  const [validateBySku, setValidateBySku] = useState<Record<string, { errors: number; warnings: number }>>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMapped, setAiMapped] = useState<Set<string>>(new Set()) // headers mapped by the AI tail
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const typeParam = useMemo(
    () => (productTypes && productTypes.length > 1 ? { productTypes } : { productType }),
    [productTypes, productType],
  )

  useEffect(() => {
    if (!open) {
      setStep('upload'); setBusy(false); setError(null); setFileName(''); setPasteText('')
      setParsed(null); setSuggest(null); setMapping(new Map()); setCoerced(null)
      setMode('fill-missing'); setPlan(null); setOverrides({}); setExpanded(new Set())
      setAppliedPreset(null); setValidateBySku({}); setAiBusy(false); setAiMapped(new Set())
    } else {
      setPresets(loadPresets())
    }
  }, [open])

  const post = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json?.error ?? `${path} failed`)
    return json
  }, [])

  // ── Step 1 → parse ────────────────────────────────────────────────
  const runParse = useCallback(async (payload: { filename: string; text?: string; bytesBase64?: string }) => {
    setBusy(true); setError(null)
    try {
      const res = await post('parse', payload) as { headers: string[]; rows: Record<string, unknown>[] }
      if (!res.headers?.length) throw new Error('No columns found in the file')
      setParsed({ headers: res.headers, rows: res.rows ?? [] })
      const sug = await post('suggest-mapping', { headers: res.headers, marketplace, ...typeParam }) as SuggestResponse
      setSuggest(sug)
      setMapping(new Map(sug.mappings.map((m) => [m.header, m.columnId])))
      // FX.6b — a saved preset for this exact header set overrides the auto-map.
      const preset = loadPresets().find((p) => headerKey(p.headers) === headerKey(res.headers))
      if (preset) { setMapping(new Map(Object.entries(preset.mapping))); setUseAi(preset.useAi); setAppliedPreset(preset.name) }
      else setAppliedPreset(null)
      setStep('mapping')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed')
    } finally {
      setBusy(false)
    }
  }, [post, marketplace, typeParam])

  const onFile = useCallback(async (file: File) => {
    setFileName(file.name)
    runParse(await fileToPayload(file))
  }, [runParse])

  const onPaste = useCallback(() => {
    if (!pasteText.trim()) return
    setFileName('pasted data')
    runParse({ filename: 'pasted.tsv', text: pasteText })
  }, [pasteText, runParse])

  const savePreset = useCallback(() => {
    if (!parsed) return
    const suggestedName = fileName.replace(/\.[^.]+$/, '') || 'Supplier'
    const name = (typeof window !== 'undefined' ? window.prompt('Save this mapping as a preset (re-used when a file with the same columns is imported):', suggestedName) : '')?.trim()
    if (!name) return
    const preset: ImportPreset = { name, headers: parsed.headers, mapping: Object.fromEntries(mapping), useAi, createdAt: Date.now() }
    const next = [...presets.filter((p) => p.name !== name), preset]
    setPresets(next); persistPresets(next); setAppliedPreset(name)
  }, [parsed, fileName, mapping, useAi, presets])

  const applyPreset = useCallback((name: string) => {
    const p = presets.find((x) => x.name === name)
    if (!p) return
    setMapping(new Map(Object.entries(p.mapping))); setUseAi(p.useAi); setAppliedPreset(p.name)
  }, [presets])

  // FX.7 — AI-map the headers the heuristic + operator left unmapped.
  const aiMapRemaining = useCallback(async () => {
    if (!parsed || !suggest) return
    const unmapped = suggest.mappings.map((m) => m.header).filter((h) => !mapping.get(h))
    if (!unmapped.length) return
    setAiBusy(true); setError(null)
    try {
      const samples: Record<string, string> = {}
      for (const h of unmapped) samples[h] = String(parsed.rows[0]?.[h] ?? '').slice(0, 60)
      const res = await post('suggest-columns-ai', { headers: unmapped, samples, marketplace, ...typeParam }) as { suggestions: Record<string, { columnId: string; confidence: number } | null> }
      const next = new Map(mapping)
      const ai = new Set(aiMapped)
      for (const [h, s] of Object.entries(res.suggestions ?? {})) {
        if (s && !next.get(h)) { next.set(h, s.columnId); ai.add(h) }
      }
      setMapping(next); setAiMapped(ai)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI mapping failed')
    } finally {
      setAiBusy(false)
    }
  }, [parsed, suggest, mapping, aiMapped, post, marketplace, typeParam])

  // ── Step 2 → coerce + plan ────────────────────────────────────────
  const mappedRows = useMemo(() => {
    if (!parsed) return []
    const pairs = [...mapping].filter(([, col]) => col) as Array<[string, string]>
    return parsed.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [header, col] of pairs) if (header in row) out[col] = row[header]
      return out
    })
  }, [parsed, mapping])

  const mappedCount = useMemo(() => [...mapping.values()].filter(Boolean).length, [mapping])

  const buildPlan = useCallback(async (rows: Record<string, unknown>[], nextMode: Mode) => {
    return await post('plan-import', {
      existing: currentRows, incoming: rows, mode: nextMode, addNewRows: true,
    }) as ImportPlan
  }, [post, currentRows])

  const goToPreview = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const co = await post('coerce', { rows: mappedRows, marketplace, ...typeParam, ai: useAi }) as CoerceResponse
      setCoerced(co)
      // FX.6b — pre-flight the coerced rows (best-effort; never blocks the preview).
      const vmap: Record<string, { errors: number; warnings: number }> = {}
      try {
        const val = await post('validate-rows', { rows: co.rows, marketplace, ...typeParam }) as { results: Array<{ sku: string; issues: Array<{ severity: 'error' | 'warning' }> }> }
        for (const r of val.results ?? []) {
          vmap[r.sku] = {
            errors: r.issues.filter((i) => i.severity === 'error').length,
            warnings: r.issues.filter((i) => i.severity === 'warning').length,
          }
        }
      } catch { /* validation is advisory */ }
      setValidateBySku(vmap)
      const p = await buildPlan(co.rows, mode)
      setPlan(p); setOverrides({}); setExpanded(new Set())
      setStep('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coercion failed')
    } finally {
      setBusy(false)
    }
  }, [post, mappedRows, marketplace, typeParam, useAi, buildPlan, mode])

  const changeMode = useCallback(async (next: Mode) => {
    if (!coerced || next === mode) return
    setMode(next); setBusy(true)
    try {
      const p = await buildPlan(coerced.rows, next)
      setPlan(p); setOverrides({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-plan failed')
    } finally {
      setBusy(false)
    }
  }, [coerced, mode, buildPlan])

  // ── willApply resolution (plan default ± local overrides) ─────────
  const cellKey = (rowKey: string, columnId: string) => `${rowKey}::${columnId}`
  const isOn = useCallback((rowKey: string, c: PlanCell) => {
    const k = cellKey(rowKey, c.columnId)
    return k in overrides ? overrides[k] : c.willApply
  }, [overrides])
  const toggleCell = (rowKey: string, c: PlanCell) => {
    setOverrides((prev) => ({ ...prev, [cellKey(rowKey, c.columnId)]: !(cellKey(rowKey, c.columnId) in prev ? prev[cellKey(rowKey, c.columnId)] : c.willApply) }))
  }
  const toggleExpand = (key: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const applyResult = useMemo<ImportApplyResult>(() => {
    if (!plan) return { newRows: [], updates: [], cellCount: 0 }
    let cellCount = 0
    const pick = (rowKey: string, cells: PlanCell[]) => {
      const out: Record<string, string> = {}
      for (const c of cells) if (isOn(rowKey, c)) { out[c.columnId] = c.to; cellCount++ }
      return out
    }
    const newRows = plan.newRows
      .map((n) => ({ sku: n.sku, cells: pick(`new:${n.sku}`, n.cells) }))
      .filter((n) => Object.keys(n.cells).length > 0)
    const updates = plan.updates
      .map((u) => ({ rowId: u.rowId, cells: pick(`upd:${u.rowId}`, u.cells) }))
      .filter((u) => Object.keys(u.cells).length > 0)
    return { newRows, updates, cellCount }
  }, [plan, isOn])

  if (!open) return null

  const label = (col: string) => columnLabels.get(col) ?? col
  const flaggedCount = coerced?.counts.flagged ?? 0
  const needsRequired = plan ? plan.newRows.filter((n) => (validateBySku[n.sku]?.errors ?? 0) > 0).length : 0

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-10 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="Smart import"
        className="w-[940px] max-w-full max-h-[88vh] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">

        {/* Header + stepper */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            <Wand2 className="w-4 h-4 text-violet-600" /> Smart import
            <span className="text-xs font-normal text-slate-500">· {marketplace} · {productTypes && productTypes.length > 1 ? `${productTypes.length} types` : productType}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            {(['upload', 'mapping', 'preview'] as Step[]).map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300" />}
                <span className={cn('px-2 py-0.5 rounded-full capitalize',
                  step === s ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}>
                  {i + 1}. {s === 'upload' ? 'Upload' : s === 'mapping' ? 'Map' : 'Preview'}
                </span>
              </span>
            ))}
          </div>
          <button onClick={() => !busy && onClose()} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="px-5 py-2 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2 flex-shrink-0">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* STEP 1 — upload / paste */}
          {step === 'upload' && (
            <div className="space-y-4">
              <button type="button" onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void onFile(f) }}
                className={cn('w-full border-2 border-dashed rounded-xl py-10 flex flex-col items-center gap-2 transition-colors',
                  dragOver ? 'border-violet-400 bg-violet-50/60 dark:bg-violet-950/20' : 'border-slate-300 dark:border-slate-700 hover:border-violet-400 hover:bg-violet-50/40 dark:hover:bg-violet-950/10')}>
                <Upload className="w-7 h-7 text-slate-400" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{dragOver ? 'Drop to import' : 'Choose a file or drag it here'}</span>
                <span className="text-xs text-slate-500">CSV · Excel (.xlsx) · TSV · JSON — supplier columns are auto-mapped next</span>
              </button>
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} />
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <div className="flex-1 border-t border-slate-200 dark:border-slate-800" /> or paste rows
                <div className="flex-1 border-t border-slate-200 dark:border-slate-800" />
              </div>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={5}
                placeholder={'Paste tab- or comma-separated rows (first row = headers)…'}
                className="w-full text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2.5 focus:outline-none focus:border-violet-400" />
              <div className="flex justify-end">
                <Button size="sm" onClick={onPaste} disabled={!pasteText.trim() || busy} loading={busy}>
                  Parse pasted data <ArrowRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* STEP 2 — mapping */}
          {step === 'mapping' && parsed && suggest && (
            <div className="space-y-3">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {fileName && <span className="font-medium text-slate-600 dark:text-slate-300">{fileName} — </span>}
                {parsed.rows.length} row{parsed.rows.length !== 1 ? 's' : ''} · {parsed.headers.length} columns ·{' '}
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">{mappedCount} mapped</span>.
                Set a column to <em>Skip</em> to leave it out.
              </div>
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {appliedPreset && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Preset “{appliedPreset}”
                  </span>
                )}
                {presets.length > 0 && (
                  <select value="" onChange={(e) => { if (e.target.value) applyPreset(e.target.value) }}
                    className="text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:border-violet-400">
                    <option value="">Load preset…</option>
                    {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                )}
                <button type="button" onClick={savePreset}
                  className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
                  Save as preset
                </button>
                {suggest.mappings.length - mappedCount > 0 && (
                  <button type="button" onClick={() => void aiMapRemaining()} disabled={aiBusy}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-50">
                    {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    AI-map remaining ({suggest.mappings.length - mappedCount})
                  </button>
                )}
              </div>
              <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Their column</th>
                      <th className="px-2 py-2 w-6" />
                      <th className="text-left px-3 py-2 font-medium">→ Flat-file column</th>
                      <th className="text-left px-3 py-2 font-medium w-20">Match</th>
                      <th className="text-left px-3 py-2 font-medium">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggest.mappings.map((m) => {
                      const sample = String(parsed.rows[0]?.[m.header] ?? '')
                      const badge = SOURCE_BADGE[aiMapped.has(m.header) ? 'ai' : (mapping.get(m.header) ? m.source : 'none')]
                      return (
                        <tr key={m.header} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="px-3 py-1.5 font-medium text-slate-700 dark:text-slate-200 break-all">{m.header}</td>
                          <td className="px-2 py-1.5 text-slate-300"><ArrowRight className="w-3.5 h-3.5" /></td>
                          <td className="px-3 py-1.5">
                            <select value={mapping.get(m.header) ?? ''}
                              aria-label={`Map column ${m.header}`}
                              onChange={(e) => {
                                setMapping((prev) => new Map(prev).set(m.header, e.target.value || null))
                                setAiMapped((prev) => { if (!prev.has(m.header)) return prev; const n = new Set(prev); n.delete(m.header); return n })
                              }}
                              className="w-full max-w-[240px] text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 py-1 focus:outline-none focus:border-violet-400">
                              <option value="">— Skip —</option>
                              {columnIds.map((c) => <option key={c} value={c}>{label(c)}{label(c) !== c ? ` (${c})` : ''}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-1.5">
                            <span className={cn('text-[9px] uppercase font-medium px-1.5 py-0.5 rounded', badge.cls)}>{badge.label}</span>
                          </td>
                          <td className="px-3 py-1.5 text-slate-400 truncate max-w-[160px]">{sample || <span className="italic">(empty)</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} className="w-3.5 h-3.5 accent-violet-600" />
                <Sparkles className="w-3.5 h-3.5 text-violet-500" /> Use AI to match values to allowed options (e.g. “rosso” → “Red”)
              </label>
            </div>
          )}

          {/* STEP 3 — preview */}
          {step === 'preview' && plan && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
                  {(['fill-missing', 'overwrite'] as Mode[]).map((m) => (
                    <button key={m} type="button" onClick={() => void changeMode(m)} disabled={busy}
                      className={cn('px-3 py-1.5', mode === m ? 'bg-violet-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300')}>
                      {m === 'fill-missing' ? 'Fill only missing' : 'Overwrite'}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">{plan.stats.newRows}</span> new ·{' '}
                  <span className="font-semibold text-sky-600 dark:text-sky-400">{plan.stats.updatedRows}</span> updated
                  {flaggedCount > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{flaggedCount} value{flaggedCount !== 1 ? 's' : ''} flagged</span></>}
                  {needsRequired > 0 && <> · <span className="text-rose-600 dark:text-rose-400">{needsRequired} missing required</span></>}
                  {plan.duplicateSkus > 0 && <> · {plan.duplicateSkus} duplicate{plan.duplicateSkus !== 1 ? 's' : ''} merged</>}
                  {plan.skippedNoSku > 0 && <> · {plan.skippedNoSku} skipped (no SKU)</>}
                </div>
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
              </div>

              {plan.newRows.length === 0 && plan.updates.length === 0 && (
                <div className="text-center py-10 text-sm text-slate-500">Nothing to apply — the import matches the grid for the mapped columns.</div>
              )}

              {[
                { title: 'New rows', kind: 'new' as const, items: plan.newRows.map((n) => ({ key: `new:${n.sku}`, sku: n.sku, rowId: '', cells: n.cells })) },
                { title: 'Updates', kind: 'upd' as const, items: plan.updates.map((u) => ({ key: `upd:${u.rowId}`, sku: u.sku, rowId: u.rowId, cells: u.cells })) },
              ].filter((g) => g.items.length > 0).map((group) => (
                <div key={group.kind}>
                  <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">{group.title} ({group.items.length})</div>
                  <div className="space-y-1">
                    {group.items.map((it) => {
                      const isOpen = expanded.has(it.key)
                      const onCount = it.cells.filter((c) => isOn(it.key, c)).length
                      return (
                        <div key={it.key} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <button type="button" onClick={() => toggleExpand(it.key)} className="text-slate-400 hover:text-slate-600">
                              {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </button>
                            <span className="font-mono text-xs text-slate-700 dark:text-slate-200">{it.sku}</span>
                            <span className={cn('text-[10px] px-1.5 py-0.5 rounded',
                              group.kind === 'new' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300')}>
                              {group.kind === 'new' ? 'new' : 'update'}
                            </span>
                            {group.kind === 'new' && (validateBySku[it.sku]?.errors ?? 0) > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                                title="This new row is still missing Amazon-required fields">
                                ⚠ {validateBySku[it.sku]?.errors} required
                              </span>
                            )}
                            <span className="ml-auto text-[10px] text-slate-500">{onCount}/{it.cells.length} cell{it.cells.length !== 1 ? 's' : ''}</span>
                          </div>
                          {isOpen && (
                            <table className="w-full text-xs border-t border-slate-100 dark:border-slate-800">
                              <tbody>
                                {it.cells.map((c) => (
                                  <tr key={c.columnId} className={cn('border-b border-slate-50 dark:border-slate-800/50 last:border-0', !isOn(it.key, c) && 'opacity-45')}>
                                    <td className="px-2 py-1 w-7">
                                      <input type="checkbox" checked={isOn(it.key, c)} onChange={() => toggleCell(it.key, c)} className="w-3.5 h-3.5 accent-violet-600" />
                                    </td>
                                    <td className="px-2 py-1 text-slate-700 dark:text-slate-200 align-top break-all">{label(c.columnId)}</td>
                                    <td className="px-2 py-1 text-slate-400 align-top break-all w-2/5">{c.from || <span className="italic">(empty)</span>}</td>
                                    <td className="px-2 py-1 align-top w-2/5">
                                      <span className="text-slate-800 dark:text-slate-100 break-all">{c.to}</span>
                                      {c.reason === 'skip-existing' && <span className="ml-1 text-[9px] text-amber-600">kept existing</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center gap-3 flex-shrink-0 bg-slate-50 dark:bg-slate-900/50">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {step === 'preview' && (
              applyResult.cellCount > 0
                ? <><CheckCircle2 className="w-3 h-3 inline -mt-0.5 mr-1 text-emerald-600" />Will write <span className="font-semibold text-slate-800 dark:text-slate-100">{applyResult.cellCount}</span> cell{applyResult.cellCount !== 1 ? 's' : ''} · ⌘Z reverts</>
                : 'Select cells to apply.'
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {step !== 'upload' && (
              <Button variant="ghost" size="sm" disabled={busy}
                onClick={() => { setError(null); setStep(step === 'preview' ? 'mapping' : 'upload') }}>Back</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => !busy && onClose()} disabled={busy}>Cancel</Button>
            {step === 'mapping' && (
              <Button size="sm" onClick={goToPreview} disabled={busy || mappedCount === 0} loading={busy}>
                Preview <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            )}
            {step === 'preview' && (
              <Button size="sm" disabled={busy || applyResult.cellCount === 0} onClick={() => onApply(applyResult)}>
                Apply import
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
