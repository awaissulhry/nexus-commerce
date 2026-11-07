'use client'

import Link from 'next/link'
import { Ban, FileText, Upload } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { VOID_REASONS, type VoidReason } from '@nexus/factory-domain/safety/health/rules'
import { FileDropzone, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { addressTerms, COPY_ACCEPT, COPY_MOST_BYTES, EMPTY_ADDRESS, HEALTH_PATH, voidHeld } from '../model'
import type { HealthPageActions, HealthPageModel, JudgementWindowState } from '../view-model'
import { JudgementStateTag, OutcomeTag, personText, ProtectedLaw, say, SectionFailed, SectionLoading, useWhen, useWords, WhoLooked } from './parts'

/**
 * A judgement (a row of the judgements, `?judgement=<id>`): its own RECORDED read (one OPEN view, said in the window) — the
 * person, the outcome, the task limits (never a reason), until when unfit, the day and the expiry, the visit it came from, the
 * doctor, when it was recorded, a void with its reason, the doctor's copies (each opens in its own tab: design tab:copy, a COPY
 * view of its own). HR and the doctor void it (a reason from the list: kept, never changed) or add the copy; Who looked for HR
 * and the DPO. The appeal deadline is Later.
 */
export function JudgementWindow({ model, state, actions }: { model: HealthPageModel; state: JudgementWindowState; actions?: HealthPageActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const judgement = state.read.status === 'ready' ? state.read.value.judgement : null
  const frame = model.frame.status === 'ready' ? model.frame.value : null
  const manage = frame?.can.manage ?? model.can.manage
  const views = frame?.can.views ?? model.can.views
  const voided = Boolean(judgement?.voided)
  const copyHref = (fileId: string) => `${model.prefix}${HEALTH_PATH}/copy?judgement=${encodeURIComponent(state.id)}&file=${encodeURIComponent(fileId)}`
  const visitHref = judgement?.visit ? `${model.prefix}${HEALTH_PATH}${addressTerms({ ...EMPTY_ADDRESS, visit: judgement.visit.id })}` : null

  const footer = !judgement ? (
    <Button onClick={() => actions?.onJudgementClose?.()}>{t('common.close')}</Button>
  ) : state.mode === 'void' ? (
    <>
      <Button onClick={() => actions?.onJudgementMode?.('view')}>{t('common.back')}</Button>
      <span className="grow" />
      <Button variant="primary" heldReason={state.busy ? t('held.saving') : say(t, voidHeld(state.reason, voided))} onClick={() => actions?.onJudgementSave?.()}>
        {state.busy ? <Spinner size={12} /> : <Ban size={14} aria-hidden />} {t('void.do')}
      </Button>
    </>
  ) : state.mode === 'copy' ? (
    <>
      <Button onClick={() => actions?.onJudgementMode?.('view')}>{t('common.back')}</Button>
      <span className="grow" />
      <Button variant="primary" heldReason={state.busy ? t('held.saving') : state.copy ? null : t('held.copy.file')} onClick={() => actions?.onJudgementSave?.()}>
        {state.busy ? <Spinner size={12} /> : <Upload size={14} aria-hidden />} {t('copy.do')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => actions?.onJudgementClose?.()}>{t('common.close')}</Button>
      <span className="grow" />
      <Button heldReason={!manage ? t('held.manage') : voided ? t('refusal.JUDGEMENT_VOIDED') : null} onClick={() => actions?.onJudgementMode?.('copy')}>
        <Upload size={14} aria-hidden /> {t('copy.title')}
      </Button>
      <Button heldReason={!manage ? t('held.manage') : voided ? t('refusal.JUDGEMENT_VOIDED') : null} onClick={() => actions?.onJudgementMode?.('void')}>
        <Ban size={14} aria-hidden /> {t('void.title')}
      </Button>
    </>
  )

  return (
    <Modal open onClose={() => actions?.onJudgementClose?.()} title={judgement ? t('judgement.title', { day: when.day(judgement.judgedOn) }) : t('judgement.reading')} subtitle={judgement ? personText(judgement.employee) : undefined} size="lg" footer={footer}>
      <div className="fw-hv-form">
        {state.read.status === 'loading' ? (
          <SectionLoading rows={5} />
        ) : state.read.status === 'error' ? (
          <SectionFailed title={t('judgement.failed')} problem={state.read.problem} onRetry={actions?.onJudgementRetry} />
        ) : judgement ? (
          <>
            <PrivacyNote
              level="protected"
              variant="panel"
              recorded
              text={t('judgement.recorded', { time: when.at(state.read.value.at) })}
              law={<ProtectedLaw />}
              action={views ? <WhoLooked of={{ recordType: 'FITNESS_JUDGEMENT', recordId: judgement.id }} state={model.whoLooked} onOpen={actions?.onWhoLooked} label={t('who.judgement', { day: when.day(judgement.judgedOn) })} /> : undefined}
              labels={ds.privacyNote}
            />
            {state.problem && <Banner tone="danger" title={t('judgement.refused')}>{t(state.problem.key)}</Banner>}
            {judgement.voided && <Banner tone="warning" title={t('judgement.voided', { reason: t(`voidReason.${judgement.voided.reason}`), by: judgement.voided.by?.name ?? t('who.someone'), at: when.at(judgement.voided.at) })} />}
            {state.mode === 'void' ? (
              <div className="fw-hv-form">
                <p className="fw-hv-muted">{t('void.body')}</p>
                <Field label={t('void.reason')} required>
                  <Select value={state.reason ?? ''} onChange={(event) => actions?.onJudgementReason?.(event.target.value as VoidReason)}>
                    <option value="">{t('move.cancel.choose')}</option>
                    {VOID_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {t(`voidReason.${reason}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : state.mode === 'copy' ? (
              <div className="fw-hv-form">
                <p className="fw-hv-muted">{t('judge.copyHint')}</p>
                {state.copy ? (
                  <span className="fw-hv-row">
                    <span>{state.copy.name}</span>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onJudgementCopy?.(null)}>
                      {t('judge.removeCopy')}
                    </Button>
                  </span>
                ) : (
                  <FileDropzone accept={COPY_ACCEPT} maxBytes={COPY_MOST_BYTES} onFiles={(files) => actions?.onJudgementCopy?.(files[0] ?? null)} />
                )}
              </div>
            ) : (
              <KeyValue
                items={[
                  { label: t('judgement.person'), value: `${personText(judgement.employee)} · ${judgement.employee.site.name}` },
                  { label: t('judgement.outcome'), value: <OutcomeTag outcome={judgement.outcome} /> },
                  ...(judgement.taskLimits ? [{ label: t('judgement.limits'), value: <span className="fw-hv-text">{judgement.taskLimits}</span> }] : []),
                  ...(judgement.unfitUntil ? [{ label: t('judgement.unfitUntil'), value: when.day(judgement.unfitUntil) }] : []),
                  { label: t('judgement.day'), value: when.day(judgement.judgedOn) },
                  {
                    label: t('judgement.expires'),
                    value: judgement.expiresOn ? (
                      judgement.state === 'SUPERSEDED' || judgement.state === 'VOIDED' ? when.day(judgement.expiresOn) : <DueCell value={{ due: judgement.expiresOn }} today={model.today} formatDate={(iso) => when.day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('judgements.validUntil', { date: text }) }} />
                    ) : (
                      t('judgements.noExpiry')
                    ),
                  },
                  { label: t('judgement.state'), value: <JudgementStateTag state={judgement.state} /> },
                  {
                    label: t('judgement.visit'),
                    value: judgement.visit && visitHref ? <Link href={visitHref}>{t('judgement.visitOf', { type: t(`visitType.${judgement.visit.type}`), day: when.day(judgement.visit.doneOn) })}</Link> : t('judgement.noVisit'),
                  },
                  { label: t('judgement.doctor'), value: judgement.doctor?.name ?? t('judgement.noDoctor') },
                  { label: t('judgement.recordedAt'), value: when.at(judgement.recordedAt) },
                  {
                    label: t('judgement.copies'),
                    value:
                      judgement.copies.length === 0 ? (
                        t('judgements.noCopy')
                      ) : (
                        <ul className="fw-hv-list">
                          {judgement.copies.map((copy, index) => (
                            <li key={copy.fileId}>
                              {copy.availableAt ? (
                                <a href={copyHref(copy.fileId)} target="_blank" rel="noopener noreferrer">
                                  <FileText size={13} aria-hidden /> {t('judgement.copyN', { n: index + 1, day: when.at(copy.availableAt) })}
                                </a>
                              ) : (
                                <span className="fw-hv-muted">{t('judgement.copyWaiting', { n: index + 1 })}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                ]}
              />
            )}
          </>
        ) : null}
      </div>
    </Modal>
  )
}
