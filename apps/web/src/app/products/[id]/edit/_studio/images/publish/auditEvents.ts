/**
 * PES.7 — the image-publish audit trail, read honestly. Pure, tested.
 *
 * 🔴 **The audit log and the job log are two records of the same events that cannot be joined.**
 * Measured across the complete audit trail for GALE-JACKET (all 71 `imagePublish*` entries, one
 * unpaginated page, not a sample):
 *
 * | action | n | channel | carries `jobId` |
 * |--------|---|---------|-----------------|
 * | `imagePublishStarted`   | 38 | AMAZON (all) | **38** |
 * | `imagePublishCompleted` | 14 | EBAY (all)   | **0** |
 * | `imagePublishFailed`    | 10 | EBAY (all)   | **0** |
 * | `imagePublishBulk`      |  9 | EBAY (all)   | 0 |
 *
 * The two channels log disjoint halves of the same story, and the halves have no key in common:
 *
 *  • **Amazon** writes a start — with the job id — and never writes an outcome. Its route has no
 *    `imagePublishCompleted` call at all; the code says the terminal status would be written
 *    "from `pollAndUpdateFeedJob` if/when we wire that", and it was never wired.
 *  • **eBay** writes outcomes with real error text, and never writes a start, and its outcome rows
 *    carry no job id — so an outcome here cannot be attributed to a row in the job list.
 *
 * Therefore this surface is presented as its own record and is never silently merged into the job
 * list. Correlating by timestamp and channel would look tidy and would attribute outcomes to jobs
 * on a guess; a wrong outcome against a named job is worse than an honest gap.
 *
 * `userId` is null on every one of the 71 entries, so this log cannot say who did anything, and
 * the surface must not imply a person.
 */

export interface AuditEntry {
  id: string
  action: string
  createdAt: string
  userId: string | null
  metadata: Record<string, unknown> | null
}

export type EventKind = 'started' | 'completed' | 'failed' | 'bulk' | 'other'

export interface PublishEvent {
  id: string
  kind: EventKind
  at: string
  /** The pill's word. Never the raw action or kind. */
  label: string
  /** The numbers this entry carries, if any — shown beside the pill rather than inside it. */
  facts: string | null
  channel: string | null
  marketplace: string | null
  /** Error text, for a failure. */
  detail: string | null
  /** Present only on Amazon starts — the only entries that carry one. */
  jobId: string | null
  /**
   * Amazon's feed id, and the same value the job row stores as `vendorEntityId` — so an operator
   * CAN match an Amazon start to its job row by eye, and can quote it to Seller Central. It is the
   * eBay half that has no shared key, which is what the surface's notice says.
   */
  reference: string | null
  /** A dry run is a rehearsal, and must never be counted as a send. */
  dryRun: boolean
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function kindOf(action: string): EventKind {
  switch (action) {
    case 'imagePublishStarted': return 'started'
    case 'imagePublishCompleted': return 'completed'
    case 'imagePublishFailed': return 'failed'
    case 'imagePublishBulk': return 'bulk'
    default: return 'other'
  }
}

/** The pill: what happened, in one word. */
function labelFor(kind: EventKind): string {
  switch (kind) {
    // "Submitted" and not "Published": a start is a dispatch, and on Amazon it is the ONLY thing
    // ever written — no outcome follows it, so the word must not promise one.
    case 'started': return 'Submitted'
    case 'completed': return 'Complete'
    case 'failed': return 'Failed'
    case 'bulk': return 'Bulk'
    default: return 'Recorded'
  }
}

/** The numbers, beside the pill. Kept out of the pill so a badge never reads as a sentence. */
function factsFor(kind: EventKind, m: Record<string, unknown>, dryRun: boolean): string | null {
  const parts: string[] = []
  const skus = num(m.skuCount)
  const pictures = num(m.pictureCount)
  const colourSets = num(m.colorSetCount)
  const batch = num(m.batchSize)

  if (kind === 'started') {
    if (skus !== null) parts.push(`${skus} SKUs`)
    // A dry run is a rehearsal. It must never be readable as a send, so this is spelled out in
    // full rather than compressed to a flag an operator has to know how to interpret.
    if (dryRun) parts.push('dry run — nothing was sent to the channel')
  } else if (kind === 'completed' || kind === 'failed') {
    if (pictures !== null) parts.push(`${pictures} picture${pictures === 1 ? '' : 's'}`)
    if (colourSets !== null && colourSets > 0) parts.push(`${colourSets} colour sets`)
  } else if (kind === 'bulk') {
    if (batch !== null) parts.push(`${batch} products`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function readAuditEntry(entry: AuditEntry): PublishEvent {
  const m = entry.metadata ?? {}
  const kind = kindOf(entry.action)
  const dryRun = m.dryRun === true
  return {
    id: entry.id,
    kind,
    at: entry.createdAt,
    label: labelFor(kind),
    facts: factsFor(kind, m, dryRun),
    channel: str(m.channel),
    marketplace: str(m.marketplace),
    detail: str(m.error),
    jobId: str(m.jobId),
    reference: str(m.feedId),
    dryRun,
  }
}

export interface AuditSummary {
  total: number
  byKind: Record<EventKind, number>
  /** Channels that logged a start but never an outcome — the gap worth naming. */
  channelsMissingOutcomes: string[]
  /** Channels that logged an outcome but never a start. */
  channelsMissingStarts: string[]
  /** Outcome events that carry no job id, and so cannot be tied to any job row. */
  unattributableOutcomes: number
  /** Distinct failure reasons, most frequent first. */
  failures: Array<{ message: string; count: number }>
  dryRuns: number
}

export function summariseAudit(entries: readonly AuditEntry[]): AuditSummary {
  const byKind: Record<EventKind, number> = {
    started: 0, completed: 0, failed: 0, bulk: 0, other: 0,
  }
  const starts = new Set<string>()
  const outcomes = new Set<string>()
  const failures = new Map<string, number>()
  let unattributableOutcomes = 0
  let dryRuns = 0

  for (const e of entries) {
    const ev = readAuditEntry(e)
    byKind[ev.kind]++
    if (ev.dryRun) dryRuns++
    const channel = ev.channel ?? 'unknown'
    if (ev.kind === 'started') starts.add(channel)
    if (ev.kind === 'completed' || ev.kind === 'failed') {
      outcomes.add(channel)
      if (!ev.jobId) unattributableOutcomes++
    }
    if (ev.kind === 'failed' && ev.detail) {
      // eBay repeats the same rejection across markets; the same error twenty times is one problem.
      failures.set(ev.detail, (failures.get(ev.detail) ?? 0) + 1)
    }
  }

  return {
    total: entries.length,
    byKind,
    channelsMissingOutcomes: [...starts].filter((c) => !outcomes.has(c)).sort(),
    channelsMissingStarts: [...outcomes].filter((c) => !starts.has(c)).sort(),
    unattributableOutcomes,
    failures: [...failures.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count),
    dryRuns,
  }
}

/**
 * A failure's first line. eBay embeds a raw JSON error body in the message, which is unreadable in
 * a list row and useful in full — so the row shows the sentence and the title carries everything.
 */
export function failureHeadline(message: string): string {
  const beforeJson = message.split(/:\s*\{/)[0]
  return beforeJson.length < message.length ? `${beforeJson.trim()}…` : message
}
