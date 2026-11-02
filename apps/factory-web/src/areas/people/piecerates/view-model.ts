import type { ReviewState } from '@nexus/ui/patterns'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { Notice, SightState } from '../_shared/parts'
import type { EarningsCounts, EarningsKind, OpenReason, EntryRecord, EntryRow, HeldRecord, HeldRow, OperationOption, Overview, PeriodDetail, PeriodRow, Publication, PublishPreview, RatesPage, Ref, SchemeDetail, SchemesPage, Statement, StatementRow, SwitchView, TableRow, VersionDetail } from './api'
import type { PieceAddress, PieceCan, RateDraft, RateTile, SchemeDraft, VersionDraft, Words } from './model'

/** A read: still running, there, or failed in our words (never drawn as empty). */
export type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; problem: Words }

export interface PreconditionsDraft {
  ccnlName: string
  ccnlArticle: string
  workerNoticeId: string
  dpiaId: string
  consultantName: string
  consultantAgreedOn: string
  schemeId: string
  note: string
}

export interface NewTableDraft {
  name: string
  code: string
  styleId: string
  lineId: string
}

export type PieceDialog =
  | { kind: 'preconditions'; draft: PreconditionsDraft; busy: boolean; problem: Words | null }
  | { kind: 'start'; onFrom: string; reason: string; busy: boolean; problem: Words | null; missing: readonly string[] }
  | { kind: 'stop'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'version'; draft: VersionDraft; table: NewTableDraft | null; editing: { id: string; version: number } | null; operations: readonly OperationOption[] | null; styles: readonly Ref[]; lines: readonly Ref[]; rateForAll: string; busy: boolean; problem: Words | null }
  | { kind: 'publish'; versionId: string; version: number | null; lineId: string; lines: readonly Ref[]; preview: Read<PublishPreview>; onFloor: boolean; printed: boolean; busy: boolean; problem: Words | null }
  | { kind: 'confirm'; ids: readonly string[]; rates: number; rows: readonly { id: string; label: string; from: string; trial: string; refused: Words | null; version: number | null }[] | null; review: ReviewState }
  | { kind: 'cancelVersion'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'withdraw'; publication: Publication; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'paper'; publication: Publication; picked: readonly string[]; busy: boolean; problem: Words | null }
  | { kind: 'endScheme'; lastDay: string; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'deleteScheme'; busy: boolean; problem: Words | null }
  | { kind: 'lock'; busy: boolean; problem: Words | null }
  | { kind: 'backToPreview'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'correct'; amount: string; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'leadOpen'; statementId: string; reason: OpenReason | ''; busy: boolean; problem: Words | null }
  | { kind: 'notPaid'; ids: readonly string[]; reason: string; busy: boolean; problem: Words | null }

export interface PieceBuilt {
  /** The address of a built Office page, or null while it is not built. */
  efficiency: string | null
  attendance: string | null
}

export interface LedgerState {
  entries: readonly EntryRow[] | null
  problem: Words | null
  more: boolean
  loadingMore: boolean
}

export interface PieceModel {
  prefix: string
  can: PieceCan
  address: PieceAddress
  today: string
  scope: OfficeScope
  sight: SightState
  /** The site the page works in; null with All sites. */
  siteId: string | null
  overview: Read<Overview>
  gate: Read<SwitchView> | null
  /** Piece pay was on here: the sections about people exist. */
  ever: boolean
  counts: EarningsCounts | null
  reviewCount: number | null
  rates: Read<RatesPage> | null
  selectedRates: readonly string[]
  tables: readonly TableRow[]
  schemes: Read<SchemesPage>
  schemeId: string | null
  scheme: Read<SchemeDetail> | null
  /** The form-card's edit: a draft edited, or a new draft (id null). */
  schemeEdit: { id: string | null; version: number | null; draft: SchemeDraft; busy: boolean; problem: Words | null } | null
  periods: Read<readonly PeriodRow[]> | null
  ledger: LedgerState | null
  lines: readonly Ref[]
  held: Read<readonly HeldRow[]> | null
  selectedHeld: readonly string[]
  /** The records open in their modals. */
  version: Read<VersionDetail> | null
  period: { detail: Read<PeriodDetail>; statements: readonly StatementRow[] | null; busy: boolean; problem: Words | null } | null
  statement: { read: Read<Statement>; busy: boolean; problem: Words | null } | null
  heldRecord: { read: Read<HeldRecord>; note: string; busy: boolean; problem: Words | null } | null
  entry: Read<EntryRecord> | null
  dialog: PieceDialog | null
  stepUp: { open: boolean; busy: boolean; sentence: string | null; problem: string | null }
  notice: Notice | null
  built: PieceBuilt
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  help: boolean
  busyRun: boolean
}

export interface PieceActions {
  onAddress: (next: Partial<PieceAddress>) => void
  onTile: (tile: RateTile | null) => void
  onSelectSite: (siteId: string) => void
  onDismissNotice: () => void
  onHelp: (open: boolean) => void
  onRetry: () => void
  // the gate
  onPreconditions: () => void
  onPreconditionsDraft: (patch: Partial<PreconditionsDraft>) => void
  onPreconditionsSave: () => void
  onStart: () => void
  onStartDraft: (patch: { onFrom?: string; reason?: string }) => void
  onStartSave: () => void
  onStop: () => void
  onStopSave: () => void
  onDialogReason: (reason: string) => void
  onStepUpSubmit: (code: string) => void
  onStepUpCancel: () => void
  onCloseDialog: () => void
  // rates
  onSelectRates: (ids: string[]) => void
  onNewVersion: (from?: { tableId: string } | 'library') => void
  onEditRates: (detail: VersionDetail) => void
  onVersionDraft: (patch: Partial<VersionDraft>) => void
  onTableDraft: (patch: Partial<NewTableDraft> | null) => void
  onRateDraft: (key: string, patch: Partial<RateDraft>) => void
  onAddRate: () => void
  onRemoveRate: (key: string) => void
  onLibrary: () => void
  onRateForAll: (value: string) => void
  onVersionSave: () => void
  onOpenVersion: (id: string | null) => void
  onPublish: (versionId?: string) => void
  onPublishDraft: (patch: { versionId?: string; lineId?: string; onFloor?: boolean; printed?: boolean }) => void
  onPublishSave: () => void
  onPutInForce: () => void
  onConfirmVersion: () => void
  onCancelVersion: () => void
  onCancelVersionSave: () => void
  onWithdraw: (publication: Publication) => void
  onWithdrawSave: () => void
  onPaper: (publication: Publication) => void
  onPaperPick: (workerId: string, picked: boolean) => void
  onPaperSave: () => void
  onConfirmRates: () => void
  onConfirmRatesSave: () => void
  // schemes
  onPickScheme: (id: string) => void
  onNewScheme: (fromCurrent: boolean) => void
  onEditScheme: () => void
  onSchemeDraft: (patch: Partial<SchemeDraft>) => void
  onSchemeDiscard: () => void
  onSchemeSave: () => void
  onActivateScheme: () => void
  onEndScheme: () => void
  onEndSchemeDraft: (patch: { lastDay?: string; reason?: string }) => void
  onEndSchemeSave: () => void
  onDeleteScheme: () => void
  onDeleteSchemeSave: () => void
  // periods
  onRunBand: () => void
  onOpenPeriod: (id: string | null) => void
  onPeriodStep: (step: 'run' | 'reopen' | 'review') => void
  onLock: () => void
  onLockSave: () => void
  onBack: () => void
  onBackSave: () => void
  onOpenStatement: (id: string | null) => void
  onApprove: () => void
  onLeadOpen: (statementId: string) => void
  onLeadReason: (reason: OpenReason | '') => void
  onLeadOpenSave: () => void
  onLeadReview: () => void
  // ledger
  onLedgerMore: () => void
  onOpenEntry: (id: string | null) => void
  onCorrect: () => void
  onCorrectDraft: (patch: { amount?: string; reason?: string }) => void
  onCorrectSave: () => void
  // held
  onSelectHeld: (ids: string[]) => void
  onOpenHeld: (id: string | null) => void
  onHeldNote: (note: string) => void
  onCountHeld: (ids?: readonly string[]) => void
  onNotPaid: (ids?: readonly string[]) => void
  onNotPaidSave: () => void
}

export type { EarningsKind }
