'use client'

import { Check, CheckCheck, Hourglass, MessageSquareText, UserCheck } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { Ticks, type TickState } from '../../../tasks/shared/view/TaskParts'
import type { CallFlag } from '../api'
import { askIcon, askToIcon } from '../icons'
import { askStateKey, askTo, isAskCode, leaderButtons } from '../model'
import '../help2.css'

/**
 * owb-fl8 step 2 — the ask on the basket (design § 5zf D; P/floor.js floorBasket's ask card): who answers (Designer · Team leader,
 * fixed by the code), what was asked, Asked → Works on it → Answered; and **An answer for you** with the answer's words (the call's
 * answer, read back) and Listen. The team leader answers an ask that is theirs with On my way / Solved. No chat (pick C).
 */

export interface AskCardModel {
  readonly ask: CallFlag | null
  readonly answer: { readonly words: string; readonly at: string } | null
  /** The person answers calls (the team leader): only a team leader's ask, never the designer's. */
  readonly answers: boolean
  readonly pending: { readonly ticks: TickState } | null
  readonly speech: string
  readonly timeZone?: string
}

export function AskCardView({ model, onAnswer }: { model: AskCardModel; onAnswer: (step: 'ON_THE_WAY' | 'SOLVED') => void }) {
  const t = useT('floor-help2')
  const ds = useDsWords()
  const locale = useLocale()
  const { ask, answer } = model
  const stateKey = ask ? askStateKey(ask) : null
  const to = ask && isAskCode(ask.typeCode) ? askTo(ask.typeCode) : null
  const theirs = Boolean(ask) && model.answers && to === 'TEAM_LEADER' && stateKey !== 'ask.state.answered'
  const buttons = theirs && ask ? leaderButtons(ask) : []
  if (!(ask && stateKey) && !answer) return null
  return (
    <>
      {ask && stateKey && stateKey !== 'ask.state.answered' ? (
        <section className="fw-h2-card" data-tone="info" aria-label={t('ask.cardLabel')}>
          <div className="fw-h2-card-head">
            <span className="fw-h2-card-icon" data-tone="info" aria-hidden>
              {askIcon(ask.typeCode)}
            </span>
            <div className="fw-h2-card-text">
              <p className="fw-h2-card-title">{isAskCode(ask.typeCode) ? t(`ask.code.${ask.typeCode}`) : t('ask.cardLabel')}</p>
              <div className="fw-h2-chips">
                {to ? (
                  <span className="fw-h2-chip" data-tone="primary">
                    {askToIcon(to)}
                    {t(`ask.to.${to}`)}
                  </span>
                ) : null}
                <span className="fw-h2-chip" data-tone={stateKey === 'ask.state.asked' ? 'warning' : 'info'}>
                  {stateKey === 'ask.state.asked' ? <Hourglass aria-hidden /> : <UserCheck aria-hidden />}
                  {t(stateKey)}
                </span>
                <span className="fw-h2-minutes">{t('card.minutes', { count: ask.minutes })}</span>
              </div>
            </div>
          </div>
          {buttons.length > 0 ? (
            <div className="fw-h2-actions" role="group" aria-label={t('card.answer')}>
              {buttons.includes('ON_THE_WAY') ? (
                <FloorButton variant="primary" icon={<UserCheck />} heldReason={model.pending ? t('card.pending') : null} onClick={() => onAnswer('ON_THE_WAY')}>
                  {t('card.onMyWay')}
                </FloorButton>
              ) : null}
              <FloorButton variant="success" icon={<Check />} heldReason={model.pending ? t('card.pending') : null} onClick={() => onAnswer('SOLVED')}>
                {t('ask.answered')}
              </FloorButton>
            </div>
          ) : null}
          {model.pending ? (
            <p className="fw-h2-ticks">
              <Ticks state={model.pending.ticks} />
            </p>
          ) : null}
        </section>
      ) : null}
      {answer ? (
        <section className="fw-h2-card" data-tone="success" aria-label={t('answer.title')}>
          <div className="fw-h2-card-head">
            <span className="fw-h2-card-icon" data-tone="success" aria-hidden>
              <MessageSquareText />
            </span>
            <div className="fw-h2-card-text">
              <p className="fw-h2-card-title">
                <CheckCheck aria-hidden className="fw-floor-inline-icon" /> {t('answer.title')}
              </p>
              {/* The answer as the office wrote it: never translated, never changed. */}
              <p className="fw-h2-card-words">{answer.words}</p>
              <p className="fw-floor-muted">{formatDateTime(answer.at, { locale, timeZone: model.timeZone })}</p>
            </div>
          </div>
          <ReadAloudButton text={answer.words} lang={model.speech} labels={ds.readAloud} />
        </section>
      ) : null}
    </>
  )
}
