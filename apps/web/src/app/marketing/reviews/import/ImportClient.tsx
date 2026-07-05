'use client'

import { useCallback, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Eye,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FileUp,
  ArrowRight,
} from 'lucide-react'
import { Listbox } from '@/design-system/components/Listbox'

type CanonicalField =
  | 'externalReviewId'
  | 'rating'
  | 'title'
  | 'body'
  | 'authorName'
  | 'postedAt'
  | 'asin'
  | 'sku'
  | 'verifiedPurchase'
  | 'helpfulVotes'
  | 'marketplace'

const FIELD_ORDER: { key: CanonicalField; label: string; required?: boolean }[] = [
  { key: 'body', label: 'Review text', required: true },
  { key: 'rating', label: 'Rating (1–5)' },
  { key: 'title', label: 'Title' },
  { key: 'authorName', label: 'Author' },
  { key: 'postedAt', label: 'Date' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'externalReviewId', label: 'Review ID' },
  { key: 'asin', label: 'ASIN' },
  { key: 'sku', label: 'SKU' },
  { key: 'verifiedPurchase', label: 'Verified' },
  { key: 'helpfulVotes', label: 'Helpful votes' },
]

interface PreviewSampleRow {
  body: string | null
  title: string | null
  rating: number | null
  authorName: string | null
  marketplace: string | null
  postedAt: string | null
  errors: string[]
  warnings: string[]
}

interface ImportPreview {
  headers: string[]
  detectedMapping: Partial<Record<CanonicalField, string>>
  appliedMapping: Partial<Record<CanonicalField, string>>
  channel: string
  totalRows: number
  validRows: number
  invalidRows: number
  duplicateExisting: number
  duplicateInBatch: number
  willInsert: number
  sample: PreviewSampleRow[]
}

interface ApplyResult {
  parsed: number
  valid: number
  skippedInvalid: number
  summary: {
    reviewsSeen: number
    reviewsInserted: number
    reviewsSkippedExisting: number
    sentimentExtracted: number
    errors: string[]
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const SAMPLE_CSV = `body,rating,author,date,sku
"Casco fantastico, vestibilità perfetta e ottima ventilazione.",5,Marco R.,2026-05-12,XAV-HLM-001
"La giacca è arrivata con una cucitura difettosa sulla manica.",2,Giulia P.,2026-05-18,XAV-JKT-014
"Guanti comodi ma la taglia è più piccola del previsto.",3,Luca B.,2026-05-20,XAV-GLV-007`

export function ImportClient() {
  const router = useRouter()
  const [channel, setChannel] = useState('AMAZON')
  const [marketplace, setMarketplace] = useState('')
  const [text, setText] = useState('')
  const [bytesBase64, setBytesBase64] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [formatHint, setFormatHint] = useState<'csv' | 'json'>('csv')
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({})
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasInput = bytesBase64 != null || text.trim().length > 0

  const buildBody = useCallback(
    (overrideMapping?: Partial<Record<CanonicalField, string>>) => {
      const map = overrideMapping ?? mapping
      const cleanMap: Partial<Record<CanonicalField, string>> = {}
      for (const [k, v] of Object.entries(map)) {
        if (v) cleanMap[k as CanonicalField] = v
      }
      const base: Record<string, unknown> = {
        channel,
        marketplace: marketplace.trim() || null,
        columnMapping: cleanMap,
      }
      if (bytesBase64) {
        base.bytesBase64 = bytesBase64
        base.fileKind = 'xlsx'
      } else {
        base.text = text
        base.fileKind = formatHint
      }
      return base
    },
    [channel, marketplace, mapping, bytesBase64, text, formatHint],
  )

  const doPreview = useCallback(
    async (overrideMapping?: Partial<Record<CanonicalField, string>>) => {
      setLoading(true)
      setError(null)
      setResult(null)
      try {
        const res = await fetch('/api/reviews/import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(overrideMapping)),
        })
        const json = await res.json()
        if (!res.ok || !json.ok) {
          throw new Error(json.message || json.error || 'Preview failed')
        }
        const p = json.preview as ImportPreview
        setPreview(p)
        // Seed the mapping editor with what was detected/applied so the
        // operator sees the auto-mapping and can correct it.
        if (!overrideMapping) setMapping(p.appliedMapping)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setPreview(null)
      } finally {
        setLoading(false)
      }
    },
    [buildBody],
  )

  const doApply = useCallback(async () => {
    setApplying(true)
    setError(null)
    try {
      const res = await fetch('/api/reviews/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json.message || json.error || 'Import failed')
      }
      setResult(json.result as ApplyResult)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }, [buildBody, router])

  const onFile = useCallback(async (file: File) => {
    const name = file.name.toLowerCase()
    setFileName(file.name)
    setResult(null)
    setPreview(null)
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const buf = await file.arrayBuffer()
      setBytesBase64(arrayBufferToBase64(buf))
      setText('')
    } else {
      const t = await file.text()
      setText(t)
      setBytesBase64(null)
      setFormatHint(name.endsWith('.json') ? 'json' : 'csv')
    }
  }, [])

  const onMappingChange = (field: CanonicalField, header: string) => {
    const next = { ...mapping, [field]: header || undefined }
    setMapping(next)
    if (preview) doPreview(next)
  }

  return (
    <div className="space-y-4">
      {/* Input panel */}
      <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Channel
            </span>
            <Listbox
              value={channel}
              onChange={setChannel}
              options={[
                { value: 'AMAZON', label: 'Amazon' },
                { value: 'EBAY', label: 'eBay' },
                { value: 'SHOPIFY', label: 'Shopify' },
              ]}
              ariaLabel="Channel"
              className="mt-1 w-full"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Default marketplace <span className="normal-case text-tertiary">(optional)</span>
            </span>
            <input
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              placeholder="IT"
              className="mt-1 w-full text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Paste format
            </span>
            <Listbox
              value={formatHint}
              onChange={(value) => setFormatHint(value as 'csv' | 'json')}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'json', label: 'JSON' },
              ]}
              disabled={bytesBase64 != null}
              ariaLabel="Paste format"
              className="mt-1 w-full"
            />
          </label>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md ring-1 ring-inset bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 cursor-pointer">
            <FileUp className="h-3.5 w-3.5" />
            Upload file (CSV / JSON / XLSX)
            <input
              type="file"
              accept=".csv,.json,.xlsx,.xls,text/csv,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onFile(f)
              }}
            />
          </label>
          {fileName && (
            <span className="text-xs text-slate-500 dark:text-slate-400">{fileName}</span>
          )}
          <button
            type="button"
            onClick={() => {
              setText(SAMPLE_CSV)
              setBytesBase64(null)
              setFormatHint('csv')
              setFileName(null)
            }}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Load sample
          </button>
        </div>

        {bytesBase64 == null && (
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setResult(null)
            }}
            placeholder="Paste CSV or JSON here…"
            rows={6}
            className="w-full text-xs font-mono rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
          />
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => doPreview()}
            disabled={!hasInput || loading}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ring-1 ring-inset bg-slate-900 text-white ring-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:ring-slate-100 disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            Preview
          </button>
          {preview && (
            <button
              type="button"
              onClick={doApply}
              disabled={applying || preview.willInsert === 0}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md ring-1 ring-inset bg-emerald-600 text-white ring-emerald-600 hover:bg-emerald-700 disabled:opacity-40"
            >
              {applying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Import {preview.willInsert} review{preview.willInsert === 1 ? '' : 's'}
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Apply result */}
      {result && (
        <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-md px-3 py-3">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              Imported {result.summary.reviewsInserted} new review
              {result.summary.reviewsInserted === 1 ? '' : 's'} · {result.summary.sentimentExtracted}{' '}
              classified
            </span>
          </div>
          <div className="text-xs text-emerald-800 dark:text-emerald-300">
            {result.parsed} parsed · {result.summary.reviewsSkippedExisting} already existed ·{' '}
            {result.skippedInvalid} invalid
            {result.summary.errors.length > 0 && ` · ${result.summary.errors.length} errors`}
          </div>
          <Link
            href="/marketing/reviews"
            className="inline-flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300 hover:underline mt-2"
          >
            View in feed <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md p-3 space-y-3">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <PreviewStat label="Rows" value={preview.totalRows} />
            <PreviewStat label="Valid" value={preview.validRows} tone="emerald" />
            <PreviewStat
              label="Invalid"
              value={preview.invalidRows}
              tone={preview.invalidRows > 0 ? 'rose' : undefined}
            />
            <PreviewStat
              label="Duplicates"
              value={preview.duplicateExisting + preview.duplicateInBatch}
              tone={preview.duplicateExisting + preview.duplicateInBatch > 0 ? 'amber' : undefined}
            />
            <PreviewStat label="Will import" value={preview.willInsert} tone="blue" />
          </div>

          {/* Column mapping editor */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Column mapping
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {FIELD_ORDER.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    {f.label}
                    {f.required && <span className="text-rose-500"> *</span>}
                  </span>
                  <Listbox
                    value={mapping[f.key] ?? ''}
                    onChange={(value) => onMappingChange(f.key, value)}
                    options={[
                      { value: '', label: '— none —' },
                      ...preview.headers.map((h) => ({ value: h, label: h })),
                    ]}
                    ariaLabel={f.label}
                    className="mt-0.5 w-full"
                  />
                </label>
              ))}
            </div>
          </div>

          {/* Sample table */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Sample (first {preview.sample.length})
            </div>
            <div className="overflow-x-auto border border-default dark:border-slate-800 rounded">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950/50 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">Rating</th>
                    <th className="text-left font-medium px-2 py-1.5">Review</th>
                    <th className="text-left font-medium px-2 py-1.5">Author</th>
                    <th className="text-left font-medium px-2 py-1.5">Date</th>
                    <th className="text-left font-medium px-2 py-1.5">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {preview.sample.map((r, i) => (
                    <tr key={i} className={r.errors.length > 0 ? 'bg-rose-50/50 dark:bg-rose-950/20' : ''}>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap">
                        {r.rating != null ? `${r.rating}★` : '—'}
                      </td>
                      <td className="px-2 py-1.5 max-w-[360px]">
                        <div className="truncate">{r.body ?? <span className="text-rose-500">missing</span>}</div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.authorName ?? '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {r.postedAt ? r.postedAt.slice(0, 10) : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.errors.map((e) => (
                          <span key={e} className="text-rose-600 dark:text-rose-400 mr-1">
                            {e}
                          </span>
                        ))}
                        {r.warnings.map((w) => (
                          <span key={w} className="text-amber-600 dark:text-amber-400 mr-1">
                            {w}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PreviewStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'emerald' | 'rose' | 'amber' | 'blue'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'rose'
        ? 'text-rose-700 dark:text-rose-300'
        : tone === 'amber'
          ? 'text-amber-700 dark:text-amber-300'
          : tone === 'blue'
            ? 'text-blue-700 dark:text-blue-300'
            : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="rounded-md border border-default dark:border-slate-800 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}
