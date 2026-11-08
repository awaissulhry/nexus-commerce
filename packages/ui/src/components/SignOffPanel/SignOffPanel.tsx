'use client'

/**
 * SignOffPanel — ordered sign-off steps with separation of duties in words (B-W2b-78, design part SignOffPanel): an
 * inspection's result and release, a hold's release, an NCR, a CAPA's staged approvals, a plan or document version, a
 * label proof, a test result.
 *
 *   <SignOffPanel steps={[
 *       { id: 'result', label: 'Result signed', role: 'Inspector', state: 'signed', signer: 'Marta Demo',
 *         method: 'pin', methodDetail: 'at bench 2', signedAt: '10:42', fingerprint: sha },
 *       { id: 'release', label: 'Release by a second person', state: 'waiting', whoMay: 'Quality lead',
 *         rules: [{ kind: 'fourEyes', state: 'broken' }], action: { label: 'Release', onClick: openStepUp } },
 *     ]} labels={ds.signOffPanel} />
 *
 * - Each step: its number, what it is, the role, its state as an icon AND a word; signed: by whom, how (PIN / code /
 *   typed name, with the app's detail), when and the fingerprint; waiting: who may sign; rejected: by whom and why.
 * - Separation of duties per step (maker check from scans, four-eyes, author-cannot-approve, the app's own): each rule
 *   with ✓ / ✕ / ? and a word and its sentence.
 * - The step's action (the app opens StepUpModal or SignBlock in the office) is held — focusable, announced, inert — with
 *   the reason on screen (`signOffPanelModel.ts`). On the floor the app passes `sign` (a PinSignBlock, D22), drawn under
 *   the current step when nothing holds it.
 * - The summary ("1 of 2 signed") is a polite live region: a signature that lands is heard once.
 * - Sized by the density (`--nds-density-*`).
 */
import { createElement, useId, type ReactNode } from 'react'
import { Ban, CheckCircle2, CircleHelp, Clock, Lock, MinusCircle, PenLine, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton } from '../../floor/FloorButton'
import { sealGroups, sealShort } from '../DocumentSeal/documentSealModel'
import { SIGN_OFF_PANEL_LABELS, type SignOffPanelLabels } from './SignOffPanelLabels'
import {
  dutyText,
  signOffCurrent,
  signOffStepHeld,
  signOffSummary,
  type DutyKind,
  type DutyState,
  type SignMethod,
  type SignStepState,
} from './signOffPanelModel'
import './signOffPanel.css'

export interface DutyRule {
  id: string
  kind: DutyKind
  state: DutyState
  /** The app's sentence; else the part's for the kind and state. */
  text?: string
}

export interface SignOffAction {
  label: string
  onClick: () => void
  /** The signature is being recorded: held with `busyLabel`. */
  busy?: boolean
  busyLabel?: string
}

export interface SignOffStep {
  id: string
  /** What this step is ("Result signed", "Release by a second person", "Approve the plan"). */
  label: string
  /** The role that signs it ("Inspector"). */
  role?: string
  state: SignStepState
  /** Who signed (or rejected). */
  signer?: string
  /** The signer's role, when it differs from the step's. */
  signerRole?: string
  method?: SignMethod
  /** "at bench 2", "authenticator code". */
  methodDetail?: string
  /** When, written in the page's language. */
  signedAt?: string
  /** The SHA-256 of what was signed. */
  fingerprint?: string
  /** Who may sign while it waits ("Quality lead or plant manager"). */
  whoMay?: string
  /** Why it cannot be signed now (no right, offline, a result not in). Shown on screen. */
  heldReason?: string | null
  /** Why it was rejected. */
  rejectedReason?: ReactNode
  /** Separation-of-duties checks for the person looking. */
  rules?: readonly DutyRule[]
  /** The step's action (opens the app's StepUpModal or SignBlock). */
  action?: SignOffAction
  /** The app's sign block, drawn under the current step when nothing holds it (PinSignBlock on the floor). */
  sign?: ReactNode
  /** A line more. */
  note?: ReactNode
}

export interface SignOffPanelProps {
  steps: readonly SignOffStep[]
  /** Default "Sign-off". */
  title?: ReactNode
  /** The level of the title (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<SignOffPanelLabels>
  id?: string
  className?: string
}

const STEP_ICON: Record<SignStepState, typeof CheckCircle2> = { signed: CheckCircle2, waiting: Clock, held: Lock, rejected: Ban, notNeeded: MinusCircle }
const RULE_ICON: Record<DutyState, typeof CheckCircle2> = { met: CheckCircle2, broken: XCircle, unknown: CircleHelp }

export function SignOffPanel({ steps, title, headingLevel = 3, labels, id, className }: SignOffPanelProps) {
  const lw = mergeLabels(SIGN_OFF_PANEL_LABELS, labels)
  const auto = useId()
  const titleId = `${auto}-title`
  const current = signOffCurrent(steps)
  const s = signOffSummary(steps)
  const H = `h${headingLevel}` as 'h3'
  const summary = s.rejected ? lw.rejectedSummary : s.complete ? lw.complete : lw.summary(s.signed, s.total)

  return (
    <section id={id} className={['nds-signoff', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={titleId}>
      <div className="nds-signoff-head">
        <PenLine className="nds-signoff-icon" aria-hidden />
        <H id={titleId} className="nds-signoff-title">
          {title ?? lw.title}
        </H>
        <span className="nds-signoff-summary" role="status" data-state={s.rejected ? 'rejected' : s.complete ? 'signed' : 'waiting'}>
          {summary}
        </span>
      </div>
      <ol className="nds-signoff-steps" aria-label={lw.steps}>
        {steps.map((step, index) => {
          const held = signOffStepHeld(steps, index, lw)
          const isCurrent = index === current
          const openStep = step.state === 'waiting' || step.state === 'held'
          const how = step.method ? [lw.methods[step.method], step.methodDetail].filter(Boolean).join(' ') : step.methodDetail
          return (
            <li key={step.id} className="nds-signoff-step" data-state={step.state} data-current={isCurrent ? 'true' : undefined} aria-current={isCurrent ? 'step' : undefined}>
              <span className="nds-signoff-num" aria-hidden>
                {index + 1}
              </span>
              <div className="nds-signoff-body">
                <div className="nds-signoff-top">
                  <span className="nds-signoff-label">
                    <span className="nds-signoff-sr">{lw.step(index + 1)}: </span>
                    {step.label}
                  </span>
                  {step.role ? <span className="nds-signoff-role">{step.role}</span> : null}
                  <span className="nds-signoff-state">
                    {createElement(STEP_ICON[step.state], { 'aria-hidden': true, className: 'nds-signoff-state-icon' })}
                    {lw.states[step.state]}
                  </span>
                </div>
                {step.state === 'signed' && step.signer ? (
                  <div className="nds-signoff-line">{[lw.signedBy(step.signer, step.signerRole), how, step.signedAt].filter(Boolean).join(' · ')}</div>
                ) : null}
                {step.state === 'signed' && step.fingerprint ? (
                  <div className="nds-signoff-fp">
                    {lw.fingerprint} <code title={sealGroups(step.fingerprint)}>{sealShort(step.fingerprint)}</code>
                  </div>
                ) : null}
                {step.state === 'rejected' ? (
                  <>
                    {step.signer ? <div className="nds-signoff-line">{[lw.rejectedBy(step.signer), how, step.signedAt].filter(Boolean).join(' · ')}</div> : null}
                    {step.rejectedReason ? <div className="nds-signoff-reason">{step.rejectedReason}</div> : null}
                  </>
                ) : null}
                {openStep && step.whoMay ? <div className="nds-signoff-line">{lw.whoMay(step.whoMay)}</div> : null}
                {step.rules?.length ? (
                  <ul className="nds-signoff-rules">
                    {step.rules.map((rule) => (
                      <li key={rule.id} className="nds-signoff-rule" data-state={rule.state}>
                        <span className="nds-signoff-rule-state">
                          {createElement(RULE_ICON[rule.state], { 'aria-hidden': true, className: 'nds-signoff-state-icon' })}
                          {lw.ruleStates[rule.state]}
                        </span>
                        <span className="nds-signoff-rule-text">{dutyText(rule, lw)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {step.note ? <div className="nds-signoff-note">{step.note}</div> : null}
                {/* The held reason on screen, unless it is a rule's sentence already drawn above (said once). */}
                {openStep && held && !step.rules?.some((rule) => rule.state !== 'met' && dutyText(rule, lw) === held) ? <p className="nds-signoff-held">{held}</p> : null}
                {openStep && step.action ? (
                  <div className="nds-signoff-action">
                    <FloorButton
                      variant="primary"
                      size="md"
                      icon={<PenLine />}
                      heldReason={held ?? (step.action.busy ? (step.action.busyLabel ?? step.action.label) : null)}
                      onClick={step.action.onClick}
                    >
                      {step.action.busy && step.action.busyLabel ? step.action.busyLabel : step.action.label}
                    </FloorButton>
                  </div>
                ) : null}
                {isCurrent && !held && step.sign ? <div className="nds-signoff-sign">{step.sign}</div> : null}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
