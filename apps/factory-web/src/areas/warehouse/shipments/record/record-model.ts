import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type { Backorder, Bought, Ddt, DdtPreview, DdtRow, Documents, Evidence, EvidenceKind, Labels, PackingListVersion, ReadyOrder, SentLinks, Shipment, Tracking, TransportBy, Voided } from '../api'
import type { LiveState } from '../hooks'
import type { DdtForm, Phrase, RecordTab, ShippingAbilities } from '../model'

/** SCR-067 — a shipment's view model (ShipmentRecordView draws it and fetches nothing). */

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'not_found' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** A part a tab reads by itself: its value, or why it could not be read (a message key); null value + null problem = reading. */
export interface Part<T> {
  value: T | null
  problem: string | null
}
export const PART_LOADING: Part<never> = Object.freeze({ value: null, problem: null })

/** A PDF read for the viewer (the issued DDT's, or the draft's with the SAMPLE banner). */
export interface PdfPart {
  data: Uint8Array | null
  problem: string | null
  /** The draft's PDF (never stored, no number used). */
  sample: boolean
}

export type RecordDialog =
  | { kind: 'issueDdt' }
  | { kind: 'annulDdt'; ddtId: string }
  | { kind: 'buyLabels' }
  | { kind: 'handOver' }
  | { kind: 'cancel' }
  | { kind: 'delivery' }
  | { kind: 'addLines' }
  | { kind: 'parcel'; parcelId: string | null }
  | { kind: 'sendLink' }
  | { kind: 'unpack' }
  // B-W2a-71 (every day)
  | { kind: 'voidLabels' }
  | { kind: 'freight' }
  | { kind: 'evidenceFile' }
  | { kind: 'evidenceComplete' }
  | { kind: 'evidenceReopen' }
  | { kind: 'evidenceNeed'; needed: boolean }

export interface ShipmentRecordModel {
  /** `/w/<company>`. */
  prefix: string
  can: ShippingAbilities
  tab: RecordTab
  shipment: Loaded<Shipment>
  /** Every DDT of the shipment (live and annulled), newest first. */
  ddts: Part<DdtRow[]>
  /** The live DDT in full (what it says), once issued. */
  ddt: Part<Ddt> | null
  /** The issued DDT's PDF, or the draft's. */
  pdf: PdfPart | null
  /** The draft DDT (what it would say, its problems, the number it would take), while none is live. */
  preview: Part<DdtPreview> | null
  /** The labels (shipping.pack), the tracking (once labelled), the documents that travel. */
  labels: Part<Labels> | null
  tracking: Part<Tracking> | null
  documents: Part<Documents>
  /** What the order can still put on this DRAFT (Add garments). */
  ready: Part<ReadyOrder | null> | null
  /** B-W2a-71: the order's lines on this shipment and what stays on backorder (GET …/backorder?shipmentId=). */
  backorder: Part<Backorder>
  /** B-W2a-71: every packing list printed for it, newest first (Documents › Other documents). */
  packingLists: Part<PackingListVersion[]>
  /** B-W2a-71: the intra-EU transport evidence (the Export tab). */
  evidence: Part<Evidence>
  live: LiveState
  dockOpen: boolean
  /** Someone changed it while a dialog with typed work was open. */
  changed: { at: string } | null
  notice: { tone: 'success' | 'warning' | 'danger' | 'info'; words: Phrase; detail?: string | null } | null
  busy: boolean
  dialog: RecordDialog | null
  dialogProblem: { words: Phrase; detail?: string | null } | null
  /** The DDT form (the issue dialog), and the last buy's outcome / the last sent links (the dialogs' receipts). */
  ddtForm: DdtForm | null
  bought: Bought | null
  sent: SentLinks | null
  /** B-W2a-71: the last void's outcome per parcel (the Void labels dialog's receipt). */
  voided: Voided | null
  /** Design cases: the record panels drawn as a preview. */
  panelsPreview?: RecordPanelsViewModel
}

export interface ShipmentRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'ddts' | 'pdf' | 'preview' | 'labels' | 'tracking' | 'documents' | 'ready' | 'backorder' | 'packingLists' | 'evidence') => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  // Lines & cartons
  onPack?: () => void
  onUnpack?: () => void
  onLineQuantity?: (lineId: string, quantity: number) => void
  onRemoveLine?: (lineId: string) => void
  onAddLines?: (lines: { workOrderSizeId: string; quantity: number }[]) => void
  onPlaceLine?: (lineId: string, parcelId: string | null) => void
  onSaveParcel?: (parcelId: string | null, measures: { grossWeightKg: string; lengthCm: string; widthCm: string; heightCm: string }) => void
  onRemoveParcel?: (parcelId: string) => void
  onPackingList?: () => void
  // Documents
  onDdtForm?: (form: DdtForm) => void
  onPreview?: () => void
  onIssueDdt?: () => void
  onAnnulDdt?: (ddtId: string, reason: string) => void
  onDownloadDdt?: (ddtId: string) => void
  onPrintDdtAgain?: (ddtId: string) => void
  onAttach?: () => void
  onSendLink?: (contactIds: string[], expiresInDays: number) => void
  onOpenFile?: (fileId: string) => void
  // Carrier & label
  onDelivery?: (next: { transportBy: TransportBy; carrierCode: string; serviceCode: string }) => void
  onBuyLabels?: () => void
  onPrintLabels?: () => void
  onHandOver?: () => void
  onCancel?: (reason: string) => void
  // B-W2a-71 (every day)
  onVoidLabels?: (reason: string) => void
  /** Minor units typed, or null: back to the site's rule. */
  onFreight?: (charge: number | null) => void
  onFilePaper?: (kind: EvidenceKind, file: File) => void
  onCompleteEvidence?: (note: string) => void
  onReopenEvidence?: (reason: string) => void
  onEvidenceNeeded?: (needed: boolean, reason: string) => void
}
