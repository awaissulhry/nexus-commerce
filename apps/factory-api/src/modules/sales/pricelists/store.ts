import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { inForceOn, listPriceText, listStateOf, listTiles, marginPctOf, type ChainLevel, type PriceListKind, type VersionFacts } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { costLine, type SheetCache } from '../quotes/pricing'
import { rulesInForce, settingsRowsFor } from '../quotes/rules'
import { officeContextOf, type Reader } from '../quotes/store'

/**
 * The price lists' reads (factory-db pricing.prisma PriceList, PriceListVersion, PriceListEntry): the columns every read
 * names, who may see and change a list (office only; can() on its company: a list of every company is seen with any
 * grant that holds the permission and changed only by a grant over every company), the locks every write takes (the
 * list's row first, then a version's compare-and-set: one order, so two writers never deadlock), a version's prices
 * with today's standard cost and margin (only for a caller who holds the cost or the margin grain), and the price chain
 * a quote line reads its list price from.
 */

export const LIST_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  kind: true,
  currency: true,
  baseListId: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PriceListSelect
export type ListRow = Prisma.PriceListGetPayload<{ select: typeof LIST_COLUMNS }>

export const VERSION_COLUMNS = {
  id: true,
  listId: true,
  revision: true,
  status: true,
  validFrom: true,
  validTo: true,
  activatedAt: true,
  activatedById: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PriceListVersionSelect
export type ListVersionRow = Prisma.PriceListVersionGetPayload<{ select: typeof VERSION_COLUMNS }>

export const ENTRY_COLUMNS = { id: true, versionId: true, styleId: true, colourwayId: true, unitPrice: true, version: true } as const satisfies Prisma.PriceListEntrySelect
export type EntryRow = Prisma.PriceListEntryGetPayload<{ select: typeof ENTRY_COLUMNS }>

export const LIST_SCOPE = { company: { field: 'companyId', nullable: true } } as const

export const dayText = (value: Date | null): BusinessDate | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dayValue = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
export const priceOf = (value: Prisma.Decimal): string => listPriceText(value.toString())

export const versionFactsOf = (row: ListVersionRow): VersionFacts => ({ id: row.id, revision: row.revision, status: row.status, validFrom: dayText(row.validFrom), validTo: dayText(row.validTo) })

export const mayOnList = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => can(actorOf(context), permission, companyId === null ? {} : { companyId })

/** The list the caller may see (else 404). */
export async function readListFor(caller: CommandCaller, listId: string): Promise<ListRow> {
  const context = officeContextOf(caller)
  const row = isUuid(listId) ? await caller.withClient((client) => client.priceList.findUnique({ where: { id: listId }, select: LIST_COLUMNS })) : null
  if (!row || !mayOnList(context, PRICE_LISTS_VIEW, row.companyId)) throw new NotFoundError('Price list not found.')
  return row
}

/** The caller may change lists of this company (every company: a grant over every company), else 403. */
export function assertMayChangeList(context: OfficeContext, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) throw new ForbiddenError(companyId === null ? 'A price list of every company is changed only by a role over every company.' : undefined)
}

/** Locks the list's row for the rest of the command: every write to a list, its versions or its prices takes it first. */
export async function lockList(tx: CommandTx, listId: string): Promise<ListRow> {
  await tx.$queryRaw`SELECT id FROM "PriceList" WHERE id = ${listId}::uuid FOR UPDATE`
  const row = await tx.priceList.findUnique({ where: { id: listId }, select: LIST_COLUMNS })
  if (!row) throw new NotFoundError('Price list not found.')
  return row
}

/** A version of the list, compared and set by hand under the list's lock (its version bumped); 409 when it changed. */
export async function claimVersion(tx: CommandTx, listId: string, versionId: string, expected: number, now: Date): Promise<ListVersionRow> {
  const row = isUuid(versionId) ? await tx.priceListVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS }) : null
  if (!row || row.listId !== listId) throw new NotFoundError('Price list version not found.')
  if (row.version !== expected) throw new StaleVersionError('PriceListVersion', versionId, row.version, expected)
  const { count } = await tx.priceListVersion.updateMany({ where: { id: versionId, version: expected }, data: { version: expected + 1, updatedAt: now } })
  if (count !== 1) throw new StaleVersionError('PriceListVersion', versionId, expected + 1, expected)
  return { ...row, version: expected + 1, updatedAt: now }
}

export const versionsOf = (db: Reader, listIds: readonly string[]): Promise<ListVersionRow[]> =>
  listIds.length === 0 ? Promise.resolve([]) : db.priceListVersion.findMany({ where: { listId: { in: [...listIds] } }, select: VERSION_COLUMNS, orderBy: [{ listId: 'asc' }, { revision: 'asc' }] })

export const versionViewOf = (row: ListVersionRow, entries: number) => ({
  id: row.id,
  revision: row.revision,
  status: row.status,
  validFrom: dayText(row.validFrom),
  validTo: dayText(row.validTo),
  activatedAt: row.activatedAt === null ? null : toUtcIso(row.activatedAt),
  activatedById: row.activatedById,
  note: row.note,
  /** How many prices it holds. */
  entries,
  version: row.version,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
})

/** One list as the list screen reads it: its state today, the version in force (or next), its customers, its prices. */
export async function listRowsOf(db: Reader, lists: readonly ListRow[], today: BusinessDate) {
  const ids = lists.map((row) => row.id)
  const versions = await versionsOf(db, ids)
  const counts = ids.length === 0 ? [] : await db.priceListEntry.groupBy({ by: ['versionId'], where: { versionId: { in: versions.map((row) => row.id) } }, _count: { _all: true } })
  const entriesOf = new Map(counts.map((row) => [row.versionId, row._count._all]))
  const customers = ids.length === 0 ? [] : await db.party.groupBy({ by: ['priceListId'], where: { priceListId: { in: ids } }, _count: { _all: true } })
  const customersOf = new Map(customers.map((row) => [row.priceListId!, row._count._all]))
  const bases = new Map((await db.priceList.findMany({ where: { id: { in: [...new Set(lists.flatMap((row) => (row.baseListId ? [row.baseListId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return lists.map((row) => {
    const own = versions.filter((version) => version.listId === row.id)
    const facts = own.map(versionFactsOf)
    const current = inForceOn(facts, today)
    const shown = current ?? facts.filter((version) => version.status === 'ACTIVE').at(-1) ?? facts.at(-1) ?? null
    const draft = own.find((version) => version.status === 'DRAFT') ?? null
    const tiles = listTiles(facts, today)
    return {
      id: row.id,
      companyId: row.companyId,
      code: row.code,
      name: row.name,
      kind: row.kind as PriceListKind,
      currency: row.currency,
      baseList: row.baseListId ? (bases.get(row.baseListId) ?? { id: row.baseListId, code: '', name: '' }) : null,
      state: listStateOf(row.status as 'ACTIVE' | 'ARCHIVED', facts, today),
      status: row.status as 'ACTIVE' | 'ARCHIVED',
      /** The version in force today, else the last active one, else the newest draft. */
      shownVersion: shown ? { id: shown.id, revision: shown.revision, status: shown.status, validFrom: shown.validFrom, validTo: shown.validTo } : null,
      draftVersionId: draft?.id ?? null,
      stylesPriced: shown ? (entriesOf.get(shown.id) ?? 0) : 0,
      customers: customersOf.get(row.id) ?? 0,
      startsSoon: tiles.startsSoon,
      endsSoon: tiles.endsSoon,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}
export type ListRowView = Awaited<ReturnType<typeof listRowsOf>>[number]

// ---- a version's prices with today's standard cost and margin ----------------------------------------------------------

/**
 * The cost of one piece of a style in a colourway at its base size (the costing sheet of its RELEASED revision, else
 * its newest DRAFT: an estimate), or null without a revision or with inputs missing. A price row for every colourway
 * takes its dearest active colourway (the lowest margin).
 */
async function unitCostsOf(db: Reader, entries: readonly EntryRow[], companyId: string | null, now: Date): Promise<Map<string, string | null>> {
  const company = companyId === null ? { id: null, currency: costingCurrency(null) } : await db.company.findUnique({ where: { id: companyId }, select: { id: true, currency: true } }).then((row) => ({ id: row?.id ?? null, currency: costingCurrency(row?.currency ?? null) }))
  const styleIds = [...new Set(entries.map((entry) => entry.styleId))]
  const styles = new Map((await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, sizes: true, baseSize: true } })).map((row) => [row.id, row]))
  const revisions = await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: { in: ['RELEASED', 'DRAFT'] } }, select: { id: true, styleId: true, status: true, revision: true }, orderBy: { revision: 'desc' } })
  const revisionOf = (styleId: string) => revisions.find((row) => row.styleId === styleId && row.status === 'RELEASED')?.id ?? revisions.find((row) => row.styleId === styleId)?.id ?? null
  const colourways = await db.colourway.findMany({ where: { styleId: { in: styleIds }, status: 'ACTIVE' }, select: { id: true, styleId: true } })
  const cache: SheetCache = new Map()
  const costs = new Map<string, string | null>()
  for (const entry of entries) {
    const style = styles.get(entry.styleId)
    const revisionId = revisionOf(entry.styleId)
    const size = style?.baseSize ?? style?.sizes[0] ?? null
    if (!style || revisionId === null || size === null) {
      costs.set(entry.id, null)
      continue
    }
    const targets = entry.colourwayId !== null ? [entry.colourwayId] : colourways.filter((row) => row.styleId === entry.styleId).map((row) => row.id)
    let dearest: string | null = null
    let known = targets.length > 0
    for (const colourwayId of targets) {
      const { cost } = await costLine(db, cache, { styleId: entry.styleId, styleRevisionId: revisionId, colourwayId, sizes: [{ size, quantity: 1, unitPrice: null }] }, company, now)
      if (!cost.complete || cost.unitCost === null) {
        known = false
        break
      }
      if (dearest === null || new Dec(cost.unitCost).gt(new Dec(dearest))) dearest = cost.unitCost
    }
    costs.set(entry.id, known ? dearest : null)
  }
  return costs
}

/** A version's prices for the record's Prices tab, with labels; cost and margin only for a caller with those grains. */
export async function entriesViewOf(db: Reader, context: RequestContext, list: Pick<ListRow, 'companyId'>, versionId: string, now: Date) {
  const entries = await db.priceListEntry.findMany({ where: { versionId }, select: ENTRY_COLUMNS })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.styleId))] } }, select: { id: true, code: true, name: true, status: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const grains = heldGrains(actorOf(context))
  const costs = grains.has('cost') || grains.has('margin') ? await unitCostsOf(db, entries, list.companyId, now) : new Map<string, string | null>()
  const floor = grains.has('margin') ? rulesInForce(await settingsRowsFor(db, list.companyId), list.companyId).marginFloorPct : null
  const rows = entries.map((entry) => {
    const style = styles.get(entry.styleId)
    const colourway = entry.colourwayId ? colourways.get(entry.colourwayId) : undefined
    const unitPrice = priceOf(entry.unitPrice)
    const cost = costs.get(entry.id) ?? null
    const margin = marginPctOf(unitPrice, cost)
    return {
      id: entry.id,
      styleId: entry.styleId,
      style: { code: style?.code ?? '', name: style?.name ?? '', status: style?.status ?? 'ARCHIVED' },
      colourwayId: entry.colourwayId,
      colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
      unitPrice: asMoney('price', unitPrice),
      /** One piece at the style's base size, from today's cost sheet (for every colourway: the dearest). */
      standardCost: asMoney('cost', cost),
      marginPct: asMoney('margin', margin),
      belowFloor: asMoney('margin', margin !== null && floor !== null && new Dec(margin).lt(new Dec(floor))),
      version: entry.version,
    }
  })
  return rows.sort((a, b) => (a.style.code < b.style.code ? -1 : a.style.code > b.style.code ? 1 : (a.colourway?.code ?? '') < (b.colourway?.code ?? '') ? -1 : 1))
}

// ---- the price chain a quote reads its list prices from (SAL-165) --------------------------------------------------------

export interface PriceChainStart {
  /** The quote's company and currency: a list of another company or currency never prices it. */
  readonly companyId: string
  readonly currency: string
  /** The customer's own list (Party.priceListId); null: the company's BASE list. */
  readonly partyListId: string | null
  /** The version the quote keeps (QuoteVersion.priceListVersionId): the chain starts from it. */
  readonly pinnedVersionId: string | null
  /** The day the other lists of the chain are read on (today). */
  readonly day: BusinessDate
  /** Only these styles' prices are read (a line's style); undefined: every price. */
  readonly styleIds?: readonly string[] | undefined
}

export interface PriceChain {
  readonly levels: readonly ChainLevel[]
  /** The version the quote should keep: the pinned one, else the first version found in force along the chain. */
  readonly keptVersionId: string | null
  readonly lists: readonly { readonly id: string; readonly code: string; readonly name: string; readonly kind: PriceListKind; readonly versionId: string | null; readonly revision: number | null }[]
}

const usable = (row: Pick<ListRow, 'status' | 'currency' | 'companyId'>, start: PriceChainStart): boolean => row.status === 'ACTIVE' && row.currency === start.currency && (row.companyId === null || row.companyId === start.companyId)

/**
 * The lists a quote is priced from, in order: the list of the version it keeps, else the customer's list (when it is
 * active, of the quote's company or every company, in the quote's currency), else the company's BASE list (its own,
 * else every company's); then the lists each falls back to (baseListId), at most PRICE_LIST_LIMITS.chain deep. Each list
 * is read at its version in force on `day` (the kept version for the first).
 */
export async function priceChainOf(db: Reader, start: PriceChainStart): Promise<PriceChain> {
  let first: ListRow | null = null
  let pinned: ListVersionRow | null = null
  if (start.pinnedVersionId !== null) {
    pinned = await db.priceListVersion.findUnique({ where: { id: start.pinnedVersionId }, select: VERSION_COLUMNS })
    first = pinned ? await db.priceList.findUnique({ where: { id: pinned.listId }, select: LIST_COLUMNS }) : null
    if (first && !(first.currency === start.currency && (first.companyId === null || first.companyId === start.companyId))) first = null
  }
  if (!first && start.partyListId !== null) {
    const own = await db.priceList.findUnique({ where: { id: start.partyListId }, select: LIST_COLUMNS })
    if (own && usable(own, start)) first = own
  }
  if (!first) {
    const bases = await db.priceList.findMany({ where: { kind: 'BASE', status: 'ACTIVE', currency: start.currency, OR: [{ companyId: start.companyId }, { companyId: null }] }, select: LIST_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    first = bases.find((row) => row.companyId === start.companyId) ?? bases[0] ?? null
  }
  const lists: ListRow[] = []
  const seen = new Set<string>()
  for (let list = first; list && lists.length < 8 && !seen.has(list.id); ) {
    lists.push(list)
    seen.add(list.id)
    const next: ListRow | null = list.baseListId ? await db.priceList.findUnique({ where: { id: list.baseListId }, select: LIST_COLUMNS }) : null
    list = next && usable(next, start) ? next : null
  }
  const versions = await versionsOf(db, lists.map((row) => row.id))
  const chosen = lists.map((list, index) => (index === 0 && pinned && pinned.listId === list.id ? pinned : (inForceOn(versions.filter((row) => row.listId === list.id).map((row) => ({ ...versionFactsOf(row), row })), start.day)?.row ?? null)))
  const versionIds = chosen.flatMap((row) => (row ? [row.id] : []))
  const entries = versionIds.length === 0 ? [] : await db.priceListEntry.findMany({ where: { versionId: { in: versionIds }, ...(start.styleIds ? { styleId: { in: [...start.styleIds] } } : {}) }, select: ENTRY_COLUMNS })
  return {
    levels: lists.map((list, index) => ({
      listId: list.id,
      versionId: chosen[index]?.id ?? null,
      entries: entries.filter((entry) => entry.versionId === chosen[index]?.id).map((entry) => ({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: entry.unitPrice.toString() })),
    })),
    keptVersionId: pinned && first?.id === pinned.listId ? pinned.id : (chosen.find((row) => row !== null)?.id ?? null),
    lists: lists.map((list, index) => ({ id: list.id, code: list.code, name: list.name, kind: list.kind as PriceListKind, versionId: chosen[index]?.id ?? null, revision: chosen[index]?.revision ?? null })),
  }
}
