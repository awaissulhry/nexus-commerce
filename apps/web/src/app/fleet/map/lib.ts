/**
 * NAF.SB.M.1b — the map's payload types and its census.
 *
 * The census is the one-line count above the canvas, and it exists to repair a
 * defect that is live today: `FleetTab.tsx:551` renders a green pill reading
 * `running` above seven cards that all read `OFF`. The pill means *not
 * halted*. A beginner reads one word, and the word says the fleet is working.
 *
 * THE INVARIANT, and why it is a test rather than a convention. The Workers
 * stream shipped a tile reading 3 above four amber rows, then "All 3" over two
 * visible rows, and concluded that a summary and the rows underneath it must
 * be one derivation counted twice rather than two derivations that can
 * disagree. So here the count IS the predicate: `census()` filters by the same
 * `matches` the canvas dims by, and `lib.vitest.test.ts` asserts the identity,
 * the partition, and that a chip's count never moves when another is active.
 */
import { deriveStatus, classifyFailure, type CharterLike, type RunLike } from '../_shared/run-health'

/* ── the payload, as GET /api/agent/fleet/map returns it over JSON ──────── */

export interface MapRun extends RunLike {
  id: string
  createdAt: string
  endedAt: string | null
  status: string
  ok: boolean
  mode: string | null
  trigger: string
  errorMessage: string | null
  haltedReason: string | null
  findingCount: number
  costUSD: number
  latencyMs: number | null
  model: string | null
  provider: string | null
  workflowKey: string | null
  assignmentId: string | null
}

export interface Provenance {
  workflowKey: string
  kind: string
  source: string
}

export interface MapNode {
  key: string
  name: string
  description: string | null
  tier: string
  domain: string
  diagnostic: boolean
  templateKey: string | null
  lane: 'ranked' | 'standalone' | 'unwired'
  rank: number | null
  charter: CharterLike & {
    autonomyCap: string
    activeRevisionNumber: number | null
    modelProvider: string | null
    modelName: string | null
    cadence: string | null
    scopeMarketplaces: string[]
    scopePortfolioIds: string[]
    scopeCampaignIds: string[]
    dailyBudgetUSD: number
    maxTokensPerRun: number
    maxFindingsPerRun: number
    maxToolCallsPerRun: number
  }
  lastRun: MapRun | null
  recentRuns: MapRun[]
  runs: {
    window: number
    lifetime: number
    notOkWindow: number
    runningNow: boolean
    runningRunId: string | null
    runningSince: string | null
  }
  findings: { open: number; openExpired: number; bySeverity: Record<string, number> }
  plans: { authoredWindow: number; verdictsWindow: { pass: number; revise: number; block: number } }
  approvals: { waiting: number; scheduled: number }
  cost: {
    currency: string
    windowUSD: number
    runs: number
    todayUSD: number
    lifetimeUSD: number
    inputTokensWindow: number
    outputTokensWindow: number
  }
  declaredBy: Provenance[]
}

export interface MapEdge {
  id: string
  from: string
  to: string
  artifact: string
  declaredBy: Provenance[]
  counts: { crossed: number; dropped: number; conflicted: number }
  everCrossed: boolean
  dropped: Array<{ findingId: string; charterKey: string | null; reason: string }>
  conflicts: Array<{ findingIds: string[]; kind: string | null; resolution: string | null }>
  samples: Array<{
    id: string
    kind: string
    entityId: string
    entityName: string | null
    severity: string
  }>
  verdicts: { pass: number; revise: number; block: number } | null
  lastCritique: {
    planId: string
    verdict: string
    blockedCount: number
    /** The critic's own sentence. Already persisted; the map service used to
     *  read `criticNotes` and extract nothing from it but a count. */
    summary: string | null
    /** Set when `fleet-council.service.ts` overrode a passing verdict from
     *  deterministic pre-checks — in which case the summary above describes a
     *  verdict that is no longer the one in force. */
    overrideNote: string | null
  } | null
  /** The most recent verdict IGNORING the window, so "nothing reviewed" can
   *  tell "never" apart from "not in the last 7 days". Out-of-window content is
   *  never promoted into the window — this only says where to look. */
  latestCritique: { verdict: string; at: string; inWindow: boolean } | null
  lineage: 'plan-items' | 'none'
  lineageNote: string
}

export interface FleetMapPayload {
  asOf: string
  window: { key: string; days: number | null; since: string | null }
  state: {
    halted: boolean
    haltedAt: string | null
    haltReason: string | null
    haltedBy: string | null
    dailyCeilingUSD: number
    degraded: boolean
    spentTodayUSD: number
    spendLedgerReadable: boolean
  }
  schedule: Array<{
    key: string
    label: string
    schedule: string
    enabled: boolean
    nextFireAt: string | null
  }>
  wiring: {
    workflows: Array<{ workflowKey: string; kind: string; source: string; trigger: string }>
    degraded: boolean
    unorderedReason: string | null
  }
  nodes: MapNode[]
  edges: MapEdge[]
  totals: { runsLifetime: number; crossedLifetime: number }
  warnings: string[]
}

/* ── status, derived by the SHARED function ────────────────────────────── */

/**
 * The map mints no status words. There are six, they live in
 * `_shared/run-health.ts`, and the Workers roster calls the same function over
 * the same fields — so a worker cannot read one thing on the roster and
 * another here. Deriving it locally would be the exact drift that module's
 * header says it exists to prevent.
 */
export function statusOf(n: MapNode) {
  return deriveStatus(n.charter, n.lastRun, { runningNow: n.runs.runningNow })
}

/** A failure that is genuinely a failure. `halted: budget_tokens` is stored as
 *  `ok:false` and is a limit WORKING — amber, never red, and never counted as
 *  something broke. */
export function severeFailure(n: MapNode): boolean {
  const f = n.lastRun ? classifyFailure(n.lastRun) : null
  return f != null && f.severe
}

export function stoppedByLimit(n: MapNode): boolean {
  const f = n.lastRun ? classifyFailure(n.lastRun) : null
  return f != null && f.klass === 'limit'
}

/* ── the census ────────────────────────────────────────────────────────── */

export type ChipRank = 'subject' | 'state' | 'fact'

export interface Chip {
  id: string
  rank: ChipRank
  label: string
  matches: (n: MapNode) => boolean
  /** What this number counts, in words a beginner can act on. Rendered as the
   *  chip's tooltip; a number nobody can define is a number nobody trusts. */
  definition: string
  /** Facts render only when non-zero — except the ones marked here, which
   *  render at zero because the zero is the point. */
  alwaysRender?: boolean
  /** Shown instead of the definition when the count is zero and the zero has
   *  a structural cause the operator would otherwise misread. */
  zeroNote?: string
}

/**
 * Rank 1 is a PARTITION: every drawn node matches exactly one state chip, and
 * they sum to the total. Rank 2 chips overlap it deliberately — `off` outranks
 * everything in `deriveStatus`, so on a fleet that is entirely off every
 * failure would otherwise disappear into the word "off". That is the whole
 * reason rank 2 exists, and it is why the two ranks are visually separated
 * rather than run together into one line that appears to add up and does not.
 */
export const CHIPS: Chip[] = [
  {
    id: 'workers',
    rank: 'subject',
    label: 'workers',
    matches: () => true,
    definition:
      'Every worker drawn on this map: the ones your enabled routines name, plus the ones the nightly job runs itself. Retired workers are not drawn.',
  },

  /* rank 1 — the partition, one per status word */
  {
    id: 'running',
    rank: 'state',
    label: 'running',
    matches: (n) => statusOf(n).word === 'running',
    alwaysRender: true,
    definition: 'Working right now — a run has started and has not finished.',
    zeroNote: 'Nothing is running at this moment.',
  },
  {
    id: 'working',
    rank: 'state',
    label: 'working',
    matches: (n) => statusOf(n).word === 'working',
    definition: 'Switched on, allowed to act, and its last run finished cleanly.',
  },
  {
    id: 'off',
    rank: 'state',
    label: 'switched off',
    matches: (n) => statusOf(n).word === 'off',
    definition:
      'You have switched it off, or its dial is at OFF. It will not start, whatever the schedule says.',
  },
  {
    id: 'paused',
    rank: 'state',
    label: 'paused',
    matches: (n) => statusOf(n).word === 'paused',
    definition: 'Temporarily stopped, with an end date. A pause is never a forgotten off switch.',
  },
  {
    id: 'not-set-up',
    rank: 'state',
    label: 'not set up',
    matches: (n) => statusOf(n).word === 'not-set-up',
    definition:
      'It exists in code but has no settings row yet, so it cannot be switched on until one is created.',
  },
  {
    id: 'attention',
    rank: 'state',
    label: 'needs attention',
    matches: (n) => statusOf(n).word === 'attention',
    definition: 'Something about this worker needs a decision from you. The card says what.',
  },

  /* rank 2 — the facts the partition hides */
  {
    id: 'never-run',
    rank: 'fact',
    label: 'never run, ever',
    matches: (n) => n.runs.lifetime === 0,
    definition:
      'Has never run at all, over the whole life of the fleet — not just in the window you are looking at.',
  },
  {
    id: 'last-failed',
    rank: 'fact',
    label: 'last run failed',
    matches: (n) => severeFailure(n),
    definition:
      'Its most recent run ended in a real failure. A run stopped by one of its own limits is counted separately, because that is a limit working.',
  },
  {
    id: 'hit-a-limit',
    rank: 'fact',
    label: 'stopped by a limit',
    matches: (n) => stoppedByLimit(n),
    definition:
      'Its last run hit one of its own budget or token limits and stopped part-way. Nothing is broken — this is a safety limit doing its job.',
  },
  {
    id: 'waiting',
    rank: 'fact',
    label: 'waiting in Approvals',
    matches: (n) => n.approvals.waiting + n.approvals.scheduled > 0,
    alwaysRender: true,
    definition: 'Proposals from this worker that are waiting for your yes or no.',
    zeroNote:
      'No worker can put anything here yet: the fleet’s proposal tools are preview-only, so a plan that passes the critic still queues nothing.',
  },
]

export interface CensusRow {
  chip: Chip
  count: number
}

/** The count IS the predicate. Nothing else may produce these numbers. */
export function census(nodes: MapNode[], chips: Chip[] = CHIPS): CensusRow[] {
  return chips.map((chip) => ({ chip, count: nodes.filter(chip.matches).length }))
}

/** Chips render at zero only when the zero itself teaches something. */
export function visibleCensus(nodes: MapNode[], chips: Chip[] = CHIPS): CensusRow[] {
  return census(nodes, chips).filter(
    (r) => r.chip.rank === 'subject' || r.count > 0 || r.chip.alwaysRender === true,
  )
}

/** One sentence, one owner. Every surface that wants to say how much of the
 *  fleet is showing reads this rather than composing its own. */
export function filterSummary(nodes: MapNode[], activeChipId: string | null): string {
  if (!activeChipId) return ''
  const chip = CHIPS.find((c) => c.id === activeChipId)
  if (!chip) return ''
  const n = nodes.filter(chip.matches).length
  return `Showing ${n} of ${nodes.length} — ${chip.label}`
}

/* ── S1R · the verdict ─────────────────────────────────────────────────── */

/**
 * NAF.SB.M-S1R — the sentence that answers the section's question.
 *
 * The section's whole contract is *is anything wrong, and is anything even
 * on?*, and until S1R nothing on it answered that in a sentence: the answer had
 * to be assembled by the reader out of five equal pills, one of which read `7
 * off` in the same 11.5px as `1 never run`.
 *
 * TWO PROPERTIES THIS FUNCTION MUST KEEP.
 *
 * 1. **It invents no predicate.** Every number it speaks comes from `census()`,
 *    which is the same `matches` the canvas dims by. A verdict derived its own
 *    way is the drift `lib.vitest.test.ts` exists to make impossible — the
 *    Workers stream shipped that bug twice before this rule was written down.
 * 2. **It never speaks before the page has read.** `nodes` is `[]` until the
 *    first successful load, and `[]` produces the `empty` tone rather than a
 *    confident "0 workers" — measured on prod 2026-08-08, the old strip stated
 *    `0 workers · 0 running · 0 waiting in Approvals` as fact while its own
 *    request was still in flight, with those zeros as live buttons. The caller
 *    must still render the skeleton while `data == null`; this is the belt to
 *    that brace.
 */
export type VerdictTone = 'halted' | 'running' | 'failed' | 'off' | 'mixed' | 'empty'

export interface Verdict {
  tone: VerdictTone
  headline: string
  /** The reserved sub-line. Null is a legitimate answer; the caller keeps the
   *  space either way, because that row is also where the active filter's
   *  summary lands and a row that appears on click moves the graph. */
  detail: string | null
}

export function verdict(nodes: MapNode[], halted: boolean): Verdict {
  const total = nodes.length
  if (total === 0) {
    return { tone: 'empty', headline: 'No workers are wired up yet.', detail: null }
  }

  const counts = new Map(census(nodes).map((r) => [r.chip.id, r.count]))
  const n = (id: string) => counts.get(id) ?? 0

  /** The partition, spoken — optionally minus the state the headline already
   *  named, so no sentence says the same thing twice. Zero-count states are
   *  omitted here and handled as notes beside the lenses. */
  const rest = (skip: string | null) =>
    CHIPS.filter((c) => c.rank === 'state' && c.id !== skip && n(c.id) > 0)
      .map((c) => `${n(c.id)} ${c.label}`)
      .join(' · ')

  if (halted) {
    return {
      tone: 'halted',
      headline: 'The fleet is halted.',
      detail: 'Nothing will run, whatever any dial says.',
    }
  }

  const running = n('running')
  if (running > 0) {
    const r = rest('running')
    return {
      tone: 'running',
      headline: `${running} ${running === 1 ? 'worker is' : 'workers are'} running now.`,
      detail: r ? `The rest: ${r}.` : null,
    }
  }

  const failed = n('last-failed')
  if (failed > 0) {
    const r = rest(null)
    return {
      tone: 'failed',
      headline: `${failed} ${failed === 1 ? "worker's" : "workers'"} last run failed.`,
      detail: r ? `${r}.` : null,
    }
  }

  if (n('off') === total) {
    return {
      tone: 'off',
      headline: 'The whole fleet is switched off.',
      detail: 'Nothing will start, whatever any schedule says.',
    }
  }

  const on = total - n('off')
  const r = rest(null)
  return {
    tone: 'mixed',
    // The noun agrees with the denominator and the verb with the subject:
    // "1 of 3 workers is switched on", never "1 of 3 worker is".
    headline: `${on} of ${total} ${total === 1 ? 'worker' : 'workers'} ${
      on === 1 ? 'is' : 'are'
    } switched on.`,
    detail: r ? `${r}.` : null,
  }
}

/* ── S1R · the standing facts ──────────────────────────────────────────── */

/**
 * The two figures that sit beside the counts and are NOT lenses.
 *
 * The rule is the Workers strip's, and it is why these are here rather than in
 * `CHIPS`: **a lens counts workers and its number is exactly the nodes left
 * undimmed when you press it; a figure that does not filter may count something
 * else.** Open findings counts findings, so pressing it could never produce 64
 * rows over 7 nodes — it is a fact, and it must never become a button.
 *
 * `openExpired` is here because the map's payload has carried it since M.1a and
 * **no surface in the ten pages says it**: on prod today all 47 of the
 * self-test's open findings are past their expiry date.
 */
export interface FindingsTotals {
  open: number
  expired: number
  diagnostic: number
}

export function findingsTotals(nodes: MapNode[]): FindingsTotals {
  return {
    open: nodes.reduce((s, x) => s + x.findings.open, 0),
    expired: nodes.reduce((s, x) => s + x.findings.openExpired, 0),
    diagnostic: nodes.filter((x) => x.diagnostic).reduce((s, x) => s + x.findings.open, 0),
  }
}

/**
 * Money, at one precision per sentence.
 *
 * The shipped strip read `spent $0.0000 of the $2.00 daily ceiling today` — two
 * precisions inside one sentence, four decimals of them spent saying zero. A
 * sub-cent amount is real and must not round to `$0.00`, so it gets a form of
 * its own rather than more decimals for everybody.
 */
export function usd(v: number): string {
  if (v === 0) return '$0.00'
  if (v > 0 && v < 0.01) return '<$0.01'
  return `$${v.toFixed(2)}`
}

/** Said once, under the strip, and referenced rather than repeated. The
 *  self-test's findings are about the fleet, not about the account, and it
 *  holds most of them — a reader who is not told that will draw the wrong
 *  conclusion from every number above. */
export function diagnosticFootnote(nodes: MapNode[]): string | null {
  const diag = nodes.filter((n) => n.diagnostic)
  if (diag.length === 0) return null
  const findings = diag.reduce((s, n) => s + n.findings.open, 0)
  const total = nodes.reduce((s, n) => s + n.findings.open, 0)
  if (findings === 0 || total === 0) return null
  return `${findings} of the ${total} open findings belong to ${
    diag.length === 1 ? diag[0].name : `${diag.length} self-test workers`
  }, which checks the fleet rather than your account.`
}
