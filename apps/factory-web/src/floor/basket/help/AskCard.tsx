'use client'

import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useFloor } from '../../FloorApp'
import type { CardProps } from './ProblemCard'
import { usePendingAnswer } from './ProblemCard'
import { answersCalls } from './model'
import { AskCardView } from './view/AskCardView'

/**
 * owb-fl8 step 2 — the container of the ask card: the open ask with who answers, and "An answer for you" (fl1's `flags.answer`: the
 * call's answer words). The team leader's On my way / Answered on a team leader's ask go through the phone's queue.
 */
export function AskCard({ read, onChanged }: CardProps) {
  const { me, locale } = useFloor()
  const { pending, answer } = usePendingAnswer(onChanged)
  const ask = read.flags.ask
  if (!ask && !read.flags.answer) return null
  return (
    <AskCardView
      model={{ ask, answer: read.flags.answer, answers: answersCalls(me?.permissions ?? []), pending: pending ? { ticks: pending.ticks } : null, speech: me?.speech?.lang ?? INTL_LOCALE[locale] }}
      onAnswer={(step) => (ask ? void answer(ask.callId, step) : undefined)}
    />
  )
}
