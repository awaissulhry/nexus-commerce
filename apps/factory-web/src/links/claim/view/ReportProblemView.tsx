'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Card, Stepper } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { ClaimPage } from '../api'
import {
  ANSWER_DAYS,
  nextOf,
  previousOf,
  sendHeldKey,
  stepIndex,
  STEPS,
  uploadSummary,
  worthKeeping,
  type ClaimActions,
  type ClaimViewModel,
  type DoneModel,
  type Step,
} from '../model'
import { RepairsCard } from '../types/repair/Steps'
import { OTHER_GARMENT, repairItemOf } from '../types/repair/model'
import { CasesCard } from './Cases'
import { itemTitle } from './items'
import { PhotoDialog } from './PhotoDialog'
import { ScanDialog } from './ScanDialog'
import { DetailsStep, ItemStep, PhotosStep, ReviewStep, TypeStep } from './Steps'
import '../claim.css'

export type { ClaimViewModel, ClaimActions } from '../model'

/**
 * SCR-197 — Report a problem (design links.claim; 00 §2.9 one-off link page, §2.6 a guided flow): the link frame (the
 * sender, the language, whom to ask, the privacy notice) around ONE task in five steps — What do you need? (big choice
 * cards: a return or a quality complaint) · Which item (from the shipment's or order's items; the serial scanned from the
 * label or typed) · Tell us more (each type's own questions) · Photos (marked to circle the problem; at least two of a
 * damage) · Check and send (one screen) — then Sent (EndState: the case number and the next step). The band says how the
 * draft kept with us stands (SaveStatus) and offers Finish later; ← → move between steps where no field takes the keys.
 * Continue checks its step and says what to fix at the field; the send is held with its reason when the link takes no
 * more reports. No money anywhere on this page.
 */
export function ReportProblemView({ model, actions }: { model: ClaimViewModel; actions?: ClaimActions }) {
  return (
    <WithMessages namespaces={['link-claim', 'photo-kit', 'returns-repair']}>
      <ReportProblem model={model} actions={actions} />
    </WithMessages>
  )
}

function ReportProblem({ model, actions }: { model: ClaimViewModel; actions?: ClaimActions }) {
  const t = useT('link-claim')
  const page = model.page
  const valid = model.link === 'valid'
  const title = page ? t('title', { record: t(`record.${page.record.type === 'Shipment' ? 'Shipment' : 'SalesOrder'}`, { label: page.record.label }) }) : null
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.sender.companyName } : null,
        title,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'CLAIM', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? model.done ? <Done page={page} done={model.done} model={model} actions={actions} /> : <Wizard page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** The page is read: skeleton cards in the shape of the choice cards; after about a second, "Still loading…". */
function Loading() {
  const t = useT('link-claim')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-cl-stack" aria-busy="true">
      <Skeleton width="100%" height={36} />
      <Card padded className="fw-cl-card">
        <Skeleton width="45%" height={24} />
        <div className="fw-cl-choices">
          <Skeleton width="100%" height={112} />
          <Skeleton width="100%" height={112} />
        </div>
      </Card>
      <p className="fw-cl-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

/** A failed read is never drawn as an empty page: the problem in our words and Try again. */
function ReadProblem({ model, actions }: { model: ClaimViewModel; actions?: ClaimActions }) {
  const t = useT('link-claim')
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

function Wizard({ page, model, actions }: { page: ClaimPage; model: ClaimViewModel; actions?: ClaimActions }) {
  // B-W2b-342: a repair's refusal names its own catalogue (`returns-repair:…`); every other key is link-claim's.
  const t = useScopedT('link-claim')
  const r = useT('returns-repair')
  const locale = useLocale()
  const ds = useDsWords()
  const step = model.step
  const busy = model.send === 'busy'
  const held = sendHeldKey(page)
  const here = useRef(actions)
  here.current = actions

  // ← → between steps (design kb), never while a field, a choice or a dialog takes the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="radiogroup"], [role="slider"], [role="listbox"]')) return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      if (event.key === 'ArrowRight') here.current?.onNext?.()
      else here.current?.onBack?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const steps = STEPS.map((key) => ({ key, label: t(`step.${key}.short`) }))
  const previous = previousOf(step)
  const next = nextOf(step)
  return (
    <div className="fw-cl-stack">
      {model.draft.restoredAt && (
        <Banner
          tone="info"
          title={t('draft.restored', { day: formatDate(model.draft.restoredAt, { locale, timeZone: model.timeZone }), time: formatTime(model.draft.restoredAt, { locale, timeZone: model.timeZone }) })}
          action={
            <span className="fw-cl-actions">
              <Button size="sm" onClick={() => actions?.onDismissRestored?.()}>
                {t('draft.keep')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onStartAgain?.()}>
                {t('draft.startAgain')}
              </Button>
            </span>
          }
        >
          {t('draft.restoredBody')}
        </Banner>
      )}
      {page.cases.length > 0 && <CasesCard page={page} model={model} actions={actions} compact />}
      <RepairsCard offer={model.repairOffer ?? null} timeZone={model.timeZone} compact />
      <div className="fw-cl-band">
        <Stepper steps={steps} current={stepIndex(step)} onSelect={(index) => actions?.onStep?.(STEPS[index]!)} canSelect={(index) => index !== stepIndex(step)} className="fw-cl-stepper" />
        <div className="fw-cl-save">
          <SaveStatus
            state={model.draft.status}
            onRetry={() => actions?.onSaveRetry?.()}
            formatTime={(iso) => formatTime(iso, { locale, timeZone: model.timeZone })}
            locale={locale}
            size="sm"
            labels={ds.saveStatus}
          />
          <Button size="sm" variant="quiet" heldReason={worthKeeping(model.form) ? null : t('later.held')} onClick={() => actions?.onFinishLater?.()}>
            {t('later.button')}
          </Button>
        </div>
      </div>
      {model.draft.later && model.draft.status.kind === 'saved' && (
        <Banner tone="success" title={t('later.saved')}>
          {t('later.savedBody', { day: formatDate(page.link.expiresAt, { locale, timeZone: model.timeZone }) })}
        </Banner>
      )}
      {model.problem && (
        <Banner tone="danger" title={t(model.problem)} action={model.problem === 'problem.unavailable' || model.problem === 'problem.internal' || model.problem === 'problem.rateLimited' ? <Button size="sm" onClick={() => actions?.onSend?.()}>{t('retry')}</Button> : undefined}>
          {t(`${model.problem}Body`)}
        </Banner>
      )}
      <Card padded className="fw-cl-card">
        <div className="fw-cl-head">
          <p className="fw-cl-count">{t('step.count', { at: stepIndex(step) + 1, of: STEPS.length })}</p>
          <h2 id="fw-cl-step-heading" className="fw-cl-h2" tabIndex={-1}>
            {t(`step.${step}.title`)}
          </h2>
          <p className="fw-cl-hint">{t(`step.${step}.lead`, { sender: page.sender.companyName })}</p>
        </div>
        <StepBody step={step} page={page} model={model} actions={actions} />
        <div className="fw-cl-nav">
          {previous ? (
            <Button onClick={() => actions?.onBack?.()} heldReason={busy ? t('send.busy') : null}>
              {t('nav.back')}
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button variant="primary" onClick={() => actions?.onNext?.()}>
              {t('nav.next', { step: t(`step.${next}.short`) })}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={busy ? t('send.busy') : held ? t(held, { sender: page.sender.companyName }) : null}>
              {busy ? (
                <>
                  <Spinner size={14} /> {t('send.busy')}
                </>
              ) : (
                model.form.type === 'REPAIR' ? r('link.send') : t(`send.button.${model.form.type ?? 'RETURN'}`)
              )}
            </Button>
          )}
        </div>
        <p className="fw-cl-keys">{t('nav.keys')}</p>
      </Card>
      {model.photoFor !== null && <PhotoDialog model={model} page={page} actions={actions} />}
      {model.scanFor !== null && <ScanDialog actions={actions} />}
    </div>
  )
}

function StepBody({ step, page, model, actions }: { step: Step; page: ClaimPage; model: ClaimViewModel; actions?: ClaimActions }) {
  switch (step) {
    case 'type':
      return <TypeStep page={page} model={model} actions={actions} />
    case 'item':
      return <ItemStep page={page} model={model} actions={actions} />
    case 'details':
      return <DetailsStep page={page} model={model} actions={actions} />
    case 'photos':
      return <PhotosStep page={page} model={model} actions={actions} />
    case 'review':
      return <ReviewStep page={page} model={model} actions={actions} />
  }
}

/** Design sec:done — the case number and the next step, how the photos went, and this link's reports. */
function Done({ page, done, model, actions }: { page: ClaimPage; done: DoneModel; model: ClaimViewModel; actions?: ClaimActions }) {
  const t = useT('link-claim')
  const r = useT('returns-repair')
  const locale = useLocale()
  const ds = useDsWords()
  const sent = done.sent
  const uploads = uploadSummary(done.uploads)
  const held = sendHeldKey(page)
  const repairItem = sent.type === 'REPAIR' ? (done.form.repair.itemKey === OTHER_GARMENT ? r('link.item.other') : itemTitle(repairItemOf(page, done.form.repair.itemKey), t)) : null
  const items =
    repairItem !== null
      ? [[repairItem, done.form.repair.serial.trim() ? r('common.serial', { serial: done.form.repair.serial.trim() }) : null].filter(Boolean).join(' · ')]
      : sent.type === 'RETURN'
      ? done.form.picks.map((pick) => {
          const item = page.items.find((entry) => entry.key === pick.key)
          return t('done.itemLine', { item: item ? itemTitle(item, t) : pick.key, pieces: pick.quantity })
        })
      : [done.form.itemKey && done.form.itemKey !== '*' ? itemTitle(page.items.find((entry) => entry.key === done.form.itemKey) ?? null, t) : t('item.whole')]
  const photosLine = uploads.total === 0 ? null : uploads.busy > 0 ? t('done.photos.busy', { sent: uploads.sent, total: uploads.total }) : uploads.failed > 0 ? t('done.photos.failed', { count: uploads.failed }) : t('done.photos.sent', { count: uploads.sent })
  return (
    <div className="fw-cl-stack">
      <EndState
        tone="success"
        title={sent.type === 'REPAIR' ? r('link.done.title', { number: sent.number }) : t(`done.title.${sent.type}`, { number: sent.number })}
        body={sent.answerBy ? t('done.answerBy', { day: formatDate(sent.answerBy, { locale, timeZone: model.timeZone }) }) : t('done.answerWithin', { days: ANSWER_DAYS })}
        next={[sent.type === 'REPAIR' ? r('link.done.next') : t(`done.next.${sent.type}`), ...(photosLine ? [photosLine] : []), page.link.usesLeft > 0 && page.link.live ? t('done.again', { day: formatDate(page.link.expiresAt, { locale, timeZone: model.timeZone }) }) : t('done.noMore', { sender: page.sender.companyName })]}
        facts={[
          { label: t('done.fact.type'), value: sent.type === 'REPAIR' ? r(`common.kind.${done.form.repair.kind}`) : t(`type.${sent.type}.title`) },
          { label: t(sent.type === 'RETURN' ? 'done.fact.items' : 'done.fact.item'), value: items.join(' · ') },
          ...(done.form.customerRef.trim() ? [{ label: t('done.fact.yourRef'), value: done.form.customerRef.trim() }] : []),
          ...(done.form.typedName.trim() ? [{ label: t('done.fact.by'), value: done.form.typedName.trim() }] : []),
        ]}
        reference={{ value: sent.number, label: t('done.reference') }}
        actions={[{ label: t('done.another'), onClick: () => actions?.onAnother?.(), heldReason: held ? t(held, { sender: page.sender.companyName }) : null }]}
        contact={{ name: page.sender.companyName, detail: t('done.contact') }}
        labels={ds.endState}
      >
        {uploads.failed > 0 && uploads.busy === 0 && (
          <Banner
            tone="warning"
            title={t('done.photos.failedTitle', { count: uploads.failed })}
            action={
              <Button size="sm" onClick={() => actions?.onRetryPhotos?.()}>
                {t('retry')}
              </Button>
            }
          >
            {t('done.photos.failedBody')}
          </Banner>
        )}
        {uploads.busy > 0 && (
          <p className="fw-cl-hint" role="status">
            <Spinner size={14} /> {t('done.photos.busy', { sent: uploads.sent, total: uploads.total })}
          </p>
        )}
      </EndState>
      <CasesCard page={page} model={model} actions={actions} />
      <RepairsCard offer={model.repairOffer ?? null} timeZone={model.timeZone} />
    </div>
  )
}
