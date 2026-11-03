'use client'

import type { ReactNode } from 'react'
import { CircleHelp, Clock, Cog, Droplet, Hammer, Hand, Hourglass, SlidersHorizontal, Sparkles, Unlink, Wrench, Zap } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { RadioCard } from '@nexus/ui/primitives'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { MACHINE_AFTER } from '../../_shared/api'
import { ageWords } from '../../_shared/model'
import { useWords } from '../../_shared/parts'
import type { DeepJob, JobClose } from '../../requests/depth/api'
import { actionTiles, afterHeld, failureTiles, type CloseDraft } from '../../requests/depth/model'
import '../../requests/depth/depth.css'

const ACTION_ICON: Readonly<Record<string, ReactNode>> = { ADJUSTED: <Wrench size={20} aria-hidden />, REPLACED_PART: <Cog size={20} aria-hidden />, CLEANED: <Sparkles size={20} aria-hidden />, OTHER: <CircleHelp size={20} aria-hidden /> }
const FAILURE_ICON: Readonly<Record<string, ReactNode>> = {
  LOOSE_PART: <Unlink size={20} aria-hidden />,
  WORN_PART: <Hourglass size={20} aria-hidden />,
  BROKEN_PART: <Hammer size={20} aria-hidden />,
  ELECTRICAL: <Zap size={20} aria-hidden />,
  LUBRICATION: <Droplet size={20} aria-hidden />,
  SETTINGS: <SlidersHorizontal size={20} aria-hidden />,
  WRONG_USE: <Hand size={20} aria-hidden />,
  OTHER: <CircleHelp size={20} aria-hidden />,
}

/**
 * The one-screen close (B-W2b-140 on B-W2b-96; QHS-190; design plant.jobs Hand-back "What was done · failure code · time
 * (automatic from start to done) · machine after", pop:close "Hand back"): the action tiles and the failure-code tiles of
 * factory-domain plant/jobs/close in the page's language (the same tiles as the floor's close), words (needed for Other),
 * the minutes the API counts from the start (never typed, never per person), and the machine after — Running held while
 * the machine is locked as unsafe (H1). The Hand-back tab and the Hand back dialog draw this one form.
 */
export function CloseForm({ job, close, draft, disabled = false, onDraft }: { job: DeepJob; close: JobClose | null; draft: CloseDraft; disabled?: boolean; onDraft?: (patch: Partial<CloseDraft>) => void }) {
  const t = useWords()
  const locale = useLocale()
  const words = useReasonWords()
  const actions: ReasonTile[] = actionTiles(locale).map((tile) => ({ id: tile.code, label: tile.label, icon: ACTION_ICON[tile.code] ?? <CircleHelp size={20} aria-hidden />, hint: tile.code === 'OTHER' ? t('close.otherHint') : undefined }))
  const failures: ReasonTile[] = failureTiles(locale).map((tile) => ({ id: tile.code, label: tile.label, icon: FAILURE_ICON[tile.code] ?? <CircleHelp size={20} aria-hidden /> }))
  const minutes = close?.minutesSoFar ?? null
  return (
    <div className="fw-pd-close">
      <div className="fw-pl-stack tight">
        <ReasonGrid label={t('close.action')} reasons={actions} value={draft.action} onChange={(id) => !disabled && onDraft?.({ action: id as CloseDraft['action'] })} words={words} locale={locale} />
        <ReasonGrid label={t('close.failure')} reasons={failures} value={draft.failure} onChange={(id) => !disabled && onDraft?.({ failure: id })} words={words} locale={locale} />
        <p className="fw-pl-hint">{t('close.failureHint')}</p>
      </div>
      <div className="fw-pl-stack tight">
        <Field label={t('handBack.workDone')} required={draft.action === 'OTHER'} hint={draft.action === 'OTHER' ? t('close.wordsOther') : t('close.wordsHint')}>
          <Textarea value={draft.words} rows={3} maxLength={2000} disabled={disabled} onChange={(event) => onDraft?.({ words: event.target.value })} />
        </Field>
        <p className="fw-pl-row fw-pl-hint">
          <Clock size={13} aria-hidden /> {minutes === null ? t('close.notStarted') : t('close.minutes', { time: ageWords(t, minutes) })}
        </p>
        <div className="fw-pl-choices" role="radiogroup" aria-label={t('handBack.machineAfter')}>
          {MACHINE_AFTER.map((after) => {
            const reason = afterHeld(after, job, close)
            return (
              <RadioCard
                key={after}
                name={`machine-after-${job.id}`}
                value={after}
                checked={draft.after === after}
                selected={draft.after === after}
                disabled={disabled || reason !== null}
                onChange={() => onDraft?.({ after })}
                title={t(`machineAfter.${after}`)}
                description={reason ? t(reason) : t(`machineAfterHint.${after}`)}
              />
            )
          })}
        </div>
        {draft.after === 'RETIRED' && <Banner tone="info" title={t('handBack.retiresOnClose')} />}
      </div>
    </div>
  )
}
