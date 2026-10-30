import type { PartyDetail, StyleDetail } from '../../quotes/api'
import type { ManualOrderBody, ManualPreview } from '../api'
import { badPrice, manualLines, piecesOf, type DraftLine } from '../daily-model'
import type { OrderAbilities, Phrase } from '../model'
import type { ComposerState } from '../record/record-model'

/**
 * The typed New order (design pop:orders.new → "Create draft order → Lines tab editable until 'Confirm order'";
 * B-W2a-50 on B-W2a-30's manual entry). The API keeps no draft order: the page holds it (and this browser tab's session
 * storage, so a reload keeps the lines), the API prices it as it is typed (POST …/manual/preview) and makes it at once,
 * CONFIRMED, on "Confirm order". Pure rules here; the page is new/NewOrderPage.tsx.
 */

export interface NewOrderHeader {
  companyId: string
  partyId: string
  contactId: string
  customerRef: string
}

/** The page's address holds the dialog's answers (`/sales/orders/new?company=&party=&contact=&ref=`). */
export function newOrderAddress(prefix: string, header: NewOrderHeader): string {
  const query = new URLSearchParams({ company: header.companyId, party: header.partyId })
  if (header.contactId) query.set('contact', header.contactId)
  if (header.customerRef.trim()) query.set('ref', header.customerRef.trim())
  return `${prefix}/sales/orders/new?${query.toString()}`
}

export function headerFromAddress(params: { get(name: string): string | null } | null): NewOrderHeader | null {
  const companyId = params?.get('company') ?? ''
  const partyId = params?.get('party') ?? ''
  if (!companyId || !partyId) return null
  return { companyId, partyId, contactId: params?.get('contact') ?? '', customerRef: params?.get('ref') ?? '' }
}

/** Why a customer takes no order now (the New order dialog's Create), or null. */
export function newOrderHeld(party: Pick<PartyDetail, 'status' | 'taxIdentities'> | null): (Phrase & { params?: { status: string } }) | null {
  if (!party) return { key: 'newOrder.held.customer' }
  if (party.status !== 'ACTIVE') return { key: 'newOrder.held.party', params: { status: party.status } }
  if (!party.taxIdentities.some((identity) => identity.current)) return { key: 'newOrder.held.identity' }
  return null
}

export interface NewOrderDraft {
  lines: DraftLine[]
  requestedDate: string
  promiseDate: string
  internalNote: string
}

export const EMPTY_DRAFT: NewOrderDraft = Object.freeze({ lines: [], requestedDate: '', promiseDate: '', internalNote: '' }) as NewOrderDraft

/** The session-storage key of a draft (one per company and customer). */
export const draftKey = (header: Pick<NewOrderHeader, 'companyId' | 'partyId'>): string => `factory:new-order:${header.companyId}:${header.partyId}`

/** A stored draft read back (anything unreadable is no draft). */
export function parseDraft(text: string | null): NewOrderDraft | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<NewOrderDraft>
    if (!Array.isArray(value.lines)) return null
    const lines = value.lines.filter(
      (line): line is DraftLine => !!line && typeof line.key === 'string' && typeof line.styleId === 'string' && typeof line.colourwayId === 'string' && typeof line.sizes === 'object' && line.sizes !== null && typeof line.price === 'string',
    )
    return {
      lines: lines.map((line) => ({ ...line, lineId: null, locked: false, sizes: Object.fromEntries(Object.entries(line.sizes).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0)) })),
      requestedDate: typeof value.requestedDate === 'string' ? value.requestedDate : '',
      promiseDate: typeof value.promiseDate === 'string' ? value.promiseDate : '',
      internalNote: typeof value.internalNote === 'string' ? value.internalNote : '',
    }
  } catch {
    return null
  }
}

/** What "Confirm order" (and the preview) sends. */
export function manualBody(header: NewOrderHeader, draft: NewOrderDraft): ManualOrderBody {
  return {
    companyId: header.companyId,
    partyId: header.partyId,
    ...(header.contactId ? { contactId: header.contactId } : {}),
    ...(header.customerRef.trim() ? { customerRef: header.customerRef.trim() } : {}),
    ...(draft.requestedDate ? { requestedDate: draft.requestedDate } : {}),
    ...(draft.promiseDate ? { promiseDate: draft.promiseDate } : {}),
    ...(draft.internalNote.trim() ? { internalNote: draft.internalNote.trim() } : {}),
    lines: manualLines(draft.lines),
  }
}

/** The lines the body sends, in its order (the preview's lines and the API's refusals name them by that index). */
export const sentLines = (draft: Pick<NewOrderDraft, 'lines'>): DraftLine[] => draft.lines.filter((line) => piecesOf(line) > 0)

/** Each sent line's net and resolved unit price from the preview, by the draft line's key. */
export function previewByKey(draft: Pick<NewOrderDraft, 'lines'>, preview: ManualPreview | null): { nets: Record<string, number | undefined>; prices: Record<string, string | undefined> } {
  const nets: Record<string, number | undefined> = {}
  const prices: Record<string, string | undefined> = {}
  const lines = preview?.order?.lines ?? []
  sentLines(draft).forEach((line, index) => {
    const priced = lines[index]
    if (!priced || priced.styleId !== line.styleId || priced.colourwayId !== line.colourwayId) return
    nets[line.key] = priced.netAmount
    prices[line.key] = priced.unitPrice
  })
  return { nets, prices }
}

/** Dates typed in the past (the API refuses them too). */
export function dateProblems(draft: Pick<NewOrderDraft, 'requestedDate' | 'promiseDate'>, today: string): { requestedDate?: string; promiseDate?: string } {
  const out: { requestedDate?: string; promiseDate?: string } = {}
  if (draft.requestedDate && draft.requestedDate < today) out.requestedDate = 'newOrder.problem.past'
  if (draft.promiseDate && draft.promiseDate < today) out.promiseDate = 'newOrder.problem.past'
  return out
}

/** Why "Confirm order" waits, or null. */
export function confirmHeld(input: { can: Pick<OrderAbilities, 'manage'>; draft: NewOrderDraft; preview: NewOrderPreview; today: string; busy: boolean }): Phrase | null {
  if (!input.can.manage) return { key: 'held.noManage' }
  if (input.busy) return { key: 'held.busy' }
  if (sentLines(input.draft).length === 0) return { key: 'newOrder.held.lines' }
  if (input.draft.lines.some(badPrice)) return { key: 'amend.held.price' }
  const dates = dateProblems(input.draft, input.today)
  if (dates.requestedDate || dates.promiseDate) return { key: 'newOrder.problem.past' }
  if (input.preview.phase === 'reading' || input.preview.phase === 'idle') return { key: 'newOrder.held.pricing' }
  if (input.preview.phase === 'failed') return { key: 'newOrder.held.previewFailed' }
  if (input.preview.value && !input.preview.value.ok) return { key: 'newOrder.held.problems' }
  return null
}

export interface NewOrderPreview {
  phase: 'idle' | 'reading' | 'ready' | 'failed'
  value: ManualPreview | null
  problem: string | null
}

/** SCR-039 (draft) — the typed New order's view model (NewOrderView draws it and fetches nothing). */
export interface NewOrderModel {
  prefix: string
  can: OrderAbilities
  today: string
  /** The customer as read (names, terms, tax mode); the address's header. */
  header: NewOrderHeader | null
  party: { status: 'loading' } | { status: 'ready'; value: PartyDetail } | { status: 'error'; problem: string } | { status: 'missing' }
  /** The number it will get: undefined while read, null when the company has no single active series. */
  number: string | null | undefined
  draft: NewOrderDraft
  styles: Record<string, StyleDetail | null | undefined>
  composer: ComposerState
  preview: NewOrderPreview
  busy: boolean
  /** "Confirm order" was refused: said above the lines, what was typed stays. */
  problem: Phrase | null
}

export interface NewOrderActions {
  onCells?: (styleId: string, next: Record<string, Record<string, number>>) => void
  onPrice?: (key: string, text: string) => void
  onField?: (field: 'requestedDate' | 'promiseDate' | 'internalNote', value: string) => void
  onComposerQuery?: (query: string) => void
  onComposerPick?: (styleId: string | null) => void
  onComposerToggle?: (colourwayId: string) => void
  onComposerAdd?: () => void
  onConfirm?: () => void
  onDiscard?: () => void
  onRetry?: () => void
}
