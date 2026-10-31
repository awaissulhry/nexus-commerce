import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { readLedger, type LedgerQuery } from '../../../modules/inventory/stock/ledger-read'
import { defineExportSource } from '../source'

/**
 * Warehouse › Movements (SCR-064, `/warehouse/moves`): the export of the ledger as the screen shows it. The address is
 * the list's own (apps/factory-web areas/warehouse/moves model.ts movesAddressOf / ledgerQueryOf): a stock key `?site=`
 * `?item=` `?colour=` `?lot=` `?hide=` `?location=`, `?reasons=A,B`, `?period=7d|30d|90d|365d|all` (default 30 days,
 * or the whole ledger once a key is named), `?note=with|without`, `?reversed=yes|no`, `?q=`, `?writeOffs=yes`. Read
 * through the module's readLedger (inventory.stock.view, its companies and sites), a page at a time, newest first; the
 * row count comes from the ledger's own count before the run. The value is the cost grain: absent without it.
 *
 * Quantity: with a stock key named, the signed change of that stock (the screen's "+3"); otherwise the moved quantity,
 * in the material's base unit. Balance: the running balance after each row, as the screen draws it for one stock key
 * (site and material at least, nothing else narrowing); the balance is carried from page to page in the cursor.
 * Posted by: an office user's name, a floor tablet's name or the system, as the screen shows them (never a floor worker).
 */

type Row = Awaited<ReturnType<typeof readLedger>>['moves'][number] & { readonly keyed: boolean; readonly balance: string | null }
/** The ledger's query, and whether the address names a stock key (the quantity is then the signed change). */
type Query = { readonly ledger: Omit<LedgerQuery, 'cursor' | 'limit'>; readonly keyed: boolean }

const PERIOD_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }

function idTerm(address: URLSearchParams, name: string): string | undefined {
  const value = address.get(name) || undefined
  if (value && !isUuid(value)) throw new ValidationError(`Not a ${name}.`, [{ path: `query/${name}`, message: 'An id.' }])
  return value
}

/** The cursor of the next page: the ledger's, and the balance the rows above it left (only with a running balance). */
const SEPARATOR = '~'

export const moves = defineExportSource<Query, Row>({
  listKey: 'warehouse.moves',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    const key = { itemId: idTerm(address, 'item'), lotId: idTerm(address, 'lot'), hideId: idTerm(address, 'hide'), locationId: idTerm(address, 'location') }
    const keyed = !!(key.itemId || key.lotId || key.hideId || key.locationId)
    const asked = address.get('period') ?? ''
    const period = asked === 'all' || Object.hasOwn(PERIOD_DAYS, asked) ? asked : keyed ? 'all' : '30d'
    const reasons = (address.get('reasons') ?? '').split(',').filter((reason) => (STOCK_MOVE_REASONS as readonly string[]).includes(reason))
    const note = address.get('note')
    const reversed = address.get('reversed')
    const ledger: Omit<LedgerQuery, 'cursor' | 'limit'> = {
      siteId: idTerm(address, 'site'),
      ...key,
      itemColourId: idTerm(address, 'colour'),
      ...(reasons.length > 0 ? { reasons: reasons as unknown as NonNullable<LedgerQuery['reasons']> } : {}),
      ...(note === 'with' ? { hasNote: true } : note === 'without' ? { hasNote: false } : {}),
      ...(reversed === 'yes' ? { reversed: true } : reversed === 'no' ? { reversed: false } : {}),
      ...(period === 'all' ? {} : { from: new Date(Date.now() - PERIOD_DAYS[period]! * 86_400_000).toISOString() }),
      ...(address.get('writeOffs') === 'yes' ? { writeOffs: true } : {}),
      q: (address.get('q') ?? '').trim().slice(0, 80) || undefined,
    }
    return { ledger, keyed }
  },
  async count(caller, query) {
    const page = await readLedger(caller, { ...query.ledger, limit: 1 })
    return page.rowCount ?? page.moves.length
  },
  async read(caller, query, cursor, limit) {
    const [moveCursor, carried] = cursor ? (cursor.split(SEPARATOR) as [string, string | undefined]) : [undefined, undefined]
    const page = await readLedger(caller, { ...query.ledger, cursor: moveCursor, limit })
    let balance: Decimal | null = page.closing === null ? null : new Dec(carried ?? page.closing)
    const rows: Row[] = page.moves.map((move) => {
      const row: Row = { ...move, keyed: query.keyed, balance: balance ? balance.toFixed(4) : null }
      if (balance) balance = balance.minus(move.delta)
      return row
    })
    const next = page.nextCursor === null ? null : balance ? `${page.nextCursor}${SEPARATOR}${balance.toFixed(4)}` : page.nextCursor
    return { rows, next }
  },
  columns: {
    when: { value: (row) => ({ at: row.occurredAt }) },
    reason: { value: (row, words) => words(`reason.${row.reason}`) },
    material: { value: (row) => `${row.item.code} · ${row.item.name}` },
    lot: { value: (row) => [row.lot?.code, row.hide?.code].filter((code): code is string => !!code).join(' · ') || null },
    route: {
      value: (row, words) => {
        const side = (end: Row['from']) => (end.kind === 'LOCATION' ? (end.location?.code ?? '—') : words(`side.${end.kind}`))
        return `${side(row.from)} → ${side(row.to)}`
      },
    },
    quantity: { value: (row) => ({ decimal: row.keyed ? row.delta : row.baseQuantity }) },
    balance: { value: (row) => (row.balance === null ? null : { decimal: row.balance }) },
    document: {
      value: (row) => {
        const main = row.document?.number ?? row.reference
        const note = row.writeOff ? row.writeOff.note : row.note
        return [main, note].filter((part): part is string => !!part).join(' · ') || null
      },
    },
    posted: {
      value: (row, words) => {
        const by = row.postedBy
        if (by.audience === 'FLOOR') return by.device ? words('postedBy.FLOOR').replace('{device}', by.device.name) : words('postedBy.floorNoDevice')
        if (by.audience === 'SYSTEM') return words('postedBy.SYSTEM')
        return by.name ?? words('postedBy.officeNoName')
      },
    },
    value: { grain: 'cost', value: (row) => (row.valuation ? { minor: Number(row.valuation.valueAmount), currency: row.valuation.currency } : null) },
  },
  words: {
    it: {
      'reason.OPENING': 'Giacenza iniziale',
      'reason.RECEIPT': 'Ricevimento',
      'reason.ISSUE': 'Prelievo per ordine',
      'reason.RETURN': 'Reso da ordine',
      'reason.TRANSFER': 'Trasferimento',
      'reason.ADJUSTMENT': 'Rettifica',
      'reason.COUNT': 'Differenza inventario',
      'reason.SCRAP': 'Scarto',
      'reason.PRODUCTION_RECEIPT': 'Carico prodotto finito',
      'reason.CUSTOMER_RETURN': 'Reso da cliente',
      'reason.SUPPLIER_RETURN': 'Reso a fornitore',
      'reason.SHIPMENT': 'Spedizione',
      'side.SUPPLIER': 'Fornitore',
      'side.WORK_ORDER': 'Ordine di lavoro',
      'side.OPENING': 'Giacenza iniziale',
      'side.COUNT': 'Inventario',
      'side.ADJUSTMENT': 'Rettifica',
      'side.SCRAP': 'Scarto',
      'side.OUTSIDE': 'Fuori sede',
      'postedBy.FLOOR': 'Tablet · {device}',
      'postedBy.floorNoDevice': 'Un tablet',
      'postedBy.SYSTEM': 'Nexus',
      'postedBy.officeNoName': 'Un utente d’ufficio',
    },
    en: {
      'reason.OPENING': 'Opening stock',
      'reason.RECEIPT': 'Receipt',
      'reason.ISSUE': 'Issue to work order',
      'reason.RETURN': 'Return from work order',
      'reason.TRANSFER': 'Transfer',
      'reason.ADJUSTMENT': 'Adjustment',
      'reason.COUNT': 'Count difference',
      'reason.SCRAP': 'Scrap',
      'reason.PRODUCTION_RECEIPT': 'Finished goods from a work order',
      'reason.CUSTOMER_RETURN': 'Customer return',
      'reason.SUPPLIER_RETURN': 'Return to supplier',
      'reason.SHIPMENT': 'Shipment',
      'side.SUPPLIER': 'Supplier',
      'side.WORK_ORDER': 'Work order',
      'side.OPENING': 'Opening stock',
      'side.COUNT': 'Count',
      'side.ADJUSTMENT': 'Correction',
      'side.SCRAP': 'Scrap',
      'side.OUTSIDE': 'Outside the site',
      'postedBy.FLOOR': 'Tablet · {device}',
      'postedBy.floorNoDevice': 'A tablet',
      'postedBy.SYSTEM': 'Nexus',
      'postedBy.officeNoName': 'An office user',
    },
  },
})
