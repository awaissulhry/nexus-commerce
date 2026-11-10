import type { AnnexIIIPoint, Hazard, ResidualRisk } from '@nexus/factory-domain/compliance/techfiles/rules'
import type { LiveState } from '../../../quality/_shared/model'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { EvidenceOption, FileRecord, PacksAnswer, PartyOption, PersonOption, Production, ReportsAnswer, RiskAnswer, ShareAnswer } from '../api'
import type { Read, RecordDraft, RecordTab, ScheduleDraft, ShareDraft, TechfilesCan } from '../model'
import type { PackDialogActions, PackDialogModel } from '../view/PackDialog'
import type { Notice } from '../view/parts'

/**
 * The view model of a technical file's record (SCR-120-file) and the actions its views call: one model per record, each tab's
 * read and pop-up in it; the container (TechFileRecord.tsx) reads and writes, the views draw.
 */

/** A pop-up's write in flight and its refusal in our words. */
export interface Writing {
  readonly busy: boolean
  readonly problem: Notice | null
}
export const IDLE: Writing = Object.freeze({ busy: false, problem: null })

/** The band's pop-ups: edit (certificate, keeper, note; a later keep-until when archived), reopen and archive with a reason. */
export type FileDialog =
  | { readonly kind: 'edit'; readonly certificateId: string; readonly keeperId: string; readonly note: string; readonly retainUntil: string }
  | { readonly kind: 'reopen'; readonly reason: string }
  | { readonly kind: 'archive'; readonly reason: string; readonly retainUntil: string }

/** Link evidence (a record or a file of the style; a drawing uploaded onto the file) or "Not applicable" with a note. */
export interface EvidenceDialog {
  readonly point: AnnexIIIPoint
  /** The row it changes; null: a new row of the point. */
  readonly itemId: string | null
  readonly mode: 'link' | 'na'
  readonly options: Read<EvidenceOption[]>
  /** The option chosen (`optionKey`), or ''. */
  readonly choice: string
  readonly note: string
  /** A file chosen on this device to upload onto the technical file and link. */
  readonly upload: { readonly name: string; readonly size: number; readonly type: string } | null
  readonly writing: Writing
}

/** A cell's save mark in the hazards grid. */
export interface Mark {
  readonly state: 'saving' | 'saved' | 'refused' | 'unknown'
  readonly problem?: string
}

export interface RiskUi {
  /** The revision asked (`?rev=`), else the draft, else the newest. */
  readonly shown: string | null
  /** The zone picked on the sketch (a new hazard's zone; the rows of that zone are marked). */
  readonly zone: string | null
  readonly marks: Readonly<Record<string, Mark>>
  readonly selected: readonly string[]
  /** The class reasoning as typed (saved when the field is left). */
  readonly reasoning: string | null
  readonly reasoningMark: Mark | null
  /** Sign the assessment (the typed name and function; a fresh code when pressed). */
  readonly sign: { readonly name: string; readonly fn: string; readonly writing: Writing } | null
  readonly writing: Writing
}

export interface TestDialog {
  readonly kind: 'schedule' | 'record'
  /** Record: the planned test it records (null: record a test done without a plan, planned and recorded at once). */
  readonly testId: string | null
  readonly schedule: ScheduleDraft
  readonly record: RecordDraft
  readonly writing: Writing
}

export interface ShareState {
  readonly packId: string
  readonly draft: ShareDraft
  /** The parties to send it to (parties.view); null: the person cannot read parties. */
  readonly parties: Read<PartyOption[]> | null
  readonly writing: Writing
  /** Sent: the link's address when it was not mailed (shown once), how it went. */
  readonly done: ShareAnswer | null
}

export interface WithdrawState {
  readonly packId: string
  readonly linkId: string
  readonly reason: string
  readonly writing: Writing
}

export interface RecordModel {
  prefix: string
  can: TechfilesCan
  tab: RecordTab
  record: FileRecord
  asOf: string | null
  live: LiveState
  online: boolean
  today: string
  notice: Notice | null
  /** A live change came while a pop-up was open: "Changed at …" with Reload. */
  changedAt: string | null
  dockOpen: boolean
  fileDialog: { readonly dialog: FileDialog; readonly writing: Writing } | null
  keepers: Read<PersonOption[]> | null
  /** The certificates that cover the style (the edit pop-up's choice; evidence-options of point f). */
  certificates: Read<EvidenceOption[]> | null
  /** The Annex III row whose quick action (review, un-review, clear, remove) is being saved. */
  busyItem: string | null
  evidence: EvidenceDialog | null
  risk: Read<RiskAnswer> | null
  riskUi: RiskUi
  reports: Read<ReportsAnswer> | null
  production: Read<Production> | null
  testDialog: TestDialog | null
  packs: Read<PacksAnswer> | null
  share: ShareState | null
  withdraw: WithdrawState | null
  pack: PackDialogModel | null
  stepUp: StepUpState
  keysOpen?: boolean
}

export interface RecordActions {
  onDismissNotice?: () => void
  onReload?: () => void
  onDock?: () => void
  onRetry?: (part: 'risk' | 'reports' | 'production' | 'packs') => void
  // the band
  onComplete?: () => void
  onFileDialog?: (dialog: FileDialog | null) => void
  onFileSave?: () => void
  onPack?: () => void
  // Annex III
  onEvidence?: (point: AnnexIIIPoint, itemId: string | null, mode: 'link' | 'na') => void
  onEvidenceChange?: (patch: Partial<Pick<EvidenceDialog, 'choice' | 'note'>>) => void
  onEvidenceFile?: (file: File | null) => void
  onEvidenceSave?: () => void
  onEvidenceClose?: () => void
  onItem?: (itemId: string, action: 'review' | 'unreview' | 'clear' | 'remove') => void
  onOpenFile?: (fileId: string, name: string) => void
  // the risk assessment
  onRevision?: (assessmentId: string) => void
  onNewRevision?: () => void
  onRemoveRevision?: () => void
  onZone?: (zone: string | null) => void
  onCell?: (rowId: string, cell: 'hazard' | 'garmentZone' | 'intendedUse' | 'foreseeableMisuse' | 'control' | 'standardClause' | 'residualRisk', value: string) => void
  onAddRow?: (hazard?: Hazard, residual?: ResidualRisk) => void
  onRiskSelected?: (ids: string[]) => void
  onRemoveRows?: (ids: readonly string[]) => void
  onReasoning?: (text: string) => void
  onReasoningSave?: () => void
  onSign?: (open: boolean) => void
  onSignChange?: (patch: { name?: string; fn?: string }) => void
  onSignSave?: () => void
  // production control
  onSchedule?: (workOrderId: string | null) => void
  onRecord?: (testId: string | null) => void
  onTestDraft?: (patch: { schedule?: Partial<ScheduleDraft>; record?: Partial<RecordDraft> }) => void
  onTestFile?: (file: File | null) => void
  onTestSave?: () => void
  onTestClose?: () => void
  onRemoveTest?: (testId: string) => void
  // evidence packs
  onOpenPdf?: (packId: string) => void
  onAuthority?: (packId: string) => void
  onShare?: (packId: string | null) => void
  onShareDraft?: (draft: ShareDraft) => void
  onShareSave?: () => void
  onCopyUrl?: (url: string) => void
  onWithdraw?: (packId: string, linkId: string | null) => void
  onWithdrawReason?: (reason: string) => void
  onWithdrawSave?: () => void
  onRemovePack?: (packId: string) => void
  pack?: PackDialogActions
  // the code
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
}

/** An evidence option's key in the picker. */
export const optionKey = (option: Pick<EvidenceOption, 'kind' | 'recordType' | 'recordId' | 'fileId'>): string => `${option.kind}:${option.recordType}:${option.recordId ?? option.fileId ?? ''}`

/** The upload choice's key ("a file from this device"). */
export const UPLOAD_CHOICE = 'UPLOAD'
