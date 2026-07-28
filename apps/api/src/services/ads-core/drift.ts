/**
 * AX-ZD.4 — drift detection.
 *
 * "Zero drift" is not a promise that our copy always matches Amazon — it can't
 * be, Amazon is eventually consistent and people edit in Seller Central. It is a
 * promise that we always KNOW when it doesn't, and can say why.
 *
 * The detection itself is free. `ads-campaign-settings-sync` already reads every
 * campaign's live state from Amazon every ~20 minutes and writes it in
 * non-destructively. Until now it silently overwrote our value; recording what it
 * overwrote turns a sync into a drift log at zero extra API cost — which matters,
 * because Amazon's rate limits are regional and adding accounts does not buy
 * throughput.
 *
 * The hard part is not spotting a difference, it is saying which KIND it is.
 * The audit's §3.3 point stands: without separating these, "our write hasn't
 * landed", "somebody edited in Seller Central" and "the write failed silently"
 * all look identical — local ≠ remote.
 */

/** Why our value and Amazon's disagree. */
export type DriftClass =
  /** Somebody changed it on Amazon's side. Nothing of ours is in flight. */
  | 'EXTERNAL_CHANGE'
  /** We wrote recently; Amazon has not caught up yet. Expected, self-healing. */
  | 'WRITE_LAG'
  /** We wrote, the write reported failure, and Amazon still holds the old value. */
  | 'WRITE_FAILED'
  /** A write is queued but has not been dispatched, so Amazon cannot know yet. */
  | 'WRITE_PENDING'

export interface DriftInput {
  /** What we hold locally. */
  ours: string | null
  /** What Amazon just told us. */
  theirs: string | null
  /** When we last pushed a write for this entity, if ever. */
  lastWriteAt?: Date | null
  /** Outcome stamp of that last write. */
  lastWriteStatus?: string | null
  /** A queued mutation exists that has not reached Amazon yet. */
  hasPendingWrite?: boolean
  now?: Date
}

/**
 * How long a landed write is allowed to take to show up in a read before we stop
 * calling it lag.
 *
 * Amazon's own guidance is eventual consistency in seconds to low minutes for
 * the campaign-management surfaces. Fifteen minutes is deliberately generous:
 * the cost of being too tight is crying "someone edited this in Seller Central"
 * at our own write, which is the one false positive that would make an operator
 * stop believing the whole feature.
 */
export const WRITE_LAG_GRACE_MS = 15 * 60 * 1000

/**
 * Classify one disagreement.
 *
 * Order matters: a queued-but-undispatched write explains the difference before
 * anything else can, and a failed write explains it before we blame a human.
 */
export function classifyDrift(input: DriftInput): DriftClass {
  const now = input.now ?? new Date()

  if (input.hasPendingWrite) return 'WRITE_PENDING'

  const wroteAt = input.lastWriteAt ? input.lastWriteAt.getTime() : null
  const sinceWrite = wroteAt == null ? null : now.getTime() - wroteAt
  const recentlyWrote = sinceWrite != null && sinceWrite >= 0 && sinceWrite <= WRITE_LAG_GRACE_MS

  // A failed write plus a stale remote value is the honest reading: our change
  // never made it, so Amazon legitimately still holds the old one. Calling that
  // an external change would send someone hunting for a person who did nothing.
  if ((input.lastWriteStatus ?? '').toUpperCase() === 'FAILED') return 'WRITE_FAILED'

  if (recentlyWrote) return 'WRITE_LAG'

  return 'EXTERNAL_CHANGE'
}

/** True when a difference is ours to explain rather than somebody else's doing. */
export function isOurs(c: DriftClass): boolean {
  return c !== 'EXTERNAL_CHANGE'
}

/**
 * Human wording. Drift reports get read by whoever is on shift, not by whoever
 * wrote the classifier, so each one says what happened AND what to do.
 */
export function describeDrift(c: DriftClass, field: string): string {
  switch (c) {
    case 'WRITE_PENDING':
      return `${field} differs because our change is still queued and has not reached Amazon yet. It should resolve on its own.`
    case 'WRITE_LAG':
      return `${field} differs because we changed it moments ago and Amazon has not caught up. It should resolve on its own.`
    case 'WRITE_FAILED':
      return `${field} differs because our last write FAILED — Amazon still holds the old value. This will not fix itself.`
    case 'EXTERNAL_CHANGE':
      return `${field} was changed on Amazon's side, not by us. Somebody edited it in Seller Central, or an Amazon automation did.`
  }
}

/** Normalise a value for comparison so formatting never masquerades as drift. */
export function normaliseForCompare(v: unknown): string | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return String(Number(v.toFixed(4)))
  const s = String(v).trim()
  if (!s) return null
  // "20" and "20.00" are the same budget; "ENABLED" and "enabled" the same state.
  const n = Number(s)
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s)) return String(Number(n.toFixed(4)))
  return s.toLowerCase()
}

export interface FieldDrift {
  field: string
  ours: string | null
  theirs: string | null
}

/**
 * Compare two field maps and return only genuine differences.
 *
 * A field Amazon did NOT report is skipped rather than treated as cleared — a
 * partial response must never look like somebody blanking a value, which is the
 * same trap the settings sync already guards against on the write side.
 */
export function diffFields(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  fields: readonly string[],
): FieldDrift[] {
  const out: FieldDrift[] = []
  for (const f of fields) {
    if (!(f in theirs)) continue
    const t = normaliseForCompare(theirs[f])
    if (t == null) continue
    const o = normaliseForCompare(ours[f])
    if (o !== t) out.push({ field: f, ours: o, theirs: t })
  }
  return out
}
