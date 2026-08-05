/**
 * ACR.4.1 — which rules have EARNED the next notch, and which only look like they have.
 *
 * `ads-graduation.ts` answers how far a rule may ever be trusted, from what it does. That is a
 * policy question and it is settled before a rule ever runs. This file answers the other one:
 * given that a rule is ALLOWED to reach AUTO, has it accumulated the evidence to deserve it?
 *
 * Graduation itself is never automatic. Nothing here writes; the operator moves the notch
 * through the existing PATCH /advertising/autonomy/rules/:id, which re-checks the ceiling on
 * its own. A service that could promote a rule would be the thing this whole programme exists
 * to avoid.
 *
 * ── Why there are two tracks, and why they are labelled differently ─────────────────────────
 *
 * Measured on prod 2026-08-05, before a line of this was written: 151 AdsRuleSuggestion rows —
 * 150 pending, ONE applied (2026-06-23), none dismissed, none edited. Six rules sit at PROPOSE
 * with an AUTO ceiling and not one has a single operator decision behind it.
 *
 * So the strict bar — "proposals you applied without changing them, N weeks running" — is the
 * only bar that means what it says, and today it surfaces nothing. That is the correct answer
 * and this file gives it. But a board that can only ever say "no" teaches an operator to stop
 * opening it, so the rules that have RUN clean are shown too, under their own verdict and
 * never under the word ready:
 *
 *   READY      — you applied its proposals, unmodified, in ≥3 distinct weeks, no failures.
 *                This is agreement, and it is the only evidence that transfers to AUTO.
 *   UNREVIEWED — it has run clean for ≥3 weeks and is holding proposals you have not decided
 *                on. Evidence that it WORKS, not that you agree with it. The queue is the
 *                blocker, and the queue is priced (ACR.4.4).
 *   UNSEEN     — it has run clean for ≥3 weeks and has never queued a proposal at all. The
 *                most dangerous of the three to graduate and the easiest to mistake for the
 *                safest: hundreds of clean evaluations, and you have never once seen what it
 *                would actually do. Called out rather than counted as progress.
 *   BUILDING / FAILING / CAPPED — not enough history yet · it has failed inside the window ·
 *                its action types hold it below AUTO forever.
 *
 * Read-only.
 */
import prisma from '../../db.js'
import { graduationCeiling } from './ads-graduation.js'
import { resolveAutonomy, type AutonomyLevel } from './ads-autonomy.js'

/**
 * Distinct weeks of clean history before a rule is surfaced as ready.
 *
 * Three, decided with the operator 2026-08-05: long enough that one good week is not mistaken
 * for a pattern, short enough that a rule working the priced queue can actually reach it. It is
 * a constant rather than a setting because a threshold an operator can lower on the day they
 * are impatient is not a threshold.
 */
export const GRADUATION_WEEKS = 3

/**
 * How far back evidence is read. Wider than the bar on purpose — the operator should be able
 * to see a rule's last eight weeks and judge the shape, not just meet a boolean.
 */
const WINDOW_DAYS = 56

/**
 * Evidence must be RECENT as well as sufficient. Three clean weeks in March do not describe a
 * rule's behaviour today: the account, the bids and the catalogue have all moved since. Without
 * this, a rule trusted once would stay "ready" forever on history nobody would re-check.
 */
const STALE_AFTER_DAYS = 14

/**
 * Matches after which "it has never proposed anything" stops being early days and becomes a
 * fact about the rule. Twenty is low deliberately: the point is to catch the state, and a rule
 * that has matched twenty times without queuing once is already telling you what it is.
 */
const UNSEEN_MIN_RUNS = 20

const DAY = 86_400_000

export type Verdict = 'ready' | 'unreviewed' | 'unseen' | 'building' | 'failing' | 'capped'

export interface RuleReadiness {
  ruleId: string
  name: string
  level: AutonomyLevel
  ceiling: AutonomyLevel
  ceilingReason: string
  verdict: Verdict
  /** One sentence the operator can act on — the whole point of the row. */
  summary: string
  evidence: {
    /** Distinct weeks in which you applied one of its proposals unchanged. The strict bar. */
    decisionWeeks: number
    /** Distinct weeks in which it ran and produced no failure. The weaker signal. */
    cleanWeeks: number
    /** Proposals you applied without touching the numbers. */
    appliedClean: number
    /** Proposals you applied after editing the magnitude — agreement with a correction. */
    appliedEdited: number
    dismissed: number
    pending: number
    /** Executions that failed inside the window, excluding the engine declining to run. */
    failures: number
    /** Every proposal it has ever queued. Zero here is what separates UNSEEN from UNREVIEWED. */
    proposalsEver: number
    /** When you last agreed with it, so staleness is checkable rather than asserted. */
    lastDecisionAt: string | null
    lastRunAt: string | null
  }
  /** True only for `ready`. The UI must never infer readiness from the verdict string. */
  canGraduate: boolean
  /** The notch a click would move it to. Always exactly one step, never a jump to AUTO. */
  nextLevel: AutonomyLevel | null
}

export interface GraduationBoard {
  generatedAt: string
  weeksRequired: number
  windowDays: number
  ready: RuleReadiness[]
  /** Everything else at PROPOSE, so "why is nothing ready" is answerable on the same screen. */
  others: RuleReadiness[]
  totals: { ready: number; unreviewed: number; unseen: number; building: number; failing: number; capped: number }
}

/** ISO week key for a date — the same bucketing the report schedules use for "a week". */
function isoWeek(d: Date): string {
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = p.getUTCDay() || 7
  p.setUTCDate(p.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(p.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((p.getTime() - yearStart.getTime()) / DAY + 1) / 7)
  return `${p.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

const ORDER: AutonomyLevel[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']
const nextNotch = (level: AutonomyLevel, ceiling: AutonomyLevel): AutonomyLevel | null => {
  const i = ORDER.indexOf(level)
  const next = ORDER[i + 1]
  if (!next) return null
  return ORDER.indexOf(next) <= ORDER.indexOf(ceiling) ? next : null
}

/** The evidence a verdict is decided from — every field a count or a date, no database. */
export interface VerdictInput {
  ceilingIsAuto: boolean
  ceilingReason: string
  failures: number
  decisionWeeks: number
  cleanWeeks: number
  editedApplies: number
  appliedClean: number
  pending: number
  proposalsEver: number
  runs: number
  lastDecisionAt: Date | null
}

/**
 * The whole judgement, as a pure function.
 *
 * Extracted from the board so the ORDER of these branches is testable without a database —
 * and the order is the substance here, not an implementation detail. Two of them would each
 * have produced a confidently wrong answer if placed differently:
 *
 *   · `capped` outranks everything. A structural rule with perfect history is still capped,
 *     because the ceiling is about what the rule DOES, not what it has done.
 *   · `unseen` outranks the week thresholds. It is a qualitative state, not a quantity of
 *     history — a rule that never queues a proposal cannot accumulate evidence by running
 *     longer, so ranking it by weeks reports progress toward something unreachable.
 */
export function decideVerdict(e: VerdictInput, now = new Date()): { verdict: Verdict; summary: string } {
  const stale = e.lastDecisionAt != null && now.getTime() - e.lastDecisionAt.getTime() > STALE_AFTER_DAYS * DAY

  if (!e.ceilingIsAuto) return { verdict: 'capped', summary: e.ceilingReason }

  if (e.failures > 0) {
    return {
      verdict: 'failing',
      summary: `${e.failures} execution${e.failures === 1 ? '' : 's'} failed in the last ${WINDOW_DAYS} days. A rule that cannot complete its own runs is not a candidate for running them unattended.`,
    }
  }
  if (e.decisionWeeks >= GRADUATION_WEEKS && e.editedApplies === 0 && !stale) {
    return {
      verdict: 'ready',
      summary: `You applied its proposals unchanged in ${e.decisionWeeks} separate weeks, most recently ${e.lastDecisionAt ? daysAgo(e.lastDecisionAt, now) : 'recently'}, and nothing it ran failed. That is agreement, repeated — the evidence AUTO asks for.`,
    }
  }
  if (e.decisionWeeks >= GRADUATION_WEEKS && e.editedApplies > 0) {
    return {
      verdict: 'building',
      summary: `${e.decisionWeeks} weeks of applied proposals, but you corrected the magnitude on ${e.editedApplies} of them. Editing before applying is agreement with the intent and disagreement with the number — and the number is what would run unattended.`,
    }
  }
  if (e.decisionWeeks >= GRADUATION_WEEKS && stale) {
    return {
      verdict: 'building',
      summary: `${e.decisionWeeks} clean weeks, but the last one was ${e.lastDecisionAt ? daysAgo(e.lastDecisionAt, now) : 'a while ago'}. Evidence older than ${STALE_AFTER_DAYS} days describes an account that has since moved.`,
    }
  }
  if (e.runs >= UNSEEN_MIN_RUNS && e.proposalsEver === 0) {
    return {
      verdict: 'unseen',
      summary: `${e.runs.toLocaleString('en-IE')} matches across ${e.cleanWeeks} week${e.cleanWeeks === 1 ? '' : 's'}, no failures — and not one queued proposal. You have never seen what it would actually do, so there is nothing here to agree with. That makes it the riskiest row on this board, not the safest.`,
    }
  }
  if (e.cleanWeeks >= GRADUATION_WEEKS && e.pending > 0) {
    return {
      verdict: 'unreviewed',
      summary: `${e.cleanWeeks} weeks of clean runs, and ${e.pending} proposal${e.pending === 1 ? '' : 's'} waiting on you. It works; you have not yet said whether you agree. Working the priced queue is what turns this into evidence.`,
    }
  }
  if (e.cleanWeeks >= GRADUATION_WEEKS) {
    return {
      verdict: 'unreviewed',
      summary: `${e.cleanWeeks} weeks of clean runs and nothing waiting. It has proposed ${e.proposalsEver} time${e.proposalsEver === 1 ? '' : 's'} in total — too little decided history to graduate on.`,
    }
  }
  return {
    verdict: 'building',
    summary: e.runs === 0
      ? 'Has not run inside the window. There is nothing to judge it on yet.'
      : `${e.cleanWeeks} of the ${GRADUATION_WEEKS} weeks needed, ${e.appliedClean} proposal${e.appliedClean === 1 ? '' : 's'} applied unchanged.`
        + (e.pending > 0 ? ` ${e.pending} ${e.pending === 1 ? 'is' : 'are'} waiting on you — deciding them is what builds the rest.` : ''),
  }
}

export async function getGraduationBoard(now = new Date()): Promise<GraduationBoard> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY)

  const [rules, protectionCount] = await Promise.all([
    prisma.automationRule.findMany({
      where: { domain: 'advertising' },
      select: {
        id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true,
        actions: true, lastExecutedAt: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } }),
  ])

  // Only rules sitting at PROPOSE are candidates for a notch up. A rule at AUTO has already
  // graduated; one at OFF or OBSERVE has a step to take first, and that step is not this
  // board's business.
  const atPropose = rules
    .map((r) => {
      const actionTypes = (Array.isArray(r.actions) ? r.actions : [])
        .map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
      return { r, actionTypes, ceiling: graduationCeiling({ actionTypes, hasKeywordProtections: protectionCount > 0 }) }
    })
    .filter((x) => resolveAutonomy(x.r) === 'PROPOSE')

  if (atPropose.length === 0) {
    return {
      generatedAt: now.toISOString(), weeksRequired: GRADUATION_WEEKS, windowDays: WINDOW_DAYS,
      ready: [], others: [],
      totals: { ready: 0, unreviewed: 0, unseen: 0, building: 0, failing: 0, capped: 0 },
    }
  }

  const ids = atPropose.map((x) => x.r.id)
  const [suggestions, execs] = await Promise.all([
    // Every proposal these rules ever queued — `proposalsEver` is what separates a rule you
    // have not got round to from a rule that has never shown you anything, and that needs the
    // full history, not the window.
    prisma.adsRuleSuggestion.findMany({
      where: { ruleId: { in: ids } },
      select: { ruleId: true, status: true, decidedAt: true, appliedResult: true },
    }),
    /**
     * Row-level rather than grouped, because weeks cannot be derived from a count. Bounded:
     * only the rules actually at PROPOSE, only the window.
     *
     * The DAILY_CAP_EXCEEDED exclusion must spell out the null branch. `NOT: { errorMessage: X }`
     * compiles to NOT (errorMessage = X), which is NULL — not TRUE — for the null errorMessage
     * every SUCCESS and DRY_RUN carries, so the terse form silently drops every clean row and
     * this board would report zero evidence for everything. Same trap the rules route hit.
     *
     * And the exclusion is load-bearing, not cosmetic. Measured over this window on prod:
     * 693,743 FAILED executions, of which 693,704 are DAILY_CAP_EXCEEDED — rows the engine
     * wrote when it DECLINED to run a rule, almost all of them from the self-ratcheting cap
     * bug fixed 2026-08-04 (the newest is 2026-08-03). Exactly 39 are real failures. Without
     * the exclusion every rule on this board reads as catastrophically broken and nothing
     * could ever graduate; with it, the 39 still count, which is the entire point.
     */
    prisma.automationRuleExecution.findMany({
      where: {
        ruleId: { in: ids },
        startedAt: { gte: since },
        OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
      },
      select: { ruleId: true, status: true, startedAt: true },
    }),
  ])

  const sugBy = new Map<string, typeof suggestions>()
  for (const s of suggestions) {
    const list = sugBy.get(s.ruleId) ?? []
    list.push(s)
    sugBy.set(s.ruleId, list)
  }
  const execBy = new Map<string, typeof execs>()
  for (const e of execs) {
    const list = execBy.get(e.ruleId) ?? []
    list.push(e)
    execBy.set(e.ruleId, list)
  }

  const rows: RuleReadiness[] = atPropose.map(({ r, ceiling }) => {
    const mine = sugBy.get(r.id) ?? []
    const runs = execBy.get(r.id) ?? []

    const applied = mine.filter((s) => s.status === 'applied')
    // The operator's own edit is recorded by the apply route as `appliedResult.override`. An
    // applied-with-edit proposal is agreement WITH A CORRECTION — evidence the rule's magnitude
    // is not yet right, which is precisely the thing that must not run unattended.
    const edited = applied.filter((s) => (s.appliedResult as Record<string, unknown> | null)?.override != null)
    const clean = applied.filter((s) => (s.appliedResult as Record<string, unknown> | null)?.override == null)
    const dismissed = mine.filter((s) => s.status === 'dismissed').length
    const pending = mine.filter((s) => s.status === 'pending').length

    const inWindow = clean.filter((s) => s.decidedAt != null && s.decidedAt >= since)
    const decisionWeeks = new Set(inWindow.map((s) => isoWeek(s.decidedAt!))).size
    const lastDecision = applied
      .map((s) => s.decidedAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null

    const failures = runs.filter((e) => e.status === 'FAILED').length
    const cleanWeeks = new Set(
      runs.filter((e) => e.status !== 'FAILED').map((e) => isoWeek(e.startedAt)),
    ).size

    const { verdict, summary } = decideVerdict({
      ceilingIsAuto: ceiling.maxLevel === 'AUTO',
      ceilingReason: ceiling.reason,
      failures,
      decisionWeeks,
      cleanWeeks,
      editedApplies: edited.length,
      appliedClean: clean.length,
      pending,
      proposalsEver: mine.length,
      runs: runs.length,
      lastDecisionAt: lastDecision,
    }, now)

    const ready = verdict === 'ready'
    return {
      ruleId: r.id,
      name: r.name,
      level: 'PROPOSE',
      ceiling: ceiling.maxLevel,
      ceilingReason: ceiling.reason,
      verdict,
      summary,
      evidence: {
        decisionWeeks,
        cleanWeeks,
        appliedClean: clean.length,
        appliedEdited: edited.length,
        dismissed,
        pending,
        failures,
        proposalsEver: mine.length,
        lastDecisionAt: lastDecision?.toISOString() ?? null,
        lastRunAt: r.lastExecutedAt?.toISOString() ?? null,
      },
      canGraduate: ready,
      // One notch. The dial moves PROPOSE → AUTO here, and the route re-checks the ceiling on
      // arrival — this value is a suggestion to the UI, never an authorisation.
      nextLevel: ready ? nextNotch('PROPOSE', ceiling.maxLevel) : null,
    }
  })

  const rank: Record<Verdict, number> = { ready: 0, unreviewed: 1, unseen: 2, failing: 3, building: 4, capped: 5 }
  const others = rows.filter((x) => x.verdict !== 'ready')
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.name.localeCompare(b.name))

  return {
    generatedAt: now.toISOString(),
    weeksRequired: GRADUATION_WEEKS,
    windowDays: WINDOW_DAYS,
    ready: rows.filter((x) => x.verdict === 'ready').sort((a, b) => b.evidence.decisionWeeks - a.evidence.decisionWeeks),
    others,
    totals: {
      ready: rows.filter((x) => x.verdict === 'ready').length,
      unreviewed: rows.filter((x) => x.verdict === 'unreviewed').length,
      unseen: rows.filter((x) => x.verdict === 'unseen').length,
      building: rows.filter((x) => x.verdict === 'building').length,
      failing: rows.filter((x) => x.verdict === 'failing').length,
      capped: rows.filter((x) => x.verdict === 'capped').length,
    },
  }
}

function daysAgo(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return days < 21 ? `${days} days ago` : `${Math.floor(days / 7)} weeks ago`
}
