import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { WhereUsedGroup, WhereUsedRow, WhereUsedView } from '@nexus/factory-domain/product/where-used/contracts'
import { byOpenThenNewest, isOpen, priceListOpen, WHERE_USED_KINDS, WHERE_USED_PERMISSION, WHERE_USED_ROWS, type WhereUsedKind } from '@nexus/factory-domain/product/where-used/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, readStyle } from '../styles/store'

/**
 * Where a style is used (B-W2b-227; PRD-021; factory-domain product/where-used): GET /product/styles/:styleId/where-used,
 * office, product.styles.view over the style's company. Per kind, only with that kind's own view permission (else
 * `allowed: false` and nothing more), and only the records of the companies and sites the person reaches (scopeWhere):
 *
 *   QUOTES          quotes whose current revision has a line of the style (quotes.view; open: draft … sent)
 *   SALES_ORDERS    orders with a line of the style (orders.view; open: confirmed … partly shipped)
 *   WORK_ORDERS     work orders making it (workorders.view, company and site; open: draft, released, in progress, on hold)
 *   STOCK           finished garments of its SKUs on hand, per SKU (inventory.stock.view, the moves' company and site)
 *   PRICE_LISTS     price list versions with a price for it, never the price (pricelists.view; open: active, not ended)
 *   SAMPLE_ROUNDS   its sample rounds (product.styles.view; open: requested … under review), never the charge
 *   CERTIFICATES    certificates whose coverage names it (compliance.certificates.view; open: draft, valid, suspended)
 *
 * Read with the request's client, one query after another; nothing written. No money.
 */

type Reader = FactoryClient

const day = (value: Date | null | undefined): string | null => (value ? businessDate(value) : null)
const dateOnly = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)

interface PartyRow {
  readonly id: string
  readonly code: string
  readonly legalName: string
  readonly tradeName: string | null
}

async function partiesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  const rows: PartyRow[] = wanted.length === 0 ? [] : await db.party.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName?.trim() || row.legalName }]))
}

function groupOf(kind: WhereUsedKind, rows: readonly WhereUsedRow[], onHand: number | null = null): WhereUsedGroup {
  const ordered = byOpenThenNewest(rows)
  return { kind, allowed: true, count: rows.length, open: rows.filter((row) => row.open).length, rows: ordered.slice(0, WHERE_USED_ROWS), more: ordered.length > WHERE_USED_ROWS, onHand }
}

const notAllowed = (kind: WhereUsedKind): WhereUsedGroup => ({ kind, allowed: false, count: 0, open: 0, rows: [], more: false, onHand: null })

async function quotes(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const lines = await db.quoteLine.findMany({ where: { styleId }, select: { versionId: true, quantity: true } })
  if (lines.length === 0) return groupOf('QUOTES', [])
  const versions = await db.quoteVersion.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.versionId))] } }, select: { id: true, quoteId: true, revision: true } })
  const rows = await db.quote.findMany({
    where: { AND: [{ id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, scopeWhere(actor, WHERE_USED_PERMISSION.QUOTES, { company: 'companyId' }) as Prisma.QuoteWhereInput] },
    select: { id: true, number: true, status: true, partyId: true, companyId: true, currentRevision: true, createdAt: true },
  })
  const parties = await partiesOf(
    db,
    rows.map((row) => row.partyId),
  )
  return groupOf(
    'QUOTES',
    rows.flatMap((row) => {
      const current = versions.find((version) => version.quoteId === row.id && version.revision === row.currentRevision)
      if (!current) return []
      const pieces = lines.filter((line) => line.versionId === current.id).reduce((sum, line) => sum + line.quantity, 0)
      return [{ id: row.id, number: row.number, state: row.status, open: isOpen('QUOTES', row.status), at: day(row.createdAt), party: parties.get(row.partyId) ?? null, companyId: row.companyId, siteId: null, detail: `revision ${row.currentRevision}`, pieces }]
    }),
  )
}

async function salesOrders(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const lines = await db.salesOrderLine.findMany({ where: { styleId }, select: { orderId: true, quantity: true } })
  if (lines.length === 0) return groupOf('SALES_ORDERS', [])
  const rows = await db.salesOrder.findMany({
    where: { AND: [{ id: { in: [...new Set(lines.map((line) => line.orderId))] } }, scopeWhere(actor, WHERE_USED_PERMISSION.SALES_ORDERS, { company: 'companyId' }) as Prisma.SalesOrderWhereInput] },
    select: { id: true, number: true, status: true, partyId: true, companyId: true, orderDate: true },
  })
  const parties = await partiesOf(
    db,
    rows.map((row) => row.partyId),
  )
  return groupOf(
    'SALES_ORDERS',
    rows.map((row) => ({
      id: row.id,
      number: row.number,
      state: row.status,
      open: isOpen('SALES_ORDERS', row.status),
      at: dateOnly(row.orderDate),
      party: parties.get(row.partyId) ?? null,
      companyId: row.companyId,
      siteId: null,
      detail: null,
      pieces: lines.filter((line) => line.orderId === row.id).reduce((sum, line) => sum + line.quantity, 0),
    })),
  )
}

async function workOrders(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const rows = await db.workOrder.findMany({
    where: { AND: [{ styleId }, scopeWhere(actor, WHERE_USED_PERMISSION.WORK_ORDERS, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput] },
    select: { id: true, number: true, status: true, kind: true, companyId: true, siteId: true, dueDate: true, createdAt: true },
  })
  const sizes = rows.length === 0 ? [] : await db.workOrderSize.findMany({ where: { workOrderId: { in: rows.map((row) => row.id) } }, select: { workOrderId: true, quantity: true } })
  return groupOf(
    'WORK_ORDERS',
    rows.map((row) => ({
      id: row.id,
      number: row.number,
      state: row.status,
      open: isOpen('WORK_ORDERS', row.status),
      at: dateOnly(row.dueDate) ?? day(row.createdAt),
      party: null,
      companyId: row.companyId,
      siteId: row.siteId,
      detail: row.kind,
      pieces: sizes.filter((size) => size.workOrderId === row.id).reduce((sum, size) => sum + size.quantity, 0),
    })),
  )
}

const whole = (value: Decimal): number => Number(value.toFixed(0))
const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))

async function stock(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const items = await db.item.findMany({ where: { kind: 'FINISHED', variant: { styleId } }, select: { id: true, code: true } })
  if (items.length === 0) return groupOf('STOCK', [], 0)
  const scope = scopeWhere(actor, WHERE_USED_PERMISSION.STOCK, { company: 'companyId', site: 'siteId' }) as Prisma.StockMoveWhereInput
  const base: Prisma.StockMoveWhereInput = { AND: [scope, { itemId: { in: items.map((item) => item.id) } }] }
  const into = await db.stockMove.groupBy({ by: ['itemId'], where: { AND: [base, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.groupBy({ by: ['itemId'], where: { AND: [base, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const onHand = new Map<string, Decimal>()
  for (const row of into) onHand.set(row.itemId, (onHand.get(row.itemId) ?? ZERO).plus(dec(row._sum.baseQuantity)))
  for (const row of outOf) onHand.set(row.itemId, (onHand.get(row.itemId) ?? ZERO).minus(dec(row._sum.baseQuantity)))
  const rows = items.flatMap((item) => {
    const pieces = whole(onHand.get(item.id) ?? ZERO)
    return pieces === 0 ? [] : [{ id: item.id, number: item.code, state: 'ON_HAND', open: true, at: null, party: null, companyId: null, siteId: null, detail: null, pieces }]
  })
  return groupOf(
    'STOCK',
    rows,
    rows.reduce((sum, row) => sum + row.pieces, 0),
  )
}

async function priceLists(db: Reader, actor: Actor, styleId: string, today: string): Promise<WhereUsedGroup> {
  const entries = await db.priceListEntry.findMany({ where: { styleId }, select: { versionId: true }, distinct: ['versionId'] })
  if (entries.length === 0) return groupOf('PRICE_LISTS', [])
  const versions = await db.priceListVersion.findMany({ where: { id: { in: entries.map((entry) => entry.versionId) } }, select: { id: true, listId: true, revision: true, status: true, validFrom: true, validTo: true } })
  const lists = await db.priceList.findMany({
    where: { AND: [{ id: { in: [...new Set(versions.map((row) => row.listId))] } }, scopeWhere(actor, WHERE_USED_PERMISSION.PRICE_LISTS, { company: { field: 'companyId', nullable: true } }) as Prisma.PriceListWhereInput] },
    select: { id: true, code: true, name: true, companyId: true },
  })
  const listOf = new Map(lists.map((row) => [row.id, row]))
  return groupOf(
    'PRICE_LISTS',
    versions.flatMap((version) => {
      const list = listOf.get(version.listId)
      if (!list) return []
      const validTo = dateOnly(version.validTo)
      return [{ id: version.id, number: list.code, state: version.status, open: priceListOpen(version.status, validTo, today), at: dateOnly(version.validFrom), party: null, companyId: list.companyId, siteId: null, detail: `${list.name} · version ${version.revision}`, pieces: null }]
    }),
  )
}

async function sampleRounds(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const rows = await db.sampleRound.findMany({
    where: { AND: [{ styleId }, scopeWhere(actor, WHERE_USED_PERMISSION.SAMPLE_ROUNDS, { company: 'companyId' }) as Prisma.SampleRoundWhereInput] },
    select: { id: true, number: true, kind: true, roundNo: true, stage: true, partyId: true, companyId: true, dueDate: true, createdAt: true },
  })
  const parties = await partiesOf(
    db,
    rows.map((row) => row.partyId),
  )
  return groupOf(
    'SAMPLE_ROUNDS',
    rows.map((row) => ({
      id: row.id,
      number: row.number,
      state: row.stage,
      open: isOpen('SAMPLE_ROUNDS', row.stage),
      at: dateOnly(row.dueDate) ?? day(row.createdAt),
      party: row.partyId ? (parties.get(row.partyId) ?? null) : null,
      companyId: row.companyId,
      siteId: null,
      detail: `${row.kind} · round ${row.roundNo}`,
      pieces: null,
    })),
  )
}

async function certificates(db: Reader, actor: Actor, styleId: string): Promise<WhereUsedGroup> {
  const coverage = await db.certificateCoverage.findMany({ where: { styleId }, select: { certificateId: true, sizes: true, status: true } })
  if (coverage.length === 0) return groupOf('CERTIFICATES', [])
  const rows = await db.certificate.findMany({
    where: {
      AND: [{ id: { in: [...new Set(coverage.map((row) => row.certificateId))] } }, scopeWhere(actor, WHERE_USED_PERMISSION.CERTIFICATES, { company: { field: 'companyId', nullable: true } }) as Prisma.CertificateWhereInput],
    },
    select: { id: true, number: true, status: true, companyId: true, validTo: true, notifiedBodyName: true, standard: true },
  })
  return groupOf(
    'CERTIFICATES',
    rows.map((row) => {
      const sizes = [...new Set(coverage.filter((entry) => entry.certificateId === row.id && entry.status === 'ACTIVE').flatMap((entry) => entry.sizes))]
      return {
        id: row.id,
        number: row.number,
        state: row.status,
        open: isOpen('CERTIFICATES', row.status),
        at: dateOnly(row.validTo),
        party: null,
        companyId: row.companyId,
        siteId: null,
        detail: [row.standard, row.notifiedBodyName, sizes.length > 0 ? `sizes ${sizes.join(', ')}` : null].filter(Boolean).join(' · '),
        pieces: null,
      }
    }),
  )
}

/** GET /product/styles/:styleId/where-used */
export async function whereUsed(caller: CommandCaller, styleId: string, now: Date = new Date()): Promise<WhereUsedView> {
  const style = await readStyle(caller, styleId)
  const actor = actorOf(contextOf(caller))
  const today = businessDate(now)
  const readers: Record<WhereUsedKind, (db: Reader) => Promise<WhereUsedGroup>> = {
    QUOTES: (db) => quotes(db, actor, styleId),
    SALES_ORDERS: (db) => salesOrders(db, actor, styleId),
    WORK_ORDERS: (db) => workOrders(db, actor, styleId),
    STOCK: (db) => stock(db, actor, styleId),
    PRICE_LISTS: (db) => priceLists(db, actor, styleId, today),
    SAMPLE_ROUNDS: (db) => sampleRounds(db, actor, styleId),
    CERTIFICATES: (db) => certificates(db, actor, styleId),
  }
  const groups = await caller.withClient(async (client) => {
    const out: WhereUsedGroup[] = []
    // One kind after another: the request's client runs one query at a time anyway.
    for (const kind of WHERE_USED_KINDS) out.push(holds(actor, WHERE_USED_PERMISSION[kind]) ? await readers[kind](client) : notAllowed(kind))
    return out
  })
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, brand: style.brandParty ? { id: style.brandParty.id, code: style.brandParty.code, name: style.brandParty.tradeName ?? style.brandParty.legalName } : null },
    groups,
  }
}

