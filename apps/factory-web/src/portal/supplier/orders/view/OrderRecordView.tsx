'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { AlertCircle, FileText, Truck } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { LineResponseList, type LineDraft } from '@nexus/ui/patterns/LineResponseList/index'
import { Button, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Textarea, Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { copyHref, type NoticeRow, type OrderLine, type OrderPage } from '../api'
import { answerLines, kindsOf, lineFacts, lineRequestOf, lineTitle, parseQuantityIn, quantityWords } from '../../../../lib/po-answer/lines'
import {
  historySteps,
  lineDeliveryOf,
  MAX_NOTE,
  MAX_REF,
  noticeTone,
  outcomeOf,
  proposalAnswers,
  sendHeld,
  wasOf,
  type AnswerDraft,
  type AnswerProblem,
  type RecordTab,
} from '../model'
import { useOrderWords } from '../words'
import { ChangesList, ConfirmAllDialog, DeclineDialog, VersionDialog, type ConfirmAllModel, type DeclineModel, type VersionModel } from './Dialogs'
import '../supplier-orders.css'

/**
 * SCR-189 › one purchase order (design portal.supplier.orders rec "Purchase order": Lines, Confirm or propose, Ship notices,
 * Documents, Messages). The frame's band holds the title, their reference first, the state, "Confirm all as asked" and the
 * ⋯ (Decline, What changed, the PO PDF, Ask a question); this view draws the tab's content and the pop-ups. No price,
 * cost or amount anywhere (Owner answer C2): the order's copy is price-free and price talk belongs in Messages.
 */

export interface AnswerDone {
  outcome: 'CONFIRMED' | 'PROPOSED' | 'DECLINED'
  /** The review line's words of what was sent (null: a decline of the whole order). */
  summary: string | null
  supplierRef: string | null
}

export interface OrderRecordViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  page: OrderPage | null
  tab: RecordTab
  prefix: string
  /** The supplier's today (Europe/Rome). */
  today: string
  /** A line to show (from Home's next deliveries). */
  highlight: string | null
  draft: AnswerDraft
  facts: { preview: boolean; offline: boolean }
  busy: boolean
  problem: AnswerProblem | null
  done: AnswerDone | null
  /** The "What changed" panel is open (the first visit after a revision opens it). */
  changesOpen: boolean
  notices: { state: 'loading' | 'error' | 'noAccess' | 'ready'; items: readonly NoticeRow[] }
  /** Requests from us about this order (the task list's rows). */
  requests: readonly { id: string; title: string; verb: string; href: string }[]
  dialog: { kind: 'confirmAll'; model: ConfirmAllModel } | { kind: 'decline'; model: DeclineModel } | { kind: 'version'; model: VersionModel } | null
}

export interface OrderRecordActions {
  onAnswer?: (lineId: string, draft: LineDraft | null) => void
  onAllAsAsked?: () => void
  onField?: (field: 'supplierRef' | 'note', value: string) => void
  onSend?: () => void
  onDecline?: () => void
  onRetry?: () => void
  onRetryNotices?: () => void
  onChangesToggle?: (open: boolean) => void
  onTab?: (tab: RecordTab) => void
  dialog?: {
    onRef?: (value: string) => void
    onConfirm?: () => void
    onDeclineDraft?: (reason: Parameters<NonNullable<Parameters<typeof DeclineDialog>[0]['onDraft']>>[0], note: string) => void
    onDeclineSend?: () => void
    onVersionRetry?: () => void
    onClose?: () => void
  }
}

export function OrderRecordView({ model, actions, children }: { model: OrderRecordViewModel; actions?: OrderRecordActions; children?: ReactNode }) {
  const { t } = useOrderWords()
  if (model.state === 'loading') {
    return (
      <div className="fw-pso-record" role="status" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton height={28} width="40%" />
        <Skeleton height={72} />
        <Skeleton height={72} />
        <Skeleton height={72} />
      </div>
    )
  }
  if (model.state === 'missing') {
    return (
      <div className="fw-pso-record">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('record.missing')} description={t('record.missingBody')} action={
            <Button asChild>
              <a href={`${model.prefix}/orders`}>{t('record.toList')}</a>
            </Button>
          } />
      </div>
    )
  }
  if (model.state === 'error' || !model.page) {
    return (
      <div className="fw-pso-record">
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('record.failed')}</span>
          <Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>
        </div>
      </div>
    )
  }
  const page = model.page
  const dialog = model.dialog
  return (
    <div className="fw-pso-record">
      {model.tab === 'lines' ? <LinesTab model={model} page={page} actions={actions} /> : null}
      {model.tab === 'confirm' ? <ConfirmTab model={model} page={page} actions={actions} /> : null}
      {model.tab === 'asn' ? <NoticesTab model={model} actions={actions} /> : null}
      {model.tab === 'documents' ? <DocumentsTab model={model} page={page} /> : null}
      {model.tab === 'messages' ? (
        <section id="messages" className="fw-pso-section" aria-label={t('tabs.messages')}>
          <p className="fw-pso-hint">{t('messages.priceTalk')}</p>
          {children}
        </section>
      ) : null}
      {dialog?.kind === 'confirmAll' ? <ConfirmAllDialog model={dialog.model} actions={{ onRef: actions?.dialog?.onRef, onConfirm: actions?.dialog?.onConfirm, onClose: actions?.dialog?.onClose }} /> : null}
      {dialog?.kind === 'decline' ? <DeclineDialog model={dialog.model} onDraft={actions?.dialog?.onDeclineDraft} onSend={actions?.dialog?.onDeclineSend} onClose={actions?.dialog?.onClose} /> : null}
      {dialog?.kind === 'version' ? <VersionDialog model={dialog.model} onRetry={actions?.dialog?.onVersionRetry} onClose={actions?.dialog?.onClose} /> : null}
    </div>
  )
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function LinesTab({ model, page, actions }: { model: OrderRecordViewModel; page: OrderPage; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, day } = words
  const latest = useRef(page)
  latest.current = page
  const columns = useMemo((): ColDef<OrderLine>[] => {
    const SeqCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span className="fw-pso-seq">{data.seq}</span> : null)
    const WhatCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const facts = [...lineFacts(data, t, words.locale), ...(data.requiresCrViTest ? [t('lines.crVi')] : []), ...(data.note ? [t('lines.note', { note: data.note })] : [])]
      return (
        <span className="fw-pso-what" title={facts.join(' · ') || undefined}>
          <span className="fw-pso-what-title">{lineTitle(data)}</span>
          {facts.length > 0 ? <span className="fw-pso-sub">{facts.join(' · ')}</span> : null}
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const was = wasOf(latest.current, data.id)
      return (
        <span className="fw-pso-what">
          <span>{quantityWords(data.quantity, data.uom, words)}</span>
          {was.quantity ? <span className="fw-pso-sub fw-pso-was">{t('lines.was', { value: quantityWords(was.quantity, data.uom, words) })}</span> : null}
          {was.added ? <span className="fw-pso-sub fw-pso-was">{t('lines.added')}</span> : null}
        </span>
      )
    }
    const NeedCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const was = wasOf(latest.current, data.id)
      return (
        <span className="fw-pso-what">
          <span>{day(data.needDate)}</span>
          {was.needDate ? <span className="fw-pso-sub fw-pso-was">{t('lines.was', { value: day(was.needDate) })}</span> : null}
        </span>
      )
    }
    const ConfirmedCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      if (data.confirmedQuantity === null) return <span className="fw-pso-sub">{data.proposal ? t('lines.proposed') : t('lines.notConfirmed')}</span>
      return <span>{t('lines.askedBy', { quantity: quantityWords(data.confirmedQuantity, data.uom, words), date: data.confirmedDate ? day(data.confirmedDate) : '—' })}</span>
    }
    const ReceivedCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const delivery = lineDeliveryOf(data)
      const tone = delivery === 'delivered' ? 'success' : delivery === 'partly' ? 'info' : 'neutral'
      return (
        <span className="fw-pso-what">
          <Pill tone={tone}>{t(`lines.delivery.${delivery}`)}</Pill>
          {delivery === 'partly' && data.baseUom ? <span className="fw-pso-sub">{t('lines.received', { value: quantityWords(data.receivedBase, data.baseUom, words) })}</span> : null}
        </span>
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<OrderLine>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<OrderLine> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title: the line and its article.
      { ...column('seq', t('col.line'), SeqCell, { width: 80, minWidth: 70, maxWidth: 90 }), valueGetter: ({ data }) => (data ? `${t('lines.line', { seq: data.seq })} · ${lineTitle(data)}` : '') },
      column('what', t('col.what'), WhatCell, { flex: 2.2, minWidth: 260 }),
      column('quantity', t('col.quantity'), QuantityCell, { flex: 0.9, minWidth: 130 }),
      column('need', t('col.need'), NeedCell, { flex: 0.8, minWidth: 130 }),
      column('confirmed', t('col.confirmed'), ConfirmedCell, { flex: 1.1, minWidth: 170 }),
      column('received', t('col.received'), ReceivedCell, { flex: 1, minWidth: 160 }),
    ]
  }, [t, day, words])
  const changes = page.changes
  return (
    <div className="fw-pso-stack">
      <Card padded className="fw-pso-card">
        <OrderFacts page={page} />
      </Card>
      {changes ? (
        <Card padded className="fw-pso-card">
          <Disclosure summary={t('changes.title', { version: changes.revision })} open={model.changesOpen} onToggle={(event) => actions?.onChangesToggle?.((event.target as HTMLDetailsElement).open)}>
            <ChangesList changes={changes} />
          </Disclosure>
        </Card>
      ) : null}
      {page.order.state === 'BEING_CHANGED' ? <Banner tone="info" title={t('record.beingChanged', { number: page.order.documentNumber })} /> : null}
      <ListFrame<OrderLine>
        label={t('lines.title')}
        title={t('lines.title')}
        listKey={null}
        rows={page.lines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('lines.count', { count: page.lines.length })}
        focusRow={model.highlight ? Math.max(0, page.lines.findIndex((line) => line.id === model.highlight)) : undefined}
      />
      <p className="fw-pso-hint">{t('answer.noPrices')}</p>
    </div>
  )
}

// ── Confirm or propose ───────────────────────────────────────────────────────────────────────────────────────────────
function ConfirmTab({ model, page, actions }: { model: OrderRecordViewModel; page: OrderPage; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day, at } = words
  const ds = useDsWords()
  const lines = answerLines(page.lines)
  const requests = lines.map((line) => lineRequestOf(line, words, page.answer.substitutes[line.id] ?? []))
  const buyer = page.from.buyerName ?? t('who.buyer')
  const facts = { canAnswer: page.answer.canAnswer, mayAnswer: page.answer.mayAnswer, preview: model.facts.preview, offline: model.facts.offline, busy: model.busy }
  const editable = page.answer.canAnswer && page.answer.mayAnswer && !model.facts.preview && !model.busy && !model.done
  const steps = historySteps(page.history)

  const history = (
    <Card padded className="fw-pso-card">
      <h2 className="fw-pso-h2">{t('history.title')}</h2>
      {steps.length === 0 ? (
        <p className="fw-pso-hint">{t('history.empty')}</p>
      ) : (
        <Timeline
          label={t('history.title')}
          steps={steps.map((step) => ({
            key: step.key,
            label: t(step.words.key, step.words.params),
            tone: step.tone,
            ...(step.at !== null ? { at: step.at } : {}),
            ...(step.detail ? { detail: t(step.detail.key, { ...step.detail.params, ...(step.detail.reasonKey ? { reason: t(step.detail.reasonKey) } : {}) }) } : {}),
          }))}
        />
      )}
    </Card>
  )

  if (model.done) {
    const done = model.done
    return (
      <div className="fw-pso-stack">
        <Card padded className="fw-pso-card">
          <EndState
            tone={done.outcome === 'CONFIRMED' ? 'success' : done.outcome === 'PROPOSED' ? 'info' : 'neutral'}
            title={t(`done.${done.outcome}.title`)}
            body={done.outcome === 'PROPOSED' && done.summary ? t('done.PROPOSED.body', { buyer, summary: done.summary }) : t(`done.${done.outcome}.body`, { buyer })}
            next={t(`done.${done.outcome}.next`, { buyer })}
            facts={done.supplierRef ? [{ label: t('answer.ref'), value: done.supplierRef }] : undefined}
            reference={{ value: page.order.documentNumber, label: t('ref.ours') }}
            actions={[{ label: t('done.toList'), href: `${model.prefix}/orders`, variant: 'primary' }, { label: t('done.toLines'), onClick: () => actions?.onTab?.('lines') }]}
            labels={ds.endState}
          />
        </Card>
        {history}
      </div>
    )
  }

  if (!page.answer.canAnswer) {
    const proposed = proposalAnswers(page, locale)
    const status = page.order.state
    return (
      <div className="fw-pso-stack">
        <Banner tone={status === 'DECLINED' || status === 'CANCELLED' ? 'neutral' : status === 'CHANGE_PROPOSED' || status === 'BEING_CHANGED' ? 'info' : 'success'} title={t(`answered.${status}.title`, { buyer })}>
          {t(`answered.${status}.body`, { buyer, date: page.order.confirmedAt ? at(page.order.confirmedAt) : '' })}
        </Banner>
        {page.proposal ? (
          <Card padded className="fw-pso-card">
            <h2 className="fw-pso-h2">{t('proposal.title')}</h2>
            <p className="fw-pso-hint">{t(page.proposal.decision ? `proposal.decision.${page.proposal.decision}` : 'proposal.waiting', { buyer, at: at(page.proposal.at) })}</p>
            <LineResponseList lines={requests} answers={proposed} editable={false} kinds={kindsOf(page.answer.lineAnswers)} today={model.today} parseQuantity={parseQuantityIn(locale)} formatDate={day} locale={INTL_LOCALE[locale]} showSummary={false} labels={ds.lineResponseList} />
          </Card>
        ) : null}
        {history}
      </div>
    )
  }

  const outcome = outcomeOf(requests, model.draft.answers)
  const held = sendHeld(requests, model.draft, facts, model.today, locale)
  const sendLabel = outcome === 'CONFIRMED' ? t('answer.confirmAll') : outcome === 'DECLINED' ? t('answer.sendDecline') : t('answer.sendChanges')
  return (
    <div className="fw-pso-stack">
      <Card padded className="fw-pso-card">
        <div className="fw-pso-card-head">
          <h2 className="fw-pso-h2">{t('answer.title')}</h2>
          {page.order.confirmBy ? <span className="fw-pso-sub">{t('answer.by', { date: at(page.order.confirmBy) })}</span> : null}
        </div>
        <p className="fw-pso-hint">{t('answer.intro', { buyer })}</p>
        {!page.answer.mayAnswer ? <Banner tone="info" title={t('held.mayAnswer')} /> : null}
        <LineResponseList
          lines={requests}
          answers={model.draft.answers}
          onAnswer={actions?.onAnswer}
          onAllAsAsked={editable ? actions?.onAllAsAsked : undefined}
          editable={editable}
          kinds={kindsOf(page.answer.lineAnswers)}
          today={model.today}
          parseQuantity={parseQuantityIn(locale)}
          formatDate={day}
          locale={INTL_LOCALE[locale]}
          labels={ds.lineResponseList}
          modalLabels={ds.modal}
          textareaLabels={ds.textarea}
          dateFieldLabels={ds.dateField}
        />
        <div className="fw-pso-fields">
          <Field label={t('answer.ref')} hint={t('answer.refHint')} error={model.draft.supplierRef.trim().length > MAX_REF ? t('held.ref') : undefined}>
            <Input value={model.draft.supplierRef} onChange={(event) => actions?.onField?.('supplierRef', event.target.value)} disabled={!editable} maxLength={MAX_REF * 2} autoComplete="off" />
          </Field>
          <Field label={t('answer.note', { buyer })} error={model.draft.note.trim().length > MAX_NOTE ? t('held.note') : undefined}>
            <Textarea value={model.draft.note} onChange={(event) => actions?.onField?.('note', event.target.value)} disabled={!editable} rows={2} honourRows maxLength={MAX_NOTE * 2} />
          </Field>
        </div>
        {/* The review line ("2 lines as asked · 1 later date") is the DS part's own; here what sending comes to. */}
        <p className="fw-pso-outcome">{t(`answer.outcome.${outcome}`, { buyer })}</p>
        {model.problem ? <Banner tone="danger" title={t(`problem.${model.problem}`)} /> : null}
        <div className="fw-pso-actions">
          <Button onClick={() => actions?.onDecline?.()} heldReason={facts.preview ? t('held.preview') : !facts.mayAnswer ? t('held.mayAnswer') : null}>
            {t('answer.decline')}
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onSend?.()}>
            {model.busy ? <Spinner size={14} /> : null} {sendLabel}
          </Button>
        </div>
        <p className="fw-pso-hint">{t('answer.noPrices')}</p>
      </Card>
      {history}
    </div>
  )
}

// ── Ship notices ─────────────────────────────────────────────────────────────────────────────────────────────────────
function NoticesTab({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const { t, locale, day } = useOrderWords()
  const notices = model.notices
  return (
    <Card padded className="fw-pso-card">
      <h2 className="fw-pso-h2">{t('asn.title')}</h2>
      {notices.state === 'loading' ? (
        <div role="status" aria-label={t('state.loading')} className="fw-pso-stack">
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : notices.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('asn.failed')}</span>
          <Button onClick={() => actions?.onRetryNotices?.()}>{t('state.retry')}</Button>
        </div>
      ) : notices.state === 'noAccess' ? (
        <p className="fw-pso-hint">{t('asn.noAccess')}</p>
      ) : notices.items.length === 0 ? (
        <EmptyState icon={<Truck size={24} aria-hidden />} title={t('asn.empty')} description={t('asn.emptyBody')} />
      ) : (
        <ul className="fw-pso-rows" aria-label={t('asn.title')}>
          {notices.items.map((notice) => (
            <li key={notice.id} className="fw-pso-row">
              <span className="fw-pso-row-main">
                <strong>{notice.number ?? t('asn.draft')}</strong>
                <span className="fw-pso-sub">
                  {[notice.shipDate ? t('asn.shipDate', { date: day(notice.shipDate) }) : null, t('asn.lines', { count: notice.lines }), notice.carrier ? (notice.trackingNumber ? `${notice.carrier} · ${notice.trackingNumber}` : notice.carrier) : null, notice.ddtNumber ? t('asn.ddt', { number: notice.ddtNumber }) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Pill tone={noticeTone(notice.state)}>{notice.words[locale]}</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ── Documents ────────────────────────────────────────────────────────────────────────────────────────────────────────
function DocumentsTab({ model, page }: { model: OrderRecordViewModel; page: OrderPage }) {
  const { t, locale, at } = useOrderWords()
  const ddts = model.notices.state === 'ready' ? model.notices.items.filter((notice) => notice.ddtNumber) : []
  return (
    <div className="fw-pso-stack">
      <Card padded className="fw-pso-card">
        <h2 className="fw-pso-h2">{t('docs.title')}</h2>
        <ul className="fw-pso-rows" aria-label={t('docs.title')}>
          <li className="fw-pso-row">
            <span className="fw-pso-row-main">
              <strong>{t('docs.asSent', { number: page.order.documentNumber })}</strong>
              <span className="fw-pso-sub">{page.order.sentAt ? t('docs.sentOn', { at: at(page.order.sentAt) }) : t('docs.noPrices')}</span>
            </span>
            <Button size="sm" asChild>
              <a href={copyHref(page.order.id, locale)} target="_blank" rel="noopener noreferrer" aria-label={t('docs.openPdf', { number: page.order.documentNumber })}>
                <FileText size={13} aria-hidden /> {t('docs.pdf')}
              </a>
            </Button>
          </li>
          {ddts.map((notice) => (
            <li key={notice.id} className="fw-pso-row">
              <span className="fw-pso-row-main">
                <strong>{t('docs.ddt', { number: notice.ddtNumber ?? '' })}</strong>
                <span className="fw-pso-sub">{t('docs.ddtOf', { notice: notice.number ?? t('asn.draft') })}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="fw-pso-hint">{t('docs.noPrices')}</p>
      </Card>
      <Card padded className="fw-pso-card">
        <h2 className="fw-pso-h2">{t('docs.requests')}</h2>
        {model.requests.length === 0 ? (
          <p className="fw-pso-hint">{t('docs.noRequests')}</p>
        ) : (
          <ul className="fw-pso-rows" aria-label={t('docs.requests')}>
            {model.requests.map((request) => (
              <li key={request.id} className="fw-pso-row">
                <span className="fw-pso-row-main">
                  <strong>{request.title}</strong>
                </span>
                <Button size="sm" asChild>
                  <a href={request.href}>{request.verb}</a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/** The order's facts for the Lines tab head (from, deliver to, terms): kept here for the record's first glance. */
export function OrderFacts({ page }: { page: OrderPage }) {
  const { t, day, at } = useOrderWords()
  const address = page.deliverTo ? [page.deliverTo.name, page.deliverTo.line1, page.deliverTo.line2, `${page.deliverTo.postalCode} ${page.deliverTo.city}${page.deliverTo.province ? ` (${page.deliverTo.province})` : ''}`].filter(Boolean).join(', ') : '—'
  return (
    <KeyValue
      dense
      labelCase="sentence"
      columns={3}
      items={[
        { label: t('order.from'), value: page.from.tradeName ?? page.from.legalName },
        { label: t('order.buyer'), value: page.from.buyerName ?? '—' },
        { label: t('order.deliverTo'), value: address },
        { label: t('order.sentOn'), value: page.order.sentAt ? at(page.order.sentAt) : '—' },
        { label: t('order.wanted'), value: page.order.requestedDate ? day(page.order.requestedDate) : '—' },
        { label: t('order.terms'), value: page.order.incoterms ?? '—' },
        ...(page.order.note ? [{ label: t('order.note'), value: page.order.note }] : []),
      ]}
    />
  )
}
