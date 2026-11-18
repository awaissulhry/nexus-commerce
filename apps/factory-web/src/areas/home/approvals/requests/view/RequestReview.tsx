'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, ExternalLink, Layers, MessageSquareReply, X, Zap } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { DateField, DetailModal, Modal, ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { RequestCard } from '../../../../../lib/production/view/RequestCard'
import { useProductionWords } from '../../../../../lib/production/words'
import { money } from '../../../../sales/quotes/model'
import { openIdOf } from '../../inbox'
import { DEPTH_NS, type InboxActions, type InboxViewModel } from '../../model'
import type { BrandRequest } from '../api'
import {
  answerHeld,
  cardInputOf,
  counterHeld,
  CR,
  EMPTY_COUNTER,
  hasTwoAccepts,
  heldFollowUpOf,
  liftHeld,
  refusalKeyOf,
  REQUEST_LIMITS,
  said,
  teamOf,
  type CounterDraft,
  type FollowUp,
  type RequestReviewModel,
} from '../model'

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
const STANDING_TONE: Readonly<Record<BrandRequest['status'], Tone>> = Object.freeze({ OPEN: 'warning', COUNTERED: 'info', ACCEPTED: 'success', REFUSED: 'danger', WITHDRAWN: 'neutral' })

/** A, R are the window's keys — never while typing, never with a dialog open. */
const typing = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return element !== null && (element.closest('input, textarea, select, [contenteditable="true"]') !== null || element.isContentEditable)
}

/**
 * F-PR-08 — a customer's request in Home › Approvals' review window, built on today's window (the DS DetailModal of the task review;
 * threads re-frame it later). `?open=<request id>`: the request in the customer's words and the impact read now (the shared
 * RequestCard, office face: what it changes old → new, their words, what is already fixed, the earliest date, a price — the amount
 * only with the price grain), our counter-offer and their answer, what accepting does, the order's work orders this reader reaches
 * (the others counted, never named), the words the customer reads with their preview; Accept (A) — "Urgent – asked": Accept as
 * urgent / Accept and rush the floor —, Suggest something else, Refuse (R), each held with its reason before the click.
 * `?open=<batch id>`: the batch's orders (each answered alone from its row) and Accept all / Refuse all, each re-checked first.
 * It fetches nothing (Approvals.tsx and use-request-review load it).
 */
export function RequestReview({ model, actions }: { model: InboxViewModel; actions?: InboxActions }) {
  const review = model.requestReview
  if (!review) return null
  return review.as === 'batch' ? <BatchReview model={model} review={review} actions={actions} /> : <OneReview model={model} review={review} actions={actions} />
}

const navOf = (model: InboxViewModel, id: string, onGo: ((id: string | null) => void) | undefined, noun: string) => {
  const ids = (model.rows.items ?? []).map(openIdOf).filter((entry): entry is string => entry !== null)
  return ids.length > 1 && ids.includes(id) && onGo ? { ids, current: id, onGo: (next: string) => onGo(next), noun } : undefined
}

/** The words the customer reads: one field for Accept (optional) and Refuse (required), with their preview. */
function WordsField({ words, onWords, required }: { words: string; onWords: (value: string) => void; required: boolean }) {
  const t = useT('approvals')
  return (
    <>
      <Field label={t(`${CR}.words.label`)} hint={t(required ? `${CR}.words.hintBatch` : `${CR}.words.hint`)}>
        <Textarea value={words} onChange={(event) => onWords(event.target.value)} rows={3} maxLength={REQUEST_LIMITS.answer} />
      </Field>
      <p className="fw-apv-hint" aria-live="polite">
        {words.trim() ? t(`${CR}.words.preview`, { words: words.trim() }) : t(`${CR}.words.none`)}
      </p>
    </>
  )
}

// ---- one request -------------------------------------------------------------------------------------------------------------

function OneReview({ model, review, actions }: { model: InboxViewModel; review: Extract<RequestReviewModel, { as: 'request' }>; actions?: InboxActions }) {
  const t = useT('approvals')
  const depth = useT(DEPTH_NS)
  const sales = useT('sales')
  const w = useProductionWords()
  const locale = useLocale()
  const record = review.record.status === 'ready' ? review.record.value : null
  const request = record?.request ?? null
  const impact = review.impact.status === 'ready' ? review.impact.value : null
  const [words, setWords] = useState(review.words)
  useEffect(() => setWords(review.words), [review.id, review.words])
  const onWords = (value: string) => {
    setWords(value)
    actions?.request?.onWords?.(value)
  }
  const state = { offline: model.offline, busy: model.busy }
  const heldKey = (answer: 'accept' | 'refuse' | 'counter') => (request ? answerHeld(request, answer, state, words) : `${CR}.held.reading`)
  const acceptHeld = heldKey('accept')
  const refuseHeld = heldKey('refuse')
  const counterHeldKey = heldKey('counter')
  const waiting = request !== null && (request.status === 'OPEN' || request.status === 'COUNTERED')
  const answering = waiting && request.waitingOn === 'US' && (request.may.accept || request.may.refuse || request.may.counter)
  // Why it cannot be accepted as it stands (its state, our counter, who answers its kind) — said once in the window, not only on hover.
  const standingHeld = request && waiting ? answerHeld(request, 'accept', { offline: false, busy: false }, 'words') : null
  const dialog = review.dialog
  const accept = (rushFloor: boolean) => {
    if (acceptHeld || dialog) return
    actions?.request?.onAccept?.(rushFloor)
  }
  const refuse = () => {
    if (refuseHeld || dialog) return
    actions?.request?.onRefuse?.()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || dialog || typing(event.target)) return
      if (event.key === 'a') {
        event.preventDefault()
        accept(false)
      } else if (event.key === 'r') {
        event.preventDefault()
        refuse()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const kind = request ? w.t(`parts.request.kind.${request.kind}`) : ''
  const title = request ? t(`${CR}.review.title`, { kind, order: request.orderNumber }) : t(`${CR}.review.titleUnknown`)
  const subtitle = request ? [request.party.name, request.customerRef ? t(`${CR}.review.po`, { ref: request.customerRef }) : null].filter(Boolean).join(' · ') : undefined
  const loading = review.record.status === 'loading'
  const error = review.record.status === 'error' ? sales(review.record.problem) : review.record.status === 'not_found' ? t(`${CR}.review.notFound`) : review.record.status === 'forbidden' ? t(`${CR}.review.forbidden`) : undefined
  const input = request ? cardInputOf(request, impact, { say: t, locale, day: w.day, money: (minor, currency) => money(minor, currency, locale) }) : null
  const lift = request && review.can.lift ? heldFollowUpOf(request, impact) : null
  const orderHref = request ? (review.orderHrefs[request.orderId] ?? null) : null
  const two = request !== null && hasTwoAccepts(request)

  const footer =
    request && answering ? (
      <>
        <Button size="sm" variant="danger-outline" heldReason={refuseHeld ? t(refuseHeld) : null} onClick={refuse} aria-keyshortcuts="r">
          <X size={14} aria-hidden /> {t(`${CR}.refuse`)} <Kbd>R</Kbd>
        </Button>
        <Button size="sm" heldReason={counterHeldKey ? t(counterHeldKey) : null} onClick={() => !counterHeldKey && !dialog && actions?.request?.onCounter?.()}>
          <MessageSquareReply size={14} aria-hidden /> {t(`${CR}.counter.open`)}
        </Button>
        {two ? (
          <>
            <Button size="sm" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => accept(true)}>
              <Zap size={14} aria-hidden /> {t(`${CR}.acceptRush`)}
            </Button>
            <Button size="sm" variant="primary" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => accept(false)} aria-keyshortcuts="a">
              <Check size={14} aria-hidden /> {t(`${CR}.acceptUrgent`)} <Kbd>A</Kbd>
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => accept(false)} aria-keyshortcuts="a">
            <Check size={14} aria-hidden /> {t(`${CR}.accept`)} <Kbd>A</Kbd>
          </Button>
        )}
      </>
    ) : undefined

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpen?.(null)}
        title={title}
        subtitle={subtitle}
        meta={
          request ? (
            <>
              <Pill tone={STANDING_TONE[request.status]}>{said(request.standing, locale)}</Pill>
              {request.batch && request.batch.count > 1 && <Tag tone="info">{t(`${CR}.review.inBatch`, { count: request.batch.count })}</Tag>}
            </>
          ) : undefined
        }
        nav={navOf(model, review.id, actions?.onOpen, depth('review.noun'))}
        loading={loading && !request}
        error={error}
        onRetry={() => actions?.request?.onRetry?.()}
        actions={footer}
      >
        {request && input && (
          <div className="fw-apv-review">
            <Banner tone="info" title={t(`${CR}.review.asked`, { customer: request.party.name, who: request.askedBy ?? request.party.name, at: formatDateTime(request.askedAt, { locale }) })}>
              {request.reasonWords ? t(`${CR}.review.why`, { reason: said(request.reasonWords, locale) }) : undefined}
            </Banner>
            {review.problem && <Banner tone="danger" title={t(review.problem)} />}
            {standingHeld && <Banner tone="warning" title={t(standingHeld)} />}
            <RequestCard face="office" request={input} />
            {impact?.now.blocked && <Banner tone="warning" title={t(`${CR}.impact.blocked`)} />}
            {impact && (impact.now.notes.length > 0 || impact.now.earliest || impact.now.pricedWords) && (
              <ul className="fw-apv-list">
                {impact.now.earliest && <li>{said(impact.now.earliest.words, locale)}</li>}
                {impact.now.pricedWords && <li>{said(impact.now.pricedWords, locale)}</li>}
                {impact.now.notes.map((note, index) => (
                  <li key={index}>{said(note, locale)}</li>
                ))}
              </ul>
            )}
            {review.impact.status === 'error' && <p className="fw-apv-hint">{t(`${CR}.impact.notRead`)}</p>}
            {request.counter && (
              <Banner tone={request.counter.state === 'AGREED' ? 'success' : request.counter.state === 'WAITING' ? 'info' : 'warning'} title={said(request.counter.offer, locale)}>
                {[said(request.counter.words, locale), record?.counterApproval?.answer ? t(`${CR}.counter.theirWords`, { words: record.counterApproval.answer }) : null].filter(Boolean).join(' · ')}
              </Banner>
            )}
            <section aria-labelledby="fw-apv-cr-does">
              <h3 id="fw-apv-cr-does" className="fw-apv-h">
                {t(`${CR}.does.title`)}
              </h3>
              <p className="fw-apv-hint">{said(request.acceptWords, locale)}</p>
              {two && (
                <ul className="fw-apv-list">
                  <li>{t(`${CR}.does.urgent`)}</li>
                  <li>{t(`${CR}.does.rushFloor`)}</li>
                </ul>
              )}
              <p className="fw-apv-hint">{t(`${CR}.team.${teamOf(request.answeredWith)}`)}</p>
            </section>
            {impact && (impact.workOrders.length > 0 || impact.workOrdersNotShown > 0) && (
              <section aria-labelledby="fw-apv-cr-wo">
                <h3 id="fw-apv-cr-wo" className="fw-apv-h">
                  {t(`${CR}.workOrders.title`)}
                </h3>
                <ul className="fw-apv-list">
                  {impact.workOrders.map((workOrder) => (
                    <li key={workOrder.id}>
                      {[workOrder.number, workOrder.held ? t(`${CR}.workOrders.held`) : null, workOrder.mixed ? t(`${CR}.workOrders.mixed`) : null].filter(Boolean).join(' · ')}
                    </li>
                  ))}
                </ul>
                {impact.workOrdersNotShown > 0 && <p className="fw-apv-hint">{t(`${CR}.workOrders.notShown`, { count: impact.workOrdersNotShown })}</p>}
              </section>
            )}
            {request.batch && request.batch.count > 1 && request.batchId && (
              <p className="fw-apv-hint">
                {t(`${CR}.review.batchLine`, { count: request.batch.count, waiting: request.batch.waiting })}{' '}
                <Button size="sm" variant="link" inline onClick={() => actions?.onOpen?.(request.batchId)}>
                  <Layers size={12} aria-hidden /> {t(`${CR}.review.openBatch`)}
                </Button>
              </p>
            )}
            {answering && <WordsField words={words} onWords={onWords} required={false} />}
            {lift && (
              <Button size="sm" onClick={() => actions?.request?.onLift?.(lift)} heldReason={model.offline ? t(`${CR}.held.offline`) : null}>
                {t(`${CR}.followUp.lift`)}
              </Button>
            )}
            {orderHref && (
              <Button size="sm" variant="quiet" asChild>
                <Link href={orderHref}>
                  <ExternalLink size={14} aria-hidden /> {t(`${CR}.review.openOrder`, { order: request.orderNumber })}
                </Link>
              </Button>
            )}
          </div>
        )}
      </DetailModal>
      {request && dialog?.kind === 'counter' && <CounterDialog request={request} today={review.today} price={model.grains.price} busy={dialog.busy} problem={dialog.problem} initialNote={words} actions={actions} />}
    </>
  )
}

/** "Suggest something else" (a counter-offer the customer answers): a date, a fee (price grain only), our words — at least one. */
function CounterDialog({ request, today, price, busy, problem, initialNote, actions }: { request: BrandRequest; today: string; price: boolean; busy: boolean; problem: string | null; initialNote: string; actions?: InboxActions }) {
  const t = useT('approvals')
  const w = useProductionWords()
  const withPrice = price && request.may.counterWithPrice
  const [draft, setDraft] = useState<CounterDraft>({ ...EMPTY_COUNTER, note: initialNote })
  const heldKey = counterHeld(draft, { withPrice, today }) ?? (busy ? `${CR}.held.busy` : null)
  const send = () => {
    if (heldKey) return
    actions?.request?.onCounterSend?.(draft)
  }
  const currency = request.cancelFee?.currency ?? null
  return (
    <Modal
      open
      onClose={() => actions?.request?.onCloseDialog?.()}
      title={t(`${CR}.counter.title`, { order: request.orderNumber })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.request?.onCloseDialog?.()}>{t(`${CR}.back`)}</Button>
          <Button variant="primary" heldReason={heldKey ? t(heldKey) : null} onClick={send}>
            {t(`${CR}.counter.send`)}
          </Button>
        </>
      }
    >
      <div
        className="fw-apv-review"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
      >
        <p className="fw-apv-hint">{t(`${CR}.counter.body`)}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
        <Field label={t(`${CR}.counter.date`)} hint={t(`${CR}.counter.dateHint`)}>
          <DateField value={draft.date} min={today} onChange={(value) => setDraft({ ...draft, date: value })} clearable />
        </Field>
        {withPrice ? (
          <Field label={t(`${CR}.counter.fee`)} hint={t(`${CR}.counter.feeHint`)}>
            <Input value={draft.fee} inputMode="decimal" onChange={(event) => setDraft({ ...draft, fee: event.target.value })} {...(currency ? { prefix: currency } : {})} />
          </Field>
        ) : (
          <p className="fw-apv-hint">{t(`${CR}.counter.noFee`)}</p>
        )}
        <Field label={t(`${CR}.counter.note`)}>
          <Textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} rows={3} maxLength={REQUEST_LIMITS.note} />
        </Field>
        <p className="fw-apv-hint" aria-live="polite">
          {t(`${CR}.counter.preview`, {
            date: draft.date ? w.day(draft.date) : '—',
            priced: withPrice && draft.fee.trim() ? t(`${CR}.counter.priced`) : t(`${CR}.counter.notPriced`),
          })}
        </p>
      </div>
    </Modal>
  )
}

// ---- a batch -----------------------------------------------------------------------------------------------------------------

function BatchReview({ model, review, actions }: { model: InboxViewModel; review: Extract<RequestReviewModel, { as: 'batch' }>; actions?: InboxActions }) {
  const t = useT('approvals')
  const depth = useT(DEPTH_NS)
  const sales = useT('sales')
  const w = useProductionWords()
  const locale = useLocale()
  const requests = review.batch.status === 'ready' ? review.batch.value : null
  const lead = requests?.[0] ?? null
  const [words, setWords] = useState(review.words)
  useEffect(() => setWords(review.words), [review.id, review.words])
  const onWords = (value: string) => {
    setWords(value)
    actions?.request?.onWords?.(value)
  }
  const state = { offline: model.offline, busy: model.busy }
  const waiting = (requests ?? []).filter((request) => request.waitingOn === 'US')
  // Accept all / Refuse all: held while none of the batch may be answered so (each is checked again when read before the answer).
  const heldAll = (answer: 'accept' | 'refuse'): string | null => {
    if (!lead) return `${CR}.held.reading`
    const first = waiting.find((request) => answerHeld(request, answer, state, answer === 'refuse' ? words : 'words') === null)
    if (first) return null
    return waiting[0] ? answerHeld(waiting[0], answer, state, words) : `${CR}.held.noneWaiting`
  }
  const acceptHeld = heldAll('accept')
  const refuseHeld = heldAll('refuse')
  const kind = lead ? w.t(`parts.request.kind.${lead.kind}`) : ''
  const two = lead !== null && hasTwoAccepts(lead)
  const dialog = review.dialog
  const open = (answer: 'accept' | 'refuse', rushFloor: boolean) => {
    if ((answer === 'accept' ? acceptHeld : refuseHeld) || dialog) return
    actions?.request?.onBatch?.(answer, rushFloor)
  }
  const error = review.batch.status === 'error' ? sales(review.batch.problem) : review.batch.status === 'not_found' ? t(`${CR}.review.notFound`) : review.batch.status === 'forbidden' ? t(`${CR}.review.forbidden`) : undefined

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpen?.(null)}
        title={lead ? t(`${CR}.batch.title`, { kind, count: requests!.length }) : t(`${CR}.review.titleUnknown`)}
        subtitle={lead ? lead.party.name : undefined}
        meta={lead ? <Tag tone="info">{t(`${CR}.batch.waiting`, { count: waiting.length, total: requests!.length })}</Tag> : undefined}
        nav={navOf(model, review.id, actions?.onOpen, depth('review.noun'))}
        loading={review.batch.status === 'loading' && !requests}
        error={error}
        onRetry={() => actions?.request?.onRetry?.()}
        actions={
          lead && waiting.length > 0 ? (
            <>
              <Button size="sm" variant="danger-outline" heldReason={refuseHeld ? t(refuseHeld) : null} onClick={() => open('refuse', false)}>
                <X size={14} aria-hidden /> {t(`${CR}.batch.refuseAll`, { count: waiting.length })}
              </Button>
              {two ? (
                <>
                  <Button size="sm" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => open('accept', true)}>
                    <Zap size={14} aria-hidden /> {t(`${CR}.batch.acceptAllRush`, { count: waiting.length })}
                  </Button>
                  <Button size="sm" variant="primary" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => open('accept', false)}>
                    <Check size={14} aria-hidden /> {t(`${CR}.batch.acceptAllUrgent`, { count: waiting.length })}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="primary" heldReason={acceptHeld ? t(acceptHeld) : null} onClick={() => open('accept', false)}>
                  <Check size={14} aria-hidden /> {t(`${CR}.batch.acceptAll`, { count: waiting.length })}
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {lead && requests && (
          <div className="fw-apv-review">
            <Banner tone="info" title={t(`${CR}.batch.asked`, { customer: lead.party.name, count: requests.length, kind: kind.toLocaleLowerCase(locale) })}>
              {said(lead.acceptWords, locale)}
            </Banner>
            {review.problem && <Banner tone="danger" title={t(review.problem)} />}
            {two && (
              <ul className="fw-apv-list">
                <li>{t(`${CR}.does.urgent`)}</li>
                <li>{t(`${CR}.does.rushFloor`)}</li>
              </ul>
            )}
            <SummaryTable
              label={t(`${CR}.batch.orders`)}
              columns={[t(`${CR}.batch.col.order`), t(`${CR}.batch.col.po`), t(`${CR}.batch.col.state`), t(`${CR}.batch.col.asked`), t(`${CR}.batch.col.answer`)]}
              rows={requests.map((request) => ({
                id: request.id,
                cells: [
                  review.orderHrefs[request.orderId] ? (
                    <Link key="o" className="fw-apv-link" href={review.orderHrefs[request.orderId]!}>
                      {request.orderNumber}
                    </Link>
                  ) : (
                    request.orderNumber
                  ),
                  request.customerRef ?? '—',
                  <Pill key="s" tone={STANDING_TONE[request.status]}>
                    {said(request.standing, locale)}
                  </Pill>,
                  formatDateTime(request.askedAt, { locale }),
                  request.waitingOn === 'US' ? (
                    <Button key="a" size="sm" variant="link" inline onClick={() => actions?.onOpen?.(request.id)}>
                      {t(`${CR}.batch.answerAlone`)}
                    </Button>
                  ) : (
                    '—'
                  ),
                ],
              }))}
              density="roomy"
              stackOnPhone
            />
            <p className="fw-apv-hint">{t(`${CR}.batch.recheck`)}</p>
            <p className="fw-apv-hint">{t(`${CR}.team.${teamOf(lead.answeredWith)}`)}</p>
            {waiting.length > 0 && <WordsField words={words} onWords={onWords} required />}
          </div>
        )}
      </DetailModal>
      {lead && dialog?.kind === 'batch' && <BatchAnswerDialog review={review} kind={kind} words={words} offline={model.offline} actions={actions} />}
    </>
  )
}

/**
 * Accept all / Refuse all (as Approve N, B-W2b-307): the batch read again, each request checked — the current ones listed "Waiting →
 * Accepted", one answered meanwhile, withdrawn or not ours to answer left out with why —, then answered one by one at the version
 * read (each still refused by the API if it moved in between), and the done screen says what became of each, in our words.
 */
function BatchAnswerDialog({ review, kind, words, offline, actions }: { review: Extract<RequestReviewModel, { as: 'batch' }>; kind: string; words: string; offline: boolean; actions?: InboxActions }) {
  const t = useT('approvals')
  const locale = useLocale()
  const dialog = review.dialog
  if (dialog?.kind !== 'batch') return null
  const lines = dialog.lines ?? []
  const current = lines.filter((line) => line.leftOut === null)
  const leftOut = lines.filter((line) => line.leftOut !== null)
  const accept = dialog.answer === 'accept'
  const verb = accept ? (dialog.rushFloor ? t(`${CR}.batch.nextRush`) : t(`${CR}.batch.nextAccepted`)) : t(`${CR}.batch.nextRefused`)
  const phase = dialog.state
  const state =
    phase.phase === 'done'
      ? {
          phase: 'done' as const,
          results: Object.fromEntries(Object.entries(phase.results).map(([id, result]) => [id, { ok: result.ok, words: result.ok ? (result.words ? said(result.words, locale) : verb) : t(refusalKeyOf(result.code)) }])),
        }
      : phase.phase === 'failed'
        ? { phase: 'failed' as const, error: t(phase.problem) }
        : phase.phase === 'ready' && dialog.lines === null
          ? { phase: 'reading' as const }
          : phase
  const problems = [...(offline ? [t(`${CR}.held.offline`)] : []), ...(!accept && words.trim() === '' ? [t(`${CR}.held.words`)] : []), ...(current.length === 0 && dialog.lines !== null ? [t(`${CR}.held.noneCurrent`)] : [])]
  const lead: ReactNode =
    leftOut.length > 0 ? (
      <div className="fw-apv-review">
        <p className="fw-apv-h">{t(`${CR}.batch.leftOut`, { count: leftOut.length })}</p>
        <ul className="fw-apv-list">
          {leftOut.map((line) => (
            <li key={line.requestId}>
              {line.orderNumber} — {t(line.leftOut!)}
            </li>
          ))}
        </ul>
      </div>
    ) : undefined
  return (
    <ReviewChangesModal
      open
      onClose={() => actions?.request?.onCloseDialog?.()}
      title={t(accept ? `${CR}.batch.acceptTitle` : `${CR}.batch.refuseTitle`, { count: current.length, kind })}
      summary={words.trim() ? t(`${CR}.words.preview`, { words: words.trim() }) : t(`${CR}.words.none`)}
      changes={current.map((line) => ({ id: line.requestId, where: line.orderNumber, what: kind, now: t(`${CR}.batch.now`), next: verb, ...(line.customerRef ? { note: t(`${CR}.review.po`, { ref: line.customerRef }) } : {}) }))}
      problems={problems}
      saveLabel={t(accept ? `${CR}.batch.acceptSave` : `${CR}.batch.refuseSave`, { count: current.length })}
      ackLabel={t(`${CR}.batch.ack`)}
      lead={lead}
      state={state}
      onSave={() => actions?.request?.onBatchConfirm?.()}
      onRetry={() => actions?.request?.onBatch?.(dialog.answer, dialog.rushFloor)}
      doneVerb={accept ? t(`${CR}.batch.doneAccepted`) : t(`${CR}.batch.doneRefused`)}
      size="lg"
    />
  )
}

// ---- after an accept: Lift the hold (R-23) -----------------------------------------------------------------------------------------

/** "Lift the hold": why (the office's own words), then each work order's pause of this request lifted. */
export function LiftDialog({ followUp, busy, problem, actions }: { followUp: FollowUp; busy: boolean; problem: string | null; actions?: InboxActions }) {
  const t = useT('approvals')
  const [reason, setReason] = useState('')
  const heldKey = liftHeld(reason, busy)
  const go = () => {
    if (heldKey) return
    actions?.onLiftConfirm?.(reason)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t(`${CR}.lift.title`)}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{t(`${CR}.back`)}</Button>
          <Button variant="primary" heldReason={heldKey ? t(heldKey) : null} onClick={go}>
            {t(`${CR}.followUp.lift`)}
          </Button>
        </>
      }
    >
      <div className="fw-apv-review">
        <p className="fw-apv-hint">{t(`${CR}.lift.body`, { orders: followUp.workOrders.map((workOrder) => workOrder.number).join(', ') })}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
        <Field label={t(`${CR}.lift.reason`)} required hint={t(`${CR}.lift.reasonHint`)}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={REQUEST_LIMITS.lift} />
        </Field>
      </div>
    </Modal>
  )
}

/** The notice's follow-up button: "Lift the hold" / "Clear rush" instead of a generic undo; held without its right (`may`). */
export function FollowUpButton({ followUp, offline, busy, may, actions }: { followUp: FollowUp; offline: boolean; busy: boolean; may: boolean; actions?: InboxActions }) {
  const t = useT('approvals')
  const heldKey = !may ? `${CR}.followUp.held.${followUp.kind}` : offline ? `${CR}.held.offline` : busy ? `${CR}.held.busy` : null
  return (
    <Button size="sm" heldReason={heldKey ? t(heldKey) : null} onClick={() => !heldKey && actions?.onFollowUp?.(followUp)}>
      {t(followUp.kind === 'lift' ? `${CR}.followUp.lift` : `${CR}.followUp.clearRush`)}
    </Button>
  )
}
