import type { BenchCheck, PickBody, StyleConfigurator } from '../../quotes/record/configurator/api'
import { draftKey, draftOf, picksBody, textProblem, type DraftPick } from '../../quotes/record/configurator/model'
import type { FollowupsSay } from '../../../../lib/options-followups/words'

/**
 * A typed order line's options, pure (B-W2b-374; XF3:02): what the person picks in the line's Options dialog (New order, an
 * amendment's new line) before the order is confirmed. The picks are B-W2b-340's draft (one value of a SINGLE group, any
 * of a MULTI, a text where the value takes one, a library colour OR a material); the combination is B-W2b-229's check of the
 * style (the rule's words); the price is the API's (the order's preview prices the line with its options).
 */

/** The picks a draft line sends, as its Options dialog saved them (none: no options). */
export type EntryPicks = readonly PickBody[]

/** The dialog's draft from the picks a line has (none yet: an empty draft; the API takes the style's defaults). */
export function draftOfPicks(picks: EntryPicks, style: StyleConfigurator | null): DraftPick[] {
  if (!style) return []
  const groupOf = new Map(style.groups.flatMap((group) => group.values.map((value) => [value.id, group.groupId] as const)))
  return draftOf(
    picks.flatMap((pick) => {
      const groupId = groupOf.get(pick.valueId)
      return groupId ? [{ id: null, groupId, valueId: pick.valueId, text: pick.text ?? null, byDefault: false, colourId: pick.colourId ?? null, itemId: pick.itemId ?? null, itemColourId: pick.itemColourId ?? null }] : []
    }),
  )
}

/** What the dialog's Use sends back to the line (the defaults left out: the API takes them again). */
export const picksOfDraft = (draft: readonly DraftPick[], style: StyleConfigurator | null): PickBody[] => (style ? picksBody(draft, style.groups) : [])

/** The words of the line's Options button: "Options", or "Options · 3" with three chosen. */
export const entryButton = (picks: EntryPicks): FollowupsSay => (picks.length === 0 ? { key: 'entry.button' } : { key: 'entry.buttonCount', params: { count: picks.length } })

export interface EntryState {
  online: boolean
  checking: boolean
  check: BenchCheck | null
  failed: boolean
}

/** Why "Use these options" waits (null: it can be pressed): a text missing, the check not back, a refused combination. */
export function entryHeld(state: EntryState, draft: readonly DraftPick[], style: StyleConfigurator | null): FollowupsSay | null {
  if (!style) return { key: 'entry.held.checking' }
  if (draft.length === 0) return null
  const values = new Map(style.groups.flatMap((group) => group.values.map((value) => [value.id, value] as const)))
  for (const pick of draft) {
    const value = values.get(pick.valueId)
    if (value && textProblem(value, pick.text)) return { key: 'entry.held.text' }
  }
  if (!state.online) return { key: 'entry.held.offline' }
  if (state.checking || (!state.check && !state.failed)) return { key: 'entry.held.checking' }
  if (state.failed) return { key: 'entry.check.failed' }
  if (state.check && !state.check.ok) return { key: 'entry.held.refused' }
  return null
}

/** The key of a draft (what is checked): the same key, the same answer. */
export const entryKey = (draft: readonly DraftPick[], style: StyleConfigurator | null): string => (style ? draftKey(draft, style.groups) : '')

/**
 * B-W2b-302's paste: what could not land of a row's Options cell, in this catalogue's words (the API's `leftOut[].message` is
 * English: each kind matched from paste.ts and copy-options.ts), or null when the entry is not about options.
 */
export function pasteOptionWords(entry: { message: string }, row: number): FollowupsSay | null {
  const message = entry.message
  if (/options are not written on a line already/.test(message)) return { key: 'pasteOptions.left.kept', params: { row } }
  if (/is not one the style offers/.test(message)) return { key: 'pasteOptions.left.option', params: { row } }
  if (/is in more than one group/.test(message)) return { key: 'pasteOptions.left.ambiguous', params: { row } }
  if (/option .* is written twice/.test(message)) return { key: 'pasteOptions.left.twice', params: { row } }
  if (/the options were left out/.test(message)) return { key: 'pasteOptions.left.refused', params: { row } }
  return null
}
