'use client'

import { useState } from 'react'
import { Ban, StickyNote } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useLocale, useScopedT } from '../../../i18n/provider'
import { NOTE_MAX, type Phrase } from '../model'
import type { ActsDialog, WorkOrderActsActions, WorkOrderActsModel } from '../use-work-order-acts'
import type { OrderHoldDialog as OrderHoldDialogState } from '../use-work-order-acts' // F-OO-108
import './work-order-acts.css'
// F-OP-114: the ONE Put on hold / Release the hold / Release (moved here from the work order's pages).
import { HoldDialog, LiftHoldDialog, type HoldParts } from './HoldDialog'
import { ReleaseDialog } from './ReleaseDialog'
// F-OP-115: Split… (the every-shift page's dialog as it is), Close… · Reopen… (the close's parts as they are), Cancel… (below).
import { WithMessages } from '../../../../record-panels/i18n'
import { SplitDialog } from '../../../../areas/production/work-orders/every-shift/view/SplitDialog'
import { SHIFT_NAMESPACE } from '../../../../areas/production/work-orders/every-shift/model'
import { CloseParts } from '../../../../areas/production/work-orders/close/view/CloseParts'
import { cancelHeld } from '../model'

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
 * F-OP-115: Split… (a draft: SplitDialog as it is), Close… · Reopen… (CloseParts as they are) and Cancel… (the reason; what the cancel
 * check found: the pieces cut refuse it in the API's words — "{n} pieces are cut: lower the work order to the cut instead", no outcome
 * to pick (R-16) — the stock issued to it, the workshops it is at). Each brings its catalogues, so it draws on any page.
 */
export function WorkOrderActsDialogs({ model, actions }: { model: WorkOrderActsModel; actions?: WorkOrderActsActions }) {
  if (!model.dialog && !model.holdOrder /* F-OO-108 */) return null
  return (
    <WithMessages namespaces={DIALOG_NAMESPACES}>
      <ActsDialogs model={model} actions={actions} />
    </WithMessages>
  )
}

/** F-OP-115: the catalogues the row's dialogs speak (the order page's, the production lane's). */
const DIALOG_NAMESPACES = ['orders', 'production', 'production-work-orders', SHIFT_NAMESPACE] as const

function ActsDialogs({ model, actions }: { model: WorkOrderActsModel; actions?: WorkOrderActsActions }) {
  if (model.holdOrder) return <OrderHoldDialog model={model} open={model.holdOrder} actions={actions} /> // F-OO-108
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
    // ---- F-OP-115 ----
    case 'split':
      return dialog.workOrder.value && model.split ? <SplitDialog workOrder={dialog.workOrder.value} model={model.split} actions={actions?.split} /> : <ReadingDialog dialog={dialog} actions={actions} />
    case 'close':
    case 'reopen':
      return dialog.workOrder.value && model.close.dialog ? <CloseParts workOrder={dialog.workOrder.value} model={model.close} actions={actions?.close} /> : <ReadingDialog dialog={dialog} actions={actions} />
    case 'cancel':
      return <CancelDialog dialog={dialog} actions={actions} />
    // ---- end F-OP-115
    default:
      return null
  }
}

/**
 * F-OP-115 (R-16) — Cancel… from a work-order row: the reason, and what the cancel check found. With pieces cut the API refuses it in
 * its own words, said here before anything is sent (and Cancel held with them): the way out is to lower the work order to the cut.
 */
function CancelDialog({ dialog, actions }: { dialog: ActsDialog; actions?: WorkOrderActsActions }) {
  const t = useScopedT(NS)
  const locale = useLocale()
  const [reason, setReason] = useState('')
  const check = dialog.cancelCheck?.value ?? null
  const waits = cancelHeld(check, reason, dialog.busy || !dialog.workOrder.value, locale)
  const held = typeof waits === 'string' ? waits : say(t, waits)
  const go = held ? null : () => actions?.onCancelWorkOrder?.(reason)
  const started = (check?.status ?? dialog.workOrder.value?.status ?? 'DRAFT') !== 'DRAFT'
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('production:cancel.title', { number: dialog.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()} heldReason={dialog.busy ? t('production:held.busy') : null}>
            {t('production:cancel.keep')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('production:cancel.go')}
          </Button>
        </>
      }
    >
      <div className="fw-woa-dialog" onKeyDown={submitKeys(go)}>
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem) ?? ''} />}
        <p>{t(started ? 'production:cancel.bodyStarted' : 'production:cancel.bodyDraft')}</p>
        {!check ? (
          dialog.cancelCheck?.problem ? (
            <EmptyState
              title={t('wo.cancel.check')}
              description={t(`production:${dialog.cancelCheck.problem}`)}
              action={
                <Button size="sm" onClick={() => actions?.onRetryDialog?.()}>
                  {t('production:common.retry')}
                </Button>
              }
            />
          ) : (
            <p className="fw-woa-hint" role="status">
              <Spinner size={12} /> {t('production:held.checking')}
            </p>
          )
        ) : check.refusal ? (
          // R-16: no outcome picker — the API's own words, which name the way out.
          <Banner tone="warning" title={locale === 'it' ? check.refusal.it : check.refusal.en} />
        ) : (
          <Field label={t('production:cancel.reason')} required>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
          </Field>
        )}
        {check && (check.issued.length > 0 || check.atWorkshop.length > 0) && (
          <ul className="fw-woa-list">
            {check.issued.length > 0 && <li>{t('wo.cancel.issued', { items: check.issued.map((row) => `${row.label} ${row.quantity}${row.baseUom ? ` ${row.baseUom}` : ''}`).join(', ') })}</li>}
            {check.atWorkshop.length > 0 && <li>{t('wo.cancel.atWorkshop', { numbers: check.atWorkshop.map((row) => row.number).join(', ') })}</li>}
          </ul>
        )}
      </div>
    </Modal>
  )
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

// ---- F-OO-108 (order overview §1.4; B-OO-005, review F13, F16): "Hold the whole order…" — the ONE Hold dialog on the plan -----------
/**
 * The sales order's "Hold the whole order…": the shared Hold dialog (both kinds, each with its right) on the work orders the domain's
 * plan holds, and under them what it leaves out, each with why — a work order shared with other customers (held on its own page), one
 * held already or done (its words), those this reader does not reach (counted, never named), the made-to-measure units (each held on
 * its own page). A production hold sends every version read (all or none); when the plan holds none any more, Put on hold says why.
 */
function OrderHoldDialog({ model, open, actions }: { model: WorkOrderActsModel; open: OrderHoldDialogState; actions?: WorkOrderActsActions }) {
  const t = useScopedT(NS)
  const locale = useLocale()
  const { plan } = open
  const words = (entry: { readonly it: string; readonly en: string }) => (locale === 'it' ? entry.it : entry.en)
  const parts: HoldParts = { reasons: model.reasons, can: { holdsPlace: model.can.qualityHold, productionHold: plan.ids.length > 0 }, busy: open.busy, problem: open.problem }
  const notes = (
    <>
      {plan.left.length > 0 && (
        <ul className="fw-woa-list" aria-label={t('where.hold.leftTitle')}>
          {plan.left.map((entry) => (
            <li key={entry.id}>{t('where.hold.left', { number: entry.number, words: words(entry.words) })}</li>
          ))}
        </ul>
      )}
      {plan.notReached > 0 && <p className="fw-woa-hint">{t('where.hold.notReached', { count: plan.notReached })}</p>}
      {open.units > 0 && <p className="fw-woa-hint">{t('where.hold.units', { count: open.units })}</p>}
    </>
  )
  return <HoldDialog numbers={[...plan.numbers]} workOrderIds={[...plan.ids]} parts={parts} onCancel={() => actions?.onCloseOrderHold?.()} onPlace={actions?.onPlaceOrderHold} notes={notes} heldBy={plan.ids.length === 0 && plan.held ? words(plan.held.words) : null} />
}
// ---- end F-OO-108
