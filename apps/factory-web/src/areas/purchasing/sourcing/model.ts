import type { Uom } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { MAX_SAMPLE_LINES, SAMPLE_LINE_KINDS, SAMPLE_ORDER_REFUSALS, type SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Choices, CreateBody, MaterialChoice, SampleRow } from './api'

/**
 * The rules of Purchasing › Sourcing & claims › RFQs & sourcing (SCR-222; B-W2b-347; design purchasing.sourcing), pure: what
 * the address holds (the list's rows, status and words; New sample order `?new=1`), who may do what (purchasing.view reads,
 * purchasing.manage drafts, the cost grain sees the value and opens the PDF), the New sample order draft (each line: what it buys
 * — a sample hide, a swatch, a colour card —, the material, its colour, how much in which of its units, by when) and why Create
 * draft is held, the body it sends, and a refused write in the page's words. The RFQ list and record are Later in the design:
 * nothing here draws them.
 */

export const SOURCING_NAMESPACE = 'purchasing-sourcing'

// ---- the address -------------------------------------------------------------------------------------------------------------

export const ROW_FILTERS = ['OPEN', 'ALL'] as const
export type RowFilter = (typeof ROW_FILTERS)[number]

export interface SourcingAddress {
  readonly rows: RowFilter
  readonly status: PurchaseOrderStatus | null
  readonly q: string
  /** New sample order is open. */
  readonly add: boolean
}

export const EMPTY_ADDRESS: SourcingAddress = Object.freeze({ rows: 'OPEN', status: null, q: '', add: false })

const isStatus = (value: string | null): value is PurchaseOrderStatus => value !== null && (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)

export function addressOf(params: Pick<URLSearchParams, 'get'>): SourcingAddress {
  const status = params.get('status')
  return {
    rows: params.get('rows') === 'all' ? 'ALL' : 'OPEN',
    status: isStatus(status) ? status : null,
    q: (params.get('q') ?? '').slice(0, 60),
    add: params.get('new') === '1',
  }
}

export function addressText(address: SourcingAddress): string {
  const query = new URLSearchParams()
  if (address.rows === 'ALL') query.set('rows', 'all')
  if (address.status) query.set('status', address.status)
  if (address.q) query.set('q', address.q)
  if (address.add) query.set('new', '1')
  const text = query.toString()
  return text ? `?${text}` : ''
}

export const withAddress = (address: SourcingAddress, change: Partial<SourcingAddress>): SourcingAddress => ({ ...address, ...change })

export const isFiltered = (address: SourcingAddress): boolean => address.status !== null || address.q.trim() !== '' || address.rows === 'ALL'

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface SourcingCan {
  /** purchasing.view: the page reads. */
  readonly view: boolean
  /** purchasing.manage: New sample order. */
  readonly manage: boolean
  /** The cost grain: the value column and the PDF (it prints prices). */
  readonly cost: boolean
}

export function sourcingCan(permissions: readonly string[]): SourcingCan {
  const held = new Set(permissions)
  return { view: held.has('purchasing.view'), manage: held.has('purchasing.manage'), cost: held.has('money.cost') }
}

// ---- the rows in words -------------------------------------------------------------------------------------------------------

/** The rows' status filter: open ones (default), every one, or one status. */
export const STATUS_FILTERS: readonly PurchaseOrderStatus[] = PURCHASE_ORDER_STATUSES

/** "GIA-DEMO-01 Giacca Demo" (the style alone when the order buys for no round). */
export const styleText = (row: Pick<SampleRow, 'style'>): string => (row.style ? `${row.style.code} ${row.style.name}` : '—')

/** What a row buys: its first lines' words ("Pelle campione · SEED-LEA-100"), the rest counted by the view. */
export const itemsText = (row: Pick<SampleRow, 'items'>): string => row.items.map((item) => `${item.description ?? item.name} · ${item.code}`).join('; ')

// ---- New sample order --------------------------------------------------------------------------------------------------------

export interface LineDraft {
  /** The row's own key in the dialog (never sent). */
  readonly key: string
  readonly what: SampleLineKind
  readonly itemId: string | null
  readonly itemColourId: string | null
  readonly quantity: string
  readonly uom: Uom | null
  readonly needDate: string
  readonly description: string
}

export interface SampleDraft {
  readonly partyId: string | null
  readonly siteId: string | null
  readonly styleId: string | null
  readonly roundId: string | null
  readonly requestedDate: string
  readonly note: string
  readonly lines: readonly LineDraft[]
}

let lineCounter = 0
export function newLine(needDate: string, what: SampleLineKind = 'HIDE', key?: string): LineDraft {
  return { key: key ?? `line-${++lineCounter}`, what, itemId: null, itemColourId: null, quantity: '1', uom: null, needDate, description: '' }
}

export const emptyDraft = (needDate: string): SampleDraft => ({ partyId: null, siteId: null, styleId: null, roundId: null, requestedDate: '', note: '', lines: [newLine(needDate, 'HIDE', 'line-0')] })

export const materialOf = (choices: Choices | null, itemId: string | null): MaterialChoice | null => (choices && itemId ? (choices.materials.find((item) => item.id === itemId) ?? null) : null)

/** Units that pack a material (a whole hide, a roll, a box): a swatch or a colour card is no such pack. */
const PACK_UNITS: readonly Uom[] = ['HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX']

/** The unit a line starts in: a hide in hides when the leather is bought so; a swatch or a colour card in the material's base unit when it is bought by the pack; else its purchase unit. */
export function defaultUnit(what: SampleLineKind, material: MaterialChoice): Uom {
  if (what === 'HIDE') return material.units.includes('HIDE') ? 'HIDE' : material.purchaseUom
  return PACK_UNITS.includes(material.purchaseUom) ? material.baseUom : material.purchaseUom
}

/** A line with its material chosen: its unit (kept when the new material has it), no colour of another material. */
export function withMaterial(line: LineDraft, material: MaterialChoice | null): LineDraft {
  if (!material) return { ...line, itemId: null, itemColourId: null, uom: null }
  const uom = line.uom && material.units.includes(line.uom) ? line.uom : defaultUnit(line.what, material)
  const colour = material.colours.length === 1 ? material.colours[0]!.id : material.colours.some((entry) => entry.id === line.itemColourId) ? line.itemColourId : null
  return { ...line, itemId: material.id, itemColourId: colour, uom }
}

/** A line's kind changed: a hide of a material that is no leather loses its material. */
export function withWhat(line: LineDraft, what: SampleLineKind, choices: Choices | null): LineDraft {
  const material = materialOf(choices, line.itemId)
  if (what === 'HIDE' && material && material.kind !== 'LEATHER') return { ...line, what, itemId: null, itemColourId: null, uom: null }
  return { ...line, what }
}

/** The materials a line may take: a hide only of a leather. */
export const materialsFor = (choices: Choices | null, what: SampleLineKind): readonly MaterialChoice[] => (choices ? (what === 'HIDE' ? choices.materials.filter((item) => item.kind === 'LEATHER') : choices.materials) : [])

const QUANTITY = /^\d{1,10}(?:\.\d{1,4})?$/
/** A quantity as typed ("1,5" or "1.5") in the API's form, or null when it is not one above 0. */
export function quantityOf(text: string): string | null {
  const value = text.trim().replace(',', '.')
  if (!QUANTITY.test(value) || Number(value) <= 0) return null
  return value
}

/** Why a line cannot go yet (a key of the page's words), or null. */
export function lineHeld(line: LineDraft, today: string): string | null {
  if (!line.itemId) return 'held.lineMaterial'
  if (!line.uom) return 'held.lineUnit'
  if (quantityOf(line.quantity) === null) return 'held.lineQuantity'
  if (!line.needDate) return 'held.lineDate'
  if (line.needDate < today) return 'held.linePast'
  return null
}

/** Why Create draft is held (a key of the page's words), or null. */
export function createHeld(input: { readonly draft: SampleDraft; readonly choices: Choices | null; readonly can: SourcingCan; readonly companyId: string | null; readonly busy: boolean; readonly today: string }): string | null {
  const { draft } = input
  if (!input.can.manage) return 'held.manage'
  if (!input.companyId) return 'held.company'
  if (!input.choices) return 'held.choices'
  if (input.busy) return 'held.busy'
  if (!draft.partyId) return 'held.supplier'
  if (!draft.siteId) return 'held.site'
  if (!draft.styleId) return 'held.style'
  if (draft.lines.length === 0) return 'held.lines'
  if (draft.requestedDate && draft.requestedDate < input.today) return 'held.requestedPast'
  for (const line of draft.lines) {
    const held = lineHeld(line, input.today)
    if (held) return held
  }
  return null
}

/** Add another line (at most MAX_SAMPLE_LINES: more go on the record). */
export const mayAddLine = (draft: SampleDraft): boolean => draft.lines.length < MAX_SAMPLE_LINES

/** The draft with the site the dialog starts on (the only one) once the choices are read. */
export const withDefaults = (draft: SampleDraft, choices: Choices): SampleDraft => (draft.siteId || !choices.defaultSiteId ? draft : { ...draft, siteId: choices.defaultSiteId })

/** The style chosen: a round of another style is dropped. */
export function withStyle(draft: SampleDraft, styleId: string | null, choices: Choices | null): SampleDraft {
  const style = choices?.styles.find((entry) => entry.id === styleId) ?? null
  const round = style?.rounds.some((entry) => entry.id === draft.roundId) ? draft.roundId : null
  return { ...draft, styleId: style?.id ?? null, roundId: round }
}

export function bodyOf(draft: SampleDraft, companyId: string): CreateBody {
  return {
    companyId,
    siteId: draft.siteId!,
    partyId: draft.partyId!,
    developmentStyleId: draft.styleId!,
    sampleRoundId: draft.roundId,
    requestedDate: draft.requestedDate || null,
    note: draft.note.trim() || null,
    lines: draft.lines.map((line) => ({
      what: line.what,
      itemId: line.itemId!,
      itemColourId: line.itemColourId,
      quantity: quantityOf(line.quantity)!,
      uom: line.uom!,
      needDate: line.needDate,
      description: line.description.trim() || null,
    })),
  }
}

export const LINE_KINDS: readonly SampleLineKind[] = SAMPLE_LINE_KINDS

// ---- a refused write, a failed read ------------------------------------------------------------------------------------------

export interface Problem {
  /** A key of the page's words. */
  readonly key: string
  /** The field it names (`partyId`, `lines`), when it names one. */
  readonly field: string | null
  /** The line it names (0-based), when it names one. */
  readonly line: number | null
}

const REFUSALS = new Set<string>(SAMPLE_ORDER_REFUSALS)
const FIELD_WORDS = new Set(['partyId', 'siteId', 'developmentStyleId', 'sampleRoundId', 'requestedDate', 'note', 'contactId'])
const LINE_FIELD_WORDS = new Set(['itemId', 'itemColourId', 'quantity', 'uom', 'needDate', 'description', 'unitPrice'])

export function problemOf(error: unknown): Problem {
  if (!isApiError(error)) return { key: 'problem.write', field: null, line: null }
  let refusal: string | null = null
  let field: string | null = null
  let line: number | null = null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path.startsWith('refusal/') && !refusal) {
      const code = path.slice('refusal/'.length)
      if (REFUSALS.has(code)) refusal = code
      continue
    }
    const at = /^body[./]lines[./](\d+)[./]([a-zA-Z]+)/.exec(path)
    if (at && field === null) {
      line = Number(at[1])
      field = at[2]!
      continue
    }
    const top = /^body[./]([a-zA-Z]+)/.exec(path)
    if (top && field === null) field = top[1]!
  }
  if (refusal) return { key: `refusal.${refusal}`, field, line }
  switch (error.kind) {
    case 'invalid':
      if (line !== null && field && LINE_FIELD_WORDS.has(field)) return { key: `invalid.line.${field}`, field, line }
      if (field && FIELD_WORDS.has(field)) return { key: `invalid.${field}`, field, line }
      return { key: 'problem.invalid', field, line }
    case 'conflict':
      return { key: 'problem.conflict', field, line }
    case 'not_found':
      return { key: field && FIELD_WORDS.has(field) ? `invalid.${field}` : 'problem.gone', field, line }
    case 'forbidden':
    case 'step_up':
      return { key: 'problem.forbidden', field: null, line: null }
    case 'signed_out':
      return { key: 'problem.signedOut', field: null, line: null }
    case 'rate_limited':
      return { key: 'problem.slowDown', field: null, line: null }
    case 'unavailable':
      return { key: 'problem.offline', field: null, line: null }
    default:
      return { key: 'problem.write', field: null, line: null }
  }
}

/** A failed read in the page's words (never drawn as an empty list). */
export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'signed_out') return 'problem.signedOut'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.read'
}

// ---- live --------------------------------------------------------------------------------------------------------------------

/** Every purchase-order event may move a sample order's row (design "purchasing.po.sent → Sample order status"). */
export const isOrdersChange = (change: { readonly type: string }): boolean => change.type.startsWith('purchase_order.')
