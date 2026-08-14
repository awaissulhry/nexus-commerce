/**
 * SQP.3 Phase C — which ASINs tonight's request pass should ask for.
 *
 * ── What was wrong with "the top ten" ─────────────────────────────────────────────────────────
 *
 * `ourAsinsForMarketplace(mkt, 10)` returns the same ten ASINs every night, ordered ACTIVE-first with
 * no yield signal and no tiebreaker. Measured 2026-08-13: the pool is **694 distinct ASINs** across the
 * four live markets (DE 208, ES 121, FR 113, IT 252), so the nightly pass covers **5.8%** of it and the
 * other ~654 have never been asked for even once. It is not that the tail is barren — it is that the
 * tail has never been sampled.
 *
 * 🔴 And the ordering is inert in FR, which holds **zero ACTIVE listings** (117 DISCOVERABLE, 15
 * BUYABLE, 1 DRAFT). "Active listings first so a small limit covers what's actually selling" sorts
 * nothing there; FR's ten are an arbitrary ten of 113.
 *
 * ── The idea: settling PAYS for coverage ──────────────────────────────────────────────────────
 *
 * Phase B established that a week freezes, so an ASIN whose week has settled needs no report tonight.
 * That frees a slot. Rather than shrink the nightly pass, this hands the freed slot to an ASIN that has
 * never been asked for — so the same budget that today buys the same ten rows every night gradually
 * buys the pool instead. **No knob has to be turned for that to happen.**
 *
 * The budget itself is the one gated number, and it is deliberately left where it is. Raising it is an
 * operator decision, not a side effect of this file.
 *
 * ── Two orderings, because they answer different questions ────────────────────────────────────
 *
 * CORE is the head of the existing preference order — the ASINs believed to matter, asked for first so
 * a widening can never cost us what we already collect. ROTATION is everything else, ordered by how
 * long it has been since we last asked, so an ASIN that has never been requested sorts first and the
 * sweep reaches the whole pool instead of cycling through the same prefix.
 */

/** One ASIN as the selector sees it. `lastRequestedAt` is null when it has never been asked for. */
export interface SqpCandidate {
  asin: string
  /** position in the existing preference order — lower is more preferred. */
  rank: number
  lastRequestedAt: Date | null
}

export interface SqpSelection {
  chosen: string[]
  /** why each chosen ASIN is in the list, so the summary can say it. */
  reason: Record<string, 'core' | 'rotation'>
  skippedSettled: string[]
  skippedOutstanding: string[]
  /** slots the settle rule freed and rotation actually used — the number this design exists to move. */
  slotsFreedToRotation: number
}

/**
 * Pick tonight's ASINs.
 *
 * `coreCount` defaults to the whole budget, which reproduces today's behaviour exactly while nothing is
 * settled — the change only shows up once Phase B starts freeing slots.
 */
export function selectNightlyAsins(args: {
  candidates: SqpCandidate[]
  budget: number
  /** ASINs whose active week has stopped moving — a report for them would return what we hold. */
  settled: ReadonlySet<string>
  /** ASINs with a report already in flight — asking again queues behind it and delays the drain. */
  outstanding: ReadonlySet<string>
  coreCount?: number
}): SqpSelection {
  const budget = Math.max(0, Math.floor(args.budget))
  const coreCount = Math.max(0, Math.min(budget, args.coreCount ?? budget))

  const byRank = [...args.candidates].sort((a, b) => a.rank - b.rank)
  const skippedSettled: string[] = []
  const skippedOutstanding: string[] = []
  const eligible: SqpCandidate[] = []

  for (const c of byRank) {
    // Outstanding wins over settled: an in-flight report is a fact about right now, and settledness is
    // a fact about the past. Reporting an ASIN in both buckets would double-count it in the summary.
    if (args.outstanding.has(c.asin)) skippedOutstanding.push(c.asin)
    else if (args.settled.has(c.asin)) skippedSettled.push(c.asin)
    else eligible.push(c)
  }

  // 🔴 CORE is an identity set, not a survivor count — the top `coreCount` ASINs BY RANK, whether or
  // not they survive. Defining it as "the first coreCount eligible" instead lets the core walk down the
  // pool and swallow the very slots settling just freed, so rotation never gets one and Phase C does
  // nothing. A test caught that before it shipped.
  const coreIds = new Set(byRank.slice(0, coreCount).map((c) => c.asin))
  const core = eligible.filter((c) => coreIds.has(c.asin))
  const taken = new Set(core.map((c) => c.asin))

  // Least-recently-asked first, so a never-requested ASIN leads and the sweep reaches the tail.
  // Ties break on rank, never on array order, so two runs of the same night agree.
  const rotationPool = eligible
    .filter((c) => !taken.has(c.asin))
    .sort((a, b) => {
      const at = a.lastRequestedAt?.getTime() ?? -Infinity
      const bt = b.lastRequestedAt?.getTime() ?? -Infinity
      return at === bt ? a.rank - b.rank : at - bt
    })

  const rotation = rotationPool.slice(0, Math.max(0, budget - core.length))

  const reason: Record<string, 'core' | 'rotation'> = {}
  for (const c of core) reason[c.asin] = 'core'
  for (const c of rotation) reason[c.asin] = 'rotation'

  return {
    chosen: [...core, ...rotation].map((c) => c.asin),
    reason,
    skippedSettled,
    skippedOutstanding,
    // Only slots that settling freed AND rotation filled. A budget that was never full because the
    // pool is small did not free anything, and must not be reported as if it had.
    slotsFreedToRotation: Math.min(rotation.length, skippedSettled.length),
  }
}

/** One line for the cron summary — the pass has to be able to say what it covered and why. */
export function selectionSummary(marketplace: string, s: SqpSelection, poolSize: number): string {
  const core = s.chosen.filter((a) => s.reason[a] === 'core').length
  const rot = s.chosen.length - core
  const bits = [`${marketplace} ${s.chosen.length}/${poolSize}`]
  if (rot) bits.push(`${core} core + ${rot} rotating`)
  if (s.skippedSettled.length) bits.push(`${s.skippedSettled.length} settled`)
  if (s.skippedOutstanding.length) bits.push(`${s.skippedOutstanding.length} in flight`)
  return bits.join(' · ')
}
