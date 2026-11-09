'use client'

import { useEffect, useState } from 'react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Countdown, Textarea, useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { ApprovalPage, LinkDecision } from '../api'
import { ANSWER_LIMITS, commentNeeded, decidedTone, decisionsOf, isDecided, signLabelKey, type ApproveActions, type ApproveViewModel } from '../model'
import { FileViewer } from './FileViewer'
import { KindPanelView } from './KindPanels'
import { MarkPhotoDialog } from './MarkPhotoDialog'
import '../approve.css'

export type { ApproveViewModel, ApproveActions } from '../model'

/**
 * SCR-198 — Approve (design links.approve; 00 §2.9 one-off link page): the link frame (the sender, the language, whom to
 * ask, the privacy notice) around ONE task — what we ask (kind, record, due with its countdown, who asks, the question),
 * the kind's own panel (a revised order line by line old → new; the design proof; the concession; a sample, colour,
 * leather or artwork with its photos and spec; a document to sign), then your decision (Approve · Approve with changes
 * where the kind allows · Refuse, the comment — needed with changes and with a refusal —, a photo marked, and the
 * SignBlock: the typed name; Enter signs). The end (EndState) says what happens next and repeats the receipt. A request
 * that takes no answer now says why (the API's words) and holds the sign button with that reason, never disabled.
 * No money but in a revised order's panel (the party's own order); never a cost or a margin.
 */
export function ApproveView({ model, actions }: { model: ApproveViewModel; actions?: ApproveActions }) {
  return (
    <WithMessages namespaces={['link-approve', 'photo-kit']}>
      <Approve model={model} actions={actions} />
    </WithMessages>
  )
}

function Approve({ model, actions }: { model: ApproveViewModel; actions?: ApproveActions }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const page = model.page
  const valid = model.link === 'valid'
  // B-W2b-F16: the kind in our words from its code, the record in the reader's language.
  const title = page ? t('title', { kind: t(`kind.${page.request.kind}`), label: page.request.words[locale] }) : null
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.request.from.companyName } : null,
        title,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'APPROVAL', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? <Body page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** The request is read: skeleton cards in the shape of the page; after about a second, "Still loading…". */
function Loading() {
  const t = useT('link-approve')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-ap-stack" aria-busy="true">
      <Card padded className="fw-ap-card">
        <Skeleton width="40%" height={22} />
        <Skeleton width="100%" height={64} />
      </Card>
      <Card padded className="fw-ap-card">
        <Skeleton width="30%" height={22} />
        <Skeleton width="100%" height={160} />
      </Card>
      <p className="fw-ap-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

/** A failed read is never drawn as an empty request: the problem in our words and Try again. */
function ReadProblem({ model, actions }: { model: ApproveViewModel; actions?: ApproveActions }) {
  const t = useT('link-approve')
  return (
    <Banner
      tone="danger"
      title={t(model.problem ?? 'problem.read')}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('retry')}
        </Button>
      }
    >
      {t('problem.readBody')}
    </Banner>
  )
}

function Body({ page, model, actions }: { page: ApprovalPage; model: ApproveViewModel; actions?: ApproveActions }) {
  const decided = isDecided(page)
  return (
    <div className="fw-ap-stack">
      {decided ? <Decided page={page} model={model} /> : page.may.held ? <Banner tone="warning" title={page.may.held} /> : null}
      <WhatWeAsk page={page} model={model} />
      <KindPanelView page={page} model={model} actions={actions} />
      {!decided && <Decision page={page} model={model} actions={actions} />}
      <FileViewer page={page} model={model} actions={actions} />
      {model.marking && <MarkPhotoDialog marking={model.marking} actions={actions} />}
    </div>
  )
}

/** Design sec:what — kind, record, due (with its countdown while it waits), who asks, and the question in their words. */
function WhatWeAsk({ page, model }: { page: ApprovalPage; model: ApproveViewModel }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const request = page.request
  const waiting = request.status === 'OPEN' && page.may.answer
  return (
    <Card padded className="fw-ap-card">
      <h2 className="fw-ap-h2">{t('what.title')}</h2>
      <blockquote className="fw-ap-question" lang={page.locale}>
        {request.question}
      </blockquote>
      <KeyValue
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('what.kind'), value: t(`kind.${request.kind}`) },
          { label: t('what.record'), value: request.words[locale] },
          {
            label: t('what.due'),
            value: (
              <span className="fw-ap-due">
                <span>{formatDate(request.dueAt, { locale, timeZone: model.timeZone })}</span>
                {waiting && <Countdown to={request.dueAt} now={model.now} label={(left) => t('what.dueIn', { left })} doneLabel={t('what.dueNow')} className="fw-ap-countdown" />}
              </span>
            ),
          },
          { label: t('what.from'), value: request.from.companyName },
          { label: t('what.state'), value: t(`state.${request.status}`) },
          { label: t('what.dueAt'), value: formatDateTime(request.dueAt, { locale, timeZone: model.timeZone }) },
        ]}
      />
    </Card>
  )
}

/** Design sec:decision — the answer, the comment, a marked photo, and the typed name that signs it (Enter signs). */
function Decision({ page, model, actions }: { page: ApprovalPage; model: ApproveViewModel; actions?: ApproveActions }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const decisions = decisionsOf(page)
  const held = page.may.answer ? null : (page.may.held ?? t('decision.held'))
  const busy = model.answer === 'busy'
  const markupFile = model.markup ? page.files.find((file) => file.id === model.markup!.fileId) : null
  const commentLabel = t(model.decision === 'REFUSED' ? 'decision.comment.why' : model.decision === 'APPROVED_WITH_CHANGES' ? 'decision.comment.what' : 'decision.comment.optional')
  const decisionError = model.field === 'decision' && model.problem ? t(model.problem) : null
  const commentError = model.field === 'comment' && model.problem ? t(model.problem) : undefined
  const message = model.field === null && model.problem ? t(model.problem) : undefined
  return (
    <Card padded className="fw-ap-card" id="fw-ap-decision">
      <h2 className="fw-ap-h2">{t('decision.title')}</h2>
      <fieldset className="fw-ap-choices" aria-describedby={decisionError ? 'fw-ap-decision-error' : undefined}>
        <legend className="fw-ap-legend">{t('decision.legend')}</legend>
        <div className="fw-ap-choice-grid" data-count={decisions.length}>
          {decisions.map((decision: LinkDecision) => (
            <RadioCard
              key={decision}
              name="fw-ap-decision"
              value={decision}
              checked={model.decision === decision}
              selected={model.decision === decision}
              readOnly={!!held}
              onChange={() => !held && actions?.onDecision?.(decision)}
              title={t(`decision.option.${decision}.title`)}
              description={t(`decision.option.${decision}.body`)}
            />
          ))}
        </div>
        {decisionError && (
          <p id="fw-ap-decision-error" className="fw-ap-error" role="alert">
            {decisionError}
          </p>
        )}
      </fieldset>
      <Field label={commentLabel} hint={commentNeeded(model.decision) ? t('decision.comment.needed') : t('decision.comment.hint')} error={commentError} required={commentNeeded(model.decision)}>
        <Textarea id="fw-ap-comment" value={model.comment} rows={4} limit={ANSWER_LIMITS.answer} readOnly={!!held || busy} onChange={(event) => actions?.onComment?.(event.target.value)} />
      </Field>
      <div className="fw-ap-markup-line" role="status">
        {model.markup && markupFile ? (
          <>
            <span>{t('decision.marked', { name: markupFile.originalName, count: model.markup.marks.length })}</span>
            {model.markup.note.trim() && <span className="fw-ap-hint">“{model.markup.note.trim()}”</span>}
            <span className="fw-ap-actions">
              <Button size="sm" heldReason={held} onClick={() => actions?.onMark?.(markupFile.id)}>
                {t('decision.markEdit')}
              </Button>
              <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onMarkRemove?.()}>
                {t('decision.markRemove')}
              </Button>
            </span>
          </>
        ) : (
          <span className="fw-ap-hint">{page.files.length > 0 ? t('decision.markHint') : t('decision.noPhotos')}</span>
        )}
      </div>
      <SignBlock
        title={<span className="fw-ap-h3">{t('sign.title')}</span>}
        summary={<p className="fw-ap-hint">{model.decision ? t(`sign.summary.${model.decision}`, { label: page.request.words[locale], company: page.request.from.companyName }) : t('sign.summary.none')}</p>}
        legal={<p className="fw-ap-hint">{t('sign.legal', { company: page.request.from.companyName })}</p>}
        nameLabel={t('sign.name')}
        nameHint={t('sign.nameHint')}
        nameEmptyLabel={t('sign.nameEmpty')}
        acceptLabel={t(signLabelKey(model.decision))}
        onAccept={(signed) => actions?.onSign?.(signed.name)}
        state={busy ? 'busy' : 'idle'}
        busyLabel={t('sign.busy')}
        heldReason={held}
        message={message}
        messageTone="danger"
      />
    </Card>
  )
}

/** Design sec:done — the answer as signed and what happens next (the API's words), with the receipt. */
function Decided({ page, model }: { page: ApprovalPage; model: ApproveViewModel }) {
  const t = useT('link-approve')
  const locale = useLocale()
  const ds = useDsWords()
  const request = page.request
  const answer = request.answer
  const receipt = page.receipt ?? null
  return (
    <EndState
      tone={decidedTone(request.status)}
      title={t(`state.${request.status}`)}
      body={request.decided}
      facts={[
        ...(answer ? [{ label: t('done.name'), value: answer.typedName }, { label: t('done.at'), value: formatDateTime(answer.at, { locale, timeZone: model.timeZone }) }] : []),
        ...(answer?.words ? [{ label: t('done.words'), value: answer.words }] : []),
        ...(answer?.markupFileId ? [{ label: t('done.marks'), value: t('done.marksValue') }] : []),
      ]}
      next={receipt === 'SENT' ? [t('done.receiptSent'), t('done.closed')] : receipt === 'FAILED' ? [t('done.receiptFailed'), t('done.closed')] : [t('done.closed')]}
      reference={{ value: request.words[locale], label: t('done.reference') }}
      contact={{ name: request.from.companyName, detail: t('done.contact') }}
      labels={ds.endState}
    />
  )
}
