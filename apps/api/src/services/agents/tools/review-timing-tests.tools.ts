/**
 * Reviews PR J (2026-10-27) — the two approved changes of timing tests and A/B splits
 * (services/reviews/review-timing-test.service.ts). The Reviews › Requests › Timing page and a rule's A/B card ask for
 * them; Claude may ask too. Either way a person approves each one in Nexus first: nothing changes before.
 *
 *   start-review-timing-test     a test RUNS: from the next scheduler run, new orders of its market are split by order
 *                                number between its groups (first-try days, or rule A and its copy B), and its holdout
 *                                group gets no review request at all. Stopping it (no approval: it only stops a split)
 *                                does not ask the held-out buyers later, and sent requests cannot be taken back, so the
 *                                start itself cannot be put back.
 *   apply-review-timing-winner   the winning first-try day goes into the rule for exactly that market and product type
 *                                (or a new rule is added for them); `armId: "before"` puts back what was there (its undo).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { staleRefusal } from './stale-preview.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult } from '../tool-types.js'

const BEFORE = 'before'
const svc = () => import('../../reviews/review-timing-test.service.js')

async function freshOrStale(preview: () => Promise<ToolResult>, ctx: ToolContext, fields: string[], what: string) {
  const fresh = await preview()
  if (!fresh.ok) return { refusal: fresh }
  const stale = staleRefusal(ctx.approvedPreview, fresh.preview, fields, what)
  return stale ? { refusal: { ok: false, error: stale } as ToolResult } : { fresh }
}

// ── start-review-timing-test ────────────────────────────────────────────────────────────────────────────────────────

const startInput = z.object({
  testId: z.string().trim().min(1).max(64).describe('the timing test or A/B split to start (Reviews › Requests › Timing, or a rule’s A/B split card)'),
})
type StartArgs = z.infer<typeof startInput>

async function previewStart(a: StartArgs): Promise<ToolResult> {
  const { timingTestFacts, testSummary, startRefusal } = await svc()
  const facts = await timingTestFacts(a.testId)
  if (!facts) return { ok: false, error: 'This timing test is not in this business. Nothing was started.' }
  const { row, names, live, rules } = facts
  const refusal = startRefusal(row, live, names, rules)
  const test = testSummary(row, names)
  if (refusal) return { ok: false, error: `${test.title}: ${refusal} Nothing was started.` }
  const effect = row.kind === 'AB'
    ? 'From the next scheduler run, the new orders rule A decides are split 50 / 50 by order number: half are asked by A, half get B’s timing and sentiment check.'
    : `From the next scheduler run, new ${test.title.split(' · ')[0]} orders${row.productType ? ` of ${row.productType}` : ''} are split by order number: each group is first asked on its day after delivery${row.holdoutPct > 0 ? `, and ${row.holdoutPct}% of the orders (the holdout) get no review request at all` : ''}.`
  return {
    ok: true,
    preview: {
      action: 'start-review-timing-test',
      summary: `Start the ${row.kind === 'AB' ? 'A/B split' : 'timing test'} ${test.title}`,
      test,
      effect,
      ends: test.ends,
      note: 'It changes when real buyers are asked (and, with a holdout, that some are not asked). Stop it at any time on the Timing page or the rule’s A/B card; the buyers it held out are not asked later, and requests already sent cannot be taken back.',
    },
  }
}

const startTool: AgentTool = {
  name: 'start-review-timing-test',
  title: 'Start a review timing test',
  input: startInput,
  requires: [F.reviewsManage],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Start a timing test or an A/B split of this business\'s review requests (made on Reviews › Requests › Timing, or a '
    + 'rule\'s A/B split card): from the next scheduler run, new orders of its market are split by order number between '
    + 'its groups — different first-try days after delivery, or rule A and its copy B — and a holdout group gets no review '
    + 'request at all. It changes when real buyers are asked, so a person approves it in Nexus before it starts. Stopping '
    + 'it needs no approval; the buyers it held out are not asked later and sent requests cannot be taken back.',
  handler: (args) => previewStart(args as StartArgs),
  async execute(args, ctx) {
    const a = args as StartArgs
    const checked = await freshOrStale(() => previewStart(a), ctx, ['test'], 'the test')
    if ('refusal' in checked) return checked.refusal
    const { markTestRunning } = await svc()
    const started = await markTestRunning(a.testId, ctx.approvalId ?? null)
    if (!started) return { ok: false, error: 'The test was stopped or started meanwhile. Nothing was changed.' }
    return {
      ok: true,
      data: { testId: a.testId, status: 'RUNNING' },
      change: { before: { testId: a.testId, status: 'WAITING_APPROVAL' }, after: { testId: a.testId, status: 'RUNNING' } },
    }
  },
}

// ── apply-review-timing-winner ──────────────────────────────────────────────────────────────────────────────────────

const applyInput = z.object({
  testId: z.string().trim().min(1).max(64).describe('the finished timing test (Reviews › Requests › Timing)'),
  armId: z.string().trim().min(1).max(64).describe('the winning group of the test; "before" puts back what was there before its winner was applied'),
})
type ApplyArgs = z.infer<typeof applyInput>

async function previewApply(a: ApplyArgs): Promise<ToolResult> {
  const { timingTestFacts, testSummary, resultOf, storedOf, winnerTarget } = await svc()
  const { applyHeld } = await import('../../reviews/review-timing-test-math.js')
  const facts = await timingTestFacts(a.testId)
  if (!facts) return { ok: false, error: 'This timing test is not in this business. Nothing was changed.' }
  const { row, names } = facts
  const test = testSummary(row, names)
  const stored = storedOf(row)
  if (a.armId === BEFORE) {
    const applied = stored.applied
    if (!applied) return { ok: false, error: `${test.title}: no winner of this test is applied, so there is nothing to put back. Nothing was changed.` }
    return {
      ok: true,
      preview: {
        action: 'apply-review-timing-winner',
        summary: `Put back the first try of “${applied.ruleName}” from before the timing test’s winner`,
        test,
        winner: { label: BEFORE, delayDays: applied.before.sendDelayDays },
        rule: { mode: applied.created ? 'turn-off' : 'update', id: applied.ruleId, name: applied.ruleName },
        from: { delayDays: applied.delayDays },
        to: applied.created ? { delayDays: null, words: 'the rule the winner added is turned off (not deleted)' } : { delayDays: applied.before.sendDelayDays, minDays: applied.before.minDays, maxDays: applied.before.maxDays },
        note: 'Changes Nexus only: the rule decides the first try of orders scheduled from the next run; requests already queued keep their day.',
      },
    }
  }
  const arm = row.arms.find((x) => x.id === a.armId)
  if (!arm || arm.holdout || arm.delayDays == null) return { ok: false, error: `${test.title}: that group is not a first-try day of this test. Nothing was changed.` }
  if (stored.applied) return { ok: false, error: `${test.title}: its winner was applied already (“${stored.applied.ruleName}”, day ${stored.applied.delayDays}). Nothing was changed.` }
  const { result } = await resultOf(row)
  const held = applyHeld(row, result)
  if (held) return { ok: false, error: `${test.title}: ${held} Nothing was changed.` }
  if (result.leaderId !== arm.id) return { ok: false, error: `${test.title}: ${arm.label} is not the winner. Nothing was changed.` }
  const target = await winnerTarget(row)
  return {
    ok: true,
    preview: {
      action: 'apply-review-timing-winner',
      summary: `${target.mode === 'create' ? 'Add the rule' : 'Change the rule'} “${target.name}”: first try on day ${arm.delayDays} after delivery`,
      test,
      winner: { label: arm.label, delayDays: arm.delayDays },
      result: { words: result.words, sure: result.sure, sureWords: result.sureWords },
      rule: { mode: target.mode, id: target.ruleId, name: target.name },
      from: { delayDays: target.fromDays, words: target.fromWords },
      to: { delayDays: arm.delayDays },
      note: target.mode === 'create'
        ? `Adds the rule “${target.name}” (Amazon ${test.market}${row.productType ? `, ${row.productType}` : ''}) with the first try on day ${arm.delayDays} and the other settings of the rule that decides these orders now; other products keep their rule. Changes Nexus only, from the next scheduler run.`
        : `Changes the first try of “${target.name}” to day ${arm.delayDays}. Changes Nexus only, from the next scheduler run; requests already queued keep their day.`,
    },
  }
}

const applyTool: AgentTool = {
  name: 'apply-review-timing-winner',
  title: 'Apply a timing test’s winner',
  input: applyInput,
  requires: [F.reviewsManage],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  description:
    'Apply the winning first-try day of a finished review timing test of this business: the rule for exactly that Amazon '
    + 'market and product type asks on that day after delivery, or such a rule is added with the other settings of the '
    + 'rule that decides those orders now. Only a winner at least 80% sure, after the test has enough counted orders. '
    + 'armId "before" puts back what was there before (a rule it added is turned off, not deleted). A person approves it '
    + 'in Nexus first; it changes Nexus only, from the next scheduler run.',
  handler: (args) => previewApply(args as ApplyArgs),
  async execute(args, ctx) {
    const a = args as ApplyArgs
    const checked = await freshOrStale(() => previewApply(a), ctx, ['test', 'winner', 'rule', 'from', 'to'], 'the test')
    if ('refusal' in checked) return checked.refusal
    const { timingTestFacts, applyWinnerToRule, putBackBeforeWinner } = await svc()
    const facts = await timingTestFacts(a.testId)
    if (!facts) return { ok: false, error: 'This timing test is gone. Nothing was changed.' }
    const by = `${ctx.via}:${ctx.userId ?? 'unknown'}`
    const change = a.armId === BEFORE ? await putBackBeforeWinner(facts.row) : await applyWinnerToRule(facts.row, a.armId, by)
    return { ok: true, data: change.after, change }
  },
  undo: {
    async current(change: ToolChange) {
      const after = (change.after ?? {}) as { testId?: string; ruleId?: string | null }
      if (!after.testId) return null
      const { winnerRuleNow } = await svc()
      return winnerRuleNow(after.testId, after.ruleId ?? null)
    },
    request(change: ToolChange) {
      const before = (change.before ?? {}) as { armId?: string }
      const after = (change.after ?? {}) as { testId?: string; armId?: string }
      if (!after.testId) return { refusal: 'This change does not name its timing test.' }
      if (after.armId === BEFORE) {
        return before.armId && before.armId !== BEFORE
          ? { tool: 'apply-review-timing-winner', args: { testId: after.testId, armId: before.armId } }
          : { refusal: 'This change does not name the winner it took back.' }
      }
      return { tool: 'apply-review-timing-winner', args: { testId: after.testId, armId: BEFORE } }
    },
  },
}

export const REVIEW_TIMING_TEST_TOOLS: AgentTool[] = [startTool, applyTool]
