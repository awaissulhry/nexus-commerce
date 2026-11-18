'use client'

import { AlertCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useProductionPageWords } from '../../words'
import { PROBLEM_ORDERS_MAX, PROBLEM_TEXT_MAX, type PointerOption, type ProblemOrder, type ProblemOutcome } from '../model'
import '../problem.css'

/**
 * F-PR-24 — the "Report a problem" dialog (17-web-r2 §1.6; production plan §1, §3 "Issues"; review fixes R-41, R-42, R-43): a DS
 * Modal, a bottom sheet on a phone. It names the orders it is about (their PO first, then "Your order 12"), asks what is wrong
 * (required), and for ONE order what it is about (optional: a file we shared on the order or its lines, or a message of its
 * conversation; many orders: "Pick one order to point to a file or a message"); "We answer in this order's messages". Send writes
 * one message in each order's thread. Sending; not sent + Retry with the text kept; the result per order ("Waiting on us since
 * 16 Nov"); never who answers (whoever does signs with their name in the thread, as today). Draws one model; fetches nothing.
 */

export interface ReportProblemModel {
  readonly orders: readonly ProblemOrder[]
  /** How many past the 50 a report takes (Send is held with the words). */
  readonly over: number
  readonly text: string
  /** What it is about (ONE order): its files and messages; null for many orders. */
  readonly pointer: { readonly state: 'loading' | 'error' | 'ready'; readonly options: readonly PointerOption[]; readonly chosen: string | null } | null
  /** The person may point to something at all (it reads the order's files or conversation). */
  readonly pointerAsked: boolean
  readonly phase: 'edit' | 'sending' | 'failed' | 'done'
  /** Not sent: why, in our words (a key of `portal-production`), and whether Retry may help. */
  readonly failure: { readonly key: string; readonly retry: boolean } | null
  /** Why Send waits, in words; null: it may go. */
  readonly held: string | null
  /** Sent: what happened per order. */
  readonly outcome: ProblemOutcome | null
}

export interface ReportProblemActions {
  onText?: (text: string) => void
  onPointer?: (id: string | null) => void
  onRetryPointers?: () => void
  onSend?: () => void
  onClose?: () => void
}

export function ReportProblemDialog({ model, actions }: { model: ReportProblemModel; actions?: ReportProblemActions }) {
  const { t, day } = useProductionPageWords()
  const one = model.orders.length === 1 ? model.orders[0]! : null
  const sending = model.phase === 'sending'
  const done = model.phase === 'done'
  const footer = done ? (
    <Button variant="primary" onClick={() => actions?.onClose?.()}>
      {t('problem.close')}
    </Button>
  ) : (
    <>
      <Button onClick={() => actions?.onClose?.()} heldReason={sending ? t('problem.held.sending') : null}>
        {t('problem.cancel')}
      </Button>
      <Button variant="primary" heldReason={model.held} onClick={() => actions?.onSend?.()}>
        {sending ? <Spinner size={14} /> : null} {sending ? t('problem.sending') : model.phase === 'failed' && model.failure?.retry ? t('problem.retry') : t('problem.send')}
      </Button>
    </>
  )
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => actions?.onClose?.()}
      title={t('problem.title')}
      subtitle={one ? t('problem.aboutOne', { name: one.name }) : t('problem.aboutMany', { count: model.orders.length })}
      closeHeld={sending ? t('problem.held.sending') : null}
      footer={footer}
    >
      <div className="fw-pprob">
        {done && model.outcome ? (
          <Outcome outcome={model.outcome} day={day} />
        ) : (
          <>
            {!one && model.orders.length > 0 ? (
              <section className="fw-pprob-orders" aria-label={t('problem.ordersLabel')}>
                <ul className="fw-pprob-list">
                  {model.orders.map((order) => (
                    <li key={order.id}>{order.name}</li>
                  ))}
                </ul>
              </section>
            ) : null}
            {model.over > 0 ? <Banner tone="warning" title={t('problem.held.tooMany', { count: model.orders.length, max: PROBLEM_ORDERS_MAX })} /> : null}
            <Field label={t('problem.what')} required hint={t('problem.whatHint')}>
              <Textarea value={model.text} rows={4} limit={PROBLEM_TEXT_MAX} disabled={sending} onChange={(event) => actions?.onText?.(event.target.value)} />
            </Field>
            {one && model.pointer ? (
              <Pointer pointer={model.pointer} disabled={sending} actions={actions} />
            ) : !one && model.pointerAsked ? (
              <p className="fw-pprob-hint">{t('problem.pointer.pickOne')}</p>
            ) : null}
            <p className="fw-pprob-hint">{t(one ? 'problem.answerOne' : 'problem.answerMany')}</p>
            {model.phase === 'failed' && model.failure ? <Banner tone="danger" icon={<AlertCircle size={16} aria-hidden />} title={t(model.failure.key)}>{t('problem.kept')}</Banner> : null}
          </>
        )}
      </div>
    </Modal>
  )
}

/** What the message is about, for ONE order: a file we shared or a message of its conversation (optional). */
function Pointer({ pointer, disabled, actions }: { pointer: NonNullable<ReportProblemModel['pointer']>; disabled: boolean; actions?: ReportProblemActions }) {
  const { t } = useProductionPageWords()
  if (pointer.state === 'loading') {
    return (
      <div className="fw-pprob-stack" role="status" aria-label={t('problem.pointer.loading')}>
        <span className="fw-pprob-label">{t('problem.pointer.label')}</span>
        <Skeleton height={36} />
      </div>
    )
  }
  if (pointer.state === 'error') {
    return (
      <div className="fw-pprob-row" role="alert">
        <span className="fw-pprob-hint">{t('problem.pointer.failed')}</span>
        <Button size="sm" onClick={() => actions?.onRetryPointers?.()}>
          {t('problem.tryAgain')}
        </Button>
      </div>
    )
  }
  if (pointer.options.length === 0) return <p className="fw-pprob-hint">{t('problem.pointer.empty')}</p>
  const files = pointer.options.filter((option) => option.kind === 'file')
  const messages = pointer.options.filter((option) => option.kind === 'message')
  return (
    <Field label={t('problem.pointer.label')} hint={t('problem.pointer.hint')}>
      <Select value={pointer.chosen ?? ''} disabled={disabled} onChange={(event) => actions?.onPointer?.(event.target.value === '' ? null : event.target.value)}>
        <option value="">{t('problem.pointer.none')}</option>
        {files.length > 0 ? (
          <optgroup label={t('problem.pointer.files')}>
            {files.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {messages.length > 0 ? (
          <optgroup label={t('problem.pointer.messages')}>
            {messages.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  )
}

/** Sent: per order "Waiting on us since 16 Nov", what did not go and why; ids that were not its own only counted. */
function Outcome({ outcome, day }: { outcome: ProblemOutcome; day: (iso: string) => string }) {
  const { t } = useProductionPageWords()
  return (
    <div className="fw-pprob" role="status">
      {outcome.sent.length > 0 ? (
        <Banner tone="success" title={t('problem.result.sent', { count: outcome.sent.length })}>
          {t('problem.result.where')}
        </Banner>
      ) : null}
      <ul className="fw-pprob-list" aria-label={t('problem.result.label')}>
        {outcome.sent.map((entry) => (
          <li key={entry.id} className="fw-pprob-result">
            <span>{entry.name}</span>
            <span className="fw-pprob-hint">{t('problem.chip.waiting', { date: day(entry.since) })}</span>
          </li>
        ))}
        {outcome.notSent.map((entry) => (
          <li key={entry.id} className="fw-pprob-result is-not-sent">
            <span>{entry.name}</span>
            <span className="fw-pprob-hint">{t('problem.result.notSentWhy', { words: entry.words })}</span>
          </li>
        ))}
      </ul>
      {outcome.notFound > 0 ? <p className="fw-pprob-hint">{t('problem.result.notFound', { count: outcome.notFound })}</p> : null}
    </div>
  )
}
