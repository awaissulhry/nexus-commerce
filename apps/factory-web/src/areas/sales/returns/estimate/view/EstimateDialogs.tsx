'use client'

import { useId } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { RepairActions, RepairModel } from '../../view-model'
import { Money, say, useWords } from '../../view/parts'
import { answerProblems, lineDraftProblems, shownEstimate, termsProblems, type LineField } from '../model'
import type { EstimateDialog, EstimateModel } from '../view-model'

/**
 * The Estimate tab's dialogs (B-W2b-352): Add part / Add labour (what the customer reads, qty, price, minutes for labour,
 * our cost with the cost grain), New estimate (a new revision copying the newest's lines; replacing a sent one withdraws
 * it — said before the click), Send (what the customer sees and where: the portal; NOTHING is mailed today — the design's
 * OutboundSendDialog waits for an estimate PDF and mail, B-W2b-342's gap), Record the answer (accepted or declined, how
 * the office heard it, by whom, the customer's reason for a no), Withdraw and Edit terms (valid until and the customer's
 * note while a draft; the internal note any time). Each primary button held with its reason; refusals in our words.
 */
export function EstimateDialogs({ model, estimates, actions }: { model: RepairModel; estimates: EstimateModel; actions?: RepairActions }) {
  const dialog = estimates.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'line':
      return <LineDialog model={model} estimates={estimates} dialog={dialog} actions={actions} />
    case 'new':
      return <NewDialog model={model} estimates={estimates} dialog={dialog} actions={actions} />
    case 'send':
      return <SendDialog model={model} estimates={estimates} actions={actions} />
    case 'answer':
      return <AnswerDialog model={model} estimates={estimates} dialog={dialog} actions={actions} />
    case 'withdraw':
      return <WithdrawDialog model={model} estimates={estimates} dialog={dialog} actions={actions} />
    case 'terms':
      return <TermsDialog model={model} estimates={estimates} dialog={dialog} actions={actions} />
  }
}

function Footer({ held, busy, label, actions }: { held: string | null; busy: boolean; label: string; actions?: RepairActions }) {
  const t = useWords()
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onEstimateDialog?.(null)}>
        {t('quality:common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onEstimateSubmit?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

function Problem({ estimates }: { estimates: EstimateModel }) {
  const t = useWords()
  return estimates.dialogProblem ? <Banner tone="danger" title={say(t, estimates.dialogProblem)} /> : null
}

function LineDialog({ estimates, dialog, actions }: { model: RepairModel; estimates: EstimateModel; dialog: Extract<EstimateDialog, { kind: 'line' }>; actions?: RepairActions }) {
  const t = useWords()
  const ids = { description: useId(), quantity: useId(), price: useId(), minutes: useId(), cost: useId() }
  const draft = dialog.draft
  const problems = lineDraftProblems(draft)
  const errorOf = (field: LineField) => (dialog.showProblems ? problems.find((entry) => entry.field === field) : undefined)
  const set = (patch: Partial<typeof draft>) => actions?.onEstimateDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  const held = estimates.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0].words) : null
  const seesCosts = estimates.value?.seesCosts ?? false
  const error = (field: LineField) => {
    const found = errorOf(field)
    return found ? say(t, found.words) : undefined
  }
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t(draft.kind === 'LABOUR' ? 'depth:estimate.line.titleLabour' : 'depth:estimate.line.titlePart')} size="md" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.line.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        <Field label={t('depth:estimate.col.what')} required hint={t('depth:estimate.line.whatHint')} error={error('description')} htmlFor={ids.description}>
          <Input id={ids.description} value={draft.description} onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <div className="fw-q-form-three">
          <Field label={t('depth:estimate.col.quantity')} required error={error('quantity')} htmlFor={ids.quantity}>
            <Input id={ids.quantity} inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
          </Field>
          <Field label={t('depth:estimate.line.price')} required error={error('unitPrice')} htmlFor={ids.price}>
            <Input id={ids.price} inputMode="decimal" value={draft.unitPrice} onChange={(event) => set({ unitPrice: event.target.value })} />
          </Field>
          {draft.kind === 'LABOUR' && (
            <Field label={t('depth:estimate.col.minutes')} required error={error('minutes')} htmlFor={ids.minutes}>
              <Input id={ids.minutes} inputMode="numeric" value={draft.minutes} onChange={(event) => set({ minutes: event.target.value })} />
            </Field>
          )}
          {seesCosts && (
            <Field label={t('depth:estimate.line.cost')} hint={t('depth:estimate.line.costHint')} error={error('unitCost')} htmlFor={ids.cost}>
              <Input id={ids.cost} inputMode="decimal" value={draft.unitCost} onChange={(event) => set({ unitCost: event.target.value })} />
            </Field>
          )}
        </div>
      </div>
    </Modal>
  )
}

function NewDialog({ estimates, dialog, actions }: { model: RepairModel; estimates: EstimateModel; dialog: Extract<EstimateDialog, { kind: 'new' }>; actions?: RepairActions }) {
  const t = useWords()
  const answer = estimates.value
  const newest = answer?.estimates[0] ?? null
  const replaced = dialog.replaces ? answer?.estimates.find((entry) => entry.id === dialog.replaces) : null
  const held = estimates.busy ? t('quality:common.working') : null
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t('depth:estimate.newDialog.title', { revision: (newest?.revision ?? 0) + 1 })} size="sm" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.newDialog.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        <p>{newest ? t('depth:estimate.newDialog.copies', { revision: newest.revision, count: newest.lines.length }) : t('depth:estimate.newDialog.first')}</p>
        {replaced && <Banner tone="warning" title={t('depth:estimate.newDialog.replaces', { revision: replaced.revision })} />}
      </div>
    </Modal>
  )
}

function SendDialog({ model, estimates, actions }: { model: RepairModel; estimates: EstimateModel; actions?: RepairActions }) {
  const t = useWords()
  const estimate = shownEstimate(estimates.value, estimates.shownId)
  const held = estimates.busy ? t('quality:common.working') : !estimate ? t('quality:common.loading') : null
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t('depth:estimate.send.title', { revision: estimate?.revision ?? '—', number: model.repair.number })} size="md" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.send.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        {estimate && (
          <KeyValue
            columns={2}
            items={[
              { label: t('depth:estimate.send.to'), value: model.repair.party.legalName },
              { label: t('depth:estimate.count', { count: estimate.lines.length }), value: <Money minor={estimate.summary.amount ?? null} currency={estimate.currency} /> },
            ]}
          />
        )}
        <ul className="fw-q-lines">
          <li>{t('depth:estimate.send.portal')}</li>
          <li>{t('depth:estimate.send.frozen')}</li>
          {model.repair.stage === 'RECEIVED' && <li>{t('depth:estimate.send.stage')}</li>}
        </ul>
        <Banner tone="info" title={t('depth:estimate.send.noMail')} />
      </div>
    </Modal>
  )
}

function AnswerDialog({ estimates, dialog, actions }: { model: RepairModel; estimates: EstimateModel; dialog: Extract<EstimateDialog, { kind: 'answer' }>; actions?: RepairActions }) {
  const t = useWords()
  const ids = { how: useId(), name: useId(), reason: useId() }
  const draft = dialog.draft
  const problems = answerProblems(draft)
  const set = (patch: Partial<typeof draft>) => actions?.onEstimateDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  const held = estimates.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : null
  const show = (key: string) => (dialog.showProblems && problems.some((entry) => entry.key === key) ? t(key) : undefined)
  const estimate = shownEstimate(estimates.value, estimates.shownId)
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t('depth:estimate.answer.title', { revision: estimate?.revision ?? '—' })} size="md" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.answer.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        <p className="fw-q-hint">{t('depth:estimate.answer.body')}</p>
        <div className="fw-q-form-two" role="radiogroup" aria-label={t('depth:estimate.answer.label')}>
          <RadioCard name="estimate-answer" value="ACCEPTED" checked={draft.answer === 'ACCEPTED'} selected={draft.answer === 'ACCEPTED'} onChange={() => set({ answer: 'ACCEPTED' })} title={t('depth:estimate.answer.ACCEPTED')} description={t('depth:estimate.answer.acceptedHint')} />
          <RadioCard name="estimate-answer" value="DECLINED" checked={draft.answer === 'DECLINED'} selected={draft.answer === 'DECLINED'} onChange={() => set({ answer: 'DECLINED' })} title={t('depth:estimate.answer.DECLINED')} description={t('depth:estimate.answer.declinedHint')} />
        </div>
        <Field label={t('depth:estimate.answer.how')} required hint={t('depth:estimate.answer.howHint')} error={show('depth:estimate.answer.problem.how')} htmlFor={ids.how}>
          <Input id={ids.how} value={draft.how} onChange={(event) => set({ how: event.target.value })} />
        </Field>
        <Field label={t('depth:estimate.answer.name')} htmlFor={ids.name}>
          <Input id={ids.name} value={draft.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        {draft.answer === 'DECLINED' && (
          <Field label={t('depth:estimate.answer.reason')} required error={show('depth:estimate.answer.problem.reason')} htmlFor={ids.reason}>
            <Textarea id={ids.reason} rows={2} value={draft.declineReason} onChange={(event) => set({ declineReason: event.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function WithdrawDialog({ estimates, dialog, actions }: { model: RepairModel; estimates: EstimateModel; dialog: Extract<EstimateDialog, { kind: 'withdraw' }>; actions?: RepairActions }) {
  const t = useWords()
  const id = useId()
  const estimate = shownEstimate(estimates.value, estimates.shownId)
  const held = estimates.busy ? t('quality:common.working') : null
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t('depth:estimate.withdraw.title', { revision: estimate?.revision ?? '—' })} size="sm" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.withdraw.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        <p>{t(estimate?.status === 'SENT' ? 'depth:estimate.withdraw.bodySent' : 'depth:estimate.withdraw.body')}</p>
        <Field label={t('depth:estimate.withdraw.reason')} htmlFor={id}>
          <Textarea id={id} rows={2} value={dialog.reason} onChange={(event) => actions?.onEstimateDialog?.({ kind: 'withdraw', reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function TermsDialog({ model, estimates, dialog, actions }: { model: RepairModel; estimates: EstimateModel; dialog: Extract<EstimateDialog, { kind: 'terms' }>; actions?: RepairActions }) {
  const t = useWords()
  const locale = useLocale()
  const ids = { until: useId(), customer: useId(), internal: useId() }
  const estimate = shownEstimate(estimates.value, estimates.shownId)
  const draftOnly = estimate?.status === 'DRAFT'
  const draft = dialog.draft
  const set = (patch: Partial<typeof draft>) => actions?.onEstimateDialog?.({ kind: 'terms', draft: { ...draft, ...patch } })
  const problems = draftOnly ? termsProblems(draft, model.today) : []
  const held = estimates.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : null
  return (
    <Modal open onClose={() => actions?.onEstimateDialog?.(null)} title={t('depth:estimate.terms.title', { revision: estimate?.revision ?? '—' })} size="md" footer={<Footer held={held} busy={estimates.busy} label={t('depth:estimate.terms.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        <Problem estimates={estimates} />
        {!draftOnly && <Banner tone="info" title={t('depth:estimate.terms.sentOnly')} />}
        <Field label={t('depth:estimate.fact.validUntil')} htmlFor={ids.until}>
          <DateField id={ids.until} value={draft.validUntil} onChange={(value) => set({ validUntil: value })} locale={INTL_LOCALE[locale]} min={model.today} disabled={!draftOnly} ariaLabel={t('depth:estimate.fact.validUntil')} placeholder={t('depth:estimate.terms.noDate')} clearLabel={t('depth:estimate.terms.noDate')} />
        </Field>
        <Field label={t('depth:estimate.fact.customerNote')} hint={t('depth:estimate.terms.customerHint')} htmlFor={ids.customer}>
          <Textarea id={ids.customer} rows={3} value={draft.customerNote} disabled={!draftOnly} onChange={(event) => set({ customerNote: event.target.value })} />
        </Field>
        <Field label={t('depth:estimate.fact.internalNote')} hint={t('depth:estimate.terms.internalHint')} htmlFor={ids.internal}>
          <Textarea id={ids.internal} rows={3} value={draft.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
