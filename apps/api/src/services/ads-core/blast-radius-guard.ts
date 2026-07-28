/**
 * Threshold-gated halt for bulk applies and unattended runs.
 *
 * `BlastRadius` was already computed for every bulksheet preview — budget
 * delta, archives, pauses, bid changes, large bid changes — and shown to the
 * operator. Nothing ever *gated* on it. That is fine while a human reads the
 * preview and clicks Apply; it is not fine the moment a schedule applies a file
 * nobody looked at.
 *
 * So this is the precondition for scheduled imports, not a nice-to-have
 * alongside them. A bad upstream file — a truncated export, a spreadsheet where
 * someone dragged a formula down a column — would otherwise rewrite the account
 * overnight and be discovered from the spend.
 *
 * Two design choices worth stating:
 *
 * - **Archives are counted separately and weighted hardest.** Archive is
 *   terminal on Amazon: there is no unarchive, by API or by UI. Every other
 *   change in a bad run is reversible; this one is not.
 * - **Thresholds are absolute AND proportional.** "10% of campaigns" is
 *   meaningless on an account with 11 of them, and "50 campaigns" is meaningless
 *   on one with 40,000. A run trips if it exceeds EITHER, so neither scale is
 *   left unguarded.
 *
 * Pure: no I/O. Unit-tested.
 */

export interface BlastInput {
  /** Rows that would actually change something. */
  changedRows: number
  /** Total rows considered, for the proportional test. */
  totalRows: number
  archives: number
  pauses: number
  bidChanges: number
  largeBidChanges: number
  /** Daily budget movement in EUR across every campaign touched. */
  budgetDeltaEur: number
  campaignsTouched: number
  conflicts: number
}

export interface BlastThresholds {
  maxChangedRows: number
  maxChangedPct: number
  maxArchives: number
  maxPauses: number
  maxLargeBidChanges: number
  /** Absolute daily-spend commitment change this run may make, in EUR. */
  maxBudgetDeltaEur: number
  /** Conflicts mean the file disagrees with live state — unattended, that is a stop. */
  maxConflicts: number
}

/**
 * Defaults are tuned for an UNATTENDED run and are deliberately tight. A human
 * looking at a preview can reasonably approve something bigger; a schedule at
 * 03:00 cannot, so the interactive path passes its own, looser thresholds.
 */
export const UNATTENDED_THRESHOLDS: BlastThresholds = {
  maxChangedRows: 500,
  maxChangedPct: 40,
  maxArchives: 25,
  maxPauses: 100,
  maxLargeBidChanges: 50,
  maxBudgetDeltaEur: 200,
  maxConflicts: 0,
}

export interface BlastVerdict {
  proceed: boolean
  /** Every breached threshold, not just the first — one fix at a time is slow. */
  breaches: Array<{ metric: string; value: number; limit: number; message: string }>
  /** One line for a log, a toast, or an alert. */
  summary: string
}

export function evaluateBlastRadius(input: BlastInput, thresholds: BlastThresholds = UNATTENDED_THRESHOLDS): BlastVerdict {
  const breaches: BlastVerdict['breaches'] = []
  const add = (metric: string, value: number, limit: number, message: string): void => {
    if (value > limit) breaches.push({ metric, value, limit, message })
  }

  add('changedRows', input.changedRows, thresholds.maxChangedRows,
    `${input.changedRows} rows would change (limit ${thresholds.maxChangedRows}).`)

  const pct = input.totalRows > 0 ? (input.changedRows / input.totalRows) * 100 : 0
  add('changedPct', Math.round(pct), thresholds.maxChangedPct,
    `${Math.round(pct)}% of the file would change (limit ${thresholds.maxChangedPct}%). A file that changes almost everything is usually a mistake, not an intention.`)

  add('archives', input.archives, thresholds.maxArchives,
    `${input.archives} entities would be ARCHIVED (limit ${thresholds.maxArchives}). Archive is terminal on Amazon — there is no unarchive.`)

  add('pauses', input.pauses, thresholds.maxPauses,
    `${input.pauses} entities would be paused (limit ${thresholds.maxPauses}).`)

  add('largeBidChanges', input.largeBidChanges, thresholds.maxLargeBidChanges,
    `${input.largeBidChanges} bids would move by more than half (limit ${thresholds.maxLargeBidChanges}) — that shape is usually a decimal-separator error.`)

  add('budgetDeltaEur', Math.abs(input.budgetDeltaEur), thresholds.maxBudgetDeltaEur,
    `Daily committed spend would move by €${Math.abs(input.budgetDeltaEur).toFixed(2)} across ${input.campaignsTouched} campaign(s) (limit €${thresholds.maxBudgetDeltaEur.toFixed(2)}).`)

  add('conflicts', input.conflicts, thresholds.maxConflicts,
    `${input.conflicts} row(s) conflict with live Amazon state (limit ${thresholds.maxConflicts}). Unattended, a conflict means the file is arguing with reality and nobody is there to adjudicate.`)

  const proceed = breaches.length === 0
  const summary = proceed
    ? `Within limits: ${input.changedRows} of ${input.totalRows} rows change, €${input.budgetDeltaEur.toFixed(2)} daily budget delta.`
    : `HALTED — ${breaches.length} threshold(s) exceeded: ${breaches.map((b) => b.metric).join(', ')}.`

  return { proceed, breaches, summary }
}

/** Build the guard's input from a bulksheet preview result. */
export function blastInputFromPreview(preview: {
  counts: { total: number; create: number; update: number; archive: number; conflict: number }
  blastRadius: {
    archives: number; pauses: number; bidChanges: number; largeBidChanges: number
    dailyBudget: { deltaEur: number; campaigns: number }
  }
}): BlastInput {
  return {
    changedRows: preview.counts.create + preview.counts.update + preview.counts.archive,
    totalRows: preview.counts.total,
    archives: preview.blastRadius.archives,
    pauses: preview.blastRadius.pauses,
    bidChanges: preview.blastRadius.bidChanges,
    largeBidChanges: preview.blastRadius.largeBidChanges,
    budgetDeltaEur: preview.blastRadius.dailyBudget.deltaEur,
    campaignsTouched: preview.blastRadius.dailyBudget.campaigns,
    conflicts: preview.counts.conflict,
  }
}
