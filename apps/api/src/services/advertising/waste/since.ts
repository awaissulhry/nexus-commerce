/**
 * Negative Targeting page — NFIX (2026-10-11): WHEN a standing negative was added, from the records its writers keep.
 * Pure: read.ts gathers the facts, stopped.ts shows the answer ("Since"), and the spend before reads the same day.
 *
 * The fault it fixes: "Since" was the negative's create record joined by the row's own id, else `AdTarget.createdAt` —
 * the moment Nexus STORED the row. A row Nexus's sync brought in (or stored again) carries the sync's day, so every such
 * negative read the day of that sync (one day for every row on a live business), and the Brain's and Harvest's own write records were never read.
 *
 *   records     the create record of the row (AdvertisingActionLog create_negative_*), the Brain's write
 *               (AdsBrainNegative WRITTEN — by its row, or by its place, match and words when the row was stored again),
 *               Harvest's landing of the pair whose source this negative is (by its row, or its ad group and words):
 *               the EARLIEST is the add — a Brain or Harvest record only when Nexus did not already hold the row well
 *               before it (a write that found the negative standing is not when it was added)
 *   first seen  no record: `AdTarget.createdAt`, the day Nexus's sync first saw it — when that sync brought it in alone
 *               or with a few others. One sync that stored a crowd of negatives at once (BULK_SYNC_MIN within
 *               BULK_SYNC_WINDOW_MS) is a first import or a re-sync: the day it says is not an add day, so "Since" is
 *               unknown ("—") with why in words
 */
import { romeDay } from './pure.js'

export type SinceSource = 'hold' | 'record' | 'brain' | 'harvest' | 'first-seen'

/** When a negative was added, which record says so, and words for the hover (always for an unknown or first-seen day). */
export interface AddedFact { at: Date | null; source: SinceSource | null; why: string | null }

/** A sync that stored this many negatives or more within the window is an import, not a day each was added. */
export const BULK_SYNC_MIN = 10
export const BULK_SYNC_WINDOW_MS = 2 * 60_000
/** A record this much later than the stored row is not the row's add (the write found the negative standing). */
export const RECORD_SLACK_MS = 10 * 60_000

/** For each row, how many rows (itself included) were stored within ±window of it. One sort, two pointers. */
export function crowdSizes(rows: ReadonlyArray<{ id: string; at: number }>, windowMs: number = BULK_SYNC_WINDOW_MS): Map<string, number> {
  const sorted = [...rows].sort((a, b) => a.at - b.at)
  const out = new Map<string, number>()
  let lo = 0
  let hi = 0
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].at
    while (sorted[lo].at < t - windowMs) lo++
    if (hi < i) hi = i
    while (hi + 1 < sorted.length && sorted[hi + 1].at <= t + windowMs) hi++
    out.set(sorted[i].id, hi - lo + 1)
  }
  return out
}

export interface AddedFacts {
  /** The row's own create record. */
  record?: Date | null
  /** The Brain's write of it (AdsBrainNegative WRITTEN, a new negative). */
  brain?: Date | null
  /** Harvest's landing of the pair whose source it is. */
  harvest?: Date | null
  /** When Nexus stored the row (AdTarget.createdAt). */
  firstSeen: Date
  /** How many negatives the same sync stored with it (crowdSizes), itself included. */
  crowd: number
}

const SOURCE_WORDS: Readonly<Record<'record' | 'brain' | 'harvest', string>> = {
  record: 'Added on this day: its create record',
  brain: 'Added on this day: the Brain\'s write',
  harvest: 'Added on this day: Harvest\'s landing',
}

/** The day a negative was added (null: not known), with which record says so and why in words. */
export function negativeAdded(f: AddedFacts): AddedFact {
  const seen = f.firstSeen.getTime()
  const records = ([['record', f.record], ['brain', f.brain], ['harvest', f.harvest]] as const)
    .filter((x): x is readonly ['record' | 'brain' | 'harvest', Date] => x[1] instanceof Date && Number.isFinite(x[1].getTime()))
    // The row's own create record is its add. The Brain's or Harvest's (found by place and words too) is not when Nexus
    // held the row well before it: that write found the negative standing.
    .filter(([source, at]) => source === 'record' || !(seen < at.getTime() - RECORD_SLACK_MS))
    .sort((a, b) => a[1].getTime() - b[1].getTime())
  const best = records[0] ?? null
  if (best) return { at: best[1], source: best[0], why: SOURCE_WORDS[best[0]] }
  if (f.crowd >= BULK_SYNC_MIN) {
    return { at: null, source: null, why: `Added before Nexus kept a record: Nexus first saw it on ${romeDay(f.firstSeen)}, in one sync with ${f.crowd - 1} other negatives` }
  }
  return { at: f.firstSeen, source: 'first-seen', why: 'No add on record: the day Nexus first saw it' }
}

/** A paused keyword with no hold and no pause on record: why "Since" is unknown. */
export const NO_PAUSE_RECORD = 'Paused before Nexus kept a record, or outside Nexus: no pause on record'
