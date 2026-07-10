/**
 * UFX P7 — unsaved-changes nav-away guard for the flat-file editors.
 *
 * The mounted FlatFileGrid publishes its dirty (non-ghost) row count here;
 * the grid itself installs the tab-close (beforeunload) confirm, and the
 * ChannelStrip reads the count to confirm before switching channels.
 *
 * Deliberately NOT wired into market switches: those flush edits to a local
 * draft (and eBay/Amazon restore it per market), so market navigation stays
 * friction-free.
 *
 * Honest copy: edits are debounce-autosaved to a local draft on both pages,
 * so leaving loses at most the last moments of typing — the message says the
 * draft is kept rather than threatening total loss.
 *
 * Module-level singleton is safe: at most one flat-file grid is mounted at a
 * time, and the grid resets the count on unmount.
 */

let _dirtyCount = 0

/** Grid → guard: publish the current dirty (non-ghost) row count. */
export function setFlatFileDirtyCount(n: number): void {
  _dirtyCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Guard consumers (ChannelStrip): the last published dirty count. */
export function getFlatFileDirtyCount(): number {
  return _dirtyCount
}

/** True when leaving the page should ask for confirmation. */
export function shouldConfirmLeave(): boolean {
  return _dirtyCount > 0
}

/** Confirm copy for the channel switch (draft-honest, not alarmist). */
export function channelSwitchMessage(n: number): string {
  return `You have ${n} unsaved change${n === 1 ? '' : 's'} on this sheet. ` +
    'Edits are kept as a local draft and restored when you come back. Switch channel?'
}
