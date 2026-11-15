import { reachOf, type Reach } from '../../kit/bulk-model'
import type { Said } from '../template-editor/model'
import type { DocumentSlot, DocumentTemplate, DocumentTemplateKind, DocumentTemplatesAnswer, TemplateLanguage } from './api'

/**
 * Admin › Documents › Document templates (B-W2b-432; design admin.documents sec:doc-templates, PLT-231): one row per kind and
 * language of a company — the version in use (or the code's fixed layout), the open draft, how many versions, the layout it
 * prints with, the last change —, a row opening its editor, and the bulk actions over the selected rows (publish the
 * drafts, back to the fixed layout, delete the drafts; one call per row, each with the version read). Pure.
 */

export interface CompanyChoice {
  id: string
  name: string
}

export type ListRead<T> = { status: 'loading' } | { status: 'failed'; problem: string } | { status: 'ready'; answer: T }

export interface DocRow {
  /** `QUOTE:it`. */
  id: string
  kind: DocumentTemplateKind
  language: TemplateLanguage
  slot: DocumentSlot
  /** The version in use (null: the code's fixed layout prints). */
  active: DocumentTemplate | null
  /** The open draft. */
  draft: DocumentTemplate | null
}

export type DocBulk = 'publish' | 'retire' | 'delete'

export interface ListNotice extends Said {
  tone: 'success' | 'info' | 'warning' | 'danger'
  /** After a bulk run: each refused row (its id: the view names it) and why, in words. */
  refused?: ReadonlyArray<{ id: string; said: Said }>
}

export interface DocTemplatesModel {
  /** `/w/<company>`. */
  prefix: string
  companies: readonly CompanyChoice[]
  /** The company the list shows (templates are a company's: one at a time). */
  companyId: string | null
  read: ListRead<DocumentTemplatesAnswer>
  selected?: readonly string[]
  /** The bulk action asked for (its confirm is open) over these rows. */
  confirm?: { action: DocBulk; rows: readonly DocRow[] } | null
  busy?: boolean
  notice?: ListNotice | null
  asOf?: string | null
  /** Changes made elsewhere since the list was read (live): "N updates · Show". */
  updates?: number
  /** The company's legal data misses this many facts its documents print (null: unknown); its previews refuse until then. */
  legalMissing?: number | null
}

export const rowId = (kind: string, language: string) => `${kind}:${language}`

/** The rows of the answer: each slot with its version in use and its draft (in the API's order: kind, then Italian, English). */
export function rowsOf(answer: DocumentTemplatesAnswer | null): DocRow[] {
  if (!answer) return []
  const byId = new Map(answer.templates.map((template) => [template.id, template]))
  return answer.slots.map((slot) => ({
    id: rowId(slot.kind, slot.language),
    kind: slot.kind,
    language: slot.language,
    slot,
    active: slot.active ? (byId.get(slot.active.id) ?? null) : null,
    draft: slot.draft ? (byId.get(slot.draft.id) ?? null) : null,
  }))
}

/** The version a row opens: its draft, else the version in use; null for a kind that prints the fixed layout and has no draft. */
export const openTarget = (row: Pick<DocRow, 'slot'>): string | null => row.slot.draft?.id ?? row.slot.active?.id ?? null

/** Why a row cannot be ticked (no bulk action reaches it); null when it can. */
export function rowHeld(row: Pick<DocRow, 'slot'>, mayManage: boolean): string | null {
  if (!mayManage) return 'tpl.held.noRight'
  if (!row.slot.draft && !row.slot.active) return 'tpl.list.nothingToDo'
  return null
}

/** Which selected rows a bulk action reaches (and why each other one is left out). */
export function bulkReach(rows: readonly DocRow[], action: DocBulk): Reach<DocRow> {
  return reachOf(rows, (row) => {
    if (action === 'retire') return row.slot.active ? null : 'tpl.bulk.left.fixed'
    return row.slot.draft ? null : 'tpl.bulk.left.noDraft'
  })
}

/** Why "Write a template" (the first draft of a kind and language) waits; null when it may. */
export function startHeld(mayManage: boolean, busy: boolean): string | null {
  if (!mayManage) return 'tpl.held.noRight'
  if (busy) return 'tpl.held.busy'
  return null
}

/** The rows counted for the list's head: in use, drafts, fixed. */
export function counts(rows: readonly DocRow[]): { inUse: number; drafts: number; fixed: number } {
  return { inUse: rows.filter((row) => row.slot.active).length, drafts: rows.filter((row) => row.slot.draft).length, fixed: rows.filter((row) => !row.slot.active).length }
}

/** `?view=documents&company=<id>` (the list's address on the Documents page). */
export function listQuery(view: 'documents' | 'mail', companyId: string | null): string {
  const query = new URLSearchParams({ view })
  if (companyId) query.set('company', companyId)
  return query.toString()
}
