/**
 * NAF.SB.W.1 — what a worker's state actually is, and what a failed run
 * actually means. One module, because the roster, the Activity page and the
 * worker's own page must not disagree about whether something is broken.
 *
 * Two findings from the production database drive every decision here
 * (docs/2026-08-07-naf-sbw-section-studies.md, Study 1):
 *
 * 1. "Failed" is four different things. Of 26 not-ok fleet runs, 21 could not
 *    reach the provider, 3 were refused for lack of credit, 1 broke its own
 *    output contract, and 1 was stopped by its token limit. Only the third is
 *    the worker's fault. Rendering one word for all four teaches an operator
 *    to distrust the wrong thing.
 *
 * 2. `halted: budget_tokens` is stored as `ok: false` and is not a failure at
 *    all — it is a limit doing exactly its job. It must never be coloured like
 *    a defect, or the operator learns that a working safety limit is a bug.
 *
 * And one structural rule: the "Needs attention" count on the health strip and
 * the amber rows in the table are the SAME derivation, so a strip reading 3
 * above a table showing 4 is impossible by construction rather than by care.
 */

/* ── the shapes we read, mirrored from the fleet API ───────────────────── */

export interface CharterLike {
  key: string
  domain: string
  enabled: boolean
  autonomyLevel: string
  degraded: boolean
  /** SB.W.1 — false = no settings row was ever created. null = unknown
   *  (the policy read itself failed, so `degraded` is the real story). */
  provisioned?: boolean | null
  pausedUntil?: string | null
  pausedReason?: string | null
}

export interface RunLike {
  status: string
  ok: boolean
  errorMessage?: string | null
  haltedReason?: string | null
  createdAt: string
  findingCount?: number
  costUSD?: string | number
}

/* ── failure classification ────────────────────────────────────────────── */

export type FailureClass =
  | 'provider-unreachable'
  | 'provider-refused'
  | 'contract'
  | 'limit'
  | 'unknown'

/** Who the operator should go and talk to. `nobody` is not a euphemism — a
 *  limit stopping a run is the system working. */
export type Blame = 'infrastructure' | 'billing' | 'worker' | 'nobody' | 'unknown'

export interface Failure {
  klass: FailureClass
  blame: Blame
  /** One sentence, written for someone who has never seen the fleet. */
  sentence: string
  /** `limit` is amber; everything else that is genuinely wrong is red. */
  severe: boolean
}

export function classifyFailure(run: RunLike): Failure | null {
  if (run.ok) return null
  // A run in flight is created with `ok: false` and only flips true when it
  // finishes. Reading that as a failure labels every running worker "did not
  // finish" while it is still perfectly well running.
  if (run.status === 'running') return null

  // A halt is checked first: it is recorded alongside an empty errorMessage,
  // and it is the one "failure" that is not one.
  if (run.haltedReason) {
    return {
      klass: 'limit',
      blame: 'nobody',
      sentence: `It hit one of its own limits and stopped part-way — ${humanHalt(run.haltedReason)}. That limit worked. Raise it, or accept the shorter answer.`,
      severe: false,
    }
  }

  const e = run.errorMessage ?? ''

  if (e.includes('fetch failed')) {
    return {
      klass: 'provider-unreachable',
      blame: 'infrastructure',
      sentence: 'Its last run could not reach the AI provider at all. That is a connection problem, not this worker.',
      severe: true,
    }
  }
  if (/credit balance|insufficient_quota|billing/i.test(e)) {
    return {
      klass: 'provider-refused',
      blame: 'billing',
      sentence: 'The AI provider refused the request — the account is out of credit.',
      severe: true,
    }
  }
  if (/schema validation|failed schema/i.test(e)) {
    return {
      klass: 'contract',
      blame: 'worker',
      sentence: 'Its answer did not match the format it promised, so nothing was written. This one is the worker itself — read its charter.',
      severe: true,
    }
  }
  return {
    klass: 'unknown',
    blame: 'unknown',
    sentence: e ? `It failed: ${truncate(e, 120)}` : 'It failed, and recorded no reason.',
    severe: true,
  }
}

/** `budget_tokens: 20142 of 20000 run tokens used` → `20,142 of 20,000 tokens`. */
function humanHalt(reason: string): string {
  const m = /^([a-z_]+):\s*(.*)$/.exec(reason)
  if (!m) return reason
  const [, kind, detail] = m
  const what = kind === 'budget_tokens' ? 'its token limit'
    : kind === 'budget_usd' ? 'its daily budget'
    : kind.replace(/_/g, ' ')
  return detail ? `${what} (${detail})` : what
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/* ── the six status words ──────────────────────────────────────────────── */

export type StatusWord =
  | 'not-set-up'
  | 'off'
  | 'paused'
  | 'running'
  | 'attention'
  | 'working'

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'busy'

export interface WorkerStatus {
  word: StatusWord
  /** What the badge says. */
  label: string
  tone: Tone
  /** The mandatory line under the badge. Never empty — a status word with no
   *  reason is the flattening this module exists to prevent. */
  reason: string
  /** Counts toward the health strip's "Needs attention" tile. */
  needsAttention: boolean
  /**
   * Two or three words naming WHY, for aggregation. The strip's tile says
   * "3 · 1 never set up · 2 failing" by tallying these, so the summary and the
   * rows underneath it are the same derivation counted twice rather than two
   * derivations that can disagree. Only meaningful when `needsAttention`.
   */
  tag: string
}

/**
 * Precedence, and it matters:
 *
 *   degraded → not provisioned → paused → running → off → failed → never run
 *
 * `degraded` outranks everything because when the policy read fails, every
 * other field alongside it is the fail-safe posture rather than a fact. `off`
 * outranks a failed last run deliberately: a worker the operator has switched
 * off is not asking for anything, whatever it did last time — but its reason
 * line still mentions the failure, because hiding it would be the other error.
 */
export function deriveStatus(
  charter: CharterLike,
  lastRun: RunLike | null,
  opts: { runningNow?: boolean } = {},
): WorkerStatus {
  const live = charter.enabled && charter.autonomyLevel !== 'OFF'
  const failure = lastRun ? classifyFailure(lastRun) : null

  if (charter.degraded) {
    return {
      word: 'attention',
      label: 'Needs attention',
      tone: 'bad',
      reason:
        'Its settings could not be read from the database. What you see here is the fail-safe posture, not your choices.',
      needsAttention: true,
      tag: 'settings unreadable',
    }
  }

  if (charter.provisioned === false) {
    return {
      word: 'not-set-up',
      label: 'Not set up',
      tone: 'neutral',
      reason:
        'This worker exists in code but has never had a settings row created. Until it does, it cannot be switched on.',
      needsAttention: true,
      tag: 'never set up',
    }
  }

  if (charter.pausedUntil && new Date(charter.pausedUntil).getTime() > Date.now()) {
    const until = new Date(charter.pausedUntil).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    })
    return {
      word: 'paused',
      label: 'Paused',
      tone: 'warn',
      reason: charter.pausedReason
        ? `Paused until ${until} — “${charter.pausedReason}”.`
        : `Paused until ${until}. A pause always has an end date, so it is never a forgotten off switch.`,
      needsAttention: true,
      tag: 'paused',
    }
  }

  if (opts.runningNow || lastRun?.status === 'running') {
    return {
      word: 'running',
      label: 'Running now',
      tone: 'busy',
      reason: lastRun ? `Started ${ago(lastRun.createdAt)}.` : 'A run is in flight.',
      needsAttention: false,
      tag: 'running',
    }
  }

  if (!live) {
    const tail = !lastRun
      ? ' It has never run.'
      : failure
        ? ` Its last run did not finish: ${lowerFirst(failure.sentence)}`
        : ''
    return {
      word: 'off',
      label: 'Off',
      tone: 'neutral',
      reason: `Switched off — it does not run, and it costs nothing.${tail}`,
      needsAttention: false,
      tag: 'off',
    }
  }

  if (failure) {
    return {
      word: 'attention',
      label: 'Needs attention',
      tone: failure.severe ? 'bad' : 'warn',
      reason: failure.sentence,
      needsAttention: true,
      // The tag names the CAUSE, so the strip can say "2 cannot reach the AI"
      // rather than "2 failing" — the operator's next step differs by class.
      tag: failure.klass === 'provider-unreachable' ? 'cannot reach the AI'
        : failure.klass === 'provider-refused' ? 'out of AI credit'
        : failure.klass === 'contract' ? 'breaking its contract'
        : failure.klass === 'limit' ? 'stopped by a limit'
        : 'failing',
    }
  }

  if (!lastRun) {
    return {
      word: 'attention',
      label: 'Needs attention',
      tone: 'warn',
      reason:
        'It is switched on but has never run. Either its schedule has not come round yet, or nothing is starting it.',
      needsAttention: true,
      tag: 'never run',
    }
  }

  const bits = [`Ran ${ago(lastRun.createdAt)}`]
  if (lastRun.findingCount != null) {
    bits.push(`${lastRun.findingCount} finding${lastRun.findingCount === 1 ? '' : 's'}`)
  }
  const cost = Number(lastRun.costUSD ?? 0)
  if (cost > 0) bits.push(`$${cost.toFixed(4)}`)
  return {
    word: 'working',
    label: 'Working',
    tone: 'good',
    reason: `${bits.join(' · ')}.`,
    needsAttention: false,
    tag: 'working',
  }
}

/* ── diagnostic workers ────────────────────────────────────────────────── */

/**
 * `fleet-selftest` holds 47 of 64 open findings and 38 of 47 runs. It checks
 * that the fleet itself works; its findings are not about the operator's
 * account. Counting it into headline numbers makes every figure on the page
 * mostly about a self-test.
 *
 * The charter declares this itself (`CharterDefinition.diagnostic`). A rule on
 * `domain` was tried first and is wrong twice over: `fleet-auditor` is
 * `domain: 'fleet'` and would be missed, and `domain: 'ops'` is exactly where
 * docs/AGENT_FLEET.md Part 6 puts `ops-schema-drift`, `ops-sync-health` and
 * `ops-tech-debt-triage` — real business analysts that a domain rule would
 * silently drop out of the totals the day they are written.
 */
export function isDiagnostic(charter: { diagnostic?: boolean; key?: string }): boolean {
  if (typeof charter.diagnostic === 'boolean') return charter.diagnostic
  // Deploy-window fallback only: the web can reach production ahead of the
  // API, and for those few minutes the flag is absent. Without this the
  // self-test's 47 findings would briefly land in the headline totals.
  // Delete once the field is live everywhere.
  return charter.key === 'fleet-selftest'
}

export const DIAGNOSTIC_HINT =
  'A diagnostic worker: it checks that the fleet itself is working. Its findings are about the fleet, not about your Amazon account, so it is left out of the totals above.'

/* ── shared time formatting ────────────────────────────────────────────── */

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
