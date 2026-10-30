import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Ddt, DdtPreview, DdtRequest, Documents, Labels, ShipmentRow, ShipmentStatus, Shipment, ShipmentQuery, SiteSettings, TransportBy } from './api'
import { SHIPMENT_STATUSES } from './api'

/**
 * The shipping office screens' pure rules (SCR-066 the shipments list, SCR-067 a shipment; B-W1-46 … 49 part 2): what a
 * person may do, the saved rows and the address that holds them, the tiles and the carrier cut-off cards of the
 * ship-today queue, a shipment's next step (Mark packed → Issue DDT → Buy labels → Mark handed over) and why it is held,
 * the "Ready to ship" checklist, and the screens' own words for the API's codes. No fetching, no React: the tests hold
 * them. No money anywhere (a shipment carries none).
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A message key and its values, translated by the view (`shipments` catalogue). */
export interface Phrase {
  key: string
  params?: Record<string, string | number>
}
const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface ShippingAbilities {
  view: boolean
  /** Plan a shipment, change its lines and delivery, cancel it, hand it over, attach and send its documents. */
  manage: boolean
  /** Parcels, garments into parcels, packed / unpacked, the packing list. */
  pack: boolean
  issueDdt: boolean
  annulDdt: boolean
  buyLabels: boolean
  printLabels: boolean
  /** Download a stored file (the DDT's PDF, a label's PDF). */
  readFiles: boolean
  /** The site's shipping settings: the cut-off for the countdowns. */
  viewSettings: boolean
  viewOrders: boolean
}

export function abilitiesOf(permissions: readonly string[]): ShippingAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('shipping.view'),
    manage: held.has('shipping.manage'),
    pack: held.has('shipping.pack'),
    issueDdt: held.has('shipping.ddt.issue'),
    annulDdt: held.has('shipping.ddt.cancel'),
    buyLabels: held.has('shipping.labels.buy'),
    printLabels: held.has('print.labels'),
    readFiles: held.has('files.read'),
    viewSettings: held.has('shipping.settings.view'),
    viewOrders: held.has('orders.view'),
  }
}

/** Whether the person can do anything on a shipment (else the record says it is read-only for them). */
export const actsOnShipments = (can: ShippingAbilities): boolean => can.manage || can.pack || can.issueDdt || can.annulDdt || can.buyLabels

// ---- words and tones -----------------------------------------------------------------------------------------------------

export const STATUS_TONE: Record<ShipmentStatus, Tone> = {
  DRAFT: 'neutral',
  PACKED: 'info',
  SHIPPED: 'info',
  DELIVERED: 'success',
  RETURNED: 'warning',
  CANCELLED: 'danger',
}

export const TRACKING_TONE: Record<string, Tone> = {
  LABEL_CREATED: 'neutral',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  EXCEPTION: 'danger',
  RETURNED: 'warning',
}

export const isFinal = (status: ShipmentStatus): boolean => status === 'DELIVERED' || status === 'RETURNED' || status === 'CANCELLED'
export const hasLeft = (status: ShipmentStatus): boolean => status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED'

/** A decimal weight string (kg, up to 4 decimals) as people read it: "33.35 kg" (the view adds the unit). */
export function kilos(value: string | null, locale: string): string | null {
  if (value === null) return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(number)
}

/** Who carries the goods, in words: a carrier's name, else own van / the customer collects. */
export function carrierWords(row: Pick<ShipmentRow, 'transportBy' | 'carrierName' | 'carrierCode'>): Phrase {
  if (row.transportBy === 'SENDER') return phrase('transport.SENDER')
  if (row.transportBy === 'RECIPIENT') return phrase('transport.RECIPIENT')
  const name = row.carrierName ?? row.carrierCode
  return name ? phrase('transport.carrier', { name }) : phrase('transport.noCarrier')
}

/** The ship-to in one line: "Milano · IT". */
export const placeOf = (shipTo: { city?: unknown; country?: unknown } | null | undefined): string | null => {
  const city = typeof shipTo?.city === 'string' && shipTo.city ? shipTo.city : null
  const country = typeof shipTo?.country === 'string' && shipTo.country ? shipTo.country : null
  return city || country ? [city, country].filter(Boolean).join(' · ') : null
}

/** The ship-to of a record as lines for a postal address (name, street, postal code + city, country). */
export function addressLines(shipTo: Record<string, unknown>): string[] {
  const text = (key: string) => (typeof shipTo[key] === 'string' && shipTo[key] !== '' ? (shipTo[key] as string) : null)
  return [text('name'), text('line1'), text('line2'), [text('postalCode'), text('city'), text('province') ? `(${text('province')})` : null].filter(Boolean).join(' ') || null, text('country')].filter((line): line is string => !!line)
}

// ---- the saved rows ⇄ the address ⇄ the API query ----------------------------------------------------------------------------

export const ROW_VIEWS = ['today', ...SHIPMENT_STATUSES, 'all'] as const
export type RowView = (typeof ROW_VIEWS)[number]

const isRowView = (value: string | null | undefined): value is RowView => !!value && (ROW_VIEWS as readonly string[]).includes(value)

/** `?rows=` (default the ship-today queue), `?q=`, `?carrier=` (a cut-off card's carrier, today's rows only). */
export function rowsFromAddress(params: { get(name: string): string | null } | null): RowView {
  const value = params?.get('rows') ?? null
  return isRowView(value) ? value : 'today'
}

/** The API's query of a saved rows view: today = what has not left yet (DRAFT and PACKED); a state; all. */
export function rowsQuery(rows: RowView, q: string, cursor: string | null = null): ShipmentQuery {
  const base = { q, cursor, limit: 50 }
  if (rows === 'today') return { ...base, open: true }
  if (rows === 'all') return base
  return { ...base, status: rows }
}

export function listAddress(path: string, next: { rows: RowView; q: string; carrier: string | null }): string {
  const query = new URLSearchParams()
  if (next.rows !== 'today') query.set('rows', next.rows)
  if (next.q.trim()) query.set('q', next.q.trim())
  if (next.carrier && next.rows === 'today') query.set('carrier', next.carrier)
  const qs = query.toString()
  return `${path}${qs ? `?${qs}` : ''}`
}

// ---- the ship-today queue: tiles and the carrier cut-off cards ----------------------------------------------------------------

export const TILES = [
  { key: 'toPack', rows: 'DRAFT' },
  { key: 'toLabel', rows: 'PACKED' },
  { key: 'notHandedOver', rows: 'PACKED' },
  { key: 'inTransit', rows: 'SHIPPED' },
] as const satisfies readonly { key: string; rows: RowView }[]
export type TileKey = (typeof TILES)[number]['key']

/** A packed shipment that still needs carrier labels before it can leave (a carrier carries it, a parcel has none). */
export const needsLabels = (row: Pick<ShipmentRow, 'status' | 'transportBy' | 'parcels' | 'labelled'>): boolean => row.status === 'PACKED' && row.transportBy === 'CARRIER' && row.labelled < row.parcels

/** A packed shipment whose papers are done (its DDT, and the labels when a carrier carries it): it waits to be handed over. */
export const waitsForHandOver = (row: Pick<ShipmentRow, 'status' | 'transportBy' | 'parcels' | 'labelled' | 'ddt'>): boolean => row.status === 'PACKED' && row.ddt !== null && !needsLabels(row)

/**
 * The tiles' counts from what was read: the open shipments (`open`, complete when not `openMore`) and the ones in transit
 * (`shipped`, complete when not `shippedMore`). Null: unknown (not read, or only part of it was read).
 */
export function tileCounts(open: readonly ShipmentRow[] | null, openMore: boolean, inTransit: number | null): Record<TileKey, number | null> {
  const known = open !== null && !openMore
  return {
    toPack: known ? open.filter((row) => row.status === 'DRAFT').length : null,
    // Ready to label: packed, its DDT issued, a parcel still without its label (the DDT comes first).
    toLabel: known ? open.filter((row) => needsLabels(row) && row.ddt !== null).length : null,
    notHandedOver: known ? open.filter(waitsForHandOver).length : null,
    inTransit,
  }
}

/** A carrier's cut-off card (design sh-cutoff): who carries, what is ready and what is still to pack, and the cut-off today. */
export interface CutOffCard {
  /** The `?carrier=` filter: the carrier's code, or `SENDER` / `RECIPIENT` / `none`. */
  key: string
  carrier: Phrase
  shipments: number
  /** Parcels of packed shipments. */
  parcelsReady: number
  /** Shipments still to pack (DRAFT) and their garments. */
  toPack: number
  garmentsToPack: number
  /** Today's cut-off of the sites the shipments leave from (the earliest), or null when none is set or unknown. */
  cutOff: { time: string; at: string } | null
}

export const carrierKey = (row: Pick<ShipmentRow, 'transportBy' | 'carrierCode'>): string => (row.transportBy !== 'CARRIER' ? row.transportBy : (row.carrierCode ?? 'none'))

/**
 * The cut-off cards of the open shipments, a card per carrier (own van and customer pickup their own), by the earliest
 * cut-off, then by name. `cutOffs` maps a site to its HH:MM (the site's zone); `today` is that zone's date.
 */
export function cutOffCards(open: readonly ShipmentRow[], cutOffs: ReadonlyMap<string, string>, today: string, timeZone = 'Europe/Rome'): CutOffCard[] {
  const cards = new Map<string, CutOffCard>()
  for (const row of open) {
    if (row.status !== 'DRAFT' && row.status !== 'PACKED') continue
    const key = carrierKey(row)
    const card = cards.get(key) ?? { key, carrier: carrierWords(row), shipments: 0, parcelsReady: 0, toPack: 0, garmentsToPack: 0, cutOff: null }
    card.shipments += 1
    if (row.status === 'PACKED') card.parcelsReady += row.parcels
    else {
      card.toPack += 1
      card.garmentsToPack += row.garments
    }
    const time = cutOffs.get(row.siteId)
    if (time) {
      const at = zonedInstant(today, time, timeZone)
      if (at && (!card.cutOff || at < card.cutOff.at)) card.cutOff = { time, at }
    }
    cards.set(key, card)
  }
  return [...cards.values()].sort((a, b) => (a.cutOff?.at ?? '9').localeCompare(b.cutOff?.at ?? '9') || a.key.localeCompare(b.key))
}

/** The cut-off of each site the person reaches (its HH:MM), from the shipping settings. */
export function cutOffsBySite(sites: readonly SiteSettings[] | null): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of sites ?? []) if (entry.settings?.cutOffTime) map.set(entry.site.id, entry.settings.cutOffTime)
  return map
}

/**
 * The instant (ISO, UTC) of a wall-clock time on a day in a zone (`2026-10-29`, `17:00`, Europe/Rome → 16:00Z). Pure:
 * the zone's offset at that moment is read with Intl, twice, so a day that changes its clock lands right.
 */
export function zonedInstant(day: string, time: string, timeZone = 'Europe/Rome'): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match || !clock) return null
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(clock[1]), Number(clock[2]))
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    )
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    return asUtc - instant
  }
  let guess = wall - offsetAt(wall)
  guess = wall - offsetAt(guess)
  return new Date(guess).toISOString()
}

/** Today in a zone (YYYY-MM-DD). */
export function zonedToday(now: Date = new Date(), timeZone = 'Europe/Rome'): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

// ---- what packing still needs, in this screen's words (the same rules as factory-domain shipping packingProblems) -----------

/** Each thing a DRAFT still needs before it is packed, from its own lines and parcels (the API's sentences are English). */
export function packingNeeds(shipment: Pick<Shipment, 'lines' | 'parcels'>): Phrase[] {
  const needs: Phrase[] = []
  if (shipment.lines.length === 0) needs.push(phrase('packing.lines'))
  const unplaced = shipment.lines.filter((line) => line.parcelId === null).reduce((sum, line) => sum + line.quantity, 0)
  if (unplaced > 0) needs.push(phrase('packing.unplaced', { count: unplaced }))
  if (shipment.parcels.length === 0) needs.push(phrase('packing.parcel'))
  const sorted = [...shipment.parcels].sort((a, b) => a.seq - b.seq)
  const unweighed = sorted.filter((parcel) => parcel.grossWeightKg === null).map((parcel) => parcel.seq)
  if (unweighed.length > 0) needs.push(phrase('packing.unweighed', { count: unweighed.length, parcels: unweighed.join(', ') }))
  const filled = new Set(shipment.lines.map((line) => line.parcelId))
  const empty = sorted.filter((parcel) => !filled.has(parcel.id)).map((parcel) => parcel.seq)
  if (empty.length > 0) needs.push(phrase('packing.empty', { count: empty.length, parcels: empty.join(', ') }))
  const serials = shipment.lines.filter((line) => line.serialTracked && line.serials.length < line.quantity).reduce((sum, line) => sum + line.quantity - line.serials.length, 0)
  if (serials > 0) needs.push(phrase('packing.serials', { count: serials }))
  return needs
}

// ---- a shipment's next step (design: Issue DDT → Buy label → Mark handed over) ----------------------------------------------------

export type StepKind = 'pack' | 'issueDdt' | 'buyLabels' | 'handOver'

export interface NextStep {
  kind: StepKind | null
  /** Why it waits (a message key), or null when it can run. */
  held: Phrase | null
}

export interface RecordFacts {
  shipment: Shipment
  /** The live DDT, when one is issued (none: not issued, or annulled and not replaced). */
  ddt: Pick<Ddt, 'id' | 'number' | 'status'> | null
  labels: Pick<Labels, 'toLabel' | 'parcels'> | null
  documents: Pick<Documents, 'blockers'> | null
}

const labelsMissing = (facts: RecordFacts): boolean =>
  facts.shipment.transportBy === 'CARRIER' && (facts.labels ? facts.labels.toLabel > 0 : facts.shipment.parcels.some((parcel) => parcel.trackingNumber === null))

export function nextStep(facts: RecordFacts, can: ShippingAbilities): NextStep {
  const { shipment } = facts
  if (shipment.status === 'DRAFT') {
    if (!can.pack) return { kind: 'pack', held: phrase('held.noPack') }
    const needs = packingNeeds(shipment)
    if (needs.length > 0) return { kind: 'pack', held: phrase('held.packing', { count: needs.length }) }
    return { kind: 'pack', held: null }
  }
  if (shipment.status !== 'PACKED') return { kind: null, held: null }
  if (shipment.ddtRequired && !facts.ddt) return { kind: 'issueDdt', held: can.issueDdt ? null : phrase('held.noIssue') }
  if (labelsMissing(facts)) return { kind: 'buyLabels', held: can.buyLabels ? (facts.ddt || !shipment.ddtRequired ? null : phrase('held.ddtFirst')) : phrase('held.noBuy') }
  if (!can.manage) return { kind: 'handOver', held: phrase('held.noManage') }
  if (facts.documents && facts.documents.blockers.length > 0) return { kind: 'handOver', held: phrase('held.documents', { count: facts.documents.blockers.length }) }
  return { kind: 'handOver', held: null }
}

// ---- "Ready to ship" (design sh-ready: every check the law and the customer need, each with its fix) ---------------------------

export type CheckState = 'ok' | 'open' | 'warn' | 'notNeeded'

export interface ReadyCheck {
  code: 'released' | 'documents' | 'packed' | 'ddt' | 'labels'
  state: CheckState
  words: Phrase
  /** The tab that fixes it. */
  tab: RecordTab
}

export function readyChecks(facts: RecordFacts & { documents: Documents | null }): ReadyCheck[] {
  const { shipment, documents } = facts
  const garments = shipment.lines.reduce((sum, line) => sum + line.quantity, 0)
  const left = hasLeft(shipment.status)
  const checks: ReadyCheck[] = [
    // The API plans lines from released garments only (released − reversed − on other shipments): every line was released.
    { code: 'released', state: garments > 0 ? 'ok' : 'open', words: garments > 0 ? phrase('ready.released.ok', { count: garments }) : phrase('ready.released.none'), tab: 'lines' },
  ]
  if (documents === null) checks.push({ code: 'documents', state: 'open', words: phrase('ready.documents.unknown'), tab: 'documents' })
  else if (documents.blockers.length > 0) checks.push({ code: 'documents', state: 'open', words: phrase('ready.documents.missing', { count: documents.blockers.length }), tab: 'documents' })
  else if (documents.warnings.length > 0) checks.push({ code: 'documents', state: 'warn', words: phrase('ready.documents.fallback', { count: documents.warnings.length }), tab: 'documents' })
  else checks.push({ code: 'documents', state: 'ok', words: phrase('ready.documents.ok'), tab: 'documents' })
  const packed = shipment.status !== 'DRAFT' && shipment.status !== 'CANCELLED'
  checks.push({ code: 'packed', state: packed ? 'ok' : 'open', words: packed ? phrase('ready.packed.ok', { count: shipment.parcels.length }) : phrase('ready.packed.open', { count: packingNeeds(shipment).length }), tab: 'lines' })
  if (!shipment.ddtRequired) checks.push({ code: 'ddt', state: 'notNeeded', words: phrase('ready.ddt.notNeeded'), tab: 'documents' })
  else checks.push({ code: 'ddt', state: facts.ddt ? 'ok' : 'open', words: facts.ddt ? phrase('ready.ddt.ok', { number: facts.ddt.number }) : phrase('ready.ddt.open'), tab: 'documents' })
  if (shipment.transportBy !== 'CARRIER') checks.push({ code: 'labels', state: 'notNeeded', words: phrase(`ready.labels.${shipment.transportBy}`), tab: 'carrier' })
  else if (left || !labelsMissing(facts)) checks.push({ code: 'labels', state: shipment.parcels.length > 0 ? 'ok' : 'open', words: phrase('ready.labels.ok', { count: shipment.parcels.length }), tab: 'carrier' })
  else checks.push({ code: 'labels', state: 'open', words: phrase('ready.labels.open', { count: facts.labels?.toLabel ?? shipment.parcels.filter((parcel) => parcel.trackingNumber === null).length }), tab: 'carrier' })
  return checks
}

export const openChecks = (checks: readonly ReadyCheck[]): number => checks.filter((check) => check.state === 'open').length

// ---- the record's tabs ---------------------------------------------------------------------------------------------------------

export const RECORD_TABS = ['lines', 'documents', 'carrier', 'tracking', 'activity'] as const
export type RecordTab = (typeof RECORD_TABS)[number]

export function tabOf(value: string | null | undefined): RecordTab {
  return (RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'lines'
}

// ---- the DDT ----------------------------------------------------------------------------------------------------------------------

/** The DDT form as typed (the server fills everything else from the shipment, its order, its parcels and the company). */
export interface DdtForm {
  reason: DdtRequest['reason']
  reasonText: string
  carrierName: string
  appearance: string
  netWeightKg: string
  freight: '' | 'FREE' | 'FORWARD'
  remarks: string
  /** The goods leave now (own van, the customer collects): issue and hand over in one. */
  ship: boolean
}

export function ddtFormFor(shipment: Pick<Shipment, 'transportBy' | 'carrierName'>, preview: DdtPreview | null): DdtForm {
  return {
    reason: 'SALE',
    reasonText: '',
    carrierName: shipment.transportBy === 'CARRIER' ? (preview?.draft.carrier?.name ?? shipment.carrierName ?? '') : '',
    appearance: preview?.draft.appearance ?? '',
    netWeightKg: '',
    freight: '',
    remarks: '',
    ship: false,
  }
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The request the preview and the issue send: only what the person typed (blank = the server's default). */
export function ddtRequestOf(form: DdtForm, transportBy: TransportBy, version?: number): DdtRequest {
  return {
    ...(version ? { version } : {}),
    reason: form.reason,
    ...(form.reason === 'OTHER' ? { reasonText: blank(form.reasonText) } : {}),
    ...(transportBy === 'CARRIER' && blank(form.carrierName) ? { carrier: { name: form.carrierName.trim() } } : {}),
    ...(blank(form.appearance) ? { appearance: form.appearance.trim() } : {}),
    ...(blank(form.netWeightKg) ? { netWeightKg: form.netWeightKg.trim().replace(',', '.') } : {}),
    ...(form.freight ? { freight: form.freight } : {}),
    ...(blank(form.remarks) ? { remarks: form.remarks.trim() } : {}),
    ...(form.ship && transportBy !== 'CARRIER' ? { ship: true } : {}),
  }
}

/** The preview's problems grouped: the shipment's state, the company's legal data, the fields the office types. */
export function ddtProblemGroups(preview: DdtPreview | null): { state: string[]; company: string[]; fields: { path: string; message: string }[] } {
  const groups = { state: [] as string[], company: [] as string[], fields: [] as { path: string; message: string }[] }
  for (const problem of preview?.problems ?? []) {
    if (problem.path.startsWith('company/')) groups.company.push(problem.message)
    else if (problem.path.startsWith('body/')) groups.fields.push(problem)
    else groups.state.push(problem.message)
  }
  return groups
}

/** The typed phrase that annuls a DDT: its number (a fiscal document: the person types what they annul). */
export const annulPhrase = (ddt: Pick<Ddt, 'number'>): string => ddt.number

// ---- the documents' words ----------------------------------------------------------------------------------------------------------

export const DOCUMENT_STATE_TONE: Record<string, Tone> = { ATTACHED: 'success', ON_FILE: 'info', MISSING: 'danger', NOT_REQUIRED: 'neutral' }
export const LINK_STATE_TONE: Record<string, Tone> = { LIVE: 'success', REVOKED: 'neutral', USED_UP: 'info', EXPIRED: 'warning' }

/** A language code in the person's language ("it" → "Italiano" / "Italian"); the code itself when unknown. */
export function languageName(code: string | null, locale: string): string {
  if (!code) return '—'
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code
  } catch {
    return code
  }
}

// ---- problems in words -----------------------------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

export interface WriteProblem extends Phrase {
  /** The record changed meanwhile: read it again. */
  reload: boolean
  /** The API's own sentence, shown under ours for a refusal the screen has no words of its own for. */
  detail?: string | null
}

/** A refused write as words (the API's sentence is kept as the detail of a state refusal: it names the parcel, the serial…). */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.write.internal', reload: false }
  const first = error.issues[0]
  if (error.kind === 'conflict') {
    const moved = error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    if (moved) return { key: 'problem.write.moved', reload: true }
    return { key: 'problem.write.state', reload: true, detail: error.message || first?.message || null }
  }
  if (error.kind === 'invalid') {
    // Fields the screen has its own words for (the label buy's service, the sender's or recipient's address).
    const paths = error.issues.map(issuePath)
    if (paths.includes('shipment/serviceCode')) return { key: 'problem.write.noService', reload: false }
    if (paths.some((path) => path.startsWith('shipment/shipTo') || path.startsWith('recipient/'))) return { key: 'problem.write.address', reload: false, detail: first?.message ?? null }
    return { key: 'problem.write.invalid', reload: false, detail: first?.message ?? error.message ?? null }
  }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `problem.write.${error.kind}`, reload: error.kind === 'not_found' }
  return { key: 'problem.write.internal', reload: false }
}

// ---- live --------------------------------------------------------------------------------------------------------------------------

const LIVE_PREFIXES = ['shipment.', 'ddt.', 'shipping.', 'print.job_', 'quality.release'] as const

function idsOf(fields: Readonly<Record<string, unknown>>): string[] {
  return Object.values(fields).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}

/** Whether a live event concerns the shipments (the list), or this shipment (the record: one that names it or its records). */
export function liveTouches(change: { type: string; fields: Readonly<Record<string, unknown>> }, known?: ReadonlySet<string>): boolean {
  if (!LIVE_PREFIXES.some((prefix) => change.type.startsWith(prefix))) return false
  if (!known) return change.type.startsWith('shipment.') || change.type.startsWith('ddt.') || change.type.startsWith('quality.release')
  return idsOf(change.fields).some((id) => known.has(id))
}

/** The ids a live event may name for this shipment: itself, its parcels, its lines, its DDTs, the print jobs it queued. */
export function knownIds(shipment: Shipment, extra: readonly string[] = []): Set<string> {
  return new Set([shipment.id, ...shipment.parcels.map((parcel) => parcel.id), ...shipment.lines.map((line) => line.id), ...extra])
}

// ---- CSV of the selected rows (Export N) ------------------------------------------------------------------------------------------

const cell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function shipmentsCsv(rows: readonly ShipmentRow[], words: { header: (column: string) => string; status: (status: ShipmentStatus) => string; carrier: (row: ShipmentRow) => string }): string {
  const columns = ['number', 'status', 'customer', 'order', 'shipTo', 'carrier', 'parcels', 'weight', 'ddt', 'tracking', 'shipped'] as const
  const lines = [columns.map((column) => cell(words.header(column))).join(',')]
  for (const row of rows) {
    lines.push(
      [row.number, words.status(row.status), row.partyName, row.salesOrderNumber, placeOf(row.shipTo), words.carrier(row), row.parcels, row.grossWeightKg, row.ddt?.number ?? null, row.trackingNumbers.join(' '), row.shippedAt]
        .map((value) => cell(value as string | number | null))
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

// ---- New shipment (sh-new): what each cell can still ship ---------------------------------------------------------------------------

export interface QuantityProblem {
  cellId: string
  key: string
  params: Record<string, string | number>
}

/** Each typed quantity from 0 to what the cell can still ship (released − reversed − on other shipments); at least one garment. */
export function newShipmentProblems(cells: readonly { workOrderSizeId: string; shippable: number }[], quantities: Readonly<Record<string, number>>): QuantityProblem[] {
  const problems: QuantityProblem[] = []
  for (const cell of cells) {
    const asked = quantities[cell.workOrderSizeId] ?? 0
    if (!Number.isInteger(asked) || asked < 0 || asked > cell.shippable) problems.push({ cellId: cell.workOrderSizeId, key: 'new.problem.range', params: { max: cell.shippable } })
  }
  return problems
}

export const newShipmentLines = (cells: readonly { workOrderSizeId: string }[], quantities: Readonly<Record<string, number>>): { workOrderSizeId: string; quantity: number }[] =>
  cells.flatMap((cell) => ((quantities[cell.workOrderSizeId] ?? 0) > 0 ? [{ workOrderSizeId: cell.workOrderSizeId, quantity: quantities[cell.workOrderSizeId]! }] : []))
