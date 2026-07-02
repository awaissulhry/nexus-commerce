'use client'

/**
 * EbayImportWizard — a self-contained 3-step file-import wizard for the eBay flat
 * file (Upload · Map · Preview). Built ENTIRELY from the H10 design system: zero
 * hand-rolled raw-Tailwind colour/border classes. Layout is plain divs with inline
 * `var(--h10-*)` token styles; everything visible is a DS component/primitive.
 *
 * The parent owns the contract (props below) and wires the result into the eBay
 * flat-file store. This file does NOT touch EbayFlatFileClient.
 */

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, ArrowLeft, Wand2, ClipboardPaste, UploadCloud } from 'lucide-react'

import { Modal } from '@/design-system/components/Modal'
import { Stepper } from '@/design-system/components/Stepper'
import { FileDropzone } from '@/design-system/components/FileDropzone'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Combobox, type ComboboxOption } from '@/design-system/components/Combobox'
import { Banner } from '@/design-system/components/Banner'
import { Button } from '@/design-system/primitives/Button'
import { Spinner } from '@/design-system/primitives/Spinner'
import { Textarea } from '@/design-system/primitives/Textarea'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'

import { getBackendUrl } from '@/lib/backend-url'

// ── Contract ──────────────────────────────────────────────────────────
export interface ExistingParent {
  id: string
  sku: string
  variationTheme?: string
}

export interface EbayImportWizardProps {
  open: boolean
  onClose: () => void
  /** the eBay columns to map INTO */
  columns: { id: string; label: string }[]
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

const STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map' },
  { key: 'preview', label: 'Preview' },
]

// ── Matching helpers ──────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function autoMatch(
  header: string,
  columns: { id: string; label: string }[],
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
  const [step, setStep] = useState(0)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [mapping, setMapping] = useState<HeaderRow[]>([])
  const [mode, setMode] = useState<MergeMode>('fill-missing')
  const [importTarget, setImportTarget] = useState<ImportTarget>('new')
  const [targetParentId, setTargetParentId] = useState<string>('')

  // Reset ALL state whenever the modal closes/reopens.
  useEffect(() => {
    if (!open) {
      setStep(0)
      setParsing(false)
      setParseError(null)
      setParsed(null)
      setPasteText('')
      setMapping([])
      setMode('fill-missing')
      setImportTarget('new')
      setTargetParentId('')
    }
  }, [open])

  // Drag-drop-on-grid entry: when opened with a pre-loaded file, parse it.
  useEffect(() => {
    if (open && initialFile) onFiles([initialFile])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  // The combobox target options: every eBay column + an explicit Skip option.
  const targetOptions: ComboboxOption[] = useMemo(
    () => [
      { value: SKIP, label: '— Skip this column —' },
      ...columns.map((c) => ({ value: c.id, label: c.label })),
    ],
    [columns],
  )

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
      // Seed the auto-mapping from the headers.
      const first = result.rows[0] ?? {}
      setParsed(result)
      setMapping(
        result.headers.map((header) => {
          const { target, confidence } = autoMatch(header, columns)
          return { header, sample: toCell(first[header]), target, confidence }
        }),
      )
      setStep(1) // auto-advance to Map
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
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls')
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

  // ── Derived: mapped rows + stats ────────────────────────────────────
  const mappedHeaders = useMemo(() => mapping.filter((m) => m.target !== SKIP), [mapping])
  const skippedCount = mapping.length - mappedHeaders.length

  // The eBay column ids that ended up mapped (dedup, preserve column order).
  const mappedColumnIds = useMemo(() => {
    const used = new Set(mappedHeaders.map((m) => m.target))
    return columns.filter((c) => used.has(c.id)).map((c) => c.id)
  }, [mappedHeaders, columns])

  const columnLabelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of columns) m.set(c.id, c.label)
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

  // Which eBay column id carries the SKU (for new-vs-update counting).
  const skuColumnId = useMemo(() => {
    const direct = mappedColumnIds.find((id) => id === 'sku' || id === 'SKU')
    if (direct) return direct
    return mappedColumnIds.find((id) => norm(id) === 'sku') ?? null
  }, [mappedColumnIds])

  const { newCount, updateCount } = useMemo(() => {
    if (!skuColumnId || !existingSkus || existingSkus.size === 0) {
      return { newCount: mappedRows.length, updateCount: 0 }
    }
    let update = 0
    for (const row of mappedRows) {
      const sku = toCell(row[skuColumnId]).trim()
      if (sku && existingSkus.has(sku)) update += 1
    }
    return { newCount: mappedRows.length - update, updateCount: update }
  }, [mappedRows, skuColumnId, existingSkus])

  // Parent picker options for "Import under parent" mode.
  const parentOptions: ComboboxOption[] = useMemo(
    () => (existingParents ?? []).map((p) => ({ value: p.id, label: p.sku })),
    [existingParents],
  )

  // ── Render nothing when closed ──────────────────────────────────────
  if (!open) return null

  // ── Step 1: Upload ──────────────────────────────────────────────────
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
          <span style={{ fontSize: 13 }}>Parsing your file…</span>
        </div>
      ) : (
        <>
          <FileDropzone
            onFiles={onFiles}
            accept=".csv,.tsv,.xlsx,.xls,.json"
            maxBytes={MAX_BYTES}
            hint={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <UploadCloud size={13} aria-hidden /> CSV, TSV, Excel or JSON · up to 15MB
              </span>
            }
          />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--h10-text-3)',
            }}
          >
            <span style={{ flex: 1, height: 1, background: 'var(--h10-border-subtle)' }} />
            or paste data
            <span style={{ flex: 1, height: 1, background: 'var(--h10-border-subtle)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--h10-text-2)',
              }}
            >
              <ClipboardPaste size={13} aria-hidden /> Paste CSV / TSV rows
            </label>
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'sku\tcondition\tprice\nABC-123\tNew\t49.99'}
              rows={6}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
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

  // ── Step 2: Map ─────────────────────────────────────────────────────
  const setTarget = (header: string, target: string) =>
    setMapping((prev) => prev.map((m) => (m.header === header ? { ...m, target } : m)))

  const mapColumns: Column<HeaderRow>[] = [
    {
      key: 'source',
      label: 'Source column',
      render: (row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
          <span style={{ fontWeight: 600, color: 'var(--h10-text)' }}>{row.header}</span>
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--h10-text-3)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 220,
            }}
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
      <Banner variant="info" title={`Map columns for ${marketplace}`}>
        We auto-matched what we could. Adjust any column or set it to “Skip”.
      </Banner>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12.5,
          color: 'var(--h10-text-2)',
        }}
      >
        <Wand2 size={14} aria-hidden style={{ color: 'var(--h10-primary)' }} />
        <strong style={{ color: 'var(--h10-text)' }}>{mapping.length}</strong> columns ·{' '}
        <strong style={{ color: 'var(--h10-text)' }}>{mappedHeaders.length}</strong> mapped ·{' '}
        <strong style={{ color: 'var(--h10-text)' }}>{skippedCount}</strong> skipped
      </div>
      <DataGrid
        columns={mapColumns}
        rows={mapping}
        rowKey={(r) => r.header}
        maxHeight={380}
        emptyState="No columns to map."
      />
    </div>
  )

  // ── Step 3: Preview & import ────────────────────────────────────────
  const previewColumns: Column<Record<string, unknown>>[] = mappedColumnIds.map((id) => ({
    key: id,
    label: columnLabelById.get(id) ?? id,
    render: (row) => {
      const v = toCell(row[id])
      return (
        <span
          style={{
            display: 'inline-block',
            maxWidth: 200,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            verticalAlign: 'bottom',
            color: v ? 'var(--h10-text)' : 'var(--h10-text-3)',
          }}
          title={v}
        >
          {v || '—'}
        </span>
      )
    },
  }))

  const previewRows = mappedRows.slice(0, PREVIEW_LIMIT)

  const hasParents = (existingParents?.length ?? 0) > 0

  const previewBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Import destination: new families vs under an existing parent */}
      {hasParents && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--h10-text-2)' }}>
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
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--h10-text-2)' }}>
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

      <Banner
        variant="info"
        title={`${mappedRows.length} ${mappedRows.length === 1 ? 'row' : 'rows'} ready`}
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
            maxHeight={360}
            emptyState="No rows to preview."
          />
          {mappedRows.length > previewRows.length && (
            <span style={{ fontSize: 11.5, color: 'var(--h10-text-3)' }}>
              Showing first {previewRows.length} of {mappedRows.length} rows.
            </span>
          )}
        </div>
      )}
    </div>
  )

  // ── Footer (per step) ───────────────────────────────────────────────
  let footer: ReactNode = null
  if (step === 0) {
    footer = (
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    )
  } else if (step === 1) {
    footer = (
      <>
        <Button variant="secondary" onClick={() => setStep(0)}>
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button variant="primary" disabled={mappedHeaders.length === 0} onClick={() => setStep(2)}>
          Continue <ArrowRight size={14} aria-hidden />
        </Button>
      </>
    )
  } else {
    footer = (
      <>
        <Button variant="secondary" onClick={() => setStep(1)}>
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button
          variant="primary"
          disabled={
            mappedRows.length === 0 ||
            mappedColumnIds.length === 0 ||
            (importTarget === 'parent' && !targetParentId)
          }
          onClick={() => {
            onImport(mappedRows, mode, importTarget === 'parent' ? targetParentId : undefined)
            onClose()
          }}
        >
          Import {mappedRows.length} {mappedRows.length === 1 ? 'row' : 'rows'}
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
          <Stepper steps={STEPS} current={step} />
        </div>
      }
      footer={footer}
    >
      {step === 0 ? uploadBody : step === 1 ? mapBody : previewBody}
    </Modal>
  )
}

export default EbayImportWizard
