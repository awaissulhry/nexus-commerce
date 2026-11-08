'use client'

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { Banner, Card, ChangeReview, DetailPopover, Disclosure, KeyValue, ProgressBar, type KeyValueItem } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { ApprovalPage, ChangeRequest, DepositRead, OrderRecord, ProgressRead } from '../api'
import { milestoneSteps, movesOf, netMoved, openDeposits, promiseMoves, promiseOf, requestTone, shipToLines, sizeMoves } from '../model'
import { useOrderWords, type OrderWords } from '../words'
import { Loading, ReadFailed, SizeRunTable } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'

/**
 * Order › Status & progress (design rec "Order" tab status): "Please re-confirm" when a revised version waits (SAL-222), where
 * the order is (the six steps with their dates, the promise date big with its history in customer words), the customer's
 * change and cancel requests with our answer, production progress per line and size when the account shares it (C1), the
 * deposit and the order's facts. Money only with the price grain.
 */
export function StatusTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  return (
    <div className="fw-pord-tab">
      {record.order.reconfirmNeeded ? <ReconfirmPanel model={model} actions={actions} /> : null}
      <Tracker model={model} record={record} actions={actions} />
      <Requests model={model} actions={actions} />
      {record.progressShared && model.progress.state !== 'hidden' ? <Progress model={model} actions={actions} /> : null}
      {record.deposits.length > 0 && record.seesPrices ? <Deposits model={model} deposits={record.deposits} depositRequired={record.order.depositRequired} actions={actions} /> : null}
      <Facts record={record} />
    </div>
  )
}

/** The revised order's changes line by line, old → new (ChangeReview without ticks: they all go together). */
export function RevisionReview({ page, words }: { page: ApprovalPage; words: OrderWords }) {
  const { t } = words
  const order = page.content.revisedOrder
  if (!order) return null
  const items = order.lines.map((line) => {
    const prices = order.prices?.find((row) => row.lineId === line.lineId) ?? null
    const values: KeyValueItem[] = [
      { label: t('revision.pieces'), value: t('revision.oldNew', { old: line.piecesBefore, new: line.piecesAfter }) },
      ...(sizeMoves(line).length > 0 ? [{ label: t('revision.sizes'), value: sizeMoves(line).map((size) => t('revision.size', { size: size.size, old: size.before, new: size.after })).join(' · ') }] : []),
      ...(prices ? [{ label: t('revision.amount'), value: t('revision.oldNew', { old: words.money(prices.netBefore, order.currency), new: words.money(prices.netAfter, order.currency) }) }] : []),
    ]
    return {
      id: line.lineId,
      label: t('revision.line', { seq: line.seq, style: line.style.code, colour: line.colour.name }),
      status: t(`revision.change.${line.change}`),
      note: line.style.name,
      selectable: false,
      values,
    }
  })
  const header = order.header.map((change) => ({
    id: `h-${change.field}`,
    label: t(`revision.field.${change.field}`),
    status: t('revision.change.CHANGED'),
    note: '',
    selectable: false,
    values: [{ label: t('revision.was'), value: change.before ? (change.field === 'requestedDate' ? words.day(change.before) : change.before) : '—' }, { label: t('revision.now'), value: change.after ? (change.field === 'requestedDate' ? words.day(change.after) : change.after) : '—' }],
  }))
  return (
    <div className="fw-pord-stack">
      <ChangeReview label={t('revision.label', { version: order.revision })} items={[...header, ...items]} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />
      {order.netAmountBefore !== undefined && order.netAmountAfter !== undefined ? (
        <p className="fw-pord-total-move">{t('revision.net', { old: words.money(order.netAmountBefore, order.currency), new: words.money(order.netAmountAfter, order.currency) })}</p>
      ) : null}
      {netMoved(order) ? <p className="fw-pord-hint">{t('revision.voids')}</p> : null}
    </div>
  )
}

function ReconfirmPanel({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const revision = model.revision
  if (revision.state === 'loading') return <Loading rows={1} height={88} />
  if (revision.state === 'error') return <ReadFailed title={t('reconfirm.failed')} onRetry={actions?.onRetryRevision} />
  if (revision.state === 'noAccess') return <Banner tone="warning" title={t('reconfirm.bannerNoAccess')}>{t('reconfirm.askColleague')}</Banner>
  const page = revision.page
  if (!page || !page.content.revisedOrder) return <Banner tone="info" title={t('reconfirm.bannerSoon')} />
  const order = page.content.revisedOrder
  return (
    <Banner
      tone="warning"
      title={t('reconfirm.banner', { version: order.revision, date: day(page.request.dueAt) })}
      action={
        <Button variant="primary" size="sm" heldReason={model.reconfirmHeld} onClick={() => actions?.onReconfirm?.()}>
          {t('reconfirm.review')}
        </Button>
      }
    >
      <div className="fw-pord-stack">
        {netMoved(order) ? <p className="fw-pord-hint">{t('revision.voids')}</p> : null}
        <Disclosure summary={t('reconfirm.whatChanged', { count: order.lines.length + order.header.length })}>
          <RevisionReview page={page} words={words} />
        </Disclosure>
      </div>
    </Banner>
  )
}

function Tracker({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const ds = useDsWords()
  const order = record.order
  const promise = promiseOf(order)
  const moves = movesOf(record.promiseHistory)
  const history = promiseMoves(record.promiseHistory, locale, day).reverse()
  // The popover opens only once the page runs in the browser (a server render never draws it: no hydration mismatch).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <Card header={t('tracker.title')} headingLevel={2}>
      <div className="fw-pord-tracker">
        <MilestoneTracker steps={milestoneSteps(record.milestones, locale, day)} label={t('tracker.label', { number: order.number })} labels={ds.milestoneTracker} />
        <div className="fw-pord-promise">
          {order.status === 'CANCELLED' ? (
            <p className="fw-pord-promise-date">{order.cancelledOn ? t('tracker.cancelledOn', { date: day(order.cancelledOn) }) : t('tracker.cancelled')}</p>
          ) : promise.date ? (
            <>
              <span className="fw-pord-promise-label">{t('tracker.promise')}</span>
              <p className="fw-pord-promise-date">{day(promise.date)}</p>
              {promise.first ? <span className="fw-pord-sub">{t('tracker.firstPromised', { date: day(promise.first) })}</span> : null}
            </>
          ) : (
            <p className="fw-pord-hint">{t('tracker.noPromise')}</p>
          )}
          {moves > 0 ? (
            <DetailPopover
              trigger={
                <span className="fw-pord-moved-mark">
                  <History size={14} aria-hidden /> {t('tracker.moved', { count: moves })}
                </span>
              }
              triggerLabel={t('history.open', { count: moves })}
              triggerClassName="fw-pord-moved-trigger"
              label={t('history.title')}
              hoverDelay={0}
              open={mounted && (model.historyOpen ?? false)}
              onOpenChange={(open) => actions?.onHistory?.(open)}
            >
              <div className="fw-pord-history">
                <strong>{t('history.title')}</strong>
                <ol className="fw-pord-history-list">
                  {history.map((move, index) => (
                    <li key={index}>
                      <span>{move.from ? t('history.move', { on: move.on, from: move.from, to: move.to }) : t('history.set', { on: move.on, to: move.to })}</span>
                      {move.reason ? <span className="fw-pord-sub">{move.reason}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            </DetailPopover>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

function Requests({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day, at } = words
  const requests = model.requests
  if (requests.state === 'noAccess' || (requests.state === 'ready' && requests.items.length === 0)) return null
  return (
    <Card header={t('requests.title')} headingLevel={2}>
      {requests.state === 'loading' ? (
        <Loading rows={1} height={48} />
      ) : requests.state === 'error' ? (
        <ReadFailed title={t('requests.failed')} onRetry={actions?.onRetryRequests} />
      ) : (
        <ul className="fw-pord-requests">
          {requests.items.map((request) => (
            <li key={request.id} className="fw-pord-request" id={`change-request:${request.id}`}>
              <div className="fw-pord-request-head">
                <strong>{request.kindWords[locale]}</strong>
                <Pill tone={requestTone(request.status)}>{request.words[locale]}</Pill>
                <span className="fw-pord-sub">{t(request.mine ? 'requests.askedByYou' : 'requests.asked', { when: at(request.askedAt) })}</span>
                {request.status === 'OPEN' ? (
                  <Button size="sm" variant="quiet" className="fw-pord-push" heldReason={model.withdrawHeld} onClick={() => actions?.onWithdraw?.(request)}>
                    {t('requests.withdraw')}
                  </Button>
                ) : null}
              </div>
              <RequestWhat request={request} words={words} />
              {request.answer ? <p className="fw-pord-answer">{t('requests.ourAnswer', { answer: request.answer })}</p> : null}
              {request.status === 'ACCEPTED' && request.answeredAt ? <span className="fw-pord-sub">{t('requests.acceptedOn', { date: day(request.answeredAt.slice(0, 10)) })}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function RequestWhat({ request, words }: { request: ChangeRequest; words: OrderWords }) {
  const { t, locale, day } = words
  const parts: string[] = []
  if (request.kind === 'CANCEL') {
    parts.push(request.wholeOrder ? t('requests.wholeOrder') : t('requests.lines', { lines: [...new Set(request.cells.map((cell) => cell.seq))].join(', ') }))
    if (request.reasonWords) parts.push(request.reasonWords[locale])
    if (request.cancelFee?.pct && request.cancelFee.totalFee != null) parts.push(t('requests.fee', { fee: words.money(request.cancelFee.totalFee, request.cancelFee.currency) }))
  } else {
    for (const cell of request.cells) parts.push(t('requests.cell', { seq: cell.seq, size: cell.size ?? '—', old: cell.before, new: cell.asked }))
    if (request.requestedDate) parts.push(t('requests.date', { date: day(request.requestedDate) }))
    if (request.shipTo) parts.push(t('requests.shipTo', { address: request.shipTo.label }))
  }
  return (
    <div className="fw-pord-stack">
      <span>{parts.join(' · ')}</span>
      {request.note ? <span className="fw-pord-sub">{t('requests.note', { note: request.note })}</span> : null}
    </div>
  )
}

function Progress({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, time } = words
  const progress = model.progress
  return (
    <Card header={t('progress.title')} headingLevel={2} headerAction={progress.read ? <span className="fw-pord-sub">{t('band.updated', { time: time(progress.read.asOf) })}</span> : null}>
      {progress.state === 'loading' ? (
        <Loading rows={2} height={40} />
      ) : progress.state === 'error' || !progress.read ? (
        <ReadFailed title={t('progress.failed')} onRetry={actions?.onRetryProgress} />
      ) : (
        <div className="fw-pord-stack">
          {progress.read.lines.map((line) => (
            <ProgressLine key={line.lineId} line={line} stages={progress.read!.stages} words={words} />
          ))}
          <p className="fw-pord-hint">{t('progress.refresh', { seconds: progress.read.refreshSeconds })}</p>
        </div>
      )}
    </Card>
  )
}

type ProgressLineRead = ProgressRead['lines'][number]

function ProgressLine({ line, stages, words }: { line: ProgressLineRead; stages: ProgressRead['stages']; words: OrderWords }) {
  const { t, locale } = words
  const figure = (stage: ProgressRead['stages'][number]['key'], of: Pick<ProgressLineRead, 'cut' | 'sewn' | 'inspected' | 'packed'>) => (stage === 'CUT' ? of.cut : stage === 'SEWN' ? of.sewn : stage === 'INSPECTED' ? of.inspected : of.packed)
  const title = t('progress.line', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })
  return (
    <div className="fw-pord-progress-line">
      <strong>{title}</strong>
      <div className="fw-pord-bars">
        {stages.map((stage) => {
          const value = figure(stage.key, line)
          return (
            <div key={stage.key} className="fw-pord-bar">
              <span>{value === null ? t('progress.notScanned', { stage: stage.words[locale] }) : t('progress.of', { stage: stage.words[locale], count: value, ordered: line.ordered })}</span>
              <ProgressBar value={value === null || line.ordered === 0 ? null : (value / line.ordered) * 100} ariaLabel={`${title}: ${stage.words[locale]}`} />
            </div>
          )
        })}
      </div>
      <Disclosure summary={t('progress.sizes')}>
        <SizeRunTable
          label={t('progress.sizesOf', { title })}
          run={{
            heads: [t('sizes.ordered'), ...stages.map((stage) => stage.words[locale])],
            rows: line.sizes.map((size) => ({ size: size.size ?? '—', cells: [size.ordered, ...stages.map((stage) => (figure(stage.key, size) === null ? '—' : String(figure(stage.key, size))))] })),
          }}
        />
      </Disclosure>
    </div>
  )
}

function Deposits({ model, deposits, depositRequired, actions }: { model: OrderRecordViewModel; deposits: readonly DepositRead[]; depositRequired: boolean; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const open = openDeposits(deposits)
  return (
    <Card header={t('deposit.title')} headingLevel={2}>
      <div className="fw-pord-stack">
        {depositRequired && open.length > 0 ? <p className="fw-pord-strong">{t('deposit.gate')}</p> : null}
        {deposits.map((deposit) => {
          const pay = model.pay[deposit.id]
          return (
            <div key={deposit.id} className="fw-pord-deposit">
              <KeyValue
                columns={3}
                phoneColumns={2}
                labelCase="sentence"
                items={[
                  { label: t(`deposit.kind.${deposit.kind}`), value: words.money(deposit.amount, deposit.currency) },
                  { label: t('deposit.due'), value: day(deposit.dueDate) },
                  { label: t('deposit.status'), value: deposit.paidAt ? t('deposit.paidOn', { date: day(deposit.paidAt.slice(0, 10)) }) : t(`deposit.state.${deposit.status}`) },
                ]}
              />
              {pay ? (
                <Button variant="primary" size="sm" heldReason={pay.held} onClick={() => actions?.onPay?.(deposit.id)}>
                  {t('deposit.payCard')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Facts({ record }: { record: OrderRecord }) {
  const words = useOrderWords()
  const { t, day } = words
  const order = record.order
  const shipTo = shipToLines(order.shipTo)
  const items: KeyValueItem[] = [
    { label: t('facts.orderedOn'), value: day(order.orderDate) },
    { label: t('facts.requested'), value: order.requestedDate ? day(order.requestedDate) : '—' },
    { label: t('facts.promise'), value: order.promiseDate ? day(order.promiseDate) : '—' },
    {
      label: t('facts.shipTo'),
      value: shipTo.length > 0 ? (
        <span className="fw-pord-address">
          {shipTo.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </span>
      ) : (
        '—'
      ),
    },
    { label: t('facts.paymentTerms'), value: order.paymentTerms ?? '—' },
    ...(order.noWithdrawal ? [{ label: t('facts.withdrawal'), value: t('facts.noWithdrawal') }] : []),
  ]
  return (
    <Card header={t('facts.title')} headingLevel={2}>
      <KeyValue columns={3} labelCase="sentence" items={items} />
    </Card>
  )
}
