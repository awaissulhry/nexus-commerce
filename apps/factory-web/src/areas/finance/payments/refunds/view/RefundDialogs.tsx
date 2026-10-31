'use client'

import { useState } from 'react'
import { Banner, DateField, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayInstant, money, type Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { Refund } from '../api'
import { emptyRefund, moveHeld, moveProblems, refundGoWords, refundHeld, refundProblems, settlesWords, type RefundAbilities, type RefundDraft, type RefundMove, type RefundTarget } from '../model'

/**
 * The Refund dialog (design finance.payments pop:refund — "Credit note it settles; amount capped at what is still
 * refundable; method"; opened from the payments band, a credit note, or a payment's credit balance) and the moves of a
 * refund (made, cancelled, voided), composed from the DS. Each fetches nothing: the host passes what it shows (the credit
 * notes with money left to refund, or one target) and does what it asks; a refusal is said inside, what was typed stays.
 */

export interface RefundDialogModel {
  /** What may be refunded (credit notes with money left; a payment's credit balance); null while it loads. */
  targets: RefundTarget[] | null
  targetsProblem: string | null
  /** The target the dialog opens with (a credit note's record, a payment's ⋯). */
  start: string | null
  can: RefundAbilities
  today: string
  busy: boolean
  problem: Phrase | null
  /** Design cases: what the dialog holds typed. */
  draft?: Partial<RefundDraft>
}

const targetId = (target: RefundTarget) => (target.kind === 'creditNote' ? target.creditNoteId : target.paymentId)

export function RefundDialog({ model, onRecord, onRetry, onClose }: { model: RefundDialogModel; onRecord: (target: RefundTarget, draft: RefundDraft) => void; onRetry?: () => void; onClose: () => void }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const [picked, setPicked] = useState<string>(model.start ?? '')
  const [draft, setDraft] = useState<RefundDraft>({ ...emptyRefund(model.today), ...model.draft })
  const targets = model.targets ?? []
  const target = targets.find((entry) => targetId(entry) === picked) ?? (targets.length === 1 ? targets[0]! : null)
  const problems = refundProblems(target, draft, model.today)
  const first = problems.target ?? problems.amount ?? problems.paidOn ?? problems.reference ?? problems.dueDate ?? null
  const right = refundHeld(model.can)
  const held = model.busy ? t('held.busy') : right ? d(right.key, right.params) : model.targets === null ? d('refund.held.reading') : first ? d(first) : null
  const go = refundGoWords(target, draft, locale)
  const set = (field: keyof RefundDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  const preset = !!model.start && target !== null && targetId(target) === model.start
  return (
    <DialogFrame title={d('refund.title')} held={held} go={() => target && onRecord(target, draft)} goLabel={model.busy ? t('common.working') : d(go.key, go.params)} onClose={onClose} problem={model.problem}>
      <p className="fw-fin-hint">{d('refund.body')}</p>
      {model.targetsProblem ? (
        <Banner
          tone="danger"
          title={d('refund.failed')}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        >
          {t(model.targetsProblem)}
        </Banner>
      ) : model.targets === null ? (
        <p className="fw-fin-hint" role="status">
          <Spinner size={12} /> {d('refund.loading')}
        </p>
      ) : targets.length === 0 ? (
        <Banner tone="info" title={d('refund.none')} />
      ) : preset || targets.length === 1 ? (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: d(target!.kind === 'creditNote' ? 'refund.settlesNote' : 'refund.settlesPayment'), value: target!.label },
            { label: d('refund.customer'), value: target!.partyName },
            ...(model.can.price ? [{ label: d('refund.cap'), value: money(target!.cap, target!.currency, locale), hint: d('refund.capHint') }] : []),
          ]}
        />
      ) : (
        <Field label={d('refund.settles')} error={picked && problems.target ? d(problems.target) : undefined}>
          <Select value={picked} onChange={(event) => setPicked(event.target.value)}>
            <option value="">{d('refund.pick')}</option>
            {targets.map((entry) => (
              <option key={targetId(entry)} value={targetId(entry)}>
                {d(entry.kind === 'creditNote' ? 'refund.optionNote' : 'refund.optionPayment', { label: entry.label, customer: entry.partyName, amount: model.can.price ? money(entry.cap, entry.currency, locale) : '—' })}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="fw-fin-two">
        <Field label={d('refund.amount')} hint={target && model.can.price ? d('refund.amountHint', { amount: money(target.cap, target.currency, locale) }) : d('refund.amountHintPlain')} error={draft.amount && problems.amount ? d(problems.amount) : undefined}>
          <Input inputMode="decimal" value={draft.amount} onChange={(event) => set('amount', event.target.value)} autoComplete="off" />
        </Field>
        <Field label={d('refund.method')}>
          <Input value={t('payments.method.BANK_TRANSFER')} readOnly />
        </Field>
      </div>
      <fieldset className="fw-fin-choices">
        <legend className="fw-fin-legend">{d('refund.when')}</legend>
        {(['now', 'later'] as const).map((option) => (
          <RadioCard key={option} name="fw-fin-refund-when" value={option} checked={draft.when === option} selected={draft.when === option} onChange={() => set('when', option)} title={d(`refund.whenOption.${option}`)} description={d(`refund.whenHint.${option}`)} />
        ))}
      </fieldset>
      {draft.when === 'now' ? (
        <div className="fw-fin-two">
          <Field label={d('refund.paidOn')} error={problems.paidOn ? d(problems.paidOn) : undefined}>
            <DateField value={draft.paidOn} onChange={(value) => set('paidOn', value)} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={d('refund.paidOn')} />
          </Field>
          <Field label={d('refund.reference')} hint={d('refund.referenceHint')} error={draft.reference && problems.reference ? d(problems.reference) : undefined}>
            <Input value={draft.reference} maxLength={200} onChange={(event) => set('reference', event.target.value)} autoComplete="off" />
          </Field>
        </div>
      ) : (
        <Field label={d('refund.dueDate')} error={problems.dueDate ? d(problems.dueDate) : undefined}>
          <DateField value={draft.dueDate} onChange={(value) => set('dueDate', value)} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={d('refund.dueDate')} />
        </Field>
      )}
      <Field label={d('refund.note')}>
        <Textarea value={draft.note} rows={2} maxLength={2000} onChange={(event) => set('note', event.target.value)} />
      </Field>
      <p className="fw-fin-hint">{d(draft.when === 'now' ? 'refund.afterNow' : 'refund.afterLater')}</p>
    </DialogFrame>
  )
}

/** A refund's move: made (its value date and reference), cancelled (the customer keeps the credit), voided (owed again). */
export function RefundMoveDialog({ refund, move, can, today, busy, problem, onMove, onClose, start }: { refund: Refund; move: RefundMove; can: RefundAbilities; today: string; busy: boolean; problem: Phrase | null; onMove: (input: { paidOn: string; reference: string; reason: string }) => void; onClose: () => void; start?: { reference?: string; reason?: string } }) {
  const t = useT('finance')
  const d = useT('finance-daily')
  const locale = useLocale()
  const [paidOn, setPaidOn] = useState(today)
  const [reference, setReference] = useState(start?.reference ?? '')
  const [reason, setReason] = useState(start?.reason ?? '')
  const problems = moveProblems(move, { paidOn, reference, reason }, today)
  const wait = moveHeld(refund, move, can)
  const first = problems.paidOn ?? problems.reference ?? problems.reason ?? null
  const held = busy ? t('held.busy') : wait ? d(wait.key, wait.params) : first ? d(first) : null
  const settles = settlesWords(refund)
  const amount = money(refund.amount, refund.currency, locale)
  return (
    <DialogFrame title={d(`refunds.move.${move}.title`, { amount: can.price ? amount : '—' })} held={held} go={() => onMove({ paidOn, reference: reference.trim(), reason: reason.trim() })} goLabel={busy ? t('common.working') : d(`refunds.move.${move}.go`)} onClose={onClose} problem={problem} tone={move === 'paid' ? 'primary' : 'danger'} size="sm">
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: d('refund.customer'), value: refund.party.legalName },
          { label: d('refund.settles'), value: d(settles.key, settles.params) },
          ...(refund.dueDate ? [{ label: d('refund.dueDate'), value: formatDate(dayInstant(refund.dueDate), { locale }) }] : []),
        ]}
      />
      <p className="fw-fin-hint">{d(`refunds.move.${move}.body`)}</p>
      {move === 'paid' ? (
        <>
          <Field label={d('refund.paidOn')} error={problems.paidOn ? d(problems.paidOn) : undefined}>
            <DateField value={paidOn} onChange={setPaidOn} max={today} locale={INTL_LOCALE[locale]} ariaLabel={d('refund.paidOn')} />
          </Field>
          <Field label={d('refund.reference')} hint={d('refund.referenceHint')} error={reference && problems.reference ? d(problems.reference) : undefined}>
            <Input value={reference} maxLength={200} onChange={(event) => setReference(event.target.value)} autoComplete="off" />
          </Field>
        </>
      ) : (
        <Field label={d('refunds.reason')} error={reason && problems.reason ? d(problems.reason) : undefined}>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
      )}
    </DialogFrame>
  )
}
