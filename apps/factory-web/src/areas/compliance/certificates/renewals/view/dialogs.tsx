'use client'

import { ArrowRight } from 'lucide-react'
import { renewalTask } from '@nexus/factory-domain/compliance/renewals/rules'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { CertCan } from '../../model'
import { dateLocale, PdfChooser, useDay } from '../../view/parts'
import type { Renewals, Review } from '../api'
import { appliedHeld, candidateLabel, inWindow, linkHeld, reviewHeld, startHeld, type RenewalsModel } from '../model'
import type { RenewalsActions } from '../use-renewals'

function Problem({ problem, lines }: { problem: string | null; lines: readonly string[] }) {
  const t = useT('certificates')
  if (!problem) return null
  return (
    <Banner tone="danger" title={t(problem)}>
      {lines.length > 0 && (
        <ul className="fw-q-lines fw-ce-data">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

function Footer({ held, busy, label, onConfirm, onClose, tone = 'primary' }: { held: string | null; busy: boolean; label: string; onConfirm?: () => void; onClose?: () => void; tone?: 'primary' | 'danger' }) {
  const t = useT('certificates')
  return (
    <>
      <Button onClick={() => onClose?.()}>{t('common.back')}</Button>
      <Button variant={tone} heldReason={held} onClick={() => onConfirm?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

/** The dialogs of the Renewals tab (one at a time; Esc closes and the focus goes back to the opener: the DS Modal). */
export function RenewalDialogs({ renewals, model, can, actions }: { renewals: Renewals; model: RenewalsModel; can: CertCan; actions?: RenewalsActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const review = 'reviewId' in dialog ? (model.reviews.value?.find((entry) => entry.id === dialog.reviewId) ?? null) : null
  switch (dialog.kind) {
    case 'start':
      return <StartDialog renewals={renewals} model={model} can={can} actions={actions} />
    case 'applied':
      return <AppliedDialog renewals={renewals} model={model} can={can} actions={actions} />
    case 'link':
      return <LinkDialog renewals={renewals} model={model} can={can} actions={actions} />
    case 'notify':
    case 'notNeeded':
    case 'answer':
      return review ? <ReviewDialog verb={dialog.kind} review={review} renewals={renewals} model={model} can={can} actions={actions} /> : null
  }
}

/** Start renewal: ONE task on the certificate with the usual steps (the notified body's own list wins), due the window's last day. */
function StartDialog({ renewals, model, can, actions }: { renewals: Renewals; model: RenewalsModel; can: CertCan; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const day = useDay()
  const draft = model.draft
  const why = startHeld(renewals, can, model.busy)
  const task = renewalTask({ number: renewals.certificate.number, notifiedBodyName: renewals.certificate.notifiedBodyName, notifiedBodyNumber: renewals.certificate.notifiedBodyNumber, validTo: renewals.certificate.validTo }, draft.language)
  const people = model.people?.value ?? []
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('ren.start.title', { number: renewals.certificate.number })} size="md" footer={<Footer held={why ? t(why) : null} busy={model.busy} label={t('ren.start.confirm')} onConfirm={actions?.onStart} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-ce-dialog">
        <p>{t('ren.start.what', { opens: day(renewals.window.opens), closes: day(renewals.window.closes) })}</p>
        <div className="fw-q-two">
          <Field label={t('ren.start.assignee')} hint={model.people?.problem ? t('ren.start.peopleFailed') : undefined}>
            <Select value={draft.assignee} onChange={(event) => actions?.onDraft?.({ assignee: event.target.value })} disabled={!model.people?.value}>
              <option value="me">{t('ren.start.me')}</option>
              <option value="nobody">{t('ren.renewal.nobody')}</option>
              {people
                .filter((person) => !person.me)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('ren.start.language')}>
            <SegmentedControl
              ariaLabel={t('ren.start.language')}
              value={draft.language}
              onChange={(value) => actions?.onDraft?.({ language: value as 'it' | 'en' })}
              options={[
                { value: 'it', label: t('ren.start.it') },
                { value: 'en', label: t('ren.start.en') },
              ]}
            />
          </Field>
        </div>
        <div className="fw-ce-ren-preview" aria-label={t('ren.start.preview')}>
          <p>
            <strong>{task.title}</strong> · {t('ren.start.due', { date: day(task.dueDate) })}
          </p>
          <ol className="fw-q-lines">
            {task.checklist.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <p className="fw-q-hint">{t('ren.start.bodyList')}</p>
        </div>
        <p className="fw-q-hint">{t('ren.start.nothingSent')}</p>
        <Problem problem={model.problem} lines={model.lines} />
      </div>
    </Modal>
  )
}

/** The day the application for review went to the notified body (typed in: nothing is sent from here). */
function AppliedDialog({ renewals, model, can, actions }: { renewals: Renewals; model: RenewalsModel; can: CertCan; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const day = useDay()
  const locale = useLocale()
  const draft = model.draft
  const why = appliedHeld(renewals, can, draft, model.busy)
  const inside = inWindow(renewals, draft.appliedOn)
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('ren.applied.title', { number: renewals.certificate.number })} size="md" footer={<Footer held={why ? t(why) : null} busy={model.busy} label={t('ren.applied.confirm')} onConfirm={actions?.onApplied} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-ce-dialog">
        <p>{t('ren.applied.what', { body: `${renewals.certificate.notifiedBodyName} (${renewals.certificate.notifiedBodyNumber})` })}</p>
        <div className="fw-q-two">
          <Field label={t('ren.applied.day')} required>
            <DateField value={draft.appliedOn} onChange={(value) => actions?.onDraft?.({ appliedOn: value ?? '' })} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} clearable={false} />
          </Field>
          <Field label={t('ren.applied.reference')} hint={t('ren.applied.referenceHint')}>
            <Input value={draft.reference} maxLength={100} onChange={(event) => actions?.onDraft?.({ reference: event.target.value })} />
          </Field>
        </div>
        {inside === false && <Banner tone="warning" title={t('ren.applied.late', { opens: day(renewals.window.opens), closes: day(renewals.window.closes) })} />}
        <Field label={t('ren.applied.note')}>
          <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        <Problem problem={model.problem} lines={model.lines} />
      </div>
    </Modal>
  )
}

/** Link the new certificate: registered, the same holder, valid from a later day (set once, never changed). */
function LinkDialog({ renewals, model, can, actions }: { renewals: Renewals; model: RenewalsModel; can: CertCan; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const day = useDay()
  const draft = model.draft
  const why = linkHeld(renewals, can, draft, model.busy)
  const chosen = renewals.candidates.find((candidate) => candidate.id === draft.successorId) ?? null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('ren.link.title', { number: renewals.certificate.number })} size="md" footer={<Footer held={why ? t(why) : null} busy={model.busy} label={t('ren.link.confirm')} onConfirm={actions?.onLink} onClose={() => actions?.onDialog?.(null)} />}>
      <div className="fw-ce-dialog">
        <p>{t('ren.link.what')}</p>
        {renewals.candidates.length === 0 ? (
          <Banner tone="info" title={t('ren.link.none')}>
            <p className="fw-q-hint">{t('ren.link.noneFix')}</p>
          </Banner>
        ) : (
          <Field label={t('ren.link.pick')} required>
            <Select value={draft.successorId} onChange={(event) => actions?.onDraft?.({ successorId: event.target.value })}>
              <option value="">{t('ren.link.choose')}</option>
              {renewals.candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidateLabel(candidate)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {chosen && (
          <p className="fw-ce-change">
            <span className="fw-ce-data">{renewals.certificate.number}</span> {t('ren.link.until', { date: day(renewals.certificate.validTo) })} <ArrowRight size={12} aria-label={t('ren.changes.to')} /> <span className="fw-ce-data">{chosen.number}</span> {t('ren.link.from', { from: day(chosen.validFrom), to: day(chosen.validTo) })}
          </p>
        )}
        <p className="fw-q-hint">{t('ren.link.after')}</p>
        <Problem problem={model.problem} lines={model.lines} />
      </div>
    </Modal>
  )
}

/** A review's decision: told the notified body, not needed (with the reason), or the notified body's answer with its file. */
function ReviewDialog({ verb, review, renewals, model, can, actions }: { verb: 'notify' | 'notNeeded' | 'answer'; review: Review; renewals: Renewals; model: RenewalsModel; can: CertCan; actions?: RenewalsActions }) {
  const t = useT('certificates')
  const locale = useLocale()
  const draft = model.draft
  const why = reviewHeld(can, verb, draft, review, renewals.today, model.busy)
  const confirm = verb === 'notify' ? actions?.onNotify : verb === 'notNeeded' ? actions?.onNotNeeded : actions?.onAnswer
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`ren.${verb}.title`, { code: review.style.code, revision: review.revision.revision })}
      size="md"
      footer={<Footer held={why ? t(why) : null} busy={model.busy} label={t(`ren.${verb}.confirm`)} onConfirm={confirm} onClose={() => actions?.onDialog?.(null)} tone={verb === 'answer' && draft.decision === 'REFUSED' ? 'danger' : 'primary'} />}
    >
      <div className="fw-ce-dialog">
        <ul className="fw-q-lines" aria-label={t('ren.changes.col.change')}>
          {review.changes.map((change, index) => (
            <li key={index} className="fw-ce-change">
              <strong>{t(`ren.kind.${change.kind}`)}</strong> <span className="fw-ce-data">{change.before}</span> <ArrowRight size={12} aria-label={t('ren.changes.to')} /> <span className="fw-ce-data">{change.after}</span>
            </li>
          ))}
        </ul>
        <p>{t(`ren.${verb}.what`, { number: review.certificate.number, body: review.certificate.notifiedBodyNumber })}</p>
        {verb === 'notify' && (
          <Field label={t('ren.notify.note')}>
            <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
          </Field>
        )}
        {verb === 'notNeeded' && (
          <Field label={t('ren.notNeeded.reason')} required hint={t('ren.notNeeded.reasonHint')}>
            <Textarea value={draft.reason} rows={3} maxLength={1000} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
          </Field>
        )}
        {verb === 'answer' && (
          <>
            <Field label={t('ren.answer.decision')}>
              <SegmentedControl
                ariaLabel={t('ren.answer.decision')}
                value={draft.decision}
                onChange={(value) => actions?.onDraft?.({ decision: value as 'APPROVED' | 'REFUSED' })}
                options={[
                  { value: 'APPROVED', label: t('ren.answer.APPROVED') },
                  { value: 'REFUSED', label: t('ren.answer.REFUSED') },
                ]}
              />
            </Field>
            <p className="fw-q-hint">{t(`ren.answerMeans.${draft.decision}`)}</p>
            <div className="fw-q-two">
              <Field label={t('ren.answer.day')} required>
                <DateField value={draft.answeredOn} onChange={(value) => actions?.onDraft?.({ answeredOn: value ?? '' })} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} clearable={false} />
              </Field>
              <Field label={t('ren.answer.reference')}>
                <Input value={draft.reference} maxLength={100} onChange={(event) => actions?.onDraft?.({ reference: event.target.value })} />
              </Field>
            </div>
            {review.files.length > 0 ? (
              <p className="fw-q-hint">{t('ren.answer.filed', { name: review.files[0]!.originalName })}</p>
            ) : (
              <PdfChooser name={draft.fileName} onFile={actions?.onFile} label={t('ren.answer.file')} hint={t('ren.answer.fileHint')} held={can.upload ? null : t('ren.held.upload')} />
            )}
            <Field label={t('ren.answer.note')}>
              <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
            </Field>
          </>
        )}
        <p className="fw-q-hint">{t(verb === 'notify' ? 'ren.notify.nothingSent' : 'ren.decision.kept')}</p>
        <Problem problem={model.problem} lines={model.lines} />
      </div>
    </Modal>
  )
}
