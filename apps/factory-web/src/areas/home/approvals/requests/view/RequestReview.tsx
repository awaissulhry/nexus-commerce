'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, ExternalLink, Layers, MessageSquareReply, Settings2, X, Zap } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { DateField, DetailModal, Modal, ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { RequestCard } from '../../../../../lib/production/view/RequestCard'
import { useProductionWords } from '../../../../../lib/production/words'
import { money, type Grains } from '../../../../sales/quotes/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NS } from '../../model'
import type { BrandRequest } from '../api'
// F-PR-09: "Decide for <customer>" and "Reverse" on our counter-offer's approval (the page's CustomerOverrideProvider draws them).
// F-SA-240: a door's notice names the request in words as the inbox does.
import { requestWords } from '../../words/request-words'
// B-SA-046b: which pieces the customer's design change is for, in the same words for every reader.
import { DESIGN_APPLIES_WORDS } from '@nexus/factory-domain/sales/change-requests/rules'
import type { RequestNotice } from '../use-request-review'
import { CustomerOverrideSlot } from '../../../../_shared/customer-override/slot'
// F-SA-241: the window's new parts (On the floor now, Extra pieces, What happens next, Done · What happens next) for every door; its
// layout comes with it (a door other than Home › Approvals has no approvals stylesheet of its own).
import '../../approvals.css'
import { DoneSteps, FloorNow, NextSteps } from './NextSteps'
import { ConversationTick } from './ConversationTick'
import { ExtraPieces } from './ExtraPieces'
import { designOptionsOffered, NO_CHOICES, outcomeHeld, planHeld, type TellTick } from '../model' // F-OP-107: outcomeHeld (the picker's props)
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
  type RequestActions,
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
 * F-SA-240 (sales page plan P5, P24; 14-change-flow §3.5): ONE window, four doors — Home › Approvals, the order page, the thread
 * card, the customer's Work tab. Its props are the window's own (no host's model): the review, the price grain, offline / busy,
 * the door's own list the ‹ › arrows walk (`nav`), and the window's actions. Approvals passes its rows; the other doors their own
 * list through use-request-review-door.ts. It brings its own catalogues, so any office page may mount it.
 */
// ---- F-SA-240: the window's props, the same from every door ----
/** The door's own list: the ‹ › arrows walk it (Approvals: its rows; the order page: its waiting requests; the Work tab: the customer's). */
export interface RequestReviewNav {
  /** The ids the door lists, in its order (a request's id, or a batch's). */
  readonly ids: readonly string[]
  /** Open another id of the list, or close the window (null). None (a design case): no arrows, Close does nothing. */
  readonly onOpen?: ((id: string | null) => void) | undefined
}

export interface RequestReviewProps {
  /** The request or batch the address opens (null: none). */
  readonly review: RequestReviewModel | null | undefined
  /** The reader's grains: the price grain sets a counter's fee. */
  readonly grains: Pick<Grains, 'price'>
  readonly offline: boolean
  /** A write of the host or the window runs. */
  readonly busy?: boolean
  readonly nav: RequestReviewNav
  readonly actions?: RequestActions | undefined
}

const REVIEW_NAMESPACES = [DEPTH_NS, 'approvals', 'sales'] as const

export function RequestReview(props: RequestReviewProps) {
  const review = props.review
  if (!review) return null
  return <WithMessages namespaces={REVIEW_NAMESPACES}>{review.as === 'batch' ? <BatchReview {...props} review={review} /> : <OneReview {...props} review={review} />}</WithMessages>
}

const navOf = (nav: RequestReviewNav, id: string, noun: string) => {
  const ids = nav.ids
  const onGo = nav.onOpen
  return ids.length > 1 && ids.includes(id) && onGo ? { ids: [...ids], current: id, onGo: (next: string) => onGo(next), noun } : undefined
}
// ---- end F-SA-240

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

function OneReview({ review, grains, offline, busy = false, nav, actions }: RequestReviewProps & { review: Extract<RequestReviewModel, { as: 'request' }> }) {
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
    actions?.onWords?.(value)
  }
  const state = { offline, busy }
  const heldKey = (answer: 'accept' | 'refuse' | 'counter') => (request ? answerHeld(request, answer, state, words) : `${CR}.held.reading`)
  const refuseHeld = heldKey('refuse')
  const counterHeldKey = heldKey('counter')
  const waiting = request !== null && (request.status === 'OPEN' || request.status === 'COUNTERED')
  // ---- F-SA-241 / F-SA-242: the apply plan, the choices before Accept, the done view, the conversation tick ----
  const pathname = usePathname() ?? ''
  const plan = review.plan?.status === 'ready' ? review.plan.value : null
  const choices = review.choices ?? NO_CHOICES
  const done = review.done ?? null
  const accepted = request?.status === 'ACCEPTED'
  const fromPlan = waiting ? planHeld(plan, choices) : null
  const planHeldText = fromPlan ? ('words' in fromPlan ? said(fromPlan.words, locale) : t(fromPlan.key, fromPlan.params)) : null
  // The change cannot be carried out as it stands (a colour already cut, a style of our own collection): said once in the window.
  const blockedWhy = waiting ? (plan?.next.find((step) => (step.kind === 'AMEND' || step.kind === 'STYLE_CHANGE') && step.state === 'NOT_POSSIBLE' && step.why !== null)?.why ?? null) : null
  const acceptHeldKey = heldKey('accept')
  const acceptHeld = acceptHeldKey ? t(acceptHeldKey) : planHeldText
  const tell: TellTick | undefined = review.tell
  const doors = request ? { companyId: request.companyId, orderHref: review.orderHrefs[request.orderId] || null, orderNumber: request.orderNumber } : null
  const optionsHref = designOptionsOffered(plan) && request ? `${review.orderHrefs[request.orderId] || pathname}?tab=lines` : null
  // ---- end F-SA-241 / F-SA-242
  const answering = waiting && request.waitingOn === 'US' && (request.may.accept || request.may.refuse || request.may.counter)
  // Why it cannot be accepted as it stands (its state, our counter, who answers its kind) — said once in the window, not only on hover.
  const standingHeld = request && waiting ? answerHeld(request, 'accept', { offline: false, busy: false }, 'words') : null
  const dialog = review.dialog
  const accept = (rushFloor: boolean) => {
    if (acceptHeld || dialog || done) return
    actions?.onAccept?.(rushFloor)
  }
  const refuse = () => {
    if (refuseHeld || dialog || done) return
    actions?.onRefuse?.()
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

  const footer = done ? (
    // F-SA-241 (Round 4): after Accept the window stays on "Done · What happens next" — Close (a door) or Next request › (Approvals).
    <Button size="sm" variant="primary" onClick={() => actions?.onDoneClose?.()}>
      {done.next === 'next' ? t(`${CR}.done.nextRequest`) : t(`${CR}.done.close`)}
    </Button>
  ) : request && answering ? (
      <>
        <Button size="sm" variant="danger-outline" heldReason={refuseHeld ? t(refuseHeld) : null} onClick={refuse} aria-keyshortcuts="r">
          <X size={14} aria-hidden /> {t(`${CR}.refuse`)} <Kbd>R</Kbd>
        </Button>
        <Button size="sm" heldReason={counterHeldKey ? t(counterHeldKey) : null} onClick={() => !counterHeldKey && !dialog && actions?.onCounter?.()}>
          <MessageSquareReply size={14} aria-hidden /> {t(`${CR}.counter.open`)}
        </Button>
        {two ? (
          <>
            <Button size="sm" heldReason={acceptHeld} onClick={() => accept(true)}>
              <Zap size={14} aria-hidden /> {t(`${CR}.acceptRush`)}
            </Button>
            <Button size="sm" variant="primary" heldReason={acceptHeld} onClick={() => accept(false)} aria-keyshortcuts="a">
              <Check size={14} aria-hidden /> {t(`${CR}.acceptUrgent`)} <Kbd>A</Kbd>
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" heldReason={acceptHeld} onClick={() => accept(false)} aria-keyshortcuts="a">
            <Check size={14} aria-hidden /> {t(`${CR}.accept`)} <Kbd>A</Kbd>
          </Button>
        )}
      </>
    ) : undefined

  return (
    <>
      <DetailModal
        open
        onClose={() => (done ? actions?.onDoneClose?.() : nav.onOpen?.(null))}
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
        nav={navOf(nav, review.id, depth('review.noun'))}
        loading={loading && !request}
        error={error}
        onRetry={() => actions?.onRetry?.()}
        actions={footer}
      >
        {/* F-SA-241 (Round 4): after Accept, "Done · What happens next" — each next step its own command, Close / Next request ›. */}
        {request && done && doors && (
          <div className="fw-apv-review">
            <Banner tone="success" title={t(`${CR}.done.accepted`, { kind: w.t(`parts.request.kind.${request.kind}`), order: request.orderNumber })} />
            <DoneSteps plan={plan} done={done} tell={tell} customer={request.party.name} offline={offline} canHold={review.can.lift} doors={doors} actions={actions} />
          </div>
        )}
        {request && input && !done && (
          <div className="fw-apv-review">
            <Banner tone="info" title={t(`${CR}.review.asked`, { customer: request.party.name, who: request.askedBy ?? request.party.name, at: formatDateTime(request.askedAt, { locale }) })}>
              {request.reasonWords ? t(`${CR}.review.why`, { reason: said(request.reasonWords, locale) }) : undefined}
            </Banner>
            {review.problem && <Banner tone="danger" title={t(review.problem)} />}
            {standingHeld && <Banner tone="warning" title={t(standingHeld)} />}
            {/* F-SA-242: held in words before the click — a colour already cut, a style of our own collection (Suggest something else or
                refuse; the line's Options… only while no work order makes it). */}
            {!standingHeld && blockedWhy && (
              <Banner
                tone="warning"
                title={said(blockedWhy, locale)}
                action={
                  optionsHref ? (
                    <Button size="sm" variant="quiet" asChild>
                      <Link href={optionsHref}>
                        <Settings2 size={14} aria-hidden /> {t(`${CR}.design.options`)}
                      </Link>
                    </Button>
                  ) : undefined
                }
              />
            )}
            <RequestCard face="office" request={input} />
            {impact?.now.blocked && <Banner tone="warning" title={t(`${CR}.impact.blocked`)} />}
            {impact && (impact.now.notes.length > 0 || impact.now.earliest || impact.now.pricedWords || impact.now.appliesTo) && (
              <ul className="fw-apv-list">
                {/* B-SA-046b: a design change says first which pieces the customer asked it for. */}
                {impact.now.appliesTo && <li>{said(DESIGN_APPLIES_WORDS[impact.now.appliesTo], locale)}</li>}
                {impact.now.earliest && <li>{said(impact.now.earliest.words, locale)}</li>}
                {impact.now.pricedWords && <li>{said(impact.now.pricedWords, locale)}</li>}
                {impact.now.notes.map((note, index) => (
                  <li key={index}>{said(note, locale)}</li>
                ))}
              </ul>
            )}
            {review.impact.status === 'error' && <p className="fw-apv-hint">{t(`${CR}.impact.notRead`)}</p>}
            {/* F-SA-241: On the floor now (the order's own cells; without workorders.view "—" and "Needs work-order access"). */}
            {plan && <FloorNow plan={plan} />}
            {/* F-SA-241 (R1, Round 4): extra pieces cut beyond the new figure — one outcome required before Accept. F-OP-107: the part's
                plain props (the order page's strip, Close remaining lines and Cancel use the same). */}
            {plan && plan.extra.total > 0 && (
              <ExtraPieces
                name={`fw-apv-extra-${plan.request.id}`}
                pieces={plan.extra.pieces.map((piece) => ({ key: `${piece.lineId}:${piece.size}`, line: piece.seq, words: piece.words }))}
                outcomes={plan.extra.outcomes.map((option) => ({ outcome: option.outcome, words: option.words, held: outcomeHeld(option) }))}
                chosen={accepted ? plan.extra.chosen : choices.extraOutcome}
                done={accepted}
                onChoose={actions?.onExtraOutcome}
              />
            )}
            {request.counter && (
              <Banner tone={request.counter.state === 'AGREED' ? 'success' : request.counter.state === 'WAITING' ? 'info' : 'warning'} title={said(request.counter.offer, locale)}>
                {[said(request.counter.words, locale), record?.counterApproval?.answer ? t(`${CR}.counter.theirWords`, { words: record.counterApproval.answer }) : null].filter(Boolean).join(' · ')}
              </Banner>
            )}
            {/* F-PR-09: our counter-offer asked of the customer — decided for them while it waits, or their answer reversed. */}
            {request.counter && <CustomerOverrideSlot source={{ requestId: request.counter.approvalRequestId }} customer={request.party.name} version={request.version} />}
            {/* F-SA-241: What happens next (replaces "What accepting does" where the plan has steps: a change, a cancel, ship what is
                ready, a design change) — numbered, who does each, Finish what is started / Stop now per touched work order. */}
            {plan && plan.next.length > 0 && doors ? (
              <section aria-labelledby="fw-apv-cr-next">
                <h3 id="fw-apv-cr-next" className="fw-apv-h">
                  {t(`${CR}.next.title`)}
                </h3>
                <NextSteps plan={plan} accepted={accepted} choices={choices} offline={offline} canHold={review.can.lift} doors={doors} actions={actions} />
                <p className="fw-apv-hint">{t(`${CR}.team.${teamOf(request.answeredWith)}`)}</p>
              </section>
            ) : (
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
            )}
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
                <Button size="sm" variant="link" inline onClick={() => nav.onOpen?.(request.batchId)}>
                  <Layers size={12} aria-hidden /> {t(`${CR}.review.openBatch`)}
                </Button>
              </p>
            )}
            {answering && <WordsField words={words} onWords={onWords} required={false} />}
            {/* F-SA-242 (14-change-flow §4.2): the same words as our message in the order's conversation — on when words are typed, held
                with why, never automatic. */}
            {answering && tell && <ConversationTick id={request.id} tick={tell} words={words} customer={request.party.name} onTick={actions?.onTell} />}
            {lift && (
              <Button size="sm" onClick={() => actions?.onLift?.(lift)} heldReason={offline ? t(`${CR}.held.offline`) : null}>
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
      {request && dialog?.kind === 'counter' && <CounterDialog request={request} today={review.today} price={grains.price} busy={dialog.busy} problem={dialog.problem} initialNote={words} actions={actions} />}
    </>
  )
}

/** "Suggest something else" (a counter-offer the customer answers): a date, a fee (price grain only), our words — at least one. */
function CounterDialog({ request, today, price, busy, problem, initialNote, actions }: { request: BrandRequest; today: string; price: boolean; busy: boolean; problem: string | null; initialNote: string; actions?: RequestActions | undefined }) {
  const t = useT('approvals')
  const w = useProductionWords()
  const withPrice = price && request.may.counterWithPrice
  const [draft, setDraft] = useState<CounterDraft>({ ...EMPTY_COUNTER, note: initialNote })
  const heldKey = counterHeld(draft, { withPrice, today }) ?? (busy ? `${CR}.held.busy` : null)
  const send = () => {
    if (heldKey) return
    actions?.onCounterSend?.(draft)
  }
  const currency = request.cancelFee?.currency ?? null
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t(`${CR}.counter.title`, { order: request.orderNumber })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{t(`${CR}.back`)}</Button>
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

function BatchReview({ review, offline, busy = false, nav, actions }: RequestReviewProps & { review: Extract<RequestReviewModel, { as: 'batch' }> }) {
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
    actions?.onWords?.(value)
  }
  const state = { offline, busy }
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
    actions?.onBatch?.(answer, rushFloor)
  }
  const error = review.batch.status === 'error' ? sales(review.batch.problem) : review.batch.status === 'not_found' ? t(`${CR}.review.notFound`) : review.batch.status === 'forbidden' ? t(`${CR}.review.forbidden`) : undefined

  return (
    <>
      <DetailModal
        open
        onClose={() => nav.onOpen?.(null)}
        title={lead ? t(`${CR}.batch.title`, { kind, count: requests!.length }) : t(`${CR}.review.titleUnknown`)}
        subtitle={lead ? lead.party.name : undefined}
        meta={lead ? <Tag tone="info">{t(`${CR}.batch.waiting`, { count: waiting.length, total: requests!.length })}</Tag> : undefined}
        nav={navOf(nav, review.id, depth('review.noun'))}
        loading={review.batch.status === 'loading' && !requests}
        error={error}
        onRetry={() => actions?.onRetry?.()}
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
                    <Button key="a" size="sm" variant="link" inline onClick={() => nav.onOpen?.(request.id)}>
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
      {lead && dialog?.kind === 'batch' && <BatchAnswerDialog review={review} kind={kind} words={words} offline={offline} actions={actions} />}
    </>
  )
}

/**
 * Accept all / Refuse all (as Approve N, B-W2b-307): the batch read again, each request checked — the current ones listed "Waiting →
 * Accepted", one answered meanwhile, withdrawn or not ours to answer left out with why —, then answered one by one at the version
 * read (each still refused by the API if it moved in between), and the done screen says what became of each, in our words.
 */
function BatchAnswerDialog({ review, kind, words, offline, actions }: { review: Extract<RequestReviewModel, { as: 'batch' }>; kind: string; words: string; offline: boolean; actions?: RequestActions | undefined }) {
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
      onClose={() => actions?.onCloseDialog?.()}
      title={t(accept ? `${CR}.batch.acceptTitle` : `${CR}.batch.refuseTitle`, { count: current.length, kind })}
      summary={words.trim() ? t(`${CR}.words.preview`, { words: words.trim() }) : t(`${CR}.words.none`)}
      changes={current.map((line) => ({ id: line.requestId, where: line.orderNumber, what: kind, now: t(`${CR}.batch.now`), next: verb, ...(line.customerRef ? { note: t(`${CR}.review.po`, { ref: line.customerRef }) } : {}) }))}
      problems={problems}
      saveLabel={t(accept ? `${CR}.batch.acceptSave` : `${CR}.batch.refuseSave`, { count: current.length })}
      ackLabel={t(`${CR}.batch.ack`)}
      lead={lead}
      state={state}
      onSave={() => actions?.onBatchConfirm?.()}
      onRetry={() => actions?.onBatch?.(dialog.answer, dialog.rushFloor)}
      doneVerb={accept ? t(`${CR}.batch.doneAccepted`) : t(`${CR}.batch.doneRefused`)}
      size="lg"
    />
  )
}

// ---- after an accept: Lift the hold (R-23) -----------------------------------------------------------------------------------------

/**
 * "Lift the hold": why (the office's own words), then each work order's pause of this request lifted.
 * F-SA-240: its own callbacks (Approvals and every other door pass theirs) and its own catalogues.
 */
export function LiftDialog(props: { followUp: FollowUp; busy: boolean; problem: string | null; onConfirm?: ((reason: string) => void) | undefined; onClose?: (() => void) | undefined }) {
  return (
    <WithMessages namespaces={REVIEW_NAMESPACES}>
      <LiftDialog_ {...props} />
    </WithMessages>
  )
}

function LiftDialog_({ followUp, busy, problem, onConfirm, onClose }: { followUp: FollowUp; busy: boolean; problem: string | null; onConfirm?: ((reason: string) => void) | undefined; onClose?: (() => void) | undefined }) {
  const t = useT('approvals')
  const [reason, setReason] = useState('')
  const heldKey = liftHeld(reason, busy)
  const go = () => {
    if (heldKey) return
    onConfirm?.(reason)
  }
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t(`${CR}.lift.title`)}
      size="sm"
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t(`${CR}.back`)}</Button>
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
// F-SA-240: its own callback (every door passes its own).
export function FollowUpButton({ followUp, offline, busy, may, onFollowUp }: { followUp: FollowUp; offline: boolean; busy: boolean; may: boolean; onFollowUp?: ((followUp: FollowUp) => void) | undefined }) {
  const t = useT('approvals')
  const heldKey = !may ? `${CR}.followUp.held.${followUp.kind}` : offline ? `${CR}.held.offline` : busy ? `${CR}.held.busy` : null
  return (
    <Button size="sm" heldReason={heldKey ? t(heldKey) : null} onClick={() => !heldKey && onFollowUp?.(followUp)}>
      {t(followUp.kind === 'lift' ? `${CR}.followUp.lift` : `${CR}.followUp.clearRush`)}
    </Button>
  )
}

// ---- F-SA-240: what a door other than Home › Approvals draws of an answer — its notice (the request in words, what the answer said
// beside, "Lift the hold" / "Clear rush") and Lift the hold's why. Home › Approvals keeps its inbox notice (InboxView).
/** The door's own state of the window (use-request-review-door.ts makes it; a design case may pass one). */
export interface RequestDoorParts {
  readonly window: RequestReviewProps
  readonly notice: RequestNotice | null
  readonly lift: { readonly followUp: FollowUp; readonly busy: boolean; readonly problem: string | null } | null
  readonly can: { readonly lift: boolean; readonly rush: boolean }
  readonly actions?: RequestDoorActions | undefined
}

export interface RequestDoorActions {
  readonly onDismiss?: () => void
  readonly onFollowUp?: (followUp: FollowUp) => void
  readonly onLiftConfirm?: (reason: string) => void
  readonly onLiftClose?: () => void
}

/** The window as a door mounts it: the review window, and Lift the hold's why when it is open. */
export function RequestDoorWindow({ door }: { door: RequestDoorParts }) {
  return (
    <>
      <RequestReview {...door.window} />
      {door.lift && <LiftDialog followUp={door.lift.followUp} busy={door.lift.busy} problem={door.lift.problem} onConfirm={door.actions?.onLiftConfirm} onClose={door.actions?.onLiftClose} />}
    </>
  )
}

/** The door's notice after an answer, in the page's one banner place (the host puts it there): the request in words, its follow-up. */
export function RequestDoorNoticeBanner({ door }: { door: RequestDoorParts }) {
  return door.notice ? (
    <WithMessages namespaces={REVIEW_NAMESPACES}>
      <DoorNotice door={door} notice={door.notice} />
    </WithMessages>
  ) : null
}

function DoorNotice({ door, notice }: { door: RequestDoorParts; notice: RequestNotice }) {
  const t = useT(DEPTH_NS)
  const locale = useLocale()
  const followUp = notice.followUp
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.request ? { ...notice.params, request: requestWords(notice.request, locale, t) } : notice.params)}
      action={
        <span className="fw-apv-tags">
          {followUp && <FollowUpButton followUp={followUp} offline={door.window.offline} busy={door.window.busy ?? false} may={followUp.kind === 'lift' ? door.can.lift : door.can.rush} onFollowUp={door.actions?.onFollowUp} />}
          {door.actions?.onDismiss && (
            <Button size="sm" variant="quiet" onClick={door.actions.onDismiss}>
              {t('dismiss')}
            </Button>
          )}
        </span>
      }
    >
      {notice.lines && notice.lines.length > 0 ? notice.lines.map((line) => said(line, locale)).join(' ') : undefined}
    </Banner>
  )
}
// ---- end F-SA-240
