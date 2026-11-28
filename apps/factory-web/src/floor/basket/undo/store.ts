import type { Department } from '../../../lib/department/model'

/**
 * owb-fl6 (design § 5zg "3. Undo — ONE bar at the foot of every floor page"; P/fsteps.js fundoBar, undoLast) — the last change THIS
 * person made, kept on the device for the bar: a move (one basket or many: their groups) or a give. The floor app reads it into every
 * frame and runs the Undo; the server keeps the rule (the own move while nobody moved it since). A screen that shows baskets reads
 * again when `changes` moves (an Undo went through). Nothing here is sent or stored: it lives in this tab, for this person.
 */

export type UndoEntry =
  | {
      readonly kind: 'move'
      readonly groupIds: readonly string[]
      /** One basket: its code; many: null (the bar says how many). */
      readonly code: string | null
      readonly count: number
      readonly from: Department | null
      /** Where it went; null with `toReady`: Ready to ship. */
      readonly to: Department | null
      readonly toReady: boolean
    }
  | {
      readonly kind: 'give'
      readonly code: string
      readonly from: string | null
      readonly to: string
      readonly assignment: { readonly id: string; readonly version: number }
      /** Who held it before (the give goes back to them); null: nobody — today's API takes a give back only to a person. */
      readonly backTo: string | null
    }

export interface UndoState {
  readonly entry: (UndoEntry & { readonly id: number; readonly personId: string }) | null
  readonly busy: boolean
  /** What the last Undo said: somebody moved it after you, or it failed; null: nothing to say. */
  readonly said: 'moved' | 'failed' | null
  /** Moves each time an Undo went through (screens read again). */
  readonly changes: number
}

const EMPTY: UndoState = Object.freeze({ entry: null, busy: false, said: null, changes: 0 })

export class UndoStore {
  private state: UndoState = EMPTY
  private next = 1
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): UndoState => this.state

  private set(state: UndoState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /** A new change of this person: the bar shows it (the one before is gone). */
  readonly put = (personId: string, entry: UndoEntry): void => this.set({ ...this.state, entry: { ...entry, id: this.next++, personId }, busy: false, said: null })

  /** The cross: the bar goes; the change stays. */
  readonly close = (): void => this.set({ ...this.state, entry: null, said: null, busy: false })

  readonly start = (): void => this.set({ ...this.state, busy: true, said: null })

  /** The Undo's answer: went through (the bar goes, screens read again), somebody moved it after you, or it failed. */
  readonly finish = (result: 'undone' | 'moved' | 'failed'): void =>
    this.set(result === 'undone' ? { entry: null, busy: false, said: null, changes: this.state.changes + 1 } : { ...this.state, entry: result === 'moved' ? null : this.state.entry, busy: false, said: result })

  /** Another person on the device: nothing of the one before. */
  readonly forget = (personId: string | null): void => {
    if (this.state.entry && this.state.entry.personId !== personId) this.set({ ...this.state, entry: null, said: null, busy: false })
  }
}

export const undoStore = new UndoStore()
