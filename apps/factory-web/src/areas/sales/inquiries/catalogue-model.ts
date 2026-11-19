import type { CatalogueAccepted, CatalogueRecord } from './api'
import type { InquiriesCan, Loaded, Notice, Phrase } from './model'
// ---- F-CP-157: the accept's line map ----
import type { AcceptMapBody, CatalogueCustomLine, StyleOption } from './api'
import { newLineKey, parseSizes } from './model'
import type { StyleRead } from './view/LinesEditor'
// ---- end F-CP-157

/**
 * B-TH-233 (threads plan TH-3; O-SAL-INQ-LIST.pane-actions-F13, B-TH-040): a catalogue order beside the Incoming list, pure — what
 * may be done now (the API's own `may`, the customer's state, the right, offline: in that order, so the words come before the
 * click), Accept as order (the promise date, a price typed per line — price grain only, blank = the customer's list price today),
 * Accept as quote, Refuse (the words the customer reads), and the receipt. Every word is a key of `sales-inquiries`.
 *
 * Only a SENT catalogue order is decided, once (factory-domain sales/portal-ordering/office decisionProblem); the customer may
 * withdraw it before. Deciding needs orders.manage over its company and customer (a quote also quotes.manage): the production
 * manager reads it and holds every action — "Only sales can accept or refuse a catalogue order" (held, not hidden).
 */

export type CatalogueAction = 'order' | 'quote' | 'refuse'

/** Why an action on the catalogue order waits, in words (null: it may run now). */
export function catalogueHeld(record: CatalogueRecord, action: CatalogueAction, can: Pick<InquiriesCan, 'orders' | 'quotes'>, offline: boolean): Phrase | null {
  const status = record.request.status
  if (status !== 'SENT') return { key: `catalogue.held.${status}` }
  if (!can.orders) return { key: 'catalogue.held.right', params: { right: 'right.orders.manage' } }
  if (action === 'quote' && !can.quotes) return { key: 'held.needs', params: { right: 'right.quotes.manage' } }
  if (!record.may[action]) return { key: 'held.notNow' }
  if (action === 'order') {
    const quoteFirst = orderHeldOf(record) // F-CP-157: a made-to-measure request is accepted as a quote only (GATE-MTM)
    if (quoteFirst) return quoteFirst
  }
  if (offline) return { key: 'held.offline' }
  return null
}

/** The main button follows the order: Accept as order while it may, else Accept as quote; nothing once it is decided. */
export function catalogueMain(record: CatalogueRecord, can: Pick<InquiriesCan, 'orders' | 'quotes'>): CatalogueAction | null {
  if (record.request.status !== 'SENT') return null
  if (catalogueHeld(record, 'order', can, false) === null) return 'order'
  if (catalogueHeld(record, 'quote', can, false) === null) return 'quote'
  return 'order'
}

/** What Accept sends, as typed. */
export interface AcceptDraft {
  readonly as: 'ORDER' | 'QUOTE'
  /** The promise date of the order (YYYY-MM-DD; starts as the date the customer asked for). */
  readonly promiseDate: string | null
  /** By line id: the unit price typed ('' = the customer's list price today). Only with the price grain. */
  readonly prices: Readonly<Record<string, string>>
  /** F-CP-157: by described / made-to-measure line id, the style line(s) it is made into (absent: a request with none). */
  readonly map?: Readonly<Record<string, readonly MapInto[]>>
}

/** The dialog starts from the catalogue order: the date asked, the price the customer was shown on each line (price grain only). */
// F-CP-157: + one style line to name for each described / made-to-measure line (its own style and colourway, when it names them, as
// the first guess; the office decides).
export function acceptDraftOf(record: CatalogueRecord, as: 'ORDER' | 'QUOTE', can: Pick<InquiriesCan, 'price'>): AcceptDraft {
  const prices: Record<string, string> = {}
  for (const line of record.request.lines) prices[line.id] = can.price && typeof line.unitPriceShown === 'string' ? line.unitPriceShown : ''
  const custom = linesToMap(record)
  const map: Record<string, MapInto[]> = {}
  for (const line of custom) map[line.id] = [intoOf(line)]
  return { as, promiseDate: record.request.requestedDate, prices, ...(custom.length > 0 ? { map } : {}) }
}

// ── F-CP-157 (customer page plan C5; 12 §9; the API's B-CP-077; lead note 3: no profile per person in v1) ──────────────────────────
// The office accept window maps each described or made-to-measure line to the style line(s) it is made into (1 to 20: a style the
// company sells in a colourway, its sizes — else the line's own sizes, or its people's when each has one —, for an ORDER maybe a
// typed unit price with the price grain). Held in words until every such line is mapped; the line map is shown before Accept. A
// made-to-measure request is accepted as a QUOTE only (GATE-MTM: made-to-measure has not started); its people stay on the request
// (never copied, never mapped to a measurement profile). The API checks it all again in the command.

/** At most this many style lines one line is made into (factory-domain ACCEPT_MAP_LIMITS.into). */
export const MAP_INTO_MAX = 20

/** One style line a described or made-to-measure line is made into, as typed. */
export interface MapInto {
  readonly key: string
  readonly styleId: string | null
  /** The style's words for the picker (code · name), kept with the pick. */
  readonly styleLabel: string | null
  readonly colourwayId: string | null
  /** "50:5 52:10" ('' = the request line's own sizes, or its people's). */
  readonly sizesText: string
  /** ORDER, price grain only: a unit price ('' = the customer's list price today). */
  readonly price: string
}

/** The request's lines to map, in its order (the API's `acceptMap.lineIds` when it sends them; else every custom line). */
export function linesToMap(record: CatalogueRecord): CatalogueCustomLine[] {
  const custom = [...(record.request.customLines ?? [])].sort((a, b) => a.seq - b.seq)
  const asked = record.request.acceptMap?.lineIds
  return asked ? custom.filter((line) => asked.includes(line.id)) : custom
}

/** The made-to-measure lines (a quote first while made-to-measure has not started). */
export const madeToMeasureLines = (record: CatalogueRecord): CatalogueCustomLine[] => linesToMap(record).filter((line) => line.kind === 'MADE_TO_MEASURE')

/**
 * A new style line for a request line: the style it names as the first guess (a hint only), never its colourway — the office picks
 * the colourway itself, so a line is never mapped without a person deciding it; no sizes, no price.
 */
export function intoOf(line: Pick<CatalogueCustomLine, 'style'> | null): MapInto {
  return { key: newLineKey(), styleId: line?.style?.id ?? null, styleLabel: line?.style ? `${line.style.code} · ${line.style.name}` : null, colourwayId: null, sizesText: '', price: '' }
}

/** The request line's own sizes for one style line: its size rows, else its people's sizes when every person has one; null: none. */
export function ownSizesOf(line: CatalogueCustomLine): Array<{ size: string; quantity: number }> | null {
  if (line.sizes.length > 0) return line.sizes.map((row) => ({ size: row.size, quantity: row.quantity }))
  if (line.byPerson && line.people.length > 0 && line.people.every((person) => person.size !== null)) {
    const counts = new Map<string, number>()
    for (const person of line.people) counts.set(person.size!, (counts.get(person.size!) ?? 0) + 1)
    return [...counts.entries()].map(([size, quantity]) => ({ size, quantity }))
  }
  return null
}

/** The styles a line may be made into: the open range and THIS customer's own label — never another customer's (the brand wall). */
export const mapStylesOf = (styles: readonly StyleOption[], partyId: string): StyleOption[] => styles.filter((style) => !style.brand || style.brand.id === partyId)

const lineList = (lines: readonly { readonly seq: number }[]): string => lines.map((line) => String(line.seq)).join(', ')

/**
 * Why this request is not accepted as an ORDER (null: it may be): a made-to-measure line — a quote first while made-to-measure has
 * not started (GATE-MTM); its people stay on the request. The API's own `acceptMap.orderHeld` says so too.
 */
export function orderHeldOf(record: CatalogueRecord): Phrase | null {
  const mtm = madeToMeasureLines(record)
  if (mtm.length > 0) return { key: 'catalogueMap.held.madeToMeasure', params: { lines: lineList(mtm), count: mtm.length } }
  return record.request.acceptMap?.orderHeld ? { key: 'catalogueMap.held.quoteOnly' } : null
}

/**
 * Why the accept waits on the map, in words (null: every line is mapped and reads): a made-to-measure line as an ORDER (a quote first);
 * a line with no style line named in full (style and colourway); sizes that do not read; several style lines without each one's
 * sizes; one style line with no sizes where the request line gives none (a total, or people in a sheet or sending later); a typed
 * price that is not a price (price grain only).
 */
export function mapHeld(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'price'>): Phrase | null {
  const lines = linesToMap(record)
  if (lines.length === 0) return null
  if (draft.as === 'ORDER') {
    const quoteFirst = orderHeldOf(record)
    if (quoteFirst) return quoteFirst
  }
  const unmapped = lines.filter((line) => !(draft.map?.[line.id] ?? []).some((into) => into.styleId && into.colourwayId))
  if (unmapped.length > 0) return { key: 'catalogueMap.held.unmapped', params: { lines: lineList(unmapped), count: unmapped.length } }
  for (const line of lines) {
    const into = (draft.map?.[line.id] ?? []).filter((one) => one.styleId || one.colourwayId || one.sizesText.trim() || one.price.trim())
    if (into.some((one) => !one.styleId || !one.colourwayId)) return { key: 'catalogueMap.held.half', params: { n: line.seq } }
    if (into.length > MAP_INTO_MAX) return { key: 'catalogueMap.held.tooMany', params: { n: line.seq, max: MAP_INTO_MAX } }
    for (const one of into) {
      const sizes = parseSizes(one.sizesText)
      if (sizes === null) return { key: 'catalogueMap.held.badSizes', params: { n: line.seq } }
      if (Object.keys(sizes).length === 0) {
        if (into.length > 1) return { key: 'catalogueMap.held.sizesOfEach', params: { n: line.seq } }
        if (!ownSizesOf(line)) return { key: line.byPerson ? 'catalogueMap.held.sizesOfPeople' : 'catalogueMap.held.sizesOfTotal', params: { n: line.seq, pieces: line.pieces } }
      }
      if (draft.as === 'ORDER' && can.price && one.price.trim() !== '' && typedPrice(one.price) === null) return { key: 'catalogueMap.held.badPrice', params: { n: line.seq } }
    }
  }
  return null
}

/** The map the accept sends: each line's named style lines (sizes only when typed; a unit price only for an ORDER with the price grain). */
export function mapBodyOf(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'price'>): AcceptMapBody[] {
  return linesToMap(record).flatMap((line) => {
    const into = (draft.map?.[line.id] ?? []).flatMap((one) => {
      if (!one.styleId || !one.colourwayId) return []
      const sizes = parseSizes(one.sizesText) ?? {}
      const price = draft.as === 'ORDER' && can.price ? typedPrice(one.price) : null
      return [{ styleId: one.styleId, colourwayId: one.colourwayId, ...(Object.keys(sizes).length > 0 ? { sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) } : {}), ...(price ? { unitPrice: price } : {}) }]
    })
    return into.length > 0 ? [{ lineId: line.id, into }] : []
  })
}

/** One row of the line map shown before Accept: the request line (its place, its words) and what it becomes. */
export interface LineMapRow {
  readonly id: string
  readonly n: number
  /** The customer's words (a catalogue line: its style · colour). */
  readonly asked: string
  readonly pieces: number
  /** What it becomes: each style line (code · colour · sizes); empty: not mapped yet ("Not mapped yet"). */
  readonly becomes: readonly string[]
  readonly kind: 'CATALOGUE' | 'DESCRIBED' | 'MADE_TO_MEASURE'
}

const sizesWords = (sizes: readonly { readonly size: string; readonly quantity: number }[]): string => sizes.map((row) => `${row.size}:${row.quantity}`).join(' ')

/**
 * The line map, in the request's order: a catalogue line becomes itself; a described or made-to-measure line the style lines named
 * (with the sizes typed, else the line's own / its people's). `styleOf` gives a picked style's detail (its colourway names).
 */
export function lineMapRowsOf(record: CatalogueRecord, draft: AcceptDraft, locale: 'it' | 'en', styleOf: (styleId: string) => StyleRead | undefined): LineMapRow[] {
  const catalogue: LineMapRow[] = record.request.lines.map((line) => ({ id: line.id, n: line.seq, asked: `${line.style.code} · ${line.colourway.code}`, pieces: line.pieces, becomes: [`${line.style.code} · ${line.colourway.code} · ${sizesWords(line.sizes)}`], kind: 'CATALOGUE' as const }))
  const custom: LineMapRow[] = linesToMap(record).map((line) => {
    const own = ownSizesOf(line)
    const into = (draft.map?.[line.id] ?? []).filter((one) => one.styleId && one.colourwayId)
    const becomes = into.map((one) => {
      const read = styleOf(one.styleId!)
      const detail = read?.status === 'ready' ? read.value : null
      const code = detail?.code ?? one.styleLabel?.split(' · ')[0] ?? '—'
      const colour = detail?.colourways.find((entry) => entry.id === one.colourwayId)?.code ?? '—'
      const typed = parseSizes(one.sizesText)
      const sizes = typed && Object.keys(typed).length > 0 ? sizesWords(Object.entries(typed).map(([size, quantity]) => ({ size, quantity }))) : into.length === 1 && own ? sizesWords(own) : '—'
      return `${code} · ${colour} · ${sizes}`
    })
    return { id: line.id, n: line.seq, asked: customWords(line, locale), pieces: line.pieces, becomes, kind: line.kind }
  })
  return [...catalogue, ...custom].sort((a, b) => a.n - b.n)
}

/** A described line's own words, else a made-to-measure line's garment type; with the colours in words. */
export function customWords(line: Pick<CatalogueCustomLine, 'description' | 'garmentType' | 'colourText'>, locale: 'it' | 'en'): string {
  const words = line.description?.trim() || line.garmentType?.words[locale] || '—'
  return line.colourText?.trim() ? `${words} · ${line.colourText.trim()}` : words
}
// ── end F-CP-157 ──

const PRICE = /^\d{1,12}(\.\d{1,6})?$/
/** A typed price as the API takes it (a comma accepted), or null when it is not one. */
export function typedPrice(text: string): string | null {
  const value = text.trim().replace(',', '.')
  return PRICE.test(value) ? value : null
}

/** Why Accept waits: the action's own hold, then a typed price that is not a price (the line named). */
// F-CP-157: + the map's words (a made-to-measure line as an order, a line not mapped yet, …). A line is named by its place on the
// request (`seq`, as the API names it: "Line 2"), never seq / 10 (request lines are 1, 2, 3 …).
export function acceptHeld(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'orders' | 'quotes'> & Partial<Pick<InquiriesCan, 'price'>>, offline: boolean): Phrase | null {
  const held = catalogueHeld(record, draft.as === 'ORDER' ? 'order' : 'quote', can, offline)
  if (held) return held
  if (draft.as === 'ORDER') {
    const bad = record.request.lines.find((line) => (draft.prices[line.id] ?? '').trim() !== '' && typedPrice(draft.prices[line.id] ?? '') === null)
    if (bad) return { key: 'catalogue.accept.badPrice', params: { n: bad.seq } }
  }
  return mapHeld(record, draft, { price: !!can.price }) // F-CP-157
}

/** The Accept body: an order's typed prices (price grain only: a price is never sent without it) and its promise date; a quote alone. */
// F-CP-157: + the map (an order and a quote alike; a unit price on it only for an ORDER with the price grain).
export function acceptBodyOf(record: CatalogueRecord, draft: AcceptDraft, can: Pick<InquiriesCan, 'price'>): { version: number; as: 'ORDER' | 'QUOTE'; promiseDate?: string | null; lines?: Array<{ lineId: string; unitPrice: string }>; map?: AcceptMapBody[] } {
  const map = mapBodyOf(record, draft, can) // F-CP-157
  if (draft.as === 'QUOTE') return { version: record.request.version, as: 'QUOTE', ...(map.length > 0 ? { map } : {}) }
  const lines = can.price
    ? record.request.lines.flatMap((line) => {
        const price = typedPrice(draft.prices[line.id] ?? '')
        return price ? [{ lineId: line.id, unitPrice: price }] : []
      })
    : []
  return { version: record.request.version, as: 'ORDER', ...(draft.promiseDate !== record.request.requestedDate ? { promiseDate: draft.promiseDate } : {}), ...(lines.length > 0 ? { lines } : {}), ...(map.length > 0 ? { map } : {}) }
}

/** The receipt: what was made and its number; the sizes the colourway no longer offers named by line; the API's copy warnings counted. */
// F-CP-157: the lines named by their place on the request (`seq`); + the customer's logos carried onto what was made (and those not),
// and how many of the customer's prices the order took (the price grain only: the API sends none otherwise).
export function acceptDone(made: CatalogueAccepted['made'], number: string): { readonly phrase: Phrase; readonly lines: Phrase[]; /** F-CP-157: something to check (left out, the API's warnings, a logo not carried). */ readonly warn: boolean } {
  const phrase: Phrase = { key: made.as === 'ORDER' ? 'catalogue.done.order' : 'catalogue.done.quote', params: { made: made.number, number } }
  const lines: Phrase[] = made.dropped.map((one): Phrase => (one.size ? { key: 'catalogue.done.droppedSize', params: { n: one.seq, size: one.size } } : { key: 'catalogue.done.droppedLine', params: { n: one.seq } }))
  if (made.warnings.length > 0) lines.push({ key: 'catalogue.done.warnings', params: { count: made.warnings.length } })
  // ---- F-CP-157
  const carried = made.artwork?.carried.length ?? 0
  const notCarried = made.artwork?.notCarried.length ?? 0
  if (carried > 0) lines.push({ key: 'catalogueMap.done.logos', params: { count: carried, made: made.number } })
  if (notCarried > 0) lines.push({ key: 'catalogueMap.done.logosNot', params: { count: notCarried } })
  if (made.brandPrices !== undefined && made.brandPrices > 0) lines.push({ key: 'catalogueMap.done.brandPrices', params: { count: made.brandPrices, made: made.number } })
  const warn = made.dropped.length > 0 || made.warnings.length > 0 || notCarried > 0
  // ---- end F-CP-157
  return { phrase, lines, warn }
}

/** The refusal's words (the customer reads them): 1 to 1000 characters (factory-domain refuseReasonProblem). */
export const REFUSE_MAX = 1000
export function refuseHeld(reason: string, offline: boolean): Phrase | null {
  const text = reason.trim()
  if (text === '') return { key: 'catalogue.refuseHeld' }
  if (text.length > REFUSE_MAX) return { key: 'decline.held.long', params: { max: REFUSE_MAX } }
  if (offline) return { key: 'held.offline' }
  return null
}

/** Once decided or withdrawn: the outcome line (what it became, the words it was refused with, the customer's withdrawal). */
export function catalogueOutcome(record: CatalogueRecord): Phrase | null {
  const request = record.request
  if (request.status === 'ACCEPTED') return request.salesOrder ? { key: 'catalogue.outcome.order', params: { made: request.salesOrder.number } } : request.quote ? { key: 'catalogue.outcome.quote', params: { made: request.quote.number } } : { key: 'catalogue.outcome.accepted' }
  if (request.status === 'REFUSED') return { key: 'catalogue.outcome.refused', params: { reason: request.refuseReason ?? '—' } }
  if (request.status === 'WITHDRAWN') return { key: 'catalogue.outcome.withdrawn' }
  return null
}

/** A line's sizes as the office reads them ("S:2 M:5 L:3"). */
export const lineSizes = (line: Pick<CatalogueRecord['request']['lines'][number], 'sizes'>): string => line.sizes.map((size) => `${size.size}:${size.quantity}`).join(' ')

// ---- the pane's model (the container use-catalogue-order.tsx fills it; the view draws it) ----------------------------------------------

// F-CP-157: the accept window's style picker (the styles a line may be made into; null: no product.styles.view) and each picked
// style's colourways and sizes, by id.
export type CatalogueDialog =
  | { readonly kind: 'accept'; readonly draft: AcceptDraft; readonly busy: boolean; readonly notice: Notice | null; readonly styles?: { readonly items: readonly StyleOption[] | null; readonly problem: string | null } | null; readonly details?: Readonly<Record<string, StyleRead>> }
  | { readonly kind: 'refuse'; readonly reason: string; readonly busy: boolean; readonly notice: Notice | null }

export interface CatalogueModel {
  readonly prefix: string
  readonly can: InquiriesCan
  readonly offline: boolean
  readonly loaded: Loaded<CatalogueRecord>
  readonly notice: Notice | null
  readonly dialog: CatalogueDialog | null
  /** Someone else decided or changed it while it was open: when. */
  readonly handled: string | null
  /** F-CP-107: the customer's portal draft read on its customer page (read only; its title); absent: a sent catalogue order. */
  readonly draft?: { readonly title: string } | null
}

export interface CatalogueActions {
  onRetry?: () => void
  onReload?: () => void
  onAccept?: (as: 'ORDER' | 'QUOTE') => void
  onRefuse?: () => void
  onDraft?: (patch: Partial<AcceptDraft>) => void
  onPrice?: (lineId: string, price: string) => void
  onReason?: (reason: string) => void
  // ---- F-CP-157: the line map — a style line of a request line changed, added, taken out; a style picked (its colourways read)
  onMapInto?: (lineId: string, key: string, patch: Partial<MapInto>) => void
  onMapAdd?: (lineId: string) => void
  onMapRemove?: (lineId: string, key: string) => void
  onMapStyle?: (styleId: string) => void
  // ---- end F-CP-157
  onSubmit?: () => void
  onCloseDialog?: () => void
  onDismissNotice?: () => void
}
