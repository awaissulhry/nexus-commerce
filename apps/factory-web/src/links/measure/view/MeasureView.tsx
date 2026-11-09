'use client'

import { useEffect, useState } from 'react'
import { Banner, Card, Stepper } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { PHOTO_RETENTION_DAYS_AFTER_SHIPPING } from '@nexus/factory-domain/sales/measure-link/rules'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { MeasurePage, MeasureSent } from '../api'
import { nextOf, previousOf, sendHeldKey, stepIndex, STEPS, worthKeeping, type MeasureActions, type MeasureViewModel, type Step } from '../model'
import { GuideDialog, PhotoDialog } from './Dialogs'
import { BasicsStep, FitStep, PhotosStep, PointsStep, ReviewStep, StartStep } from './Steps'
import '../measure.css'

export type { MeasureViewModel, MeasureActions } from '../model'

/**
 * SCR-195 — Send measurements (design links.measure; 00 §2.9 one-off link page, §2.6 a guided flow): the link frame (the
 * sender, the language, whom to ask, the privacy notice) around ONE task in six steps — Before you start and Your data (the
 * notice comes before any field: every later step is held until the tick, GDPR art. 13) · About you · Measurements (by body
 * zone, a picture and a guide per point, hints that never block; Enter → next point) · How you like it · Photos (front, side,
 * back in a base layer) · Check and send — then Sent (EndState). The band says how the draft kept with us stands
 * (SaveStatus) and offers Finish later. No money anywhere on this page.
 */
export function MeasureView({ model, actions }: { model: MeasureViewModel; actions?: MeasureActions }) {
  return (
    <WithMessages namespaces={['link-measure', 'photo-kit']}>
      <Measure model={model} actions={actions} />
    </WithMessages>
  )
}

function Measure({ model, actions }: { model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  const t = useT('link-measure')
  const locale = useLocale()
  const page = model.page
  const valid = model.link === 'valid'
  const title = page ? t('title', { garment: page.garment.name[locale] }) : null
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.sender.companyName } : null,
        title,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'MEASUREMENTS', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? model.done ? <Done page={page} sent={model.done} model={model} /> : <Wizard page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** The page is read: skeleton cards in the shape of the form; after about a second, "Still loading…". */
function Loading() {
  const t = useT('link-measure')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-ms-stack" aria-busy="true">
      <Skeleton width="100%" height={36} />
      <Card padded className="fw-ms-card">
        <Skeleton width="45%" height={24} />
        <Skeleton width="100%" height={72} />
        <Skeleton width="100%" height={120} />
      </Card>
      <p className="fw-ms-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

/** A failed read is never drawn as an empty form: the problem in our words and Try again. */
function ReadProblem({ model, actions }: { model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  const t = useT('link-measure')
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

const RETRYABLE = new Set(['problem.unavailable', 'problem.internal', 'problem.rateLimited'])

function Wizard({ page, model, actions }: { page: MeasurePage; model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  const t = useT('link-measure')
  const locale = useLocale()
  const ds = useDsWords()
  const step = model.step
  const held = sendHeldKey(model)
  const read = page.noticeRead !== null
  const steps = STEPS.map((key) => ({ key, label: t(`step.${key}.short`) }))
  const previous = previousOf(step)
  const next = nextOf(step)
  return (
    <div className="fw-ms-stack">
      {model.draft.restoredAt && (
        <Banner
          tone="info"
          title={t('draft.restored', { day: formatDate(model.draft.restoredAt, { locale, timeZone: model.timeZone }), time: formatTime(model.draft.restoredAt, { locale, timeZone: model.timeZone }) })}
          action={
            <span className="fw-ms-actions">
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
      <div className="fw-ms-band">
        <Stepper steps={steps} current={stepIndex(step)} onSelect={(index) => actions?.onStep?.(STEPS[index]!)} canSelect={(index) => index !== stepIndex(step) && (read || index === 0)} className="fw-ms-stepper" />
        <div className="fw-ms-save">
          <SaveStatus state={model.draft.status} onRetry={() => actions?.onSaveRetry?.()} formatTime={(iso) => formatTime(iso, { locale, timeZone: model.timeZone })} locale={locale} size="sm" labels={ds.saveStatus} />
          <Button size="sm" variant="quiet" heldReason={!read ? t('held.notice') : worthKeeping(model.form) ? null : t('later.held')} onClick={() => actions?.onFinishLater?.()}>
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
        <Banner tone={model.problem === 'problem.fix' ? 'warning' : 'danger'} title={t(model.problem)} action={RETRYABLE.has(model.problem) ? <Button size="sm" onClick={() => actions?.onSend?.()}>{t('retry')}</Button> : undefined}>
          {t(`${model.problem}Body`, { sender: page.sender.companyName })}
        </Banner>
      )}
      <Card padded className="fw-ms-card">
        <div className="fw-ms-head">
          <p className="fw-ms-count">{t('step.count', { at: stepIndex(step) + 1, of: STEPS.length })}</p>
          <h2 id="fw-ms-step-heading" className="fw-ms-h2" tabIndex={-1}>
            {t(`step.${step}.title`)}
          </h2>
          <p className="fw-ms-hint">{t(`step.${step}.lead`, { sender: page.sender.companyName, rider: page.rider.name })}</p>
        </div>
        <StepBody step={step} page={page} model={model} actions={actions} />
        <div className="fw-ms-nav">
          {previous ? (
            <Button onClick={() => actions?.onBack?.()} heldReason={model.send === 'busy' ? t('send.busy') : null}>
              {t('nav.back')}
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button variant="primary" heldReason={!page.notice ? t('held.noNotice', { sender: page.sender.companyName }) : !read && step === 'start' ? t('held.notice') : null} onClick={() => actions?.onNext?.()}>
              {t('nav.next', { step: t(`step.${next}.short`) })}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={held ? t(held, { sender: page.sender.companyName }) : null}>
              {model.send === 'busy' ? (
                <>
                  <Spinner size={14} /> {t('send.busy')}
                </>
              ) : (
                t('send.button')
              )}
            </Button>
          )}
        </div>
      </Card>
      {model.photoFor !== null && <PhotoDialog view={model.photoFor} model={model} actions={actions} />}
      {model.guideFor !== null && <GuideDialog page={page} model={model} actions={actions} />}
    </div>
  )
}

function StepBody({ step, page, model, actions }: { step: Step; page: MeasurePage; model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  switch (step) {
    case 'start':
      return <StartStep page={page} model={model} actions={actions} />
    case 'basics':
      return <BasicsStep page={page} model={model} actions={actions} />
    case 'points':
      return <PointsStep page={page} model={model} actions={actions} />
    case 'fit':
      return <FitStep page={page} model={model} actions={actions} />
    case 'photos':
      return <PhotosStep page={page} model={model} actions={actions} />
    case 'review':
      return <ReviewStep page={page} model={model} actions={actions} />
  }
}

/** Design sec:done — thank you, what happens next, what we keep and for how long. */
function Done({ page, sent, model }: { page: MeasurePage; sent: MeasureSent; model: MeasureViewModel }) {
  const t = useT('link-measure')
  const locale = useLocale()
  const ds = useDsWords()
  const name = model.typedName.trim() || page.rider.name
  return (
    <EndState
      tone="success"
      title={t('done.title', { name })}
      body={t('done.body')}
      next={[t('done.next.check'), sent.photos > 0 ? t('done.next.photos', { days: PHOTO_RETENTION_DAYS_AFTER_SHIPPING }) : t('done.next.noPhotos'), t('done.next.again', { sender: page.sender.companyName })]}
      facts={[
        { label: t('done.fact.garment'), value: page.garment.name[locale] },
        { label: t('done.fact.sent'), value: formatDateTime(sent.at, { locale, timeZone: model.timeZone }) },
        { label: t('done.fact.version'), value: String(sent.revision) },
        { label: t('done.fact.photos'), value: t('done.photoCount', { count: sent.photos }) },
      ]}
      contact={{ name: page.sender.companyName, detail: t('done.contact') }}
      labels={ds.endState}
    />
  )
}
