'use client'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import type { Staged } from '../_canvas/actions'
import { eur } from '../_canvas/format'

/**
 * DS alignment (2026-08-25): this was a hand-built dialog — its own scrim, its own 540px
 * panel, its own header and footer rows, and no Esc handling, no focus handling and no
 * `aria-modal`. It is now the design system's `Modal` at `md` (560px, the nearest step on the
 * scale to the 540px it computed at), which brings all three for free, plus the header close
 * button this dialog never had.
 *
 * The dry-run switch is the DS `Checkbox`; the two footer actions are DS `Button`s. The blast
 * radius, the diff list and the two notes are content, not chrome, and keep their own styles.
 */
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
    <Modal
      open
      onClose={onCancel}
      title="Review changes"
      size="md"
      footer={
        <>
          <Button onClick={onCancel}>Close</Button>
          <Button variant="primary" onClick={onConfirm} disabled={applying}>
            {applying ? 'Applying…' : dryRun ? 'Preview' : 'Apply changes'}
          </Button>
        </>
      }
    >
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
      <Checkbox
        className="mc-dry"
        checked={dryRun}
        onChange={onToggleDryRun}
        label="Dry-run (preview only — nothing is applied)"
      />
      <div className="mc-modal-note">
        {dryRun
          ? 'Dry-run: Confirm previews only — no changes are sent.'
          : 'Live: changes route through the write-gate; only allowlisted campaigns reach Amazon.'}
      </div>
      {result && <div className="mc-modal-result">{result}</div>}
    </Modal>
  )
}
