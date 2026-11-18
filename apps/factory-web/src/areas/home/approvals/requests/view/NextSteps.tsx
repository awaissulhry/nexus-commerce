'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Check, ExternalLink, Play } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { useProductionWords } from '../../../../../lib/production/words'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { ApplyPlan, ApplyPlanStep } from '../api'
import {
  CR,
  leftToRun,
  REQUEST_LIMITS,
  said,
  stepStateOf,
  stoppable,
  type ApplyChoices,
  type CommandState,
  type DoneCommand,
  type DoneView,
  type RequestActions,
  type TellTick,
  type WorkChoice,
} from '../model'

/**
 * F-SA-241 (sales page plan P5, P6', R1, R8; 14-change-flow §3.2 items 4 and 6, §3.4; lead picks Round 4) — the review window's
 * "On the floor now", "What happens next" and, after Accept, "Done · What happens next", for every door. Pure drawing of the apply
 * plan (B-SA-045) and the window's choices; every opener is a real link, every command a button held with why.
 *
 *   On the floor now   the order's OWN cells per asked size — ordered · asked · in work orders · cut and bundled · sewn · packed (the
 *                      portal's stage words; "not counted here" for a step a site does not count, never 0) and the API's "In work now:
 *                      3 bundles at Sewing"; without workorders.view "—" and "Needs work-order access"
 *   What happens next  numbered: what the step does, who does it (a team, or the supervisor by name inside the office), its state in
 *                      words; per touched work order with bundles in work Finish what is started (default) / Stop now
 *   Done · What        what the Accept did, then the next steps with their own command ("Stop now", "Change the work order now") or
 *   happens next       their door (the work-order change, the style change, the change order); "Do the next steps" when two or more
 *                      are left; "Tell the customer…" (F-SA-242)
 */

const prefixOf = (pathname: string): string => /^\/w\/[^/]+/.exec(pathname)?.[0] ?? ''

// ---- On the floor now --------------------------------------------------------------------------------------------------------

export function FloorNow({ plan }: { plan: ApplyPlan }) {
  const t = useT('approvals')
  const w = useProductionWords()
  const locale = useLocale()
  const withheld = plan.withheld.includes('floor')
  const floor = plan.floor
  const count = (value: number | null) => (value === null ? w.t('parts.pieces.notCounted') : String(value))
  return (
    <section aria-labelledby={`fw-apv-floor-${plan.request.id}`}>
      <h3 id={`fw-apv-floor-${plan.request.id}`} className="fw-apv-h">
        {t(`${CR}.floor.title`)}
      </h3>
      {withheld || !floor ? (
        <p className="fw-apv-hint">
          <span aria-hidden>—</span> {t(`${CR}.floor.withheld`)}
        </p>
      ) : floor.cells.length === 0 ? (
        <p className="fw-apv-hint">{t(`${CR}.floor.nothing`)}</p>
      ) : (
        <>
          <SummaryTable
            label={t(`${CR}.floor.title`)}
            columns={[t(`${CR}.floor.col.cell`), w.t('parts.pieces.stages.ORDERED'), t(`${CR}.floor.col.asked`), t(`${CR}.floor.col.inWorkOrders`), w.t('parts.pieces.stages.CUT'), w.t('parts.pieces.stages.SEWN'), w.t('parts.pieces.stages.PACKED')]}
            rows={floor.cells.map((cell) => ({
              id: `${cell.lineId}:${cell.size ?? ''}`,
              cells: [
                cell.size === null ? t(`${CR}.floor.wholeLine`, { line: cell.seq }) : t(`${CR}.floor.cell`, { line: cell.seq, size: cell.size }),
                String(cell.ordered),
                cell.asked === null ? '—' : String(cell.asked),
                String(cell.inWorkOrders),
                count(cell.cut),
                count(cell.sewn),
                String(cell.packed),
              ],
            }))}
            align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right']}
            stackOnPhone
          />
          <p className="fw-apv-hint">{[t(`${CR}.floor.own`), floor.inWork.words ? said(floor.inWork.words, locale) : null].filter(Boolean).join(' ')}</p>
          {floor.workOrdersLeftOut > 0 && <p className="fw-apv-hint">{t(`${CR}.floor.leftOut`, { count: floor.workOrdersLeftOut })}</p>}
        </>
      )}
    </section>
  )
}

// ---- What happens next (before Accept, and after it) ----------------------------------------------------------------------------

interface StepDoors {
  /** The request's company (a record's address names it). */
  readonly companyId: string
  /** The order's page (null: the door is the order's own page). */
  readonly orderHref: string | null
  readonly orderNumber: string
}

function stepDoor(step: ApplyPlanStep, doors: StepDoors, prefix: string, say: (key: string, params?: Record<string, string | number>) => string) {
  const ref = step.ref
  if (ref?.type === 'WorkOrderChange') return { href: `${prefix}/home/approvals?open=${encodeURIComponent(ref.id)}`, label: say(`${CR}.next.openChange`) }
  if (ref && (ref.type === 'ChangeRequest' || ref.type === 'ChangeOrder')) return { href: `${prefix}${recordAddress({ type: ref.type, id: ref.id, label: ref.number ?? undefined, companyId: doors.companyId, siteId: null }, OFFICE_PAGES)}`, label: say(`${CR}.next.open`, { number: ref.number ?? '' }) }
  if (step.kind === 'REPROMISE' && doors.orderHref && step.state !== 'DONE') return { href: doors.orderHref, label: say(`${CR}.review.openOrder`, { order: doors.orderNumber }) }
  return null
}

export function NextSteps({
  plan,
  accepted,
  choices,
  offline,
  canHold,
  doors,
  actions,
}: {
  plan: ApplyPlan
  accepted: boolean
  choices: ApplyChoices
  offline: boolean
  /** The reader may stop a work order now (workorders.hold): Stop now is offered, else held with why. */
  canHold: boolean
  doors: StepDoors
  actions?: RequestActions | undefined
}) {
  const t = useT('approvals')
  const locale = useLocale()
  const prefix = prefixOf(usePathname() ?? '')
  if (plan.next.length === 0) return plan.words ? <p className="fw-apv-hint">{said(plan.words, locale)}</p> : null
  return (
    <ol className="fw-apv-steps" aria-label={t(`${CR}.next.title`)}>
      {plan.next.map((step) => {
        const state = stepStateOf(step, accepted)
        const door = accepted ? stepDoor(step, doors, prefix, t) : null
        const offer = !accepted && stoppable(step)
        const workOrder = step.workOrder
        const stopped = workOrder !== null && choices.stops.includes(workOrder.id)
        return (
          <li key={`${step.seq}:${step.kind}`} className="fw-apv-step">
            <span className="fw-apv-step-mark" aria-hidden>
              {step.state === 'DONE' ? <Check size={14} /> : step.seq}
            </span>
            <span className="fw-apv-step-body">
              <span className="fw-apv-step-what">{said(step.words, locale)}</span>
              {step.why && <span className="fw-apv-sub">{said(step.why, locale)}</span>}
              {step.person && <span className="fw-apv-sub">{t(`${CR}.next.who`, { name: step.person.name })}</span>}
              {offer && workOrder && (
                <span className="fw-apv-step-choice">
                  <span className="fw-apv-sub">{t(`${CR}.next.inWork`, { order: workOrder.number, count: step.bundles ?? 0 })}</span>
                  <SegmentedControl
                    size="sm"
                    ariaLabel={t(`${CR}.next.choiceLabel`, { order: workOrder.number })}
                    value={stopped ? 'STOP' : 'FINISH'}
                    onChange={(value) => {
                      // Held, not hidden: without the right to hold work orders Stop now says why and is not taken.
                      if (value === 'STOP' && (!canHold || offline)) return
                      actions?.onWorkChoice?.(workOrder.id, value as WorkChoice)
                    }}
                    options={[
                      { value: 'FINISH', label: t(`${CR}.next.finish`) },
                      { value: 'STOP', label: t(`${CR}.next.stop`), ...(!canHold ? { title: t(`${CR}.next.stopHeld`) } : offline ? { title: t(`${CR}.held.offline`) } : {}) },
                    ]}
                  />
                  {!canHold && <span className="fw-apv-sub">{t(`${CR}.next.stopHeld`)}</span>}
                  {stopped && <span className="fw-apv-sub">{t(`${CR}.next.stopWords`, { count: step.bundles ?? 0 })}</span>}
                </span>
              )}
              {door && (
                <span className="fw-apv-tags">
                  <Button size="sm" variant="link" inline asChild>
                    <Link href={door.href}>
                      <ExternalLink size={12} aria-hidden /> {door.label}
                    </Link>
                  </Button>
                </span>
              )}
            </span>
            <span className="fw-apv-step-state">
              <Pill tone={state.tone}>{t(state.key)}</Pill>
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ---- Done · What happens next ---------------------------------------------------------------------------------------------

const commandHeld = (state: CommandState | undefined, done: DoneView, offline: boolean): string | null => {
  if (state?.phase === 'done') return `${CR}.next.doneAlready`
  if (state?.phase === 'running' || done.running) return `${CR}.held.busy`
  if (offline) return `${CR}.held.offline`
  return null
}

/** The done view's body: what the Accept did (the notice's lines), the commands with their states, the steps, Tell the customer…. */
export function DoneSteps({ plan, done, tell, customer, offline, canHold, doors, actions }: { plan: ApplyPlan | null; done: DoneView; tell: TellTick | undefined; customer: string; offline: boolean; canHold: boolean; doors: StepDoors; actions?: RequestActions | undefined }) {
  const t = useT('approvals')
  const locale = useLocale()
  const left = leftToRun(done.commands, done.states)
  return (
    <section aria-labelledby="fw-apv-done-h" className="fw-apv-review">
      <h3 id="fw-apv-done-h" className="fw-apv-h" tabIndex={-1}>
        {t(`${CR}.done.title`)}
      </h3>
      {(done.notice.lines ?? []).length > 0 && (
        <ul className="fw-apv-list">
          {(done.notice.lines ?? []).map((line, index) => (
            <li key={index}>{said(line, locale)}</li>
          ))}
        </ul>
      )}
      {done.commands.length > 0 && (
        <ul className="fw-apv-steps" aria-label={t(`${CR}.done.commands`)}>
          {done.commands.map((command) => (
            <DoneCommandRow key={command.key} command={command} state={done.states[command.key]} done={done} offline={offline} actions={actions} />
          ))}
        </ul>
      )}
      {left.length >= 2 && (
        <p className="fw-apv-tags">
          <Button size="sm" variant="primary" heldReason={done.running ? t(`${CR}.held.busy`) : offline ? t(`${CR}.held.offline`) : null} onClick={() => !done.running && !offline && actions?.onRunAll?.()}>
            <Play size={14} aria-hidden /> {t(`${CR}.done.runAll`, { count: left.length })}
          </Button>
          <span className="fw-apv-sub">{t(`${CR}.done.runAllHint`)}</span>
        </p>
      )}
      {plan && <NextSteps plan={plan} accepted choices={{ extraOutcome: plan.extra.chosen, stops: [] }} offline={offline} canHold={canHold} doors={doors} actions={actions} />}
      {plan && plan.next.length > 0 && plan.next.every((step) => step.state === 'DONE') && <p className="fw-apv-hint">{t(`${CR}.done.nothingLeft`)}</p>}
      <TellBox tell={tell} customer={customer} offline={offline} actions={actions} />
    </section>
  )
}

function DoneCommandRow({ command, state, done, offline, actions }: { command: DoneCommand; state: CommandState | undefined; done: DoneView; offline: boolean; actions?: RequestActions | undefined }) {
  const t = useT('approvals')
  const locale = useLocale()
  const held = commandHeld(state, done, offline)
  const what = command.kind === 'stop' ? t(`${CR}.done.stop`, { order: command.workOrder.number }) : t(`${CR}.done.apply`, { what: said(command.words, locale) })
  const label = command.kind === 'stop' ? t(`${CR}.next.stop`) : t(`${CR}.next.changeNow`)
  return (
    <li className="fw-apv-step">
      <span className="fw-apv-step-mark" aria-hidden>
        {state?.phase === 'done' ? <Check size={14} /> : '·'}
      </span>
      <span className="fw-apv-step-body">
        <span className="fw-apv-step-what">{what}</span>
        {state?.phase === 'refused' && (
          <span className="fw-apv-sub" role="status">
            {t(state.key, state.params)}
          </span>
        )}
      </span>
      <span className="fw-apv-step-state">
        {state?.phase === 'done' ? (
          <Pill tone="success">{t(`${CR}.next.state.done`)}</Pill>
        ) : (
          <Button size="sm" heldReason={held ? t(held) : null} onClick={() => !held && actions?.onRunStep?.(command.key)}>
            {state?.phase === 'refused' ? t(`${CR}.done.again`) : label}
          </Button>
        )}
      </span>
    </li>
  )
}

// ---- F-SA-242: "Tell the customer…" after Accept (the words written in the order's conversation, the thread's own send) ----

function TellBox({ tell, customer, offline, actions }: { tell: TellTick | undefined; customer: string; offline: boolean; actions?: RequestActions | undefined }) {
  const t = useT('approvals')
  if (!tell) return null
  const sent = tell.sent
  if (tell.compose === null) {
    return (
      <div className="fw-apv-tags">
        {sent === 'sent' && <span className="fw-apv-sub">{t(`${CR}.tell.sent`)}</span>}
        {typeof sent === 'object' && <span className="fw-apv-sub" role="status">{t(sent.refused, { customer })}</span>}
        <Button size="sm" heldReason={tell.reach === 'none' ? t(`${CR}.tell.held.reach`, { customer }) : offline ? t(`${CR}.held.offline`) : null} onClick={() => tell.reach !== 'none' && !offline && actions?.onTellOpen?.()}>
          {t(`${CR}.tell.open`)}
        </Button>
      </div>
    )
  }
  const text = tell.compose
  const held = text.trim() === '' ? `${CR}.tell.held.words` : text.length > REQUEST_LIMITS.answer ? `${CR}.held.long` : offline ? `${CR}.held.offline` : sent === 'sending' ? `${CR}.held.busy` : null
  return (
    <div className="fw-apv-review">
      <p className="fw-apv-h">{t(`${CR}.tell.title`)}</p>
      <Textarea value={text} onChange={(event) => actions?.onTellWords?.(event.target.value)} rows={3} maxLength={REQUEST_LIMITS.answer} aria-label={t(`${CR}.tell.title`)} />
      <p className="fw-apv-hint">{t(`${CR}.tell.hint`)}</p>
      {typeof sent === 'object' && (
        <p className="fw-apv-hint" role="status">
          {t(sent.refused, { customer })}
        </p>
      )}
      <span className="fw-apv-tags">
        <Button size="sm" onClick={() => actions?.onTellClose?.()}>
          {t(`${CR}.back`)}
        </Button>
        <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => !held && actions?.onTellSend?.()}>
          {t(`${CR}.tell.send`)}
        </Button>
      </span>
    </div>
  )
}
