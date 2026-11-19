import type { DockPick } from '../view/WorkTab'
import type { DraftRow } from './api'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6) — "Drafts of <customer>" on the Work tab, pure: the address term (`list=drafts`,
 * one of the Work tab's view terms), a row in words (its title, started by whom, its counts, its files, how ready it is, its last
 * change, the day wanted, its conversation), the dock pick of a row (the draft's own conversation), the window's walk (J / K) and the
 * live events a draft list is read again on. Read only: no selection, no export, Accept and Refuse held until the customer sends it.
 */

/** The page term of the view (one of the Work tab's view terms: an address on it gets no default written). */
export const DRAFTS_TERM = Object.freeze({ name: 'list', value: 'drafts' } as const)

/** The Work tab shows the customer's drafts (`list=drafts`). */
export const draftsShown = (params: { get(name: string): string | null } | null): boolean => params?.get(DRAFTS_TERM.name) === DRAFTS_TERM.value

/**
 * The address that opens the view: the page's tab, its lock and `list=drafts` — the sheet's own terms dropped (a rows view, a search
 * would not apply to drafts); the page's dock kept. Picking a rows view again goes through the sheet, which drops `list`.
 */
export function draftsAddress(base: string, partyId: string, params: { get(name: string): string | null } | null): string {
  const query = new URLSearchParams({ tab: 'work', party: partyId, [DRAFTS_TERM.name]: DRAFTS_TERM.value })
  const dock = params?.get('dock')
  if (dock) query.set('dock', dock)
  return `${base}?${query.toString()}`
}

/** Words of this screen: a key of `parties` with its parameters. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The draft's name: its first line's style, else the words for "Untitled draft". */
export const draftTitle = (row: Pick<DraftRow, 'draft'>, untitled: string): string => row.draft?.title?.trim() || untitled

/** "3 lines · 140 pieces · 12 people" (each its own plural; people only when it has a roster). */
export function linesWords(row: DraftRow): Words[] {
  const people = row.draft?.people ?? 0
  return [{ key: 'customers.drafts.lineCount', params: { count: row.lines } }, { key: 'customers.drafts.pieceCount', params: { count: row.pieces } }, ...(people > 0 ? [{ key: 'customers.drafts.peopleCount', params: { count: people } }] : [])]
}

/** "2 logos · 1 sheet" — counts only (a measurement sheet is never named here; its name needs sales.measurements.view). */
export function filesWords(row: DraftRow): Words[] {
  const files = row.draft?.files
  if (!files) return []
  return [
    ...(files.logos.length > 0 ? [{ key: 'customers.drafts.logoCount', params: { count: files.logos.length } }] : []),
    ...(files.references.length > 0 ? [{ key: 'customers.drafts.referenceCount', params: { count: files.references.length } }] : []),
    ...(files.sheets.length > 0 ? [{ key: 'customers.drafts.sheetCount', params: { count: files.sheets.length } }] : []),
  ]
}

/** "5 of 7" and its problems (a mark, in words). The price part is counted only for a price holder (the API's `of`). */
export function readyOf(row: DraftRow): { readonly words: Words; readonly problems: number } | null {
  const readiness = row.draft?.readiness
  if (!readiness) return null
  return { words: { key: 'customers.drafts.ready', params: { done: readiness.done, of: readiness.of } }, problems: readiness.problems }
}

/** "4 · asked the factory designer" (its conversation, for a reader of its thread); null: no conversation to show. */
export function messagesWords(row: DraftRow): Words | null {
  const thread = row.draft?.thread
  if (!thread || thread.messages === 0) return null
  return thread.designerAsked ? { key: 'customers.drafts.messagesAsked', params: { count: thread.messages } } : { key: 'customers.drafts.messages', params: { count: thread.messages } }
}

/** The dock's pick of a draft: its own conversation (PortalOrderRequest is a customer-side dock type). */
export const draftPick = (row: Pick<DraftRow, 'id'>, label: string): DockPick => ({ type: 'PortalOrderRequest', id: row.id, label, companyId: null })

/** The window's walk: the rows' ids in the order shown, the current one. */
export const draftsNav = (rows: readonly Pick<DraftRow, 'id'>[], current: string): { readonly ids: readonly string[]; readonly current: string } => ({ ids: rows.map((row) => row.id), current })

/**
 * Money wall: the "Value at the prices shown" column only for a price holder — the API drops `netShown` (a price-grain field) for
 * anyone else (the key is absent, never 0), so a list whose rows carry none draws no such column.
 */
// F-CP-141 (follow-up 6): + the draft's own value (B-CP-076's `draft.draftValueAmount`, the price grain too).
export const showsValue = (rows: readonly Pick<DraftRow, 'netShown' | 'draft'>[] | null): boolean => !!rows && rows.some((row) => row.netShown !== undefined || (row.draft?.draftValueAmount ?? undefined) !== undefined)

/**
 * F-CP-141 (follow-up 6; the API's B-CP-076): a draft's value — `draft.draftValueAmount` (minor units) when the API sends it, else
 * today's `netShown` (a decimal at the prices shown); null: not known ("—").
 */
export function draftValueOf(row: Pick<DraftRow, 'netShown' | 'draft'>): { readonly minor: number } | { readonly decimal: string } | null {
  const amount = row.draft?.draftValueAmount
  if (amount !== undefined) return amount === null ? null : { minor: amount }
  return row.netShown ? { decimal: row.netShown } : null
}

/** The live events the drafts are read again on (behind "N updates · Show": rows never jump): a draft changed (or discarded), or sent. */
export const draftsTouched = (type: string): boolean => type === 'portal_order_request.draft_changed' || type === 'portal_order_request.sent'

/** The read of the list in its states. */
export type DraftsRead = { readonly status: 'off' } | { readonly status: 'reading' } | { readonly status: 'ready'; readonly rows: readonly DraftRow[] } | { readonly status: 'failed' }
