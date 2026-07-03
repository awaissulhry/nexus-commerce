'use client'

/**
 * ER1 — CSV import with dry-run diff (ported verbatim from _write-modals.tsx,
 * C1). Used by the Ad Manager.
 */
import { useEffect, useState } from 'react'
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
        <button type="button" className="h10-am-btn" onClick={props.onClose}>Close</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="h10-am-btn" onClick={() => run(true)} disabled={busy || !csvText.trim()}>{busy ? '…' : 'Dry-run'}</button>
        <button type="button" className="h10-am-btn primary" onClick={() => run(false)} disabled={busy || !diff || diff.every((d) => d.error) || applied != null}>Apply valid rows</button>
      </>}>
      <SandboxBanner mode={mode} />
      <textarea className="eb-textarea" rows={6} value={csvText} onChange={(e) => { setCsvText(e.target.value); setDiff(null); setApplied(null) }} placeholder="Paste CSV here…" />
      <Err msg={error} />
      {parseErrors.length > 0 && <ul className="eb-results">{parseErrors.map((p) => <li key={p.row} className="err">row {p.row}: {p.error}</li>)}</ul>}
      {diff && (
        <table className="eb-difftable">
          <thead><tr><th>#</th><th>Op</th><th>Target</th><th>From</th><th>To</th><th>Check</th></tr></thead>
          <tbody>
            {diff.map((r) => (
              <tr key={r.row}>
                <td>{r.row}</td><td>{r.kind}</td><td>{r.target}</td><td>{r.from}</td><td>{r.to}</td>
                <td>{r.error ? <span className="h10-pill warn">{r.error}</span> : r.note ? <span className="h10-pill warn">{r.note}</span> : <span className="h10-pill ok">ok</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {applied && <ul className="eb-results">{applied.map((a) => <li key={a.row} className={a.ok ? 'ok' : 'err'}>row {a.row}: {a.detail} ({a.mode})</li>)}</ul>}
    </H10Modal>
  )
}
