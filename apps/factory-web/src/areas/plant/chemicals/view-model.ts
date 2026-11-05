import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { Cabinet, Chemical, ChemicalRecord, Choices, CountsAnswer, LibraryAnswer, ListAnswer } from './api'
import type { ChemicalDraft, ChemicalMode, ChemicalsAddress, ChemicalsCan, Problem, SheetDraft } from './model'

/** One read of one section: loading, its answer, or the problem in words (never drawn as empty). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A line the page says after a write (and what was refused, in words). */
export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** Add chemical (design pop:add): the facts, the first sheet (optional), the site's choices. */
export interface AddState {
  readonly draft: ChemicalDraft
  readonly sheet: SheetDraft
  readonly choices: Read<Choices> | null
  readonly busy: boolean
  readonly problem: Problem | null
  /** The chemical is in the register but its sheet was not taken: it says so and offers Replace SDS on the record. */
  readonly addedWithoutSheet: string | null
}

/** The PDF the window shows: the sheet's bytes once read (a 60-second address read at once). */
export interface PdfState {
  readonly sheetId: string
  readonly read: Read<{ readonly bytes: Uint8Array; readonly fileName: string }>
}

/** The chemical's window (design pop:chem, a DetailModal; J / K over the register's rows). */
export interface OpenState {
  readonly id: string
  readonly read: Read<ChemicalRecord>
  readonly mode: ChemicalMode
  readonly draft: ChemicalDraft | null
  readonly choices: Read<Choices> | null
  readonly sheet: SheetDraft
  readonly reason: string
  readonly busy: boolean
  readonly problem: Problem | null
  readonly pdf: PdfState | null
  /** What the last write did, said in the window. */
  readonly saved: { readonly key: string; readonly params?: Readonly<Record<string, string>> } | null
}

/** Archive N (the register's bulk action): one reason for every chemical chosen, one call each. */
export interface ArchiveManyState {
  readonly ids: readonly string[]
  readonly reason: string
  readonly busy: boolean
}

/** Print cabinet QR (design pop:qr): the cabinets of the scope, the one chosen. */
export interface QrState {
  readonly cabinets: Read<readonly Cabinet[]>
  readonly chosen: string | null
}

export interface ChemicalsPageModel {
  readonly prefix: string
  readonly can: ChemicalsCan
  readonly scope: OfficeScope
  readonly companyId: string | null
  readonly address: ChemicalsAddress
  readonly today: string
  /** This web's address (the cabinet QR holds the floor page under it). */
  readonly origin: string
  readonly counts: Read<CountsAnswer>
  readonly register: Read<ListAnswer>
  readonly library: Read<LibraryAnswer>
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly selected?: readonly string[]
  readonly add: AddState | null
  readonly open: OpenState | null
  readonly archiveMany: ArchiveManyState | null
  readonly qr: QrState | null
  readonly keysOpen?: boolean
}

export interface ChemicalsPageActions {
  onAddress?: (change: Partial<ChemicalsAddress>) => void
  onRetryCounts?: () => void
  onRetryRegister?: () => void
  onRetryLibrary?: () => void
  onDismissNotice?: () => void
  onSelected?: (ids: string[]) => void
  onAddDraft?: (draft: ChemicalDraft) => void
  onAddSheet?: (sheet: SheetDraft, file?: File | null) => void
  onSaveAdd?: () => void
  onEditDraft?: (draft: ChemicalDraft) => void
  onSaveEdit?: () => void
  onReplaceDraft?: (sheet: SheetDraft, file?: File | null) => void
  onReplace?: () => void
  onArchiveReason?: (reason: string) => void
  onArchive?: () => void
  onRestore?: () => void
  onShowSheet?: (sheetId: string) => void
  onRetryOpen?: () => void
  onArchiveMany?: (ids: readonly string[] | null) => void
  onArchiveManyReason?: (reason: string) => void
  onApplyArchiveMany?: () => void
  onQrChoose?: (key: string) => void
  onRetryCabinets?: () => void
}

/** A chemical as the J / K order of the window reads it. */
export type RegisterRow = Chemical
