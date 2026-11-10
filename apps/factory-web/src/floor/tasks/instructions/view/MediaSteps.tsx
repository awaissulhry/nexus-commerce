'use client'

import { ArrowLeft, ArrowRight, Check, CircleAlert, CloudOff, Image as ImageIcon, Loader, ShieldAlert, SquareCheckBig, ZoomIn } from 'lucide-react'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { instructionIcon } from '../../../../lib/production/instruction-icons'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { ListFooter, TaskLine } from '../../shared/view/TaskParts'
import type { InstructionStep } from '../api'
import { readAloudText } from '../model'

/**
 * FloorMediaSteps (design part of floor.instructions sec:steps "How to do it"; the DS has none: composed here of DS FloorButton
 * and ReadAloudButton, named in the notes): one step per screen, picture first — a big photo (tap or Zoom opens the Photo pop-up
 * with + and −) or a muted looping video with its caption —, the step's icon, "Step 2 of 5", short words in the language they are
 * written in, the critical point and the safety note boxed, Previous and Next as big buttons. The numbered strip says which steps
 * were on screen (Seen waits for all of them). Data in, events out: the container reads the photos and videos.
 */

export interface MediaStepsModel {
  readonly steps: readonly InstructionStep[]
  readonly index: number
  /** The steps on screen so far (each index once). */
  readonly shown: readonly number[]
  /** The medium picked on this step (a step with several photos or videos). */
  readonly medium: number
  /** A medium's blob address: a string once read; null: being read; undefined: not read (offline and not kept). */
  readonly src: Readonly<Record<string, string | null | undefined>>
  /** Media whose read failed (the office has not finished it, or the network). */
  readonly failed: readonly string[]
  /** The language the person asked for (a step shown in another says so). */
  readonly asked: string
  readonly online: boolean
}

export type MediaStepsAction = { type: 'step'; index: number } | { type: 'next' } | { type: 'prev' } | { type: 'medium'; index: number } | { type: 'zoom'; mediaId: string }

export function MediaSteps({ model, t, send }: { model: MediaStepsModel; t: Translate; send: (action: MediaStepsAction) => void }) {
  const ds = useDsWords()
  const count = model.steps.length
  const step = model.steps[model.index]
  if (!step) return null
  const Icon = instructionIcon(step.icon)
  const medium = step.media[Math.min(model.medium, Math.max(0, step.media.length - 1))]
  const src = medium ? model.src[medium.id] : undefined
  const failed = medium ? model.failed.includes(medium.id) : false
  const language = step.shownIn ?? model.asked
  const otherLanguage = step.shownIn !== null && step.shownIn !== model.asked
  const first = model.index === 0
  const last = model.index === count - 1
  const caption = medium?.caption ?? null

  return (
    <section className="fw-fi-step fw-floor-stack" aria-labelledby="fw-fi-step-words">
      <div className="fw-fi-step-split">
        <div className="fw-floor-stack fw-fi-step-picture">
          <div className="fw-fi-picture" data-kind={medium?.kind ?? 'none'}>
            {!medium ? (
              <span className="fw-fi-picture-icon" aria-hidden="true">
                <Icon />
              </span>
            ) : src && medium.kind === 'PHOTO' ? (
              <button type="button" className="fw-fi-photo" onClick={() => send({ type: 'zoom', mediaId: medium.id })} aria-label={t('steps.zoomOpen')}>
                <img src={src} alt={caption ?? step.words} />
              </button>
            ) : src && medium.kind === 'VIDEO' ? (
              <video className="fw-fi-video" src={src} muted loop autoPlay playsInline aria-label={caption ?? step.words} />
            ) : (
              <p className="fw-fi-picture-wait" role="status">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  {failed ? <CircleAlert /> : src === null && model.online ? <Loader /> : model.online ? <ImageIcon /> : <CloudOff />}
                </span>
                {failed ? t('steps.mediaFailed') : model.online ? t('steps.mediaLoading') : t('steps.mediaOffline')}
              </p>
            )}
          </div>
          {caption ? <p className="fw-fi-caption">{caption}</p> : null}
          {step.media.length > 1 ? (
            <div className="fw-fi-media-pick" role="group" aria-label={t('steps.mediaPick')}>
              {step.media.map((entry, index) => (
                <FloorButton key={entry.id} size="md" variant={index === model.medium ? 'primary' : 'secondary'} aria-pressed={index === model.medium} onClick={() => send({ type: 'medium', index })}>
                  {t(entry.kind === 'VIDEO' ? 'steps.videoN' : 'steps.photoN', { n: index + 1 })}
                </FloorButton>
              ))}
            </div>
          ) : null}
        </div>

        <div className="fw-floor-stack fw-fi-step-text">
          <header className="fw-fi-step-head">
            <span className="fw-fi-step-icon" aria-hidden="true">
              <Icon />
            </span>
            <span className="fw-fi-step-count" aria-live="polite">
              {t('steps.of', { n: model.index + 1, count })}
            </span>
            {step.critical ? (
              <span className="fw-floor-pill" data-tone="danger">
                {t('steps.critical')}
              </span>
            ) : null}
            <span className="fw-fi-step-tools">
              {medium && src && medium.kind === 'PHOTO' ? (
                <FloorButton size="md" variant="secondary" icon={<ZoomIn />} onClick={() => send({ type: 'zoom', mediaId: medium.id })}>
                  {t('steps.zoom')}
                </FloorButton>
              ) : null}
              <ReadAloudButton text={() => readAloudText(step, model.index)} lang={speechLang(language)} size="sm" showVoice={false} labels={ds.readAloud} />
            </span>
          </header>
          <p id="fw-fi-step-words" className="fw-fi-words" lang={language}>
            {step.words}
          </p>
          {otherLanguage ? <p className="fw-floor-muted">{t('steps.otherLanguage')}</p> : null}
          {step.safety ? (
            <TaskLine tone="danger" icon={<ShieldAlert />}>
              <span lang={language}>{step.safety}</span>
            </TaskLine>
          ) : null}
          {step.requiredTick ? (
            <TaskLine tone="info" icon={<SquareCheckBig />}>
              {t('steps.tick')}
            </TaskLine>
          ) : null}
          <ol className="fw-fi-strip" aria-label={t('steps.strip')}>
            {model.steps.map((entry, index) => {
              const shown = model.shown.includes(index)
              return (
                <li key={entry.code}>
                  <button type="button" className="fw-fi-strip-step" data-current={index === model.index} data-shown={shown} aria-current={index === model.index ? 'step' : undefined} aria-label={t(shown ? 'steps.stripShown' : 'steps.stripNot', { n: index + 1 })} onClick={() => send({ type: 'step', index })}>
                    {shown ? <Check aria-hidden="true" /> : null}
                    <span>{index + 1}</span>
                  </button>
                </li>
              )
            })}
          </ol>
          <ListFooter
            count={t('steps.shownCount', { seen: model.shown.filter((index) => index < count).length, count })}
            keys={[
              { key: '→ ↵', does: t('keys.next') },
              { key: '←', does: t('keys.prev') },
              { key: 'Esc', does: t('keys.back') },
            ]}
          />
        </div>
        <div className="fw-fi-nav fw-fi-step-nav">
          <FloorButton size="lg" block variant="secondary" icon={<ArrowLeft />} heldReason={first ? t('steps.firstHeld') : null} onClick={() => send({ type: 'prev' })}>
            {t('steps.prev')}
          </FloorButton>
          <FloorButton size="lg" block variant={last ? 'secondary' : 'primary'} icon={<ArrowRight />} heldReason={last ? t('steps.lastHeld') : null} onClick={() => send({ type: 'next' })}>
            {t('steps.next')}
          </FloorButton>
        </div>
      </div>
    </section>
  )
}
