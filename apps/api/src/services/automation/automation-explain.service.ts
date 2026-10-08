/**
 * R7 (MCP full control, part 06 §3) — "why did it do X": what an automation (or one of its rules) did in a window.
 *
 * Joins, per automation kind (each adapter's `explain`, automation-adapters.ts and the context adapters):
 *   · its runs — AutomationRuleExecution for rules, CronRun for engines, its own run table where it keeps one
 *   · its writes — matched by its EXACT actor strings (R2 made them exact: `automation:<ruleId>`,
 *     `automation:auto-bid`, `automation:rank-defend-<scheduleId>` …), never by a prefix, plus whether it has EVER
 *     written anything
 *   · its refusals — the durable refusal record (a cap that declined to run it is not a failure)
 * and says plainly what the numbers mean: "never written", "capped", "not running", "no runs", "failing".
 *
 * Risk 4 of part 06: a rule can be AUTO, busy, and never write (0 of 18 bid rules ever wrote, 2026-08). That is the
 * first thing this service says when it is true.
 *
 * Read-only, in the caller's business.
 */
import { automationAdapter, getAutomationCatalog, type AutomationEntry } from './automation-catalog.service.js'
import { cronRunsFact, lowest, type AutomationAdapter, type AutomationLevel, type ExplainFacts } from './automation-levels.js'

export const MAX_EXPLAIN_DAYS = 30
const CAP_REASONS = ['DAILY_CAP_EXCEEDED', 'WRITE_CAP_REACHED', 'VALUE_CAP_EXCEEDED']
/**
 * ONE BRAIN AB-6 — a write left on a lever another owner holds, each named as what it is (follow-up of #527):
 * `BRAIN_OWNED:<lever>` a product's brain, `OWNER_LOCKED:<lever>` the Owner's lock, `BID_BRAIN:bids` the bid brain. Rows
 * recorded before the holders were told apart read `LEVER_HELD:<lever>`: the keyword bids were only ever the bid brain's;
 * any other lever is said as either, which is all such a row knows.
 */
const HELD_PREFIXES: ReadonlyArray<[string, string]> = [
  ['BRAIN_OWNED:', 'a product\'s brain owns'],
  ['OWNER_LOCKED:', 'the Owner\'s lock holds'],
  ['BID_BRAIN:', 'the bid brain runs'],
]
const LEGACY_HELD = 'LEVER_HELD:'
/** Who held the lever of a held-lever reason, in words, and the lever; null when the reason is not one. Pure. */
function heldReason(reason: string): { who: string; lever: string } | null {
  for (const [prefix, who] of HELD_PREFIXES) if (reason.startsWith(prefix)) return { who, lever: reason.slice(prefix.length) }
  if (!reason.startsWith(LEGACY_HELD)) return null
  const lever = reason.slice(LEGACY_HELD.length)
  return { who: lever === 'bids' ? 'the bid brain runs' : 'a product\'s brain or the Owner\'s lock holds (recorded before they were told apart)', lever }
}

export type VerdictCode = 'never-written' | 'not-written-in-window' | 'capped' | 'lever-held' | 'refused' | 'not-running' | 'no-runs' | 'failing' | 'acting'

export interface Verdict {
  code: VerdictCode
  says: string
}

export interface AutomationActivity {
  automation: Pick<AutomationEntry, 'id' | 'key' | 'name' | 'level' | 'levelReason'>
  /** The rule, plan or schedule explained, when one was named. */
  row: ExplainFacts['subject']
  window: { days: number; since: string }
  runs: ExplainFacts['runs']
  writes: ExplainFacts['writes']
  refusals: ExplainFacts['refusals']
  /** What it found, when it keeps such a record (A19 auto-undo: its judgements). */
  findings?: ExplainFacts['findings']
  verdicts: Verdict[]
  notes: string[]
}

const FAILED = new Set(['FAILED', 'FAILURE', 'ERROR', 'failed', 'error'])

/** The plain sentences the numbers add up to. Pure. */
export function verdictsOf(level: AutomationLevel | null, levelReason: string, facts: ExplainFacts, days: number): Verdict[] {
  const out: Verdict[] = []
  const runs = facts.runs
  const writes = facts.writes
  const ran = runs?.total ?? 0
  if (level === 'OFF') out.push({ code: 'not-running', says: `It is OFF: ${levelReason}` })

  if (writes) {
    if (!writes.everWritten && (level === 'AUTO' || ran > 0)) {
      out.push({ code: 'never-written', says: `It has never written anything${ran ? `, though it ran ${ran} times in ${days} days` : ''}${level === 'AUTO' ? ' — at AUTO' : ''}. A run that writes nothing is a dry run, a proposal, a refusal at the write gate or a change to the same value.` })
    } else if (writes.total === 0 && ran > 0 && level === 'AUTO') {
      out.push({ code: 'not-written-in-window', says: `It ran ${ran} times at AUTO in ${days} days and wrote nothing (last write ${writes.lastEverAt}).` })
    } else if (writes.total > 0) {
      out.push({ code: 'acting', says: `It wrote ${writes.total} times in ${days} days (last ${writes.lastAt}).` })
    }
  }

  const capReasons = Object.entries(facts.refusals?.byReason ?? {}).filter(([reason]) => CAP_REASONS.includes(reason))
  const capRefusals = capReasons.reduce((n, [, count]) => n + count, 0) + (runs?.capped ?? 0)
  if (capRefusals > 0) {
    const detail = capReasons.map(([reason, count]) => `${reason} ${count}`).join(', ')
    out.push({ code: 'capped', says: `Its own caps stopped it ${capRefusals} times in ${days} days${detail ? ` (${detail})` : ''}: the cap, not the rule, decides how much it reaches.` })
  }
  // ONE BRAIN AB-6 — one owner per lever: what it left to each lever's holder, each named as what it is. Said apart from
  // a refusal, because nothing is wrong with the rule: the lever has another owner.
  const leverHeld = Object.entries(facts.refusals?.byReason ?? {}).flatMap(([reason, count]) => {
    const held = heldReason(reason)
    return held ? [{ ...held, count }] : []
  })
  if (leverHeld.length) {
    const n = leverHeld.reduce((sum, h) => sum + h.count, 0)
    const byWho = new Map<string, string[]>()
    for (const h of leverHeld) byWho.set(h.who, [...(byWho.get(h.who) ?? []), `${h.lever} ${h.count}`])
    out.push({ code: 'lever-held', says: `It left ${n} write${n === 1 ? '' : 's'} alone in ${days} days on levers another owner holds — ${[...byWho].map(([who, parts]) => `${who} ${parts.join(', ')}`).join('; ')}: one owner per lever, not a failure.` })
  }
  const otherRefusals = Object.entries(facts.refusals?.byReason ?? {}).filter(([reason]) => !CAP_REASONS.includes(reason) && !heldReason(reason))
  if (otherRefusals.length) {
    out.push({ code: 'refused', says: `It was refused ${otherRefusals.reduce((n, [, c]) => n + c, 0)} times (${otherRefusals.map(([r, c]) => `${r} ${c}`).join(', ')}).` })
  }

  if (runs && ran === 0 && level !== 'OFF' && level != null) out.push({ code: 'no-runs', says: `It has not run in ${days} days (${runs.source}).` })
  if (runs && ran > 0) {
    const failed = Object.entries(runs.byStatus).filter(([status]) => FAILED.has(status)).reduce((n, [, c]) => n + c, 0)
    if (failed / ran > 0.2) out.push({ code: 'failing', says: `${failed} of its ${ran} runs failed in ${days} days.` })
  }
  return out
}

/** What one automation (or one of its rows) did in the last `days` days; null when `rowId` is not one of its rows here. */
export async function explainAutomation(adapter: AutomationAdapter, opts: { rowId?: string; days?: number } = {}): Promise<AutomationActivity | null> {
  const days = Math.min(MAX_EXPLAIN_DAYS, Math.max(1, Math.round(opts.days ?? 7)))
  // Whole UTC days, today included: the grain the refusal record keeps (refusalCountsByActor), and a window that
  // reads the same for every call on the same day.
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const since = new Date(today.getTime() - (days - 1) * 86_400_000)
  const explainOpts = { rowId: opts.rowId, since, days }
  const facts: ExplainFacts | null = adapter.explain
    ? await adapter.explain(explainOpts)
    : opts.rowId
      ? null
      : { subject: null, runs: await cronRunsFact(adapter.crons, since), writes: null, refusals: null }
  if (!facts) return null
  const [entry] = await getAutomationCatalog((a) => a === adapter)
  // A named row is judged at its own level, held under what the automation as a whole may do (env, dial).
  const level: AutomationLevel | null = facts.subject?.level != null && entry.level != null
    ? lowest(facts.subject.level, entry.level)
    : (facts.subject?.level ?? entry.level)
  const levelReason = facts.subject?.level === 'OFF' ? 'this one is switched off.' : entry.levelReason
  return {
    automation: { id: entry.id, key: entry.key, name: entry.name, level: entry.level, levelReason: entry.levelReason },
    row: facts.subject,
    window: { days, since: since.toISOString() },
    runs: facts.runs,
    writes: facts.writes,
    refusals: facts.refusals,
    ...(facts.findings ? { findings: facts.findings } : {}),
    verdicts: verdictsOf(level, levelReason, facts, days),
    notes: [
      ...(facts.notes ?? []),
      ...(!facts.writes ? ['Its writes are not attributable from here: what it changed is not recorded under its own name.'] : []),
    ],
  }
}

export { automationAdapter }
