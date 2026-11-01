'use client'

import { useId } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ddtProblems, MOVE_OF, noteKeyOf } from '../../model'
import type { RepairActions, RepairDialog, RepairModel } from '../../view-model'
import { DdtFields } from '../../view/DdtFields'
import { say, useWords } from '../../view/parts'

/**
 * The repair record's dialogs (SCR-112): Receive the garment (the customer's DDT), a stage move with the note it needs
 * (estimated: what was estimated; approved: how the customer approved; back into repair: what still needs doing), Make
 * repair work order (Production's routing steps of the garment's style, each available at the site or said why not),
 * Send back (its DDT, reason repair, issued in the same step; or the live DDT issued under Shipping; unrepaired needs
 * a note) and Cancel. Each primary button is held with its reason.
 */
export function RepairDialogs({ model, actions }: { model: RepairModel; actions?: RepairActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'receive':
      return <ReceiveDialog model={model} dialog={dialog} actions={actions} />
    case 'move':
      return <MoveDialog model={model} dialog={dialog} actions={actions} />
    case 'workOrder':
      return <WorkOrderDialog model={model} dialog={dialog} actions={actions} />
    case 'ship':
      return <ShipDialog model={model} dialog={dialog} actions={actions} />
    case 'cancel':
      return <CancelDialog model={model} dialog={dialog} actions={actions} />
  }
}

function Footer({ held, busy, label, actions }: { held: string | null; busy: boolean; label: string; actions?: RepairActions }) {
  const t = useWords()
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
        {t('quality:common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialogSubmit?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

function ReceiveDialog({ model, dialog, actions }: { model: RepairModel; dialog: Extract<RepairDialog, { kind: 'receive' }>; actions?: RepairActions }) {
  const t = useWords()
  const ids = { ddt: useId(), date: useId(), note: useId() }
  const set = (patch: Partial<typeof dialog>) => actions?.onDialog?.({ ...dialog, ...patch })
  const held = model.dialogBusy ? t('quality:common.working') : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('repairReceive.title', { number: model.repair.number })} size="md" footer={<Footer held={held} busy={model.dialogBusy} label={t('repairReceive.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t('repairReceive.body')}</p>
        <div className="fw-q-form-two">
          <Field label={t('newRepair.ddt')} hint={t('repairReceive.ddtHint')} htmlFor={ids.ddt}>
            <Input id={ids.ddt} value={dialog.ddtNumber} onChange={(event) => set({ ddtNumber: event.target.value })} />
          </Field>
          <Field label={t('newRepair.ddtDate')} htmlFor={ids.date}>
            <Input id={ids.date} type="date" max={model.today} value={dialog.ddtDate} onChange={(event) => set({ ddtDate: event.target.value })} />
          </Field>
        </div>
        <Field label={t('receive.note')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={dialog.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function MoveDialog({ model, dialog, actions }: { model: RepairModel; dialog: Extract<RepairDialog, { kind: 'move' }>; actions?: RepairActions }) {
  const t = useWords()
  const id = useId()
  const to = MOVE_OF[dialog.action]
  const noteKey = noteKeyOf(model.repair.stage, to)
  const held = model.dialogBusy ? t('quality:common.working') : noteKey && !dialog.note.trim() ? t('move.noteNeeded') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`move.title.${dialog.action}`, { number: model.repair.number })}
      size="md"
      footer={<Footer held={held} busy={model.dialogBusy} label={t(`repair.action.${dialog.action}`)} actions={actions} />}
    >
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t(`move.body.${dialog.action}`)}</p>
        <Field label={t('move.noteLabel')} required={!!noteKey} hint={noteKey ? t(noteKey) : undefined} htmlFor={id}>
          <Textarea id={id} rows={3} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function WorkOrderDialog({ model, dialog, actions }: { model: RepairModel; dialog: Extract<RepairDialog, { kind: 'workOrder' }>; actions?: RepairActions }) {
  const t = useWords()
  const options = dialog.options
  const held = model.dialogBusy ? t('quality:common.working') : !options ? t('quality:common.loading') : options.blockers.length > 0 ? t('workOrder.blocked') : dialog.seqs.length === 0 ? t('workOrder.pickSteps') : null
  const toggle = (seq: number, on: boolean) => actions?.onDialog?.({ ...dialog, seqs: on ? [...dialog.seqs, seq].sort((a, b) => a - b) : dialog.seqs.filter((value) => value !== seq) })
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('workOrder.title', { number: model.repair.number })} size="lg" footer={<Footer held={held} busy={model.dialogBusy} label={t('workOrder.submit', { count: dialog.seqs.length })} actions={actions} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <p className="fw-q-hint">{t('workOrder.body')}</p>
        {!options && !dialog.problem && (
          <p className="fw-q-loading" role="status">
            <Spinner size={12} /> {t('quality:common.loading')}
          </p>
        )}
        {options && (
          <>
            {options.garment.orderNumber && <p className="fw-q-hint">{t('workOrder.soldOn', { number: options.garment.orderNumber, seq: options.garment.lineSeq ?? '—', size: options.garment.size ?? '—' })}</p>}
            {options.revision && <p className="fw-q-hint">{t('workOrder.revision', { revision: options.revision.revision })}</p>}
            {options.blockers.length > 0 && <Banner tone="warning" title={t('workOrder.blockedTitle', { count: options.blockers.length })}>{t('workOrder.blockedBody')}</Banner>}
            {options.garment.problems.length > 0 && <Banner tone="warning" title={t('workOrder.garmentProblems', { count: options.garment.problems.length })} />}
            <fieldset className="fw-q-stack">
              <legend className="fw-q-hint">{t('workOrder.steps')}</legend>
              {options.steps.length === 0 && <p className="fw-q-hint">{t('workOrder.noSteps')}</p>}
              {options.steps.map((step) => (
                <Checkbox
                  key={step.seq}
                  checked={dialog.seqs.includes(step.seq)}
                  disabled={!step.available}
                  onChange={(event) => toggle(step.seq, event.target.checked)}
                  label={`${step.seq} · ${step.code} · ${step.name}${step.available ? '' : ` — ${t('workOrder.notAtSite')}`}`}
                />
              ))}
            </fieldset>
          </>
        )}
      </div>
    </Modal>
  )
}

function ShipDialog({ model, dialog, actions }: { model: RepairModel; dialog: Extract<RepairDialog, { kind: 'ship' }>; actions?: RepairActions }) {
  const t = useWords()
  const id = useId()
  const repair = model.repair
  const live = repair.ddts.find((ddt) => ddt.live) ?? null
  const noteKey = noteKeyOf(repair.stage, 'SHIPPED')
  const unrepairedPpe = repair.safety.required && (repair.stage === 'RECEIVED' || repair.stage === 'ESTIMATED')
  const problems = dialog.useLive ? [] : ddtProblems(dialog.draft)
  const ddtRight = dialog.useLive || model.can.ddtIssue
  const held = model.dialogBusy
    ? t('quality:common.working')
    : !ddtRight
      ? t('held.right.ddtIssue')
      : noteKey && !dialog.note.trim()
        ? t('move.noteNeeded')
        : problems[0]
          ? say(t, problems[0])
          : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('send.title', { number: repair.number })} size="lg" footer={<Footer held={held} busy={model.dialogBusy} label={t('repair.action.ship')} actions={actions} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t('send.body')}</p>
        {unrepairedPpe && <Banner tone="warning" title={t('send.unrepairedPpe')} />}
        {live && <Checkbox checked={dialog.useLive} onChange={(event) => actions?.onDialog?.({ ...dialog, useLive: event.target.checked })} label={t('send.useLive', { number: live.number })} />}
        {!dialog.useLive && (
          <>
            <DdtFields draft={dialog.draft} preview={dialog.preview} previewing={dialog.previewing} onDraft={(draft) => actions?.onDialog?.({ ...dialog, draft })} />
            <span className="fw-q-actions">
              <Button size="sm" heldReason={problems[0] ? say(t, problems[0]) : dialog.previewing ? t('quality:common.working') : null} onClick={() => actions?.onShipPreview?.()}>
                {t('send.preview')}
              </Button>
            </span>
          </>
        )}
        <Field label={t('move.noteLabel')} required={!!noteKey} hint={noteKey ? t(noteKey) : t('send.noteHint')} htmlFor={id}>
          <Textarea id={id} rows={2} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function CancelDialog({ model, dialog, actions }: { model: RepairModel; dialog: Extract<RepairDialog, { kind: 'cancel' }>; actions?: RepairActions }) {
  const t = useWords()
  const id = useId()
  const held = model.dialogBusy ? t('quality:common.working') : !dialog.reason.trim() ? t('cancel.reasonNeeded') : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('repairCancel.title', { number: model.repair.number })} size="md" footer={<Footer held={held} busy={model.dialogBusy} label={t('repairCancel.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t(model.repair.receivedAt ? 'repairCancel.bodyHere' : 'repairCancel.body')}</p>
        <Field label={t('cancel.reason')} required htmlFor={id}>
          <Textarea id={id} rows={3} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
