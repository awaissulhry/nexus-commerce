import type { StepUpState } from '../../_shared/hooks'
import type { LiveState } from '../../_shared/model'
import type { DefectChoice, FoundAt, NcrCard, NcrCounts, NcrLane, NcrPrefill, NcrSettingsAnswer, NcrSource, NcrSummary, Person, Severity, SiteChoice, Uom } from '../api'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { ContainmentTimeDraft, NcrAddress, NcrCan, Say } from '../model'
import type { NcrNotice } from '../parts'
import type { CloseDialogActions, CloseDialogModel } from '../view/CloseNcrDialog'
import type { EscalateActions, EscalateModel } from '../view/EscalateDialog'

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
 * B-W2b-17: the title is the prefill's parts in the reader's words (`title`, made by the caller with model.ts
 * titleWords); the API's English `title` only when it has no parts. Left out with parts: the dialog words it itself.
 */
export function draftOf(prefill: NcrPrefill, current: NewNcrDraft, title?: string | null): NewNcrDraft {
  const keep = <K extends keyof NewNcrDraft>(key: K, value: NewNcrDraft[K] | null | undefined): NewNcrDraft[K] => (current[key] !== EMPTY_DRAFT[key] || value === null || value === undefined ? current[key] : value)
  return {
    ...current,
    siteId: keep('siteId', prefill.siteId),
    title: keep('title', title ?? (prefill.titleParts ? null : prefill.title)),
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
      /**
       * B-W2b-17: the containment time the NCR gets when nobody says otherwise (hours after it was found): from the
       * prefill, or the company's setting for an NCR by hand. null: still read; 'failed': the factory sets it at Create.
       */
      readonly containment: { readonly hours: number } | null | 'failed'
      readonly busy: boolean
      readonly notice: NcrNotice | null
    }
  | { readonly kind: 'assign'; readonly ids: readonly string[]; readonly ownerId: string; readonly busy: boolean; readonly notice: NcrNotice | null }
  | {
      /** B-W2b-17: the company's containment time for new NCRs (page ⋯ "Containment time…"). */
      readonly kind: 'containmentTime'
      /** The setting read (null while read). */
      readonly answer: NcrSettingsAnswer | null
      /** Why it could not be read (a `quality` problem key). */
      readonly problem: string | null
      readonly draft: ContainmentTimeDraft
      readonly busy: boolean
      readonly notice: NcrNotice | null
    }

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
  /** B-W2b-113: Escalate to CAPA (pop:ncr-capa), the shared dialog's model; null: closed. */
  readonly escalate?: EscalateModel | null
  /**
   * B-W2b-113: the currency of the Cost column (the company's; the list's rows carry minor units without one — EUR until the
   * summary names it).
   */
  readonly currency?: string
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
  /** B-W2b-17: the containment-time dialog. */
  onContainmentTime?: () => void
  onContainmentDraft?: (patch: Partial<ContainmentTimeDraft>) => void
  onSubmitContainmentTime?: () => void
  onRetryContainmentTime?: () => void
  onDialogClose?: () => void
  onExport?: (ids: readonly string[]) => void
  onCopy?: (number: string) => void
  onPrint?: () => void
  onBoardMove?: (card: NcrCard, to: 'CONTAINED' | 'DECIDED' | 'CLOSED') => Promise<boolean>
  onDismissNotice?: () => void
  close?: CloseDialogActions
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  /** B-W2b-113: open Escalate to CAPA for these NCRs (a row's verb, the selection, key e). */
  onEscalate?: (ncrs: readonly { readonly id: string; readonly number: string }[]) => void
  /** B-W2b-113: the shared dialog's actions. */
  escalate?: EscalateActions
  /** B-W2b-113: the NCR report (ncr-pdf) in a new tab. */
  onPrintNcr?: (id: string) => void
}

// ---- B-W2b-113: the CAPA and Cost columns, Escalate to CAPA from the list -------------------------------------------------

/** At most this many NCRs go to one CAPA at once (B-W2b-108's preview reads 50). */
export const ESCALATE_MAX = 50

/** Why a row cannot be escalated (an `ncr` Say), or null: the person's rights, a cancelled NCR, a CAPA it names already. */
export function rowEscalateHeld(row: Pick<NcrSummary, 'number' | 'stage' | 'capa'>, can: Pick<NcrCan, 'manage' | 'capaView'>): Say | null {
  if (!can.manage || !can.capaView) return { key: 'list.heldEscalateRight' }
  if (row.stage === 'CANCELLED') return { key: 'escalate.code.NCR_CANCELLED', params: { number: row.number } }
  if (row.capa) return { key: 'list.heldEscalated', params: { number: row.number, capa: row.capa.number } }
  return null
}

/** The picked rows that may go to a CAPA. */
export const escalatableOf = <Row extends Pick<NcrSummary, 'number' | 'stage' | 'capa'>>(rows: readonly Row[], can: Pick<NcrCan, 'manage' | 'capaView'>): Row[] => rows.filter((row) => rowEscalateHeld(row, can) === null)

/** Why "Escalate N to one CAPA" is held for the rows picked (an `ncr` Say), or null. */
export function bulkEscalateHeld(picked: readonly Pick<NcrSummary, 'number' | 'stage' | 'capa'>[], can: Pick<NcrCan, 'manage' | 'capaView'>, offline: boolean): Say | null {
  if (!can.manage || !can.capaView) return { key: 'list.heldEscalateRight' }
  const going = escalatableOf(picked, can)
  if (going.length === 0) return { key: 'list.heldEscalateNone' }
  if (going.length > ESCALATE_MAX) return { key: 'list.heldEscalateMax' }
  if (offline) return { key: 'list.heldEscalateOffline' }
  return null
}

/** A cost in minor units in the reader's number format and the currency; "—" when there is none. */
export function costText(minor: number | null | undefined, currency: string, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** The cost in the CSV: a plain decimal (the reader's spreadsheet formats it), empty when none. */
export const costCsv = (minor: number | null | undefined): string => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2))
