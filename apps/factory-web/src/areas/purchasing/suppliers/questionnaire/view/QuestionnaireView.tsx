'use client'

import { useEffect, useState } from 'react'
import { Copy, ExternalLink, FileText, Send } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { AnswerView, SupplierQuestionnaire } from '../api'
import {
  answerTone,
  answerWords,
  linkTone,
  MAX_DAYS,
  OTHER,
  reviewHeld,
  sectionsOf,
  sendHeld,
  versionOf,
  type QuestionnaireActions,
  type QuestionnaireViewModel,
} from '../model'
import '../questionnaire.css'

export type { QuestionnaireViewModel, QuestionnaireActions } from '../model'

type T = (key: string, params?: Record<string, string | number>) => string

/**
 * The supplier record's Questionnaire tab (B-W2b-172; design purchasing.suppliers "Links › Supplier questionnaire (W2b) —
 * Onboarding", "Office: purchasing.suppliers › … (answers reviewed, versioned)"): the company's questionnaire (the version
 * a link asks; none published: publish the starter set), Send the questionnaire (by e-mail to a contact, or a link to pass
 * on, given once), the links sent and where each stands, and the answers newest first — the version answered, who signed
 * it and when, the documents with their dates, the PDF kept on the supplier's files, the review (accepted, or questions
 * back on the supplier's thread) and its task. Fills the tab; no money anywhere. Fetches nothing (Questionnaire.tsx does).
 */
export function QuestionnaireView({ model, actions }: { model: QuestionnaireViewModel; actions?: QuestionnaireActions }) {
  return (
    <WithMessages namespaces={['purchasing-questionnaire']}>
      <Questionnaire model={model} actions={actions} />
    </WithMessages>
  )
}

function Questionnaire({ model, actions }: { model: QuestionnaireViewModel; actions?: QuestionnaireActions }) {
  const t = useT('purchasing-questionnaire')
  const data = model.data
  if (!data) {
    if (model.problem)
      return (
        <EmptyState
          title={t('problem.read')}
          description={t('problem.readBody')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        />
      )
    return <Loading />
  }
  const answer = model.dialog && model.dialog.kind !== 'send' ? (data.answers.find((entry) => entry.id === (model.dialog as { id: string }).id) ?? null) : null
  return (
    <div className="fw-qn-stack">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.close')}
            </Button>
          }
        />
      )}
      <Head data={data} model={model} actions={actions} t={t} />
      <div className="fw-qn-columns">
        <Answers data={data} model={model} actions={actions} t={t} />
        <Links data={data} model={model} t={t} />
      </div>
      {model.dialog?.kind === 'send' && <SendDialog data={data} model={model} actions={actions} t={t} />}
      {model.dialog?.kind === 'answer' && answer && <AnswerDialog data={data} answer={answer} model={model} actions={actions} t={t} />}
      {model.dialog?.kind === 'review' && answer && <ReviewDialog data={data} answer={answer} model={model} actions={actions} t={t} />}
    </div>
  )
}

function Loading() {
  const t = useT('purchasing-questionnaire')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-qn-stack" aria-busy="true">
      <Card padded className="fw-qn-card">
        <Skeleton width="30%" height={22} />
        <Skeleton width="60%" height={16} />
      </Card>
      <div className="fw-qn-columns">
        <Card padded className="fw-qn-card">
          <Skeleton width="100%" height={88} />
          <Skeleton width="100%" height={88} />
        </Card>
        <Card padded className="fw-qn-card">
          <Skeleton width="100%" height={44} />
        </Card>
      </div>
      <p className="fw-qn-hint" role="status">
        {slow ? t('loading.slow') : t('loading.now')}
      </p>
    </div>
  )
}

interface Part {
  data: SupplierQuestionnaire
  model: QuestionnaireViewModel
  actions?: QuestionnaireActions
  t: T
}

function Head({ data, model, actions, t }: Part) {
  const locale = useLocale()
  const held = sendHeld(data)
  const current = data.current
  return (
    <Card padded className="fw-qn-card">
      <div className="fw-qn-row">
        <div className="fw-qn-head">
          <h2 className="fw-qn-h2">{t('title')}</h2>
          {current ? (
            <p className="fw-qn-hint">{t('current', { title: current.title, revision: current.revision, day: formatDate(current.publishedAt ?? current.updatedAt, { locale, timeZone: model.timeZone }), count: current.questions.length })}</p>
          ) : (
            <p className="fw-qn-hint">{t('noVersion')}</p>
          )}
          {data.draft && <p className="fw-qn-hint">{t('draftVersion', { revision: data.draft.revision })}</p>}
        </div>
        <div className="fw-qn-actions">
          {!current && (
            <Button onClick={() => actions?.onPublishStarter?.()} heldReason={!data.may.manage ? t('held.manage') : data.draft ? t('held.draft', { revision: data.draft.revision }) : model.publishing ? t('publishing') : null}>
              {model.publishing ? <Spinner size={14} /> : null} {t('publishStarter')}
            </Button>
          )}
          <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={held ? t(held) : null}>
            <Send size={14} aria-hidden /> {t('send.button')}
          </Button>
        </div>
      </div>
      <p className="fw-qn-hint">{t('why')}</p>
    </Card>
  )
}

function Answers({ data, model, actions, t }: Part) {
  const locale = useLocale()
  return (
    <section className="fw-qn-stack" aria-labelledby="fw-qn-answers">
      <h3 id="fw-qn-answers" className="fw-qn-h3">
        {t('answers.title')}
      </h3>
      {data.answers.length === 0 ? (
        <Card padded className="fw-qn-card">
          <p className="fw-qn-hint">{data.links.some((link) => link.state === 'OPEN') ? t('answers.waiting') : t('answers.none')}</p>
        </Card>
      ) : (
        data.answers.map((answer) => {
          const held = reviewHeld(data, answer)
          return (
            <Card key={answer.id} padded className="fw-qn-card">
              <div className="fw-qn-row">
                <div className="fw-qn-head">
                  <span className="fw-qn-h3">
                    {t('answer.title', { revision: answer.revision, day: formatDateTime(answer.submittedAt, { locale, timeZone: model.timeZone }) })} <Pill tone={answerTone(answer.state)}>{t(`state.${answer.state}`)}</Pill>
                  </span>
                  <span className="fw-qn-hint">{t(answer.via === 'LINK' ? 'answer.byLink' : 'answer.byPortal', { name: answer.signedName, role: answer.signedRole ?? '—' })}</span>
                </div>
                <div className="fw-qn-actions">
                  <Button size="sm" onClick={() => actions?.onAnswer?.(answer.id)}>
                    {t('answer.open')}
                  </Button>
                  {answer.pdf && (
                    <Button size="sm" onClick={() => actions?.onOpenFile?.(answer.pdf!.fileId, answer.pdf!.name, 'application/pdf')} heldReason={model.opening?.fileId === answer.pdf.fileId && !model.opening.failed ? t('file.opening') : null}>
                      <ExternalLink size={14} aria-hidden /> {t('answer.pdf')}
                    </Button>
                  )}
                  <Button size="sm" variant={answer.state === 'WAITING' ? 'primary' : 'secondary'} onClick={() => actions?.onReview?.(answer.id)} heldReason={held ? t(held) : null}>
                    {t('answer.review')}
                  </Button>
                </div>
              </div>
              <KeyValue
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('answer.sites'), value: t('answer.siteCount', { own: answer.sites.length, sub: answer.subTierSites.length }) },
                  { label: t('answer.documents'), value: answer.documents.length === 0 ? t('answer.none') : answer.documents.map((document) => document.name).join(', ') },
                  ...(answer.review ? [{ label: t('answer.reviewed'), value: t('answer.reviewedBy', { name: answer.review.byName ?? '—', day: formatDateTime(answer.review.at, { locale, timeZone: model.timeZone }) }) }] : []),
                  ...(answer.review?.note ? [{ label: t('answer.note'), value: answer.review.note }] : []),
                  ...(answer.task?.open ? [{ label: t('answer.task'), value: t('answer.taskOpen', { name: answer.task.assigneeName ?? t('answer.nobody'), day: answer.task.dueDate ? formatDate(answer.task.dueDate, { locale }) : '—' }) }] : []),
                ]}
              />
              {model.opening?.failed && answer.pdf && model.opening.fileId === answer.pdf.fileId && (
                <p className="fw-qn-error" role="alert">
                  {t('file.failed')}
                </p>
              )}
            </Card>
          )
        })
      )}
    </section>
  )
}

function Links({ data, model, t }: Omit<Part, 'actions'>) {
  const locale = useLocale()
  return (
    <section className="fw-qn-stack" aria-labelledby="fw-qn-links">
      <h3 id="fw-qn-links" className="fw-qn-h3">
        {t('links.title')}
      </h3>
      <Card padded className="fw-qn-card">
        {data.links.length === 0 ? (
          <p className="fw-qn-hint">{t('links.none')}</p>
        ) : (
          <ul className="fw-qn-links">
            {data.links.map((link) => (
              <li key={link.id} className="fw-qn-link">
                <span className="fw-qn-row">
                  <span className="fw-qn-strong">{link.email ?? t('links.handed')}</span>
                  <Pill tone={linkTone(link.state)}>{t(`linkState.${link.state}`)}</Pill>
                </span>
                <span className="fw-qn-hint">
                  {t('links.sent', { day: formatDateTime(link.sentAt, { locale, timeZone: model.timeZone }), name: link.sentByName ?? '—' })}
                  {link.state === 'OPEN' ? ` · ${t('links.until', { day: formatDate(link.expiresAt, { locale, timeZone: model.timeZone }) })}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}

function SendDialog({ data, model, actions, t }: Part) {
  const form = model.send.form
  const result = model.send.result
  const fieldError = (field: string) => (model.send.field === field && model.send.problem ? t(model.send.problem) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('send.title', { name: data.party.name })}
      size="md"
      busy={model.send.busy}
      footer={
        result ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('send.done')}
          </Button>
        ) : (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('send.cancel')}</Button>
            <Button variant="primary" onClick={() => actions?.onSendConfirm?.()} heldReason={model.send.busy ? t('send.busy') : null}>
              {form.mode === 'mail' ? t('send.confirmMail') : t('send.confirmLink')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="fw-qn-stack">
          {result.url ? (
            <>
              <Banner tone="success" title={t('send.linkReady')}>
                {t('send.linkOnce')}
              </Banner>
              <div className="fw-qn-copy">
                <Input value={result.url} readOnly aria-label={t('send.linkLabel')} onFocus={(event) => event.currentTarget.select()} />
                <Button size="sm" onClick={() => actions?.onCopy?.(result.url!)}>
                  <Copy size={14} aria-hidden /> {t('send.copy')}
                </Button>
              </div>
            </>
          ) : (
            <Banner tone={result.delivery === 'FAILED' ? 'warning' : 'success'} title={result.delivery === 'FAILED' ? t('send.mailFailed') : t('send.mailed', { email: result.link.email ?? '' })}>
              {result.delivery === 'FAILED' ? t('send.mailFailedBody') : t('send.mailedBody', { day: result.link.expiresAt.slice(0, 10) })}
            </Banner>
          )}
          {result.link.withdrawn > 0 && <p className="fw-qn-hint">{t('send.withdrawn', { count: result.link.withdrawn })}</p>}
        </div>
      ) : (
        <div className="fw-qn-stack">
          {model.send.problem && !model.send.field && <Banner tone="danger" title={t(model.send.problem)} />}
          <fieldset className="fw-qn-group">
            <legend className="fw-qn-legend">{t('send.how')}</legend>
            <div className="fw-qn-choices">
              <RadioCard name="fw-qn-mode" value="mail" checked={form.mode === 'mail'} selected={form.mode === 'mail'} onChange={() => actions?.onSendForm?.({ mode: 'mail' })} title={t('send.byMail')} description={t('send.byMailBody')} />
              <RadioCard name="fw-qn-mode" value="link" checked={form.mode === 'link'} selected={form.mode === 'link'} onChange={() => actions?.onSendForm?.({ mode: 'link' })} title={t('send.byLink')} description={t('send.byLinkBody')} />
            </div>
          </fieldset>
          {form.mode === 'mail' && (
            <Field label={t('send.to')} required error={fieldError('to')} htmlFor="fw-qn-to">
              <Select id="fw-qn-to" value={form.to} onChange={(event) => actions?.onSendForm?.({ to: event.target.value })}>
                {data.contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name} · {contact.email}
                  </option>
                ))}
                <option value={OTHER}>{t('send.other')}</option>
              </Select>
            </Field>
          )}
          {(form.mode === 'link' || form.to === OTHER) && (
            <Field label={form.mode === 'mail' ? t('send.email') : t('send.emailOptional')} required={form.mode === 'mail'} hint={form.mode === 'link' ? t('send.emailHint') : undefined} error={fieldError('email')} htmlFor="fw-qn-email">
              <Input id="fw-qn-email" type="email" inputMode="email" value={form.email} onChange={(event) => actions?.onSendForm?.({ email: event.target.value })} />
            </Field>
          )}
          <div className="fw-qn-grid">
            <Field label={t('send.language')} htmlFor="fw-qn-language">
              <Select id="fw-qn-language" value={form.language} onChange={(event) => actions?.onSendForm?.({ language: event.target.value === 'en' ? 'en' : 'it' })}>
                <option value="it">{t('language.it')}</option>
                <option value="en">{t('language.en')}</option>
              </Select>
            </Field>
            <Field label={t('send.days')} hint={t('send.daysHint', { max: MAX_DAYS })} error={fieldError('days')} htmlFor="fw-qn-days">
              <Input id="fw-qn-days" type="number" inputMode="numeric" min={1} max={MAX_DAYS} value={String(form.days)} onChange={(event) => actions?.onSendForm?.({ days: Number(event.target.value) })} />
            </Field>
          </div>
          <Field label={t('send.note')} hint={t('send.noteHint')} error={fieldError('note')} htmlFor="fw-qn-note">
            <Textarea id="fw-qn-note" rows={3} value={form.note} onChange={(event) => actions?.onSendForm?.({ note: event.target.value })} />
          </Field>
          {data.links.some((link) => link.state === 'OPEN') && <p className="fw-qn-hint">{t('send.replaces')}</p>}
        </div>
      )}
    </Modal>
  )
}

function AnswerDialog({ data, answer, model, actions, t }: Part & { answer: AnswerView }) {
  const locale = useLocale()
  const version = versionOf(data, answer)
  const questions = version?.questions ?? []
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('answer.dialogTitle', { name: data.party.name, revision: answer.revision })}
      subtitle={t('answer.dialogSub', { name: answer.signedName, role: answer.signedRole ?? '—', day: formatDateTime(answer.submittedAt, { locale, timeZone: model.timeZone }) })}
      size="xl"
      readable
      footer={<Button onClick={() => actions?.onClose?.()}>{t('answer.close')}</Button>}
    >
      <div className="fw-qn-stack">
        {sectionsOf(questions).map((group) => (
          <section key={group.section} className="fw-qn-section" aria-labelledby={`fw-qn-s-${group.section}`}>
            <h3 id={`fw-qn-s-${group.section}`} className="fw-qn-h3">
              {t(`section.${group.section}`)}
            </h3>
            <KeyValue
              labelCase="sentence"
              items={group.questions.flatMap((question) => {
                if (question.kind === 'SITES' || question.kind === 'SUB_TIER_SITES') {
                  const rows = question.kind === 'SITES' ? answer.sites : answer.subTierSites
                  return [{ label: question.text[locale], value: rows.length === 0 ? t('answer.none') : rows.map((row) => [row.name, row.country, row.town, row.steps.map((step) => t(`siteStep.${step}`)).join(', ')].filter(Boolean).join(' · ')).join(' | ') }]
                }
                const entry = answer.answers[question.key]
                const words = entry?.explain?.trim()
                return [{ label: question.text[locale], value: answerWords(question, entry, answer.documents, locale, t), ...(words ? { hint: words } : {}) }]
              })}
            />
          </section>
        ))}
        {answer.documents.length > 0 && (
          <section className="fw-qn-section" aria-labelledby="fw-qn-docs">
            <h3 id="fw-qn-docs" className="fw-qn-h3">
              {t('documents.title')}
            </h3>
            <ul className="fw-qn-links">
              {answer.documents.map((document) => (
                <li key={document.fileId} className="fw-qn-link">
                  <span className="fw-qn-row">
                    <span className="fw-qn-strong">
                      <FileText size={14} aria-hidden /> {document.name || t('answer.document')}
                    </span>
                    <Pill tone={document.inForce ? 'success' : document.status === 'AVAILABLE' ? 'info' : 'warning'}>{document.inForce ? t('documents.inForce') : document.status === 'AVAILABLE' ? t('documents.waiting') : t('documents.held')}</Pill>
                  </span>
                  <span className="fw-qn-hint">
                    {[t(`category.${document.category}`), document.issuer, document.number, document.issuedOn ? t('documents.issued', { day: formatDate(document.issuedOn, { locale }) }) : null, document.expiresOn ? t('documents.expires', { day: formatDate(document.expiresOn, { locale }) }) : t('documents.noExpiry')].filter(Boolean).join(' · ')}
                  </span>
                  <span>
                    <Button size="sm" variant="link" onClick={() => actions?.onOpenFile?.(document.fileId, document.name, document.contentType)} heldReason={document.status !== 'AVAILABLE' ? t('documents.notReady') : null}>
                      {t('documents.open')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  )
}

function ReviewDialog({ data, answer, model, actions, t }: Part & { answer: AnswerView }) {
  const form = model.review.form
  const fieldError = (field: string) => (model.review.field === field && model.review.problem ? t(model.review.problem) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('review.title', { name: data.party.name, revision: answer.revision })}
      size="md"
      busy={model.review.busy}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('review.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onReviewConfirm?.()} heldReason={model.review.busy ? t('review.busy') : null}>
            {form.decision === 'QUESTIONS' ? t('review.confirmQuestions') : t('review.confirmAccept')}
          </Button>
        </>
      }
    >
      <div className="fw-qn-stack">
        {model.review.problem && !model.review.field && <Banner tone="danger" title={t(model.review.problem)} />}
        <fieldset className="fw-qn-group" id="fw-qn-decision" aria-describedby={fieldError('decision') ? 'fw-qn-decision-error' : undefined}>
          <legend className="fw-qn-legend">{t('review.what')}</legend>
          <div className="fw-qn-choices">
            <RadioCard name="fw-qn-decision" value="ACCEPTED" checked={form.decision === 'ACCEPTED'} selected={form.decision === 'ACCEPTED'} onChange={() => actions?.onReviewForm?.({ decision: 'ACCEPTED' })} title={t('review.accept')} description={answer.documents.length > 0 ? t('review.acceptBody', { count: answer.documents.length }) : t('review.acceptBodyNone')} />
            <RadioCard name="fw-qn-decision" value="QUESTIONS" checked={form.decision === 'QUESTIONS'} selected={form.decision === 'QUESTIONS'} onChange={() => actions?.onReviewForm?.({ decision: 'QUESTIONS' })} title={t('review.questions')} description={t('review.questionsBody')} />
          </div>
          {fieldError('decision') && (
            <p id="fw-qn-decision-error" className="fw-qn-error" role="alert">
              {fieldError('decision')}
            </p>
          )}
        </fieldset>
        {form.decision === 'QUESTIONS' && (
          <Field label={t('review.questionsLabel')} required hint={t('review.questionsHint')} error={fieldError('questions')} htmlFor="fw-qn-questions">
            <Textarea id="fw-qn-questions" rows={5} value={form.questions} onChange={(event) => actions?.onReviewForm?.({ questions: event.target.value })} />
          </Field>
        )}
        <Field label={t('review.note')} hint={t('review.noteHint')} error={fieldError('note')} htmlFor="fw-qn-review-note">
          <Textarea id="fw-qn-review-note" rows={3} value={form.note} onChange={(event) => actions?.onReviewForm?.({ note: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
