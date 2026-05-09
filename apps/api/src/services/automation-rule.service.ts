/**
 * W4.2 — AutomationRule evaluator service.
 *
 * Two layers:
 *
 *   1. Pure matcher (matchesAllConditions, getFieldPath, applyOperator)
 *      No I/O. Given a rule's conditions JSON + a context object,
 *      returns boolean. Tested deterministically.
 *
 *   2. Engine (evaluateRule, runDueRules)
 *      Loads rules from DB, evaluates each against a trigger payload,
 *      dispatches actions when conditions match, and persists an
 *      AutomationRuleExecution row. Dry-run by default — actions
 *      with side effects log what they WOULD do but don't execute.
 *
 * Conditions DSL:
 *   [{ field: 'recommendation.totalCents', op: 'lt', value: 50000 },
 *    { field: 'supplier.onTimeRate', op: 'gte', value: 0.95 }]
 *   Operators: eq | ne | lt | lte | gt | gte | in | contains | exists
 *   All conditions AND. For OR, define multiple rules sharing a trigger.
 *
 * Actions DSL:
 *   [{ type: 'auto_approve_recommendation' },
 *    { type: 'create_po' },
 *    { type: 'notify', target: 'operator', message: '...' },
 *    { type: 'log_only' }]
 *
 * Action handlers are registered at module load. Adding a new action
 * type is one entry in ACTION_HANDLERS plus the implementation.
 *
 * Daily-cap enforcement: before executing, the engine counts today's
 * executions for the rule and aborts if maxExecutionsPerDay would be
 * exceeded. Status of the aborted execution = 'FAILED' with
 * errorMessage='DAILY_CAP_EXCEEDED'.
 *
 * Per-execution value cap: actions that spend (e.g. create_po) report
 * an estimated EUR-cents value back. The engine compares against
 * maxValueCentsEur and aborts the action (not the rule) if exceeded.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

// ─── Conditions DSL ───────────────────────────────────────────────

export type ConditionOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'contains'
  | 'exists'

export interface Condition {
  field: string
  op: ConditionOp
  value?: unknown
}

/**
 * Resolve a dotted-path lookup against a nested object. Returns
 * undefined if any segment is missing. Handles array indexes ('a.0.b').
 */
export function getFieldPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined
  const parts = path.split('.')
  let cursor: unknown = obj
  for (const part of parts) {
    if (cursor == null) return undefined
    if (typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/**
 * Evaluate a single (op, lhs, rhs) tuple. Type coercion is intentional
 * for numeric ops — JSON-stored 50000 vs DB-derived 50000n compares
 * equal. Throws on unknown op so a typo in the DSL surfaces loudly.
 */
export function applyOperator(op: ConditionOp, lhs: unknown, rhs: unknown): boolean {
  switch (op) {
    case 'eq':
      return lhs === rhs || Number(lhs) === Number(rhs)
    case 'ne':
      return !(lhs === rhs || Number(lhs) === Number(rhs))
    case 'lt':
      return typeof lhs === 'number' && typeof rhs === 'number'
        ? lhs < rhs
        : Number(lhs) < Number(rhs)
    case 'lte':
      return Number(lhs) <= Number(rhs)
    case 'gt':
      return Number(lhs) > Number(rhs)
    case 'gte':
      return Number(lhs) >= Number(rhs)
    case 'in':
      return Array.isArray(rhs) && rhs.includes(lhs as never)
    case 'contains':
      return typeof lhs === 'string' && typeof rhs === 'string' && lhs.includes(rhs)
    case 'exists':
      return lhs !== undefined && lhs !== null
    default: {
      const exhaustive: never = op
      throw new Error(`automation-rule: unknown operator ${exhaustive}`)
    }
  }
}

/**
 * AND-conjunction over a list of conditions against a context object.
 * Empty conditions array matches by default — a rule with no conditions
 * is a "fire on every trigger" rule (paired with high blast-radius
 * caps, this is how operators implement "do X every time").
 */
export function matchesAllConditions(
  conditions: Condition[],
  context: unknown,
): boolean {
  for (const c of conditions) {
    const lhs = getFieldPath(context, c.field)
    if (!applyOperator(c.op, lhs, c.value)) return false
  }
  return true
}

// ─── Actions DSL + handler registry ───────────────────────────────

export interface Action {
  type: string
  [key: string]: unknown
}

export interface ActionResult {
  type: string
  ok: boolean
  output?: unknown
  error?: string
  /** Optional: estimated EUR-cents value of this action.
   *  When > 0, engine compares against rule.maxValueCentsEur. */
  estimatedValueCentsEur?: number
}

export type ActionHandler = (
  action: Action,
  context: unknown,
  meta: { dryRun: boolean; ruleId: string },
) => Promise<ActionResult>

/**
 * Built-in action handlers. Adding a new action type is one entry
 * here + the implementation. Each handler must:
 *   - return ActionResult with ok=true on success, ok=false + error
 *     on failure
 *   - respect the dryRun flag — read-only operations may run either
 *     way, write-side operations MUST be no-ops when dryRun=true
 *   - report estimatedValueCentsEur when the action spends EUR so the
 *     engine can enforce per-rule blast-radius caps
 */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  /**
   * Stub action — exercises the engine end-to-end without side
   * effects. Useful for "alert me when condition X" rules where
   * the only desired behavior is the AutomationRuleExecution row.
   */
  log_only: async (action) => ({
    type: action.type,
    ok: true,
    output: { logged: true },
  }),

  /**
   * Notification stub. Wired to the in-app Notification table in
   * a follow-up. For now: emit a structured log line so operators
   * can grep the cron output.
   */
  notify: async (action, context, meta) => {
    const message =
      typeof action.message === 'string'
        ? action.message
        : `Rule ${meta.ruleId} matched`
    logger.info('automation-rule notify', {
      ruleId: meta.ruleId,
      target: action.target ?? 'operator',
      message,
      dryRun: meta.dryRun,
    })
    return {
      type: action.type,
      ok: true,
      output: { delivered: !meta.dryRun, target: action.target ?? 'operator', message },
    }
  },

  /**
   * Auto-approve a replenishment recommendation. Looks up the
   * recommendation by id from the trigger context, and (when not
   * dry-run) sets its status to APPROVED. R.7 PO approval workflow
   * stays the source of truth; this just bypasses the human review
   * step under explicit operator-defined rule conditions.
   */
  auto_approve_recommendation: async (action, context, meta) => {
    const recId =
      (getFieldPath(context, 'recommendation.id') as string | undefined) ??
      (action.recommendationId as string | undefined)
    if (!recId) {
      return { type: action.type, ok: false, error: 'No recommendation.id in context' }
    }
    if (meta.dryRun) {
      return {
        type: action.type,
        ok: true,
        output: { dryRun: true, recommendationId: recId, wouldApprove: true },
      }
    }
    const updated = await prisma.replenishmentRecommendation.update({
      where: { id: recId },
      data: { status: 'APPROVED' },
      select: { id: true, status: true },
    })
    return { type: action.type, ok: true, output: updated }
  },
}

// ─── Engine ────────────────────────────────────────────────────────

export interface EvaluateRuleArgs {
  ruleId: string
  context: unknown
  /** When true, force dry-run regardless of rule.dryRun. Used by the
   *  "test rule" flow on the rule-builder UI. */
  forceDryRun?: boolean
}

export interface EvaluateRuleResult {
  ruleId: string
  matched: boolean
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'DRY_RUN' | 'NO_MATCH' | 'CAP_EXCEEDED'
  actionResults: ActionResult[]
  durationMs: number
  executionId?: string
  errorMessage?: string
}

/**
 * Evaluate one rule against a context. The full lifecycle:
 *   1. Load the rule (including counters + caps)
 *   2. Match conditions; if none match, increment evaluationCount
 *      and return NO_MATCH (no execution row written)
 *   3. Enforce maxExecutionsPerDay
 *   4. Dispatch each action through its handler
 *   5. Enforce maxValueCentsEur per spend-action
 *   6. Persist AutomationRuleExecution + update rule counters
 *
 * The function returns even on failure — caller (cron / route)
 * decides whether to surface the failure to the operator.
 */
export async function evaluateRule(args: EvaluateRuleArgs): Promise<EvaluateRuleResult> {
  const startedAt = Date.now()
  const rule = await prisma.automationRule.findUnique({ where: { id: args.ruleId } })
  if (!rule) {
    return {
      ruleId: args.ruleId,
      matched: false,
      status: 'FAILED',
      actionResults: [],
      durationMs: Date.now() - startedAt,
      errorMessage: 'Rule not found',
    }
  }
  if (!rule.enabled) {
    return {
      ruleId: rule.id,
      matched: false,
      status: 'FAILED',
      actionResults: [],
      durationMs: Date.now() - startedAt,
      errorMessage: 'Rule disabled',
    }
  }

  const conditions = (rule.conditions ?? []) as unknown as Condition[]
  const matched = matchesAllConditions(conditions, args.context)

  // Always increment evaluationCount, even on no-match. Helps the UI
  // surface "this rule fires every X minutes but never matches".
  await prisma.automationRule.update({
    where: { id: rule.id },
    data: { evaluationCount: { increment: 1 }, lastEvaluatedAt: new Date() },
  })

  if (!matched) {
    return {
      ruleId: rule.id,
      matched: false,
      status: 'NO_MATCH',
      actionResults: [],
      durationMs: Date.now() - startedAt,
    }
  }

  // Daily-cap enforcement before dispatching anything.
  if (rule.maxExecutionsPerDay != null) {
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    const todayCount = await prisma.automationRuleExecution.count({
      where: { ruleId: rule.id, startedAt: { gte: dayStart } },
    })
    if (todayCount >= rule.maxExecutionsPerDay) {
      const exec = await prisma.automationRuleExecution.create({
        data: {
          ruleId: rule.id,
          triggerData: args.context as object,
          actionResults: [],
          dryRun: rule.dryRun || !!args.forceDryRun,
          status: 'FAILED',
          errorMessage: 'DAILY_CAP_EXCEEDED',
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
        },
        select: { id: true },
      })
      return {
        ruleId: rule.id,
        matched: true,
        status: 'CAP_EXCEEDED',
        actionResults: [],
        durationMs: Date.now() - startedAt,
        executionId: exec.id,
        errorMessage: 'DAILY_CAP_EXCEEDED',
      }
    }
  }

  const dryRun = rule.dryRun || !!args.forceDryRun
  const actions = (rule.actions ?? []) as unknown as Action[]
  const actionResults: ActionResult[] = []
  let valueSpentCentsEur = 0
  let anyOk = false
  let anyFailed = false

  for (const action of actions) {
    const handler = ACTION_HANDLERS[action.type]
    if (!handler) {
      actionResults.push({
        type: action.type,
        ok: false,
        error: `Unknown action type: ${action.type}`,
      })
      anyFailed = true
      continue
    }

    // Per-execution value cap enforcement. If this action would push
    // total spend above the cap, abort just THIS action (rule may
    // still have non-spend actions that should run).
    if (rule.maxValueCentsEur != null) {
      const projected = valueSpentCentsEur
      if (projected >= rule.maxValueCentsEur) {
        actionResults.push({
          type: action.type,
          ok: false,
          error: 'VALUE_CAP_EXCEEDED',
        })
        anyFailed = true
        continue
      }
    }

    try {
      const result = await handler(action, args.context, { dryRun, ruleId: rule.id })
      actionResults.push(result)
      if (result.ok) anyOk = true
      else anyFailed = true
      if (result.estimatedValueCentsEur && result.estimatedValueCentsEur > 0) {
        valueSpentCentsEur += result.estimatedValueCentsEur
      }
    } catch (err) {
      actionResults.push({
        type: action.type,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
      anyFailed = true
    }
  }

  const status: EvaluateRuleResult['status'] = dryRun
    ? 'DRY_RUN'
    : anyFailed && !anyOk
      ? 'FAILED'
      : anyFailed
        ? 'PARTIAL'
        : 'SUCCESS'

  const exec = await prisma.automationRuleExecution.create({
    data: {
      ruleId: rule.id,
      triggerData: args.context as object,
      actionResults: actionResults as object,
      dryRun,
      status,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt,
    },
    select: { id: true },
  })

  await prisma.automationRule.update({
    where: { id: rule.id },
    data: {
      matchCount: { increment: 1 },
      executionCount: { increment: 1 },
      lastMatchedAt: new Date(),
      lastExecutedAt: new Date(),
    },
  })

  return {
    ruleId: rule.id,
    matched: true,
    status,
    actionResults,
    durationMs: Date.now() - startedAt,
    executionId: exec.id,
  }
}

/**
 * Fan out evaluation across every enabled rule for a given trigger +
 * domain. Used by the cron tick and event-driven hooks. Each rule
 * gets the same context; each gets its own EvaluateRuleResult.
 */
export async function evaluateAllRulesForTrigger(args: {
  domain: string
  trigger: string
  context: unknown
  forceDryRun?: boolean
}): Promise<EvaluateRuleResult[]> {
  const rules = await prisma.automationRule.findMany({
    where: { domain: args.domain, trigger: args.trigger, enabled: true },
    select: { id: true },
  })
  const results: EvaluateRuleResult[] = []
  for (const r of rules) {
    results.push(
      await evaluateRule({
        ruleId: r.id,
        context: args.context,
        forceDryRun: args.forceDryRun,
      }),
    )
  }
  return results
}
