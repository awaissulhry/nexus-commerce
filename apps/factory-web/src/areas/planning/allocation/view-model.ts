import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import type { PlanningSite } from '../board/api'
import type { Allocation } from './api'
import type { AllocationWorkshops, DepthOperation, FromAllocation, KitTiming, WorkOrderWorkshops } from './depth/api'
import type { AllocationControls, AllocationRefusal, ReadProblem } from './model'

/**
 * The ONE view model of Lines & subcontractors (SCR-126) and what it may ask for. The view fetches nothing: the page
 * container (AllocationPage.tsx) reads the API and fills this; the design cases fill it with made-up data.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'error'; problem: ReadProblem } | { status: 'ready'; value: T }

export type SaveState = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: string } | { state: 'failed'; refusal: AllocationRefusal }

/** A card's operations (B-W2b-338, design board#4): every operation of its work order, in-house or outside. */
export interface CardOperations {
  operations: Array<DepthOperation & { remaining: number | null; workshopName: string | null }>
  mayOutsource: boolean
}

/** One operation switched in-house or outside (its own dialog). */
export interface SwitchDialog {
  kind: 'switch'
  cardId: string
  operationId: string
  mode: 'outside' | 'in-house'
  /** The operation's workshops (outside: which are offered for it and why not; in-house: its version, fresh). */
  workshops: Loaded<WorkOrderWorkshops>
  busy?: boolean
  /** A refusal in our words. */
  error?: string | null
  /** Design cases: the workshop picked, the reason typed. */
  partyId?: string | null
  reason?: string
}

/** A drop on a workshop (design pop:kit-timing "Send to Workshop Beta"): the kit timing, then Allocate. */
export interface KitDialog {
  kind: 'kit'
  cardId: string
  /** The workshop's column (`WORKSHOP:<partyId>`). */
  laneKey: string
  pieces: number
  /** `noWork`: the work order has nothing left to make outside (the API's 409): Allocate is held with that. */
  timing: { status: 'loading' } | { status: 'error'; problem: ReadProblem | 'noWork' } | { status: 'ready'; value: KitTiming }
  busy?: boolean
  error?: string | null
}

/** "Create subcontract orders (n)": the preview, then the orders made. */
export interface OrdersDialog {
  kind: 'orders'
  slotIds: string[]
  preview: Loaded<FromAllocation>
  phase: 'ready' | 'saving' | 'done' | 'failed'
  result?: FromAllocation | null
  /** A refusal of the whole request (a message key of the depth catalogue). */
  error?: string | null
}

export type AllocationDialog = { kind: 'card'; cardId: string; busy?: boolean; error?: string | null; operations?: Loaded<CardOperations> } | { kind: 'keys' } | KitDialog | SwitchDialog | OrdersDialog

export interface AllocationViewModel {
  prefix: string
  sites: readonly PlanningSite[]
  controls: AllocationControls
  read: Loaded<Allocation>
  /** B-W2b-338: which workshops take each work order's outside work, and why not (held drop zones). */
  workshops?: Loaded<AllocationWorkshops>
  /** planning.subcontract.outsource (switch, kit time, Create subcontract orders) and purchasing.subcontract.manage (the order). */
  may?: { outsource: boolean; order: boolean }
  offline: boolean
  save: SaveState
  dialog: AllocationDialog | null
  notice: string | null
}

export interface AllocationActions {
  onSite?: (siteId: string) => void
  onRetry?: () => void
  /** A card dropped on a column (all its garments): saved before it shows; false = not made. A workshop opens the kit timing. */
  onMove?: (move: PlanningMove) => boolean | Promise<boolean>
  onOpen?: (card: PlanningCard) => void
  /** Move `pieces` garments of the card to a column (null: Not allocated); a workshop opens the kit timing first. */
  onMovePart?: (cardId: string, laneKey: string | null, pieces: number) => void
  onOpenKeys?: () => void
  onCloseDialog?: () => void
  /** The kit timing's Allocate: the garments to the workshop (the allocation's own change). */
  onAllocateKit?: () => void
  onRetryKit?: () => void
  /** Open one operation's switch from the card (outside: which workshops; in-house: the reason). */
  onSwitch?: (cardId: string, operationId: string, mode: 'outside' | 'in-house') => void
  onRetrySwitch?: () => void
  onSendOutside?: (input: { partyId: string; pieces: number }) => void
  onBringInHouse?: (reason: string) => void
  /** Back from the switch to the card. */
  onBackToCard?: () => void
  onRetryOperations?: () => void
  /** "Create subcontract orders (n)": preview, then make the parts that pass. */
  onCreateOrders?: () => void
  onConfirmOrders?: () => void
  onRetryOrders?: () => void
}
