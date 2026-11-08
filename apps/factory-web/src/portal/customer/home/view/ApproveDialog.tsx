'use client'

import { useEffect, useRef } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, FileText, ImageIcon } from 'lucide-react'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, ChangeReview, Field, KeyValue, type ChangeReviewItem } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, RadioCard, Skeleton, Tag } from '@nexus/ui/primitives'
import { Countdown, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import type { ApprovalRead, RevisedOrder } from '../api'
import { ANSWER_LIMITS, approvalTitle, commentNeeded, decidedTone, decisionsOf, isPicture, referenceOf } from '../model'
import { useHomeWords } from '../words'

/**
 * pop:approve-dialog (design portal.customer.home; B-W2b-184's portal answer, the same body as the Approve link SCR-198):
 * what we ask (our question quoted, by when with the Countdown, who asks), the kind's facts in the reader's language, a
 * revised order line by line old → new (prices only with the price grain), the request's files (opened here: a PDF in the
 * viewer, a picture as it is), and Your decision: Approve · Approve with changes (where the kind allows) · Refuse, the
 * comment where the answer needs words, signed with the typed name (Enter signs). Held with the reason: a preview, a role
 * that may not approve, no connection, a request already answered or closed. After the answer: the end in words; the
 * row leaves What waits for you. J / K move to the next or previous waiting approval; Esc closes.
 */

export interface ApproveDialogModel {
  requestId: string
  state: 'loading' | 'error' | 'gone' | 'ready'
  page: ApprovalRead | null
  /** "2 of 3 waiting" and J / K (null: this one only). */
  position: { index: number; count: number } | null
  decision: ApprovalDecision | null
  comment: string
  answer: 'idle' | 'busy' | 'done'
  /** A key of `portal-customer-home` (the page's check or the API's refusal). */
  problem: string | null
  field: 'decision' | 'comment' | null
  /** Why the whole answer is held (a preview, the role, offline, the request's own state), in words. */
  held: string | null
  /** The file open in the pop-up, as read. */
  file: { id: string; name: string; state: 'loading' | 'error' | 'ready'; src: Uint8Array | string | null; pdf: boolean } | null
  /** The page's clock for the countdown (design cases). */
  now?: number
}

export interface ApproveActions {
  onClose?: () => void
  onRetry?: () => void
  onDecision?: (decision: ApprovalDecision) => void
  onComment?: (comment: string) => void
  onSign?: (typedName: string) => void
  onStep?: (step: 1 | -1) => void
  onOpenFile?: (fileId: string | null) => void
}

export function ApproveDialog({ model, actions }: { model: ApproveDialogModel; actions?: ApproveActions }) {
  const words = useHomeWords()
  const { t } = words
  const shell = useT('shell')
  const ds = useDsWords()
  const page = model.page
  const title = page ? approvalTitle(page, t) : t('approve.loading')
  const body = useRef<HTMLDivElement>(null)

  // J / K: the next or previous waiting approval (not while typing), wherever the focus is in the pop-up.
  const step = actions?.onStep
  const canStep = model.position !== null && model.answer !== 'busy'
  useEffect(() => {
    if (!canStep) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault()
        step?.(1)
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        step?.(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canStep, step])
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 })
  }, [model.requestId])

  const nav = model.position ? (
    <span className="fw-pch-nav">
      <Button size="sm" variant="quiet" aria-label={t('approve.previous')} heldReason={model.position.index <= 1 ? t('approve.first') : null} onClick={() => actions?.onStep?.(-1)}>
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <span className="fw-pch-sub">{t('approve.nav', { index: model.position.index, count: model.position.count })}</span>
      <Button size="sm" variant="quiet" aria-label={t('approve.done.next')} heldReason={model.position.index >= model.position.count ? t('approve.last') : null} onClick={() => actions?.onStep?.(1)}>
        <ChevronRight size={16} aria-hidden />
      </Button>
    </span>
  ) : null

  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.onClose?.()}
      closeHeld={model.answer === 'busy' ? t('held.busy') : null}
      initialFocus="dialog"
      title={title}
      headerActions={nav}
      footer={
        model.answer === 'done' ? (
          <>
            {model.position && model.position.count > 1 ? <Button onClick={() => actions?.onStep?.(1)}>{t('approve.done.next')}</Button> : null}
            <Button variant="primary" onClick={() => actions?.onClose?.()}>
              {t('approve.done.close')}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="fw-pch-dialog" ref={body}>
        {model.state === 'loading' ? (
          <div className="fw-pch-stack" role="status" aria-label={t('approve.loading')}>
            <Skeleton height={72} />
            <Skeleton height={120} />
            <Skeleton height={96} />
          </div>
        ) : model.state === 'error' ? (
          <div className="fw-pstate" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{t('approve.failed')}</span>
            {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : model.state === 'gone' || !page ? (
          <Banner tone="info" title={t('approve.gone')} />
        ) : model.answer === 'done' ? (
          <EndState
            tone={decidedTone(page.request.status)}
            title={t(`status.${page.request.status}`)}
            body={t('approve.done.body')}
            facts={[
              ...(page.request.answer ? [{ label: t('approve.done.name'), value: page.request.answer.typedName }, { label: t('approve.done.at'), value: words.at(page.request.answer.at) }] : []),
              ...(page.request.answer?.words ? [{ label: t('approve.done.words'), value: page.request.answer.words }] : []),
            ]}
            next={page.receipt === 'SENT' ? [t('approve.done.receiptSent')] : page.receipt === 'FAILED' ? [t('approve.done.receiptFailed')] : []}
            reference={{ value: referenceOf(page.request.label), label: t('approve.done.reference') }}
            contact={{ name: page.request.from.companyName, detail: t('approve.done.contact') }}
            labels={ds.endState}
          />
        ) : (
          <>
            <WhatWeAsk page={page} model={model} />
            <KindContent page={page} />
            <Files page={page} model={model} actions={actions} pdfLabels={pdfViewerLabels(shell)} />
            <Decision page={page} model={model} actions={actions} />
          </>
        )}
      </div>
    </Modal>
  )
}

function WhatWeAsk({ page, model }: { page: ApprovalRead; model: ApproveDialogModel }) {
  const { t, at } = useHomeWords()
  const waiting = page.request.status === 'OPEN'
  return (
    <section className="fw-pch-dsection" aria-labelledby="fw-pch-ask-what">
      <h3 id="fw-pch-ask-what" className="fw-pch-dtitle">
        {t('approve.what')}
      </h3>
      <blockquote className="fw-pch-question" lang={page.locale}>
        {page.request.question}
      </blockquote>
      <KeyValue
        labelCase="sentence"
        columns={2}
        items={[
          {
            label: t('approve.due'),
            value: (
              <span className="fw-pch-due">
                {at(page.request.dueAt)}
                {waiting ? <Countdown to={page.request.dueAt} now={model.now} label={(left) => t('approve.dueIn', { left })} doneLabel={t('approve.dueNow')} /> : null}
              </span>
            ),
          },
          { label: t('approve.from'), value: page.request.from.companyName },
          { label: t('approve.state'), value: t(`status.${page.request.status}`) },
        ]}
      />
    </section>
  )
}

function KindContent({ page }: { page: ApprovalRead }) {
  const { t, locale, day } = useHomeWords()
  const order = page.content.revisedOrder
  const facts = page.content.facts.length > 0 ? <KeyValue labelCase="sentence" items={page.content.facts.map((fact) => ({ label: fact.label, value: <span lang={page.locale}>{fact.value}</span> }))} /> : null
  if (!order) {
    return facts ? (
      <section className="fw-pch-dsection" aria-labelledby="fw-pch-ask-facts">
        <h3 id="fw-pch-ask-facts" className="fw-pch-dtitle">
          {t('approve.facts')}
        </h3>
        {facts}
      </section>
    ) : null
  }
  const arrow = (before: string, after: string) => t('approve.arrow', { before, after })
  const money = (minor: number | undefined) => (minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency: order.currency }))
  const price = (value: string | null) => (value === null ? '—' : formatNumber(Number(value), locale, { style: 'currency', currency: order.currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }))
  const items: ChangeReviewItem[] = order.lines.map((line) => lineItem(order, line, t, arrow, money, price))
  const priced = order.netAmountBefore !== undefined && order.netAmountAfter !== undefined
  return (
    <section className="fw-pch-dsection" aria-labelledby="fw-pch-ask-order">
      <h3 id="fw-pch-ask-order" className="fw-pch-dtitle">
        {t('approve.order', { number: order.orderNumber, revision: order.revision })}
      </h3>
      {facts}
      {order.header.length > 0 ? (
        <KeyValue
          labelCase="sentence"
          items={order.header.map((entry) => ({
            label: t(`approve.header.${entry.field}`),
            value: entry.field === 'requestedDate' ? arrow(entry.before ? day(entry.before) : '—', entry.after ? day(entry.after) : '—') : arrow(entry.before ?? '—', entry.after ?? '—'),
          }))}
        />
      ) : null}
      {items.length > 0 ? <ChangeReview label={t('approve.lines', { count: items.length })} items={items} selectedIds={[]} onSelectionChange={() => undefined} tick={false} /> : null}
      {priced ? (
        <>
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('approve.net'), value: <strong>{arrow(money(order.netAmountBefore), money(order.netAmountAfter))}</strong> },
              { label: t('approve.gross'), value: arrow(money(order.grossAmountBefore), money(order.grossAmountAfter)) },
            ]}
          />
          {order.netAmountBefore !== order.netAmountAfter ? <Banner tone="info" title={t('approve.netMoved')} /> : null}
        </>
      ) : (
        <p className="fw-pch-sub">{t('approve.noPrices')}</p>
      )}
    </section>
  )
}

function lineItem(
  order: RevisedOrder,
  line: RevisedOrder['lines'][number],
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
  arrow: (before: string, after: string) => string,
  money: (minor: number | undefined) => string,
  price: (value: string | null) => string,
): ChangeReviewItem {
  const prices = order.prices?.find((row) => row.lineId === line.lineId) ?? null
  const moves = line.sizes.filter((size) => size.before !== size.after)
  return {
    id: line.lineId,
    label: t('approve.line', { seq: line.seq, style: [line.style.code, line.style.name].filter(Boolean).join(' '), colour: [line.colour.code, line.colour.name].filter(Boolean).join(' ') }),
    status: <Tag tone={line.change === 'REMOVED' ? 'danger' : line.change === 'ADDED' ? 'success' : 'warning'}>{t(`approve.change.${line.change}`)}</Tag>,
    note: t('approve.pieces', { before: line.piecesBefore, after: line.piecesAfter }),
    selectable: false,
    values: [
      ...moves.map((size) => ({ label: t('approve.size', { size: size.size }), value: arrow(String(size.before), String(size.after)) })),
      ...(prices?.unitPrice ? [{ label: t('approve.unitPrice'), value: arrow(price(prices.unitPrice.before), price(prices.unitPrice.after)) }] : []),
      ...(prices ? [{ label: t('approve.lineNet'), value: arrow(money(prices.netBefore), money(prices.netAfter)) }] : []),
    ],
  }
}

function Files({ page, model, actions, pdfLabels }: { page: ApprovalRead; model: ApproveDialogModel; actions?: ApproveActions; pdfLabels: ReturnType<typeof pdfViewerLabels> }) {
  const { t } = useHomeWords()
  if (page.content.revisedOrder && page.files.length === 0) return null
  const open = model.file
  return (
    <section className="fw-pch-dsection" aria-labelledby="fw-pch-ask-files">
      <h3 id="fw-pch-ask-files" className="fw-pch-dtitle">
        {t('approve.files')}
      </h3>
      {page.files.length === 0 ? (
        <p className="fw-pch-sub">{t('approve.filesNone')}</p>
      ) : (
        <ul className="fw-pch-askfiles">
          {page.files.map((file) => (
            <li key={file.id}>
              <Button size="sm" aria-pressed={open?.id === file.id} aria-label={t('approve.openOf', { name: file.originalName })} onClick={() => actions?.onOpenFile?.(open?.id === file.id ? null : file.id)}>
                {isPicture(file.contentType) ? <ImageIcon size={14} aria-hidden /> : <FileText size={14} aria-hidden />} {file.originalName}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="fw-pch-askfile">
          {open.state === 'loading' ? (
            <p className="fw-pch-sub" role="status">
              {t('approve.fileLoading', { name: open.name })}
            </p>
          ) : open.state === 'error' || !open.src ? (
            <Banner tone="warning" title={t('approve.fileFailed', { name: open.name })} action={<Button size="sm" onClick={() => actions?.onOpenFile?.(open.id)}>{t('state.retry')}</Button>} />
          ) : open.pdf && open.src instanceof Uint8Array ? (
            <PdfViewer src={open.src} title={open.name} fileName={open.name} labels={pdfLabels} height="min(60vh, 640px)" />
          ) : typeof open.src === 'string' ? (
            <img className="fw-pch-askimg" src={open.src} alt={open.name} />
          ) : null}
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(null)}>
            {t('approve.fileClose')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function Decision({ page, model, actions }: { page: ApprovalRead; model: ApproveDialogModel; actions?: ApproveActions }) {
  const { t } = useHomeWords()
  const decisions = decisionsOf(page)
  const held = model.held
  const busy = model.answer === 'busy'
  const label = referenceOf(page.request.label)
  const company = page.request.from.companyName
  const commentLabel = t(model.decision === 'REFUSED' ? 'approve.comment.why' : model.decision === 'APPROVED_WITH_CHANGES' ? 'approve.comment.what' : 'approve.comment.optional')
  const decisionError = model.field === 'decision' && model.problem ? t(model.problem) : null
  const commentError = model.field === 'comment' && model.problem ? t(model.problem) : undefined
  const message = model.field === null && model.problem ? t(model.problem) : undefined
  return (
    <section className="fw-pch-dsection" aria-labelledby="fw-pch-ask-decision">
      <h3 id="fw-pch-ask-decision" className="fw-pch-dtitle">
        {t('approve.decision')}
      </h3>
      <fieldset className="fw-pch-choices" aria-describedby={decisionError ? 'fw-pch-decision-error' : undefined}>
        <legend className="fw-pch-legend">{t('approve.legend')}</legend>
        <div className="fw-pch-choice-grid" data-count={decisions.length}>
          {decisions.map((decision) => (
            <RadioCard
              key={decision}
              name="fw-pch-decision"
              value={decision}
              checked={model.decision === decision}
              selected={model.decision === decision}
              readOnly={!!held}
              onChange={() => !held && actions?.onDecision?.(decision)}
              title={t(`approve.option.${decision}`)}
              description={t(`approve.option.${decision}_body`)}
            />
          ))}
        </div>
        {decisionError ? (
          <p id="fw-pch-decision-error" className="fw-pch-error" role="alert">
            {decisionError}
          </p>
        ) : null}
      </fieldset>
      <Field label={commentLabel} hint={commentNeeded(model.decision) ? t('approve.comment.needed') : t('approve.comment.hint')} error={commentError} required={commentNeeded(model.decision)}>
        <Textarea id="fw-pch-comment" value={model.comment} rows={3} limit={ANSWER_LIMITS.answer} readOnly={!!held || busy} onChange={(event) => actions?.onComment?.(event.target.value)} />
      </Field>
      <SignBlock
        title={<span className="fw-pch-dtitle">{t('approve.sign.title')}</span>}
        summary={<p className="fw-pch-sub">{model.decision ? t(`approve.sign.summary.${model.decision}`, { label, company }) : t('approve.sign.summary.none')}</p>}
        legal={<p className="fw-pch-sub">{t('approve.sign.legal', { company })}</p>}
        nameLabel={t('approve.sign.name')}
        nameHint={t('approve.sign.nameHint')}
        nameEmptyLabel={t('approve.sign.nameEmpty')}
        acceptLabel={model.decision ? t(`approve.sign.go.${model.decision}`) : t('approve.sign.choose')}
        onAccept={(signed) => actions?.onSign?.(signed.name)}
        state={busy ? 'busy' : 'idle'}
        busyLabel={t('approve.sign.busy')}
        heldReason={held}
        message={message}
        messageTone="danger"
      />
    </section>
  )
}
