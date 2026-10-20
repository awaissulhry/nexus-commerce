/**
 * Meta step 17 (write base) — Meta's limits on ONE object, kept by the gateway apart from the account's rate bucket.
 * Checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting.md:
 *
 *   - "Concurrent Requests Rate Limiting": one edit per object every 30 seconds (per app, per endpoint), independent of the
 *     account's QPS; over it Meta answers 613 / subcode 4841018 and asks to retry at least 30 s apart.
 *   - "Ad set budget": an ad set's daily_budget / lifetime_budget may change 4 times per hour; over it "the budget change
 *     for that ad set is blocked for an hour" (613 / subcode 1487632). Only that ad set's BUDGET changes wait: its other
 *     changes (a pause) still go, and so do every other object's.
 *
 * So, per (connection, object):
 *   touch       when Nexus last sent this object a change or Meta's check of one (Meta may count a check as an edit:
 *               UNVERIFIED, so a change waits 30 s after either)
 *   hold        Meta said 4841018: no change of this object until then
 *   budgetHold  Meta said 1487632: no budget change of this ad set until then
 *   budget      when this ad set's budget changed in the last hour (Nexus's own changes), for the preview's warning
 *
 * Shared through the app's Redis (rate.ts) when it is up, else this process's memory. Advisory: Meta enforces its own
 * limits anyway; a read or write error here never blocks or fails a call.
 */
import { rateRedis } from './rate.js'

/** Meta's default: one edit per object every 30 s (613/4841018). */
export const META_OBJECT_EDIT_GAP_MS = 30_000
/** Meta: an ad set's budget changes at most 4 times an hour; then 1 h blocked (613/1487632). */
export const META_ADSET_BUDGET_CHANGES_PER_HOUR = 4
export const META_ADSET_BUDGET_HOLD_MS = 60 * 60_000
const KEEP_MS = 60 * 60_000 + 60_000

export interface MetaObjectState {
  /** ms epoch of the last change or check Nexus sent this object; null = none known in the last hour. */
  touchedAt: number | null
  /** ms epoch until which Meta holds every change of this object (4841018); null = none. */
  heldUntil: number | null
  /** ms epoch until which Meta holds this ad set's budget changes (1487632); null = none. */
  budgetHeldUntil: number | null
  /** ms epochs of this ad set's budget changes in the last hour (Nexus's own). */
  budgetChanges: number[]
}

const memory = new Map<string, { touch?: number; hold?: number; budgetHold?: number; budget?: number[]; at: number }>()
let memoryOnly = false

/** Tests: keep the state in this process's memory only (and start empty). */
export const __metaObjectLimitsTest = {
  useMemory() { memoryOnly = true; memory.clear() },
  reset() { memoryOnly = false; memory.clear() },
}

const keyOf = (connectionId: string, objectId: string) => `gw:metaobj:${connectionId}:${objectId}`
const num = (v: unknown): number | undefined => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined }

async function readRaw(key: string): Promise<{ touch?: number; hold?: number; budgetHold?: number; budget?: number[] }> {
  const redis = memoryOnly ? null : rateRedis()
  if (redis) {
    try {
      const row = await redis.hgetall(key)
      return {
        touch: num(row?.touch), hold: num(row?.hold), budgetHold: num(row?.budgetHold),
        budget: String(row?.budget ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0),
      }
    } catch { /* fall back to memory */ }
  }
  const kept = memory.get(key)
  if (kept && Date.now() - kept.at > KEEP_MS) { memory.delete(key); return {} }
  return kept ?? {}
}

async function writeRaw(key: string, value: { touch?: number; hold?: number; budgetHold?: number; budget?: number[] }): Promise<void> {
  const redis = memoryOnly ? null : rateRedis()
  if (redis) {
    try {
      const fields: string[] = []
      if (value.touch) fields.push('touch', String(value.touch))
      if (value.hold) fields.push('hold', String(value.hold))
      if (value.budgetHold) fields.push('budgetHold', String(value.budgetHold))
      if (value.budget) fields.push('budget', value.budget.join(','))
      if (fields.length) await redis.hset(key, ...fields)
      await redis.pexpire(key, KEEP_MS)
      return
    } catch { /* fall back to memory */ }
  }
  memory.set(key, { ...value, at: Date.now() })
}

/** What Nexus knows of this object's limits now. */
export async function metaObjectState(connectionId: string, objectId: string, now: number = Date.now()): Promise<MetaObjectState> {
  const raw = await readRaw(keyOf(connectionId, objectId))
  return {
    touchedAt: raw.touch && now - raw.touch < KEEP_MS ? raw.touch : null,
    heldUntil: raw.hold && raw.hold > now ? raw.hold : null,
    budgetHeldUntil: raw.budgetHold && raw.budgetHold > now ? raw.budgetHold : null,
    budgetChanges: (raw.budget ?? []).filter((at) => now - at < 60 * 60_000),
  }
}

/**
 * How long a change of this object must wait before Meta takes it, and why (null: it may go now). `budget`: the change
 * moves an ad set's daily or lifetime budget.
 */
export function metaObjectWait(state: MetaObjectState, budget: boolean, now: number = Date.now()): { waitMs: number; why: string } | null {
  if (state.heldUntil && state.heldUntil > now) {
    return { waitMs: state.heldUntil - now, why: 'Meta asked Nexus to wait before changing this object again (it allows one change of the same object every 30 s; 613/4841018)' }
  }
  if (budget && state.budgetHeldUntil && state.budgetHeldUntil > now) {
    return { waitMs: state.budgetHeldUntil - now, why: `Meta blocks this ad set's budget changes for an hour after its ${META_ADSET_BUDGET_CHANGES_PER_HOUR}th change in an hour (613/1487632)` }
  }
  if (state.touchedAt && now - state.touchedAt < META_OBJECT_EDIT_GAP_MS) {
    return { waitMs: META_OBJECT_EDIT_GAP_MS - (now - state.touchedAt), why: 'Meta allows one change of the same object every 30 s (613/4841018)' }
  }
  return null
}

/** A change or a check of this object reached Meta (`budget`: a confirmed ad set budget change). */
export async function noteMetaObjectTouched(connectionId: string, objectId: string, input: { budget?: boolean } = {}, now: number = Date.now()): Promise<void> {
  try {
    const key = keyOf(connectionId, objectId)
    const raw = await readRaw(key)
    const budget = (raw.budget ?? []).filter((at) => now - at < 60 * 60_000)
    if (input.budget) budget.push(now)
    await writeRaw(key, { ...raw, touch: now, budget })
  } catch { /* advisory */ }
}

/** Meta's own answer held this object: every change (4841018, 30 s) or this ad set's budget changes (1487632, 1 h). */
export async function holdMetaObject(connectionId: string, objectId: string, what: 'edits' | 'budget', now: number = Date.now()): Promise<void> {
  try {
    const key = keyOf(connectionId, objectId)
    const raw = await readRaw(key)
    await writeRaw(key, what === 'edits'
      ? { ...raw, touch: now, hold: Math.max(raw.hold ?? 0, now + META_OBJECT_EDIT_GAP_MS) }
      : { ...raw, touch: now, budgetHold: Math.max(raw.budgetHold ?? 0, now + META_ADSET_BUDGET_HOLD_MS) })
  } catch { /* advisory */ }
}
