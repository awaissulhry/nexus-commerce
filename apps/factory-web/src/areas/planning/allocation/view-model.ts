import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import type { PlanningSite } from '../board/api'
import type { Allocation } from './api'
import type { AllocationControls, AllocationRefusal, ReadProblem } from './model'

/**
 * The ONE view model of Lines & subcontractors (SCR-126) and what it may ask for. The view fetches nothing: the page
 * container (AllocationPage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'error'; problem: ReadProblem } | { status: 'ready'; value: T }

export type SaveState = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: string } | { state: 'failed'; refusal: AllocationRefusal }

export type AllocationDialog = { kind: 'card'; cardId: string; busy?: boolean; error?: string | null } | { kind: 'keys' }

export interface AllocationViewModel {
  prefix: string
  sites: readonly PlanningSite[]
  controls: AllocationControls
  read: Loaded<Allocation>
  offline: boolean
  save: SaveState
  dialog: AllocationDialog | null
  notice: string | null
}

export interface AllocationActions {
  onSite?: (siteId: string) => void
  onRetry?: () => void
  /** A card dropped on a column (all its garments): saved before it shows; false = not made. */
  onMove?: (move: PlanningMove) => boolean | Promise<boolean>
  onOpen?: (card: PlanningCard) => void
  /** Move `pieces` garments of the card to a column (null: Not allocated). */
  onMovePart?: (cardId: string, laneKey: string | null, pieces: number) => void
  onOpenKeys?: () => void
  onCloseDialog?: () => void
}
