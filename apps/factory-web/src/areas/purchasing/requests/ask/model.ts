import { quantityOf } from '@nexus/factory-domain/purchasing/ask-to-buy/ask-to-buy'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { phrase, type Loaded, type Phrase } from '../../../_shared/buying/model'
import type { AskAnswer, AskBody, AskedRequest, AskMaterial, AskOptions, ShortageAnswer, ShortageBody, Uom } from './api'

/**
 * Ask to buy (B-W2b-332; design purchasing.requests pop:ask "Material, quantity, date, reason, work order — Send request";
 * planning.mrp "Short on open work orders": a line becomes a request, or a draft PO in one step) — the dialog's rules, pure:
 * who may ask, the draft and its defaults, why "Send request" is held (in words, the button stays focusable), the bodies
 * the API takes, a refusal in our words, and the asker's own list (status words, what may be taken back). Every key is
 * of the `purchasing-ask` catalogue.
 */

export const ASK_NAMESPACE = 'purchasing-ask'

export interface AskCan {
  /** purchasing.requests.ask: ask, see one's own requests, take one back. */
  ask: boolean
  /** purchasing.manage: "Draft a purchase order now" from a shortage, refuse a request. */
  draft: boolean
  /** purchasing.view: the buyer's queue (everybody's requests). */
  view: boolean
}

export function askCan(permissions: readonly string[]): AskCan {
  const held = new Set(permissions)
  return { ask: held.has('purchasing.requests.ask'), draft: held.has('purchasing.manage'), view: held.has('purchasing.view') }
}

export type AskMode = 'OFFICE' | 'SHORTAGE'

/** A line of the shortage list, as the dialog asks it (planning.mrp's Shortage row). */
export interface ShortageLine {
  siteId: string
  workOrder: { id: string; number: string }
  material: { itemId: string; itemColourId: string | null; label: string; uom: string }
  word: 'NOT_ENOUGH' | 'DELAYED'
  short: string
  neededBy: string
}

export interface AskDraft {
  mode: AskMode
  siteId: string | null
  itemId: string | null
  itemColourId: string | null
  description: string
  quantity: string
  uom: Uom | null
  needDate: string
  reason: string
  workOrderId: string | null
  /** Words for the approver when a rule asks a yes. */
  note: string
  /** SHORTAGE: to the buyers (REQUEST) or a purchase order line now (DRAFT, a buyer). */
  then: 'REQUEST' | 'DRAFT'
}

export type AskDone = { kind: 'sent' | 'waiting'; request: AskedRequest } | { kind: 'drafted'; request: AskedRequest; order: { id: string; number: string; created: boolean } }

export interface AskModel {
  prefix: string
  can: AskCan
  draft: AskDraft
  shortage: ShortageLine | null
  options: Loaded<AskOptions>
  busy: boolean
  offline: boolean
  problem: Phrase | null
  done: AskDone | null
  timeZone?: string
}

export interface AskActions {
  onDraft?: (draft: AskDraft) => void
  onSite?: (siteId: string) => void
  onRetry?: () => void
  onSend?: () => void
  onClose?: () => void
  onAnother?: () => void
}

/** A new request: the first site, the first unit of the material, needed in a week. */
export function newDraft(today: string, siteId: string | null): AskDraft {
  return { mode: 'OFFICE', siteId, itemId: null, itemColourId: null, description: '', quantity: '', uom: null, needDate: plusDays(today, 7), reason: '', workOrderId: null, note: '', then: 'REQUEST' }
}

/** A line of the shortage list: what is short, by when (today when it has passed), for its work order. */
export function shortageDraft(line: ShortageLine, today: string, reason: string, canDraft: boolean): AskDraft {
  return {
    mode: 'SHORTAGE',
    siteId: line.siteId,
    itemId: line.material.itemId,
    itemColourId: line.material.itemColourId,
    description: '',
    quantity: line.short,
    uom: line.material.uom as Uom,
    needDate: line.neededBy < today ? today : line.neededBy,
    reason,
    workOrderId: line.workOrder.id,
    note: '',
    then: canDraft ? 'DRAFT' : 'REQUEST',
  }
}

export function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The material picked (null: none yet, or not among the options). */
export const materialOf = (options: AskOptions | null, itemId: string | null): AskMaterial | null => (options && itemId ? (options.materials.find((item) => item.id === itemId) ?? null) : null)

/** A material picked: its colour cleared, its purchase unit (when it converts) else its base unit. */
export function withMaterial(draft: AskDraft, material: AskMaterial | null): AskDraft {
  if (!material) return { ...draft, itemId: null, itemColourId: null, uom: null }
  const uom = material.units.includes(material.purchaseUom) ? material.purchaseUom : material.baseUom
  return { ...draft, itemId: material.id, itemColourId: material.colours.length === 1 ? material.colours[0]!.id : null, uom }
}

/** Why "Send request" is held, or null (the button stays focusable and says it). */
export function sendHeld(model: Pick<AskModel, 'can' | 'draft' | 'options' | 'busy' | 'offline' | 'done'>): Phrase | null {
  const { draft } = model
  if (!model.can.ask) return phrase('held.noAsk')
  if (draft.mode === 'SHORTAGE' && draft.then === 'DRAFT' && !model.can.draft) return phrase('held.noDraft')
  if (model.busy) return phrase('held.busy')
  if (model.offline) return phrase('held.offline')
  if (model.done) return phrase('held.done')
  if (model.options.status !== 'ready') return phrase('held.loading')
  const today = model.options.value.today
  if (draft.mode === 'OFFICE') {
    if (!draft.siteId) return phrase('held.site')
    const material = materialOf(model.options.value, draft.itemId)
    if (!material) return phrase('held.material')
    if (material.colours.length > 1 && !draft.itemColourId) return phrase('held.colour')
    if (quantityOf(draft.quantity) === null) return phrase('held.quantity')
    if (!draft.uom || !material.units.includes(draft.uom)) return phrase('held.unit')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.needDate) || draft.needDate < today) return phrase('held.needDate')
  }
  if (draft.reason.trim() === '') return phrase('held.reason')
  return null
}

/** "Send request" as the API takes it. */
export function askBodyOf(draft: AskDraft): AskBody {
  return {
    siteId: draft.siteId!,
    itemId: draft.itemId!,
    itemColourId: draft.itemColourId,
    description: draft.description.trim() || null,
    quantity: draft.quantity.trim().replace(',', '.'),
    uom: draft.uom!,
    needDate: draft.needDate,
    reason: draft.reason.trim(),
    workOrderId: draft.workOrderId,
    note: draft.note.trim() || null,
  }
}

/** A shortage asked (or drafted) as the API takes it: the API reads the quantity and the day from the live list. */
export function shortageBodyOf(draft: AskDraft, line: ShortageLine): ShortageBody {
  return { siteId: line.siteId, workOrderId: line.workOrder.id, itemId: line.material.itemId, itemColourId: line.material.itemColourId, reason: draft.reason.trim(), then: draft.then, note: draft.note.trim() || null }
}

/** What the answer means for the asker: sent to the buyers, waiting for a yes, or drafted into a purchase order. */
export function doneOf(answer: AskAnswer | ShortageAnswer): AskDone {
  if ('draft' in answer && answer.draft) return { kind: 'drafted', request: answer.request, order: { id: answer.draft.purchaseOrderId, number: answer.draft.number, created: answer.draft.created } }
  return { kind: answer.request.status === 'PENDING_APPROVAL' ? 'waiting' : 'sent', request: answer.request }
}

const FIELD_PATHS = ['quantity', 'needDate', 'reason', 'description', 'itemId', 'itemColourId', 'uom', 'workOrderId', 'siteId'] as const

/** A refused send in our words: the field it names, a shortage gone or asked already, no rule's approver, else by kind. */
export function sendRefusal(error: unknown): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  const paths = error.issues.map(issuePath).map((path) => path.replace(/\./g, '/'))
  for (const field of FIELD_PATHS) if (paths.some((path) => path === `body/${field}`)) return phrase(`refused.${field}`)
  if (error.kind === 'conflict') {
    if (/not short of this material/.test(error.message)) return phrase('refused.shortageGone')
    if (/asked already/.test(error.message)) return phrase('refused.shortageAsked')
    if (paths.includes('approver')) return phrase('refused.approverSelf')
    return phrase('problem.changed')
  }
  switch (error.kind) {
    case 'forbidden':
    case 'step_up':
      return phrase('problem.forbidden')
    case 'not_found':
      return phrase('problem.gone')
    case 'invalid':
      return phrase('problem.invalid')
    case 'rate_limited':
      return phrase('problem.slowDown')
    case 'unavailable':
      return phrase('problem.offline')
    default:
      return phrase('problem.write')
  }
}

// ---- the asker's own requests -------------------------------------------------------------------------------------------------

export const STATUS_TONE = { OPEN: 'info', PENDING_APPROVAL: 'warning', CONVERTED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' } as const

/** Why a row of one's own list may not be picked (to take it back), or null. */
export const mineSelectableWhy = (row: AskedRequest): Phrase | null => (row.cancel.allowed ? null : phrase(row.status === 'OPEN' || row.status === 'PENDING_APPROVAL' ? 'mine.notYours' : 'mine.decided'))

/** Why "Take back n" is held. */
export function takeBackHeld(rows: readonly AskedRequest[], offline: boolean): Phrase | null {
  if (offline) return phrase('held.offline')
  if (rows.length === 0) return phrase('held.selectFirst')
  if (!rows.some((row) => row.cancel.allowed)) return phrase('mine.decided')
  return null
}

/** Where a request stands, in words: waiting for the buyer, for a yes, in a purchase order, refused, taken back. */
export function standingPhrase(row: AskedRequest): Phrase {
  if (row.status === 'CONVERTED') return row.converted?.purchaseOrder ? phrase('status.inOrder', { number: row.converted.purchaseOrder.number }) : phrase('status.CONVERTED')
  return phrase(`status.${row.status}`)
}

export interface MineModel {
  prefix: string
  can: AskCan
  rows: { items: AskedRequest[] | null; more: boolean; problem: string | null }
  offline: boolean
  timeZone?: string
  /** The take-back dialog (the rows it takes back, the reason). */
  takeBack: { ids: string[]; reason: string; busy: boolean; problem: Phrase | null } | null
  selected?: readonly string[]
}

export interface MineActions {
  onAsk?: () => void
  onRetry?: () => void
  onMore?: () => void
  onTakeBack?: (ids: string[]) => void
  takeBack?: { onReason?: (reason: string) => void; onConfirm?: () => void; onClose?: () => void }
}

/** The words a phrase holds may be keys themselves (a unit): translate those params first. */
export function say(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, words: Phrase): string {
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(words.params ?? {})) params[name] = typeof value === 'string' && /^uom\.[A-Z0-9_]+$/.test(value) ? t(value) : value
  return t(words.key, params)
}
