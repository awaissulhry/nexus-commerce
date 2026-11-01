'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { SupplierInvoice } from '../../api'
import { amountOf, decimalOf, PAYABLES_NAMESPACE, payProblem, unmappedLines } from '../../model'
import type { LineDraft, RecordDialog, SupplierInvoiceActions, SupplierInvoiceModel } from '../record-model'

const REASON_MAX = 500

/**
 * The record's dialogs (each ONE write, with the invoice's version as read): Approve (a note), Accept difference with a
 * reason, Send to buyer (a message), Reject with reason (= dispute with the supplier), Withdraw approval, Reopen, Void (a
 * typed invoice), Mark paid (the day ≤ today and ≥ the invoice's, the bank's reference), Mark it as an invoice without PO,
 * a typed line (change or add) and Remove line. A refused write keeps the dialog open with the refusal in words.
 */
export function RecordDialogs({ invoice, model, actions }: { invoice: SupplierInvoice; model: SupplierInvoiceModel; actions?: SupplierInvoiceActions }) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  const set = (next: RecordDialog) => actions?.onDialog?.(next)
  const confirm = () => actions?.onConfirm?.(dialog)
  const problem = model.dialogProblem && model.dialogProblem.length > 0 ? <Banner tone="danger" title={model.dialogProblem.map((phrase) => t(phrase.key, phrase.params)).join(' ')} /> : null
  const footer = (label: string, held: string | null, danger = false) => (
    <>
      <Button size="sm" onClick={close}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant={danger ? 'danger' : 'primary'} heldReason={held ?? (model.busy ? t('held.busy') : null)} onClick={confirm}>
        {label}
      </Button>
    </>
  )
  const reasonField = (value: string, onChange: (text: string) => void, label: string, hint?: string) => (
    <Field label={label} required hint={hint}>
      <Textarea value={value} maxLength={REASON_MAX} rows={3} onChange={(event) => onChange(event.target.value)} />
    </Field>
  )

  if (dialog.kind === 'approve') {
    return (
      <Modal open onClose={close} title={t('dialog.approve.title', { number: invoice.number })} size="sm" footer={footer(t('dialog.approve.confirm'), null)}>
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t('dialog.approve.body', { supplier: invoice.supplier.name })}</p>
          <Field label={t('dialog.note')}>
            <Textarea value={dialog.note} maxLength={1000} rows={2} onChange={(event) => set({ ...dialog, note: event.target.value })} />
          </Field>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'accept') {
    const entry = invoice.matches.find((match) => match.id === dialog.matchId)
    return (
      <Modal open onClose={close} title={t('dialog.accept.title')} size="md" footer={footer(t('dialog.accept.confirm'), dialog.note.trim() ? null : t('dialog.reasonNeeded'))}>
        <div className="fw-fpy-stack">
          {problem}
          {entry && <p className="fw-fpy-muted">{t('dialog.accept.line', { seq: entry.lineSeq, words: locale === 'it' ? entry.words.it : entry.words.en })}</p>}
          <p className="fw-fpy-muted">{t('dialog.accept.body')}</p>
          {reasonField(dialog.note, (note) => set({ ...dialog, note }), t('dialog.accept.reason'), t('dialog.accept.reasonHint'))}
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'sendToBuyer') {
    return (
      <Modal open onClose={close} title={t('dialog.sendToBuyer.title')} size="md" footer={footer(t('dialog.sendToBuyer.confirm'), null)}>
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t('dialog.sendToBuyer.body')}</p>
          <Field label={t('dialog.sendToBuyer.message')}>
            <Textarea value={dialog.message} maxLength={1000} rows={3} onChange={(event) => set({ ...dialog, message: event.target.value })} />
          </Field>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'dispute' || dialog.kind === 'withdraw' || dialog.kind === 'void' || dialog.kind === 'reopen') {
    const needed = dialog.kind !== 'reopen'
    return (
      <Modal
        open
        onClose={close}
        title={t(`dialog.${dialog.kind}.title`, { number: invoice.number })}
        size="md"
        footer={footer(t(`dialog.${dialog.kind}.confirm`), needed && !dialog.reason.trim() ? t('dialog.reasonNeeded') : null, dialog.kind === 'void')}
      >
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t(`dialog.${dialog.kind}.body`)}</p>
          {needed ? (
            reasonField(dialog.reason, (reason) => set({ ...dialog, reason }), t('dialog.reason'))
          ) : (
            <Field label={t('dialog.reasonOptional')}>
              <Textarea value={dialog.reason} maxLength={REASON_MAX} rows={2} onChange={(event) => set({ ...dialog, reason: event.target.value })} />
            </Field>
          )}
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'pay') {
    const wrong = payProblem(dialog, invoice, model.today)
    return (
      <Modal open onClose={close} title={t('dialog.pay.title', { number: invoice.number })} size="sm" footer={footer(t('dialog.pay.confirm'), wrong ? t(wrong) : null)}>
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t('dialog.pay.body')}</p>
          <Field label={t('dialog.pay.paidOn')} required error={wrong && wrong !== 'pay.problem.ref' ? t(wrong) : undefined}>
            <DateField
              value={dialog.paidOn}
              max={model.today}
              min={invoice.issueDate}
              locale={locale === 'it' ? 'it-IT' : 'en-GB'}
              ariaLabel={t('dialog.pay.paidOn')}
              placeholder={t('foreign.datePlaceholder')}
              clearLabel={t('foreign.dateClear')}
              onChange={(paidOn) => set({ ...dialog, paidOn })}
            />
          </Field>
          <Field label={t('dialog.pay.ref')} required hint={t('dialog.pay.refHint')}>
            <Input size="sm" value={dialog.paymentRef} maxLength={100} onChange={(event) => set({ ...dialog, paymentRef: event.target.value })} />
          </Field>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'withoutOrder') {
    const count = unmappedLines(invoice)
    return (
      <Modal open onClose={close} title={t('dialog.withoutOrder.title')} size="sm" footer={footer(t('dialog.withoutOrder.confirm'), null)}>
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t('dialog.withoutOrder.body', { count })}</p>
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'removeLine') {
    const line = invoice.lines.find((entry) => entry.id === dialog.lineId)
    return (
      <Modal open onClose={close} title={t('dialog.removeLine.title', { seq: line?.seq ?? '' })} size="sm" footer={footer(t('dialog.removeLine.confirm'), null, true)}>
        <div className="fw-fpy-stack">
          {problem}
          <p className="fw-fpy-muted">{t('dialog.removeLine.body', { description: line?.description ?? '' })}</p>
        </div>
      </Modal>
    )
  }
  // A typed line, changed or added.
  const draft = dialog.draft
  const setDraft = (patch: Partial<LineDraft>) => set({ ...dialog, draft: { ...draft, ...patch } })
  const wrong = lineProblem(draft)
  return (
    <Modal
      open
      onClose={close}
      title={dialog.lineId ? t('dialog.line.editTitle') : t('dialog.line.addTitle')}
      size="md"
      footer={footer(dialog.lineId ? t('dialog.line.save') : t('dialog.line.add'), wrong ? t(wrong) : null)}
    >
      <div className="fw-fpy-stack">
        {problem}
        <div className="fw-fpy-form">
          <Field label={t('foreign.description')} required className="fw-fpy-form-wide">
            <Input size="sm" value={draft.description} maxLength={1000} onChange={(event) => setDraft({ description: event.target.value })} />
          </Field>
          <Field label={t('dialog.line.quantity')}>
            <Input size="sm" inputMode="decimal" value={draft.quantity} onChange={(event) => setDraft({ quantity: event.target.value })} />
          </Field>
          <Field label={t('dialog.line.uom')}>
            <Input size="sm" value={draft.uom} maxLength={10} onChange={(event) => setDraft({ uom: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('dialog.line.unitPrice')}>
            <Input size="sm" inputMode="decimal" value={draft.unitPrice} onChange={(event) => setDraft({ unitPrice: event.target.value })} />
          </Field>
          <Field label={t('foreign.net')} required hint={t('foreign.amountHint')}>
            <Input size="sm" inputMode="decimal" value={draft.net} onChange={(event) => setDraft({ net: event.target.value })} />
          </Field>
          <Field label={t('foreign.vatRate')} required>
            <Input size="sm" inputMode="decimal" value={draft.vatRate} onChange={(event) => setDraft({ vatRate: event.target.value })} />
          </Field>
          <Field label={t('foreign.vatNature')} hint={t('foreign.vatNatureHint')}>
            <Input size="sm" value={draft.vatNature} maxLength={4} onChange={(event) => setDraft({ vatNature: event.target.value.toUpperCase() })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/** Why a typed line may not be saved as typed (null: it may). */
export function lineProblem(draft: LineDraft): string | null {
  if (draft.description.trim() === '') return 'foreign.problem.description'
  if (amountOf(draft.net) === null) return 'foreign.problem.net'
  if (draft.quantity.trim() !== '' && decimalOf(draft.quantity, 4) === null) return 'dialog.line.problemQuantity'
  if (draft.unitPrice.trim() !== '' && decimalOf(draft.unitPrice, 6) === null) return 'dialog.line.problemPrice'
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(draft.vatRate.trim())) return 'foreign.problem.vatRate'
  if (Number(draft.vatRate.replace(',', '.')) === 0 && !/^N[1-7](\.[0-9])?$/.test(draft.vatNature.trim())) return 'foreign.problem.vatNature'
  return null
}
