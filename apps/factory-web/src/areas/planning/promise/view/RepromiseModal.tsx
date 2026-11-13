'use client'

import { Check, Send, Undo2, X } from 'lucide-react'
import { Banner, EmptyState, Field, Listbox, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Proposal, RepromiseDraft } from '../api'
import { certificateWords, dayWords, decisionHolds, formHeld, formProblems, movedSizes, previewStale, sizeKey, sizeName, type RepromiseForm, type Words } from '../model'
import type { PromiseActions, PromiseModel, RepromiseDialog } from '../view-model'

/**
 * The Re-promise modal (design planning.promise pop:repromise "Re-promise SO-1043", the row verb or `p`): the proposed day per
 * size from the plan (each changeable, or left as it is), the reason (Listbox, in the customer's curated words), the office's
 * note, the message to the customer (a preview in their language; other words may be written) and "What happens: sales
 * accepts; the customer sees it in the portal and gets the message" → Send to sales for acceptance. A line whose re-promise
 * already waits shows it instead, with sales' word: Accept (tell the customer now, by e-mail on the order's thread), Decline
 * (with the reason the planner reads), and the planner's Withdraw. Nobody decides their own proposal — the Owner included:
 * the button is held and says why.
 */
export function RepromiseModal({ model, actions, words }: { model: PromiseModel; actions?: PromiseActions; words: Words }) {
  const { t } = words
  const dialog = model.repromise!
  const draft = dialog.draft.status === 'ready' ? dialog.draft.value : null
  const title = draft ? t('repromise.title', { order: draft.order.number, line: draft.line.seq }) : t('repromise.titleLoading')
  const subtitle = draft ? `${draft.customer.name} · ${draft.line.style.code} ${draft.line.style.name} · ${draft.line.colourway.name}` : undefined
  const close = () => actions?.onRepromise?.(null)

  let body = null
  let footer = null
  if (dialog.draft.status === 'loading') {
    body = (
      <div className="fw-pdt-dialog" aria-busy="true">
        <Skeleton height={20} />
        <Skeleton height={120} />
        <Skeleton height={60} />
      </div>
    )
  } else if (dialog.draft.status === 'error') {
    body = (
      <EmptyState
        title={t('repromise.error')}
        description={t(dialog.draft.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetryDraft?.()}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else if (dialog.done && draft) {
    body = <DoneView dialog={dialog} draft={draft} words={words} />
    footer = (
      <Button variant="primary" onClick={close}>
        {t('common.close')}
      </Button>
    )
  } else if (draft?.waiting) {
    const decided = <DecisionView model={model} dialog={dialog} draft={draft} proposal={draft.waiting} actions={actions} words={words} />
    body = decided
    footer = <DecisionFooter model={model} dialog={dialog} proposal={draft.waiting} actions={actions} words={words} />
  } else if (draft && dialog.form) {
    body = <ProposeView model={model} dialog={dialog} draft={draft} form={dialog.form} actions={actions} words={words} />
    footer = <ProposeFooter model={model} dialog={dialog} draft={draft} form={dialog.form} actions={actions} words={words} />
  }

  return (
    <Modal open onClose={close} title={title} subtitle={subtitle} size="xl" footer={footer}>
      {body}
    </Modal>
  )
}

function ProblemBanner({ dialog, words }: { dialog: RepromiseDialog; words: Words }) {
  if (!dialog.problem) return null
  return <Banner tone="danger" title={words.t(dialog.problem.key)} />
}

// ---- the planner's proposal ------------------------------------------------------------------------------------------------

function ProposeView({ model, dialog, draft, form, actions, words }: { model: PromiseModel; dialog: RepromiseDialog; draft: RepromiseDraft; form: RepromiseForm; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const problems = formProblems(draft, form)
  const moved = movedSizes(draft, form)
  const mtm = draft.line.kind === 'MADE_TO_MEASURE'
  const mayPropose = model.can.manage && draft.may.propose
  // The sizes the API named in a refusal (indexes of the moved sizes sent).
  const refusedKeys = new Set((dialog.problem?.sizes ?? []).map((index) => (moved[index] ? sizeKey(moved[index]!.size) : '')))
  const reasonOptions = draft.reasons.map((reason) => ({ value: reason.code, label: reason[locale] }))
  const stale = previewStale(draft, form, moved)
  return (
    <div className="fw-pdt-dialog">
      <ProblemBanner dialog={dialog} words={words} />
      {!mayPropose && <Banner tone="info" title={t(model.can.manage ? 'held.mayNot' : 'held.noManage')} />}
      <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-rp-sizes">
        <h3 id="fw-pdt-rp-sizes" className="fw-pdt-h3">
          {t('repromise.sizes')}
        </h3>
        <p className="fw-pdt-hint">{t('repromise.sizesHint')}</p>
        <SummaryTable
          label={t('repromise.sizes')}
          columns={[t('repromise.col.size'), t('repromise.col.open'), t('repromise.col.now'), t('repromise.col.plan'), t('repromise.col.certificate'), t('repromise.col.new')]}
          align={['left', 'right', 'left', 'left', 'left', 'left']}
          widths={[undefined, undefined, undefined, undefined, undefined, '200px']}
          stackOnPhone
          rows={draft.plan.map((row) => {
            const key = sizeKey(row.size)
            const problem = problems.sizes[key] ?? (refusedKeys.has(key) ? 'problem.refused' : null)
            const held = row.state === 'SHIPPED' ? t('repromise.shipped') : row.current === null ? t('problem.noPromise') : !mayPropose ? t(model.can.manage ? 'held.mayNot' : 'held.noManage') : null
            return {
              id: key,
              cells: [
                sizeName(row.size, t, mtm),
                String(row.open),
                dayWords(row.current, locale, true),
                <span key="plan" className="fw-pdt-cell-inline">
                  {row.proposed ? dayWords(row.proposed, locale, true) : t(`state.${row.state}`)}
                  {row.proposed && row.current && row.proposed > row.current ? <Pill tone="warning">{t('repromise.later', { count: daysBetween(row.current, row.proposed) })}</Pill> : null}
                </span>,
                certificateWords(row.certificate, words),
                held ? (
                  <span key="held" className="fw-pdt-hint">
                    {held}
                  </span>
                ) : (
                  <span key="date" className="fw-pdt-date">
                    <DateField
                      value={form.dates[key] ?? ''}
                      min={draft.today}
                      clearable
                      ariaLabel={t('repromise.newFor', { size: sizeName(row.size, t, mtm) })}
                      onChange={(value) => actions?.onDate?.(key, value)}
                    />
                    {problem ? (
                      <span className="fw-pdt-problem" role="alert">
                        {t(problem)}
                      </span>
                    ) : null}
                  </span>
                ),
              ],
            }
          })}
        />
      </section>

      <div className="fw-pdt-dialog-part">
        <Field label={t('repromise.reason')} hint={t('repromise.reasonHint')} error={problems.reason && !problems.nothing ? t(problems.reason) : undefined} required>
          <Listbox options={reasonOptions} value={form.reasonCode || undefined} placeholder={t('repromise.reasonPick')} ariaLabel={t('repromise.reason')} onChange={(value) => actions?.onForm?.({ reasonCode: value })} disabled={!mayPropose} />
        </Field>
        <Field label={t('repromise.note')} hint={t('repromise.noteHint')}>
          <Input value={form.note} maxLength={2000} onChange={(event) => actions?.onForm?.({ note: event.target.value })} disabled={!mayPropose} />
        </Field>
      </div>

      <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-rp-message">
        <h3 id="fw-pdt-rp-message" className="fw-pdt-h3">
          {t('repromise.message', { language: t(`language.${draft.language}`) })}
        </h3>
        <p className="fw-pdt-hint">{draft.recipients.length > 0 ? t('repromise.recipients', { to: draft.recipients.join(', ') }) : t('repromise.noRecipients')}</p>
        <label className="fw-pdt-toggle">
          <Toggle checked={form.own} onChange={(next) => actions?.onForm?.({ own: next })} disabled={!mayPropose} aria-label={t('repromise.ownWords')} />
          <span>{t('repromise.ownWords')}</span>
        </label>
        {form.own ? (
          <>
            <Field label={t('repromise.subject')} error={problems.message ? t(problems.message) : undefined}>
              <Input value={form.subject} maxLength={200} onChange={(event) => actions?.onForm?.({ subject: event.target.value })} />
            </Field>
            <Field label={t('repromise.body')}>
              <Textarea value={form.body} rows={8} maxLength={10_000} onChange={(event) => actions?.onForm?.({ body: event.target.value })} />
            </Field>
          </>
        ) : draft.message ? (
          <div className="fw-pdt-mail" lang={draft.language}>
            <b>{draft.message.subject}</b>
            <p className="fw-pdt-mail-body">{draft.message.body}</p>
          </div>
        ) : (
          <p className="fw-pdt-hint">{t('repromise.noPreview')}</p>
        )}
        {!form.own && stale && draft.message && <p className="fw-pdt-hint">{t('repromise.previewStale')}</p>}
      </section>

      <Banner tone="info" title={t('repromise.whatHappens')}>
        {t('repromise.whatHappensBody')}
      </Banner>
    </div>
  )
}

function ProposeFooter({ model, dialog, draft, form, actions, words }: { model: PromiseModel; dialog: RepromiseDialog; draft: RepromiseDraft; form: RepromiseForm; actions?: PromiseActions; words: Words }) {
  const { t } = words
  const problems = formProblems(draft, form)
  const held = !model.can.manage ? 'held.noManage' : !draft.may.propose ? 'held.mayNot' : dialog.busy ? 'held.busy' : formHeld(problems)
  return (
    <>
      <Button onClick={() => actions?.onRepromise?.(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onPropose?.()}>
        {dialog.busy === 'propose' ? <Spinner size={12} /> : <Send size={14} aria-hidden />} {t('repromise.send')}
      </Button>
    </>
  )
}

// ---- sales' word on a proposal that waits ------------------------------------------------------------------------------------

function DecisionView({ model, dialog, draft, proposal, actions, words }: { model: PromiseModel; dialog: RepromiseDialog; draft: RepromiseDraft; proposal: Proposal; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const holds = decisionHolds(proposal, model.can, model.me)
  const mtm = draft.line.kind === 'MADE_TO_MEASURE'
  const reason = draft.reasons.find((entry) => entry.code === proposal.reasonCode)
  const own = proposal.proposedBy?.id === model.me
  return (
    <div className="fw-pdt-dialog">
      <ProblemBanner dialog={dialog} words={words} />
      <Banner tone="info" title={t('decide.waiting', { time: formatDateTime(proposal.proposedAt, { locale }) })}>
        {[proposal.proposedBy ? t(own ? 'decide.byYou' : 'decide.by', { name: proposal.proposedBy.name }) : null, proposal.task.assignee ? t('decide.assignee', { name: proposal.task.assignee.name }) : t('decide.noAssignee')].filter(Boolean).join(' · ')}
      </Banner>
      <SummaryTable
        label={t('decide.sizes')}
        columns={[t('repromise.col.size'), t('repromise.col.now'), t('repromise.col.new')]}
        stackOnPhone
        rows={proposal.sizes.map((entry) => ({ id: sizeKey(entry.size), cells: [sizeName(entry.size, t, mtm), dayWords(entry.from, locale, true), <b key="to">{dayWords(entry.to, locale, true)}</b>] }))}
      />
      <div className="fw-pdt-form-grid">
        <Field label={t('repromise.reason')}>
          <span>{reason ? reason[locale] : t('decide.reasonOther')}</span>
        </Field>
        {proposal.reason ? (
          <Field label={t('repromise.note')}>
            <span>{proposal.reason}</span>
          </Field>
        ) : null}
      </div>
      <section className="fw-pdt-dialog-part" aria-labelledby="fw-pdt-dc-message">
        <h3 id="fw-pdt-dc-message" className="fw-pdt-h3">
          {t('repromise.message', { language: t(`language.${proposal.message.language}`) })}
        </h3>
        <p className="fw-pdt-hint">{proposal.recipients.length > 0 ? t('repromise.recipients', { to: proposal.recipients.join(', ') }) : t('repromise.noRecipients')}</p>
        <div className="fw-pdt-mail" lang={proposal.message.language}>
          <b>{proposal.message.subject}</b>
          <p className="fw-pdt-mail-body">{proposal.message.body}</p>
        </div>
        <label className="fw-pdt-toggle">
          <Toggle checked={dialog.tell && !holds.tell} onChange={(next) => actions?.onTell?.(next)} disabled={holds.tell !== null} aria-label={t('decide.tell')} />
          <span>{t('decide.tell')}</span>
          {holds.tell && holds.accept === null ? <span className="fw-pdt-hint">— {t(holds.tell)}</span> : null}
        </label>
      </section>
      {dialog.declining && (
        <Field label={t('decide.declineReason')} hint={t('decide.declineHint')} required>
          <Textarea value={dialog.declineReason} rows={3} maxLength={2000} onChange={(event) => actions?.onDeclineReason?.(event.target.value)} />
        </Field>
      )}
      <Banner tone="info" title={t('repromise.whatHappens')}>
        {t('decide.whatHappens')}
      </Banner>
    </div>
  )
}

function DecisionFooter({ model, dialog, proposal, actions, words }: { model: PromiseModel; dialog: RepromiseDialog; proposal: Proposal; actions?: PromiseActions; words: Words }) {
  const { t } = words
  const holds = decisionHolds(proposal, model.can, model.me)
  const busy = dialog.busy ? t('held.busy') : null
  const own = proposal.proposedBy?.id === model.me
  if (dialog.declining) {
    return (
      <>
        <Button onClick={() => actions?.onDeclining?.(false)}>{t('common.back')}</Button>
        <Button variant="primary" tone="danger" heldReason={holds.decline ? t(holds.decline) : busy ?? (dialog.declineReason.trim() ? null : t('held.declineReason'))} onClick={() => actions?.onDecline?.()}>
          {dialog.busy === 'decline' ? <Spinner size={12} /> : <X size={14} aria-hidden />} {t('decide.decline')}
        </Button>
      </>
    )
  }
  return (
    <>
      {own || model.can.manage ? (
        <Button heldReason={holds.withdraw ? t(holds.withdraw) : busy} onClick={() => actions?.onWithdraw?.()}>
          {dialog.busy === 'withdraw' ? <Spinner size={12} /> : <Undo2 size={14} aria-hidden />} {t('decide.withdraw')}
        </Button>
      ) : null}
      <Button heldReason={holds.decline ? t(holds.decline) : busy} onClick={() => actions?.onDeclining?.(true)}>
        <X size={14} aria-hidden /> {t('decide.declineOpen')}
      </Button>
      <Button variant="primary" heldReason={holds.accept ? t(holds.accept) : busy} onClick={() => actions?.onAccept?.()}>
        {dialog.busy === 'accept' ? <Spinner size={12} /> : <Check size={14} aria-hidden />} {dialog.tell && !holds.tell ? t('decide.acceptTell') : t('decide.accept')}
      </Button>
    </>
  )
}

// ---- what happened ---------------------------------------------------------------------------------------------------------

function DoneView({ dialog, draft, words }: { dialog: RepromiseDialog; draft: RepromiseDraft; words: Words }) {
  const { t, locale } = words
  const done = dialog.done!
  const mtm = draft.line.kind === 'MADE_TO_MEASURE'
  const sizes = done.proposal.sizes.map((entry) => t('history.move', { size: sizeName(entry.size, t, mtm), from: dayWords(entry.from, locale, true), to: dayWords(entry.to, locale, true) })).join(', ')
  const body =
    done.kind === 'proposed'
      ? t('done.proposedBody', { who: done.proposal.task.assignee?.name ?? t('done.sales') })
      : done.kind === 'accepted'
        ? [done.answer?.told ? t('done.told', { to: done.proposal.recipients.join(', ') }) : t('done.notTold'), done.answer?.lineDate ? t('done.lineDate', { day: dayWords(done.answer.lineDate, locale, true) }) : null].filter(Boolean).join(' ')
        : done.kind === 'declined'
          ? t('done.declinedBody')
          : t('done.withdrawnBody')
  return (
    <div className="fw-pdt-dialog">
      <Banner tone="success" title={t(`done.${done.kind}`)}>
        {sizes}
      </Banner>
      <p className="fw-pdt-text">{body}</p>
    </div>
  )
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
