'use client'

/**
 * SCV.3 — dedicated Sync Control Excel bar (Export + Import w/ preview-diff).
 *
 * Export downloads a 2-sheet workbook (Listings + Routes) scoped to the
 * current filters (or one product). Import uploads the edited workbook, shows
 * a preview of exactly what will change (FBA/invalid rows listed as skipped),
 * and applies only on confirm. A control sheet never writes pool quantity.
 */

import { useRef, useState } from 'react'
import { Download, Upload, X } from 'lucide-react'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

const API = getBackendUrl()

interface Change { lane: string; key: string; field: string; from: string; to: string }
interface Skip { key: string; reason: string }
interface Preview { changes: Change[]; skipped: Skip[]; changeCount: number; skipCount: number }

interface Props {
  /** Query string (without leading ?) scoping the export, e.g. "masterId=abc" or "channel=EBAY". */
  exportQuery?: string
  notify: (msg: string) => void
  onApplied: () => void
}

export default function SyncExcelBar({ exportQuery, notify, onApplied }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  const exportXlsx = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${API}/api/stock/sync-control/export${exportQuery ? `?${exportQuery}` : ''}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`export ${res.status}`)
      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `sync-control-export.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(href)
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const onPick = async (file: File) => {
    setBusy(true)
    setPendingFile(file)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API}/api/stock/sync-control/import/preview`, { method: 'POST', credentials: 'include', body: fd })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`)
      setPreview(d)
    } catch (e) {
      notify(`Import preview failed: ${e instanceof Error ? e.message : String(e)}`)
      setPendingFile(null)
    } finally {
      setBusy(false)
    }
  }

  const applyImport = async () => {
    if (!pendingFile) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', pendingFile)
      const res = await fetch(`${API}/api/stock/sync-control/import/apply`, { method: 'POST', credentials: 'include', body: fd })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? `HTTP ${res.status}`)
      notify(`Import applied: ${d.applied} change(s)${d.skipped?.length ? `, ${d.skipped.length} skipped` : ''}${d.recascadeQueued ? `, recascading ${d.recascadeQueued} product(s)` : ''}`)
      emitInvalidation({ type: 'listing.updated', meta: { source: 'sync-control-excel-import', applied: d.applied } })
      setPreview(null)
      setPendingFile(null)
      onApplied()
    } catch (e) {
      notify(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" disabled={busy} onClick={() => void exportXlsx()}><Download size={13} /> Export</Button>
      <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={13} /> Import</Button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f); e.target.value = '' }}
      />

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!busy) { setPreview(null); setPendingFile(null) } }}>
          <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div>
                <div className="text-sm font-semibold">Review import — {preview.changeCount} change{preview.changeCount === 1 ? '' : 's'}</div>
                <div className="text-xs text-zinc-500">{pendingFile?.name} · {preview.skipCount} row(s) skipped</div>
              </div>
              <button type="button" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => { setPreview(null); setPendingFile(null) }} aria-label="Close"><X size={18} /></button>
            </div>

            <div className="max-h-[55vh] overflow-auto">
              {preview.changes.length === 0 ? (
                <div className="px-4 py-6 text-sm text-zinc-500">No changes detected — the sheet matches the current state (or only had blank/locked rows).</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
                    <tr><th className="px-3 py-2">Target</th><th className="px-3 py-2">Field</th><th className="px-3 py-2">From</th><th className="px-3 py-2">To</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {preview.changes.map((c, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5 font-mono text-xs">{c.key}</td>
                        <td className="px-3 py-1.5 text-xs">{c.field}</td>
                        <td className="px-3 py-1.5 text-xs text-zinc-500">{c.from || '—'}</td>
                        <td className="px-3 py-1.5 text-xs font-medium">{c.to || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.skipped.length > 0 && (
                <div className="border-t border-zinc-200 px-4 py-2 dark:border-zinc-800">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Skipped ({preview.skipped.length})</div>
                  <ul className="space-y-0.5 text-xs text-zinc-500">
                    {preview.skipped.slice(0, 30).map((s, i) => <li key={i}><span className="font-mono">{s.key}</span> — {s.reason}</li>)}
                    {preview.skipped.length > 30 && <li>…and {preview.skipped.length - 30} more</li>}
                  </ul>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <Button size="sm" disabled={busy} onClick={() => { setPreview(null); setPendingFile(null) }}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={busy || preview.changeCount === 0} onClick={() => void applyImport()}>
                Apply {preview.changeCount} change{preview.changeCount === 1 ? '' : 's'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
