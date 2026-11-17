'use client'

import type { ReactNode } from 'react'
import { AlertCircle, ArrowLeft, FileSearch, MessageSquareReply, Undo2, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
// B-TH-282: "Add files" beside the thread; B-TH-291: Withdraw (a DS Modal through the page's words).
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ComposeFiles, type ComposeFilesActions, type ComposeFilesModel } from '../../../../lib/request-compose/view/ComposeFiles'
import type { RequestView as RequestRead } from '../api'
import { quoteText, shipToText, stateTone, type StateLinks } from '../model'
import { useRequestWords } from '../words'
import '../requests.css'

/**
 * SCR-185-request › the customer's request (B-TH-222, B-TH-303; threads plan X-P-CUS-REQ state + thread, PL3 — picture 20,
 * drawn to the approved look): ONE state line in true states only (the API's words: Sent, Being reviewed, We need something
 * from you, Quote being prepared, Quote sent, Order waiting for approval, Order confirmed, Declined, Closed — never "confirmed"
 * before it is), when it got there, what it means for the customer, what was made of it (the order's page, the quote by name,
 * each with the customer's own number); "We need something from you" quotes our question with Answer, which puts the cursor
 * in the message box. The thread is the main column (the portal's PartnerThread: two sides, never an office note); what was
 * asked sits beside it from 1280 px. Draws one view model and fetches nothing: the thread comes in as `thread`.
 */

export interface RequestRecordModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  request: RequestRead | null
  /** What the state line links to (the customer's own numbers only). */
  links: StateLinks
  /** Our question of a request that waits for the customer (NEED_INFO), quoted; null: none found in the thread (yet). */
  question: { body: string; at: string } | null
  /** No connection: what was loaded, and when (written). */
  offlineSince: string | null
  /** Orders & requests (the way back). */
  backHref: string
  // ---- B-TH-282: "Add files" (the request's door while undecided, its thread's after); null: not offered to this person.
  files?: ComposeFilesModel | null
  // ---- B-TH-291: Withdraw before the office decided (the API says when it is not allowed), and its question.
  withdraw?: { allowed: boolean; words: string | null } | null
  withdrawing?: { busy: boolean; problem: string | null } | null
  // ---- end B-TH-282 / B-TH-291
}

export interface RequestRecordActions {
  onAnswer?: () => void
  onRetry?: () => void
  // ---- B-TH-282 / B-TH-291
  files?: ComposeFilesActions
  onWithdraw?: () => void
  onWithdrawConfirm?: () => void
  onWithdrawCancel?: () => void
}

export function RequestRecordView({ model, actions, thread }: { model: RequestRecordModel; actions?: RequestRecordActions; thread: ReactNode }) {
  const words = useRequestWords()
  const { t, locale, day, at } = words

  if (model.state === 'missing') {
    return (
      <div className="fw-preq">
        <EmptyState
          icon={<FileSearch size={24} aria-hidden />}
          title={t('missing.title')}
          description={t('missing.body')}
          action={
            <Button asChild>
              <a href={model.backHref}>
                <ArrowLeft size={14} aria-hidden /> {t('missing.back')}
              </a>
            </Button>
          }
        />
      </div>
    )
  }

  if (model.state === 'error' && !model.request) {
    return (
      <div className="fw-preq">
        <EmptyState
          icon={<AlertCircle size={24} aria-hidden />}
          title={t('failed.title')}
          description={t('failed.body')}
          action={<Button onClick={() => actions?.onRetry?.()}>{t('failed.retry')}</Button>}
        />
      </div>
    )
  }

  if (!model.request) {
    return (
      <div className="fw-preq" role="status" aria-busy="true" aria-label={t('loading')}>
        <Skeleton height={88} />
        <div className="fw-preq-layout">
          <div className="fw-preq-main">
            <Skeleton height={120} />
            <Skeleton height={120} />
          </div>
          <div className="fw-preq-side">
            <Skeleton height={200} />
          </div>
        </div>
      </div>
    )
  }

  const request = model.request
  const code = request.state.code
  const needsYou = code === 'NEED_INFO'
  return (
    <div className="fw-preq">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline', { time: model.offlineSince })} /> : null}
      <Card padded className={needsYou ? 'fw-preq-state is-waiting' : 'fw-preq-state'}>
        <h2 className="fw-preq-label">{t('state.label')}</h2>
        <div className="fw-preq-stateline">
          <Pill tone={stateTone(code)}>{request.state.words[locale]}</Pill>
          <span className="fw-preq-when">{t('state.since', { when: at(request.updatedAt) })}</span>
        </div>
        <p className="fw-preq-hint">{t(`hint.${code}`)}</p>
        {model.links.order || model.links.quote ? (
          <p className="fw-preq-made">
            {model.links.order ? <a href={model.links.order.href}>{t('state.madeOrder', { order: model.links.order.label })}</a> : null}
            {model.links.order && model.links.quote ? <span aria-hidden> · </span> : null}
            {model.links.quote ? <span>{t('state.madeQuote', { quote: model.links.quote.label })}</span> : null}
          </p>
        ) : null}
        {needsYou ? (
          <div className="fw-preq-question" role="group" aria-labelledby="fw-preq-question-title">
            <MessageSquareReply size={18} aria-hidden />
            <div className="fw-preq-question-body">
              <strong id="fw-preq-question-title">{t('question.title')}</strong>
              {model.question ? (
                <>
                  <span className="fw-preq-when">{t('question.quote', { when: at(model.question.at) })}</span>
                  <blockquote className="fw-preq-quote">{quoteText(model.question.body)}</blockquote>
                </>
              ) : (
                <span className="fw-preq-when">{t('question.none')}</span>
              )}
            </div>
            <Button variant="primary" onClick={() => actions?.onAnswer?.()}>
              {t('question.answer')}
            </Button>
          </div>
        ) : null}
        {/* B-TH-291 (B-TH-095): Withdraw while the office has not decided; once it has, the API's words say why not. */}
        {model.withdraw?.allowed ? (
          <p className="fw-preq-withdraw">
            <Button size="sm" variant="quiet" onClick={() => actions?.onWithdraw?.()}>
              <Undo2 size={14} aria-hidden /> {t('withdraw.action')}
            </Button>
            <span className="fw-preq-when">{t('withdraw.hint')}</span>
          </p>
        ) : model.withdraw?.words && request.state.open ? (
          <p className="fw-preq-when">{model.withdraw.words}</p>
        ) : null}
      </Card>
      <div className="fw-preq-layout">
        <section className="fw-preq-main" aria-label={t('thread.title')}>
          {thread}
        </section>
        <aside className="fw-preq-side">
          {model.files ? (
            <Card padded className="fw-preq-files">
              <h2 className="fw-preq-h2">{t('files.title')}</h2>
              <ComposeFiles model={model.files} actions={actions?.files} title={false} />
            </Card>
          ) : null}
          <Card padded className="fw-preq-details">
            <h2 className="fw-preq-h2">{t('details.title')}</h2>
            <dl className="fw-preq-facts">
              <dt>{t('details.subject')}</dt>
              <dd>{request.subject}</dd>
              {request.customerRef ? (
                <>
                  <dt>{t('details.ref')}</dt>
                  <dd>{request.customerRef}</dd>
                </>
              ) : null}
              {request.wantedDate ? (
                <>
                  <dt>{t('details.date')}</dt>
                  <dd>{day(request.wantedDate)}</dd>
                </>
              ) : null}
              {request.shipTo ? (
                <>
                  <dt>{t('details.shipTo')}</dt>
                  <dd>
                    {shipToText(request.shipTo)}
                    {request.shipTo.waiting ? <span className="fw-preq-when"> · {t('details.shipToWaiting')}</span> : null}
                  </dd>
                </>
              ) : null}
              <dt>{t('details.received')}</dt>
              <dd>{at(request.receivedAt)}</dd>
              {request.pieces > 0 ? (
                <>
                  <dt>{t('details.pieces')}</dt>
                  <dd>{request.pieces}</dd>
                </>
              ) : null}
            </dl>
            {request.lines.length > 0 ? (
              <>
                <h3 className="fw-preq-h3">{t('details.lines')}</h3>
                <ul className="fw-preq-lines">
                  {request.lines.map((line) => {
                    const style = [line.style ? `${line.style.code} ${line.style.name}` : line.description, line.colourway?.name ?? line.colourText].filter(Boolean).join(', ') || '—'
                    const sizes = Object.entries(line.sizes)
                      .filter(([, count]) => count > 0)
                      .map(([size, count]) => `${size} × ${count}`)
                      .join(', ')
                    return <li key={line.id}>{sizes ? t('details.line', { style, sizes }) : t('details.lineQuantity', { style, count: line.quantity ?? 0 })}</li>
                  })}
                </ul>
              </>
            ) : (
              <p className="fw-preq-when">{t('details.none')}</p>
            )}
          </Card>
        </aside>
      </div>
      {model.withdrawing ? (
        <Modal
          open
          onClose={() => actions?.onWithdrawCancel?.()}
          title={request.yourNumber ? t('withdraw.title', { seq: request.yourNumber.seq }) : t('withdraw.titleNone')}
          size="sm"
          footer={
            <>
              <span className="grow" />
              <Button onClick={() => actions?.onWithdrawCancel?.()}>{t('withdraw.keep')}</Button>
              <Button variant="primary" tone="danger" heldReason={model.withdrawing.busy ? t('withdraw.busy') : null} onClick={() => actions?.onWithdrawConfirm?.()}>
                {t('withdraw.confirm')}
              </Button>
            </>
          }
        >
          <p className="fw-preq-dialog-text">{t('withdraw.body')}</p>
          {model.withdrawing.problem ? (
            <p className="fw-preq-problem" role="alert">
              {model.withdrawing.problem}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  )
}
