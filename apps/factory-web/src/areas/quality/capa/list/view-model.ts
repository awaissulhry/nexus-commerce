import type { ListMode } from '../../../../list-frame/w2b/model'
import type { LiveState } from '../../_shared/model'
import type { CapaCounts, CapaPerson, CapaPriority, CapaRow, CapaType, CapaView, CustomerChoice, Person, SourceChoice } from '../api'
import type { CapaAddress, CapaCan, NewDraft } from '../model'
import type { CapaNotice } from '../parts'
import type { CloseDialogActions, CloseDialogModel } from '../view/CloseCapaDialog'

/** New CAPA (design pop:capa-new): the draft, its pickers and the sources read from the address. */
export interface NewDialog {
  readonly kind: 'new'
  readonly draft: NewDraft
  /** Who may own it (GET /quality/capa/people); 'failed': the read failed (the owner stays the caller). */
  readonly people: readonly CapaPerson[] | null | 'failed'
  /** The sources found for the words typed (open NCRs and complaints). */
  readonly found: { readonly q: string; readonly items: readonly SourceChoice[] | null; readonly problem: string | null }
  readonly customers: { readonly items: readonly CustomerChoice[] | null; readonly problem: string | null }
  /** Opened from records (`&from=&ids=`): still reading what they say, or why that failed. */
  readonly from: { readonly reading: boolean; readonly problem: string | null } | null
  readonly busy: boolean
  readonly notice: CapaNotice | null
}

export type ListDialog = NewDialog

export interface CapaListModel {
  readonly prefix: string
  readonly me: string
  readonly companyId: string | null
  readonly today: string
  readonly can: CapaCan
  readonly address: CapaAddress
  readonly rows: { readonly items: readonly CapaRow[] | null; readonly more: boolean; readonly problem: string | null }
  readonly counts: CapaCounts | null
  /** The names the list answer brings (owners and team). */
  readonly people: readonly Person[] | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly notice: CapaNotice | null
  /** A card being moved on the board. */
  readonly moving: string | null
  readonly dialog: ListDialog | null
  readonly close: CloseDialogModel | null
  /** Design only: the rows picked, the focused row, the keys dialog open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface CapaListActions {
  onView?: (view: CapaView) => void
  onSearch?: (q: string) => void
  onType?: (type: CapaType | null) => void
  onPriority?: (priority: CapaPriority | null) => void
  onMode?: (mode: ListMode) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onOpen?: (capaId: string) => void
  onNew?: () => void
  onDialogClose?: () => void
  onNewDraft?: (patch: Partial<NewDraft>) => void
  onFindSources?: (q: string) => void
  onPickSource?: (choice: SourceChoice) => void
  onDropSource?: (recordId: string) => void
  onFindCustomers?: (q: string) => void
  onSubmitNew?: () => void
  onBoardMove?: (row: CapaRow, lane: string) => Promise<boolean>
  close?: CloseDialogActions
  onCopy?: (numbers: readonly string[]) => void
  onPrint?: () => void
  onDismissNotice?: () => void
}
