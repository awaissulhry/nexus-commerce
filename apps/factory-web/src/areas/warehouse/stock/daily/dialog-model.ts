import type { PerUnit, Uom } from '../../../_shared/stock/api'
import type { Phrase } from '../../../_shared/stock/model'
import type { PickerReason } from '../../../_shared/reasons/api'
import type { HoldPreview, WorkOrderOption } from './api'
import type { HoldDraft, WriteOffDraft, WriteOffTarget } from './model'

/**
 * The view models of the warehouse's every-day dialogs (B-W2a-64), one per dialog, built by their hooks (useWriteOff,
 * useHold, useReserve) or by a design case. A dialog view takes its model and its actions and fetches nothing.
 */

/** A read the dialog waits for: null value + null problem = still reading. */
export interface Read<T> {
  value: T | null
  problem: string | null
}

// ---- Write off (design mv-writeoff) and Scrap N hides (design hd-scrap) -----------------------------------------------------

export type SendState = 'sending' | 'sent' | 'failed'

export interface WriteOffDone {
  writeOffId: string
  moves: number
  /** The value that left the stock (cost grain), per currency. */
  value: { amount: number; currency: string } | null
  photo: SendState | null
  ncr: { state: SendState; id: string | null; number: string | null } | null
  overReserved: number
}

export interface WriteOffDialogModel {
  target: WriteOffTarget
  draft: WriteOffDraft
  reasons: Read<PickerReason[]>
  /** The cost grain: the value leaving stock is said. */
  withCost: boolean
  /** files.upload: a photo can be added. */
  canPhoto: boolean
  /** quality.ncr.raise and a lot or hide to raise it from. */
  canNcr: boolean
  posting: boolean
  problem: Phrase | null
  done: WriteOffDone | null
  /** The site's address prefix (`/w/<company>`): the NCR's link. */
  prefix: string
}

export interface WriteOffActions {
  onChange?: (draft: WriteOffDraft) => void
  onPost?: () => void
  onClose?: () => void
  onRetryPhoto?: () => void
  onRetryNcr?: () => void
}

// ---- Put lots (or hides) on hold (design st-hold) --------------------------------------------------------------------------

export interface HoldSubjectLine {
  id: string
  code: string
  /** What of it is in stock here, per unit; leather also as hides. */
  stock: PerUnit[]
  hides: number
}

export interface HoldDialogModel {
  subjectType: 'Lot' | 'Hide'
  subjects: HoldSubjectLine[]
  /** Selected rows that cannot be held (no lot) and were left out. */
  leftOut: number
  preview: Read<HoldPreview>
  /** The work orders that reserved this stock (their numbers). */
  reservedBy: Read<string[]>
  reasons: Read<PickerReason[]>
  draft: HoldDraft
  posting: boolean
  problem: Phrase | null
  /** Placed: the work orders held with it (a lot hold moves none). */
  done: { count: number } | null
}

export interface HoldActions {
  onChange?: (draft: HoldDraft) => void
  onPlace?: () => void
  onClose?: () => void
}

// ---- Reserve hides to a work order (design hd-grid selection, hd-find's "Reserve 11 hides") -------------------------------

export interface ReserveHide {
  id: string
  code: string
  lotCode: string
  area: string
  uom: Uom
  /** Why it cannot be reserved (a key of warehouse-daily with its values), or null: free to reserve. */
  why: Phrase | null
}

export interface ReserveDialogModel {
  siteId: string
  hides: ReserveHide[]
  /** workorders.view: the picker can list work orders. */
  canSeeWorkOrders: boolean
  query: string
  workOrders: Read<WorkOrderOption[]>
  workOrderId: string | null
  note: string
  posting: boolean
  problem: Phrase | null
  done: { count: number; workOrder: string } | null
  timeZone: string
}

export interface ReserveActions {
  onQuery?: (query: string) => void
  onPick?: (workOrderId: string | null) => void
  onNote?: (note: string) => void
  onReserve?: () => void
  onClose?: () => void
  onRetryWorkOrders?: () => void
}
