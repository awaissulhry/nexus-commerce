'use client'

import type { ReactNode } from 'react'
import { Camera, CircleAlert, CircleHelp, Clock, Cog, Droplet, Hammer, Hand, Hourglass, Mic, SlidersHorizontal, Sparkles, Unlink, Wrench, Zap } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { FloorButton } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { HeldLine, ProblemState, TaskLine } from '../../shared/view/TaskParts'
import type { TaskProblem } from '../../shared/task-api'
import type { JobRecord, StoredMedia } from '../api'
import { actionTiles, failureTiles, mediaHeld, type CloseDraft } from '../depth'
import { afterHeld, WORDS_MAX } from '../model'
import { StoredList, type Place } from './MediaParts'

/**
 * Close on one screen (B-W2b-102; design floor.machine "close", QHS-190): "Action tiles (adjusted, replaced part, cleaned,
 * other), failure code tiles, time … (auto), before and after photos", and the machine after (W2a). Three taps on the
 * usual path: what was done → the failure code → Hand back (running is preselected unless the machine is locked: H1).
 * The time is the office's count from Start (never typed, never summed per person); the tiles are factory-domain's lists
 * in the screen's language. A stitch-settings first-piece check after the repair is W3 (QHS-191): not drawn.
 */

const ACTION_ICON: Readonly<Record<string, ReactNode>> = { ADJUSTED: <Wrench />, REPLACED_PART: <Cog />, CLEANED: <Sparkles />, OTHER: <CircleHelp /> }
const FAILURE_ICON: Readonly<Record<string, ReactNode>> = {
  LOOSE_PART: <Unlink />,
  WORN_PART: <Hourglass />,
  BROKEN_PART: <Hammer />,
  ELECTRICAL: <Zap />,
  LUBRICATION: <Droplet />,
  SETTINGS: <SlidersHorizontal />,
  WRONG_USE: <Hand />,
  OTHER: <CircleHelp />,
}

export type CloseAction =
  | { type: 'closeAction'; code: string }
  | { type: 'closeFailure'; code: string }
  | { type: 'words'; text: string }
  | { type: 'after'; after: 'RUNNING' | 'DO_NOT_USE' | 'RETIRED' }
  | { type: 'closeMedia'; kind: 'PHOTO' | 'AUDIO'; category: 'BEFORE_WORK' | 'AFTER_WORK' | null }
  | { type: 'open'; file: StoredMedia }

export interface CloseBodyProps {
  readonly record: JobRecord
  readonly draft: CloseDraft
  readonly files: readonly StoredMedia[]
  readonly online: boolean
  readonly busy?: boolean
  readonly uploading?: boolean
  readonly failed?: boolean
  readonly problem?: TaskProblem | null
  readonly t: Translate
  readonly locale: 'it' | 'en'
  readonly place: Place
  readonly age: (minutes: number) => string
  readonly refusalWords: (code: string) => { message: string; fix: string | null } | null
  readonly send: (action: CloseAction) => void
}

export function CloseBody({ record, draft, files, online, busy, uploading, failed, problem, t, locale, place, age, refusalWords, send }: CloseBodyProps) {
  const words = useReasonWords()
  const machine = record.job.machine
  const actions: ReasonTile[] = actionTiles(locale).map((tile) => ({ id: tile.code, label: tile.label, icon: ACTION_ICON[tile.code] ?? <CircleHelp />, hint: tile.code === 'OTHER' ? t('symptom.saysWords') : undefined }))
  const failures: ReasonTile[] = failureTiles(locale).map((tile) => ({ id: tile.code, label: tile.label, icon: FAILURE_ICON[tile.code] ?? <CircleHelp /> }))
  const mediaKey = mediaHeld({ online, count: 0, busy: uploading || busy })
  const minutes = record.close.minutesSoFar
  return (
    <div className="fw-floor-stack">
      {problem ? <ProblemState problem={problem} words={refusalWords} /> : null}
      <h2 className="fw-floor-section-title">{t('handBack.title', { job: record.job.number, machine: machine.assetNumber })}</h2>
      {!online ? <HeldLine text={t('held.offline')} /> : null}
      <div className="fw-task-split">
        <div className="fw-floor-stack">
          <ReasonGrid label={t('handBack.what')} reasons={actions} value={draft.action} onChange={(id) => send({ type: 'closeAction', code: id })} words={words} locale={INTL_LOCALE[locale]} />
          <ReasonGrid label={t('close.failure')} reasons={failures} value={draft.failure} onChange={(id) => send({ type: 'closeFailure', code: id })} words={words} locale={INTL_LOCALE[locale]} />
        </div>
        <div className="fw-floor-stack">
          <Field label={t('handBack.words')} required={draft.action === 'OTHER'} hint={t('handBack.wordsHint')} htmlFor="fw-mc-done-words">
            <Textarea id="fw-mc-done-words" value={draft.words} rows={3} limit={WORDS_MAX} maxLength={WORDS_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
          </Field>
          <TaskLine tone="info" icon={<Clock />}>
            {minutes === null ? t('close.notStarted') : t('close.time', { age: age(minutes) })}
          </TaskLine>
          <section className="fw-floor-section" aria-labelledby="fw-mc-after">
            <h3 id="fw-mc-after" className="fw-floor-subtitle">
              {t('handBack.after')}
            </h3>
            <div className="fw-mc-after" role="group" aria-labelledby="fw-mc-after">
              {(['RUNNING', 'DO_NOT_USE', 'RETIRED'] as const).map((after) => {
                const why = afterHeld(after, machine)
                return (
                  <FloorButton
                    key={after}
                    size="lg"
                    block
                    variant={draft.after === after ? (after === 'RUNNING' ? 'success' : 'danger') : 'secondary'}
                    aria-pressed={draft.after === after}
                    heldReason={why ? t(why) : null}
                    onClick={() => send({ type: 'after', after })}
                  >
                    {t(`after.${after}`)}
                  </FloorButton>
                )
              })}
            </div>
            {draft.after === 'RETIRED' ? <TaskLine tone="info" icon={<CircleAlert />}>{t('handBack.retiredNote')}</TaskLine> : null}
          </section>
          <section className="fw-floor-section" aria-labelledby="fw-mc-close-media">
            <h3 id="fw-mc-close-media" className="fw-floor-subtitle">
              {t('media.title')}
            </h3>
            <StoredList files={files} t={t} place={place} online={online} onOpen={(file) => send({ type: 'open', file })} />
            {uploading ? (
              <p className="fw-floor-muted" role="status" aria-busy="true">
                {t('media.uploading')}
              </p>
            ) : null}
            {failed ? (
              <TaskLine tone="danger" icon={<CircleAlert />} alert>
                {t('media.failed')}
              </TaskLine>
            ) : null}
            <div className="fw-mc-media-buttons">
              <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={mediaKey ? t(mediaKey) : null} onClick={() => send({ type: 'closeMedia', kind: 'PHOTO', category: 'BEFORE_WORK' })}>
                {t('close.photoBefore')}
              </FloorButton>
              <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={mediaKey ? t(mediaKey) : null} onClick={() => send({ type: 'closeMedia', kind: 'PHOTO', category: 'AFTER_WORK' })}>
                {t('close.photoAfter')}
              </FloorButton>
              <FloorButton size="lg" variant="secondary" icon={<Mic />} heldReason={mediaKey ? t(mediaKey) : null} onClick={() => send({ type: 'closeMedia', kind: 'AUDIO', category: null })}>
                {t('media.addVoice')}
              </FloorButton>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
