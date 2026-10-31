import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { QUALITY_LOTS_RELEASE } from '@nexus/factory-domain/quality/lab/permissions'
import { actorOf } from '../../../core/context'
import { listStockLots, type StockLotQuery } from '../../../modules/inventory/stock/lots'
import { defineExportSource } from '../source'

/**
 * Warehouse › Lots & traceability (`/warehouse/lots`): the export of the list as the screen shows it. The address is
 * the list's own (apps/factory-web areas/warehouse/lots model.ts lotViewOf / lotQuery): `?view=waiting|inStock|all|
 * released|rejected|quarantine|crViPending|crViFailed|blocked` (or the API's own `?onHold=true`, `?quality=BLOCKED|
 * QUARANTINE`, `?crVi=PENDING|FAIL`; nothing: what waits for release for a person who releases lots
 * (quality.lots.release), else the lots that hold stock), `?site=`, `?q=`. Read through the module's listStockLots
 * (inventory.stock.view, its companies and sites), a page at a time. No money. On hand is a decimal in the material's
 * base unit.
 */

type Row = Awaited<ReturnType<typeof listStockLots>>['lots'][number]
const VIEWS = ['waiting', 'inStock', 'all', 'released', 'rejected', 'quarantine', 'crViPending', 'crViFailed', 'blocked'] as const
type View = (typeof VIEWS)[number]
/** `default`: the screen's first view, which depends on who looks (resolved in the read, as the person). */
type Query = { readonly view: View | 'default'; readonly siteId: string | undefined; readonly q: string | undefined }

const VIEW_FILTER: Readonly<Record<View, Omit<StockLotQuery, 'limit' | 'cursor' | 'siteId' | 'q'>>> = {
  waiting: { onHold: true },
  inStock: { inStock: true },
  all: {},
  released: { quality: 'RELEASED' },
  rejected: { quality: 'REJECTED' },
  quarantine: { quality: 'QUARANTINE' },
  blocked: { quality: 'BLOCKED' },
  crViPending: { crVi: 'PENDING' },
  crViFailed: { crVi: 'FAIL' },
}

function viewOf(address: URLSearchParams): View | 'default' {
  const asked = address.get('view') ?? ''
  if ((VIEWS as readonly string[]).includes(asked)) return asked as View
  if (address.get('onHold') === 'true') return 'waiting'
  if (address.get('quality') === 'BLOCKED') return 'blocked'
  if (address.get('quality') === 'QUARANTINE') return 'quarantine'
  if (address.get('crVi') === 'PENDING') return 'crViPending'
  if (address.get('crVi') === 'FAIL') return 'crViFailed'
  return 'default'
}

export const lots = defineExportSource<Query, Row>({
  listKey: 'warehouse.lots',
  permission: INVENTORY_STOCK_VIEW,
  query(address) {
    const siteId = address.get('site') || undefined
    if (siteId && !isUuid(siteId)) throw new ValidationError('Not a site.', [{ path: 'query/site', message: 'A site id.' }])
    return { view: viewOf(address), siteId, q: address.get('q')?.trim().slice(0, 80) || undefined }
  },
  async read(caller, query, cursor, limit) {
    const context = caller.factoryContext
    const view: View = query.view !== 'default' ? query.view : context && holds(actorOf(context), QUALITY_LOTS_RELEASE) ? 'waiting' : 'inStock'
    const page = await listStockLots(caller, { ...VIEW_FILTER[view], siteId: query.siteId, q: query.q, cursor: cursor ?? undefined, limit })
    return { rows: page.lots, next: page.nextCursor }
  },
  columns: {
    lot: { value: (row) => row.code },
    material: { value: (row) => `${row.item.code} · ${row.item.name}` },
    supplier: { value: (row, words) => row.supplier?.name ?? words('noSupplier') },
    received: { value: (row) => (row.receivedAt ? { day: businessDate(new Date(row.receivedAt)) } : null) },
    quality: { value: (row, words) => words(`quality.${row.qualityStatus}`) },
    crVi: { value: (row, words) => (!row.crVi.required && row.crVi.status === 'NOT_REQUIRED' ? words('crVi.NOT_REQUIRED') : words(`crViShort.${row.crVi.status}`)) },
    evidence: { value: (row, words) => (row.crVi.evidence ? words(`evidence.${row.crVi.evidence}`) : row.crVi.required ? words('evidence.missing') : null) },
    onHand: { value: (row) => ({ decimal: row.onHand }) },
    issued: { value: (row) => (row.issuedTo === 0 ? null : row.issuedTo) },
  },
  words: {
    it: {
      noSupplier: 'Senza fornitore',
      'quality.QUARANTINE': 'Quarantena',
      'quality.RELEASED': 'Rilasciato',
      'quality.BLOCKED': 'Bloccato',
      'quality.REJECTED': 'Respinto',
      'crVi.NOT_REQUIRED': 'Non richiesto',
      'crViShort.NOT_REQUIRED': 'Non richiesto',
      'crViShort.PENDING': 'In attesa',
      'crViShort.PASS': 'Conforme',
      'crViShort.FAIL': 'Non conforme',
      'evidence.LOT_REPORT': 'Rapporto sul lotto',
      'evidence.SUPPLIER_REPORT': 'Rapporto del fornitore',
      'evidence.missing': 'Mancante',
    },
    en: {
      noSupplier: 'No supplier',
      'quality.QUARANTINE': 'Quarantine',
      'quality.RELEASED': 'Released',
      'quality.BLOCKED': 'Blocked',
      'quality.REJECTED': 'Rejected',
      'crVi.NOT_REQUIRED': 'Not required',
      'crViShort.NOT_REQUIRED': 'Not required',
      'crViShort.PENDING': 'Pending',
      'crViShort.PASS': 'Pass',
      'crViShort.FAIL': 'Fail',
      'evidence.LOT_REPORT': 'Lot report',
      'evidence.SUPPLIER_REPORT': 'Supplier report',
      'evidence.missing': 'Missing',
    },
  },
})
