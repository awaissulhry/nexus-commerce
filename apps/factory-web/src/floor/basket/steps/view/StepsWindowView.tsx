'use client'

import { Check, CircleAlert, ListChecks, Lock, MapPin, Package, Route, Undo2, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import type { Department } from '../../../../lib/department/model'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { BASKET_NS, Flag, StateFlag, StepName } from '../../parts'
import { RouteEditorFoot, RouteEditorView, type RouteEditorAction, type RouteEditorModel } from '../../route/view/RouteEditorView'
import { BACK_WHY, READY_KEY, type BackWhy, type Choice, type ManyRow, type StepRow } from '../model'
import '../../basket.css'

/**
 * owb-fl6 step 1 (design § 5zg A "Change the step"; P/fsteps.js fstepsModal) — the Steps window, a centred window that is a sheet on a
 * phone: one row per step of the route and "Ready to ship"; a done step is ticked (and says Back), the step it is at says "It is here",
 * the next "Next". A tap on a step puts the basket there: no "Are you sure?". A move back asks one thing: why (Work again · Moved by
 * mistake · Other). A worker reads "Only the team leader moves a basket back." and "Only the team leader changes the route."; a team
 * leader has "Change the route" in the foot. Many baskets (Change all on an order): Which baskets? All · the ones at one step · Choose
 * (tick them), then a tap on a department. View only.
 */

export interface StepsWindowModel {
  readonly open: boolean
  readonly title: string
  readonly state: 'loading' | 'ready' | 'failed'
  readonly mode: 'steps' | 'why' | 'route' | 'done'
  /** One basket: its rows; off its route: said above them. */
  readonly one: { readonly rows: readonly StepRow[]; readonly offRoute: boolean } | null
  /** Many baskets: the rows (departments + Ready to ship), the baskets and the choice. */
  readonly many: {
    readonly rows: readonly ManyRow[]
    readonly baskets: readonly { readonly bundleId: string; readonly code: string; readonly here: Department | null; readonly chosen: boolean }[]
    readonly choice: Choice
    readonly at: readonly { readonly id: string; readonly dept: Department | null; readonly count: number }[]
    readonly chosen: number
  } | null
  readonly leader: boolean
  /** Something is still to come: the leader may change the route. */
  readonly canRoute: boolean
  /** Where a move back goes (the why screen). */
  readonly whyTo: { readonly dept: Department | null; readonly ready: boolean; readonly name: string } | null
  readonly route: RouteEditorModel | null
  /** A refusal or a result, in words. */
  readonly said: string | null
  /** The result screen's lines (after a move of many with some staying, a route saved with a warning). */
  readonly done: readonly string[]
  readonly busy: boolean
}

export type StepsWindowAction =
  | { readonly type: 'close' }
  | { readonly type: 'row'; readonly key: string }
  | { readonly type: 'why'; readonly why: BackWhy }
  | { readonly type: 'whyBack' }
  | { readonly type: 'choice'; readonly choice: Choice }
  | { readonly type: 'tick'; readonly bundleId: string }
  | { readonly type: 'route' }
  | { readonly type: 'retry' }
  | { readonly type: 'edit'; readonly action: RouteEditorAction }

export function StepsWindowView({ model, onAction }: { readonly model: StepsWindowModel; readonly onAction: (action: StepsWindowAction) => void }) {
  return (
    <Modal open={model.open} onClose={() => onAction({ type: 'close' })} title={model.title} size="md" sheet className="fw-floor-dialog" footer={<StepsFoot model={model} onAction={onAction} />}>
      <StepsBody model={model} onAction={onAction} />
    </Modal>
  )
}

/** The window's foot (it never scrolls away): a leader's Change the route; a worker's words; the route editor's Back and Save. */
export function StepsFoot({ model, onAction }: { readonly model: StepsWindowModel; readonly onAction: (action: StepsWindowAction) => void }) {
  const tb = useT(BASKET_NS)
  if (model.state !== 'ready') return null
  if (model.mode === 'route' && model.route) return <RouteEditorFoot model={model.route} onAction={(action) => onAction({ type: 'edit', action })} />
  if (model.mode === 'done') {
    return (
      <div className="fw-bk-foot is-one">
        <FloorButton size="lg" variant="primary" icon={<Check />} onClick={() => onAction({ type: 'close' })}>
          {tb('steps.close')}
        </FloorButton>
      </div>
    )
  }
  if (model.mode !== 'steps') return null
  if (!model.leader) {
    return (
      <p className="fw-bk-muted">
        <Lock aria-hidden="true" /> {tb('steps.leaderRoute')}
      </p>
    )
  }
  return model.canRoute ? (
    <div className="fw-bk-foot is-one">
      <FloorButton size="lg" variant="secondary" icon={<Route />} onClick={() => onAction({ type: 'route' })}>
        {tb('route.title')}
      </FloorButton>
    </div>
  ) : null
}

/** The window's body: the rows (one basket or many), the why of a move back, the route editor, a result. */
export function StepsBody({ model, onAction }: { readonly model: StepsWindowModel; readonly onAction: (action: StepsWindowAction) => void }) {
  const tb = useT(BASKET_NS)
  return (
    <div className="fw-bk-steps">
      {model.state === 'loading' ? (
        <p className="fw-bk-muted" aria-busy="true">
          {tb('steps.loading')}
        </p>
      ) : null}
      {model.state === 'failed' ? (
        <p role="alert" className="fw-floor-notice" data-tone="danger">
          {tb('steps.failed')}{' '}
          <FloorButton size="md" variant="secondary" onClick={() => onAction({ type: 'retry' })}>
            {tb('page.retry')}
          </FloorButton>
        </p>
      ) : null}
      {model.said ? (
        <p role="status" className="fw-floor-notice" data-tone="warning">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <CircleAlert />
          </span>
          <bdi>{model.said}</bdi>
        </p>
      ) : null}
      {model.state === 'ready' && model.mode === 'steps' && model.one ? <OneRows model={model} rows={model.one.rows} offRoute={model.one.offRoute} onAction={onAction} /> : null}
      {model.state === 'ready' && model.mode === 'steps' && model.many ? <ManyRows many={model.many} busy={model.busy} onAction={onAction} /> : null}
      {model.state === 'ready' && model.mode === 'why' && model.whyTo ? <WhyBack to={model.whyTo} busy={model.busy} onAction={onAction} /> : null}
      {model.state === 'ready' && model.mode === 'route' && model.route ? <RouteEditorView model={model.route} onAction={(action) => onAction({ type: 'edit', action })} /> : null}
      {model.mode === 'done'
        ? model.done.map((line) => (
            <p key={line} className="fw-floor-dialog-line">
              <bdi>{line}</bdi>
            </p>
          ))
        : null}
    </div>
  )
}

function StepWords({ dept, name, ready }: { readonly dept: Department | null; readonly name: string; readonly ready: boolean }) {
  return ready ? <StateFlag state="READY" /> : <StepName dept={dept} name={name} />
}

function OneRows({ model, rows, offRoute, onAction }: { readonly model: StepsWindowModel; readonly rows: readonly StepRow[]; readonly offRoute: boolean; readonly onAction: (action: StepsWindowAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = model.busy ? tb('homePage.loading') : null
  return (
    <>
      {offRoute ? (
        <p className="fw-floor-notice" data-tone="warning">
          {tb('stepBar.offRoute')}
        </p>
      ) : null}
      <p className="fw-floor-dialog-line fw-floor-muted">{tb('steps.tapStep')}</p>
      <ul className="fw-bk-srows">
        {rows.map((row) => {
          const ready = row.key === READY_KEY
          if (row.state === 'here') {
            return (
              <li key={row.key} className="fw-bk-srow-now" aria-current="step">
                <StepWords dept={row.dept} name={row.name} ready={ready} />
                <span className="fw-bk-srow-end">
                  <Flag tone="primary" icon={<MapPin />}>
                    {tb('steps.itIsHere')}
                  </Flag>
                </span>
              </li>
            )
          }
          return (
            <li key={row.key}>
              <FloorButton size="md" variant="secondary" className="fw-bk-srow" data-state={row.state} icon={row.state === 'done' ? <Check /> : ready ? <Package /> : undefined} heldReason={held} onClick={() => onAction({ type: 'row', key: row.key })}>
                <StepWords dept={row.dept} name={row.name} ready={ready} />
                <span className="fw-bk-srow-end">
                  {row.state === 'next' ? <Flag tone="info" icon={<Check />}>{tb('steps.next')}</Flag> : null}
                  {row.state === 'done' ? <Flag tone="neutral" icon={<Undo2 className="fw-bk-mirror" />}>{tb('steps.goesBack')}</Flag> : null}
                </span>
              </FloorButton>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function ManyRows({ many, busy, onAction }: { readonly many: NonNullable<StepsWindowModel['many']>; readonly busy: boolean; readonly onAction: (action: StepsWindowAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = busy ? tb('homePage.loading') : many.chosen === 0 ? tb('steps.pickFirst') : null
  const choice = many.choice
  return (
    <>
      <p className="fw-floor-dialog-line">{tb('steps.whichBaskets')}</p>
      <div className="fw-bk-choice" role="group" aria-label={tb('steps.whichBaskets')}>
        <FloorButton size="md" variant={choice.mode === 'all' ? 'primary' : 'secondary'} aria-pressed={choice.mode === 'all'} onClick={() => onAction({ type: 'choice', choice: { mode: 'all' } })}>
          {tb('steps.all', { count: many.baskets.length })}
        </FloorButton>
        {many.at.length > 1
          ? many.at.map((at) => (
              <FloorButton key={at.id} size="md" variant={choice.mode === 'at' && choice.departmentId === at.id ? 'primary' : 'secondary'} aria-pressed={choice.mode === 'at' && choice.departmentId === at.id} onClick={() => onAction({ type: 'choice', choice: { mode: 'at', departmentId: at.id } })}>
                {at.dept ? <DeptChip dept={at.dept} /> : null}
                <bdi>{at.count}</bdi>
              </FloorButton>
            ))
          : null}
        <FloorButton size="md" variant={choice.mode === 'chosen' ? 'primary' : 'secondary'} aria-pressed={choice.mode === 'chosen'} icon={<ListChecks />} onClick={() => onAction({ type: 'choice', choice: { mode: 'chosen', ids: choice.mode === 'chosen' ? choice.ids : [] } })}>
          {tb('steps.choose')}
        </FloorButton>
      </div>
      {choice.mode === 'chosen' ? (
        <div className="fw-bk-people" role="group" aria-label={tb('steps.choose')}>
          {many.baskets.map((basket) => (
            <FloorButton key={basket.bundleId} size="md" variant={basket.chosen ? 'primary' : 'secondary'} aria-pressed={basket.chosen} icon={basket.chosen ? <Check /> : <X />} onClick={() => onAction({ type: 'tick', bundleId: basket.bundleId })}>
              <bdi className="fw-bk-code">{basket.code}</bdi>
              {basket.here ? <DeptChip dept={basket.here} /> : <StateFlag state="READY" />}
            </FloorButton>
          ))}
        </div>
      ) : null}
      <p className="fw-floor-dialog-line fw-floor-muted">{many.chosen > 0 ? tb('steps.tapStepMany') : tb('steps.pickFirst')}</p>
      <ul className="fw-bk-srows">
        {many.rows.map((row) => {
          const ready = row.key === READY_KEY
          return (
            <li key={row.key}>
              <FloorButton size="md" variant="secondary" className="fw-bk-srow" icon={ready ? <Package /> : undefined} heldReason={held} onClick={() => onAction({ type: 'row', key: row.key })}>
                <StepWords dept={row.dept} name={row.name} ready={ready} />
                {row.here > 0 ? (
                  <span className="fw-bk-srow-end">
                    <Flag tone="neutral" icon={<MapPin />}>
                      {tb('steps.hereCount', { count: row.here })}
                    </Flag>
                  </span>
                ) : null}
              </FloorButton>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function WhyBack({ to, busy, onAction }: { readonly to: NonNullable<StepsWindowModel['whyTo']>; readonly busy: boolean; readonly onAction: (action: StepsWindowAction) => void }) {
  const tb = useT(BASKET_NS)
  const held = busy ? tb('homePage.loading') : null
  return (
    <>
      <div className="fw-bk-needs" data-tone="warning">
        <Undo2 className="fw-bk-mirror" aria-hidden="true" />
        <div className="fw-bk-needs-text">
          <span className="fw-bk-needs-title">{tb('steps.whyBack')}</span>
          <StepWords dept={to.dept} name={to.name} ready={to.ready} />
        </div>
      </div>
      <div className="fw-bk-why" role="group" aria-label={tb('steps.whyBack')}>
        {BACK_WHY.map((why) => (
          <FloorButton key={why} size="lg" variant="secondary" heldReason={held} onClick={() => onAction({ type: 'why', why })}>
            {tb(`steps.why.${why}`)}
          </FloorButton>
        ))}
      </div>
      <FloorButton size="md" variant="quiet" icon={<Undo2 className="fw-bk-mirror" />} onClick={() => onAction({ type: 'whyBack' })}>
        {tb('route.back')}
      </FloorButton>
    </>
  )
}
