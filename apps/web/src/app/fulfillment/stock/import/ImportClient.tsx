'use client'

/**
 * IM.1 — Bulk Inventory Import Wizard.
 *
 * 5-step pipeline:
 *   UPLOAD  → drag-drop / paste / browse (CSV, XLSX, JSON, TSV)
 *   MAP     → column picker + mode (ADJUST|SET) + target (WAREHOUSE|CHANNEL|BOTH)
 *   RESOLVE → 4-tier SKU matching; manual assign for unresolved rows
 *   PREVIEW → full DataGrid validation with colour-coded row status
 *   APPLY   → commit + progress + done screen
 *
 * Built entirely on the design system.
 * Legacy /api/stock/bulk-import is superseded by /api/stock/import/*.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Upload, FileText, CheckCircle2, AlertTriangle, ArrowRight,
  ArrowLeft, Download, Search, Trash2, Plus, RefreshCw,
  ChevronRight, History, Tag as TagIcon,
} from 'lucide-react'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Card } from '@/design-system/components/Card'
import { DataGrid } from '@/design-system/components/DataGrid'
import { Modal } from '@/design-system/components/Modal'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Tabs, type TabItem } from '@/design-system/components/Tabs'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { Pill } from '@/design-system/primitives/Pill'
import { Tag } from '@/design-system/primitives/Tag'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Spinner } from '@/design-system/primitives/Spinner'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type WizardStep = 'UPLOAD' | 'MAP' | 'RESOLVE' | 'PREVIEW' | 'APPLY'
type ImportMode = 'ADJUST' | 'SET'
type ImportTarget = 'WAREHOUSE' | 'CHANNEL' | 'BOTH'
type ResolutionTier = 'EXACT' | 'ALIAS' | 'FUZZY_NAME' | 'BARCODE' | 'UNRESOLVED'
type MainTab = 'wizard' | 'aliases' | 'history'

interface ParsedFileResult {
  filename: string
  kind: string
  headers: string[]
  totalRows: number
  preview: Record<string, unknown>[]
}

interface ResolvedRow {
  raw: string
  quantity: number
  notes?: string
  channel?: string
  marketplace?: string
  productId: string | null
  productName: string | null
  resolvedSku: string | null
  tier: ResolutionTier
  candidates: Array<{ productId: string; sku: string; name: string; score: number }>
  _skipped?: boolean
  _override?: { productId: string; sku: string; name: string }
}

interface PreviewRow extends ResolvedRow {
  currentWarehouseQty: number | null
  wouldBeWarehouseQty: number | null
  currentChannelQty: number | null
  wouldBeChannelQty: number | null
  warnings: string[]
  error: string | null
}

interface ApplyResult {
  jobId: string
  succeeded: number
  failed: number
  skipped: number
  total: number
  results: Array<{ sku: string; raw: string; applied: boolean; error?: string }>
}

interface ImportHistory {
  id: string
  filename: string | null
  fileKind: string | null
  locationCode: string
  mode: string
  target: string
  totalRows: number
  succeeded: number
  failed: number
  skipped: number
  status: string
  appliedAt: string | null
  createdAt: string
}

interface AliasRow {
  id: string
  alias: string
  raw: string
  source: string
  createdAt: string
  product: { id: string; sku: string; name: string }
}

interface Location {
  id: string
  code: string
  name: string
  type: string
  isActive: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEPS: WizardStep[] = ['UPLOAD', 'MAP', 'RESOLVE', 'PREVIEW', 'APPLY']

const SMART_HEADER_MAP: Record<string, string> = {
  sku: 'identifier', 'item code': 'identifier', 'item no': 'identifier',
  'part no': 'identifier', 'product code': 'identifier', code: 'identifier',
  asin: 'identifier', 'product name': 'identifier', name: 'identifier',
  qty: 'quantity', quantity: 'quantity', 'qty on hand': 'quantity',
  stock: 'quantity', units: 'quantity', change: 'quantity', delta: 'quantity',
  notes: 'notes', note: 'notes', comment: 'notes', remarks: 'notes',
  channel: 'channel', marketplace: 'marketplace', market: 'marketplace',
}

const TIER_LABEL: Record<ResolutionTier, string> = {
  EXACT: 'Exact SKU',
  ALIAS: 'Saved alias',
  FUZZY_NAME: 'Fuzzy name',
  BARCODE: 'Barcode',
  UNRESOLVED: 'Unresolved',
}

const TIER_TONE: Record<ResolutionTier, 'positive' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  EXACT: 'positive',
  ALIAS: 'info',
  FUZZY_NAME: 'warning',
  BARCODE: 'info',
  UNRESOLVED: 'danger',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTemplate(): string {
  return [
    'identifier,quantity,notes',
    'GAL-JK-BLK-M,+5,received from supplier',
    'Gale Jacket Black,10,',
    'GAL-JK-YEL-L,-2,damaged',
    '',
  ].join('\n')
}

function downloadBlob(content: string, filename: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function autoMapHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const h of headers) {
    const key = h.toLowerCase().trim()
    const mapped = SMART_HEADER_MAP[key]
    if (mapped && !Object.values(result).includes(mapped)) {
      result[h] = mapped
    }
  }
  return result
}

function buildRowsFromFile(
  parsed: ParsedFileResult,
  colMap: Record<string, string>,
): Array<{ raw: string; quantity: number; notes?: string; channel?: string; marketplace?: string }> {
  const idCol = Object.entries(colMap).find(([, v]) => v === 'identifier')?.[0]
  const qtyCol = Object.entries(colMap).find(([, v]) => v === 'quantity')?.[0]
  const notesCol = Object.entries(colMap).find(([, v]) => v === 'notes')?.[0]
  const channelCol = Object.entries(colMap).find(([, v]) => v === 'channel')?.[0]
  const mpCol = Object.entries(colMap).find(([, v]) => v === 'marketplace')?.[0]
  if (!idCol || !qtyCol) return []

  const rows = []
  for (const row of (parsed as any)._fullRows ?? []) {
    const raw = String(row[idCol] ?? '').trim()
    if (!raw) continue
    const rawQty = String(row[qtyCol] ?? '').trim().replace(/^\+/, '')
    const quantity = Number(rawQty)
    if (!Number.isFinite(quantity)) continue
    rows.push({
      raw,
      quantity,
      notes: notesCol ? String(row[notesCol] ?? '').trim() || undefined : undefined,
      channel: channelCol ? String(row[channelCol] ?? '').trim().toUpperCase() || undefined : undefined,
      marketplace: mpCol ? String(row[mpCol] ?? '').trim().toUpperCase() || undefined : undefined,
    })
  }
  return rows
}

// ── Main inner component ──────────────────────────────────────────────────────

function ImportWizardInner() {
  const { t } = useTranslations()
  const { toast } = useToast()

  // ── Global state ─────────────────────────────────────────────────────
  const [mainTab, setMainTab] = useState<MainTab>('wizard')
  const [step, setStep] = useState<WizardStep>('UPLOAD')
  const [locations, setLocations] = useState<Location[]>([])
  const [locationCode, setLocationCode] = useState('IT-MAIN')
  const [busy, setBusy] = useState(false)

  // ── Step: UPLOAD ─────────────────────────────────────────────────────
  const [parsedFile, setParsedFile] = useState<ParsedFileResult | null>(null)
  const [fullRows, setFullRows] = useState<Record<string, unknown>[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pasteRef = useRef<HTMLTextAreaElement>(null)

  // ── Step: MAP ────────────────────────────────────────────────────────
  const [colMap, setColMap] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<ImportMode>('ADJUST')
  const [target, setTarget] = useState<ImportTarget>('WAREHOUSE')

  // ── Step: RESOLVE ────────────────────────────────────────────────────
  const [resolvedRows, setResolvedRows] = useState<ResolvedRow[]>([])
  const [assignModal, setAssignModal] = useState<{ rowIdx: number; query: string } | null>(null)
  const [assignSearch, setAssignSearch] = useState('')
  const [assignResults, setAssignResults] = useState<Array<{ id: string; sku: string; name: string }>>([])
  const [saveAliasesChecked, setSaveAliasesChecked] = useState(true)

  // ── Step: PREVIEW ─────────────────────────────────────────────────────
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([])

  // ── Step: APPLY ───────────────────────────────────────────────────────
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)

  // ── Aliases tab ──────────────────────────────────────────────────────
  const [aliases, setAliases] = useState<AliasRow[]>([])
  const [aliasesLoading, setAliasesLoading] = useState(false)
  const [addAliasModal, setAddAliasModal] = useState(false)
  const [aliasForm, setAliasForm] = useState({ raw: '', productSearch: '', productId: '', sku: '' })
  const [aliasSearchResults, setAliasSearchResults] = useState<Array<{ id: string; sku: string; name: string }>>([])
  const [deletingAliasId, setDeletingAliasId] = useState<string | null>(null)

  // ── History tab ──────────────────────────────────────────────────────
  const [history, setHistory] = useState<ImportHistory[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // ── Init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/stock/locations`)
      .then((r) => r.json())
      .then((j) => {
        const locs: Location[] = (j.locations ?? []).filter((l: Location) => l.type !== 'AMAZON_FBA' && l.isActive)
        setLocations(locs)
        if (locs.length > 0 && !locs.find((l) => l.code === locationCode)) {
          setLocationCode(locs[0].code)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (mainTab === 'aliases') loadAliases()
    else if (mainTab === 'history') loadHistory()
  }, [mainTab])

  // ── File handling ─────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (file.size > 10_000_000) { setUploadError('File exceeds 10 MB limit'); return }
    setUploadError(null); setBusy(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${getBackendUrl()}/api/stock/import/parse`, { method: 'POST', body: formData })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${res.status}`) }
      const data = await res.json()
      const rows = await readAllRows(file)
      setFullRows(rows)
      setParsedFile({ ...data, _fullRows: rows } as any)
      // Auto-map columns
      setColMap(autoMapHeaders(data.headers))
      setStep('MAP')
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  async function readAllRows(file: File): Promise<Record<string, unknown>[]> {
    const text = await file.text()
    // Client-side minimal CSV parse for column mapping preview
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim())
    if (lines.length < 2) return []
    const headers = lines[0].split(/,|\t/).map((h) => h.trim())
    return lines.slice(1).map((line) => {
      const parts = line.split(/,|\t/)
      const obj: Record<string, unknown> = {}
      headers.forEach((h, i) => { obj[h] = parts[i]?.trim() ?? '' })
      return obj
    })
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleFile(file)
  }, [handleFile])

  const handlePasteText = useCallback(async () => {
    const text = pasteRef.current?.value.trim()
    if (!text) return
    const file = new File([text], 'pasted.csv', { type: 'text/csv' })
    await handleFile(file)
  }, [handleFile])

  // ── Step: MAP → proceed to RESOLVE ────────────────────────────────────

  async function proceedToResolve() {
    if (!parsedFile) return
    const idCol = Object.entries(colMap).find(([, v]) => v === 'identifier')?.[0]
    const qtyCol = Object.entries(colMap).find(([, v]) => v === 'quantity')?.[0]
    if (!idCol || !qtyCol) { toast('Please map at least the Identifier and Quantity columns', 'error'); return }

    const rows = buildRowsFromFile({ ...parsedFile, _fullRows: fullRows } as any, colMap)
    if (rows.length === 0) { toast('No valid rows found after mapping', 'error'); return }

    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/import/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${res.status}`) }
      const data = await res.json()
      setResolvedRows(data.rows)
      setStep('RESOLVE')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── Step: RESOLVE → proceed to PREVIEW ───────────────────────────────

  async function proceedToPreview() {
    // Apply overrides from manual assignments
    const rows = resolvedRows
      .filter((r) => !r._skipped)
      .map((r): ResolvedRow => {
        if (r._override) {
          return { ...r, productId: r._override.productId, resolvedSku: r._override.sku, productName: r._override.name, tier: 'EXACT' as ResolutionTier }
        }
        return r
      })

    // Save aliases for fuzzy/override rows if checked
    if (saveAliasesChecked) {
      const toSave = rows.filter((r) => (r.tier === 'FUZZY_NAME' || r._override) && r.productId)
      if (toSave.length > 0) {
        await fetch(`${getBackendUrl()}/api/stock/import/aliases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: toSave.map((r) => ({ productId: r.productId!, raw: r.raw, source: 'IMPORT' })) }),
        }).catch(() => {})
      }
    }

    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/import/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, locationCode, mode, target }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${res.status}`) }
      const data = await res.json()
      setPreviewRows(data.rows)
      setStep('PREVIEW')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── Step: PREVIEW → APPLY ─────────────────────────────────────────────

  async function applyImport() {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/import/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: previewRows,
          locationCode,
          mode,
          target,
          filename: parsedFile?.filename,
          fileKind: parsedFile?.kind,
        }),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${res.status}`) }
      const data = await res.json()
      setApplyResult(data)
      setStep('APPLY')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  // ── Assign modal ──────────────────────────────────────────────────────

  async function searchProducts(q: string) {
    if (!q.trim()) { setAssignResults([]); return }
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/search?q=${encodeURIComponent(q)}&limit=10`)
      const data = await res.json()
      setAssignResults((data.products ?? data.results ?? []).map((p: any) => ({ id: p.id, sku: p.sku, name: p.name })))
    } catch { setAssignResults([]) }
  }

  function confirmAssign(productId: string, sku: string, name: string) {
    if (assignModal === null) return
    setResolvedRows((rows) => rows.map((r, i) =>
      i === assignModal.rowIdx ? { ...r, _override: { productId, sku, name } } : r
    ))
    setAssignModal(null)
    setAssignSearch('')
    setAssignResults([])
  }

  function skipRow(idx: number) {
    setResolvedRows((rows) => rows.map((r, i) => i === idx ? { ...r, _skipped: true } : r))
  }
  function unskipRow(idx: number) {
    setResolvedRows((rows) => rows.map((r, i) => i === idx ? { ...r, _skipped: false } : r))
  }

  // ── Aliases tab ───────────────────────────────────────────────────────

  async function loadAliases() {
    setAliasesLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/import/aliases`)
      const data = await res.json()
      setAliases(data.aliases ?? [])
    } catch { } finally { setAliasesLoading(false) }
  }

  async function deleteAlias(id: string) {
    await fetch(`${getBackendUrl()}/api/stock/import/aliases/${id}`, { method: 'DELETE' })
    toast(t('stock.import.aliases.deleted'), 'success')
    setDeletingAliasId(null)
    loadAliases()
  }

  async function saveNewAlias() {
    if (!aliasForm.raw.trim() || !aliasForm.productId) return
    await fetch(`${getBackendUrl()}/api/stock/import/aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ productId: aliasForm.productId, raw: aliasForm.raw, source: 'MANUAL' }] }),
    })
    toast(t('stock.import.aliases.saved'), 'success')
    setAddAliasModal(false)
    setAliasForm({ raw: '', productSearch: '', productId: '', sku: '' })
    loadAliases()
  }

  async function searchAliasProduct(q: string) {
    if (!q.trim()) { setAliasSearchResults([]); return }
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/search?q=${encodeURIComponent(q)}&limit=10`)
      const data = await res.json()
      setAliasSearchResults((data.products ?? data.results ?? []).map((p: any) => ({ id: p.id, sku: p.sku, name: p.name })))
    } catch { setAliasSearchResults([]) }
  }

  // ── History tab ───────────────────────────────────────────────────────

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/import/history`)
      const data = await res.json()
      setHistory(data.jobs ?? [])
    } catch { } finally { setHistoryLoading(false) }
  }

  // ── Reset wizard ──────────────────────────────────────────────────────

  function resetWizard() {
    setStep('UPLOAD')
    setParsedFile(null); setFullRows([]); setUploadError(null)
    setColMap({}); setMode('ADJUST'); setTarget('WAREHOUSE')
    setResolvedRows([]); setPreviewRows([]); setApplyResult(null)
  }

  // ── Step breadcrumb ───────────────────────────────────────────────────

  const stepLabels: Record<WizardStep, string> = {
    UPLOAD: t('stock.import.step.upload'),
    MAP: t('stock.import.step.map'),
    RESOLVE: t('stock.import.step.resolve'),
    PREVIEW: t('stock.import.step.preview'),
    APPLY: t('stock.import.step.apply'),
  }
  const stepIdx = STEPS.indexOf(step)

  // ════════════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════════════

  const mainTabs: TabItem[] = [
    { id: 'wizard', label: 'Import Wizard' },
    { id: 'aliases', label: t('stock.import.aliases.title') },
    { id: 'history', label: t('stock.import.history.title') },
  ]

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={t('stock.import.title')}
        subtitle={t('stock.import.description')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => downloadBlob(buildTemplate(), 'stock-import-template.csv')}>
            <Download size={14} />
            {t('stock.import.upload.template')}
          </Button>
        }
      />

      <StockSubNav />

      <Tabs
        tabs={mainTabs}
        active={mainTab}
        onChange={(id) => setMainTab(id as MainTab)}
      />

      {/* ═══ WIZARD TAB ══════════════════════════════════════════════════════ */}
      {mainTab === 'wizard' && (
        <>
          {/* Step indicator */}
          {step !== 'APPLY' && (
            <div className="flex items-center gap-1.5 text-sm" aria-label="Import progress">
              {STEPS.filter((s) => s !== 'APPLY').map((s, i) => (
                <div key={s} className="flex items-center gap-1.5">
                  <span className={[
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium transition-colors',
                    s === step ? 'bg-blue-600 text-white' :
                    STEPS.indexOf(s) < stepIdx ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' :
                    'bg-surface-2 text-secondary'
                  ].join(' ')}>
                    {STEPS.indexOf(s) < stepIdx && <CheckCircle2 size={12} />}
                    {i + 1}. {stepLabels[s]}
                  </span>
                  {i < 3 && <ChevronRight size={14} className="text-tertiary shrink-0" />}
                </div>
              ))}
            </div>
          )}

          {/* ─── UPLOAD ────────────────────────────────────────────────── */}
          {step === 'UPLOAD' && (
            <Card elevated>
              <div className="p-6 flex flex-col gap-6">
                {/* Drag-drop zone */}
                <div
                  role="button"
                  tabIndex={0}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                  className={[
                    'relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors flex flex-col items-center gap-3',
                    dragging ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-default hover:border-blue-300 hover:bg-surface-2',
                  ].join(' ')}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv,.xlsx,.xls,.json,text/csv,application/json"
                    className="sr-only"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
                  />
                  {busy ? (
                    <Spinner />
                  ) : (
                    <>
                      <Upload size={36} className="text-tertiary" />
                      <p className="text-base font-medium">{t('stock.import.upload.dropzone')}</p>
                      <p className="text-sm text-tertiary">{t('stock.import.upload.accepts')}</p>
                    </>
                  )}
                </div>

                {uploadError && (
                  <div className="flex items-center gap-2 rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-300">
                    <AlertTriangle size={14} className="shrink-0" />
                    {uploadError}
                  </div>
                )}

                {/* Paste from clipboard */}
                <details className="group">
                  <summary className="cursor-pointer text-sm text-secondary hover:text-primary list-none flex items-center gap-1.5">
                    <FileText size={14} />
                    {t('stock.import.upload.paste')}
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
                    <textarea
                      ref={pasteRef}
                      rows={6}
                      placeholder="identifier,quantity,notes&#10;GAL-JK-BLK-M,+5,received from supplier&#10;Gale Jacket Black,-2,damaged"
                      className="w-full rounded-md border border-default bg-surface-1 px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <Button variant="secondary" size="sm" onClick={handlePasteText}>
                      Parse text
                    </Button>
                  </div>
                </details>
              </div>
            </Card>
          )}

          {/* ─── MAP ───────────────────────────────────────────────────── */}
          {step === 'MAP' && parsedFile && (
            <Card elevated>
              <div className="p-6 flex flex-col gap-6">
                <div>
                  <p className="text-base font-semibold">{t('stock.import.map.title')}</p>
                  <p className="text-sm text-secondary mt-0.5">{t('stock.import.map.subtitle')}</p>
                </div>

                {/* Column mapper */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { label: t('stock.import.map.fieldIdentifier'), value: 'identifier', required: true },
                    { label: t('stock.import.map.fieldQuantity'), value: 'quantity', required: true },
                    { label: t('stock.import.map.fieldNotes'), value: 'notes', required: false },
                    { label: t('stock.import.map.fieldChannel'), value: 'channel', required: false },
                    { label: t('stock.import.map.fieldMarketplace'), value: 'marketplace', required: false },
                  ].map(({ label, value, required }) => {
                    const current = Object.entries(colMap).find(([, v]) => v === value)?.[0] ?? ''
                    return (
                      <div key={value} className="flex flex-col gap-1">
                        <label className="text-sm font-medium">
                          {label}{required && <span className="text-rose-500 ml-0.5">*</span>}
                        </label>
                        <Select
                          value={current}
                          onChange={(e) => {
                            const newCol = e.target.value
                            setColMap((prev) => {
                              const next = { ...prev }
                              // remove old mapping for this target
                              Object.keys(next).forEach((k) => { if (next[k] === value) delete next[k] })
                              if (newCol) next[newCol] = value
                              return next
                            })
                          }}
                        >
                          <option value="">{t('stock.import.map.none')}</option>
                          {parsedFile.headers.map((h) => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                        </Select>
                      </div>
                    )
                  })}
                </div>

                {/* Preview of first rows */}
                {parsedFile.preview.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-tertiary uppercase tracking-wider mb-2">File preview (first 5 rows)</p>
                    <div className="overflow-x-auto rounded-lg border border-default">
                      <table className="w-full text-xs">
                        <thead className="bg-surface-2">
                          <tr>
                            {parsedFile.headers.map((h) => (
                              <th key={h} className="px-2 py-1.5 text-left font-medium text-secondary whitespace-nowrap border-b border-default">
                                {h}
                                {colMap[h] && <span className="ml-1.5 text-blue-500">→ {colMap[h]}</span>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {parsedFile.preview.slice(0, 5).map((row, i) => (
                            <tr key={i} className="border-b border-subtle">
                              {parsedFile.headers.map((h) => (
                                <td key={h} className="px-2 py-1.5 text-secondary">{String(row[h] ?? '')}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-tertiary mt-1">{parsedFile.totalRows} total rows in file</p>
                  </div>
                )}

                {/* Mode + target + location */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-default">
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium">{t('stock.import.map.mode')}</label>
                    <Select value={mode} onChange={(e) => setMode(e.target.value as ImportMode)}>
                      <option value="ADJUST">{t('stock.import.map.modeAdjust')}</option>
                      <option value="SET">{t('stock.import.map.modeSet')}</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium">{t('stock.import.map.target')}</label>
                    <Select value={target} onChange={(e) => setTarget(e.target.value as ImportTarget)}>
                      <option value="WAREHOUSE">{t('stock.import.map.targetWarehouse')}</option>
                      <option value="CHANNEL">{t('stock.import.map.targetChannel')}</option>
                      <option value="BOTH">{t('stock.import.map.targetBoth')}</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium">{t('stock.import.map.location')}</label>
                    <Select value={locationCode} onChange={(e) => setLocationCode(e.target.value)}>
                      {locations.map((l) => (
                        <option key={l.code} value={l.code}>{l.code} — {l.name}</option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep('UPLOAD')}>
                    <ArrowLeft size={14} /> Back
                  </Button>
                  <Button variant="primary" size="sm" onClick={proceedToResolve} disabled={busy}>
                    {busy ? <Spinner size={14} /> : <ArrowRight size={14} />}
                    Next: Resolve SKUs
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* ─── RESOLVE ───────────────────────────────────────────────── */}
          {step === 'RESOLVE' && (
            <Card elevated>
              <div className="p-4 flex flex-col gap-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <p className="text-base font-semibold">{t('stock.import.resolve.title')}</p>
                    {(() => {
                      const unresolved = resolvedRows.filter((r) => r.tier === 'UNRESOLVED' && !r._skipped && !r._override).length
                      const fuzzy = resolvedRows.filter((r) => r.tier === 'FUZZY_NAME' && !r._skipped).length
                      return (
                        <p className="text-sm text-secondary mt-0.5">
                          {resolvedRows.length} rows · {unresolved} unresolved · {fuzzy} fuzzy matches to verify
                        </p>
                      )
                    })()}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                      <input type="checkbox" checked={saveAliasesChecked} onChange={(e) => setSaveAliasesChecked(e.target.checked)} className="rounded" />
                      {t('stock.import.resolve.saveAliases')}
                    </label>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-default">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-2 border-b border-default">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-secondary">{t('stock.import.resolve.colInput')}</th>
                        <th className="px-3 py-2 text-left font-medium text-secondary">{t('stock.import.resolve.colMatch')}</th>
                        <th className="px-3 py-2 text-left font-medium text-secondary">{t('stock.import.resolve.colTier')}</th>
                        <th className="px-3 py-2 text-right font-medium text-secondary">{t('stock.import.resolve.colQty')}</th>
                        <th className="px-3 py-2 text-right font-medium text-secondary">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resolvedRows.map((row, idx) => {
                        const effective = row._override ?? (row.tier !== 'UNRESOLVED' ? { productId: row.productId, sku: row.resolvedSku, name: row.productName } : null)
                        const tier = row._override ? 'EXACT' as ResolutionTier : row.tier
                        return (
                          <tr key={idx} className={['border-b border-subtle', row._skipped ? 'opacity-40 line-through' : ''].join(' ')}>
                            <td className="px-3 py-2 font-mono text-xs">{row.raw}</td>
                            <td className="px-3 py-2">
                              {effective ? (
                                <div>
                                  <span className="font-mono text-xs">{effective.sku}</span>
                                  <span className="text-tertiary text-xs ml-2">{effective.name}</span>
                                </div>
                              ) : (
                                <span className="text-tertiary text-xs">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <Tag tone={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Tag>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {mode === 'ADJUST' && row.quantity > 0 ? '+' : ''}{row.quantity}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {!row._skipped && (
                                  <Button variant="ghost" size="sm" onClick={() => { setAssignModal({ rowIdx: idx, query: row.raw }); setAssignSearch(row.raw); searchProducts(row.raw) }}>
                                    <Search size={12} /> {t('stock.import.resolve.assign')}
                                  </Button>
                                )}
                                {!row._skipped ? (
                                  <Button variant="ghost" size="sm" className="text-tertiary" onClick={() => skipRow(idx)}>
                                    {t('stock.import.resolve.skip')}
                                  </Button>
                                ) : (
                                  <Button variant="ghost" size="sm" onClick={() => unskipRow(idx)}>Restore</Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep('MAP')}><ArrowLeft size={14} /> Back</Button>
                  <Button variant="primary" size="sm" onClick={proceedToPreview} disabled={busy}>
                    {busy ? <Spinner size={14} /> : <ArrowRight size={14} />}
                    Next: Preview
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* ─── PREVIEW ───────────────────────────────────────────────── */}
          {step === 'PREVIEW' && (
            <Card elevated>
              <div className="p-4 flex flex-col gap-4">
                {(() => {
                  const ok = previewRows.filter((r) => !r.error && r.productId).length
                  const warn = previewRows.filter((r) => !r.error && r.warnings?.length > 0).length
                  const err = previewRows.filter((r) => !!r.error).length
                  return (
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="text-base font-semibold">{t('stock.import.preview.title')}</p>
                        <p className="text-sm text-secondary mt-0.5">
                          <span className="text-emerald-600 font-medium">{ok} ready</span>
                          {warn > 0 && <span className="text-amber-600 font-medium ml-3">{warn} warnings</span>}
                          {err > 0 && <span className="text-rose-600 font-medium ml-3">{err} errors</span>}
                        </p>
                      </div>
                      {err > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => {
                          const errRows = previewRows.filter((r) => r.error)
                          const csv = ['input,error', ...errRows.map((r) => `"${r.raw}","${r.error}"`)].join('\n')
                          downloadBlob(csv, 'import-errors.csv')
                        }}>
                          <Download size={14} /> {t('stock.import.preview.downloadErrors')}
                        </Button>
                      )}
                    </div>
                  )
                })()}

                <DataGrid<PreviewRow>
                  rows={previewRows}
                  rowKey={(r) => `${r.raw}-${r.productId ?? 'u'}`}
                  maxHeight={480}
                  columns={[
                    {
                      key: 'input',
                      label: t('stock.import.preview.colInput'),
                      width: 160,
                      sticky: true,
                      render: (r) => <span className="font-mono text-xs">{r.raw}</span>,
                    },
                    {
                      key: 'product',
                      label: t('stock.import.preview.colProduct'),
                      render: (r) => r.productName
                        ? <span className="text-sm">{r.productName} <span className="text-tertiary text-xs ml-1">{r.resolvedSku}</span></span>
                        : <span className="text-tertiary text-sm">—</span>,
                    },
                    ...(target !== 'CHANNEL' ? [
                      {
                        key: 'whNow', label: t('stock.import.preview.colCurrentWh'), width: 110, align: 'right' as const,
                        render: (r: PreviewRow) => <span className="tabular-nums">{r.currentWarehouseQty ?? '—'}</span>,
                      },
                      {
                        key: 'whAfter', label: t('stock.import.preview.colNewWh'), width: 110, align: 'right' as const,
                        render: (r: PreviewRow) => (
                          <span className={['tabular-nums font-medium', r.wouldBeWarehouseQty !== null && r.wouldBeWarehouseQty < 0 ? 'text-rose-600' : ''].join(' ')}>
                            {r.wouldBeWarehouseQty ?? '—'}
                          </span>
                        ),
                      },
                    ] : []),
                    ...(target !== 'WAREHOUSE' ? [
                      {
                        key: 'chNow', label: t('stock.import.preview.colCurrentCh'), width: 110, align: 'right' as const,
                        render: (r: PreviewRow) => <span className="tabular-nums">{r.currentChannelQty ?? '—'}</span>,
                      },
                      {
                        key: 'chAfter', label: t('stock.import.preview.colNewCh'), width: 110, align: 'right' as const,
                        render: (r: PreviewRow) => <span className="tabular-nums font-medium">{r.wouldBeChannelQty ?? '—'}</span>,
                      },
                    ] : []),
                    {
                      key: 'status', label: t('stock.import.preview.colStatus'), width: 120,
                      render: (r) => r.error
                        ? <Pill status="err"><span className="truncate max-w-[100px] block" title={r.error}>{r.error.slice(0, 30)}</span></Pill>
                        : r.warnings?.length > 0
                        ? <Pill status="warn">Warning</Pill>
                        : r.productId ? <Pill status="ok">Ready</Pill>
                        : <Pill status="arch">Skipped</Pill>,
                    },
                  ]}
                />

                <div className="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep('RESOLVE')}><ArrowLeft size={14} /> Back</Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={applyImport}
                    disabled={busy || previewRows.filter((r) => !r.error && r.productId).length === 0}
                  >
                    {busy ? <Spinner size={14} /> : <CheckCircle2 size={14} />}
                    Apply {previewRows.filter((r) => !r.error && r.productId).length} changes
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* ─── APPLY ─────────────────────────────────────────────────── */}
          {step === 'APPLY' && applyResult && (
            <Card elevated>
              <div className="p-8 flex flex-col items-center gap-6 text-center">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/30 p-4">
                  <CheckCircle2 size={36} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-xl font-bold">{t('stock.import.apply.done')}</p>
                  <div className="flex items-center justify-center gap-4 mt-3 text-sm">
                    <span className="text-emerald-600 font-semibold">{t('stock.import.apply.succeeded', { n: applyResult.succeeded })}</span>
                    {applyResult.failed > 0 && <span className="text-rose-600 font-semibold">{t('stock.import.apply.failed', { n: applyResult.failed })}</span>}
                    {applyResult.skipped > 0 && <span className="text-secondary">{t('stock.import.apply.skipped', { n: applyResult.skipped })}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="secondary" size="sm" onClick={() => { setMainTab('history'); loadHistory() }}>
                    <History size={14} /> {t('stock.import.apply.viewHistory')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={resetWizard}>
                    <Upload size={14} /> {t('stock.import.apply.importAgain')}
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ═══ ALIASES TAB ═════════════════════════════════════════════════════ */}
      {mainTab === 'aliases' && (
        <Card elevated>
          <div className="p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-base font-semibold">{t('stock.import.aliases.title')}</p>
                <p className="text-sm text-secondary mt-0.5">{t('stock.import.aliases.description')}</p>
              </div>
              <Button variant="primary" size="sm" onClick={() => { setAddAliasModal(true); setAliasSearchResults([]) }}>
                <Plus size={14} /> {t('stock.import.aliases.add')}
              </Button>
            </div>

            {aliasesLoading ? (
              <div className="flex flex-col gap-3 p-4">{[1,2,3].map((i) => <Skeleton key={i} height={36} />)}</div>
            ) : aliases.length === 0 ? (
              <EmptyState
                icon={<TagIcon size={32} className="text-tertiary" />}
                title={t('stock.import.aliases.empty.title')}
                description={t('stock.import.aliases.empty.description')}
              />
            ) : (
              <DataGrid<AliasRow>
                rows={aliases}
                rowKey={(r) => r.id}
                initialSort={{ key: 'createdAt', dir: 'desc' }}
                columns={[
                  {
                    key: 'alias', label: t('stock.import.aliases.colAlias'), width: 220, sticky: true,
                    render: (r) => <span className="font-mono text-sm">{r.raw}</span>,
                    sortable: true, sortValue: (r) => r.raw,
                  },
                  {
                    key: 'sku', label: t('stock.import.aliases.colSku'), width: 140,
                    render: (r) => <span className="font-mono text-xs text-secondary">{r.product.sku}</span>,
                  },
                  {
                    key: 'product', label: t('stock.import.aliases.colProduct'),
                    render: (r) => <span className="text-sm">{r.product.name}</span>,
                  },
                  {
                    key: 'source', label: t('stock.import.aliases.colSource'), width: 100,
                    render: (r) => (
                      <Tag tone={r.source === 'MANUAL' ? 'info' : r.source === 'IMPORT' ? 'positive' : 'neutral'}>
                        {r.source}
                      </Tag>
                    ),
                  },
                  {
                    key: 'createdAt', label: t('stock.import.aliases.colDate'), width: 120,
                    render: (r) => <span className="text-xs text-secondary">{new Date(r.createdAt).toLocaleDateString()}</span>,
                    sortable: true, sortValue: (r) => r.createdAt,
                  },
                  {
                    key: 'actions', label: '', width: 80, align: 'right',
                    render: (r) => (
                      <Button variant="ghost" size="sm" className="text-rose-600" onClick={() => setDeletingAliasId(r.id)}>
                        <Trash2 size={13} />
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </div>
        </Card>
      )}

      {/* ═══ HISTORY TAB ═════════════════════════════════════════════════════ */}
      {mainTab === 'history' && (
        <Card elevated>
          <div className="p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-base font-semibold">{t('stock.import.history.title')}</p>
              <Button variant="ghost" size="sm" onClick={loadHistory} disabled={historyLoading}>
                <RefreshCw size={14} className={historyLoading ? 'animate-spin' : ''} />
              </Button>
            </div>

            {historyLoading ? (
              <div className="flex flex-col gap-3 p-4">{[1,2,3].map((i) => <Skeleton key={i} height={36} />)}</div>
            ) : history.length === 0 ? (
              <EmptyState icon={<History size={32} className="text-tertiary" />} title={t('stock.import.history.empty')} />
            ) : (
              <DataGrid<ImportHistory>
                rows={history}
                rowKey={(r) => r.id}
                initialSort={{ key: 'createdAt', dir: 'desc' }}
                columns={[
                  {
                    key: 'filename', label: t('stock.import.history.colFile'), width: 200, sticky: true,
                    render: (r) => <span className="text-sm font-mono">{r.filename ?? '(no file)'}</span>,
                  },
                  {
                    key: 'location', label: 'Location', width: 120,
                    render: (r) => <span className="text-sm text-secondary">{r.locationCode}</span>,
                  },
                  {
                    key: 'mode', label: 'Mode', width: 100,
                    render: (r) => <Tag tone="neutral">{r.mode}</Tag>,
                  },
                  {
                    key: 'rows', label: t('stock.import.history.colRows'), width: 90, align: 'right',
                    render: (r) => <span className="tabular-nums">{r.totalRows}</span>,
                    sortable: true, sortValue: (r) => r.totalRows,
                  },
                  {
                    key: 'result', label: t('stock.import.history.colResult'), width: 160,
                    render: (r) => (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-emerald-600 font-medium">{r.succeeded} ok</span>
                        {r.failed > 0 && <span className="text-rose-600 font-medium">{r.failed} failed</span>}
                        {r.skipped > 0 && <span className="text-secondary">{r.skipped} skipped</span>}
                      </div>
                    ),
                  },
                  {
                    key: 'status', label: 'Status', width: 100,
                    render: (r) => (
                      <Pill status={r.status === 'APPLIED' ? 'ok' : r.status === 'PARTIAL' ? 'warn' : r.status === 'FAILED' ? 'err' : 'arch'}>
                        {r.status}
                      </Pill>
                    ),
                  },
                  {
                    key: 'createdAt', label: t('stock.import.history.colDate'), width: 130,
                    render: (r) => <span className="text-xs text-secondary">{new Date(r.createdAt).toLocaleString()}</span>,
                    sortable: true, sortValue: (r) => r.createdAt,
                  },
                ]}
              />
            )}
          </div>
        </Card>
      )}

      {/* ═══ Assign Modal ════════════════════════════════════════════════════ */}
      <Modal
        open={assignModal !== null}
        onClose={() => { setAssignModal(null); setAssignSearch(''); setAssignResults([]) }}
        title={t('stock.import.resolve.assign')}
        size="md"
      >
        <div className="flex flex-col gap-3 p-1">
          <p className="text-sm text-secondary">
            Searching for: <span className="font-mono font-semibold">{assignModal?.query}</span>
          </p>
          <Input
            placeholder={t('stock.import.aliases.form.productPlaceholder')}
            value={assignSearch}
            leadingIcon={<Search size={14} />}
            onChange={(e) => { setAssignSearch(e.target.value); searchProducts(e.target.value) }}
            autoFocus
          />
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {assignResults.length === 0 && assignSearch && (
              <p className="text-sm text-tertiary py-4 text-center">No products found</p>
            )}
            {assignResults.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => confirmAssign(p.id, p.sku, p.name)}
                className="text-left px-3 py-2.5 rounded-lg hover:bg-surface-2 transition-colors border border-transparent hover:border-default flex items-center justify-between gap-2"
              >
                <div>
                  <span className="font-mono text-sm font-medium">{p.sku}</span>
                  <span className="text-sm text-secondary ml-2">{p.name}</span>
                </div>
                <CheckCircle2 size={14} className="text-blue-500 shrink-0 opacity-0 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      </Modal>

      {/* ═══ Delete Alias Confirm ════════════════════════════════════════════ */}
      <Modal
        open={deletingAliasId !== null}
        onClose={() => setDeletingAliasId(null)}
        title={t('stock.import.aliases.deleteConfirm', { alias: aliases.find((a) => a.id === deletingAliasId)?.raw ?? '' })}
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDeletingAliasId(null)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={() => deletingAliasId && deleteAlias(deletingAliasId)} className="bg-rose-600 hover:bg-rose-700 border-rose-600">
              {t('stock.import.aliases.delete')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-secondary px-1 py-2">This alias will be removed. Future imports using this text will need to be matched again.</p>
      </Modal>

      {/* ═══ Add Alias Modal ═════════════════════════════════════════════════ */}
      <Modal
        open={addAliasModal}
        onClose={() => { setAddAliasModal(false); setAliasSearchResults([]) }}
        title={t('stock.import.aliases.add')}
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAddAliasModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={saveNewAlias} disabled={!aliasForm.raw.trim() || !aliasForm.productId}>
              Save alias
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 p-1">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">{t('stock.import.aliases.form.alias')}</label>
            <Input
              placeholder={t('stock.import.aliases.form.aliasPlaceholder')}
              value={aliasForm.raw}
              onChange={(e) => setAliasForm((f) => ({ ...f, raw: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">{t('stock.import.aliases.form.product')}</label>
            <Input
              placeholder={t('stock.import.aliases.form.productPlaceholder')}
              value={aliasForm.productSearch}
              leadingIcon={<Search size={14} />}
              onChange={(e) => { setAliasForm((f) => ({ ...f, productSearch: e.target.value, productId: '', sku: '' })); searchAliasProduct(e.target.value) }}
            />
            {aliasSearchResults.length > 0 && (
              <div className="border border-default rounded-lg flex flex-col divide-y divide-subtle overflow-hidden">
                {aliasSearchResults.map((p) => (
                  <button key={p.id} type="button"
                    onClick={() => setAliasForm((f) => ({ ...f, productSearch: `${p.sku} — ${p.name}`, productId: p.id, sku: p.sku }))}
                    className={['text-left px-3 py-2 text-sm hover:bg-surface-2 transition-colors', aliasForm.productId === p.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''].join(' ')}
                  >
                    <span className="font-mono font-medium">{p.sku}</span>
                    <span className="text-secondary ml-2">{p.name}</span>
                    {aliasForm.productId === p.id && <CheckCircle2 size={13} className="inline ml-2 text-blue-500" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ── Export wrapped in ToastProvider ──────────────────────────────────────────

export default function ImportClient() {
  return (
    <ToastProvider>
      <ImportWizardInner />
    </ToastProvider>
  )
}
