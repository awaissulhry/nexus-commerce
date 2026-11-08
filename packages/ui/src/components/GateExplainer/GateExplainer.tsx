'use client'

/**
 * GateExplainer — a gate's answer in plain sentences (B-W2b-78, design part GateExplainer): the certificate gate, release
 * to ship, a hold's release conditions, labels, tests, a market's requirements. One part so every gate speaks the same
 * words.
 *
 *   <GateExplainer title="Certificate gate" rule={t('gate.rule')} checks={checks} labels={ds.gateExplainer} />
 *   <GateExplainer form="compact" checks={checks} />            → "✕ Blocked · Size 58 is outside the covered range 46–56"
 *   <GateExplainer form="popover" checks={checks} title="…" />   → the same line as a button; the full answer in a popover
 *   <GateExplainer form="list" checks={blockers} />              → only what blocks, each with who and its fix
 *   <Button heldReason={gateHeldReason(checks, ds.gateExplainer)}>Release</Button>
 *
 * - Each check: ✓ / ✕ / ? / – AND a word (Met / Not met / Not known / Not needed, or the gate's own `stateLabel`), the
 *   check as a sentence, its value now when not met ("now: PENDING"), the reason, and — when not met — who can clear it,
 *   how, and its fix (a link or a button, held with a reason when the person may not). A `law` puts a LawRef chip on it.
 * - The verdict (`gateExplainerModel.ts`): not met → Blocked; unknown → Not known yet (held too); else Clear. Nothing
 *   listed → Blocked, said.
 * - `override`: the override path when one exists (who may, how, the action), shown while the gate holds; `{ none }`
 *   says that this gate has none (a PPE certificate).
 * - `asOf`: a frozen answer ("As it stood on 3 Nov 2026, 10:42") — what was true at release.
 * - Announced: the verdict and its line sit in a polite live region (`announce`, default on in the full and compact
 *   forms), so a change after a scan is heard once.
 * - Sized by the density (`--nds-density-*`): the console's sizes at standard, bigger on the floor tier.
 */
import { createElement, useId, type ReactNode } from 'react'
import { CheckCircle2, CircleHelp, History, MinusCircle, ShieldAlert, ShieldCheck, ShieldQuestion, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton } from '../../floor/FloorButton'
import { DetailPopover } from '../DetailPopover'
import { LawRef, type LawRefProps } from '../LawRef/LawRef'
import type { LawRefLabels } from '../LawRef/LawRefLabels'
import { GATE_EXPLAINER_LABELS, type GateExplainerLabels } from './GateExplainerLabels'
import { gateBlockers, gateLine, gateSummary, gateVerdict, type GateCheckState, type GateVerdict } from './gateExplainerModel'
import './gateExplainer.css'

export interface GateAction {
  label: string
  href?: string
  onClick?: () => void
  /** Why this person cannot do it now: held (focusable, announced, inert) with the reason. */
  heldReason?: string | null
}

export interface GateCheck {
  id: string
  /** The check as a sentence ("The certificate covers every size"). */
  label: string
  state: GateCheckState
  /** This check's own word for its state ("Covered", "Not covered"). */
  stateLabel?: string
  /** The value now, when not met ("PENDING", "missing"). */
  now?: string
  /** The reason in words ("Size 58 is outside the covered range 46–56"); a string also feeds the one line. */
  reason?: ReactNode
  /** Who can clear it ("Compliance lead"). */
  who?: string
  /** How ("Ask the notified body to extend the certificate, or remove size 58 from the order"). */
  how?: string
  /** The law it comes from. */
  law?: Pick<LawRefProps, 'law' | 'plain' | 'href'>
  /** What clears it: a link or a button. */
  fix?: GateAction
}

export type GateOverride =
  | {
      /** What the override does ("Release under a concession, for this work order only"). */
      label: ReactNode
      who?: string
      how?: string
      action?: GateAction
    }
  | {
      /** Why there is none ("A PPE label needs a valid certificate: the law allows no override"). */
      none: ReactNode
    }

export type GateForm = 'full' | 'compact' | 'popover' | 'list'

export interface GateExplainerProps {
  /** The gate's name ("Certificate gate"). */
  title?: ReactNode
  /** The gate's rule in one sentence. */
  rule?: ReactNode
  checks: readonly GateCheck[]
  /** `full` (default), `compact` (one line), `popover` (the line opens the full answer), `list` (only what blocks). */
  form?: GateForm
  override?: GateOverride
  /** A frozen answer: when it was true, written in the page's language. */
  asOf?: string
  /** The verdict in a polite live region (default on for `full` and `compact`). */
  announce?: boolean
  /** The level of the title (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<GateExplainerLabels>
  /** The LawRef chips' words. */
  lawLabels?: Partial<LawRefLabels>
  id?: string
  className?: string
}

const STATE_ICON = { pass: CheckCircle2, fail: XCircle, unknown: CircleHelp, notNeeded: MinusCircle } as const
const VERDICT_ICON = { open: ShieldCheck, held: ShieldAlert, unknown: ShieldQuestion } as const
const VERDICT_STATE: Record<GateVerdict, GateCheckState> = { open: 'pass', held: 'fail', unknown: 'unknown' }

function Action({ action, variant = 'secondary' }: { action: GateAction; variant?: 'secondary' | 'primary' }) {
  if (action.href && !action.heldReason) {
    return (
      <a className="nds-gate-link" href={action.href}>
        {action.label}
      </a>
    )
  }
  return (
    <FloorButton size="sm" variant={variant} heldReason={action.heldReason ?? null} onClick={action.onClick}>
      {action.label}
    </FloorButton>
  )
}

function Verdict({ verdict, lw }: { verdict: GateVerdict; lw: GateExplainerLabels }) {
  return (
    <span className="nds-gate-verdict" data-state={VERDICT_STATE[verdict]}>
      {createElement(STATE_ICON[VERDICT_STATE[verdict]], { 'aria-hidden': true, className: 'nds-gate-state-icon' })}
      {lw.verdicts[verdict]}
    </span>
  )
}

function CheckRow({ check, lw, lawLabels, compact }: { check: GateCheck; lw: GateExplainerLabels; lawLabels?: Partial<LawRefLabels>; compact?: boolean }) {
  const open = check.state === 'fail' || check.state === 'unknown'
  return (
    <li className="nds-gate-check" data-state={check.state}>
      <span className="nds-gate-state">
        {createElement(STATE_ICON[check.state], { 'aria-hidden': true, className: 'nds-gate-state-icon' })}
        {check.stateLabel ?? lw.states[check.state]}
      </span>
      <div className="nds-gate-body">
        <div className="nds-gate-label">
          {compact && typeof check.reason === 'string' && check.reason.trim() ? check.reason : check.label}
          {open && check.now ? <span className="nds-gate-now"> ({lw.now(check.now)})</span> : null}
          {check.law ? <> <LawRef {...check.law} labels={lawLabels} /></> : null}
        </div>
        {!compact && check.reason ? <div className="nds-gate-reason">{check.reason}</div> : null}
        {open && (check.who || check.how) ? (
          <div className="nds-gate-who">
            {check.who ? <span>{lw.who(check.who)}</span> : null}
            {check.how ? <span>{lw.how(check.how)}</span> : null}
          </div>
        ) : null}
      </div>
      {open && check.fix ? (
        <div className="nds-gate-fix">
          <Action action={{ ...check.fix, label: check.fix.label || lw.fix }} />
        </div>
      ) : null}
    </li>
  )
}

function Full({ props, lw, verdict, announce, inPopover }: { props: GateExplainerProps; lw: GateExplainerLabels; verdict: GateVerdict; announce: boolean; inPopover?: boolean }) {
  const auto = useId()
  const titleId = `${auto}-title`
  const s = gateSummary(props.checks)
  const H = `h${props.headingLevel ?? 3}` as 'h3'
  const override = props.override
  return (
    <section
      id={inPopover ? undefined : props.id}
      className={['nds-gate', props.className ?? ''].filter(Boolean).join(' ')}
      data-form="full"
      data-verdict={verdict}
      data-frozen={props.asOf ? 'true' : undefined}
      aria-labelledby={props.title ? titleId : undefined}
    >
      <div className="nds-gate-head">
        {createElement(VERDICT_ICON[verdict], { 'aria-hidden': true, className: 'nds-gate-icon' })}
        {props.title ? (
          <H id={titleId} className="nds-gate-title">
            {props.title}
          </H>
        ) : null}
        <span className="nds-gate-answer" role={announce ? 'status' : undefined}>
          <Verdict verdict={verdict} lw={lw} />
          <span className="nds-gate-summary">{props.checks.length ? lw.summary(s.passed, s.total) : lw.none}</span>
        </span>
      </div>
      {props.rule ? <p className="nds-gate-rule">{props.rule}</p> : null}
      {props.asOf ? (
        <p className="nds-gate-asof">
          <History aria-hidden className="nds-gate-state-icon" />
          {lw.asOf(props.asOf)}
        </p>
      ) : null}
      {props.checks.length ? (
        <ol className="nds-gate-checks" aria-label={lw.list}>
          {props.checks.map((check) => (
            <CheckRow key={check.id} check={check} lw={lw} lawLabels={props.lawLabels} />
          ))}
        </ol>
      ) : null}
      {override && verdict !== 'open' && !props.asOf ? (
        <div className="nds-gate-override">
          <div className="nds-gate-override-title">{lw.override}</div>
          {'none' in override ? (
            <p className="nds-gate-override-text">{override.none}</p>
          ) : (
            <>
              <p className="nds-gate-override-text">{override.label}</p>
              {override.who || override.how ? (
                <div className="nds-gate-who">
                  {override.who ? <span>{lw.overrideWho(override.who)}</span> : null}
                  {override.how ? <span>{lw.how(override.how)}</span> : null}
                </div>
              ) : null}
              {override.action ? <Action action={override.action} /> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

function Compact({ props, lw, verdict, line, announce }: { props: GateExplainerProps; lw: GateExplainerLabels; verdict: GateVerdict; line: string; announce: boolean }) {
  return (
    <span id={props.id} className={['nds-gate', props.className ?? ''].filter(Boolean).join(' ')} data-form="compact" data-verdict={verdict} role={announce ? 'status' : undefined}>
      <Verdict verdict={verdict} lw={lw} />
      <span className="nds-gate-line">{line}</span>
    </span>
  )
}

export function GateExplainer(props: GateExplainerProps) {
  const lw = mergeLabels(GATE_EXPLAINER_LABELS, props.labels)
  const form = props.form ?? 'full'
  const verdict = gateVerdict(props.checks)
  const line = gateLine(props.checks, lw)
  const announce = props.announce ?? (form === 'full' || form === 'compact')

  if (form === 'compact') return <Compact props={props} lw={lw} verdict={verdict} line={line} announce={announce} />

  if (form === 'popover') {
    const sentence = `${lw.verdicts[verdict]}: ${line}`
    return (
      <span id={props.id} className="nds-gate-pop" data-verdict={verdict}>
        <DetailPopover
          trigger={
            <span className="nds-gate" data-form="compact" data-verdict={verdict}>
              <Verdict verdict={verdict} lw={lw} />
              <span className="nds-gate-line">{line}</span>
            </span>
          }
          triggerLabel={lw.showWhy(sentence)}
          triggerClassName="nds-gate-trigger"
          panelClassName="nds-gate-panel"
          label={typeof props.title === 'string' ? props.title : lw.list}
          hoverDelay={0}
        >
          <Full props={props} lw={lw} verdict={verdict} announce={false} inPopover />
        </DetailPopover>
        {announce ? (
          <span className="nds-gate-sr" role="status">
            {sentence}
          </span>
        ) : null}
      </span>
    )
  }

  if (form === 'list') {
    const blockers = gateBlockers(props.checks)
    return (
      <div id={props.id} className={['nds-gate', props.className ?? ''].filter(Boolean).join(' ')} data-form="list" data-verdict={blockers.length ? 'held' : 'open'}>
        {blockers.length ? (
          <ul className="nds-gate-checks" aria-label={lw.list}>
            {blockers.map((check) => (
              <CheckRow key={check.id} check={check} lw={lw} lawLabels={props.lawLabels} compact />
            ))}
          </ul>
        ) : (
          <p className="nds-gate-empty" role={announce ? 'status' : undefined}>
            <CheckCircle2 aria-hidden className="nds-gate-state-icon" />
            {lw.empty}
          </p>
        )}
      </div>
    )
  }

  return <Full props={props} lw={lw} verdict={verdict} announce={announce} />
}
