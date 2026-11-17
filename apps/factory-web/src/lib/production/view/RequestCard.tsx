'use client'

import type { ReactNode } from 'react'
import { Card, ChangeReview, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { requestView, type Face, type RequestInput } from '../model'
import { useProductionWords } from '../words'
import { WaitingOnPill } from './WaitingOnPill'
import '../production-parts.css'

export interface RequestCardProps {
  face: Face
  request: RequestInput
  /** The one action the reader may take (Withdraw, Accept the counter, Answer in Approvals), held with its reason by the caller. */
  action?: ReactNode
  /** The clock the wait counts from (ms). */
  now?: number
}

/**
 * F-PR-01 — one customer request, the same card in the office and the portal (09-design §1.6; it extends the portal's
 * Requests card of today, which mounts it in F-PR-12a). Reading order: kind and state (office "Waiting on us · 4 h", the
 * customer "Being reviewed" — only true states), who asked and when, what changes old → new (DS ChangeReview without
 * ticks: they go together), the customer's words, the impact before Send (what is fixed, the earliest date best / likely /
 * worst, price only to a price role — never a capacity figure), our answer, and the one action. A request names only the
 * customer's own lines.
 */
export function RequestCard({ face, request, action, now }: RequestCardProps) {
  const w = useProductionWords()
  const clock = now ?? Date.now()
  const view = requestView(face, request, clock, w.day(request.askedAt))
  const kind = w.say(view.kind)
  const impact = request.impact
  const impactItems: KeyValueItem[] = []
  if (impact) {
    // What is fixed only when the read says so: an empty list is "Nothing is fixed yet", no list says nothing.
    if (impact.frozen) impactItems.push({ label: w.t('parts.request.frozen'), value: impact.frozen.length > 0 ? impact.frozen.join(' · ') : w.t('parts.request.nothingFrozen') })
    if (impact.earliest) {
      const { best, likely, worst } = impact.earliest
      impactItems.push({
        label: w.t('parts.request.earliest'),
        value: likely && worst ? w.t('parts.request.earliestRange', { best: w.day(best), likely: w.day(likely), worst: w.day(worst) }) : w.day(best),
      })
    }
    if (impact.price) {
      impactItems.push({
        label: w.t('parts.request.price'),
        value: impact.price === 'PRICED' && impact.priceText ? impact.priceText : w.t(impact.price === 'NONE' ? 'parts.request.priceNone' : 'parts.request.priceMay'),
      })
    }
  }
  const answer = request.answer
  return (
    <Card padded className="fw-prp-request" aria-label={w.t('parts.request.label', { kind })}>
      <div className="fw-prp-request-body">
        <div className="fw-prp-request-head">
          <strong>{kind}</strong>
          {view.waiting ? <WaitingOnPill face="office" who="US" since={request.askedAt} kind="request" now={clock} /> : <Pill tone={view.tone}>{w.say(view.state)}</Pill>}
          <span className="fw-prp-sub">{w.say(view.asked)}</span>
        </div>
        {request.changes && request.changes.length > 0 ? (
          <ChangeReview
            label={w.t('parts.request.changes', { kind })}
            tick={false}
            selectedIds={[]}
            onSelectionChange={() => undefined}
            items={request.changes.map((change) => ({
              id: change.id,
              label: change.label,
              status: '',
              note: '',
              selectable: false,
              values: [
                { label: w.t('parts.request.was'), value: change.from },
                { label: w.t('parts.request.wanted'), value: change.to },
              ],
            }))}
          />
        ) : null}
        {request.note ? <p className="fw-prp-quote">{w.t(face === 'customer' ? 'parts.request.yourNote' : 'parts.request.theirNote', { note: request.note })}</p> : null}
        {impactItems.length > 0 ? (
          <div className="fw-prp-impact">
            <span className="fw-prp-label">{w.t('parts.request.impact')}</span>
            <KeyValue items={impactItems} columns={impactItems.length >= 3 ? 3 : impactItems.length === 2 ? 2 : 1} labelCase="sentence" dense />
          </div>
        ) : null}
        {answer ? (
          <p className="fw-prp-answer">
            {face === 'office' && answer.by
              ? w.t(answer.words ? 'parts.request.answerBy' : 'parts.request.answeredBy', { name: answer.by, date: w.day(answer.at), words: answer.words ?? '' })
              : w.t(answer.words ? 'parts.request.answer' : 'parts.request.answered', { date: w.day(answer.at), words: answer.words ?? '' })}
          </p>
        ) : null}
        {action ? <div className="fw-prp-request-action">{action}</div> : null}
      </div>
    </Card>
  )
}
