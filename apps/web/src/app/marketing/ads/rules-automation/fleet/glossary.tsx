'use client'

/**
 * FX.4 — the glossary: every term the fleet UI uses, defined ONCE, and a
 * <Term> primitive that renders the definition as a hover/focus tooltip.
 * Design contract rule 3: adding jargon to a fleet surface without a
 * glossary entry fails review. CSS-only tooltip (control-room.css),
 * keyboard-reachable via tabIndex, no positioning library.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

export const GLOSSARY: Record<string, { title: string; body: string }> = {
  worker: {
    title: 'Worker',
    body: 'An AI analyst with one narrow job: read prepared evidence and report findings. Workers cannot change anything — they only observe and write to the shared board.',
  },
  director: {
    title: 'Director',
    body: 'The planner. Once the workers have reported, the director picks which findings deserve action, resolves conflicts between them, and writes one ranked plan. It cannot execute anything.',
  },
  critic: {
    title: 'Critic',
    body: 'The adversarial reviewer. Its job is to find reasons to say no. It runs twelve checks against every plan; code-computed safety blocks are final and the critic can add blocks but never remove one.',
  },
  auditor: {
    title: 'Auditor',
    body: 'The reporter. Once a night it reads the fleet-health digest and writes the operator brief. It changes nothing.',
  },
  off: {
    title: 'OFF',
    body: 'The worker does not run at all. Every worker is born OFF and stays OFF until you turn its dial.',
  },
  observe: {
    title: 'OBSERVE',
    body: 'Watch-only. The worker runs, reads evidence, and reports findings — and can change nothing. This is where every worker earns its first trust.',
  },
  propose: {
    title: 'PROPOSE',
    body: 'The worker’s suggestions queue for YOUR approval. Nothing happens until you approve each one. Earned after 14 days of OBSERVE with a grade of B or better.',
  },
  auto: {
    title: 'AUTO',
    body: 'The worker acts on its own, still inside every safety gate. Requires 30 days of PROPOSE, 70% of its suggestions approved, proven calibration, zero rollbacks — and your explicit sign-off. The server refuses AUTO for a worker that has not earned it.',
  },
  cap: {
    title: 'Autonomy cap',
    body: 'A ceiling written in code. Whatever the dial says, a worker can never exceed its cap — the UI cannot override it, and neither can the API.',
  },
  finding: {
    title: 'Finding',
    body: 'One observation a worker wrote to the shared board: what it saw, where, how severe, how confident, and the evidence it cites. Findings expire — stale ones cannot enter plans.',
  },
  plan: {
    title: 'Plan',
    body: 'The director’s ranked list of proposed actions, each tied to a finding. A plan must survive the critic before anything can queue for your approval.',
  },
  approval: {
    title: 'Approval',
    // NAF.AQ.0 — this said "7 days"; the gate has always used 24 hours
    // (approval-gate.service.ts EXPIRY_HOURS, now exported so no surface has
    // to retype it). The number was wrong by 7x on the one screen that tells
    // an operator how long they have.
    body: 'One proposed action waiting for your yes or no. Nothing reaches Amazon without passing this gate. An approval expires 24 hours after it is asked, so stale intent never accumulates — and expiry always means refused, never approved-by-default.',
  },
  // NAF.AQ.1 — added for the Approvals page's gate-state section. The single
  // most load-bearing fact on that page: the fleet's three actions describe
  // what they would do and stop there, so an approval on one cannot be
  // created and could not reach Amazon if it were.
  'preview-only': {
    title: 'Preview only',
    body: 'An action that can describe what it would do but cannot actually do it — the part that writes to Amazon has not been built yet. All three of the fleet’s own actions are preview-only today, so approving one records your decision and teaches the fleet, and changes nothing on Amazon.',
  },
  'blast-radius': {
    title: 'Blast radius',
    body: 'How big a change the plan would make: campaigns touched, bid changes, budget moved, conflicts. Unattended changes must stay inside tight limits — a breach blocks the plan.',
  },
  'shadow-agreement': {
    title: 'Agrees with engines',
    body: 'Every worker finding is compared against what the deterministic engines would have proposed on the same data. High agreement means the worker sees what the proven math sees.',
  },
  grade: {
    title: 'Grade',
    body: 'The nightly report-card mark, A to F, computed by code: agreement with the engines, and format discipline. F means it broke its output contract too often. Grade B or better is required for promotion.',
  },
  calibration: {
    title: 'Calibration',
    body: 'Whether the worker’s stated confidence matches reality. Unknowable until its actions are executed and measured — shown as unknown until then, never guessed.',
  },
  sweep: {
    title: 'Sweep',
    body: 'The nightly run (04:45 UTC): every enabled worker reads fresh evidence and reports findings; report cards recompute; the entity graph re-derives.',
  },
  council: {
    title: 'Council',
    body: 'The weekly session (Monday 05:15 UTC): workers report, the director plans, the critic rules, and surviving actions queue for your approval.',
  },
  charter: {
    title: 'Charter',
    body: 'A worker’s job description — the literal, versioned instruction it runs on. Changing behaviour means changing this text: reviewed, diffed, revertible.',
  },
  evidence: {
    title: 'Evidence',
    body: 'The data a worker reads, prepared by deterministic code before the model is called. Workers never compute their own numbers — code does the math, the model does the judgment.',
  },
  severity: {
    title: 'Severity',
    body: 'How much a finding matters, in the worker’s judgment: info, low, medium, high, critical. Severity ranks attention; it never triggers action by itself.',
  },
  confidence: {
    title: 'Confidence',
    body: 'How sure the worker is (0 to 1). Low-confidence findings tend to be set aside by the director.',
  },
  exemplar: {
    title: 'Precedent',
    body: 'Every decision you make on an approval is saved and read back to the workers on later runs — your reject reasons are the most valuable teaching signal in the system.',
  },
  demotion: {
    title: 'Demotion',
    body: 'Automatic and immediate: a rollback, acceptance below 40%, two critic blocks in a week, or too many format failures — one rung down the trust ladder, and you are told why.',
  },
  ceiling: {
    title: 'Daily ceiling',
    body: 'The hard cap on what the whole fleet may spend on AI per day ($2.00). Past it, runs are refused before any model is called. Fails closed: if the ledger is unreadable, the fleet halts.',
  },
  degraded: {
    title: 'Degraded',
    body: 'The worker’s stored policy could not be read, so it fails safe to OFF. Nothing runs on unreadable configuration.',
  },
  running: {
    title: 'Fleet status',
    body: 'Whether the fleet is allowed to start runs. A halt — yours, or the automatic circuit breaker’s — stops every worker; the deterministic ad engines are unaffected.',
  },
  'risk-tier': {
    title: 'Risk tier',
    body: 'How much a single action can cost you if it is wrong — low, medium or high. It is set in code per tool, not by the worker, and it decides how much of the card is shown: a reversible bid nudge is compact, a high-risk action opens in full and needs you to confirm you have read it.',
  },
  'undo-window': {
    title: 'The undo window',
    body: 'Approving does not fire immediately. The action waits 20 seconds, during which nothing has reached Amazon and one click takes it back. If you close the tab, it still runs — the decision is saved the moment you make it, only the execution waits.',
  },
  staleness: {
    title: 'Stale approval',
    body: 'An approval describes the world as it was when you read it. If the facts move before it runs — the bid you were moving from has changed, the term is already negated, a pin was added — it is refused rather than executed, and handed back to you with what changed.',
  },
  'trust-ladder': {
    title: 'The trust ladder',
    body: 'OFF → OBSERVE (watch only) → PROPOSE (asks you) → AUTO (acts, narrowly). Each rung is earned with evidence over weeks, never granted by default — and misbehaviour drops a rung automatically.',
  },
  // NAF.WF — minted for /fleet/workflows (locks-doc glossary protocol).
  workflow: {
    title: 'Workflow',
    body: 'A named routine: which workers run, in what order, and what each hands to the next. The fleet map shows the whole fleet live; a workflow is one routine, readable on its own — and, soon, versionable and editable.',
  },
  trigger: {
    title: 'Trigger',
    body: 'What starts a routine — a clock (a schedule) or you (a manual run). If the trigger is off, the routine never runs, and its row says so instead of leaving you to guess.',
  },
  gate: {
    title: 'Gate',
    body: 'Per step of a workflow: ask first (every proposal waits for you), may act (the tool’s own policy decides), or inherit today’s behaviour. A gate can only tighten — always-ask tools keep asking whatever the gate says.',
  },
  draft: {
    title: 'Draft',
    body: 'A recorded revision that is not active. Drafts are inert: saving one changes nothing anywhere. Activate it from Versions when you mean it.',
  },
  publish: {
    title: 'Publish',
    body: 'The one consequential act in editing: it records your draft as the active revision, behind a confirmation that shows exactly what changed. Until then, editing touches nothing.',
  },
  // NAF.SB.ACT — minted for /fleet/activity (locks-doc glossary protocol).
  // The self-test owns 39 of the fleet's 53 runs and 47 of its 64 findings, so
  // it is the first thing a beginner meets on the Activity page and the first
  // thing they would misread as a problem with their account.
  selftest: {
    title: 'Self-test',
    body: 'A worker whose only job is to check that the fleet itself is working. Its findings are about our own scheduled jobs, never about your Amazon account — so it is left out of the counts and shown with a badge. Hidden by default; tick the box to see it.',
  },
  run: {
    title: 'Run',
    body: 'One worker doing its job once: it reads prepared evidence, thinks, and writes down what it found. A run costs money and takes seconds to minutes. Everything else on this page — findings, plans, approvals — was produced by some run.',
  },
  // NAF.SB.AS — exactly two terms minted for the Assignments page. "What you
  // want back" is deliberately NOT a term: it is a plain phrase and giving it
  // a name would make one text box look like three different things.
  assignment: {
    title: 'Assignment',
    body: 'One worker, pointed at one thing, with a note about what you want back. It sits and waits until you start it — nothing starts on its own. Each time you start it, it makes one run; the assignment keeps every attempt. One worker means an assignment; two or more, or anything on a clock, means a routine on Workflows.',
  },
  target: {
    title: 'Target',
    body: 'The one thing an assignment points at — a campaign, a marketplace, or your whole account. It narrows the evidence the worker reads before the worker ever sees it, so it genuinely binds rather than being a hint the worker could ignore. A target can only narrow a worker, never widen it past the limits set on its own page.',
  },
  // NAF.WF-S1R — two terms, appended as one block. Both were already load-
  // bearing words on this page and neither had a definition: "step" is used by
  // the `gate` entry above and by the editor, and "revision" by `draft` and
  // `publish`. The rebuilt routine list put both on screen — the chain of
  // steps, and a version chip on every card — so the gap became visible.
  step: {
    title: 'Step',
    body: 'One link in a routine: usually a worker doing its job, sometimes deterministic code (grading, report cards) and sometimes you. The chain on a routine reads left to right, and each step hands what it produced to the next. A worker that is switched off is still shown, struck through — it is skipped, and it costs nothing.',
  },
  revision: {
    title: 'Revision',
    body: 'One saved version of a routine’s wiring. Revisions are immutable and numbered, every one carries a note saying why, and every run records which revision produced it. A built-in that has never been edited says "as shipped" instead of a number, and going back to that can never fail.',
  },
  // NAF.SB.M.8 — one term for the Fleet map. Everything else that page needed
  // was already here (worker, finding, plan, director, critic, ceiling), which
  // is the glossary working as intended. "Handoff" is the exception: the map
  // is the only surface that makes a line between two workers something you
  // can select and read, so it is the only one that has to name the thing.
  handoff: {
    title: 'Handoff',
    body: 'One worker’s findings being picked up by the next. The map draws it as a line, and the number on it counts what was actually carried — how many of those findings the director named in its plan. The rest is as interesting: the director has to give a reason for every finding it left behind, and those reasons are on the line’s panel.',
  },
}

/**
 * NAF.AQ-S1R S1.d — the two WCAG 2.2 SC 1.4.13 requirements this had never met.
 *
 * Measured on production before the change, not inferred:
 *
 * · **Dismissible** — "A mechanism is available to dismiss the additional
 *   content without moving pointer hover or keyboard focus." There was no key
 *   handler anywhere in this file, so Esc did nothing.
 * · **Hoverable** — "the pointer can be moved over the additional content
 *   without the additional content disappearing." `.acr-term-tip` was
 *   `pointer-events: none`, and hit-testing the centre of an open tooltip
 *   returned the element BEHIND it. Even with pointer events restored there is
 *   an 8px gap between the term and its tip, and crossing that gap drops
 *   `:hover` — so the CSS side of this fix is a transparent bridge, not just
 *   deleting one declaration.
 * · **Persistent** already passed, as did keyboard reach (`tabIndex={0}`) and
 *   contrast (12.94:1). None of those is changed.
 *
 * The `:hover` / `:focus` CSS rules are deliberately left in place and still do
 * all the showing. This component only ever *hides* — one class, set by Esc and
 * cleared when the pointer or focus leaves — so every one of the nineteen
 * surfaces using `<Term>` keeps exactly today's behaviour plus the two missing
 * requirements. Nothing here can make a tooltip appear that would not have.
 *
 * Known and NOT fixed here, because it is a different change with a different
 * risk: the tip is a DOM child of the focusable span, so its text joins the
 * trigger's accessible name and a screen reader says the term twice. The fix is
 * an `aria-describedby` restructure, which is worth doing on its own.
 */
export function Term({ k, children }: { k: keyof typeof GLOSSARY & string; children: ReactNode }) {
  const entry = GLOSSARY[k]
  /**
   * `engaged` is "the pointer or focus is on this term", and it exists ONLY so
   * that the Escape listener belongs to the one term actually on screen.
   *
   * The first version of this listened on `document` from every un-dismissed
   * Term, which is wrong in a way worth recording: one Escape anywhere marked
   * every Term on the page dismissed, and a term the pointer had never touched
   * could not re-arm — because re-arming happens on ITS OWN mouseleave/blur,
   * which never fires for an element you never entered. On the Controls page
   * that would have silently killed every tooltip until a reload. Caught by
   * reasoning about the fan-out rather than by any gate: nineteen files use
   * this component and not one of them would have failed to compile.
   *
   * Hooks are declared before the `!entry` bail-out because hook order cannot
   * be conditional.
   */
  const [engaged, setEngaged] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const enter = useCallback(() => {
    setEngaged(true)
    setDismissed(false)
  }, [])
  const leave = useCallback(() => {
    setEngaged(false)
    setDismissed(false)
  }, [])

  useEffect(() => {
    if (!engaged || dismissed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      /*
       * Deliberately no preventDefault and no stopPropagation. An Escape meant
       * for a drawer or a modal must still reach it — a tooltip is the cheapest
       * thing on screen to dismiss and can afford to share the key. And the
       * listener is on `document` rather than on the element because the
       * requirement is that Esc works while merely HOVERING, when nothing is
       * focused and no element-level key event would ever fire.
       */
      setDismissed(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [engaged, dismissed])

  if (!entry) return <>{children}</>
  return (
    <span
      className={`acr-term${dismissed ? ' dismissed' : ''}`}
      tabIndex={0}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      {children}
      <span role="tooltip" className="acr-term-tip">
        <strong>{entry.title}</strong>
        {entry.body}
      </span>
    </span>
  )
}
