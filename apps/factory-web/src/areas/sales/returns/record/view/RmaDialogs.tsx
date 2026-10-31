'use client'

import { useId } from 'react'
import { Banner, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { PARCEL_CONDITIONS, RETURN_CAUSES, RETURN_GRADES, type ParcelCondition } from '../../api'
import { ddtProblems, garmentOf, receiptProblems } from '../../model'
import type { RmaActions, RmaDialog, RmaModel } from '../../view-model'
import { DdtFields } from '../../view/DdtFields'
import { say, useWords } from '../../view/parts'

/**
 * The RMA record's dialogs (SCR-112): Receive goods (the office's counter receipt: parcels, their state, the customer's
 * DDT, the pieces per line — never more than each still expects), Grade (the received lines' grade, cause and words: the
 * inspection of B-W2a-43, in the office), Make replacement order, Issue return DDT (unchanged goods back to the customer:
 * preview first, then issue) and Cancel. Each primary button is held with its reason; the API's refusals in our words.
 * A credit note is made only in Finance (one edit path): the Replacement & credit tab links there.
 */
export function RmaDialogs({ model, actions }: { model: RmaModel; actions?: RmaActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'receive':
      return <ReceiveDialog model={model} dialog={dialog} actions={actions} />
    case 'grade':
      return <GradeDialog model={model} dialog={dialog} actions={actions} />
    case 'replacement':
      return <SimpleDialog model={model} actions={actions} title="replacement.title" body="replacement.body" submit="replacement.submit" note={dialog.note} onNote={(note) => actions?.onDialog?.({ kind: 'replacement', note })} />
    case 'cancel':
      return <SimpleDialog model={model} actions={actions} title="cancel.title" body="cancel.body" submit="cancel.submit" note={dialog.reason} noteLabel="cancel.reason" noteRequired onNote={(reason) => actions?.onDialog?.({ kind: 'cancel', reason })} />
    case 'ddt':
      return <ReturnDdtDialog model={model} dialog={dialog} actions={actions} />
    case 'decide':
      return null
  }
}

function Footer({ held, busy, label, onCancel, onSubmit }: { held: string | null; busy: boolean; label: string; onCancel: () => void; onSubmit: () => void }) {
  const t = useWords()
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={onCancel}>
        {t('quality:common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={onSubmit}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

function ReceiveDialog({ model, dialog, actions }: { model: RmaModel; dialog: Extract<RmaDialog, { kind: 'receive' }>; actions?: RmaActions }) {
  const t = useWords()
  const locale = useLocale()
  const ids = { parcels: useId(), condition: useId(), carrier: useId(), tracking: useId(), ddt: useId(), ddtDate: useId(), note: useId() }
  const draft = dialog.draft
  const set = (patch: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'receive', draft: { ...draft, ...patch } })
  const problems = receiptProblems(draft, model.rma)
  const held = model.dialogBusy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : null
  const open = model.rma.lines.filter((line) => line.grade === null && line.receivedQuantity < line.quantity)
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('receive.title', { number: model.rma.number })} size="lg" footer={<Footer held={held} busy={model.dialogBusy} label={t('receive.submit')} onCancel={() => actions?.onDialog?.(null)} onSubmit={() => actions?.onDialogSubmit?.()} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t('receive.body')}</p>
        <div className="fw-q-form-three">
          <Field label={t('receive.parcels')} required htmlFor={ids.parcels}>
            <Input id={ids.parcels} inputMode="numeric" value={draft.parcels} onChange={(event) => set({ parcels: event.target.value })} />
          </Field>
          <Field label={t('receive.condition')} htmlFor={ids.condition}>
            <Select id={ids.condition} value={draft.condition} onChange={(event) => set({ condition: event.target.value as ParcelCondition })}>
              {PARCEL_CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`parcel.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('receive.ddt')} hint={t('receive.ddtHint')} htmlFor={ids.ddt}>
            <Input id={ids.ddt} value={draft.ddtNumber} onChange={(event) => set({ ddtNumber: event.target.value })} />
          </Field>
          <Field label={t('receive.ddtDate')} htmlFor={ids.ddtDate}>
            <DateField id={ids.ddtDate} value={draft.ddtDate} onChange={(value) => set({ ddtDate: value })} locale={INTL_LOCALE[locale]} max={model.today} ariaLabel={t('receive.ddtDate')} placeholder={t('newRepair.none')} clearLabel={t('newRepair.none')} />
          </Field>
          <Field label={t('receive.carrier')} htmlFor={ids.carrier}>
            <Input id={ids.carrier} value={draft.carrierName} onChange={(event) => set({ carrierName: event.target.value })} />
          </Field>
          <Field label={t('receive.tracking')} htmlFor={ids.tracking}>
            <Input id={ids.tracking} value={draft.trackingNumber} onChange={(event) => set({ trackingNumber: event.target.value })} />
          </Field>
        </div>
        <section aria-label={t('receive.linesLabel')} className="fw-q-stack">
          {open.map((line) => (
            <Field key={line.id} label={t('receive.line', { seq: line.seq, garment: garmentOf(line) || line.description })} hint={t('receive.expects', { count: line.quantity - line.receivedQuantity })}>
              <Input inputMode="numeric" value={draft.lines[line.id] ?? ''} onChange={(event) => set({ lines: { ...draft.lines, [line.id]: event.target.value } })} aria-label={t('receive.piecesOf', { seq: line.seq })} />
            </Field>
          ))}
        </section>
        <Field label={t('receive.note')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <p className="fw-q-hint">{t('receive.photosOnFloor')}</p>
      </div>
    </Modal>
  )
}

function GradeDialog({ model, dialog, actions }: { model: RmaModel; dialog: Extract<RmaDialog, { kind: 'grade' }>; actions?: RmaActions }) {
  const t = useWords()
  const ids = { grade: useId(), cause: useId(), note: useId() }
  const set = (patch: Partial<typeof dialog>) => actions?.onDialog?.({ ...dialog, ...patch })
  const lines = model.rma.lines.filter((line) => dialog.lineIds.includes(line.id))
  const held = model.dialogBusy ? t('quality:common.working') : !dialog.grade ? t('grade.pick') : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('grade.title', { count: lines.length })} size="md" footer={<Footer held={held} busy={model.dialogBusy} label={t('grade.submit', { count: lines.length })} onCancel={() => actions?.onDialog?.(null)} onSubmit={() => actions?.onDialogSubmit?.()} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <ul className="fw-q-lines">
          {lines.map((line) => (
            <li key={line.id}>{t('receive.line', { seq: line.seq, garment: garmentOf(line) || line.description })}</li>
          ))}
        </ul>
        <Field label={t('inspect.grade1')} required htmlFor={ids.grade}>
          <Select id={ids.grade} value={dialog.grade} onChange={(event) => set({ grade: event.target.value })}>
            <option value="">{t('grade.pick')}</option>
            {RETURN_GRADES.map((value) => (
              <option key={value} value={value}>
                {t(`grade.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inspect.cause')} htmlFor={ids.cause}>
          <Select id={ids.cause} value={dialog.cause} onChange={(event) => set({ cause: event.target.value })}>
            <option value="">{t('grade.noCause')}</option>
            {RETURN_CAUSES.map((value) => (
              <option key={value} value={value}>
                {t(`cause.${value}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('inspect.condition')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={dialog.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function SimpleDialog({
  model,
  actions,
  title,
  body,
  submit,
  note,
  noteLabel = 'replacement.note',
  noteRequired = false,
  onNote,
}: {
  model: RmaModel
  actions?: RmaActions
  title: string
  body: string
  submit: string
  note?: string
  noteLabel?: string
  noteRequired?: boolean
  onNote?: (value: string) => void
}) {
  const t = useWords()
  const id = useId()
  const held = model.dialogBusy ? t('quality:common.working') : noteRequired && !(note ?? '').trim() ? t('cancel.reasonNeeded') : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t(title, { number: model.rma.number })} size="md" footer={<Footer held={held} busy={model.dialogBusy} label={t(submit)} onCancel={() => actions?.onDialog?.(null)} onSubmit={() => actions?.onDialogSubmit?.()} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t(body)}</p>
        {onNote && (
          <Field label={t(noteLabel)} required={noteRequired} htmlFor={id}>
            <Textarea id={id} rows={3} value={note ?? ''} onChange={(event) => onNote(event.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function ReturnDdtDialog({ model, dialog, actions }: { model: RmaModel; dialog: Extract<RmaDialog, { kind: 'ddt' }>; actions?: RmaActions }) {
  const t = useWords()
  const problems = ddtProblems(dialog.draft)
  const held = model.dialogBusy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : dialog.preview && dialog.preview.problems.length > 0 ? t('ddt.previewProblems', { count: dialog.preview.problems.length }) : null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('ddt.titleReturn', { number: model.rma.number })} size="lg" footer={<Footer held={held} busy={model.dialogBusy} label={t('ddt.issue')} onCancel={() => actions?.onDialog?.(null)} onSubmit={() => actions?.onDialogSubmit?.()} />}>
      <div className="fw-q-stack">
        {model.dialogProblem && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
        <p className="fw-q-hint">{t('ddt.returnBody')}</p>
        <DdtFields draft={dialog.draft} preview={dialog.preview} previewing={dialog.previewing} onDraft={(draft) => actions?.onDialog?.({ ...dialog, draft })} />
      </div>
    </Modal>
  )
}
