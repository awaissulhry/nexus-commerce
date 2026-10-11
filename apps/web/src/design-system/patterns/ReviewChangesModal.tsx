'use client'

/**
 * ReviewChangesModal — the ONE review of a draft before it is saved (bid page DS lane, 2026-10-10). The Owner's liked
 * pattern: one summary line, one table old → new, one primary button that counts what it does, then Done with Undo.
 * Words and rules: `reviewChangesModel.ts`.
 *
 * The dialog does not save: the host runs the save and tells it the state — `reading` (re-reading today's values so
 * "Now" is true; Save waits), `failed` (that read failed; Save stays held, Try again), `ready` (with any `conflicts`:
 * values that changed since the draft was made), `saving`, `done` (a result per change). A held Save is never
 * `disabled`: it keeps its focus and says why (tooltip + description). A change that lets automation do more needs the
 * one tick, which starts unticked every time the dialog opens. While saving, Esc and the backdrop do nothing.
 * Opened from inside another dialog (a row's DetailModal) it stacks above it; when it closes the focus goes back to the
 * control that opened it (polish round 2, audit M10). The Done line counts each result under its verb (S2). On Done the
 * focus moves to Undo, else Done (R5); a Result that would only repeat the New column reads "Done".
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button, Checkbox, Tag, Tooltip } from '../primitives'
import { Banner } from '../components/Banner'
import { MetricStrip, type Metric } from '../components/MetricStrip'
import { Modal, type ModalProps } from '../components/Modal'
import { SummaryTable } from '../components/SummaryTable'
import {
  ackWords, doneSummary, raiseCount, resultWords, reviewColumns, reviewNote, reviewTitle, saveButtonWords, saveHeldReason,
  type ReviewChange, type ReviewState,
} from './reviewChangesModel'

export interface ReviewChangesModalProps {
  open: boolean
  onClose: () => void
  changes: readonly ReviewChange[]
  /** Default `{ phase: 'ready' }`. */
  state?: ReviewState
  /** Default "Review 3 changes". */
  title?: string
  /** The one line under the title: where this lands ("Nexus only: never sent to Amazon."). */
  summary?: ReactNode
  /** Optional tiles above the table (the import's Changes · Products · Problems). */
  metrics?: Metric[]
  /** Problems that block Save, one sentence each. */
  problems?: readonly string[]
  /** Replaces the default acknowledgement sentence. */
  ackLabel?: string
  /** Replaces "Save 3 changes" (say what happens: "Create rule at Watch"). */
  saveLabel?: string
  onSave: () => void
  /** The re-read failed: "Try again". */
  onRetry?: () => void
  /** Done screen: put the saved values back. */
  onUndo?: () => void
  undoing?: boolean
  /** Done screen: more buttons before Done ("Open the rule"). */
  doneActions?: ReactNode
  /** Done (default: `onClose`). */
  onDone?: () => void
  size?: 'lg' | 'xl' | 'xxl'
  /** The verb the Done line counts a result under when the result names none: "archived" for an archive ("1 archived").
   *  Default "saved". A result whose words start "Undone" / "Archived" / "Restored" counts as that by itself. */
  doneVerb?: string
  /** See `Modal`: default the element that opened the review (inside a detail modal, the detail gets it back). */
  returnFocusTo?: ModalProps['returnFocusTo']
}

export function ReviewChangesModal({
  open, onClose, changes, state = { phase: 'ready' }, title, summary, metrics, problems = [], ackLabel, saveLabel,
  onSave, onRetry, onUndo, undoing = false, doneActions, onDone, size = 'lg', doneVerb = 'saved', returnFocusTo,
}: ReviewChangesModalProps) {
  const [ack, setAck] = useState(false)
  useEffect(() => { if (open) setAck(false) }, [open])

  // Done: the focus goes to Undo, else to Done — never left on the page behind (audit R5). Once Undo has run and its
  // button is gone, to Done.
  const done = state.phase === 'done'
  const hasUndo = !!onUndo
  const undoRef = useRef<HTMLButtonElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open || !done) return
    const id = requestAnimationFrame(() => (undoRef.current ?? doneRef.current)?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, done, hasUndo])

  const count = changes.length
  const raises = raiseCount(changes)
  const saving = state.phase === 'saving'
  const held = saveHeldReason({ state, count, problems: problems.length, raises, ack })
  const result = done ? doneSummary(changes, state.results, doneVerb) : null
  const columns = reviewColumns(changes, done)
  const hasWhere = columns[0] === 'Where'
  const hasLast = columns[columns.length - 1] !== 'New'
  const rows = changes.map((c) => {
    const r = done ? state.results[c.id] : undefined
    const last = done ? (r ? <Tag tone={r.ok ? 'success' : 'danger'}>{resultWords(c, r)}</Tag> : '—') : reviewNote(c)
    return { id: c.id, cells: [...(hasWhere ? [c.where ?? ''] : []), c.what, c.now, c.next, ...(hasLast ? [last] : [])] }
  })

  const save = (
    <Button variant="primary" aria-disabled={held ? true : undefined} aria-description={held ?? undefined} onClick={held ? undefined : onSave}>
      {saveButtonWords(state, count, saveLabel)}
    </Button>
  )
  const footer = done ? (
    <>
      {onUndo && <Button ref={undoRef} onClick={undoing ? undefined : onUndo} aria-disabled={undoing || undefined}>{undoing ? 'Undoing…' : 'Undo'}</Button>}
      {doneActions}
      <span className="grow" />
      <Button ref={doneRef} variant="primary" onClick={onDone ?? onClose}>Done</Button>
    </>
  ) : (
    <>
      <span className="grow" />
      <Button onClick={saving ? undefined : onClose} aria-disabled={saving || undefined}>Cancel</Button>
      {held && !saving ? <Tooltip label={held} portal>{save}</Tooltip> : save}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={saving || undoing ? () => {} : done ? (onDone ?? onClose) : onClose}
      size={size}
      returnFocusTo={returnFocusTo}
      title={done ? 'Done' : title ?? reviewTitle(count)}
      subtitle={summary}
      footer={footer}
    >
      <div className="nds-review">
        {result && <p className={`nds-review-line ${result.tone}`} role="status">{result.line}</p>}
        {state.phase === 'reading' && <p className="nds-review-line" role="status">Reading today&apos;s values, so “Now” is true. Save waits for it.</p>}
        {state.phase === 'failed' && (
          <Banner tone="danger" title="Save is held" action={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>
            {state.error} Nexus reads them again before it saves, so it never overwrites a value it has not shown you.
          </Banner>
        )}
        {state.phase === 'ready' && !!state.conflicts?.length && (
          <Banner tone="warning" title="Changed since you opened this page">
            <ul className="nds-review-list">{state.conflicts.map((c, i) => <li key={i}>{c.label}: was {c.was}, now {c.now}</li>)}</ul>
          </Banner>
        )}
        {!done && problems.length > 0 && (
          <Banner tone="danger" title="Fix these before you save">
            <ul className="nds-review-list">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          </Banner>
        )}
        {!done && metrics && metrics.length > 0 && <MetricStrip metrics={metrics} />}
        <div className="nds-review-table">
          <SummaryTable label={done ? `What was ${doneVerb}` : title ?? reviewTitle(count)} columns={columns} rows={rows} />
        </div>
        {!done && raises > 0 && (
          <Checkbox checked={ack} disabled={saving} onChange={(e) => setAck(e.target.checked)} label={ackLabel ?? ackWords(raises)} />
        )}
      </div>
    </Modal>
  )
}
