import type { Backorder, Bought, Ddt, DdtPreview, DdtRow, Documents, Evidence, EvidenceKind, Labels, PackingListVersion, ReadyOrder, SentLinks, Shipment, Tracking, TransportBy, Voided } from '../api'
// F-OP-130 (order page N6): the orders that may join a DRAFT.
import type { OrderCandidates } from '../api'
import type { DdtForm, Phrase, RecordTab, ShippingAbilities } from '../model'
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds' // owb-ss3

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
  // F-OP-130 (order page N6, R-5): another order of the customer joins a DRAFT, or its garments go off it.
  | { kind: 'addOrder' }
  | { kind: 'takeOff'; salesOrderId: string }

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
  /** What the order can still put on this DRAFT (Add garments). F-OP-130 (N6): of every order it carries, the first first. */
  ready: Part<ReadyOrder[]> | null
  /**
   * B-W2a-71: the order's lines on this shipment and what stays on backorder (GET …/backorder?shipmentId=). F-OP-130 (N6): of
   * every order it carries, the first first — each order's lines also say whose each shipment line is (lineGroups).
   */
  backorder: Part<Backorder[]>
  /** F-OP-130 (N6): the customer's other open orders that may join this DRAFT, each with its verdict (read when the dialog opens). */
  candidates: Part<OrderCandidates> | null
  /** F-OP-130: the order chosen to join, and what it can still put on this DRAFT. */
  picked: { salesOrderId: string; ready: Part<ReadyOrder | null> } | null
  /** B-W2a-71: every packing list printed for it, newest first (Documents › Other documents). */
  packingLists: Part<PackingListVersion[]>
  /** B-W2a-71: the intra-EU transport evidence (the Export tab). */
  evidence: Part<Evidence>
  /** B-TH-264: the person (the record frame remembers their thread width per record type); the tab's live state is the shell's,
   * beside the record's band. */
  personId?: string | null
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
  /**
   * owb-ss3 (settle L2): the hand-over was refused with these warnings (a payment due before shipping is still open): the dialog says
   * them in words, and its act is "Ship it anyway" (the same hand-over with them as `overrides`). Absent or null: none.
   */
  handOverWarnings?: readonly OrderWarningKind[] | null
}

export interface ShipmentRecordActions {
  onRetry?: () => void
  onRetryPart?: (part: 'ddts' | 'pdf' | 'preview' | 'labels' | 'tracking' | 'documents' | 'ready' | 'backorder' | 'packingLists' | 'evidence' | /* F-OP-130 */ 'candidates') => void
  onReload?: () => void
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
  // F-OP-130 (N6): choose the order that joins (null: back to the list), take an order's garments off this DRAFT.
  onPickOrder?: (salesOrderId: string | null) => void
  // F-OS-203 (B-OS-013): ONE command, with the office's reason.
  onTakeOff?: (salesOrderId: string, reason: string) => void
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
  // Carrier & tracking (B-TH-264: Carrier & label and Tracking & delivery in one tab)
  onDelivery?: (next: { transportBy: TransportBy; carrierCode: string; serviceCode: string }) => void
  onBuyLabels?: () => void
  onPrintLabels?: () => void
  /** F-OS-203 (B-OS-014): null — now; else the time the goods really left and why (when it is not now). */
  onHandOver?: (at: { readonly shippedAt: string; readonly reason: string | null } | null) => void
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
