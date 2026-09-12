/**
 * PES.7 — per-channel publish health. Pure, tested.
 *
 * The old surface offered "last published, 30d count, success rate, avg duration, recent errors"
 * (PB.13, inventory §2.5). Two of those five cannot be computed honestly from this data, and
 * computing them anyway is worse than omitting them:
 *
 * 🔴 **No bare percentages.** A "success rate" needs a denominator of attempts whose outcome is
 * actually recorded. On GALE-JACKET, Amazon records an outcome for **6 of 43** attempts — a bare
 * "100% success" off those 6, with 37 verdict-less attempts excluded from the denominator, is a
 * number that is arithmetically true and completely false. Everything here is reported as
 * `X of Y`, with the remainder named, because a fraction that carries its own denominator cannot
 * mislead the way a percentage can.
 *
 * 🔴 **Duration is measured only where the publisher itself recorded the finish** — a row with a
 * terminal status AND a completion time. Amazon's 37 stranded rows have a `completedAt` written by
 * a reconcile sweep *weeks* after submission: measured, every one of them is between 13.6 and 27.9
 * days, and none is under an hour. Averaging those reports "this publish took a fortnight". This is
 * not a magic-threshold rule — it is a provenance rule. A finish time nobody recorded at the finish
 * is not a measurement of how long anything took.
 */

import { readJob, type JobReading, type PublishJob } from './jobs'

export interface Duration {
  n: number
  medianSeconds: number
  maxSeconds: number
}

export interface ChannelHealth {
  channel: string
  attempts: number
  lastAttemptAt: string | null
  /** Attempts whose outcome the record actually states. */
  recordedSuccess: number
  recordedFailure: number
  /** Attempts with no verdict — the number a success rate would quietly drop. */
  unrecorded: number
  /** `null` when nothing on this channel recorded its own finish. */
  duration: Duration | null
  /** Why duration is missing or partial, when it needs saying. */
  durationNote: string | null
  skuLines: number
  skuRejected: number
  errors: Array<{ message: string; count: number }>
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid]
}

/** A verdict the record actually states, as opposed to one we would be inferring. */
function verdict(r: JobReading): 'success' | 'failure' | null {
  switch (r.state) {
    case 'done': return 'success'
    case 'failed':
    case 'rejected': return 'failure'
    // 'endedNoRejections' is deliberately NOT a success: see jobs.ts — a report naming nothing is
    // also what an empty report looks like.
    default: return null
  }
}

export function summariseHealth(
  jobs: readonly PublishJob[],
  now: Date = new Date(),
): ChannelHealth[] {
  const byChannel = new Map<string, PublishJob[]>()
  for (const j of jobs) {
    const list = byChannel.get(j.channel) ?? []
    list.push(j)
    byChannel.set(j.channel, list)
  }

  const out: ChannelHealth[] = []
  for (const [channel, list] of byChannel) {
    let recordedSuccess = 0
    let recordedFailure = 0
    let unrecorded = 0
    let skuLines = 0
    let skuRejected = 0
    let lastAttemptAt: string | null = null
    const durations: number[] = []
    let completionsIgnored = 0
    const errors = new Map<string, number>()

    for (const j of list) {
      const r = readJob(j, now)
      const v = verdict(r)
      if (v === 'success') recordedSuccess++
      else if (v === 'failure') recordedFailure++
      else unrecorded++

      if (r.receipt) {
        skuLines += r.receipt.lines
        skuRejected += r.receipt.rejected
        for (const reason of r.receipt.reasons) {
          errors.set(reason.message, (errors.get(reason.message) ?? 0) + reason.count)
        }
      }
      if (r.state === 'failed' && j.errorMessage) {
        errors.set(j.errorMessage, (errors.get(j.errorMessage) ?? 0) + 1)
      }
      if (!lastAttemptAt || j.submittedAt > lastAttemptAt) lastAttemptAt = j.submittedAt

      // Provenance rule: only a row the publisher itself finished can time itself.
      if (j.completedAt) {
        if (v !== null) {
          const ms = new Date(j.completedAt).getTime() - new Date(j.submittedAt).getTime()
          if (Number.isFinite(ms) && ms >= 0) durations.push(Math.round(ms / 1000))
        } else {
          completionsIgnored++
        }
      }
    }

    out.push({
      channel,
      attempts: list.length,
      lastAttemptAt,
      recordedSuccess,
      recordedFailure,
      unrecorded,
      duration: durations.length > 0
        ? { n: durations.length, medianSeconds: median(durations), maxSeconds: Math.max(...durations) }
        : null,
      durationNote: completionsIgnored > 0
        ? `${completionsIgnored} attempt${completionsIgnored === 1 ? '' : 's'} carry a finish time that `
          + 'was written later by a sweep rather than at the finish, so they are not timed here.'
        : null,
      skuLines,
      skuRejected,
      errors: [...errors.entries()]
        .map(([message, count]) => ({ message, count }))
        .sort((a, b) => b.count - a.count),
    })
  }

  // Busiest channel first — the one an operator is most likely asking about.
  return out.sort((a, b) => b.attempts - a.attempts)
}

/**
 * The outcome sentence for a channel. Always a fraction with its denominator, never a percentage.
 */
export function outcomeSentence(h: ChannelHealth): string {
  const recorded = h.recordedSuccess + h.recordedFailure
  if (recorded === 0) {
    return `No outcome is recorded for any of the ${h.attempts} attempts on this channel.`
  }
  const head = h.recordedFailure > 0
    ? `${h.recordedSuccess} of ${recorded} recorded outcomes succeeded, ${h.recordedFailure} failed`
    : `all ${recorded} recorded outcomes succeeded`
  return h.unrecorded > 0
    ? `${head} — the other ${h.unrecorded} of ${h.attempts} attempts record no outcome at all.`
    : `${head}.`
}

/** Human duration, without inventing precision. */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return `${hours} h`
  return `${Math.round(seconds / 86_400)} days`
}
