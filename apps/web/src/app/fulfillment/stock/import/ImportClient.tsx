'use client'

/**
 * S.21 — Bulk CSV import.
 *
 * 3-stage flow:
 *   1. Upload + parse CSV. Errors surface inline (file too big,
 *      unparseable, missing required columns).
 *   2. Preview via dry-run POST: server resolves every SKU to a
 *      productId, computes wouldBeTotal, flags rows that would
 *      drive negative stock.
 *   3. Commit (button) — same payload re-sent with dryRun=false.
 *
 * Required CSV columns (any order, header row required):
 *   sku       — string, exact SKU match
 *   change    — signed integer; positive add, negative remove
 *   notes     — optional free-text appended to the audit row
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Upload, ArrowLeft, RefreshCw, AlertCircle, CheckCircle2, X,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface ParsedRow {
  sku: string
  change: number
  notes?: string
}
interface ApplyResult {
  sku: string
  change: number
  productId: string | null
  currentTotal: number | null
  wouldBeTotal: number | null
  applied: boolean
  error: string | null
}
interface ApplyResponse {
  dryRun: boolean
  succeeded: number
  failed: number
  total: number
  results: ApplyResult[]
}

interface Location {
  id: string
  code: string
  name: string
}

const CSV_TEMPLATE = `sku,change,notes
EXAMPLE-SKU-1,+5,received from supplier
EXAMPLE-SKU-2,-3,damaged
EXAMPLE-SKU-3,10,
`

function parseCsv(text: string): { rows: ParsedRow[]; error: string | null } {
  // Minimal RFC-4180-ish parser. Operator workflow: small files
  // (<5k rows) typed in spreadsheet apps. We don't ship a heavy
  // parser dep for that.
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return { rows: [], error: 'empty file' }
  const header = lines[0].split(',').map((s) => s.trim().toLowerCase())
  const skuIdx = header.indexOf('sku')
  const changeIdx = header.indexOf('change')
  const notesIdx = header.indexOf('notes')
  if (skuIdx < 0 || changeIdx < 0) {
    return { rows: [], error: 'missing required columns: sku, change' }
  }
  const rows: ParsedRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    const sku = (parts[skuIdx] ?? '').trim()
    const rawChange = (parts[changeIdx] ?? '').trim()
    if (!sku) continue
    const change = parseInt(rawChange.replace(/^\+/, ''), 10)
    if (!Number.isFinite(change)) continue
    const notes = notesIdx >= 0 ? (parts[notesIdx] ?? '').trim() : undefined
    rows.push({ sku, change, notes: notes || undefined })
  }
  return { rows, error: null }
}

export default function ImportClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [locations, setLocations] = useState<Location[]>([])
  const [locationCode, setLocationCode] = useState('IT-MAIN')
  const [parsed, setParsed] = useState<ParsedRow[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ApplyResponse | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`${getBackendUrl()}/api/stock/locations`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setLocations(j.locations ?? []))
      .catch(() => {})
  }, [])

  const handleFile = useCallback(async (file: File) => {
    if (file.size > 2_000_000) {
      setParseError(t('stock.import.parseError', { error: 'file > 2MB' }))
      return
    }
    const text = await file.text()
    const { rows, error } = parseCsv(text)
    if (error) {
      setParseError(t('stock.import.parseError', { error }))
      setParsed([])
      setPreview(null)
      return
    }
    setParseError(null)
    setParsed(rows)
    setPreview(null)
  }, [t])

  const runPreview = useCallback(async () => {
    if (parsed.length === 0) return
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, locationCode, items: parsed }),
      })
      const body: ApplyResponse | { error: string } = await res.json()
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
      }
      setPreview(body)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [parsed, locationCode, toast])

  const runCommit = useCallback(async () => {
    if (parsed.length === 0) return
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/bulk-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, locationCode, items: parsed }),
      })
      const body: ApplyResponse | { error: string } = await res.json()
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
      }
      setPreview(body)
      toast.success(t('stock.import.appliedToast', { n: body.succeeded }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [parsed, locationCode, t, toast])

  const downloadTemplate = useCallback(() => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'stock-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('stock.import.title')}
        description={t('stock.import.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.import.title') },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/fulfillment/stock"
              className="inline-flex items-center gap-1.5 h-11 sm:h-8 px-3 text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:text-slate-100"
            >
              <ArrowLeft size={14} /> {t('stock.title')}
            </Link>
            <Button variant="secondary" size="sm" onClick={downloadTemplate}>
              <Upload className="w-3.5 h-3.5 -rotate-180" />
              {t('stock.import.template')}
            </Button>
          </div>
        }
      />

      <Card>
        <div className="space-y-3">
          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
              {t('stock.import.location')}
            </label>
            <select
              value={locationCode}
              onChange={(e) => setLocationCode(e.target.value)}
              className="h-9 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.code}>{l.code} — {l.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
              {t('stock.import.uploadLabel')}
            </label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
              }}
              className="block text-base"
            />
          </div>
          {parseError && (
            <div className="text-base text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 inline-flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5" />
              {parseError}
            </div>
          )}
          {parsed.length > 0 && !preview && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {parsed.length} rows parsed
              </span>
              <Button variant="primary" size="sm" onClick={runPreview} disabled={busy}>
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {t('stock.import.dryRun')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {preview && (
        <Card noPadding>
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm">
              <span className="text-emerald-700 font-semibold">{t('stock.import.summarySucceeded', { n: preview.succeeded })}</span>
              {preview.failed > 0 && (
                <span className="text-rose-700 font-semibold ml-3">
                  {t('stock.import.summaryFailed', { n: preview.failed })}
                </span>
              )}
              {preview.dryRun && (
                <span className="text-slate-500 dark:text-slate-400 ml-3">· {t('stock.import.dryRun')}</span>
              )}
            </div>
            {preview.dryRun && preview.failed < preview.total && (
              <Button variant="primary" size="sm" onClick={runCommit} disabled={busy}>
                {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {t('stock.import.commit', { n: preview.total - preview.failed })}
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.import.colSku')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.import.colChange')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.import.colCurrent')}</th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.import.colWouldBe')}</th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t('stock.import.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.results.slice(0, 200).map((r, i) => (
                  <tr key={`${r.sku}_${i}`} className={cn('border-b border-slate-100 dark:border-slate-800', r.error && 'bg-rose-50/40')}>
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">{r.sku}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums font-semibold', r.change > 0 ? 'text-emerald-700' : r.change < 0 ? 'text-rose-700' : 'text-slate-500 dark:text-slate-400')}>
                      {r.change > 0 ? '+' : ''}{r.change}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {r.currentTotal == null ? '—' : r.currentTotal}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {r.wouldBeTotal == null ? '—' : r.wouldBeTotal}
                    </td>
                    <td className="px-3 py-2">
                      {r.error ? (
                        <span title={r.error} className="inline-block">
                          <Badge variant="danger" size="sm">
                            <X size={10} className="mr-1" />
                            {r.error.slice(0, 40)}
                          </Badge>
                        </span>
                      ) : r.applied ? (
                        <Badge variant="success" size="sm">
                          <CheckCircle2 size={10} className="mr-1" />
                          applied
                        </Badge>
                      ) : (
                        <Badge variant="info" size="sm">
                          {t('stock.import.statusOk')}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
                {preview.results.length > 200 && (
                  <tr><td colSpan={5} className="px-3 py-2 text-sm text-slate-400 dark:text-slate-500 italic">+{preview.results.length - 200} more</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
