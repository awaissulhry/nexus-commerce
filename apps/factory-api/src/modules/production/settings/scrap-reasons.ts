import type { Prisma } from '@nexus/factory-db'
import type { ScanReasonList } from '@nexus/factory-domain/reasons/lists'
import type { NewReasonRow, ReasonChange, ReasonRow, ReasonStore } from '../../../platform/reasons/sources'

/**
 * The operation screen's scrap and rework reasons as a source of the ONE reason list editor (B-W2a-18; platform/reasons
 * sources.ts): the tenant's ScrapReason rows (W1, B-W1-42; seeded with factory-domain production/scans W1_SCAN_REASONS),
 * which the scans reference (OperationScanDefect: kind + code, Restrict). They keep Italian and English words, the tile
 * order and the active flag, and since W2b (B-W2b-01's columns, B-W2b-10 turns them on; MES-125) the other floor
 * languages, an icon, a colour and "needs a note", as ReasonCode keeps them. A code and its kind never change; a reason is
 * set inactive, never deleted (the …_production_scan_records_guards trigger). The scans keep reading them through their
 * own seam (modules/production/scans/reasons-store.ts); a code set inactive leaves the operation screen's tiles at once.
 *
 * Used: the scan lines that name a code (OperationScanDefect, SCRAP and REWORK), the rework orders opened with it
 * (ReworkOrder.reasonCode, REWORK) and the subcontract receipt lines that kept it (REWORK).
 */

type Client = Prisma.TransactionClient

const SELECT = { id: true, kind: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, needsDetail: true, sortOrder: true, active: true, version: true, createdAt: true, updatedAt: true } as const
type Row = Prisma.ScrapReasonGetPayload<{ select: typeof SELECT }>

/** The other languages' words as the row keeps them ({ "ro": "…" }; the database's guard keeps the shape). */
const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

const rowOf = (row: Row): ReasonRow => ({
  id: row.id,
  list: row.kind,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  needsDetail: row.needsDetail,
  sortOrder: row.sortOrder,
  active: row.active,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** The columns a change names (W2b, B-W2b-10: the other languages, icon, colour and needs detail too). */
function dataOf(change: ReasonChange): Prisma.ScrapReasonUpdateManyMutationInput {
  return {
    ...(change.labelIt === undefined ? {} : { labelIt: change.labelIt }),
    ...(change.labelEn === undefined ? {} : { labelEn: change.labelEn }),
    ...(change.labelI18n === undefined ? {} : { labelI18n: change.labelI18n }),
    ...(change.icon === undefined ? {} : { icon: change.icon }),
    ...(change.colour === undefined ? {} : { colour: change.colour }),
    ...(change.needsDetail === undefined ? {} : { needsDetail: change.needsDetail }),
    ...(change.active === undefined ? {} : { active: change.active }),
    ...(change.sortOrder === undefined ? {} : { sortOrder: change.sortOrder }),
  }
}

const count = (map: Map<string, number>, code: string, n: number) => map.set(code, (map.get(code) ?? 0) + n)

export const scrapReasonStore: ReasonStore = {
  source: 'SCRAP_REASON',
  lists: ['SCRAP', 'REWORK'],

  async rows(client: Client, lists, filter = {}) {
    const kinds = lists.filter((list): list is ScanReasonList => list === 'SCRAP' || list === 'REWORK')
    if (kinds.length === 0) return []
    const rows = await client.scrapReason.findMany({
      where: { kind: { in: kinds }, ...(filter.activeOnly ? { active: true } : {}) },
      select: SELECT,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })
    return rows.map(rowOf)
  },

  async row(client: Client, list, id) {
    const row = await client.scrapReason.findFirst({ where: { id, kind: list as ScanReasonList }, select: SELECT })
    return row ? rowOf(row) : null
  },

  async create(tx: Client, list, data: NewReasonRow) {
    const row = await tx.scrapReason.create({
      data: { id: data.id, kind: list as ScanReasonList, code: data.code, labelIt: data.labelIt, labelEn: data.labelEn, labelI18n: data.labelI18n, icon: data.icon, colour: data.colour, needsDetail: data.needsDetail, sortOrder: data.sortOrder, createdAt: data.at, updatedAt: data.at, createdById: data.createdById },
      select: SELECT,
    })
    return rowOf(row)
  },

  async update(tx: Client, list, id, change, at) {
    const row = await tx.scrapReason.update({ where: { id }, data: { ...dataOf(change), updatedAt: at }, select: SELECT })
    if (row.kind !== list) throw new Error(`ScrapReason ${id} is not of the ${list} list`)
    return rowOf(row)
  },

  async updateAtVersion(tx: Client, list, id, version, change, at) {
    const { count: changed } = await tx.scrapReason.updateMany({ where: { id, kind: list as ScanReasonList, version }, data: { ...dataOf(change), version: { increment: 1 }, updatedAt: at } })
    if (changed === 0) return null
    return rowOf(await tx.scrapReason.findUniqueOrThrow({ where: { id }, select: SELECT }))
  },

  async usage(client: Client, list) {
    const used = new Map<string, number>()
    const kind = list as ScanReasonList
    // B-W2b-15: material scrapped while in stock (production.scrapStock) keeps its code on its SCRAP moves: one per posting.
    if (kind === 'SCRAP') {
      const rows = await client.$queryRaw<{ code: string; n: bigint }[]>`
        SELECT m."reasonCode" AS code, count(DISTINCT regexp_replace(m."idempotencyKey", ':[0-9]+$', '')) AS n
          FROM "StockMove" m
         WHERE m."reason" = 'SCRAP' AND m."reasonCode" IS NOT NULL AND m."idempotencyKey" LIKE 'production.scrap:%'
         GROUP BY 1`
      for (const row of rows) count(used, row.code, Number(row.n))
    }
    for (const row of await client.operationScanDefect.groupBy({ by: ['reasonCode'], where: { kind }, _count: { _all: true } })) count(used, row.reasonCode, row._count._all)
    if (kind === 'REWORK') for (const row of await client.reworkOrder.groupBy({ by: ['reasonCode'], _count: { _all: true } })) count(used, row.reasonCode, row._count._all)
    // W2b (B-W2b-10): the subcontract receipt lines that kept a REWORK code (pieces rejected or scrapped at the workshop).
    if (kind === 'REWORK') for (const row of await client.subcontractReceiptLine.groupBy({ by: ['reasonCode'], where: { reasonCode: { not: null } }, _count: { _all: true } })) count(used, row.reasonCode!, row._count._all)
    return used
  },
}
