'use client'

import { Clock, Hourglass, Package, Pause, Pin, Play, TriangleAlert, UserRound } from 'lucide-react'
import { Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { TeamChip } from '../../../../lib/people-picture/view/TeamChip'
import type { BoardCard } from '../api'
import { BASKETS_NAMESPACE, cardStateOf, customerWords, hasProblem, isLate, type CardState } from '../model'

/**
 * owb-fl9 step 1 — one basket on the office's Baskets board (P/ui.js basketCard): its picture, its B-number, the customer's NAME (only
 * for people allowed that customer; else its code), its team, its state, a problem, late, the person who has it (only where the site
 * names workers), the steps done of its route. A button: it opens the basket window. Never a price.
 */

const STATE_TONE: Readonly<Record<CardState, 'neutral' | 'info' | 'warning' | 'success'>> = { WAITING: 'neutral', WORKING: 'info', PAUSED: 'warning', READY: 'success' }
const STATE_ICON: Readonly<Record<CardState, typeof Play>> = { WAITING: Hourglass, WORKING: Play, PAUSED: Pause, READY: Package }

export function BasketCard({ card, ready, onOpen }: { card: BoardCard; ready: boolean; onOpen: (card: BoardCard) => void }) {
  const t = useT(BASKETS_NAMESPACE)
  const state = cardStateOf(card, ready)
  const StateIcon = STATE_ICON[state]
  const late = card.late
  return (
    <button type="button" className="fw-bb-card" data-problem={hasProblem(card) || undefined} onClick={() => onOpen(card)} aria-label={t('card.open', { code: card.code })}>
      <span className="fw-bb-pic" aria-hidden>
        {card.picture?.src ? <img src={card.picture.src} alt="" /> : null}
      </span>
      <span className="fw-bb-text">
        <span className="fw-bb-top">
          <bdi className="fw-bb-code">{card.code}</bdi>
          {card.progress ? <span className="fw-bb-progress">{t('card.progress', { done: card.progress.done, total: card.progress.total })}</span> : null}
        </span>
        <span className="fw-bb-who">{customerWords(card, 'office')}</span>
        <span className="fw-bb-chips">
          {card.flags?.first ? (
            <Pill tone="info" icon={<Pin aria-hidden />}>
              {t('card.first')}
            </Pill>
          ) : null}
          <Pill tone={STATE_TONE[state]} icon={<StateIcon aria-hidden />}>
            {t(`state.${state}`)}
          </Pill>
          {hasProblem(card) ? (
            <Pill tone="danger" icon={<TriangleAlert aria-hidden />}>
              {t('card.problem')}
            </Pill>
          ) : null}
          {isLate(card) ? (
            <Pill tone="danger" icon={<Clock aria-hidden />}>
              {late ? t('card.lateDays', { count: late.days }) : t('card.late')}
            </Pill>
          ) : null}
        </span>
        {card.team || card.worker?.name ? (
          <span className="fw-bb-people">
            {card.team ? <TeamChip team={{ name: card.team.name, kind: card.team.pictureKind ?? null, icon: card.team.pictureIcon ?? null, colour: card.team.pictureColour ?? null }} /> : null}
            {card.worker?.name ? (
              <span className="fw-bb-worker">
                <UserRound aria-hidden />
                {card.worker.name}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  )
}
