'use client'

import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { InstructionRecord, VersionAnswer } from '../../api'
import { languageName, NS, previewSteps, valueOf, versionLanguages, type Read } from '../../model'
import { InstructionsMessages, MediaThumb, StepIcon, VersionPill } from '../../view/parts'

/** SCR-285-preview — the floor preview window's view model (design tab:wi-tab-preview, a new tab). */
export interface PreviewModel {
  /** production.instructions.view. */
  readonly allowed: boolean
  readonly record: Read<InstructionRecord>
  readonly version: Read<VersionAnswer> | null
  readonly language: string
  /** fileId → the address of a photo or video (null: none to show). */
  readonly mediaSrc: Readonly<Record<string, string | null>>
}

export interface PreviewActions {
  onLanguage?: (language: string) => void
  onVersion?: (versionId: string) => void
  onRetry?: () => void
}

/**
 * tab:wi-tab-preview "Floor preview" (design production.instructions: see it at floor density as an operator will): the
 * version at the tablet's size and density, in the language picked (a step not written in it shows the one the tablet would
 * fall back to, marked), picture-first steps with their icon, critical point, safety note and the tick the tablet asks,
 * Read aloud, and the Seen button as the operator sees it (inert here: a preview records nothing). Fetches nothing.
 */
export function PreviewView({ model, actions }: { model: PreviewModel; actions?: PreviewActions }) {
  return (
    <InstructionsMessages>
      <Preview model={model} actions={actions} />
    </InstructionsMessages>
  )
}

function Preview({ model, actions }: { model: PreviewModel; actions?: PreviewActions }) {
  const t = useT(NS)
  const ds = useDsWords()
  const locale = useLocale()
  if (!model.allowed) return <EmptyState title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
  if (model.record.status === 'error') return <EmptyState title={t('preview.failed')} description={t(model.record.problem)} />
  const record = valueOf(model.record)
  const answer = valueOf(model.version)
  const languages = versionLanguages(answer, record?.floorLanguages ?? [])
  const steps = answer ? previewSteps(answer, model.language) : []
  const readText = () => steps.map((step, index) => `${index + 1}. ${step.words}${step.safety ? `. ${step.safety}` : ''}`).join('\n')
  const usable = record ? [...record.versions].filter((version) => version.status !== 'DISCARDED').sort((a, b) => b.number - a.number) : []
  return (
    <div className="fw-wi-window">
      <div className="fw-wi-window-band fw-wi-noprint">
        <span className="fw-wi-cell">
          <h1 className="fw-wi-h1">{record ? t('preview.title', { number: record.instruction.number }) : t('preview.titlePlain')}</h1>
          <span className="fw-wi-hint">{t('preview.note')}</span>
        </span>
        <span className="fw-wi-actions">
          {languages.length > 0 && (
            <SegmentedControl
              size="sm"
              ariaLabel={t('preview.language')}
              value={model.language}
              onChange={(value) => actions?.onLanguage?.(value)}
              wrap
              options={languages.map((code) => ({ value: code, label: code.toUpperCase(), title: languageName(code, locale) }))}
            />
          )}
          {usable.length > 0 && answer && (
            <Select size="sm" aria-label={t('preview.version')} value={answer.version.id} onChange={(event) => actions?.onVersion?.(event.target.value)}>
              {usable.map((version) => (
                <option key={version.id} value={version.id}>
                  {t('version.pill', { number: version.number, status: t(`status.${version.status}`) })}
                </option>
              ))}
            </Select>
          )}
        </span>
      </div>
      {!record || model.version?.status === 'loading' ? (
        <p className="fw-wi-hint fw-wi-inline" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : model.version === null ? (
        <EmptyState title={t('steps.noVersion.title')} description={t('steps.noVersion.body')} />
      ) : model.version.status === 'error' ? (
        <Banner tone="danger" title={t('preview.failed')}>
          {t(model.version.problem)}
        </Banner>
      ) : answer ? (
        <div className="fw-wi-tablet" data-density="floor" lang={model.language}>
          <header className="fw-wi-tablet-head">
            <span className="fw-wi-cell">
              <span className="fw-wi-tablet-kicker">{record.instruction.operation.code}</span>
              <span className="fw-wi-tablet-title">{record.instruction.operation.name}</span>
            </span>
            <VersionPill status={answer.version.status} number={answer.version.number} />
          </header>
          {answer.version.status !== 'PUBLISHED' && <Banner tone="warning" title={t(answer.version.status === 'DRAFT' ? 'preview.draft' : 'preview.notInForce', { number: answer.version.number })} />}
          {answer.version.acknowledgementRequired && answer.version.number > 1 && <Banner tone="info" title={t('preview.newVersion', { number: answer.version.number })}>{answer.version.changeNote}</Banner>}
          <div className="fw-wi-actions">
            <ReadAloudButton text={readText} lang={model.language} labels={ds.readAloud} />
          </div>
          {steps.length === 0 ? (
            <EmptyState title={t('steps.empty')} description={t('steps.emptyRead')} />
          ) : (
            <ol className="fw-wi-tablet-steps">
              {steps.map((step, index) => (
                <li key={step.code}>
                  <Card padded>
                    <div className="fw-wi-tablet-step" data-critical={step.critical ? 'true' : undefined} data-media={step.media.length > 0 ? 'true' : undefined}>
                      {step.media[0] && (
                        <MediaThumb kind={step.media[0].kind} src={model.mediaSrc[step.media[0].fileId]} name={step.code} caption={step.media[0].caption} large />
                      )}
                      <div className="fw-wi-stack">
                        <span className="fw-wi-inline">
                          <span className="fw-wi-tablet-n" aria-hidden>
                            {index + 1}
                          </span>
                          <StepIcon icon={step.icon} size={28} />
                          {step.critical && (
                            <Tag tone="danger">
                              <TriangleAlert size={12} aria-hidden /> {t('steps.critical')}
                            </Tag>
                          )}
                          {step.requiredTick && (
                            <Tag tone="info">
                              <CheckCircle2 size={12} aria-hidden /> {t('preview.tick')}
                            </Tag>
                          )}
                        </span>
                        <p className="fw-wi-tablet-words">{step.words}</p>
                        {step.shownIn && <span className="fw-wi-sub">{t('preview.shownIn', { language: languageName(step.shownIn, locale) })}</span>}
                        {step.safety && (
                          <p className="fw-wi-tablet-safety">
                            <ShieldAlert size={18} aria-hidden /> {step.safety}
                          </p>
                        )}
                        {step.media.length > 1 && <span className="fw-wi-sub">{t('preview.moreMedia', { count: step.media.length - 1 })}</span>}
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ol>
          )}
          <FloorButton variant="primary" size="lg" block heldReason={t('preview.seenHeld')} icon={<CheckCircle2 aria-hidden />}>
            {t('preview.seen')}
          </FloorButton>
        </div>
      ) : null}
    </div>
  )
}
