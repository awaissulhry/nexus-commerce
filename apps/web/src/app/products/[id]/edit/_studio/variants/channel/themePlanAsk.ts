/**
 * VT.2c — the one channel from a variation-theme COMMIT to the dry-run plan modal.
 *
 * ## Why this exists at all
 *
 * A SET change on a LIVE coordinate is an OPERATION, not a cell write (design §3.5 / VT.6): the
 * commit path resolves to `outcome: plan`, sends NOTHING, and VT.4's `ThemeChangePlanModal` must open
 * with the server's dry-run plan. The two ends of that cannot see each other:
 *
 * - the decision is taken in `commitVariationTheme` (`_studio/sheet/master/masterWrite.ts`), a plain
 *   async function the sheet calls — it has no React tree to render a Modal into, and the AG popup
 *   editor that produced the value has already closed by the time it runs;
 * - the modal must outlive that popup, so it belongs to a component mounted by the SHEET.
 *
 * The alternatives were worse and are recorded rather than silently rejected: threading a callback
 * would have to pass through `master/columns.tsx` + `channelColumns.tsx` (the two column builders,
 * which this lane may not open, and whose `cellEditorParams` is a module-level constant precisely so
 * a builder never has to be touched for an editor's wiring), or through the sheet adapters that
 * belong to another lane. One tiny, typed, single-listener slot is the smallest honest seam.
 *
 * ## The honesty rule this file must keep
 *
 * `askForThemeChangePlan` returns whether a host was listening. The caller ALREADY carries the
 * server's lock sentence into the cell's own result (`{ ok: true, reason }`), so a missing host
 * degrades to "the reason is on the cell" and never to silence — and never to a write, because the
 * write decision was taken before this is called and it was "send nothing".
 *
 * Nothing here touches React, so the write path does not pull a component (or its stylesheet) into
 * its module graph, and `masterWrite.vitest.test.ts` stays a node-only suite.
 */

/** Exactly what `fetchThemeChangePlan` needs, plus the sentence that refused the write. */
export interface ThemeChangePlanAsk {
  request: {
    coordinate: { productId: string; channel: string; market: string; accountId?: string | null; aliasKey?: string | null }
    expectedVersion: number
    reset?: boolean
    theme?: string | null
    mapping?: Array<{ axisKey: string; target: string; order: number }>
  }
  /** The server's own lock sentence, verbatim — shown if the plan itself cannot be built. */
  reason: string
  /** `relist | new-parent | in-place` — what the plan will describe. */
  setChangeIs: 'relist' | 'new-parent' | 'in-place'
}

type Listener = (ask: ThemeChangePlanAsk) => void

/**
 * ONE slot, not a Set. Two hosts would open two modals for one commit, and a list would make that
 * possible without anything saying so; the sheet mounts exactly one.
 */
let listener: Listener | null = null

/** Mounted by the channel sheet's plan host. Returns its own unsubscribe. */
export function onThemeChangePlanAsked(next: Listener): () => void {
  listener = next
  return () => {
    /* Only clear OUR listener: a remount registers the new one before the old one's cleanup runs
       (React 18 StrictMode does exactly that), and an unconditional `null` would leave no host. */
    if (listener === next) listener = null
  }
}

/** `false` = nothing was listening, so the caller's own `reason` is the only thing on screen. */
export function askForThemeChangePlan(ask: ThemeChangePlanAsk): boolean {
  if (!listener) return false
  listener(ask)
  return true
}
