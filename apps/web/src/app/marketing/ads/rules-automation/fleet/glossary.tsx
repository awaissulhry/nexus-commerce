'use client'

/**
 * FX.4 — the glossary: every term the fleet UI uses, defined ONCE, and a
 * <Term> primitive that renders the definition as a hover/focus tooltip.
 * Design contract rule 3: adding jargon to a fleet surface without a
 * glossary entry fails review. CSS-only tooltip (control-room.css),
 * keyboard-reachable via tabIndex, no positioning library.
 */

import type { ReactNode } from 'react'

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
    body: 'One proposed action waiting for your yes or no. Nothing reaches Amazon without passing this gate. Approvals expire after 7 days so stale intent never accumulates.',
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
}

export function Term({ k, children }: { k: keyof typeof GLOSSARY & string; children: ReactNode }) {
  const entry = GLOSSARY[k]
  if (!entry) return <>{children}</>
  return (
    <span className="acr-term" tabIndex={0}>
      {children}
      <span role="tooltip" className="acr-term-tip">
        <strong>{entry.title}</strong>
        {entry.body}
      </span>
    </span>
  )
}
