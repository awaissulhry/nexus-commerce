import type { FollowupsSay } from '../../../../lib/options-followups/words'
import type { Takes, TakesView } from './api'

/**
 * What a chosen value of an option group takes (B-W2b-374; XF3:05), pure: the three choices with their words, and why Save
 * waits — the API's held words, offline, nothing changed, saving, and the chosen options that still pick the other kind (the
 * database refuses that change too: B-W2b-363's OptionGroup_takes_check).
 */

export const TAKES_CHOICES: readonly { value: Takes; label: string; hint: string }[] = [
  { value: null, label: 'takes.none', hint: 'takes.noneHint' },
  { value: 'COLOUR', label: 'takes.colour', hint: 'takes.colourHint' },
  { value: 'MATERIAL', label: 'takes.material', hint: 'takes.materialHint' },
]

export interface TakesSaveState {
  view: TakesView | null
  draft: Takes
  online: boolean
  saving: boolean
}

/** Why Save waits (null: it can be pressed). */
export function takesHeld(state: TakesSaveState): FollowupsSay | null {
  if (!state.view) return { key: 'takes.held.busy' }
  if (!state.view.may.change && state.view.may.held) return { words: state.view.may.held }
  if (!state.online) return { key: 'takes.held.offline' }
  if (state.saving) return { key: 'takes.held.busy' }
  if (state.draft === state.view.takes) return { key: 'takes.held.unchanged' }
  if (state.draft === 'COLOUR' && state.view.picking.materials > 0) return { key: 'takes.held.materials', params: { count: state.view.picking.materials } }
  if (state.draft === 'MATERIAL' && state.view.picking.colours > 0) return { key: 'takes.held.colours', params: { count: state.view.picking.colours } }
  return null
}
