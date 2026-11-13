import type { LiveState } from '../../../quality/_shared/model'
import type { Appointment, FittingResult, FittingsTab, MtmCheck, Person, ProfileRecord, RepeatFacts, Sent, StyleDetail, StyleOption } from '../api'
import type { BookDraft, MtmCan, Notice, Phrase, ProofLine, RecordTab, ResultDraft, ReviewDraft } from '../model'
import type { LinkDialogActions, LinkDialogModel, MeasurementsDialogActions, MeasurementsDialogModel, QuoteDialogActions, QuoteDialogModel, Read } from '../view-model'

export type Loaded = { status: 'loading' } | { status: 'ready'; record: ProfileRecord } | { status: 'notFound' } | { status: 'forbidden' } | { status: 'error'; problem: string }

/** Measurements › Certified range check (design rider.meas.range): per MTM style, inside or outside, base size, ratios. */
export interface RangeModel {
  readonly styles: Read<readonly StyleOption[]>
  readonly styleId: string
  readonly style: StyleDetail | null
  readonly colourwayId: string
  readonly check: MtmCheck | null
  readonly checking: boolean
  readonly problem: string | null
}

export interface AppointmentPanel {
  readonly kind: 'appointment'
  readonly id: string
  readonly appointment: Appointment | null
  readonly problem: string | null
  /** What the panel shows: the appointment, or one of its forms. */
  readonly mode: 'view' | 'move' | 'close' | 'cancel'
  readonly move: { readonly startsAt: string; readonly minutes: number; readonly place: string; readonly invite: boolean }
  readonly close: { readonly status: 'DONE' | 'MISSED'; readonly notes: string }
  readonly reason: string
  readonly busy: boolean
  readonly notice: Notice | null
}

export type RecordDialog =
  | { readonly kind: 'review'; readonly draft: ReviewDraft; readonly check: MtmCheck | null; readonly checking: boolean; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'compare'; readonly beforeId: string; readonly afterId: string }
  | { readonly kind: 'fitting'; readonly draft: BookDraft; readonly people: readonly Person[] | null; readonly busy: boolean; readonly notice: Notice | null }
  | AppointmentPanel
  | { readonly kind: 'outcome'; readonly draft: ResultDraft; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'repeat'; readonly facts: RepeatFacts | null; readonly problem: string | null; readonly fromLineId: string; readonly measuredOk: boolean; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'deleteDay'; readonly revisionId: string; readonly revision: number; readonly day: string; readonly reason: string; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'photo'; readonly revisionId: string; readonly fileId: string; readonly view: 'FRONT' | 'SIDE' | 'BACK'; readonly src: string | null; readonly problem: string | null }

/** SCR-036-record — the rider profile (design sales.mtm "Record: Rider profile"). */
export interface ProfileRecordModel {
  readonly prefix: string
  readonly me: string
  readonly companyId: string | null
  readonly today: string
  readonly can: MtmCan
  readonly tab: RecordTab
  readonly loaded: Loaded
  readonly asOf: string | null
  readonly live: LiveState
  /** The record changed while a dialog held work (said instead of reading it under the person's hands). */
  readonly stale: string | null
  readonly notice: Notice | null
  /** The revision the Measurements tab reads (its Listbox); null: the newest. */
  readonly revisionId: string | null
  readonly range: RangeModel
  readonly fittings: Read<FittingsTab>
  readonly sent: Read<Sent>
  readonly proofs: Read<readonly ProofLine[]>
  readonly dialog: RecordDialog | null
  readonly measurements: MeasurementsDialogModel | null
  readonly link: LinkDialogModel | null
  readonly quote: QuoteDialogModel | null
  /** A result just recorded or altered: its words stay on the Fittings tab until the next read. */
  readonly lastResult?: FittingResult | null
  readonly copied?: boolean
}

export interface ProfileRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onRevision?: (revisionId: string) => void
  onDismissNotice?: () => void
  onNewRevision?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  /** Review measurements: the decision picked, the words, the mail. */
  onReviewDraft?: (patch: Partial<ReviewDraft>) => void
  onReview?: () => void
  onCompare?: (patch: { beforeId?: string; afterId?: string }) => void
  /** Book a fitting. */
  onOpenFitting?: () => void
  onBookDraft?: (patch: Partial<BookDraft>) => void
  onBook?: () => void
  /** An appointment's panel. */
  onOpenAppointment?: (id: string) => void
  onAppointmentMode?: (mode: AppointmentPanel['mode']) => void
  onAppointmentDraft?: (patch: Partial<Pick<AppointmentPanel, 'move' | 'close' | 'reason'>>) => void
  onMove?: () => void
  onClose?: () => void
  onCancelAppointment?: () => void
  onInvite?: () => void
  /** Record outcome; then send to alteration or name the new revision. */
  onOpenOutcome?: (appointmentId?: string) => void
  onOutcomeDraft?: (patch: Partial<ResultDraft>) => void
  onChange?: (code: string, patch: { change?: string; note?: string }) => void
  onRecordOutcome?: () => void
  onAlteration?: (result: FittingResult) => void
  onNameRevision?: (result: FittingResult) => void
  /** Repeat order from the latest profile. */
  onOpenRepeat?: () => void
  onRepeatDraft?: (patch: { fromLineId?: string; measuredOk?: boolean }) => void
  onRepeat?: () => void
  /** Photos. */
  onOpenPhoto?: (revisionId: string, fileId: string, view: 'FRONT' | 'SIDE' | 'BACK') => void
  onOpenDeleteDay?: (revisionId: string, revision: number) => void
  onDeleteDayDraft?: (patch: { day?: string; reason?: string }) => void
  onDeleteDay?: () => void
  /** Certified range check. */
  onRangeStyle?: (styleId: string) => void
  onRangeColourway?: (colourwayId: string) => void
  onOpenLink?: () => void
  onOpenQuote?: () => void
  measurements?: MeasurementsDialogActions
  link?: LinkDialogActions
  quote?: QuoteDialogActions
}

export type { Phrase }
