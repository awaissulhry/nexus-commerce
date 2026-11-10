import type { ScaleRow } from '../styles/api'
import type { Notice, WriteProblem } from '../library/model'
import type { EffectDraft, GroupDraft, GroupRecord, GroupRow, OptionFilters, OptionsCan, OptionTab, PickedRef, RuleItem, StyleOptions, ValueDraft } from './model'

/**
 * The view models of Options & rules (B-W2b-242): the list (SCR-114) and the option group's record (SCR-114-record). The
 * views fetch nothing; the containers (OptionsPage, record/OptionGroupRecord) read and write through ./api and hand
 * these over; the design cases (fixtures.ts) build them from made-up data.
 */

/** New option group and Edit group (pop:options.new): the draft, the companies it may be for, the last refusal. */
export interface GroupFormModel {
  mode: 'new' | 'edit'
  draft: GroupDraft
  companies: Array<{ id: string; name: string }>
  /** A group of every company may be offered (a grant over every company decides at the write). */
  everyCompany: boolean
  busy: boolean
  problem: string | null
  /** The refused fields (paths without `body/`). */
  refused: string[]
  /** The API's own sentences, kept under our words. */
  messages: string[]
}

export interface OptionsViewModel {
  /** `/w/<company>`. */
  prefix: string
  companyId: string | null
  can: OptionsCan
  filters: OptionFilters
  rows: { items: GroupRow[] | null; problem: string | null; ignored: string[] }
  /** The tiles: every group under the filter, those with an option outside the certificate (null: not counted). */
  counts: { all: number; outsideCertificate: number } | null
  countsFailed: boolean
  /** The Style studio's link (`?style=`): the style's offers, option lines and steps. */
  style: { id: string; options: StyleOptions | null; problem: string | null } | null
  asOf: string | null
  updates: number
  dismissed: string[]
  /** What the last action did. */
  notice: Notice | null
  busy: boolean
  newGroup: GroupFormModel | null
  offline?: boolean
  // Design cases only.
  selected?: string[]
  dialog?: 'archive' | 'restore' | 'help' | null
  noticesOpen?: boolean
  focusRow?: number
}

export interface OptionsActions {
  onFilters?: (next: OptionFilters) => void
  onRetry?: () => void
  /** Enter on a row: the group's record. */
  onOpen?: (row: GroupRow) => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onDismiss?: (key: string) => void
  onMove?: (ids: string[], to: 'archive' | 'restore', reason: string) => Promise<boolean>
  onNewGroup?: (open: boolean) => void
  onGroupDraft?: (draft: GroupDraft) => void
  onCreateGroup?: () => void
}

// ---- the record ------------------------------------------------------------------------------------------------------

export type GroupLoad = { status: 'loading' } | { status: 'ready'; value: GroupRecord } | { status: 'error'; problem: string } | { status: 'notFound' } | { status: 'forbidden' }

/** A cell being saved or refused: `<row id>/<field>`. */
export type CellMarks = Readonly<Record<string, { state: 'saving' } | { state: 'refused'; problem: string; params?: Record<string, string | number> }>>

/** Another group's values for the rules' "other option" (read when its group is picked). */
export type OtherValues = ReadonlyArray<{ id: string; code: string; name: string; status: 'ACTIVE' | 'ARCHIVED' }>

export interface RulesModel {
  /** The draft while the person edits (null: the saved rules, nothing changed). */
  items: RuleItem[] | null
  busy: boolean
  problem: string | null
  messages: string[]
  /** The active groups (for the other option's group) and their values by group id. */
  groups: GroupRow[] | null
  values: Readonly<Record<string, OtherValues | 'loading' | 'failed'>>
}

/** A style the Add styles dialog lists. */
export interface StylePick {
  id: string
  code: string
  name: string
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
}

export interface PickerModel {
  q: string
  results: PickedRef[] | null
}

export type RecordDialog =
  | { kind: 'edit'; form: GroupFormModel }
  | { kind: 'archive' | 'restore' }
  | { kind: 'addValue'; draft: ValueDraft; busy: boolean; problem: string | null; refused: string[]; messages: string[] }
  | { kind: 'archiveValue' | 'restoreValue'; valueId: string }
  | { kind: 'certificate'; valueId: string; note: string; busy: boolean; problem: string | null }
  | {
      kind: 'effect'
      mode: 'new' | 'edit'
      effectId: string | null
      draft: EffectDraft
      material: PickerModel
      target: PickerModel
      operation: PickerModel
      busy: boolean
      problem: string | null
      refused: string[]
      messages: string[]
    }
  | { kind: 'removeEffect'; effectId: string }
  | {
      kind: 'styles'
      q: string
      results: StylePick[] | null
      picked: string[]
      busy: boolean
      /** After Add: the styles that took the group, and those refused with their words (the API's English kept as data). */
      outcome: { added: string[]; refused: Array<{ code: string; key: string; message: string | null }> } | null
    }
  | { kind: 'withdraw'; offerId: string }
  | { kind: 'help' }

export interface GroupRecordModel {
  prefix: string
  can: OptionsCan
  tab: OptionTab
  group: GroupLoad
  /** The page's language for numbers ("it-IT"). */
  locale: string
  save: { state: 'idle' | 'saving' | 'failed'; at: string | null }
  cells: CellMarks
  busy: boolean
  notice: Notice | null
  refused: WriteProblem | null
  /** Someone else changed the group meanwhile. */
  changed: { at: string } | null
  offline: boolean
  rules: RulesModel
  /** Effects per size: the size scales and the one whose sizes the grid shows. */
  scales: { items: ScaleRow[] | null; chosen: string | null }
  dialog: RecordDialog | null
  /** Company names for the band ("Every company"). */
  companyName: string | null
}

export interface GroupRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onDismissNotice?: () => void
  // the group
  onGroupDraft?: (draft: GroupDraft) => void
  onSaveGroup?: () => void
  onMoveGroup?: (to: 'archive' | 'restore', reason: string) => void
  // options
  onValueCell?: (valueId: string, field: 'code' | 'name' | 'freeTextMaxLength' | 'freeTextPattern', value: string | number | null) => void
  onFreeText?: (valueId: string, on: boolean) => void
  onPrice?: (valueId: string, text: string) => void
  onCertificate?: (valueId: string, on: boolean) => void
  onSaveCertificate?: () => void
  onMoveValue?: (valueId: string, by: -1 | 1) => void
  onValueStatus?: (valueId: string, to: 'archive' | 'restore', reason: string) => void
  onAddValue?: () => void
  // rules
  onRules?: (items: RuleItem[] | null) => void
  onSaveRules?: () => void
  onOtherGroup?: (groupId: string) => void
  // effects
  onEffectCell?: (effectId: string, field: 'qty' | 'minutes' | 'note', text: string) => void
  onEffectSize?: (effectId: string, size: string, value: string | null) => void
  /** A typed per-size value that is not a number: kept as it was, said in the size columns' words. */
  onSizeRefused?: (size: string, text: string) => void
  onScale?: (scaleId: string | null) => void
  onSearch?: (picker: 'material' | 'target' | 'operation', q: string) => void
  onSaveEffect?: () => void
  onRemoveEffect?: (effectId: string) => void
  // styles
  /** 'invalid': the typed text is no whole number (the cell is marked refused, nothing sent). */
  onOfferCell?: (offerId: string, field: 'minPicks' | 'maxPicks', value: number | null | 'invalid') => void
  onFindStyles?: (q: string) => void
  onAddStyles?: () => void
  onWithdraw?: (offerId: string) => void
}
