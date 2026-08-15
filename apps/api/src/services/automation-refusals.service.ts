/**
 * AUTO.P0 — the durable record of an automation refusal.
 *
 * A refusal is a rule that matched and was not allowed to act. Since ADX.1 (2026-08-04) one has
 * left no trace anywhere durable: the engine publishes it to `publishAdsExecution`, an in-process
 * ring buffer holding 50 events for 5 minutes on a single instance, and nothing else. So the
 * Automations page's `capped` chip and RuleDetail's "its daily cap declined to run it N times this
 * week" have both rendered **0 for every rule** since that date — a carefully-built surface over a
 * signal that stopped existing.
 *
 * ADX.1 was right to stop writing execution rows for refusals: the cap counted its own refusals,
 * each rejection raised the number the next tick compared against, and one cap-2 rule logged 2
 * legitimate runs against 790 self-inflicted rejections in a day. **An execution row records work
 * that happened; a refusal is work that did not.** This is a separate, aggregated record for
 * exactly that reason, and it can never feed back into the cap it describes.
 *
 * ⚠ A refusal is NEVER a failure. Nothing here writes to `AutomationRuleExecution`, and no consumer
 *   may fold these counts into a failure rate, a health percentage, or a colour shared with one.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

/** UTC calendar day, matching the cap counter's own `setUTCHours(0,0,0,0)` bucket exactly. */
export function refusalDayUtc(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export type RefusalReason =
  /** `maxExecutionsPerDay` — the rule matched and was refused outright. */
  | 'DAILY_CAP_EXCEEDED'
  /** `maxWritesPerDay` — a DEMOTION to dry-run, not a refusal to run. It still proposes and still
   *  notifies; it just stops writing. Named apart because collapsing the two would repeat the
   *  conflation this whole programme exists to remove. */
  | 'WRITE_CAP_REACHED'
  /** `maxValueCentsEur` — one action refused on value. Today this is recorded as a FAILED execution
   *  with a NULL errorMessage, which is how `Reduce bids on ACOS spike` logged 1,029 refusals as
   *  failures in eight days and looked catastrophically broken instead of switched off. */
  | 'VALUE_CAP_EXCEEDED'

export interface RecordRefusalArgs {
  actorKind?: 'rule' | 'engine'
  actorId: string
  reason: RefusalReason
  /** The operator-facing sentence, stored VERBATIM — SUB §5.5 requires the UI quote it unparaphrased. */
  detail: string
  entityType?: string | null
  entityId?: string | null
  at?: Date
}

/**
 * Increment the (actor, day, reason) counter and refresh the last-instance fields.
 *
 * Never throws and never rejects: a refusal record failing to persist must not turn a refusal into
 * an exception on the engine's hot path — that would convert a governed stop into an incident. It
 * logs loudly instead, because a silently under-counting refusal surface is the exact class of
 * defect this table exists to end.
 */
export async function recordAutomationRefusal(args: RecordRefusalArgs): Promise<void> {
  const at = args.at ?? new Date()
  const actorKind = args.actorKind ?? 'rule'
  const dayUtc = refusalDayUtc(at)
  try {
    await prisma.automationRefusalDaily.upsert({
      where: {
        actorKind_actorId_dayUtc_reason: { actorKind, actorId: args.actorId, dayUtc, reason: args.reason },
      },
      create: {
        actorKind,
        actorId: args.actorId,
        dayUtc,
        reason: args.reason,
        count: 1,
        lastAt: at,
        lastReason: args.detail,
        lastEntityType: args.entityType ?? null,
        lastEntityId: args.entityId ?? null,
      },
      update: {
        count: { increment: 1 },
        lastAt: at,
        lastReason: args.detail,
        lastEntityType: args.entityType ?? null,
        lastEntityId: args.entityId ?? null,
      },
    })
  } catch (err) {
    logger.error('[automation-refusal] refusal record FAILED to persist — refusal surfaces will under-count', {
      actorId: args.actorId,
      reason: args.reason,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Refusal counts per actor over a window of UTC days, for the surfaces that render a ceiling.
 *
 * Returns a map keyed by actorId so a caller holding a list of rules can attach counts without an
 * N+1. `dayUtc` is a string comparison on purpose — it is a calendar day, not an instant, and
 * comparing it as a timestamp is how a UTC/local boundary bug gets in.
 */
export async function refusalCountsByActor(days = 7): Promise<Map<string, {
  total: number
  byReason: Record<string, number>
  lastAt: Date | null
  lastReason: string | null
}>> {
  const since = refusalDayUtc(new Date(Date.now() - (Math.max(1, days) - 1) * 86_400_000))
  const rows = await prisma.automationRefusalDaily.findMany({
    where: { dayUtc: { gte: since } },
    select: { actorId: true, reason: true, count: true, lastAt: true, lastReason: true },
  })
  const out = new Map<string, { total: number; byReason: Record<string, number>; lastAt: Date | null; lastReason: string | null }>()
  for (const r of rows) {
    const cur = out.get(r.actorId) ?? { total: 0, byReason: {}, lastAt: null, lastReason: null }
    cur.total += r.count
    cur.byReason[r.reason] = (cur.byReason[r.reason] ?? 0) + r.count
    if (!cur.lastAt || r.lastAt > cur.lastAt) {
      cur.lastAt = r.lastAt
      cur.lastReason = r.lastReason
    }
    out.set(r.actorId, cur)
  }
  return out
}
