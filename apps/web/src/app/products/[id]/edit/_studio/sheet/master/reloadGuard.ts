/**
 * PES.2 / #663 — what Reload must ASK before it throws the operator's typing away.
 *
 * 🔴 Measured on the sheet 2026-09-02: pressing Reload with a refused edit discarded the typed
 * value (the cell came back holding the database's) and KEPT the marks — the cell stayed
 * `nds-cell-is-refused`, the footer still said "1 cell blocked", and the header still said
 * "1 change not saved". All three were then false: there was no unsaved change, and the refusal
 * described a value no longer on screen. It took a full page navigation to clear them.
 *
 * Two failures in one press: work destroyed without being asked, and marks left describing work
 * that is gone. This is the rule for the first half; the second half is `writer.discard()`.
 *
 * A rule, not a dialog, so it can be tested: the surface renders what this returns.
 */
import type { ActionImpact } from '@/design-system/grid'

export interface ReloadState {
  /** Cells queued or in flight — the writer's own count, never a re-derivation. */
  pending: number
  /** Cells carrying a refusal the operator has not cleared by editing again. */
  refused: number
  /** A dropped acknowledgement may already have committed; Reload cannot undo that write. */
  unknown?: number
}

/**
 * `null` when Reload may just re-read — nothing typed is at risk, so asking would be a dialog that
 * teaches operators to dismiss dialogs.
 *
 * Otherwise the question, naming what is about to be lost. The count is in the title because it is
 * the whole substance of the question; the consequences say what happens to each kind, because
 * "discard" means something different for an unsaved edit than for a refused one — the first is
 * work not yet sent, the second is work the server has already rejected and the operator may still
 * want to read.
 */
export function reloadImpact(state: ReloadState): ActionImpact | null {
  /* 🔴 CLAMP FIRST. Without this a transient `pending: -1` alongside `refused: 2` summed to 1 and
     the question came out "2 refused cells — reload and discard IT?". Caught by the test that only
     meant to check the early return; the pluralisation was reading the raw sum. Every count below
     is derived from these two, so they are the only place worth guarding. */
  const pending = Math.max(0, Math.trunc(state.pending) || 0)
  const refused = Math.max(0, Math.trunc(state.refused) || 0)
  const unknown = Math.max(0, Math.trunc(state.unknown ?? 0) || 0)
  if (pending === 0 && refused === 0 && unknown === 0) return null

  const parts: string[] = []
  if (pending > 0) parts.push(`${pending} unsaved ${pending === 1 ? 'change' : 'changes'}`)
  if (refused > 0) parts.push(`${refused} refused ${refused === 1 ? 'cell' : 'cells'}`)
  if (unknown > 0) parts.push(`${unknown} unconfirmed ${unknown === 1 ? 'change' : 'changes'}`)

  const consequences: string[] = []
  if (pending > 0) {
    consequences.push(
      pending === 1
        ? 'Reloading discards queued typing. A request already sent may still finish saving.'
        : `Reloading discards queued typing for ${pending} changes. Requests already sent may still finish saving.`,
    )
  }
  if (unknown > 0) consequences.push('The connection dropped before these saves were confirmed. They may already be stored. Reload replaces the local values and stops recovery; it does not undo a server write.')
  if (refused > 0) {
    // Named separately because it is the one an operator might be mid-way through fixing: the
    // typed value is still on screen precisely so they can correct it, and reloading takes it.
    consequences.push(
      refused === 1
        ? 'The refused cell keeps the value you typed so you can correct it. Reloading replaces it with the stored value and clears the refusal.'
        : `The ${refused} refused cells keep the values you typed so you can correct them. Reloading replaces them with the stored values and clears the refusals.`,
    )
  }

  return {
    // `confirm`, not `type-to-confirm`: this destroys unsent typing, which is recoverable by
    // retyping, not a listing or a row. Reserve the typed phrase for what cannot be undone.
    level: 'confirm',
    title: `${parts.join(' and ')} — reload and discard ${pending + refused + unknown === 1 ? 'it' : 'them'}?`,
    consequences,
  }
}
