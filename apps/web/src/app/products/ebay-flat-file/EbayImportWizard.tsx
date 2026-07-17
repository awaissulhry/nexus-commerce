'use client'

/**
 * EbayImportWizard — dynamic file-import wizard for the eBay flat file.
 * Steps: Upload · Map · Review listings (block files only) · Preview.
 * Built ENTIRELY from the H10 design system: zero hand-rolled raw-Tailwind
 * colour/border classes. Layout is plain divs with inline `var(--h10-*)`
 * token styles; everything visible is a DS component/primitive.
 *
 * EI.1 — typed coercion (importCoerce.pure) + market-aware mapping: per-market
 * headers ("Item ID", "Price (€)", "Qty"…) resolve against the wizard's File
 * market selector, so a DE file imported while viewing IT lands on de_* columns
 * deliberately, never by column-order luck. Per-cell issues surface in Preview.
 *
 * EI.2 — block/family review: multi-listing files (parent+children per Item ID,
 * shared child SKUs pooling stock) get a Review step with per-block
 * Adopt/Create/Skip decisions (Adopt default when a live Item ID exists — the
 * listing is never re-created) and a one-click "Flag all as Shared-SKU" fix.
 *
 * The parent owns the contract (props below) and wires the result into the
 * eBay flat-file store. This file does NOT touch EbayFlatFileClient state.
 */

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, ArrowLeft, Wand2, ClipboardPaste, UploadCloud, Layers, Link2, AlertTriangle } from 'lucide-react'

import { Modal } from '@/design-system/components/Modal'
import { Stepper } from '@/design-system/components/Stepper'
import { SPREADSHEET_ACCEPT } from '@/components/flat-file/import-accept'
import { FileDropzone } from '@/design-system/components/FileDropzone'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Combobox, type ComboboxOption } from '@/design-system/components/Combobox'
import { Listbox } from '@/design-system/components/Listbox'
import { Banner } from '@/design-system/components/Banner'
import { Button } from '@/design-system/primitives/Button'
import { Spinner } from '@/design-system/primitives/Spinner'
import { Textarea } from '@/design-system/primitives/Textarea'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'

import { getBackendUrl } from '@/lib/backend-url'
import { coerceEbayImportRows, type CoerceColumnMeta, type CoerceIssue } from './importCoerce.pure'
import {
  detectImportBlocks,
  markAllPooledShared,
  applyBlockDecisions,
  type BlockDecision,
  type ImportBlock,
} from './importBlocks.pure'

// ── Contract ──────────────────────────────────────────────────────────
export interface ExistingParent {
  id: string
  sku: string
  variationTheme?: string
}

/** Rich column metadata — kind/options drive typed coercion (EI.1). */
export interface WizardColumn extends CoerceColumnMeta {
  label: string
  /** Set on per-market columns ('IT' | 'DE' | …) — targets are scoped to the
   *  wizard's File market so repeated labels ("Item ID") stay unambiguous. */
  market?: string
  readOnly?: boolean
}

export interface EbayImportWizardProps {
  open: boolean
  onClose: () => void
  /** the eBay columns to map INTO (all markets — the wizard scopes by File market) */
  columns: WizardColumn[]
  /** to count new vs update in the preview */
  existingSkus?: Set<string>
  /** parents available for "import under parent" mode */
  existingParents?: ExistingParent[]
  onImport: (rows: Record<string, unknown>[], mode: 'fill-missing' | 'overwrite', targetParentId?: string) => void
  marketplace: string
  /** when set + open, auto-parse this file (the drag-drop-on-grid entry) */
  initialFile?: File | null
}

type MergeMode = 'fill-missing' | 'overwrite'
type ImportTarget = 'new' | 'parent'
type Confidence = 'exact' | 'fuzzy' | 'none'
const SKIP = '__skip__'
const MAX_BYTES = 15 * 1024 * 1024
const PREVIEW_LIMIT = 50
const MARKET_CHOICES = ['IT', 'DE', 'FR', 'ES', 'UK'] as const

interface ParseResult {
  headers: string[]
  rows: Record<string, unknown>[]
  kind: string
}

interface HeaderRow {
  header: string
  sample: string
  target: string // an eBay column id, or SKIP
  confidence: Confidence
}

// ── Matching helpers ──────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function autoMatch(
  header: string,
  columns: WizardColumn[],
): { target: string; confidence: Confidence } {
  // 1) exact: header === col.id OR header === col.label
  const exact = columns.find((c) => header === c.id || header === c.label)
  if (exact) return { target: exact.id, confidence: 'exact' }

  // 2) normalized: norm(header) === norm(col.id || col.label)
  const nh = norm(header)
  const fuzzy = columns.find((c) => norm(c.id) === nh || norm(c.label) === nh)
  if (fuzzy) return { target: fuzzy.id, confidence: 'fuzzy' }

  // 3) none
  return { target: SKIP, confidence: 'none' }
}

function toCell(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ── Wizard type scale (named styles, not ad-hoc sizes) ────────────────
const T = {
  caption: { fontSize: 11.5, color: 'var(--h10-text-3)' } as const,
  label: { fontSize: 12, fontWeight: 600, color: 'var(--h10-text-2)' } as const,
  body: { fontSize: 12.5, color: 'var(--h10-text-2)' } as const,
  value: { fontSize: 12.5, color: 'var(--h10-text)' } as const,
  micro: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--h10-text-3)' } as const,
  note: { fontSize: 11.5 } as const,
  small: { fontSize: 13 } as const,
} as const

const CONFIDENCE_META: Record<Confidence, { tone: TagTone; label: string }> = {
  exact: { tone: 'positive', label: 'Exact' },
  fuzzy: { tone: 'warning', label: 'Fuzzy' },
  none: { tone: 'neutral', label: 'Unmapped' },
}

// ── Component ─────────────────────────────────────────────────────────
export function EbayImportWizard({
  open,
  onClose,
  columns,
  existingSkus,
  existingParents,
  onImport,
  marketplace,
  initialFile,
}: EbayImportWizardProps) {
  const [stepKey, setStepKey] = useState<'upload' | 'map' | 'review' | 'preview'>('upload')
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [mapping, setMapping] = useState<HeaderRow[]>([])
  const [mode, setMode] = useState<MergeMode>('fill-missing')
  const [importTarget, setImportTarget] = useState<ImportTarget>('new')
  const [targetParentId, setTargetParentId] = useState<string>('')
  // EI.1 — the market whose per-market columns this FILE addresses.
  const [fileMarket, setFileMarket] = useState<string>(marketplace)
  // EI.2 — operator overlays: shared quick-fix rows + per-block decisions.
  const [fixedRows, setFixedRows] = useState<Record<string, unknown>[] | null>(null)
  const [decisions, setDecisions] = useState<Record<string, BlockDecision>>({})

  // Reset ALL state whenever the modal closes/reopens.
  useEffect(() => {
    if (!open) {
      setStepKey('upload')
      setParsing(false)
      setParseError(null)
      setParsed(null)
      setPasteText('')
      setMapping([])
      setMode('fill-missing')
      setImportTarget('new')
      setTargetParentId('')
      setFixedRows(null)
      setDecisions({})
      return
    }
    setFileMarket(marketplace)
    // Smart default: when exactly one family is loaded, pre-select "Under parent"
    // so the operator doesn't have to switch — importing into a single family is
    // the common case (wizard opened from that family's page).
    if (existingParents?.length === 1) {
      setImportTarget('parent')
      setTargetParentId(existingParents[0].id)
    } else {
      setImportTarget('new')
      setTargetParentId('')
    }
    // existingParents intentionally read from closure — only fires when `open`
    // transitions; we don't want re-running mid-session if the array ref changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Drag-drop-on-grid entry: when opened with a pre-loaded file, parse it.
  useEffect(() => {
    if (open && initialFile) onFiles([initialFile])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  // ── EI.1: market-scoped mappable columns ────────────────────────────
  // Core (market-less) columns + ONLY the File market's per-market columns, so
  // repeated labels ("Item ID", "Price (€)") resolve deterministically.
  const scopedColumns = useMemo<WizardColumn[]>(
    () => columns.filter((c) => !c.market || c.market === fileMarket),
    [columns, fileMarket],
  )

  // The combobox target options: every scoped column + an explicit Skip option.
  const targetOptions: ComboboxOption[] = useMemo(
    () => [
      { value: SKIP, label: '— Skip this column —' },
      ...scopedColumns.map((c) => ({
        value: c.id,
        label:
          (c.market ? `${c.label} · ${c.market}` : c.label) +
          (c.kind === 'readonly' ? ' (link only)' : ''),
      })),
    ],
    [scopedColumns],
  )

  const remap = (headers: string[], first: Record<string, unknown>, cols: WizardColumn[]) =>
    headers.map((header) => {
      const { target, confidence } = autoMatch(header, cols)
      return { header, sample: toCell(first[header]), target, confidence }
    })

  // File market change re-runs the auto-map so per-market headers follow it.
  const onFileMarketChange = (mp: string) => {
    setFileMarket(mp)
    if (parsed) {
      const cols = columns.filter((c) => !c.market || c.market === mp)
      setMapping(remap(parsed.headers, parsed.rows[0] ?? {}, cols))
      setFixedRows(null)
      setDecisions({})
    }
  }

  // ── Parse transport (shared by file + paste) ───────────────────────
  async function runParse(body: {
    content?: string
    base64?: string
    filename: string
    kind?: 'csv' | 'xlsx' | 'json'
  }) {
    setParsing(true)
    setParseError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => null)) as
        | (ParseResult & { error?: string })
        | { error?: string }
        | null
      if (!res.ok || !json || !('headers' in json)) {
        const message =
          (json && 'error' in json && json.error) ||
          `Could not parse the file (HTTP ${res.status}).`
        throw new Error(message)
      }
      const result: ParseResult = {
        headers: json.headers,
        rows: json.rows,
        kind: json.kind,
      }
      if (!result.headers.length) {
        throw new Error('No columns were found in the file. Check it has a header row.')
      }
      // Seed the auto-mapping from the headers (scoped to the File market).
      const first = result.rows[0] ?? {}
      setParsed(result)
      setMapping(remap(result.headers, first, scopedColumns))
      setFixedRows(null)
      setDecisions({})
      setStepKey('map') // auto-advance to Map
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Parse failed.')
    } finally {
      setParsing(false)
    }
  }

  function onFiles(files: File[]) {
    const file = files[0]
    if (!file) return
    const name = file.name.toLowerCase()
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xlsm') || name.endsWith('.xlsb') || name.endsWith('.xls')
    const isJson = name.endsWith('.json')
    const reader = new FileReader()
    reader.onerror = () => setParseError('Could not read the selected file.')
    reader.onload = () => {
      const out = reader.result
      if (typeof out !== 'string') {
        setParseError('Could not read the selected file.')
        return
      }
      if (isXlsx) {
        // FileReader.readAsDataURL → "data:...;base64,XXXX" — strip the prefix.
        const base64 = out.includes(',') ? out.slice(out.indexOf(',') + 1) : out
        void runParse({ base64, filename: file.name, kind: 'xlsx' })
      } else {
        void runParse({ content: out, filename: file.name, kind: isJson ? 'json' : 'csv' })
      }
    }
    if (isXlsx) reader.readAsDataURL(file)
    else reader.readAsText(file)
  }

  function onParsePaste() {
    const text = pasteText.trim()
    if (!text) return
    // Sniff: leading { or [ → json, else csv/tsv (delimiter sniffed server-side via filename).
    const looksJson = text.startsWith('{') || text.startsWith('[')
    void runParse({
      content: pasteText,
      filename: looksJson ? 'pasted.json' : 'pasted.csv',
      kind: looksJson ? 'json' : 'csv',
    })
  }

  // ── Derived: mapped rows + coercion + blocks ────────────────────────
  const mappedHeaders = useMemo(() => mapping.filter((m) => m.target !== SKIP), [mapping])
  const skippedCount = mapping.length - mappedHeaders.length

  // The eBay column ids that ended up mapped (dedup, preserve column order).
  const mappedColumnIds = useMemo(() => {
    const used = new Set(mappedHeaders.map((m) => m.target))
    return scopedColumns.filter((c) => used.has(c.id)).map((c) => c.id)
  }, [mappedHeaders, scopedColumns])

  const columnLabelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of columns) m.set(c.id, c.market ? `${c.label} · ${c.market}` : c.label)
    return m
  }, [columns])

  // Build the eBay rows from the mapping (only non-skipped headers).
  const mappedRows = useMemo<Record<string, unknown>[]>(() => {
    if (!parsed) return []
    const pairs = mappedHeaders.map((m) => [m.header, m.target] as const)
    return parsed.rows.map((src) => {
      const out: Record<string, unknown> = {}
      for (const [header, target] of pairs) {
        // last write wins if two headers map to the same column
        out[target] = src[header]
      }
      return out
    })
  }, [parsed, mappedHeaders])

  // EI.1 — typed coercion against the full column metadata.
  const coerceResult = useMemo(
    () => coerceEbayImportRows(mappedRows, columns),
    [mappedRows, columns],
  )
  // EI.2 — operator overlay (shared quick-fix) sits on top of coercion.
  const workingRows = fixedRows ?? coerceResult.rows

  const blockAnalysis = useMemo(() => detectImportBlocks(workingRows), [workingRows])
  const blocks = useMemo<ImportBlock[]>(
    () => blockAnalysis.blocks.map((b) => ({ ...b, decision: decisions[b.key] ?? b.decision })),
    [blockAnalysis, decisions],
  )
  const hasReviewStep = importTarget === 'new' && !blockAnalysis.flat && blocks.length > 0

  // Final rows the Import button hands over (skip-filtered).
  const finalRows = useMemo(
    () => (hasReviewStep ? applyBlockDecisions(workingRows, blocks) : workingRows),
    [hasReviewStep, workingRows, blocks],
  )

  const issueByCell = useMemo(() => {
    const m = new Map<string, CoerceIssue>()
    for (const i of coerceResult.issues) m.set(`${i.rowIndex}|${i.columnId}`, i)
    return m
  }, [coerceResult.issues])
  const errorCount = coerceResult.issues.filter((i) => i.level === 'error').length
  const warnCount = coerceResult.issues.length - errorCount

  // Which eBay column id carries the SKU (for new-vs-update counting).
  const skuColumnId = useMemo(() => {
    const direct = mappedColumnIds.find((id) => id === 'sku' || id === 'SKU')
    if (direct) return direct
    return mappedColumnIds.find((id) => norm(id) === 'sku') ?? null
  }, [mappedColumnIds])

  const { newCount, updateCount } = useMemo(() => {
    if (!skuColumnId || !existingSkus || existingSkus.size === 0) {
      return { newCount: finalRows.length, updateCount: 0 }
    }
    let update = 0
    for (const row of finalRows) {
      const sku = toCell(row[skuColumnId]).trim()
      if (sku && existingSkus.has(sku)) update += 1
    }
    return { newCount: finalRows.length - update, updateCount: update }
  }, [finalRows, skuColumnId, existingSkus])

  // Parent picker options for "Import under parent" mode.
  const parentOptions: ComboboxOption[] = useMemo(
    () => (existingParents ?? []).map((p) => ({ value: p.id, label: p.sku })),
    [existingParents],
  )

  // ── Steps (dynamic — Review only for block files) ───────────────────
  const steps = useMemo(
    () =>
      hasReviewStep
        ? [
            { key: 'upload', label: 'Upload' },
            { key: 'map', label: 'Map' },
            { key: 'review', label: 'Review listings' },
            { key: 'preview', label: 'Preview' },
          ]
        : [
            { key: 'upload', label: 'Upload' },
            { key: 'map', label: 'Map' },
            { key: 'preview', label: 'Preview' },
          ],
    [hasReviewStep],
  )
  const stepIndex = Math.max(0, steps.findIndex((s) => s.key === stepKey))
  const goNext = () => setStepKey(steps[Math.min(stepIndex + 1, steps.length - 1)].key as typeof stepKey)
  const goBack = () => setStepKey(steps[Math.max(stepIndex - 1, 0)].key as typeof stepKey)

  // ── Render nothing when closed ──────────────────────────────────────
  if (!open) return null

  // ── Step: Upload ────────────────────────────────────────────────────
  const uploadBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {parseError && (
        <Banner variant="error" title="Couldn’t read that file">
          {parseError}
        </Banner>
      )}

      {parsing ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '48px 0',
            color: 'var(--h10-text-2)',
          }}
        >
          <Spinner size={28} />
          <span style={T.small}>Parsing your file…</span>
        </div>
      ) : (
        <>
          <FileDropzone
            onFiles={onFiles}
            accept={SPREADSHEET_ACCEPT}
            maxBytes={MAX_BYTES}
            hint={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <UploadCloud size={13} aria-hidden /> CSV, TSV, Excel or JSON · up to 15MB
              </span>
            }
          />

          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, ...T.micro }}
          >
            <span style={{ flex: 1, height: 1, background: 'var(--h10-border-subtle)' }} />
            or paste data
            <span style={{ flex: 1, height: 1, background: 'var(--h10-border-subtle)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...T.label }}
            >
              <ClipboardPaste size={13} aria-hidden /> Paste CSV / TSV rows
            </label>
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'sku\tcondition\tprice\nABC-123\tNew\t49.99'}
              rows={6}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', ...T.note }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" disabled={!pasteText.trim()} onClick={onParsePaste}>
                Parse pasted data
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )

  // ── Step: Map ───────────────────────────────────────────────────────
  const setTarget = (header: string, target: string) => {
    setMapping((prev) => prev.map((m) => (m.header === header ? { ...m, target } : m)))
    setFixedRows(null)
    setDecisions({})
  }

  const mapColumns: Column<HeaderRow>[] = [
    {
      key: 'source',
      label: 'Source column',
      render: (row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
          <span style={{ fontWeight: 600, color: 'var(--h10-text)' }}>{row.header}</span>
          <span
            style={{ ...T.caption, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}
            title={row.sample}
          >
            {row.sample ? `e.g. ${row.sample}` : 'no sample'}
          </span>
        </div>
      ),
    },
    {
      key: 'target',
      label: 'Map to eBay column',
      render: (row) => (
        <div style={{ minWidth: 240, width: '100%' }}>
          <Combobox
            options={targetOptions}
            value={row.target}
            onChange={(v) => setTarget(row.header, v)}
            placeholder="Choose a column…"
          />
        </div>
      ),
    },
    {
      key: 'confidence',
      label: 'Match',
      align: 'center',
      render: (row) => {
        const meta = CONFIDENCE_META[row.target === SKIP ? 'none' : row.confidence]
        return <Tag tone={meta.tone}>{row.target === SKIP ? 'Skipped' : meta.label}</Tag>
      },
    },
  ]

  const mapBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Banner variant="info" title={`Map columns for eBay ${fileMarket}`}>
        We auto-matched what we could. Adjust any column or set it to “Skip”.
      </Banner>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
          <span style={T.label}>
            File market — per-market columns (Item ID, Price, Qty…) map here
          </span>
          <Listbox
            value={fileMarket}
            onChange={(v) => onFileMarketChange(String(v))}
            options={MARKET_CHOICES.map((m) => ({ value: m, label: m === marketplace ? `${m} (current grid)` : m }))}
          />
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, ...T.body }}
        >
          <Wand2 size={14} aria-hidden style={{ color: 'var(--h10-primary)' }} />
          <strong style={{ color: 'var(--h10-text)' }}>{mapping.length}</strong> columns ·{' '}
          <strong style={{ color: 'var(--h10-text)' }}>{mappedHeaders.length}</strong> mapped ·{' '}
          <strong style={{ color: 'var(--h10-text)' }}>{skippedCount}</strong> skipped
        </div>
      </div>
      {fileMarket !== marketplace && (
        <Banner variant="warning" title={`This file targets eBay ${fileMarket}, the grid shows ${marketplace}`}>
          Prices, quantities and Item IDs land on the {fileMarket} columns — switch the page’s market selector to {fileMarket} to see them after importing.
        </Banner>
      )}
      <DataGrid
        columns={mapColumns}
        rows={mapping}
        rowKey={(r) => r.header}
        maxHeight={340}
        emptyState="No columns to map."
      />
    </div>
  )

  // ── Step: Review listings (EI.2) ────────────────────────────────────
  const adoptCount = blocks.filter((b) => b.decision === 'adopt').length
  const createCount = blocks.filter((b) => b.decision === 'create').length
  const skipCount = blocks.filter((b) => b.decision === 'skip').length
  const blockErrorCount = blocks.reduce(
    (n, b) => n + (b.decision !== 'skip' ? b.issues.filter((i) => i.level === 'error').length : 0),
    0,
  )

  const reviewColumns: Column<ImportBlock>[] = [
    {
      key: 'listing',
      label: 'Listing',
      render: (b) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180 }}>
          <span style={{ fontWeight: 600, color: 'var(--h10-text)' }}>{b.parentSku}</span>
          {b.title && (
            <span
              style={{ ...T.caption, maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={b.title}
            >
              {b.title}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'itemId',
      label: 'eBay Item ID',
      render: (b) =>
        b.itemId ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...T.value }}>
            <Link2 size={12} aria-hidden style={{ color: 'var(--h10-primary)' }} />
            {b.itemId}
          </span>
        ) : (
          <Tag tone="neutral">new listing</Tag>
        ),
    },
    {
      key: 'children',
      label: 'Variants',
      align: 'center',
      render: (b) => {
        const pooled = b.childSkus.filter((s) => blockAnalysis.pooledSkus.has(s)).length
        return (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={T.value}>{b.standalone ? '—' : b.childSkus.length}</span>
            {pooled > 0 && (
              <Tag tone="info">
                <Layers size={11} aria-hidden style={{ marginRight: 3 }} />
                {pooled} pooled
              </Tag>
            )}
          </div>
        )
      },
    },
    {
      key: 'shared',
      label: 'Shared-SKU',
      align: 'center',
      render: (b) => (b.shared ? <Tag tone="positive">Shared</Tag> : <Tag tone="neutral">—</Tag>),
    },
    {
      key: 'issues',
      label: 'Checks',
      render: (b) =>
        b.issues.length === 0 ? (
          <Tag tone="positive">OK</Tag>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {b.issues.map((i, idx) => (
              <span
                key={idx}
                style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, ...T.note, color: i.level === 'error' ? 'var(--h10-danger)' : 'var(--h10-warning)', maxWidth: 320 }}
              >
                <AlertTriangle size={11} aria-hidden style={{ marginTop: 2, flexShrink: 0 }} />
                {i.message}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: 'decision',
      label: 'Decision',
      render: (b) => (
        <SegmentedControl
          size="sm"
          value={b.decision}
          onChange={(v) => setDecisions((prev) => ({ ...prev, [b.key]: v as BlockDecision }))}
          options={
            b.itemId
              ? [
                  { value: 'adopt', label: 'Adopt' },
                  { value: 'skip', label: 'Skip' },
                ]
              : [
                  { value: 'create', label: 'Create' },
                  { value: 'skip', label: 'Skip' },
                ]
          }
        />
      ),
    },
  ]

  const reviewBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Banner variant="info" title={`${blocks.length} listing${blocks.length === 1 ? '' : 's'} in this file`}>
        <strong>{adoptCount}</strong> adopt existing eBay listings (linked by Item ID — never re-created) ·{' '}
        <strong>{createCount}</strong> create new · <strong>{skipCount}</strong> skipped ·{' '}
        <strong>{blockAnalysis.pooledSkus.size}</strong> SKU{blockAnalysis.pooledSkus.size === 1 ? '' : 's'} pooling stock across listings
      </Banner>
      {blockAnalysis.needsSharedFix && !fixedRows && (
        <Banner variant="error" title="Pooled SKUs need the Shared-SKU flag">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span>
              The same child SKUs appear in several listings, but not every listing is flagged Shared-SKU — publishing
              would stop with duplicate-SKU errors.
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const fixed = markAllPooledShared(workingRows, blockAnalysis)
                setFixedRows(fixed.rows)
              }}
            >
              Flag all as Shared-SKU
            </Button>
          </div>
        </Banner>
      )}
      {fixedRows && (
        <Banner variant="success" title="Shared-SKU flag applied to all pooled listings">
          Stock for pooled SKUs stays one warehouse pool; each listing keeps its own price and content.
        </Banner>
      )}
      <DataGrid
        columns={reviewColumns}
        rows={blocks}
        rowKey={(b) => b.key}
        maxHeight={380}
        emptyState="No listings detected."
      />
    </div>
  )

  // ── Step: Preview & import ──────────────────────────────────────────
  const previewColumns: Column<Record<string, unknown>>[] = mappedColumnIds.map((id) => ({
    key: id,
    label: columnLabelById.get(id) ?? id,
    render: (row) => {
      const v = toCell(row[id])
      const rowIndex = workingRows.indexOf(row)
      const issue = rowIndex >= 0 ? issueByCell.get(`${rowIndex}|${id}`) : undefined
      return (
        <span
          style={{
            display: 'inline-block',
            maxWidth: 200,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
            color: issue
              ? issue.level === 'error'
                ? 'var(--h10-danger)'
                : 'var(--h10-warning)'
              : v
              ? 'var(--h10-text)'
              : 'var(--h10-text-3)',
            fontWeight: issue ? 600 : undefined,
          }}
          title={issue ? `${issue.message}` : v}
        >
          {v || '—'}
        </span>
      )
    },
  }))

  const previewRows = workingRows.slice(0, PREVIEW_LIMIT)

  const hasParents = (existingParents?.length ?? 0) > 0

  const previewBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Import destination: new families vs under an existing parent */}
      {hasParents && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={T.label}>
            Import as
          </span>
          <SegmentedControl
            size="sm"
            value={importTarget}
            onChange={(v) => {
              setImportTarget(v as ImportTarget)
              if (v === 'new') setTargetParentId('')
            }}
            options={[
              { value: 'new', label: 'New families' },
              { value: 'parent', label: 'Under parent' },
            ]}
          />
          {importTarget === 'parent' && (
            <div style={{ marginTop: 4 }}>
              <Combobox
                options={parentOptions}
                value={targetParentId || undefined}
                onChange={(id) => setTargetParentId(id)}
                placeholder="Search by parent SKU…"
              />
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={T.label}>
          When a row matches an existing SKU…
        </span>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as MergeMode)}
          options={[
            { value: 'fill-missing', label: 'Only fill empty fields' },
            { value: 'overwrite', label: 'Overwrite with imported values' },
          ]}
        />
      </div>

      {(errorCount > 0 || warnCount > 0) && (
        <Banner
          variant={errorCount > 0 ? 'error' : 'warning'}
          title={`${errorCount} error${errorCount === 1 ? '' : 's'} · ${warnCount} warning${warnCount === 1 ? '' : 's'} in cell values`}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 120, overflowY: 'auto' }}>
            {coerceResult.issues.slice(0, 12).map((i, idx) => (
              <span key={idx} style={T.note}>
                Row {i.rowIndex + 1} · {columnLabelById.get(i.columnId) ?? i.columnId}: {i.message}
              </span>
            ))}
            {coerceResult.issues.length > 12 && (
              <span style={T.caption}>
                …and {coerceResult.issues.length - 12} more (cells are highlighted below)
              </span>
            )}
          </div>
        </Banner>
      )}

      <Banner
        variant="info"
        title={`${finalRows.length} ${finalRows.length === 1 ? 'row' : 'rows'} ready${skipCount > 0 ? ` (${skipCount} listing${skipCount === 1 ? '' : 's'} skipped)` : ''}`}
      >
        {skuColumnId ? (
          <>
            <strong>{newCount}</strong> new · <strong>{updateCount}</strong> update existing
            {existingSkus && existingSkus.size === 0 ? ' (no existing SKUs loaded)' : ''}
          </>
        ) : (
          'No SKU column mapped — every row will be imported as new.'
        )}
      </Banner>

      {previewColumns.length === 0 ? (
        <Banner variant="warning" title="Nothing mapped">
          Go back and map at least one column to import.
        </Banner>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DataGrid
            columns={previewColumns}
            rows={previewRows}
            rowKey={(_r) => String(previewRows.indexOf(_r))}
            maxHeight={320}
            emptyState="No rows to preview."
          />
          {workingRows.length > previewRows.length && (
            <span style={T.caption}>
              Showing first {previewRows.length} of {workingRows.length} rows.
            </span>
          )}
        </div>
      )}
    </div>
  )

  // ── Footer (per step) ───────────────────────────────────────────────
  let footer: ReactNode = null
  if (stepKey === 'upload') {
    footer = (
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    )
  } else if (stepKey === 'map') {
    footer = (
      <>
        <Button variant="secondary" onClick={goBack}>
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button variant="primary" disabled={mappedHeaders.length === 0} onClick={goNext}>
          Continue <ArrowRight size={14} aria-hidden />
        </Button>
      </>
    )
  } else if (stepKey === 'review') {
    footer = (
      <>
        <Button variant="secondary" onClick={goBack}>
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button
          variant="primary"
          disabled={blocks.every((b) => b.decision === 'skip')}
          onClick={goNext}
          title={blockErrorCount > 0 ? 'There are unresolved checks — you can still continue and fix them in the grid' : undefined}
        >
          Continue <ArrowRight size={14} aria-hidden />
        </Button>
      </>
    )
  } else {
    footer = (
      <>
        <Button variant="secondary" onClick={goBack}>
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button
          variant="primary"
          disabled={
            finalRows.length === 0 ||
            mappedColumnIds.length === 0 ||
            (importTarget === 'parent' && !targetParentId)
          }
          onClick={() => {
            onImport(finalRows, mode, importTarget === 'parent' ? targetParentId : undefined)
            onClose()
          }}
        >
          Import {finalRows.length} {finalRows.length === 1 ? 'row' : 'rows'}
          {errorCount > 0 ? ` (${errorCount} cell error${errorCount === 1 ? '' : 's'})` : ''}
        </Button>
      </>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Import eBay flat-file data"
      subtitle={
        <div style={{ marginTop: 8 }}>
          <Stepper steps={steps} current={stepIndex} />
        </div>
      }
      footer={footer}
    >
      {stepKey === 'upload' ? uploadBody : stepKey === 'map' ? mapBody : stepKey === 'review' ? reviewBody : previewBody}
    </Modal>
  )
}

export default EbayImportWizard
