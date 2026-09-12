/**
 * §9.5a — what a channel scope remembers between visits, and what it deliberately forgets.
 *
 * The channel scope persisted NOTHING: every load rebuilt from the schema and #173's default view,
 * so an operator who widened a column on eBay·IT and came back found it reset. That is §14.1 from
 * the persistence side — the two sheets look identical in a screenshot and behave like different
 * products.
 *
 * ── Why this does not simply call `useGridState` ────────────────────────────────────────────────
 * The hook persists `api.getState()` **entire** (`useGridState.ts:102`) and offers only
 * `autoRestore`. That would store precisely the two things §9.5a forbids:
 *
 *   - **horizontal scroll** — a restored 1,227px scroll lands the operator past identity, past the
 *     required-and-incomplete block, past the spine. The default view's ordering is a DECISION
 *     about what matters; a restored scroll is an accident of where someone stopped, and it
 *     overrides that decision on every load.
 *   - **selection** — an in-session intent about what you are about to act on. Restored a day
 *     later it lets someone run a bulk verb against a set they do not remember choosing.
 *
 * So this module reuses the substrate's STORAGE (`readLastUsed` / `writeLastUsed`, same format, same
 * key helper) and narrows only what is written. It is not a fork of the hook's logic; it is the
 * hook's storage with a smaller payload. When `useGridState` grows a "persist only these" option,
 * this collapses into it.
 *
 * ── The allow-list is an ALLOW-list on purpose ──────────────────────────────────────────────────
 * 🔴 An omit-list would silently start persisting anything a future AG version adds to `GridState`
 * — including a new scroll- or selection-shaped key — and the failure would be invisible, because
 * stored junk reads as a preference. Naming what may be kept means a new key is forgotten by
 * default, which is the safe direction.
 */
import type { GridState } from '@/design-system/grid'

/**
 * Everything the operator set deliberately that is not the VIEW's to decide, and nothing that
 * merely happened.
 *
 * 🔴 `columnVisibility` and `columnOrder` LEFT this list on 2026-09-04 (design V.2/V.8). Membership
 * and order come from the active view — the sheet lands on every column unless an explicit default
 * view says otherwise — and a remembered `hiddenColIds` was precisely the invisible state that made
 * a sheet look like it ignored the operator (#772–#774). Widths, pins and sort are visible on
 * screen and cannot hide a column, so they stay. The same three keys are `SHEET_PERSIST_KEYS` in
 * `../useSheetColumns.ts`, where `useGridState` now does the writing for both scopes.
 */
export const PERSISTED_STATE_KEYS = [
  'columnSizing',
  'columnPinning',
  'sort',
] as const

/**
 * The storage key.
 *
 * 🔴 It MUST carry the coordinate. Channels have different column sets, so one key for all of them
 * lands eBay's widths on Amazon's columns — and the entries would look like preferences rather than
 * like a bug. Master needs no coordinate, so copying master's key shape is the obvious mistake and
 * the reason this is a function rather than a template at the call site.
 */
export function channelSurfaceKey(channel: string, marketplace: string): string {
  return `product-edit:${channel.toUpperCase()}:${marketplace.toUpperCase()}`
}

/** Keep only the allow-listed slices, and only those actually present. */
export function pickPersisted(state: GridState | null | undefined): Partial<GridState> {
  if (!state) return {}
  const out: Record<string, unknown> = {}
  for (const k of PERSISTED_STATE_KEYS) {
    const v = (state as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as Partial<GridState>
}

/** True when there is anything worth writing — an empty object is not a preference. */
export function hasPersistedState(state: Partial<GridState>): boolean {
  return Object.keys(state).length > 0
}
