import type { CameraScanner } from '@nexus/ui/floor'
import type { LiveState } from '../../../quality/_shared/model'
import type { CaseCounts, CasePreview, CaseRow, ContactOption, PartyOption, Person } from '../api'
import type { ListAddress, NewDraft, Notice, RowVerb, ServiceCan } from '../model'

/** New case (design pop:service.new): the draft, its pickers, the preview read while typing, the camera. */
export interface NewCaseModel {
  readonly draft: NewDraft
  /** The customers (parties.view); null while reading or without the right. */
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null }
  readonly contacts: { readonly items: readonly ContactOption[] | null; readonly problem: string | null }
  /** Who may own it; 'failed': the read failed (the owner stays the caller). */
  readonly owners: readonly Person[] | null | 'failed'
  /** What the serial, the batch and the customer give the case (POST …/preview), read while the person types. */
  readonly preview: { readonly reading: boolean; readonly value: CasePreview | null; readonly problem: string | null }
  readonly busy: boolean
  readonly offline: boolean
  readonly notice: Notice | null
  /** The camera sheet is open. */
  readonly scanning: boolean
}

export interface NewCaseActions {
  onDraft?: (patch: Partial<NewDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
  onScan?: (open: boolean) => void
  onScanned?: (code: string) => void
  /** The camera (none in a design case or a browser without one: typing still works). */
  scanner?: CameraScanner | null
}

/** SCR-217 — Sales › After-sales › Warranty & service: tiles, notices, the case list, New case. */
export interface ServiceListModel {
  readonly prefix: string
  readonly me: string
  readonly companyId: string | null
  readonly today: string
  readonly can: ServiceCan
  readonly address: ListAddress
  /** The rows: null while read; `problem` when the read failed (never drawn as an empty list). */
  readonly rows: { readonly items: readonly CaseRow[] | null; readonly more: boolean; readonly problem: string | null }
  /** The tiles' counts; null while unknown (each tile says "—"); `countsFailed`: the count failed ("Couldn't count"). */
  readonly counts: CaseCounts | null
  readonly countsFailed: boolean
  /** The owners' names the list answer brings. */
  readonly people: readonly Person[] | null
  readonly asOf: string | null
  readonly live: LiveState
  /** Changes that arrived while the list was on screen ("N updates · Show"). */
  readonly updates: number
  readonly notice: Notice | null
  /** The page notices dismissed on this device (by value). */
  readonly dismissed: readonly string[]
  readonly newCase: NewCaseModel | null
  /** Design only: the rows picked, the focused row, the keys panel open, every notice listed. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  readonly noticesOpen?: boolean
}

export interface ServiceListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onOpen?: (caseId: string) => void
  /** A row's verb opens the case with that verb's dialog (Make repair, Make RMA, Close). */
  onRowVerb?: (row: CaseRow, verb: RowVerb) => void
  onNew?: () => void
  newCase?: NewCaseActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
  onDismissPageNotice?: (id: string) => void
}
