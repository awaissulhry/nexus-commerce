'use client'

import { ArrowRight, ChevronRight, Route } from 'lucide-react'
import { departmentToneClass } from '../../../../lib/department/model'
import { useT } from '../../../../lib/i18n/provider'
import type { StepBarModel } from '../../model'
import { BASKET_NS, Flag, StateFlag, StepName } from '../../parts'
import '../../../../lib/department/department.css'
import '../../basket.css'

/**
 * owb-fl5 step 2 (design § 5zg "ONE way": 1. the step bar; P/fsteps.js stepBar) — on every basket, on the first screen: "Step 3 / 6",
 * a line of the route's steps in their department colours ("Ready to ship" is the small round mark at its end), "3 Patch & print →
 * 4 Stitching", "Own route" after a change, and the word Change. The whole bar is ONE button that opens the Steps window (fl6); until
 * that window is built (`onChange` absent) the bar only shows and says no "Change" (never a dead button). Never colour alone: the
 * number, the icon and the name say each step; the segments are a picture of the same words. The arrow and the chevron carry
 * `fw-bk-mirror` (they turn right to left in Urdu, fl7); the digits never do.
 */
export function StepBar({ bar, code, onChange }: { readonly bar: StepBarModel; readonly code: string; readonly onChange?: (() => void) | null }) {
  const tb = useT(BASKET_NS)
  const body = (
    <>
      <span className="fw-bk-sb-top">
        <span>{bar.at !== null ? <bdi>{tb('stepBar.step', { at: bar.at, total: bar.total })}</bdi> : tb('stepBar.ready')}</span>
        {bar.own ? (
          <Flag tone="warning" icon={<Route />}>
            {tb('stepBar.own')}
          </Flag>
        ) : null}
        {onChange ? (
          <span className="fw-bk-sb-go">
            {tb('stepBar.change')}
            <ChevronRight className="fw-bk-mirror" aria-hidden="true" />
          </span>
        ) : null}
      </span>
      <span className="fw-bk-seg" aria-hidden="true">
        {bar.steps.map((step) => (
          <span key={step.key} className={step.dept ? departmentToneClass(step.dept.tone) : undefined} data-state={step.state} />
        ))}
        <span className="is-end" data-state={bar.ready ? 'HERE' : 'TODO'} />
      </span>
      <span className="fw-bk-sb-now">
        {bar.now ? <StepName dept={bar.now.dept} name={bar.now.name} /> : <StateFlag state="READY" />}
        {bar.now ? (
          <span className="fw-bk-sb-next">
            <ArrowRight className="fw-bk-mirror" aria-hidden="true" />
            {bar.next ? <StepName dept={bar.next.dept} name={bar.next.name} /> : <StateFlag state="READY" />}
          </span>
        ) : null}
      </span>
    </>
  )
  return onChange ? (
    <button type="button" className="fw-bk-stepbar" onClick={onChange} title={tb('stepBar.changeLabel', { code })}>
      {body}
    </button>
  ) : (
    <div className="fw-bk-stepbar" role="group" aria-label={tb('stepBar.label', { count: bar.total })}>
      {body}
    </div>
  )
}
