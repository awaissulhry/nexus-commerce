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
 * focus moves to Undo, else Done (R5); a Result that would only repeat the New column reads "Done". An optional `lead`
 * is a form above the table (the host recomputes the table as it is filled in) and `leadHeld` holds Save while that
 * form is not filled in, in the host's words.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button, Tooltip } from '../primitives'
import { type Metric } from '../components/MetricStrip'
import { Modal, type ModalProps } from '../components/Modal'
import { ReviewChangesPanel, type ReviewChangesPanelProps } from './ReviewChangesPanel'
import { raiseCount, reviewTitle, saveButtonWords, saveHeldReason, type ReviewState } from './reviewChangesModel'
import type { ReviewGroup, ReviewPanelChange } from './reviewChangesPanelModel'

export interface ReviewChangesModalProps {
  open: boolean
  onClose: () => void
  /** A `ReviewChange`; with `groups`, each may name its tab in `group`. */
  changes: readonly ReviewPanelChange[]
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
  /** `detail` = the DS detail size: a full-screen sheet on a phone, like the Harvest window (passed to `Modal`). */
  size?: 'lg' | 'xl' | 'xxl' | 'detail'
  /** The verb the Done line counts a result under when the result names none: "archived" for an archive ("1 archived").
   *  Default "saved". A result whose words start "Undone" / "Archived" / "Restored" counts as that by itself. */
  doneVerb?: string
  /** See `Modal`: default the element that opened the review (inside a detail modal, the detail gets it back). */
  returnFocusTo?: ModalProps['returnFocusTo']
  /** The table in tabs ("Keywords", "Negatives"); each change names its tab in `group`. Passed to `ReviewChangesPanel`
   *  (Keyword Harvest polish, 2026-10-11: the Terms review had to hand-build Modal + panel to get them). */
  groups?: readonly ReviewGroup[]
  /** The host's own Done line when counting the results cannot say it ("Asked · waits for approval"). Passed through. */
  doneLine?: ReviewChangesPanelProps['doneLine']
  /** A form above the table (a bulk change's How and value, Bid page 2026-10-12): the host recomputes `changes` as it
   *  is filled in, so the table follows each key. Not shown once done. Passed to the panel. */
  lead?: ReactNode
  /** Why Save waits on that form, in the host's words ("Type a bid"): the held Save says it like any other reason. */
  leadHeld?: string | null
}

export function ReviewChangesModal({
  open, onClose, changes, state = { phase: 'ready' }, title, summary, metrics, problems = [], ackLabel, saveLabel,
  onSave, onRetry, onUndo, undoing = false, doneActions, onDone, size = 'lg', doneVerb = 'saved', returnFocusTo, groups, doneLine,
  lead, leadHeld,
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
  const held = saveHeldReason({ state, count, problems: problems.length, raises, ack, lead: leadHeld })

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
      {/* The body is the shared panel (lane HTO, 2026-10-11): a window whose review is a step renders the same panel. */}
      <ReviewChangesPanel
        changes={changes} state={state} label={title ?? reviewTitle(count)} metrics={metrics} problems={problems}
        ackLabel={ackLabel} ack={ack} onAckChange={setAck} onRetry={onRetry} doneVerb={doneVerb} groups={groups} doneLine={doneLine}
        lead={lead}
      />
    </Modal>
  )
}
