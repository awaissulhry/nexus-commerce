import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { listStockLots } from '../../../modules/inventory/stock/lots'
import { stockOverview } from '../../../modules/inventory/stock/stock'
import { listHolds } from '../../../modules/quality/holds/reads'
import { defineExportSource } from '../source'

/**
 * Warehouse › Stock (SCR-060, `/warehouse/stock`): the export of the grid as the screen shows it. The address is the
 * list's own (apps/factory-web areas/warehouse/stock model.ts stockAddressOf / visibleLines): `?site=`, `?view=material|
 * lot|location|leather|quarantine` (nothing: by material), `?tile=quarantine|crvi|blocked|reserved`, `?q=` (material,
 * colour, lot, hide or place), `?asOf=<instant>` (the stock as it was then: held, reserved and available are not kept for
 * past days). Read through the module's stockOverview (inventory.stock.view, its companies and sites; at most the
 * overview's own row limit) and shaped as the screen shapes it: a leather lot at a place is ONE row with its hides
 * counted and its area summed (the Leather view keeps one row per hide); the site's open reservations are placed on the
 * rows (a lot's first, then any lot's, in place order, never beyond a row's free stock); a row under an ACTIVE quality
 * hold says so with the hold's reason (only for a person who reads holds: quality.holds.view); the lots waiting for their
 * Cr VI result come from the module's listStockLots (the screen's first 200). One read, no pages. Unit cost and value
 * are the cost grain: absent without it. Quantities are decimals in the material's base unit.
 */

type Overview = Awaited<ReturnType<typeof stockOverview>>
type StockRow = Overview['rows'][number]
type Reservation = Overview['reservations'][number]

const VIEWS = ['material', 'lot', 'location', 'leather', 'quarantine'] as const
type View = (typeof VIEWS)[number]
const TILES = ['quarantine', 'crvi', 'blocked', 'reserved'] as const
type Tile = (typeof TILES)[number]

interface Query {
  readonly siteId: string | undefined
  readonly view: View
  readonly tile: Tile | null
  readonly q: string
  readonly asOf: string | undefined
}

interface Hold {
  readonly reasonCode: string
  readonly placedAt: string
}

interface Line {
  readonly id: string
  readonly siteId: string
  readonly siteCode: string
  readonly location: StockRow['location']
  readonly item: StockRow['item']
  readonly colour: StockRow['colour']
  readonly lot: StockRow['lot']
  hide: StockRow['hide']
  hides: number
  onHand: Decimal
  held: Decimal | null
  hideReserved: Decimal
  reserved: Decimal | null
  available: Decimal | null
  hold: Hold | null
  unitCost: string | null | undefined
  value: number | null | undefined
}

/** A row of the file: a grid line, with what its cells say beside the numbers. */
interface Row extends Line {
  readonly currency: string | null
  readonly crViWaits: boolean
  /** The hold's reason in the file's language (its code when the list does not know it). */
  readonly holdReason: string | null
}

const decimalOrNull = (value: string | null | undefined): Decimal | null => (value === null || value === undefined ? null : new Dec(value))
const addOrNull = (a: Decimal | null, b: string | null | undefined): Decimal | null => (a === null || b === null || b === undefined ? null : a.plus(b))
const isHeld = (status: string | null | undefined): boolean => !!status && status !== 'RELEASED'

/** The ACTIVE quality holds of lots and hides by the held record's id (the oldest first, one per record). */
function holdsBySubject(rows: readonly { readonly subjectType: string; readonly subjects: readonly { readonly id: string }[]; readonly reasonCode: string; readonly placedAt: string }[]): Map<string, Hold> {
  const result = new Map<string, Hold>()
  const oldest = rows.filter((hold) => hold.subjectType === 'Lot' || hold.subjectType === 'Hide').sort((a, b) => a.placedAt.localeCompare(b.placedAt))
  for (const hold of oldest) for (const subject of hold.subjects) if (!result.has(subject.id)) result.set(subject.id, { reasonCode: hold.reasonCode, placedAt: hold.placedAt })
  return result
}

const holdOf = (byId: ReadonlyMap<string, Hold>, row: Pick<StockRow, 'lot' | 'hide'>): Hold | null => (row.hide ? byId.get(row.hide.id) : undefined) ?? (row.lot ? byId.get(row.lot.id) : undefined) ?? null

/** The overview's rows as the grid folds them: per site, place, material, colour and lot (and hide, when `perHide`). */
function stockLines(rows: readonly StockRow[], perHide: boolean, byId: ReadonlyMap<string, Hold>): Line[] {
  const lines = new Map<string, Line>()
  for (const row of rows) {
    const leather = row.item.tracking === 'HIDE' && row.hide !== null
    const withCost = 'value' in row
    const unitCost = withCost ? ((row as { unitCost?: string | null }).unitCost ?? null) : undefined
    const value = withCost ? ((row as { value?: number | null }).value ?? null) : undefined
    const key = [row.siteId, row.location.id, row.item.id, row.colour?.id ?? '-', row.lot?.id ?? '-', perHide ? (row.hide?.id ?? '-') : '-'].join('|')
    const found = lines.get(key)
    if (!found) {
      const hideReserved = decimalOrNull(row.reserved) ?? ZERO
      lines.set(key, {
        id: key,
        siteId: row.siteId,
        siteCode: row.siteCode,
        location: row.location,
        item: row.item,
        colour: row.colour,
        lot: row.lot,
        hide: row.hide,
        hides: leather ? 1 : 0,
        onHand: new Dec(row.onHand),
        held: decimalOrNull(row.held),
        hideReserved,
        reserved: row.held === null ? null : hideReserved,
        available: decimalOrNull(row.available),
        hold: holdOf(byId, row),
        unitCost,
        value,
      })
      continue
    }
    found.hides += leather ? 1 : 0
    found.hide = null
    found.onHand = found.onHand.plus(row.onHand)
    found.held = addOrNull(found.held, row.held)
    found.available = addOrNull(found.available, row.available)
    found.hideReserved = found.hideReserved.plus(decimalOrNull(row.reserved) ?? ZERO)
    found.reserved = found.reserved === null || row.held === null ? null : found.hideReserved
    found.hold = found.hold ?? holdOf(byId, row)
    if (withCost) {
      // A lot's hides share the lot's cost; a value is unknown as soon as one part of it is.
      found.unitCost = found.unitCost !== null && found.unitCost === unitCost ? found.unitCost : null
      found.value = found.value === null || found.value === undefined || value === null || value === undefined ? null : found.value + value
    }
  }
  return [...lines.values()]
}

/**
 * What the site's open reservations hold of each line: a line keeps its hides' own; a lot's reservation (less what its
 * hides already hold) fills that lot's lines in place order, as far as each line's free stock goes; any-lot ones then
 * fill the material and colour's lines. Available = on hand − held − reserved. As of a past date: nothing is placed.
 */
function placeReservations(lines: Line[], reservations: readonly Reservation[]): void {
  if (lines.some((line) => line.held === null)) return
  const reserved = new Map<string, Decimal>(lines.map((line) => [line.id, line.hideReserved]))
  const free = (line: Line) => Dec.max(ZERO, line.onHand.minus(line.held ?? ZERO).minus(reserved.get(line.id) ?? ZERO))
  const fill = (rows: readonly Line[], amount: Decimal) => {
    let left = amount
    for (const row of [...rows].sort((a, b) => a.location.code.localeCompare(b.location.code))) {
      if (!left.greaterThan(0)) break
      const take = Dec.min(left, free(row))
      if (take.greaterThan(0)) {
        reserved.set(row.id, (reserved.get(row.id) ?? ZERO).plus(take))
        left = left.minus(take)
      }
    }
  }
  const lotFirst = [...reservations].sort((a, b) => (a.lotId === null ? 1 : 0) - (b.lotId === null ? 1 : 0))
  for (const entry of lotFirst) {
    const rows = lines.filter((line) => line.siteId === entry.siteId && line.item.id === entry.itemId && (line.colour?.id ?? null) === entry.itemColourId && (entry.lotId === null || line.lot?.id === entry.lotId))
    // The overview's lot figure includes its hides' own reservations, which the lines already carry.
    const already = entry.lotId === null ? ZERO : rows.reduce((sum, row) => sum.plus(row.hideReserved), ZERO)
    const amount = new Dec(entry.reserved).minus(already)
    if (amount.greaterThan(0)) fill(rows, amount)
  }
  for (const line of lines) {
    line.reserved = reserved.get(line.id) ?? line.hideReserved
    line.available = line.onHand.minus(line.held ?? ZERO).minus(line.reserved)
  }
}

/** The HOLD reasons' words in the file's language. */
async function holdReasons(caller: CommandCaller, locale: ExportLocale): Promise<Map<string, string>> {
  const rows = await caller.withClient((client) => client.reasonCode.findMany({ where: { list: 'HOLD' }, select: { code: true, labelIt: true, labelEn: true } }))
  return new Map(rows.map((row) => [row.code, locale === 'en' ? row.labelEn : row.labelIt]))
}

const searchText = (line: Line): string => [line.item.code, line.item.name, line.colour?.code, line.colour?.name, line.lot?.code, line.hide?.code, line.location.code, line.location.name].filter(Boolean).join(' ').toLowerCase()

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
const decimalCell = (value: Decimal | null): { decimal: string } | null => (value === null ? null : { decimal: value.toFixed(4) })

export const stock = defineExportSource<Query, Row>({
  listKey: 'warehouse.stock',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    const siteId = address.get('site') || undefined
    if (siteId && !isUuid(siteId)) throw new ValidationError('Not a site.', [{ path: 'query/site', message: 'A site id.' }])
    const view = address.get('view') ?? ''
    const tile = address.get('tile') ?? ''
    // An as-of instant: a UTC instant in the past (a future or unreadable one is ignored: now), as the screen reads it.
    const at = address.get('asOf')
    const asOfAt = at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at) ? parseInstant(at) : null
    return {
      siteId,
      view: (VIEWS as readonly string[]).includes(view) ? (view as View) : 'material',
      tile: (TILES as readonly string[]).includes(tile) ? (tile as Tile) : null,
      q: (address.get('q') ?? '').trim().toLowerCase().slice(0, 80),
      asOf: asOfAt && asOfAt.getTime() <= Date.now() + 60_000 ? asOfAt.toISOString() : undefined,
    }
  },
  async read(caller, query, cursor, _limit, options) {
    if (cursor !== null) return { rows: [], next: null }
    const context = caller.factoryContext
    const actor = context ? actorOf(context) : null
    const locale: ExportLocale = options?.locale ?? 'it'
    const overview = await stockOverview(caller, { siteId: query.siteId, ...(query.asOf ? { asOf: query.asOf } : {}) })
    const readsHolds = !query.asOf && !!actor && holds(actor, QUALITY_HOLDS_VIEW)
    const [held, reasons, waiting] = await Promise.all([
      readsHolds ? listHolds(caller, { status: 'ACTIVE', ...(query.siteId ? { siteId: query.siteId } : {}) }).then((answer) => answer.holds) : Promise.resolve([]),
      readsHolds ? holdReasons(caller, locale) : Promise.resolve(new Map<string, string>()),
      listStockLots(caller, { siteId: query.siteId, crVi: 'PENDING', limit: 200 }).then((answer) => new Set(answer.lots.map((lot) => lot.id))),
    ])
    const byId = holdsBySubject(held)
    const currencies = new Map(overview.items.flatMap((entry) => ('currency' in entry && entry.currency ? [[entry.item.id, entry.currency] as const] : [])))
    let lines = stockLines(
      overview.rows.filter((row) => query.view !== 'leather' || row.item.tracking === 'HIDE'),
      query.view === 'leather',
      byId,
    )
    placeReservations(lines, overview.reservations)
    if (query.view === 'lot') lines = lines.filter((line) => line.lot !== null)
    if (query.view === 'quarantine') lines = lines.filter((line) => isHeld(line.lot?.qualityStatus) || line.hold !== null)
    if (query.tile === 'quarantine') lines = lines.filter((line) => line.lot?.qualityStatus === 'QUARANTINE')
    if (query.tile === 'blocked') lines = lines.filter((line) => line.lot?.qualityStatus === 'BLOCKED' || line.lot?.qualityStatus === 'REJECTED')
    if (query.tile === 'crvi') lines = lines.filter((line) => line.lot !== null && waiting.has(line.lot.id))
    if (query.tile === 'reserved') lines = lines.filter((line) => (line.reserved ?? ZERO).greaterThan(0))
    if (query.q) lines = lines.filter((line) => searchText(line).includes(query.q))
    const by = (...parts: (string | undefined | null)[]) => parts.map((part) => part ?? '').join('\u0000')
    const order: Record<View, (line: Line) => string> = {
      material: (line) => by(line.item.code, line.colour?.code, line.lot?.code, line.location.code),
      lot: (line) => by(line.lot?.code, line.location.code),
      location: (line) => by(line.siteCode, line.location.code, line.item.code, line.lot?.code),
      leather: (line) => by(line.item.code, line.lot?.code, line.hide?.code),
      quarantine: (line) => by(line.lot?.qualityStatus, line.lot?.code, line.location.code),
    }
    lines.sort((a, b) => order[query.view](a).localeCompare(order[query.view](b)))
    const rows: Row[] = lines.map((line) => ({
      ...line,
      currency: currencies.get(line.item.id) ?? null,
      crViWaits: line.lot !== null && waiting.has(line.lot.id),
      holdReason: line.hold ? (reasons.get(line.hold.reasonCode) ?? line.hold.reasonCode) : null,
    }))
    return { rows, next: null }
  },
  columns: {
    material: { value: (row) => `${row.item.code} · ${row.item.name}${row.colour ? ` · ${row.colour.code} ${row.colour.name}` : ''}` },
    lot: {
      value: (row, words) => {
        if (!row.lot) return words('noLot')
        if (row.hide) return `${row.lot.code} · ${row.hide.code}`
        return row.hides > 0 ? `${row.lot.code} · ${fill(words(row.hides === 1 ? 'hides_one' : 'hides_other'), { count: row.hides })}` : row.lot.code
      },
    },
    quality: {
      value: (row, words) => {
        if (!row.lot) return words('noQuality')
        const status = row.lot.qualityStatus
        const wait = row.hold
          ? fill(words('heldBy'), { reason: row.holdReason ?? row.hold.reasonCode, day: businessDate(new Date(row.hold.placedAt)) })
          : status === 'RELEASED'
            ? null
            : words(row.crViWaits ? 'wait.crVi' : status === 'QUARANTINE' ? 'wait.release' : status === 'BLOCKED' ? 'wait.blocked' : 'wait.rejected')
        return wait ? `${words(`quality.${status}`)} · ${wait}` : words(`quality.${status}`)
      },
    },
    location: { value: (row) => row.location.code },
    onHand: { value: (row) => decimalCell(row.onHand) },
    reserved: { value: (row) => decimalCell(row.reserved) },
    held: { value: (row) => decimalCell(row.held) },
    available: { value: (row) => decimalCell(row.available) },
    unitCost: { grain: 'cost', value: (row) => (row.unitCost ? { decimal: row.unitCost } : null) },
    value: { grain: 'cost', value: (row) => (row.value === null || row.value === undefined ? null : { minor: row.value, currency: row.currency }) },
  },
  words: {
    it: {
      noLot: 'Senza lotto',
      noQuality: 'Nessun controllo qualità',
      heldBy: 'In blocco: {reason} · dal {day}',
      hides_one: '{count} pelle',
      hides_other: '{count} pelli',
      'quality.QUARANTINE': 'Quarantena',
      'quality.RELEASED': 'Rilasciato',
      'quality.BLOCKED': 'Bloccato',
      'quality.REJECTED': 'Respinto',
      'wait.rejected': 'Respinto: esce dalla giacenza (reso o scartato).',
      'wait.blocked': 'Bloccato dalla qualità: non si può prelevare.',
      'wait.crVi': 'Attende il risultato Cr VI: la giacenza non si può prelevare.',
      'wait.release': 'Attende il rilascio della qualità.',
    },
    en: {
      noLot: 'No lot',
      noQuality: 'No quality step',
      heldBy: 'On hold: {reason} · since {day}',
      hides_one: '{count} hide',
      hides_other: '{count} hides',
      'quality.QUARANTINE': 'Quarantine',
      'quality.RELEASED': 'Released',
      'quality.BLOCKED': 'Blocked',
      'quality.REJECTED': 'Rejected',
      'wait.rejected': 'Rejected: it leaves the stock (returned or scrapped).',
      'wait.blocked': 'Blocked by quality: it cannot be issued.',
      'wait.crVi': 'Waits for its Cr VI result: its stock cannot be issued.',
      'wait.release': "Waits for quality's release.",
    },
  },
})
