'use client'

import { ArrowLeft, ArrowRight, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, Spinner, Tag } from '@nexus/ui/primitives'
import { INSTRUCTION_LIMITS } from '@nexus/factory-domain/production/instructions/rules'
import { FileDropzone, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { languageName, MEDIA_ACCEPT, MEDIA_MAX_BYTES, moveItem, NS, stepDraftOf, valueOf, type MediaDraft, type StepDraft, type VersionDraft } from '../../model'
import { MediaThumb, StepIcon } from '../../view/parts'
import type { RecordModel } from './InstructionRecordView'

export interface MediaActions {
  onDraft?: (draft: VersionDraft) => void
  /** Upload files and put them on a step of the draft (announce, PUT to the store, confirm). */
  onUpload?: (stepKey: string, files: File[]) => void
  onDismissUpload?: (key: string) => void
}

const sizeText = (bytes: number, locale: string): string => {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(mb)} MB` : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`
}

/**
 * Work instruction › Media (design rec tab `media`, sec wi-media "Photos and videos": media per step; upload; attach to a
 * step): per step its photos and short videos (shown whole; a video muted and looping as on the tablet), each with its
 * caption in the language written, moved within the step or taken off; Upload to a step puts a file on the draft (part of
 * the same save as the steps). Photos never show faces (COL-017): the drop zone says so. Fetches nothing.
 */
export function MediaTab({ model, editable, actions }: { model: RecordModel; editable: boolean; actions?: MediaActions }) {
  const t = useT(NS)
  const ds = useDsWords()
  const locale = useLocale()
  const shown = valueOf(model.shown)
  if (!shown)
    return (
      <Card padded aria-busy={model.shown?.status === 'loading'}>
        {model.shown?.status === 'error' ? (
          <EmptyState title={t('steps.failed')} description={t(model.shown.problem)} />
        ) : model.shown === null ? (
          <EmptyState title={t('steps.noVersion.title')} description={t('steps.noVersion.body')} />
        ) : (
          <p className="fw-wi-hint fw-wi-inline" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        )}
      </Card>
    )
  const draft: VersionDraft = model.draft ?? { steps: [...shown.steps].sort((a, b) => a.sortOrder - b.sortOrder).map(stepDraftOf), changeNote: shown.version.changeNote ?? '', acknowledgementRequired: shown.version.acknowledgementRequired }
  const setMedia = (step: StepDraft, media: readonly MediaDraft[]) => actions?.onDraft?.({ ...draft, steps: draft.steps.map((entry) => (entry.key === step.key ? { ...entry, media } : entry)) })
  const language = model.language
  const total = draft.steps.reduce((sum, step) => sum + step.media.length, 0)
  if (draft.steps.length === 0)
    return (
      <Card padded>
        <EmptyState title={t('media.noSteps.title')} description={t('media.noSteps.body')} />
      </Card>
    )
  return (
    <div className="fw-wi-stack">
      <p className="fw-wi-hint">
        {t('media.intro', { count: total })} {!model.can.seeMedia && t('media.noFilesRead')}
      </p>
      <div className="fw-wi-media-steps">
        {draft.steps.map((step, index) => {
          const uploads = model.uploads.filter((upload) => upload.stepKey === step.key)
          const full = step.media.length >= INSTRUCTION_LIMITS.mediaPerStep
          return (
            <Card key={step.key} padded>
              <section className="fw-wi-stack" aria-labelledby={`fw-wi-media-${step.key}`}>
                <h3 id={`fw-wi-media-${step.key}`} className="fw-wi-h3 fw-wi-inline">
                  <span className="fw-wi-step-n" aria-hidden>
                    {index + 1}
                  </span>
                  <StepIcon icon={step.icon} />
                  <span className="fw-wi-mono">{step.code}</span>
                  <span className="fw-wi-sub">{step.text[language] || Object.values(step.text).find((text) => text.trim()) || ''}</span>
                </h3>
                {step.media.length === 0 && uploads.length === 0 ? (
                  <p className="fw-wi-hint">{t('media.none')}</p>
                ) : (
                  <ol className="fw-wi-media-grid" aria-label={t('media.listOf', { code: step.code })}>
                    {step.media.map((medium, place) => (
                      <li key={medium.key} className="fw-wi-media-item">
                        <MediaThumb kind={medium.kind} src={model.mediaSrc[medium.fileId]} name={medium.file?.originalName ?? t('media.unknownFile')} caption={medium.caption[language] || null} />
                        <span className="fw-wi-chips">
                          <Tag tone="neutral">{t(`media.kind.${medium.kind}`)}</Tag>
                          {medium.file && medium.file.status !== 'AVAILABLE' && <Tag tone="warning">{t('media.notReady', { status: t(`fileStatus.${medium.file.status}`) })}</Tag>}
                          {medium.file && <span className="fw-wi-sub">{sizeText(medium.file.sizeBytes, locale)}</span>}
                        </span>
                        {editable ? (
                          <>
                            <Field label={t('media.caption', { language: languageName(language, locale) })}>
                              <Input size="sm" value={medium.caption[language] ?? ''} maxLength={INSTRUCTION_LIMITS.caption} onChange={(event) => setMedia(step, step.media.map((entry) => (entry.key === medium.key ? { ...entry, caption: { ...entry.caption, [language]: event.target.value } } : entry)))} />
                            </Field>
                            <span className="fw-wi-actions">
                              <Button size="sm" variant="quiet" aria-label={t('media.earlier', { name: medium.file?.originalName ?? '' })} heldReason={place === 0 ? t('media.first') : null} onClick={() => setMedia(step, moveItem(step.media, place, place - 1))}>
                                <ArrowLeft size={13} aria-hidden />
                              </Button>
                              <Button size="sm" variant="quiet" aria-label={t('media.later', { name: medium.file?.originalName ?? '' })} heldReason={place === step.media.length - 1 ? t('media.last') : null} onClick={() => setMedia(step, moveItem(step.media, place, place + 1))}>
                                <ArrowRight size={13} aria-hidden />
                              </Button>
                              <Button size="sm" variant="danger-outline" onClick={() => setMedia(step, step.media.filter((entry) => entry.key !== medium.key))}>
                                <Trash2 size={13} aria-hidden /> {t('media.remove')}
                              </Button>
                            </span>
                          </>
                        ) : (
                          medium.caption[language] && <span className="fw-wi-hint">{medium.caption[language]}</span>
                        )}
                      </li>
                    ))}
                    {uploads.map((upload) => (
                      <li key={upload.key} className="fw-wi-media-item">
                        {upload.state === 'uploading' ? (
                          <p className="fw-wi-hint fw-wi-inline" role="status">
                            <Spinner size={14} /> {t('media.uploading', { name: upload.name })}
                          </p>
                        ) : (
                          <Banner
                            tone="danger"
                            title={t('media.failed', { name: upload.name })}
                            action={
                              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissUpload?.(upload.key)}>
                                {t('common.dismiss')}
                              </Button>
                            }
                          >
                            {upload.problem ? t(upload.problem) : null}
                          </Banner>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {editable &&
                  (full ? (
                    <p className="fw-wi-hint">{t('problem.media.tooMany', { n: index + 1, max: INSTRUCTION_LIMITS.mediaPerStep })}</p>
                  ) : (
                    <FileDropzone
                      accept={MEDIA_ACCEPT}
                      maxBytes={MEDIA_MAX_BYTES}
                      multiple
                      labels={ds.fileDropzone}
                      hint={t('media.dropHint', { max: INSTRUCTION_LIMITS.mediaPerStep - step.media.length })}
                      onFiles={(files) => actions?.onUpload?.(step.key, files.slice(0, INSTRUCTION_LIMITS.mediaPerStep - step.media.length))}
                    />
                  ))}
              </section>
            </Card>
          )
        })}
      </div>
      <p className="fw-wi-hint">{t('media.markupGap')}</p>
    </div>
  )
}
