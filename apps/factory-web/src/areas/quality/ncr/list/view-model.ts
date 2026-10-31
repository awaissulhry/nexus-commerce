import type { StepUpState } from '../../_shared/hooks'
import type { LiveState } from '../../_shared/model'
import type { DefectChoice, FoundAt, NcrCard, NcrCounts, NcrLane, NcrPrefill, NcrSource, NcrSummary, Person, Severity, SiteChoice, Uom } from '../api'
import type { NcrAddress, NcrCan } from '../model'
import type { NcrNotice } from '../parts'
import type { CloseDialogActions, CloseDialogModel } from '../view/CloseNcrDialog'

/** What New NCR holds while it is typed (design pop:ncr-new). Photos are kept by the container; here their names. */
export interface NewNcrDraft {
  siteId: string
  title: string
  description: string
  quantityAffected: string
  quantitySuspect: string
  uom: Uom
  severity: Severity | ''
  defectCodeId: string
  zone: string
  source: NcrSource
  foundAt: FoundAt
  ownerId: string
  photos: readonly string[]
}

export const EMPTY_DRAFT: NewNcrDraft = {
  siteId: '',
  title: '',
  description: '',
  quantityAffected: '',
  quantitySuspect: '',
  uom: 'PCS',
  severity: '',
  defectCodeId: '',
  zone: '',
  source: 'OTHER',
  foundAt: 'IN_LINE',
  ownerId: '',
  photos: [],
}

/**
 * The draft as the record's prefill says it (what was found, where, how much). The prefill arrives after the dialog
 * opens: what the person typed meanwhile stays; the prefill fills only what is still empty or at its default.
 */
export function draftOf(prefill: NcrPrefill, current: NewNcrDraft): NewNcrDraft {
  const keep = <K extends keyof NewNcrDraft>(key: K, value: NewNcrDraft[K] | null | undefined): NewNcrDraft[K] => (current[key] !== EMPTY_DRAFT[key] || value === null || value === undefined ? current[key] : value)
  return {
    ...current,
    siteId: keep('siteId', prefill.siteId),
    title: keep('title', prefill.title),
    description: keep('description', prefill.description),
    quantityAffected: keep('quantityAffected', prefill.quantityAffected),
    uom: keep('uom', prefill.uom),
    severity: keep('severity', prefill.severity),
    defectCodeId: keep('defectCodeId', prefill.defectCodeId),
    zone: keep('zone', prefill.zone),
    source: keep('source', prefill.source),
    foundAt: keep('foundAt', prefill.foundAt),
  }
}

export type ListDialog =
  | {
      readonly kind: 'new'
      readonly draft: NewNcrDraft
      /** Raised from a record: its prefill (null while read), or why it could not be read. */
      readonly from: { readonly recordType: string; readonly recordId: string; readonly prefill: NcrPrefill | null; readonly problem: string | null } | null
      /** The defect library (null while read; 'failed': the NCR is made without a code). */
      readonly defects: readonly DefectChoice[] | null | 'failed'
      readonly busy: boolean
      readonly notice: NcrNotice | null
    }
  | { readonly kind: 'assign'; readonly ids: readonly string[]; readonly ownerId: string; readonly busy: boolean; readonly notice: NcrNotice | null }

export interface NcrListModel {
  readonly prefix: string
  readonly can: NcrCan
  readonly address: Pick<NcrAddress, 'view' | 'q' | 'siteId' | 'mode'>
  /** The company's sites (null: not read; [] none listed). */
  readonly sites: readonly SiteChoice[] | null
  readonly rows: { readonly items: readonly NcrSummary[] | null; readonly truncated: boolean; readonly problem: string | null }
  readonly lanes: { readonly items: readonly NcrLane[] | null; readonly problem: string | null }
  /** The tiles (null: not counted — each tile says "—"). */
  readonly counts: NcrCounts | null
  /** Office people by name (null: not read). */
  readonly people: readonly Person[] | null
  readonly asOf: string | null
  /** The clock the due words read (the last read's). */
  readonly now: string
  readonly live: LiveState
  readonly updates: number
  readonly notice: NcrNotice | null
  /** The card being moved. */
  readonly moving: string | null
  readonly dialog: ListDialog | null
  readonly close: CloseDialogModel | null
  readonly stepUp: StepUpState
  /** Design cases: rows picked, the keys dialog open, a focused row. */
  readonly selected?: readonly string[]
  readonly keysOpen?: boolean
  readonly focusRow?: number
}

export interface NcrListActions {
  onView?: (view: NcrAddress['view']) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onMode?: (mode: NcrAddress['mode']) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onNew?: () => void
  onNewDraft?: (patch: Partial<NewNcrDraft>) => void
  onPhotos?: (files: readonly File[]) => void
  onSubmitNew?: () => void
  onAssign?: (ids: readonly string[]) => void
  onAssignOwner?: (ownerId: string) => void
  onSubmitAssign?: () => void
  onDialogClose?: () => void
  onExport?: (ids: readonly string[]) => void
  onCopy?: (number: string) => void
  onPrint?: () => void
  onBoardMove?: (card: NcrCard, to: 'CONTAINED' | 'DECIDED' | 'CLOSED') => Promise<boolean>
  onDismissNotice?: () => void
  close?: CloseDialogActions
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}
