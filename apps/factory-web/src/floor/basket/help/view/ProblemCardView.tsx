'use client'

import { Building2, Camera, Check, CheckCheck, Hourglass, MapPin, Mic, TriangleAlert, UserCheck } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { useT } from '../../../../lib/i18n/provider'
import { TaskLine, Ticks, type TickState } from '../../../tasks/shared/view/TaskParts'
import type { CallFlag } from '../api'
import { problemIcon } from '../icons'
import { CARD_TONE, cardStateOf, cardWordsKey, isProblemCode, leaderButtons, mediaHeld, spotPlace, spotShown, workerCanSolve, type CardState } from '../model'
import '../help2.css'

/**
 * owb-fl8 step 1 — the red card of a problem on the basket (design § 5zf B; P/fplus.js probCard, fCallCards): what was told, its
 * state **Told → The team leader comes → Solved** with the minutes, "It is at the office now" after its time, "The office prints it
 * again" for a lost or damaged page; the place on the picture (only where the server keeps it), a photo, a voice note (online);
 * **On my way** and **Solved** for the team leader, **Solved** for the worker. The view fetches nothing (ProblemCard.tsx sends).
 */

export type CardAction = { readonly type: 'spot' } | { readonly type: 'photo' } | { readonly type: 'voice' } | { readonly type: 'answer'; readonly step: 'ON_THE_WAY' | 'SOLVED' }

export interface ProblemCardModel {
  readonly flag: CallFlag
  readonly picture: string | null
  readonly online: boolean
  /** The person answers calls (the team leader): On my way, then Solved. */
  readonly answers: boolean
  /** An answer saved on this phone and its ticks; null: none. */
  readonly pending: { readonly step: 'ON_THE_WAY' | 'SOLVED'; readonly ticks: TickState } | null
  /** A photo or voice note just went to the office. */
  readonly sent: 'photo' | 'voice' | 'spot' | null
}

const STATE_ICON: Readonly<Record<CardState, typeof Hourglass>> = { TOLD: Hourglass, COMES: UserCheck, OFFICE: Building2, SOLVED: CheckCheck }

export function ProblemCardView({ model, onAction }: { model: ProblemCardModel; onAction: (action: CardAction) => void }) {
  const t = useT('floor-help2')
  const { flag } = model
  const state = cardStateOf(flag)
  if (!state) return null
  const tone = CARD_TONE[state]
  const StateIcon = STATE_ICON[state]
  const offline = mediaHeld(model.online) ? t('media.offline') : null
  const open = state !== 'SOLVED'
  const answers = model.answers ? leaderButtons(flag) : []
  const workerSolve = !model.answers && workerCanSolve(flag)
  const spot = spotShown(flag)
  const place = spot && typeof flag.spot === 'number' ? spotPlace(flag.spot) : null

  return (
    <section className="fw-h2-card" data-tone={tone} aria-label={t('card.label')}>
      <div className="fw-h2-card-head">
        <span className="fw-h2-card-icon" data-tone={state === 'SOLVED' ? 'success' : state === 'COMES' ? 'info' : undefined} aria-hidden>
          {state === 'SOLVED' ? <Check /> : problemIcon(flag.typeCode)}
        </span>
        <div className="fw-h2-card-text">
          <p className="fw-h2-card-title">{isProblemCode(flag.typeCode) ? t(`problem.code.${flag.typeCode}`) : t('card.label')}</p>
          <div className="fw-h2-chips">
            <span className="fw-h2-chip" data-tone={tone}>
              <StateIcon aria-hidden />
              {t(cardWordsKey(state, flag.typeCode))}
            </span>
            {open ? <span className="fw-h2-minutes">{t('card.minutes', { count: flag.minutes })}</span> : null}
          </div>
        </div>
        {place ? (
          <span className="fw-h2-spotpic" aria-label={t('spot.shown', { no: (flag.spot as number) + 1 })} role="img">
            {model.picture ? <img src={model.picture} alt="" /> : null}
            <span className="fw-h2-dot" style={{ left: `${place.left}%`, top: `${place.top}%` }} />
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="fw-h2-actions" role="group" aria-label={t('card.add')}>
          {spot ? (
            <FloorButton variant="secondary" icon={<MapPin />} heldReason={offline} onClick={() => onAction({ type: 'spot' })}>
              {t('card.spot')}
            </FloorButton>
          ) : null}
          <FloorButton variant="secondary" icon={<Camera />} heldReason={offline} onClick={() => onAction({ type: 'photo' })}>
            {t('card.photo')}
          </FloorButton>
          <FloorButton variant="secondary" icon={<Mic />} heldReason={offline} onClick={() => onAction({ type: 'voice' })}>
            {t('card.voice')}
          </FloorButton>
        </div>
      ) : null}
      {offline && open ? <p className="fw-floor-muted">{offline}</p> : null}
      {open && (answers.length > 0 || workerSolve) ? (
        <div className="fw-h2-actions" role="group" aria-label={t('card.answer')}>
          {answers.includes('ON_THE_WAY') ? (
            <FloorButton variant="primary" icon={<UserCheck />} heldReason={model.pending ? t('card.pending') : null} onClick={() => onAction({ type: 'answer', step: 'ON_THE_WAY' })}>
              {t('card.onMyWay')}
            </FloorButton>
          ) : null}
          {answers.includes('SOLVED') || workerSolve ? (
            <FloorButton variant="success" icon={<Check />} heldReason={model.pending ? t('card.pending') : null} onClick={() => onAction({ type: 'answer', step: 'SOLVED' })}>
              {t('card.solved')}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
      {model.pending ? (
        <p className="fw-h2-ticks">
          <Ticks state={model.pending.ticks} />
        </p>
      ) : null}
      {model.sent ? (
        <TaskLine tone="success" icon={<Check />}>
          {t(`card.sent.${model.sent}`)}
        </TaskLine>
      ) : null}
      {state === 'OFFICE' ? (
        <TaskLine tone="danger" icon={<TriangleAlert />}>
          {t('card.officeNote')}
        </TaskLine>
      ) : null}
    </section>
  )
}
