'use client'

import { useEffect, useRef } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Countdown, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import type { ApprovalRead } from '../../home/api'
import type { WaitingRead } from '../api'
import { ANSWER_LIMITS, commentNeeded, decidedTone, decisionTitle, decisionWhat, decisionsOf, type DialogFile } from '../model'
import { useSamplesWords } from '../words'

/**
 * pop:decision "Decide on Fit 2" (design portal.customer.samples; B-W2b-184's portal answer, settled on the round by
 * B-W2b-252): what we ask (our question, by when with the Countdown), the sample as the office describes it (Sample, Style,
 * Revision, Sizes — the spec facts the request carries), the request's photos side by side (a PDF opens in the viewer),
 * and Your decision: Approve · Approve with comments · Reject, the words where the decision needs them, signed with the
 * typed name (SignBlock). Held with the reason: an office preview, a role that may not approve (its admins named), no
 * connection, a request answered or closed meanwhile. After the answer: the end in words and the next sample. J / K move
 * through the waiting samples; A approves and R rejects (never while typing); Esc closes.
 */

export interface DecisionDialogModel {
  requestId: string
  /** What the page knows of the request (the title before the request is read). */
  row: WaitingRead | null
  state: 'loading' | 'error' | 'gone' | 'ready'
  page: ApprovalRead | null
  /** "2 of 3 waiting" and J / K (null: this one only). */
  position: { index: number; count: number } | null
  decision: ApprovalDecision | null
  comment: string
  answer: 'idle' | 'busy' | 'done'
  /** A key of `portal-samples` (the page's check or the API's refusal). */
  problem: string | null
  field: 'decision' | 'comment' | null
  /** Why the whole answer is held, in words. */
  held: string | null
  /** The request's pictures, side by side (each read once). */
  pictures: readonly DialogFile[]
  /** A PDF of the request open in the viewer. */
  pdf: DialogFile | null
  /** The page's clock for the countdown (design cases). */
  now?: number
}

export interface DecisionActions {
  onClose?: () => void
  onRetry?: () => void
  onDecision?: (decision: ApprovalDecision) => void
  onComment?: (comment: string) => void
  onSign?: (typedName: string) => void
  onStep?: (step: 1 | -1) => void
  onOpenPdf?: (fileId: string | null) => void
  onRetryPicture?: (fileId: string) => void
}

const OPTION_KEY: Readonly<Record<ApprovalDecision, string>> = { APPROVED: 'approve', APPROVED_WITH_CHANGES: 'comments', REFUSED: 'reject' }

export function DecisionDialog({ model, actions }: { model: DecisionDialogModel; actions?: DecisionActions }) {
  const { t, locale, at } = useSamplesWords()
  const shell = useT('shell')
  const ds = useDsWords()
  const page = model.page
  const title = decisionTitle(model.row, t, locale)
  const body = useRef<HTMLDivElement>(null)

  // J / K the next or previous sample; A approve, R reject — never while typing, never while sending or after the end.
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const { model: now, actions: act } = latest.current
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (now.answer === 'busy') return
      const key = event.key
      if ((key === 'j' || key === 'J') && now.position) {
        event.preventDefault()
        act?.onStep?.(1)
      } else if ((key === 'k' || key === 'K') && now.position) {
        event.preventDefault()
        act?.onStep?.(-1)
      } else if ((key === 'a' || key === 'A') && now.answer === 'idle' && now.page && !now.held) {
        event.preventDefault()
        act?.onDecision?.('APPROVED')
      } else if ((key === 'r' || key === 'R') && now.answer === 'idle' && now.page && !now.held) {
        event.preventDefault()
        act?.onDecision?.('REFUSED')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 })
  }, [model.requestId])

  const nav = model.position ? (
    <span className="fw-psmp-nav">
      <Button size="sm" variant="quiet" aria-label={t('decide.previous')} heldReason={model.position.index <= 1 ? t('decide.first') : null} onClick={() => actions?.onStep?.(-1)}>
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <span className="fw-psmp-sub">{t('decide.nav', { index: model.position.index, count: model.position.count })}</span>
      <Button size="sm" variant="quiet" aria-label={t('decide.next')} heldReason={model.position.index >= model.position.count ? t('decide.last') : null} onClick={() => actions?.onStep?.(1)}>
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
            {model.position && model.position.count > 1 ? <Button onClick={() => actions?.onStep?.(1)}>{t('decide.done.next')}</Button> : null}
            <Button variant="primary" onClick={() => actions?.onClose?.()}>
              {t('decide.done.close')}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="fw-psmp-dialog" ref={body}>
        {model.state === 'loading' ? (
          <div className="fw-psmp-stack" role="status" aria-label={t('decide.loading')}>
            <Skeleton height={72} />
            <Skeleton height={160} />
            <Skeleton height={96} />
          </div>
        ) : model.state === 'error' ? (
          <div className="fw-psmp-state" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{t('decide.failed')}</span>
            {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : model.state === 'gone' || !page ? (
          <Banner tone="info" title={t('decide.gone')} />
        ) : model.answer === 'done' ? (
          <EndState
            tone={decidedTone(page.request.status)}
            title={t(`decided.${page.request.status}`)}
            body={t('decide.done.body')}
            facts={[
              ...(page.request.answer ? [{ label: t('decide.done.name'), value: page.request.answer.typedName }] : []),
              ...(page.request.answer ? [{ label: t('decide.done.at'), value: at(page.request.answer.at) }] : []),
              ...(page.request.answer?.words ? [{ label: t('decide.done.words'), value: page.request.answer.words }] : []),
            ]}
            next={page.receipt === 'SENT' ? [t('decide.done.receiptSent')] : page.receipt === 'FAILED' ? [t('decide.done.receiptFailed')] : []}
            reference={{ value: page.request.label.split(' · ')[0] ?? page.request.label, label: t('decide.done.reference') }}
            contact={{ name: page.request.from.companyName, detail: t('decide.done.contact') }}
            labels={ds.endState}
          />
        ) : (
          <>
            <WhatWeAsk page={page} model={model} />
            <div className="fw-psmp-side">
              <Pictures model={model} actions={actions} />
              <Spec page={page} />
            </div>
            <Pdfs page={page} model={model} actions={actions} pdfLabels={pdfViewerLabels(shell)} />
            <Decision page={page} model={model} actions={actions} optionKey={OPTION_KEY} />
          </>
        )}
      </div>
    </Modal>
  )
}

function WhatWeAsk({ page, model }: { page: ApprovalRead; model: DecisionDialogModel }) {
  const { t, at } = useSamplesWords()
  const waiting = page.request.status === 'OPEN'
  return (
    <section className="fw-psmp-dsection" aria-labelledby="fw-psmp-ask-what">
      <h3 id="fw-psmp-ask-what" className="fw-psmp-dtitle">
        {t('decide.what')}
      </h3>
      <blockquote className="fw-psmp-question" lang={page.locale}>
        {page.request.question}
      </blockquote>
      <KeyValue
        labelCase="sentence"
        columns={2}
        items={[
          {
            label: t('decide.due'),
            value: (
              <span className="fw-psmp-due">
                {at(page.request.dueAt)}
                {waiting ? <Countdown to={page.request.dueAt} now={model.now} label={(left) => t('decide.dueIn', { left })} doneLabel={t('decide.dueNow')} /> : null}
              </span>
            ),
          },
          { label: t('decide.from'), value: page.request.from.companyName },
          ...(model.row?.receivedAt ? [{ label: t('decide.received'), value: at(model.row.receivedAt) }] : []),
        ]}
      />
    </section>
  )
}

/** The photos of the request side by side (each as it was sent); a picture that did not load says so with Try again. */
function Pictures({ model, actions }: { model: DecisionDialogModel; actions?: DecisionActions }) {
  const { t } = useSamplesWords()
  return (
    <section className="fw-psmp-dsection" aria-labelledby="fw-psmp-ask-photos">
      <h3 id="fw-psmp-ask-photos" className="fw-psmp-dtitle">
        {t('decide.photos')}
      </h3>
      {model.pictures.length === 0 ? (
        <p className="fw-psmp-sub">{t('decide.photosNone')}</p>
      ) : (
        <ul className="fw-psmp-photos">
          {model.pictures.map((picture) => (
            <li key={picture.id} className="fw-psmp-photo">
              {picture.state === 'ready' && typeof picture.src === 'string' ? (
                <a href={picture.src} target="_blank" rel="noreferrer" aria-label={t('decide.photoOpen', { name: picture.name })}>
                  <img src={picture.src} alt={t('decide.photoAlt', { name: picture.name })} />
                </a>
              ) : picture.state === 'loading' ? (
                <Skeleton height={140} />
              ) : (
                <span className="fw-psmp-photo-failed">
                  <span>{t('decide.photoFailed')}</span>
                  <Button size="sm" onClick={() => actions?.onRetryPicture?.(picture.id)}>
                    {t('state.retry')}
                  </Button>
                </span>
              )}
              <span className="fw-psmp-sub fw-psmp-ellipsis" title={picture.name}>
                {picture.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The sample as the office describes it (the request's facts: Sample, Style, Revision, Sizes) — beside the photos. */
function Spec({ page }: { page: ApprovalRead }) {
  const { t } = useSamplesWords()
  if (page.content.facts.length === 0) return null
  return (
    <section className="fw-psmp-dsection" aria-labelledby="fw-psmp-ask-spec">
      <h3 id="fw-psmp-ask-spec" className="fw-psmp-dtitle">
        {t('decide.spec')}
      </h3>
      <KeyValue labelCase="sentence" items={page.content.facts.map((fact) => ({ label: fact.label, value: <span lang={page.locale}>{fact.value}</span> }))} />
    </section>
  )
}

function Pdfs({ page, model, actions, pdfLabels }: { page: ApprovalRead; model: DecisionDialogModel; actions?: DecisionActions; pdfLabels: ReturnType<typeof pdfViewerLabels> }) {
  const { t } = useSamplesWords()
  const pdfs = page.files.filter((file) => file.contentType.toLowerCase() === 'application/pdf')
  if (pdfs.length === 0) return null
  const open = model.pdf
  return (
    <section className="fw-psmp-dsection" aria-labelledby="fw-psmp-ask-files">
      <h3 id="fw-psmp-ask-files" className="fw-psmp-dtitle">
        {t('decide.files')}
      </h3>
      <ul className="fw-psmp-files">
        {pdfs.map((file) => (
          <li key={file.id}>
            <Button size="sm" aria-pressed={open?.id === file.id} aria-label={t('decide.fileOpen', { name: file.originalName })} onClick={() => actions?.onOpenPdf?.(open?.id === file.id ? null : file.id)}>
              <FileText size={14} aria-hidden /> {file.originalName}
            </Button>
          </li>
        ))}
      </ul>
      {open ? (
        open.state === 'loading' ? (
          <p className="fw-psmp-sub" role="status">
            {t('decide.fileLoading', { name: open.name })}
          </p>
        ) : open.state === 'error' || !(open.src instanceof Uint8Array) ? (
          <Banner tone="warning" title={t('decide.fileFailed', { name: open.name })} action={<Button size="sm" onClick={() => actions?.onOpenPdf?.(open.id)}>{t('state.retry')}</Button>} />
        ) : (
          <PdfViewer src={open.src} title={open.name} fileName={open.name} labels={pdfLabels} height="min(60vh, 640px)" />
        )
      ) : null}
    </section>
  )
}

function Decision({ page, model, actions, optionKey }: { page: ApprovalRead; model: DecisionDialogModel; actions?: DecisionActions; optionKey: Readonly<Record<ApprovalDecision, string>> }) {
  const { t, locale } = useSamplesWords()
  const decisions = decisionsOf(page)
  const held = model.held
  const busy = model.answer === 'busy'
  const company = page.request.from.companyName
  const what = model.row ? decisionWhat(model.row, t, locale) : (page.request.label.split(' · ')[0] ?? page.request.label)
  const commentLabel = t(model.decision === 'REFUSED' ? 'decide.comment.why' : model.decision === 'APPROVED_WITH_CHANGES' ? 'decide.comment.what' : 'decide.comment.optional')
  const decisionError = model.field === 'decision' && model.problem ? t(model.problem) : null
  const commentError = model.field === 'comment' && model.problem ? t(model.problem) : undefined
  const message = model.field === null && model.problem ? t(model.problem) : undefined
  return (
    <section className="fw-psmp-dsection" aria-labelledby="fw-psmp-ask-decision">
      <h3 id="fw-psmp-ask-decision" className="fw-psmp-dtitle">
        {t('decide.decision')}
      </h3>
      <fieldset className="fw-psmp-choices" aria-describedby={decisionError ? 'fw-psmp-decision-error' : undefined}>
        <legend className="fw-psmp-legend">{t('decide.legend')}</legend>
        <div className="fw-psmp-choice-grid" data-count={decisions.length}>
          {decisions.map((decision) => (
            <RadioCard
              key={decision}
              name="fw-psmp-decision"
              value={decision}
              checked={model.decision === decision}
              selected={model.decision === decision}
              readOnly={!!held}
              onChange={() => !held && actions?.onDecision?.(decision)}
              title={t(`decide.option.${optionKey[decision]}`)}
              description={t(`decide.option.${optionKey[decision]}_body`)}
            />
          ))}
        </div>
        {decisionError ? (
          <p id="fw-psmp-decision-error" className="fw-psmp-error" role="alert">
            {decisionError}
          </p>
        ) : null}
      </fieldset>
      <Field label={commentLabel} hint={commentNeeded(model.decision) ? t('decide.comment.needed') : t('decide.comment.hint')} error={commentError} required={commentNeeded(model.decision)}>
        <Textarea id="fw-psmp-comment" value={model.comment} rows={3} limit={ANSWER_LIMITS.answer} readOnly={!!held || busy} onChange={(event) => actions?.onComment?.(event.target.value)} />
      </Field>
      <SignBlock
        title={<span className="fw-psmp-dtitle">{t('decide.sign.title')}</span>}
        summary={<p className="fw-psmp-sub">{model.decision ? t(`decide.sign.summary.${optionKey[model.decision]}`, { what, company }) : t('decide.sign.summary.none')}</p>}
        legal={<p className="fw-psmp-sub">{t('decide.sign.legal', { company })}</p>}
        nameLabel={t('decide.sign.name')}
        nameHint={t('decide.sign.nameHint')}
        nameEmptyLabel={t('decide.sign.nameEmpty')}
        acceptLabel={model.decision ? t(`decide.sign.go.${optionKey[model.decision]}`) : t('decide.sign.choose')}
        onAccept={(signed) => actions?.onSign?.(signed.name)}
        state={busy ? 'busy' : 'idle'}
        busyLabel={t('decide.sign.busy')}
        heldReason={held}
        message={message}
        messageTone="danger"
      />
    </section>
  )
}
