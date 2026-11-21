'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react' // F-SC-W3: the steps' buttons, measured
import NextLink from 'next/link'
import { PauseCircle } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { MilestoneTracker, type MilestonePromise, type MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import { useDsWords } from '../../i18n/ds-parts'
import { stageSteps, type Face, type PlainStage, type StageStripInput } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface StageStripProps extends StageStripInput {
  face: Face
  /** `auto`: across on a wide box, down on a narrow one; `compact`: the one-row form for a list cell or a phone card. */
  layout?: 'auto' | 'compact'
  /** The list's name for a screen reader ("WO-0311 stages"). */
  label?: string
  /**
   * The ex-factory date and how it moved (calendar days), with the curated reason of each move. Office: "Ex-factory 18
   * Nov"; customer: "Expected 18 Nov" — never "promised".
   */
  promise?: { date: string; history?: readonly { on: string; from: string | null; to: string; reason: PromiseReasonCode | null }[] } | null
  loading?: boolean
  /** The stages could not be read: only this part says so, with Try again. */
  problem?: boolean
  onRetry?: () => void
  /**
   * F-OP-104 (10-order-page §3.1): where the stages open (the order page's `?tab=production#work-orders`, built with tabHref): the
   * stages become ONE real link (its focus ring; Enter follows it; ⌘-click opens a new tab). The promise line is then the page's
   * own (a link holds no other control). Production's pages leave it out: their strip stays as it is.
   */
  stageHref?: string | null
  /** The link's name for a screen reader ("Open the work orders in Production · now Sewing"). */
  stageLinkLabel?: string
  /**
   * F-SC-W3 (stage control B, 40-stage-plan §3): the steps a person may pick (the order page's Overview, with the right and the door
   * not held) — each a real <button> over its step, named ("Set the stage of SO-2026-0088 to Sewing…"); a click opens the office's
   * stage dialog on it (`onPick`). With picks the ONE link (stageHref) is not drawn; without them the strip is as before. Never on the
   * row form (`compact`).
   */
  picks?: readonly StageStripPick[] | null
  onPick?: (stage: PlainStage) => void
}

/** F-SC-W3: a step a person may pick, and its button's name for a screen reader. */
export interface StageStripPick {
  readonly stage: PlainStage
  readonly label: string
}

/**
 * F-PR-01 — the five plain stages (plan §4: Preparing · Cutting · Sewing · Quality check · Ready to ship), drawn with the
 * DS MilestoneTracker (its `compact` row form for a list cell or a phone card; the full form across or down by its own
 * width). A blocked stage keeps the tracker's current step and adds a blocked mark with why in words beside it (DS gap G1,
 * plan §8: the tracker has no blocked state; until the Owner's word the mark lives here). Unknown stage: "—", never step
 * 1. Office dates read "Planned"; the customer's "Expected by". Never interactive except the date's history.
 * F-MS-101: a stage set by hand (the office's one named exception) is SHOWN here, never set here: the office card passes the stage the
 * customer reads and the current step's note "Set by hand" (`note`). F-SC-W3 (stage control B): the office card may pass `picks` —
 * then each step but the current one is a button that opens the card's stage dialog (the dialog sets it, this part never does); the
 * card's door "Set the stage by hand…" stays the keyboard and phone path. The portal passes neither: its strip is unchanged.
 */
export function StageStrip({ face, layout = 'auto', label, promise, loading, problem, onRetry, stageHref, stageLinkLabel, picks, onPick, ...input }: StageStripProps) {
  const w = useProductionWords()
  const ds = useDsWords()
  const name = label ?? w.t('parts.stage.label')
  if (loading) {
    return (
      <div className="fw-prp-strip" data-layout={layout} role="status" aria-label={w.t('parts.stage.loading')}>
        <Skeleton width={layout === 'compact' ? 140 : '100%'} height={layout === 'compact' ? 14 : 44} />
      </div>
    )
  }
  if (problem) {
    return <EmptyState title={w.t('parts.stage.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{w.t('common.retry')}</Button> : undefined} />
  }
  const steps = stageSteps(input)
  // ---- F-OO-102 (office only: the portal never passes `state`, so nothing below changes for it) ----
  // Stopped (a cancelled order): no strip — the office card says where the work had reached. Waiting for a yes: every stage is to come
  // and none is now, but the DS MilestoneTracker always marks one step current (with nothing reached, the first: "Preparing · Now"),
  // so no strip is drawn rather than a wrong one (DS gap: a tracker with nothing current yet); the card says production starts once
  // the order is confirmed.
  if (input.state === 'STOPPED' || (steps.length > 0 && steps.every((step) => step.state === 'todo'))) return null
  // ---- end F-OO-102
  if (steps.length === 0) {
    return (
      <div className="fw-prp-strip fw-prp-unknown" data-layout={layout}>
        <span aria-hidden>—</span>
        <span className="nds-vh">{`${name}: ${w.t('parts.stage.unknown')}`}</span>
      </div>
    )
  }
  const milestones: MilestoneStep[] = steps.map((step) => ({
    id: step.id,
    label: w.say(step.label),
    state: step.state,
    date: step.date ? w.day(step.date) : null,
    expected: step.expected ? w.day(step.expected) : null,
    note: step.note ? w.say(step.note) : null,
  }))
  const milestonePromise: MilestonePromise | null = promise
    ? { date: w.day(promise.date), history: (promise.history ?? []).map((move) => ({ on: w.day(move.on), from: move.from ? w.day(move.from) : null, to: w.day(move.to), reason: move.reason ? w.reason(move.reason) : null })) }
    : null
  const labels = {
    ...ds.milestoneTracker,
    usually: (date: string) => w.t(face === 'office' ? 'parts.stage.office.planned' : 'parts.stage.customer.expected', { date }),
    promised: (date: string) => w.t(face === 'office' ? 'parts.stage.office.promised' : 'parts.stage.customer.promised', { date }),
  }
  const blocked = input.blocked ? (
    <Pill tone="warning" icon={<PauseCircle size={12} aria-hidden />} className="fw-prp-blocked">
      {layout === 'compact' && input.blocked.why ? w.t('parts.stage.blockedWhy', { why: input.blocked.why }) : w.t('parts.stage.blocked')}
    </Pill>
  ) : null
  // The full form puts the mark above the steps (the current step's line says why); the row form puts it after the dots.
  // F-OP-104: with a door the stages are one real link (no prefetch: a record page's tab address changes with the dock's scope).
  // F-SC-W3: with picks each step is its own button instead (the link is not drawn; the promise is the page's, as with the link).
  const pickable = layout !== 'compact' && !!onPick && !!picks && picks.length > 0
  const tracker = <MilestoneTracker steps={milestones} promise={layout === 'compact' || stageHref || pickable ? null : milestonePromise} layout={layout} label={name} labels={labels} />
  return (
    <div className="fw-prp-strip" data-layout={layout} data-blocked={input.blocked ? 'true' : undefined}>
      {layout === 'compact' ? null : blocked}
      {pickable ? (
        <StepPicks tracker={tracker} steps={steps.map((step) => step.id)} picks={picks!} onPick={onPick!} />
      ) : stageHref ? (
        <NextLink href={stageHref} prefetch={false} className="fw-prp-strip-go" aria-label={stageLinkLabel ?? name}>
          {tracker}
        </NextLink>
      ) : (
        tracker
      )}
      {layout === 'compact' ? blocked : null}
    </div>
  )
}

// ---- F-SC-W3 (stage control B, 40-stage-plan §3): the steps as buttons over the DS MilestoneTracker (frozen: its steps take no click) ----
/**
 * Real <button>s laid UNDER the tracker, each over its own step (li.nds-milestone), measured with a ResizeObserver — the stretched-button
 * idea of the DS PressableRow, never a div with a role. The tracker sits on top and lets the pointer through (production-parts.css), so
 * its own look stays and a click on a step reaches its button; the hover and the focus ring show through around the words. Tab goes
 * through the steps in order, Enter opens; across (wide box) or down (narrow, a phone) each step is one target. Before the first measure
 * (the server's markup) the buttons are there, named, with no size.
 */
function StepPicks({ tracker, steps, picks, onPick }: { tracker: ReactNode; steps: readonly PlainStage[]; picks: readonly StageStripPick[]; onPick: (stage: PlainStage) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [rects, setRects] = useState<Readonly<Partial<Record<PlainStage, CSSProperties>>>>({})
  const order = steps.join(' ')
  useEffect(() => {
    const root = box.current
    if (!root) return
    const measure = () => {
      const at = root.getBoundingClientRect()
      const next: Partial<Record<PlainStage, CSSProperties>> = {}
      root.querySelectorAll<HTMLElement>('li.nds-milestone').forEach((item, index) => {
        const stage = steps[index]
        if (!stage) return
        const r = item.getBoundingClientRect()
        next[stage] = { top: r.top - at.top, left: r.left - at.left, width: r.width, height: r.height }
      })
      setRects(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    root.querySelectorAll('li.nds-milestone').forEach((item) => observer.observe(item))
    return () => observer.disconnect()
    // The steps' order is the only input the measure reads besides the box itself (`steps` is a new array each render).
  }, [order])
  return (
    <div ref={box} className="fw-prp-strip-picks">
      {tracker}
      {picks.map((pick) => (
        <button key={pick.stage} type="button" className="fw-prp-strip-pick" data-stage={pick.stage} style={rects[pick.stage]} aria-label={pick.label} onClick={() => onPick(pick.stage)} />
      ))}
    </div>
  )
}
// ---- end F-SC-W3
