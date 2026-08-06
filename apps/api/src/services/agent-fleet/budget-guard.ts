/**
 * NAF.A — the fleet's spend ceilings (docs/AGENT_FLEET.md 9.2 §5-7).
 *
 * Three layers, all denials typed so the caller can record WHY on the run:
 *   • checkRunBudget — pure, consulted after every step; the per-run
 *     circuit breaker that aborts MID-run, not after.
 *   • checkCharterDayBudget — sums today's AgentRun.costUSD for one
 *     charter (agentKey — plan D5).
 *   • checkFleetDayBudget — sums today's fleet runs (mode NOT NULL)
 *     against AgentFleetState.dailyCeilingUSD.
 *
 * The day checks FAIL CLOSED: an unreadable ledger denies the spend. This
 * is the enforcement AgentTool.dailyBudgetUSD never got, so nothing
 * existing was reusable here.
 *
 * "Today" is computed as UTC bounds in JS and passed as Dates — never
 * AT TIME ZONE arithmetic in SQL (the Postgres trap on record).
 */
import prisma from '../../db.js'

// The success member carries explicit `undefined` fields because apps/api
// compiles with strict:false — truthiness narrowing of a discriminated
// union does NOT apply there, so callers read `.reason`/`.detail` without
// a narrow. (The vitest files are excluded from tsc and can't catch this.)
export type BudgetVerdict =
  | { ok: true; reason?: undefined; detail?: undefined }
  | {
      ok: false
      reason: 'tokens' | 'tool_calls' | 'charter_day' | 'fleet_day'
      detail: string
    }

export function checkRunBudget(
  used: { tokens: number; toolCalls: number },
  caps: { maxTokensPerRun: number; maxToolCallsPerRun: number },
): BudgetVerdict {
  if (used.tokens >= caps.maxTokensPerRun) {
    return {
      ok: false,
      reason: 'tokens',
      detail: `${used.tokens} of ${caps.maxTokensPerRun} run tokens used`,
    }
  }
  if (used.toolCalls >= caps.maxToolCallsPerRun) {
    return {
      ok: false,
      reason: 'tool_calls',
      detail: `${used.toolCalls} of ${caps.maxToolCallsPerRun} tool calls used`,
    }
  }
  return { ok: true }
}

function utcToday(): { gte: Date; lt: Date } {
  const now = new Date()
  const gte = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  return { gte, lt: new Date(gte.getTime() + 24 * 3600_000) }
}

export async function checkCharterDayBudget(
  charterKey: string,
  dailyBudgetUSD: number,
): Promise<BudgetVerdict> {
  try {
    const agg = await prisma.agentRun.aggregate({
      where: { agentKey: charterKey, createdAt: utcToday() },
      _sum: { costUSD: true },
    })
    const spent = Number(agg._sum.costUSD ?? 0)
    if (spent >= dailyBudgetUSD) {
      return {
        ok: false,
        reason: 'charter_day',
        detail: `$${spent.toFixed(4)} of $${dailyBudgetUSD.toFixed(2)} daily charter budget spent`,
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      reason: 'charter_day',
      detail: 'spend ledger unreadable — failing closed',
    }
  }
}

export async function checkFleetDayBudget(
  ceilingUSD: number,
): Promise<BudgetVerdict> {
  try {
    const agg = await prisma.agentRun.aggregate({
      where: { mode: { not: null }, createdAt: utcToday() },
      _sum: { costUSD: true },
    })
    const spent = Number(agg._sum.costUSD ?? 0)
    if (spent >= ceilingUSD) {
      return {
        ok: false,
        reason: 'fleet_day',
        detail: `$${spent.toFixed(4)} of $${ceilingUSD.toFixed(2)} fleet daily ceiling spent`,
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      reason: 'fleet_day',
      detail: 'spend ledger unreadable — failing closed',
    }
  }
}
