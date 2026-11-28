'use client'

import { Check } from 'lucide-react'
import { routeStepsOf, type Department } from '../model'
import { useDepartmentWords } from '../words'
import { DeptChip } from './DeptChip'
import '../department.css'

export interface DeptBarProps {
  /** The route: its departments in the route's order (a department may come twice). */
  readonly route: readonly Department[]
  /** The index of the step it is at (drawn strong); null: not started; at or past the end: every step done. */
  readonly current: number | null
}

/**
 * owb-b4 w4.2 (design § 5u–5z: the route of a line; the order's department bar) — a route as department chips in its order: a step left
 * behind is quiet with a check, the current one is strong (a ring, bold, `aria-current="step"`), a step to come is plain. Never colour
 * alone: the check, the ring and the words each step reads ("done", "here now", "to come") say it. An ordered list, so a screen reader
 * counts the steps. It wraps in a narrow room; nothing in it is a control.
 */
export function DeptBar({ route, current }: DeptBarProps) {
  const t = useDepartmentWords()
  const steps = routeStepsOf(route, current)
  return (
    <ol className="fw-dept-bar" aria-label={t('bar.label', { count: steps.length })}>
      {steps.map(({ dept, state }, index) => (
        <li key={`${index}:${dept.no}`} className="fw-dept-step" data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
          {state === 'done' ? <Check className="fw-dept-done" aria-hidden /> : null}
          <DeptChip dept={dept} />
          <span className="nds-vh">{t(`bar.${state}`)}</span>
        </li>
      ))}
    </ol>
  )
}
