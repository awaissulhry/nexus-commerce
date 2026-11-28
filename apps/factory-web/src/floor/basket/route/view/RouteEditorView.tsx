'use client'

import { Check, CircleAlert, Lock, Plus, RotateCcw, Undo2, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import type { Department } from '../../../../lib/department/model'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { useT } from '../../../../lib/i18n/provider'
import { BASKET_NS, Flag, StepName } from '../../parts'
import { ROUTE_WHY, type RouteDraft, type RouteView, type RouteWhy } from '../../steps/model'
import '../../basket.css'

/**
 * owb-fl6 step 2 (design § 5zg B "Change the route — on the floor, by the team leader"; P/fsteps.js fsEditModal) — inside the Steps
 * window: Why? (one tap, above the list so a 360 × 780 phone shows it) · for whom (Only this basket · All baskets of the order · the
 * chosen ones) · what is still to come (Skip: grey and struck through; Put back) · Add a step (pick a department; it goes before the last)
 * · the last step, locked · Back to the normal route (an own route). Back and Save the route stand in the window's foot (they never
 * scroll away): `RouteEditorFoot`. A route with no quality check left is warned after Save, never stopped. View only.
 */

export interface RouteEditorModel {
  readonly view: RouteView
  readonly draft: RouteDraft
  /** The "for whom" choices offered (one basket alone offers none). */
  readonly scopes: readonly RouteDraft['scope'][]
  /** How many baskets were chosen (Change all). */
  readonly chosen: number
  readonly addOpen: boolean
  /** The departments a step may be added from (open ones). */
  readonly departments: readonly Department[]
  /** Names of the added departments, in the draft's order. */
  readonly added: readonly (Department | null)[]
  /** The route was changed before (own route): "Back to the normal route" is offered. */
  readonly own: boolean
  readonly busy: boolean
}

export type RouteEditorAction =
  | { readonly type: 'turn'; readonly operationId: string }
  | { readonly type: 'addOpen' }
  | { readonly type: 'add'; readonly departmentId: string }
  | { readonly type: 'takeOut'; readonly index: number }
  | { readonly type: 'why'; readonly why: RouteWhy }
  | { readonly type: 'scope'; readonly scope: RouteDraft['scope'] }
  | { readonly type: 'normal' }
  | { readonly type: 'save' }
  | { readonly type: 'back' }

export function RouteEditorView({ model, onAction }: { readonly model: RouteEditorModel; readonly onAction: (action: RouteEditorAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = model.busy ? tb('homePage.loading') : null
  return (
    <div className="fw-bk-steps">
      {model.scopes.length > 1 ? (
        <div className="fw-bk-choice" role="group" aria-label={tb('route.forWhom')}>
          {model.scopes.map((scope) => (
            <FloorButton key={scope} size="md" variant={model.draft.scope === scope ? 'primary' : 'secondary'} aria-pressed={model.draft.scope === scope} onClick={() => onAction({ type: 'scope', scope })}>
              {scope === 'one' ? tb('route.onlyThis') : scope === 'order' ? tb('route.allOfOrder') : tb('route.chosen', { count: model.chosen })}
            </FloorButton>
          ))}
        </div>
      ) : null}
      {model.own ? (
        <div className="fw-bk-needs" data-tone="warning">
          <RotateCcw aria-hidden="true" />
          <div className="fw-bk-needs-text">
            <span className="fw-bk-needs-title">{tb('route.own')}</span>
            <FloorButton size="md" variant="secondary" icon={<Undo2 className="fw-bk-mirror" />} heldReason={held} onClick={() => onAction({ type: 'normal' })}>
              {tb('route.normalBack')}
            </FloorButton>
          </div>
        </div>
      ) : null}
      <p className="fw-floor-dialog-line">{tb('route.whyRoute')}</p>
      <div className="fw-bk-why" role="group" aria-label={tb('route.whyRoute')}>
        {ROUTE_WHY.map((why) => (
          <FloorButton key={why} size="md" variant={model.draft.why === why ? 'primary' : 'secondary'} aria-pressed={model.draft.why === why} icon={model.draft.why === why ? <Check /> : undefined} onClick={() => onAction({ type: 'why', why })}>
            {tb(`route.why.${why}`)}
          </FloorButton>
        ))}
      </div>
      <p className="fw-floor-dialog-line">{tb('route.stepsFor')}</p>
      <ul className="fw-bk-srows">
        {model.view.ahead.map((step) => (
          <li key={step.operationId} className="fw-bk-rrow" data-skipped={step.skipped}>
            <span className="fw-bk-rrow-name">
              <StepName dept={step.dept} name={step.name} />
              {step.added ? (
                <Flag tone="success" icon={<Plus />}>
                  {tb('route.newStep')}
                </Flag>
              ) : null}
            </span>
            <FloorButton size="md" variant={step.skipped ? 'secondary' : 'danger'} aria-pressed={step.skipped} icon={step.skipped ? <Undo2 className="fw-bk-mirror" /> : <X />} onClick={() => onAction({ type: 'turn', operationId: step.operationId })}>
              {step.skipped ? tb('route.putBack') : tb('route.skip')}
            </FloorButton>
          </li>
        ))}
        {model.added.map((dept, index) => (
          <li key={`add-${index}`} className="fw-bk-rrow">
            <span className="fw-bk-rrow-name">
              {dept ? <DeptChip dept={dept} /> : null}
              <Flag tone="success" icon={<Plus />}>
                {tb('route.newStep')}
              </Flag>
            </span>
            <FloorButton size="md" variant="quiet" icon={<X />} aria-label={tb('route.takeOut')} onClick={() => onAction({ type: 'takeOut', index })} />
          </li>
        ))}
        {model.view.last ? (
          <li className="fw-bk-rrow">
            <span className="fw-bk-rrow-name">
              <StepName dept={model.view.last.dept} name={model.view.last.name} />
            </span>
            <Flag tone="neutral" icon={<Lock />}>
              {tb('route.lastStep')}
            </Flag>
          </li>
        ) : null}
      </ul>
      {model.addOpen ? (
        <>
          <p className="fw-bk-muted">
            <CircleAlert aria-hidden="true" /> {tb('route.addNote')}
          </p>
          <div className="fw-bk-picks" role="group" aria-label={tb('route.addStep')}>
            {model.departments.map((dept) => (
              <FloorButton key={dept.id ?? dept.no} size="md" variant="secondary" aria-label={dept.name} onClick={() => (dept.id ? onAction({ type: 'add', departmentId: dept.id }) : undefined)}>
                <DeptChip dept={dept} />
              </FloorButton>
            ))}
          </div>
        </>
      ) : (
        <FloorButton size="md" variant="secondary" block icon={<Plus />} onClick={() => onAction({ type: 'addOpen' })}>
          {tb('route.addStep')}
        </FloorButton>
      )}
    </div>
  )
}

/** Back and Save the route: the window's foot, in view whatever the list's length. Save waits for a change and a reason (said on screen). */
export function RouteEditorFoot({ model, onAction }: { readonly model: RouteEditorModel; readonly onAction: (action: RouteEditorAction) => void }) {
  const tb = useT(BASKET_NS)
  const waits = model.busy ? tb('homePage.loading') : !model.view.changed ? tb('route.changeFirst') : !model.draft.why ? tb('route.whyFirst') : null
  return (
    <div className="fw-bk-stack">
      {waits && !model.busy ? <p className="fw-bk-dock-note">{waits}</p> : null}
      <div className="fw-bk-foot">
        <FloorButton size="lg" variant="secondary" icon={<Undo2 className="fw-bk-mirror" />} onClick={() => onAction({ type: 'back' })}>
          {tb('route.back')}
        </FloorButton>
        <FloorButton size="lg" variant="success" icon={<Check />} heldReason={waits} onClick={() => onAction({ type: 'save' })}>
          {tb('route.save')}
        </FloorButton>
      </div>
    </div>
  )
}
