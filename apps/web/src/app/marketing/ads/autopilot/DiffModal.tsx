'use client'
import type { Staged } from '../_canvas/actions'
import { eur } from '../_canvas/format'

export function DiffModal({
  staged,
  dryRun,
  onToggleDryRun,
  onConfirm,
  onCancel,
  applying,
  result,
}: {
  staged: Staged
  dryRun: boolean
  onToggleDryRun: () => void
  onConfirm: () => void
  onCancel: () => void
  applying: boolean
  result: string | null
}) {
  const d = staged.blastRadius.budgetDeltaEur
  const deltaLabel = d === 0 ? '—' : `${d > 0 ? '+' : '−'}${eur(Math.abs(d))}/day`
  return (
    <div className="mc-scrim" onClick={onCancel}>
      <div className="mc-modal" role="dialog" aria-label="Review changes" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-h">Review changes</div>
        <div className="mc-blast">
          <b>{staged.blastRadius.count}</b> campaign{staged.blastRadius.count === 1 ? '' : 's'} · daily budget Δ <b>{deltaLabel}</b>
        </div>
        <div className="mc-difflist">
          {staged.changes.map((c) => (
            <div className="mc-diffrow" key={c.id + c.label}>
              <span className="mc-diff-name" title={c.name}>
                {c.name}
              </span>
              <span className="mc-diff-label">{c.label}</span>
              <span className="mc-diff-change">
                <span className="mc-diff-before">{c.before}</span> → <span className="mc-diff-after">{c.after}</span>
              </span>
            </div>
          ))}
        </div>
        <label className="mc-dry">
          <input type="checkbox" checked={dryRun} onChange={onToggleDryRun} /> Dry-run (preview only — nothing is applied)
        </label>
        <div className="mc-modal-note">
          {dryRun
            ? 'Dry-run: Confirm previews only — no changes are sent.'
            : 'Live: changes route through the write-gate; only allowlisted campaigns reach Amazon.'}
        </div>
        {result && <div className="mc-modal-result">{result}</div>}
        <div className="mc-modal-foot">
          <button type="button" className="mc-actbtn ghost" onClick={onCancel}>
            Close
          </button>
          <button type="button" className="mc-actbtn primary" onClick={onConfirm} disabled={applying}>
            {applying ? 'Applying…' : dryRun ? 'Preview' : 'Apply changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
