'use client'

import { Check, Copy, Send, Undo2, X } from 'lucide-react'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Proposal, RepromiseDraft } from '../api'
import { certificateWords, dayWords, decisionHolds, formHeld, formProblems, movedSizes, previewStale, sizeKey, sizeName, type RepromiseForm, type Words } from '../model'
// ---- F-PR-20: "Ask the customer" on the accept, and the customer's answer on the proposal
import type { CustomerAnswerRead } from '../api'
import { acceptLabelKey, CUSTOMER_ANSWER_TONE } from '../model'
// ---- end F-PR-20
// F-PR-09: "Decide for <customer>" and "Reverse" on the customer's answer to the new date (the page's CustomerOverrideProvider draws them).
import { CustomerOverrideSlot } from '../../../_shared/customer-override/slot'
import type { PromiseActions, PromiseModel, RepromiseDialog } from '../view-model'
import { Listbox } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * The Re-promise modal (design planning.promise pop:repromise "Re-promise SO-1043", the row verb or `p`): the proposed day per
 * size from the plan (each changeable, or left as it is), the reason (Listbox, in the customer's curated words), the office's
 * note, the message to the customer (a preview in their language; other words may be written) and "What happens: sales
 * accepts; the customer sees it in the portal and gets the message" → Send to sales for acceptance. A line whose re-promise
 * already waits shows it instead, with sales' word: Accept (tell the customer now, by e-mail on the order's thread), Decline
 * (with the reason the planner reads), and the planner's Withdraw. Nobody decides their own proposal — the Owner included:
 * the button is held and says why. F-PR-20: sales may also "Ask the customer to accept the new date" (B-PR-28: the date stands
 * either way; a refusal puts a follow-up task on the order for us); after it, the customer's link is shown once (for a customer
 * who answers without the portal) and the proposal shows the customer's answer — also when its task opens a decided proposal.
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
    body = <DoneView dialog={dialog} draft={draft} actions={actions} words={words} />
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
  // F-PR-20: the proposal its task opened, decided since: its word and the customer's answer, above the line's dialog.
  if (dialog.opened && !dialog.done && draft) {
    body = (
      <div className="fw-pdt-dialog">
        <OpenedProposal proposal={dialog.opened} words={words} />
        {body}
      </div>
    )
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
        {/* F-PR-20: ask the customer to accept the new date (off by default; the date stands either way). */}
        <label className="fw-pdt-toggle">
          <Toggle checked={!!dialog.askBrand && !holds.accept} onChange={(next) => actions?.onAskBrand?.(next)} disabled={holds.accept !== null} aria-label={t('decide.askBrand')} />
          <span>{t('decide.askBrand')}</span>
        </label>
        <p className="fw-pdt-hint">{t('decide.askBrandHint')}</p>
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
        {dialog.busy === 'accept' ? <Spinner size={12} /> : <Check size={14} aria-hidden />} {t(acceptLabelKey(dialog.tell && !holds.tell, !!dialog.askBrand && !holds.accept)) /* F-PR-20 */}
      </Button>
    </>
  )
}

// ---- what happened ---------------------------------------------------------------------------------------------------------

function DoneView({ dialog, draft, actions, words }: { dialog: RepromiseDialog; draft: RepromiseDraft; actions?: PromiseActions; words: Words }) {
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
  // F-PR-20: asked the customer — its link once (a customer without the portal answers by it), then its answer on the proposal.
  const asked = done.kind === 'accepted' ? (done.answer?.brandAsk ?? null) : null
  const link = asked?.url ?? null
  const answer = done.proposal.customerAnswer ?? null
  return (
    <div className="fw-pdt-dialog">
      <Banner tone="success" title={t(`done.${done.kind}`)}>
        {sizes}
      </Banner>
      <p className="fw-pdt-text">{body}</p>
      {asked ? <p className="fw-pdt-text">{t('done.asked')}</p> : null}
      {link ? (
        <Banner
          tone="info"
          title={t('link.title')}
          action={
            <Button size="sm" onClick={() => actions?.onCopyLink?.(link)}>
              <Copy size={14} aria-hidden /> {t('link.copy')}
            </Button>
          }
        >
          <span className="fw-pdt-url">{link}</span>
          <span className="fw-pdt-hint">{t('link.once')}</span>
        </Banner>
      ) : null}
      {answer ? <CustomerAnswerPart answer={answer} customer={draft.customer.name} words={words} /> : null}
    </div>
  )
}

// ---- F-PR-20: the customer's answer on a proposal ------------------------------------------------------------------------------

/** The customer's answer to the new date: its state, when, its own words, the name it signed with, the follow-up task (ours). */
function CustomerAnswerPart({ answer, customer, words }: { answer: CustomerAnswerRead; customer: string; words: Words }) {
  const { t, locale } = words
  return (
    <section className="fw-pdt-dialog-part" aria-label={t('answer.title')}>
      <h3 className="fw-pdt-h3">{t('answer.title')}</h3>
      <span className="fw-pdt-cell-inline">
        <Pill tone={CUSTOMER_ANSWER_TONE[answer.state]}>{t(`answer.state.${answer.state}`)}</Pill>
        {answer.at ? <span className="fw-pdt-hint">{t('answer.at', { time: formatDateTime(answer.at, { locale }) })}</span> : null}
      </span>
      {answer.answer ? <p className="fw-pdt-text">{t('answer.words', { words: answer.answer })}</p> : null}
      {answer.typedName ? <p className="fw-pdt-hint">{t('answer.signed', { name: answer.typedName })}</p> : null}
      {answer.followUp ? <p className="fw-pdt-hint">{t(`answer.followUp.${answer.followUp.status}`)}</p> : null}
      {/* F-PR-09: decide it for the customer while it waits; reverse its answer (the date stands: they are asked again). */}
      <CustomerOverrideSlot source={{ requestId: answer.requestId }} customer={customer} version={`${answer.state}:${answer.at ?? ''}`} />
    </section>
  )
}

/** The proposal its task opened, decided since: its state and who decided when, then the customer's answer when asked. */
function OpenedProposal({ proposal, words }: { proposal: Proposal; words: Words }) {
  const { t, locale } = words
  const decision = proposal.decision
  const answer = proposal.customerAnswer ?? null
  return (
    <>
      <Banner tone="info" title={t('opened.title', { order: proposal.order.number, line: proposal.line.seq, state: t(`proposal.${proposal.state}`) })}>
        {decision ? (decision.by ? t('opened.decided', { time: formatDateTime(decision.at, { locale }), name: decision.by.name }) : t('opened.decidedNoName', { time: formatDateTime(decision.at, { locale }) })) : null}
      </Banner>
      {answer ? <CustomerAnswerPart answer={answer} customer={proposal.customer.name} words={words} /> : <p className="fw-pdt-hint">{t('opened.notAsked')}</p>}
    </>
  )
}
// ---- end F-PR-20

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
