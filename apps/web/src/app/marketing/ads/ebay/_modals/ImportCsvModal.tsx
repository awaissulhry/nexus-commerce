'use client'

/**
 * ER1 — CSV import with dry-run diff (ported verbatim from _write-modals.tsx,
 * C1). Used by the Ad Manager.
 */
import { useEffect, useState } from 'react'
import { Button, Pill, Textarea } from '@/design-system/primitives'
import { DataGrid } from '@/design-system/components'
import { H10Modal, Err } from '../_lib/modal'
import { postEbayAds, useWriteMode, SandboxBanner } from '../_lib'

interface CsvDiffRow { row: number; kind: string; target: string; from: string; to: string; note: string | null; error: string | null }

export function ImportCsvModal(props: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const mode = useWriteMode()
  const [csvText, setCsvText] = useState('')
  const [diff, setDiff] = useState<CsvDiffRow[] | null>(null)
  const [parseErrors, setParseErrors] = useState<Array<{ row: number; error: string }>>([])
  const [applied, setApplied] = useState<Array<{ row: number; ok: boolean; mode: string; detail: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (props.open) { setDiff(null); setApplied(null); setError(null) } }, [props.open])

  const run = async (dryRun: boolean) => {
    setBusy(true); setError(null)
    try {
      const out = await postEbayAds<{ diff: CsvDiffRow[]; parseErrors: Array<{ row: number; error: string }>; applied: Array<{ row: number; ok: boolean; mode: string; detail: string }> | null }>('/import', { csv: csvText, dryRun })
      setDiff(out.diff); setParseErrors(out.parseErrors); setApplied(out.applied)
      if (!dryRun) props.onDone?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <H10Modal open={props.open} onClose={props.onClose} wide title="Import ad operations (CSV)"
      subtitle="Columns: entity, campaign_id, listing_id, ad_rate_pct, keyword_id, bid_eur, daily_budget_eur, action(add|remove|pause|resume|end). Start from Export Data to get the exact shape."
      footer={<>
    <Button onClick={props.onClose}>Close</Button>
        <span style={{ flex: 1 }} />
    <Button onClick={() => run(true)} disabled={busy || !csvText.trim()}>{busy ? '…' : 'Dry-run'}</Button>
    <Button variant="primary" onClick={() => run(false)} disabled={busy || !diff || diff.every((d) => d.error) || applied != null}>Apply valid rows</Button>
      </>}>
      <SandboxBanner mode={mode} />
      <Textarea value={csvText} onChange={(e) => { setCsvText(e.target.value); setDiff(null); setApplied(null) }} placeholder="Paste CSV here…" />
      <Err msg={error} />
      {parseErrors.length > 0 && <ul className="eb-results">{parseErrors.map((p) => <li key={p.row} className="err">row {p.row}: {p.error}</li>)}</ul>}
      {diff && (
        <DataGrid<CsvDiffRow>
          className="eb-difftable"
          size="sm"
          rows={diff}
          rowKey={(r) => String(r.row)}
          maxHeight={320}
          columns={[
            { key: 'row', label: '#', align: 'right', sortable: true, sortValue: (r) => r.row, render: (r) => r.row },
            { key: 'kind', label: 'Op', sortable: true, sortValue: (r) => r.kind, render: (r) => r.kind },
            { key: 'target', label: 'Target', sortable: true, sortValue: (r) => r.target, render: (r) => r.target },
            { key: 'from', label: 'From', render: (r) => r.from },
            { key: 'to', label: 'To', render: (r) => r.to },
            { key: 'check', label: 'Check', render: (r) => (r.error ? <Pill tone="warning">{r.error}</Pill> : r.note ? <Pill tone="warning">{r.note}</Pill> : <Pill tone="success">ok</Pill>) },
          ]}
        />
      )}
      {applied && <ul className="eb-results">{applied.map((a) => <li key={a.row} className={a.ok ? 'ok' : 'err'}>row {a.row}: {a.detail} ({a.mode})</li>)}</ul>}
    </H10Modal>
  )
}
