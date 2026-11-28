'use client'

import { Check, UserCheck } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import { Ticks } from '../../tasks/shared/view/TaskParts'
import { leaderButtons } from './model'
import { usePendingAnswer } from './ProblemCard'
import './help2.css'

/**
 * owb-fl8 step 1 — the team leader's answer to a call that waits for them (design § 5zf C "They wait for you": **On my way** →
 * **Solved**; P/fplus.js fCallCards), for any list that holds a call (fl6's leader home may mount it). Queued: works with no network.
 */
export interface CallAnswerButtonsProps {
  readonly callId: string
  /** Today's HelpCall status. */
  readonly state: string
  readonly escalated?: boolean
  readonly onChanged?: () => void
}

export function CallAnswerButtons({ callId, state, escalated = false, onChanged }: CallAnswerButtonsProps) {
  const t = useT('floor-help2')
  const { pending, answer } = usePendingAnswer(onChanged)
  const buttons = leaderButtons({ state, escalated })
  if (buttons.length === 0) return null
  return (
    <div className="fw-h2-actions" role="group" aria-label={t('card.answer')}>
      {buttons.includes('ON_THE_WAY') ? (
        <FloorButton variant="primary" icon={<UserCheck />} heldReason={pending ? t('card.pending') : null} onClick={() => void answer(callId, 'ON_THE_WAY')}>
          {t('card.onMyWay')}
        </FloorButton>
      ) : null}
      <FloorButton variant="success" icon={<Check />} heldReason={pending ? t('card.pending') : null} onClick={() => void answer(callId, 'SOLVED')}>
        {t('card.solved')}
      </FloorButton>
      {pending ? (
        <p className="fw-h2-ticks">
          <Ticks state={pending.ticks} />
        </p>
      ) : null}
    </div>
  )
}
