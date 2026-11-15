import { mergeReasonProblem, type DuplicateRecordType, type Likelihood, type MergeRefusal } from '@nexus/factory-domain/imports/duplicates/rules'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { DuplicateCandidate, DuplicatePair, DuplicateReasonFound, ImportDuplicateRow, ImportDuplicates, MergePreview } from './api'

/**
 * Likely duplicates on screen (B-W2b-427; PLT-178): the words of each reason, refusal and use (catalogue
 * `import-duplicates`, keys `dup.*`), where a record opens, which pairs may be ticked for "Merge N", and the merge
 * dialog's state. Pure: the containers (use-duplicates.tsx) fetch, the views draw.
 */

export const NAMESPACE = 'import-duplicates'

const BUILT: ReadonlySet<string> = OFFICE_PAGES

/** The model name a record type opens by (record-links' RECORD_PAGES). */
export const RECORD_MODEL: Readonly<Record<DuplicateRecordType, 'Party' | 'Item'>> = { PARTY: 'Party', MATERIAL: 'Item' }

/** Where a candidate opens (its own page; a supplier opens on the same party page as a customer). */
export function openHref(prefix: string, record: { readonly recordType: DuplicateRecordType; readonly id: string; readonly code: string; readonly companyId: string | null }): string {
  return `${prefix}${recordAddress({ type: RECORD_MODEL[record.recordType], id: record.id, label: record.code, companyId: record.companyId }, BUILT)}`
}

/** A reason in words: its key and its values (a shared domain; a name's score). */
export function reasonWords(reason: DuplicateReasonFound): { key: string; params: Record<string, string | number> } {
  return { key: `dup.reason.${reason.code}`, params: { detail: reason.detail ?? '', score: reason.score ?? 0 } }
}

export const likelihoodTone = (likelihood: Likelihood): 'warning' | 'info' => (likelihood === 'HIGH' ? 'warning' : 'info')

/** The words of a merge refusal (kept and dropped codes as values). */
export function refusalWords(refusal: MergeRefusal, preview: Pick<MergePreview, 'kept' | 'dropped' | 'recordType'>): { key: string; params: Record<string, string> } {
  return { key: `dup.refusal.${refusal}`, params: { kept: preview.kept.code, dropped: preview.dropped.code, what: preview.recordType === 'PARTY' ? 'party' : 'material' } }
}

/** A record's status in words (parties and materials share ACTIVE and ARCHIVED). */
export const statusKey = (status: string): string => `dup.status.${['PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED'].includes(status) ? status : 'OTHER'}`

/** The import's rows worth showing: those with a candidate or an earlier row of the sheet. */
export function shownRows(answer: ImportDuplicates | null): ImportDuplicateRow[] {
  return answer?.supported ? answer.rows.filter((row) => row.candidates.length > 0 || row.sameSheet.length > 0) : []
}

/** A pair as the merge asks it: the record that stays and the duplicate. By default the older record (a) stays. */
export interface MergeAsk {
  readonly recordType: DuplicateRecordType
  readonly kept: { readonly id: string; readonly code: string }
  readonly dropped: { readonly id: string; readonly code: string }
}

export const askOfPair = (recordType: DuplicateRecordType, pair: Pick<DuplicatePair, 'a' | 'b'>, swap = false): MergeAsk =>
  swap ? { recordType, kept: { id: pair.b.id, code: pair.b.code }, dropped: { id: pair.a.id, code: pair.a.code } } : { recordType, kept: { id: pair.a.id, code: pair.a.code }, dropped: { id: pair.b.id, code: pair.b.code } }

/** The merge of a sheet row's new record into a candidate (the candidate stays). */
export const askOfRow = (recordType: DuplicateRecordType, row: ImportDuplicateRow, candidate: Pick<DuplicateCandidate, 'id' | 'code'>): MergeAsk | null =>
  row.recordId ? { recordType, kept: { id: candidate.id, code: candidate.code }, dropped: { id: row.recordId, code: row.key ?? '' } } : null

/** Why a pair cannot be ticked for "Merge N": an archived side, or a person without the right (null: it can). */
export function pairHeld(pair: DuplicatePair, canMerge: boolean): string | null {
  if (!canMerge) return 'dup.held.noRight'
  if (pair.a.status === 'ARCHIVED' || pair.b.status === 'ARCHIVED') return 'dup.held.archived'
  if (pair.b.status === 'BLOCKED') return 'dup.held.blocked'
  return null
}

/** The merge dialog's state: the pair asked, its preview (null while it loads), the reason, a problem in words. */
export interface MergeDialogModel {
  readonly ask: MergeAsk
  readonly preview: MergePreview | null
  readonly problem: string | null
  readonly busy: boolean
  readonly canMerge: boolean
  /** The address prefix (`/w/<company>`) the records open under. */
  readonly prefix: string
}

/** Why "Merge" is held (a key of the catalogue), or null. */
export function mergeHeld(model: Pick<MergeDialogModel, 'preview' | 'busy' | 'canMerge'>, reason: string): string | null {
  if (!model.canMerge) return 'dup.held.noRight'
  if (!model.preview) return 'dup.held.loading'
  if (model.preview.refusals.length > 0) return 'dup.held.refused'
  if (model.busy) return 'dup.held.busy'
  if (mergeReasonProblem(reason)) return 'dup.held.reason'
  return null
}

/** What moves, as lines of words (only what is there). */
export function moveLines(preview: Pick<MergePreview, 'moves' | 'stays'>, which: 'moves' | 'stays'): { key: string; count: number }[] {
  const counts = preview[which]
  return (['contacts', 'addresses', 'taxIdentities', 'colours'] as const).filter((part) => counts[part] > 0).map((part) => ({ key: `dup.${which}.${part}`, count: counts[part] }))
}

/** The bulk merge's outcome as one notice: merged, refused, failed. */
export interface MergeNotice {
  readonly merged: number
  readonly refused: number
  readonly tone: 'success' | 'warning' | 'danger'
}

export function mergeNotice(merged: number, refused: number): MergeNotice {
  return { merged, refused, tone: refused === 0 ? 'success' : merged === 0 ? 'danger' : 'warning' }
}
