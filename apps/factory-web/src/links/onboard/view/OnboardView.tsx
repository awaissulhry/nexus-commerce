'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Card, Stepper } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SaveStatus } from '@nexus/ui/components/SaveStatus/index'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { OnboardPage, OnboardSent } from '../api'
import { nextOf, previousOf, stepIndex, STEPS, worthKeeping, type OnboardActions, type OnboardViewModel, type Step } from '../model'
import { CertificationsStep, CompanyStep, ContactsStep, Intro, LabourStep, SignStep, SitesStep } from './Steps'
import '../onboard.css'

export type { OnboardViewModel, OnboardActions } from '../model'

/**
 * SCR-269 — Supplier questionnaire (design links.onboard; 00 §2.9 one-off link page, §2.6 a guided flow): the link frame
 * (the sender, the language, whom to ask, the privacy notice) around ONE task — Why we ask (the Forced Labour Regulation
 * (EU) 2024/3015 due diligence: about 20 minutes, save and go on later, who reads it) and six steps from the version's
 * questions: 1 · Company (the VAT number checked live in VIES) · 2 · Contacts · 3 · Sites and sub-suppliers (for leather:
 * who does each step, where) · 4 · Certifications and tests (documents with their issue and expiry day, captured once) ·
 * 5 · Labour and social (yes / no and why; the code of conduct read in a new tab and signed) · 6 · Review and send (every
 * answer with Change, the signer's role, the SignBlock: name and "true to the best of my knowledge") — then Sent
 * (EndState: who reviews it, what happens next). The band shows where you are (Stepper, "3 of 6"), how the draft kept
 * with us stands (SaveStatus) and Finish later; ← → move between steps where no field takes the keys. No money anywhere.
 */
export function OnboardView({ model, actions }: { model: OnboardViewModel; actions?: OnboardActions }) {
  return (
    <WithMessages namespaces={['link-onboard']}>
      <Onboard model={model} actions={actions} />
    </WithMessages>
  )
}

function Onboard({ model, actions }: { model: OnboardViewModel; actions?: OnboardActions }) {
  const t = useT('link-onboard')
  const page = model.page
  const valid = model.link === 'valid'
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.sender.companyName } : null,
        title: page ? t('title', { company: page.sender.companyName }) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'SUPPLIER_ONBOARD', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid && (page ? model.done ? <Done page={page} done={model.done} model={model} /> : <Wizard page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading />)}
    </LinkFrameView>
  )
}

/** The page is read: skeleton cards in the shape of the form; after about a second, "Still loading…". */
function Loading() {
  const t = useT('link-onboard')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-ob-stack" aria-busy="true">
      <Card padded className="fw-ob-card">
        <Skeleton width="40%" height={22} />
        <Skeleton width="100%" height={56} />
      </Card>
      <Skeleton width="100%" height={36} />
      <Card padded className="fw-ob-card">
        <Skeleton width="35%" height={24} />
        <Skeleton width="100%" height={44} />
        <Skeleton width="100%" height={44} />
        <Skeleton width="70%" height={44} />
      </Card>
      <p className="fw-ob-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

/** A failed read is never drawn as an empty form: the problem in our words and Try again. */
function ReadProblem({ model, actions }: { model: OnboardViewModel; actions?: OnboardActions }) {
  const t = useT('link-onboard')
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

function Wizard({ page, model, actions }: { page: OnboardPage; model: OnboardViewModel; actions?: OnboardActions }) {
  const t = useT('link-onboard')
  const locale = useLocale()
  const ds = useDsWords()
  const step = model.step
  const busy = model.send === 'busy'
  const here = useRef(actions)
  here.current = actions

  // ← → between steps (design kb), never while a field, a choice or a dialog takes the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, button[aria-haspopup], [contenteditable="true"], [role="dialog"], [role="radiogroup"], [role="listbox"]')) return
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
    <div className="fw-ob-stack">
      {model.draft.restoredAt && (
        <Banner
          tone="info"
          title={t('draft.restored', { day: formatDate(model.draft.restoredAt, { locale, timeZone: model.timeZone }), time: formatTime(model.draft.restoredAt, { locale, timeZone: model.timeZone }) })}
          action={
            <span className="fw-ob-actions">
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
      {step === 'company' && <Intro page={page} />}
      <div className="fw-ob-band">
        <Stepper steps={steps} current={stepIndex(step)} onSelect={(index) => actions?.onStep?.(STEPS[index]!)} canSelect={(index) => index !== stepIndex(step)} className="fw-ob-stepper" />
        <div className="fw-ob-save">
          <SaveStatus state={model.draft.status} onRetry={() => actions?.onSaveRetry?.()} formatTime={(iso) => formatTime(iso, { locale, timeZone: model.timeZone })} locale={locale} size="sm" labels={ds.saveStatus} />
          <Button size="sm" variant="quiet" heldReason={worthKeeping(model.form, page) ? null : t('later.held')} onClick={() => actions?.onFinishLater?.()}>
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
        <Banner tone="danger" title={t(model.problem)}>
          {t(`${model.problem}Body`)}
        </Banner>
      )}
      <Card padded className="fw-ob-card">
        <div className="fw-ob-head">
          <p className="fw-ob-count">{t('step.count', { at: stepIndex(step) + 1, of: STEPS.length })}</p>
          <h2 id="fw-ob-step-heading" className="fw-ob-h2" tabIndex={-1}>
            {t(`step.${step}.title`)}
          </h2>
          <p className="fw-ob-hint">{t(`step.${step}.lead`, { company: page.sender.companyName })}</p>
        </div>
        <StepBody step={step} page={page} model={model} actions={actions} />
        <div className="fw-ob-nav">
          {previous ? (
            <Button onClick={() => actions?.onBack?.()} heldReason={busy ? t('send.busy') : null}>
              {t('nav.back')}
            </Button>
          ) : (
            <span />
          )}
          {next && (
            <Button variant="primary" onClick={() => actions?.onNext?.()}>
              {t('nav.next', { step: t(`step.${next}.short`) })}
            </Button>
          )}
        </div>
        <p className="fw-ob-keys">{t('nav.keys')}</p>
      </Card>
    </div>
  )
}

function StepBody({ step, page, model, actions }: { step: Step; page: OnboardPage; model: OnboardViewModel; actions?: OnboardActions }) {
  switch (step) {
    case 'company':
      return <CompanyStep page={page} model={model} actions={actions} />
    case 'contacts':
      return <ContactsStep page={page} model={model} actions={actions} />
    case 'sites':
      return <SitesStep page={page} model={model} actions={actions} />
    case 'certifications':
      return <CertificationsStep page={page} model={model} actions={actions} />
    case 'labour':
      return <LabourStep page={page} model={model} actions={actions} />
    case 'sign':
      return <SignStep page={page} model={model} actions={actions} />
  }
}

/** Design sec:done — "Sent — Paolo reviews it. We write if anything is missing." with the receipt. */
function Done({ page, done, model }: { page: OnboardPage; done: OnboardSent; model: OnboardViewModel }) {
  const t = useT('link-onboard')
  const locale = useLocale()
  const ds = useDsWords()
  const reviewer = done.reviewer?.name ?? null
  return (
    <div className="fw-ob-stack">
      <EndState
        tone="success"
        title={reviewer ? t('done.titleBy', { name: reviewer }) : t('done.title', { company: done.sender.companyName })}
        body={t('done.body')}
        next={[t('done.next.review', { company: done.sender.companyName }), t('done.next.questions'), ...(done.sent.documents > 0 ? [t('done.next.documents', { count: done.sent.documents })] : [])]}
        facts={[
          { label: t('done.fact.questionnaire'), value: t('done.fact.version', { title: page.questionnaire.title, revision: done.sent.revision }) },
          { label: t('done.fact.sent'), value: formatDateTime(done.sent.submittedAt, { locale, timeZone: model.timeZone }) },
          { label: t('done.fact.by'), value: [model.form.signedName.trim(), model.form.signedRole.trim()].filter(Boolean).join(', ') },
          { label: t('done.fact.documents'), value: String(done.sent.documents) },
        ]}
        contact={{ name: done.sender.companyName, detail: t('done.contact') }}
        labels={ds.endState}
      />
    </div>
  )
}
