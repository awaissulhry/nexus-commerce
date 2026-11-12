import type { LiveState } from '../../../../shell/live/use-live'
import type { PlaceRef } from '@nexus/factory-domain/inventory/transfers/contracts'
import type { StockList, TransferView } from '../api'
import type { Notice, Phrase, ReceiveDraft, RecordTab, SettleDraft, ShipDraft, TransfersCan } from '../model'

/**
 * SCR-361 — a transfer's record (design warehouse.transfers "Record: Transfer"): what the view draws and what it asks the
 * container to do. Every write goes through the container (one Idempotency-Key per attempt, the version read).
 */

export type Loaded = { status: 'loading' } | { status: 'ready'; transfer: TransferView } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** A draft line's quantity cell while it saves (autosave per cell). */
export type CellSave = { state: 'saving' } | { state: 'saved' } | { state: 'failed'; words: Phrase }

/** The stock picker of Add lines (the sending site's stock, the draft's lines taken off). */
export interface PickerState {
  readonly q: string
  readonly locationId: string | null
  readonly stock: StockList | null
  readonly problem: string | null
  /** The stock rows picked (their keys) and the quantity typed for each. */
  readonly picked: Readonly<Record<string, string>>
  readonly busy: boolean
  readonly notice: Notice | null
}

export type RecordDialog =
  | { kind: 'ship'; draft: ShipDraft; busy: boolean; notice: Notice | null; lines: readonly Phrase[] }
  | { kind: 'receive'; draft: ReceiveDraft; scan: string; scanNote: Phrase | null; busy: boolean; notice: Notice | null; lines: readonly Phrase[] }
  | { kind: 'settle'; draft: SettleDraft; busy: boolean; notice: Notice | null }
  | { kind: 'cancel'; reason: string; busy: boolean; notice: Notice | null }
  | { kind: 'pick'; picker: PickerState }

export interface TransferRecordModel {
  prefix: string
  can: TransfersCan
  tab: RecordTab
  today: string
  loaded: Loaded
  asOf: string | null
  live: LiveState
  notice: Notice | null
  lines: readonly Phrase[]
  /** A write is running (the band's buttons wait). */
  busy: boolean
  /** Someone else changed it while it was open: when (a time) — the Reload banner. */
  stale: string | null
  cells: Readonly<Record<string, CellSave>>
  dialog: RecordDialog | null
  /** The receiving site's places (the Receive dialog's choice; null: not read). */
  toPlaces: readonly PlaceRef[] | null
}

export interface TransferRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDismissNotice?: () => void
  onCopy?: () => void
  /** A draft line's quantity typed (autosave per cell). */
  onQuantity?: (lineId: string, text: string) => void
  onRemoveLine?: (lineId: string) => void
  onRemoveLines?: (lineIds: readonly string[]) => void
  onOpenDdt?: () => void
  onPrintDdtAgain?: () => void
  onSaveTracking?: (patch: { trackingRef?: string | null; trackingUrl?: string | null; expectedOn?: string | null }) => void
  onDialog?: (dialog: RecordDialog | null) => void
  onShip?: () => void
  onReceive?: () => void
  onSettle?: () => void
  onCancel?: () => void
  onPickerSearch?: (patch: { q?: string; locationId?: string | null }) => void
  onAddPicked?: () => void
}
