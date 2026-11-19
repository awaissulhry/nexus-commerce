'use client'

import { useState } from 'react'
import { StickyNote } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useScopedT } from '../../../i18n/provider'
import { NOTE_MAX, type Phrase } from '../model'
import type { ActsDialog, WorkOrderActsActions, WorkOrderActsModel } from '../use-work-order-acts'
import './work-order-acts.css'
// F-OP-114: the ONE Put on hold / Release the hold / Release (moved here from the work order's pages).
import { HoldDialog, LiftHoldDialog, type HoldParts } from './HoldDialog'
import { ReleaseDialog } from './ReleaseDialog'

/** Words are the order page's (`orders` wo.*); a phrase may name another catalogue (`production:error.changed`). */
const NS = 'orders'

/** ⌘↵ in a dialog runs its main act when it may go (no form element: Enter in a one-line field sends nothing). */
const submitKeys = (go: (() => void) | null) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
    event.preventDefault()
    go()
  }
}

const say = (t: ReturnType<typeof useScopedT>, phrase: Phrase | null): string | null => (phrase ? t(phrase.key, phrase.params) : null)

/**
 * F-OP-113 — the dialogs a work-order row's ⋯ opens on a page that is not the work order's own (the sales order's Production tab):
 * each on the work order read afresh (its version), Esc closes, the focus returns to the opener (DS Modal), a refusal is said inside
 * it and what was typed stays. Note…: the work order's note (printed on its sheet for the floor; never the customer's to read).
 * F-OP-114: Hold… (the reason the floor reads, what the customer reads shown before it is placed, the office's note), Lift… (its
 * standing plain hold, with why) and Release… (the release check in the dialog, each condition in words; a short material only with
 * the planner's reason; the customer's credit and the compliance gate said in the refusal).
 */
export function WorkOrderActsDialogs({ model, actions }: { model: WorkOrderActsModel; actions?: WorkOrderActsActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onCloseDialog?.()
  // ---- F-OP-114 ----
  const parts: HoldParts = {
    reasons: model.reasons,
    can: { holdsPlace: model.can.qualityHold, productionHold: dialog.holdRight ?? false },
    // While the work order is read afresh (its version), the act waits.
    busy: dialog.busy || !dialog.workOrder.value,
    problem: dialog.problem,
    productionHolds: dialog.holds ?? null,
  }
  if (dialog.workOrder.problem && dialog.kind !== 'note') return <ReadingDialog dialog={dialog} actions={actions} />
  // ---- end F-OP-114
  switch (dialog.kind) {
    case 'note':
      return <NoteDialog dialog={dialog} actions={actions} />
    // ---- F-OP-114 ----
    case 'hold':
      return <HoldDialog numbers={[dialog.number]} workOrderIds={[dialog.workOrderId]} parts={parts} onCancel={close} onPlace={actions?.onPlaceHold} />
    case 'lift':
      return <LiftHoldDialog holdId={null} parts={parts} onCancel={close} onLift={actions?.onLiftHold} onRetry={() => actions?.onRetryDialog?.()} />
    case 'release':
      return dialog.workOrder.value ? (
        <ReleaseDialog workOrder={dialog.workOrder.value} check={dialog.check ?? { value: null, problem: null }} busy={dialog.busy} problem={dialog.problem} listChecks onCancel={close} onRelease={actions?.onRelease} onRetry={() => actions?.onRetryDialog?.()} />
      ) : (
        <ReadingDialog dialog={dialog} actions={actions} />
      )
    // ---- end F-OP-114
    default:
      return null
  }
}

/** F-OP-114: the work order being read afresh before its dialog can act (or why it could not be read, with Try again). */
function ReadingDialog({ dialog, actions }: { dialog: ActsDialog; actions?: WorkOrderActsActions }) {
  const t = useScopedT(NS)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={dialog.number}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('production:common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-woa-dialog">
        <Reading dialog={dialog} actions={actions} />
      </div>
    </Modal>
  )
}

/** While the work order is read afresh: reading, or why it could not be read with Try again. */
function Reading({ dialog, actions }: { dialog: ActsDialog; actions?: WorkOrderActsActions }) {
  const t = useScopedT(NS)
  if (dialog.workOrder.problem)
    return (
      <EmptyState
        title={t('wo.readFailed', { number: dialog.number })}
        description={t(`production:${dialog.workOrder.problem}`)}
        action={
          <Button size="sm" onClick={() => actions?.onRetryDialog?.()}>
            {t('production:common.retry')}
          </Button>
        }
      />
    )
  return (
    <p className="fw-woa-hint" role="status">
      <Spinner size={12} /> {t('wo.reading', { number: dialog.number })}
    </p>
  )
}

function NoteDialog({ dialog, actions }: { dialog: ActsDialog; actions?: WorkOrderActsActions }) {
  const t = useScopedT(NS)
  const workOrder = dialog.workOrder.value
  const [note, setNote] = useState<string | null>(null)
  const text = note ?? workOrder?.note ?? ''
  const unchanged = (workOrder?.note ?? '') === text.trim()
  const held = !workOrder ? t('wo.readingShort') : dialog.busy ? t('production:held.busy') : unchanged ? t('production:held.nothingChanged') : null
  const go = held ? null : () => actions?.onSaveNote?.(text)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('wo.note.title', { number: dialog.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()} heldReason={dialog.busy ? t('production:held.busy') : null}>
            {t('production:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : <StickyNote size={13} aria-hidden />} {t('wo.note.save')}
          </Button>
        </>
      }
    >
      <div className="fw-woa-dialog" onKeyDown={submitKeys(go)}>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        {!workOrder ? (
          <Reading dialog={dialog} actions={actions} />
        ) : (
          <Field label={t('wo.note.label')} hint={t('wo.note.hint')}>
            <Textarea value={text} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={NOTE_MAX} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
