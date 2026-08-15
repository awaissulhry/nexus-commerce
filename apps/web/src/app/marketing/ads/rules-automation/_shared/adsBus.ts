'use client'

/**
 * RT.1 — the Rules & Automation section's half of the app-wide invalidation rail.
 *
 * This is **not a new mechanism**. `apps/web/src/lib/sync/invalidation-channel.ts` has carried
 * cross-tab invalidation for 80 files since Phase 10d — BroadcastChannel, SSR-safe, with a
 * same-tab re-dispatch so a page that mutates its own data refreshes its own sidebar too. The ads
 * section simply never adopted it. This file is the thin, typed doorway so eleven pages reach it
 * the same way and nobody hand-rolls a twelfth event name.
 *
 * ── The two rails, and why the split does the hard work for free ────────────────────────────────
 *
 *   · **This rail carries YOUR OWN writes.** Only your own tabs can post to a BroadcastChannel, so
 *     anything arriving here was caused by you, seconds ago, somewhere you can remember. Apply it
 *     silently: you already know it happened, and a banner asking permission to show you your own
 *     edit is friction, not safety.
 *   · **The cursor poll (`useCursorPoll.ts`) carries EVERYONE ELSE'S** — the rank engine at 00:00,
 *     the resync pulling a Seller-Central edit, another operator. That rail sets `stale` and offers
 *     a button, because the one screen used to decide whether a bid is wrong must not reorder
 *     itself mid-sentence.
 *
 * No origin tagging, no clock comparison, no "was this me?" heuristic: the rail an event arrives on
 * IS the answer. That is the whole design.
 *
 * ── Two rules for callers ───────────────────────────────────────────────────────────────────────
 *
 *   1. **Emit once per logical operation, never once per row.** A bulk action that loops a fetch per
 *      selected row emits AFTER the loop. Forty rows × eleven open tabs is 440 refetches for one
 *      click, and the rail has no debounce.
 *   2. **Emit only after the write settled.** An emit beside an optimistic update tells every other
 *      tab to refetch a value the server has not accepted yet, and they will render the old one —
 *      which looks exactly like the write failing.
 */
import { useCallback } from 'react'
import {
  emitInvalidation,
  useInvalidationChannel,
  type InvalidationType,
} from '@/lib/sync/invalidation-channel'

/**
 * The nine subjects. A page subscribes to the subjects it renders, not to the pages it trusts —
 * which is why a negation refreshes both Negative Targeting and Keyword Harvest from one emit.
 */
export type AdsChange = Extract<InvalidationType, `ads.${string}`>

/** Announce a settled write to every open tab, including this one. */
export function emitAdsChange(type: AdsChange, meta?: Record<string, unknown>): void {
  emitInvalidation({ type, meta })
}

/**
 * Refetch when one of `types` is announced by any tab.
 *
 * `paused` is the same guard `useCursorPoll`'s `enabled` flag exists for, and it matters here for
 * one reason only: a drawer or dialog open on a single row is a conversation about that row, and
 * refetching under it can swap the subject mid-sentence. Pass `true` while one is open; the next
 * emit after it closes brings the page back up to date. A write in flight does NOT need to pause
 * this rail — the emit fires after the write settles, so there is nothing optimistic to overwrite.
 */
export function useAdsSync(
  types: AdsChange[],
  onChange: () => void,
  paused = false,
): void {
  const handler = useCallback(() => {
    if (paused) return
    onChange()
  }, [paused, onChange])
  useInvalidationChannel(types as InvalidationType[], handler)
}
