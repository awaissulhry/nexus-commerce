import type { StepUpState } from '../../_shared/hooks'
import type { MappingAnswer, MappingKey, MappingKind, MappingRow } from './api'
import type { AddDraft, MappingAddress, MappingCan, MappingView, Phrase, WriteProblem } from './model'

/**
 * SCR-480 — Account mapping's view models (the views draw them and fetch nothing; MappingPage.tsx fills them from the API,
 * the design cases from made-up data).
 */

export type LiveState = 'connecting' | 'live' | 'offline'

/** One key open in its dialog: its rows (earlier, in force, upcoming), a new row's draft, an upcoming row being changed. */
export interface KeyDialogModel {
  readonly key: MappingKey
  readonly draft: AddDraft
  readonly busy: boolean
  readonly problem: WriteProblem | null
  /** An upcoming row being changed (its account and note as typed). */
  readonly editing: { readonly rowId: string; readonly accountCode: string; readonly note: string } | null
  /** The upcoming row a change or a removal is running for. */
  readonly rowBusy: string | null
  readonly rowProblem: WriteProblem | null
  /** What was just done in the dialog ("6101 from 1 December 2026 is added"). */
  readonly done: Phrase | null
}

/** "Map N keys": one account for the keys chosen, from a day; what was made and what was refused, key by key. */
export interface BulkDialogModel {
  readonly keys: readonly MappingKey[]
  readonly draft: AddDraft
  readonly busy: boolean
  /** Running: how many are sent so far. */
  readonly sent: number
  readonly done: { readonly made: readonly string[]; readonly refused: ReadonlyArray<{ readonly id: string; readonly problem: Phrase }> } | null
}

/** Switching the journals on or off (the reason kept in the history; a fresh code asked first). */
export interface SwitchDialogModel {
  readonly reason: string
  readonly busy: boolean
  readonly problem: WriteProblem | null
}

export interface MappingPageModel {
  readonly prefix: string
  readonly can: MappingCan
  /** Today in Rome (the answer's, once read). */
  readonly today: string
  readonly address: MappingAddress
  readonly live: LiveState
  readonly answer: MappingAnswer | null
  readonly problem: string | null
  readonly slow: boolean
  readonly readAt: number | null
  /** Live changes behind "N updates · Show". */
  readonly updates: number
  readonly notice: Phrase | null
  readonly key: KeyDialogModel | null
  readonly bulk: BulkDialogModel | null
  readonly switching: SwitchDialogModel | null
  readonly stepUp: StepUpState
  /** Design cases: the selected rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface MappingActions {
  onKind?: (kind: MappingKind | null) => void
  onView?: (view: MappingView) => void
  onSearch?: (q: string) => void
  /** Every key again: no kind, the All view, no search. */
  onClear?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  /** Export N (CSV) of the rows chosen, or the whole mapping (⋯). */
  onExport?: (keys: readonly MappingKey[]) => void
  // the key's dialog
  onOpen?: (key: MappingKey) => void
  onClose?: () => void
  onDraft?: (patch: Partial<AddDraft>) => void
  onAdd?: () => void
  onEdit?: (row: MappingRow | null) => void
  onEditDraft?: (patch: { accountCode?: string; note?: string }) => void
  onSaveEdit?: () => void
  onRemove?: (row: MappingRow) => void
  // Map N keys
  onBulk?: (keys: readonly MappingKey[]) => void
  onBulkDraft?: (patch: Partial<AddDraft>) => void
  onBulkGo?: () => void
  onBulkClose?: () => void
  // the journals switch
  onSwitchOpen?: () => void
  onSwitchReason?: (text: string) => void
  onSwitchGo?: () => void
  onSwitchClose?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
