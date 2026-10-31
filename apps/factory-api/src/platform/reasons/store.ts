import type { Prisma } from '@nexus/factory-db'
import type { ReasonCodeList, ReasonList } from '@nexus/factory-domain/reasons/lists'
import { WRITE_OFF_COMMAND } from '@nexus/factory-domain/inventory/ledger/write-off'
import type { NewReasonRow, ReasonChange, ReasonRow, ReasonStore } from './sources'

/**
 * ReasonCode (factory-db reasons.prisma; B-W2a-01's table) as a source of the reason list editor: the eleven lists with
 * their words in Italian, English and the other floor languages, icon, colour, "needs a note", tile order and the
 * active flag. A list and a code never change; a reason is set inactive, never deleted (the …_platform_w2a_guards
 * trigger). Read in the caller's scope: the office and every floor device read the tenant's lists (no site key).
 *
 * Used — the records of other modules that keep a code of a list as text (USAGE below; a list no record names yet counts
 * nothing). A step that stores a code of a list adds its table here (one entry).
 */

type Client = Prisma.TransactionClient

const SELECT = { id: true, list: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, needsDetail: true, sortOrder: true, active: true, version: true, createdAt: true, updatedAt: true } as const
type Row = Prisma.ReasonCodeGetPayload<{ select: typeof SELECT }>

const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

const rowOf = (row: Row): ReasonRow => ({ ...row, labelI18n: wordsOf(row.labelI18n) })

function dataOf(change: ReasonChange): Prisma.ReasonCodeUpdateManyMutationInput {
  const data: Prisma.ReasonCodeUpdateManyMutationInput = {}
  if (change.labelIt !== undefined) data.labelIt = change.labelIt
  if (change.labelEn !== undefined) data.labelEn = change.labelEn
  if (change.labelI18n !== undefined) data.labelI18n = change.labelI18n
  if (change.icon !== undefined) data.icon = change.icon
  if (change.colour !== undefined) data.colour = change.colour
  if (change.needsDetail !== undefined) data.needsDetail = change.needsDetail
  if (change.active !== undefined) data.active = change.active
  if (change.sortOrder !== undefined) data.sortOrder = change.sortOrder
  return data
}

const add = (map: Map<string, number>, code: string | null, n: number) => {
  if (code) map.set(code, (map.get(code) ?? 0) + n)
}

/** Where each list's codes are kept on records (text, never a reference). */
const USAGE: Partial<Record<ReasonCodeList, (client: Client, used: Map<string, number>) => Promise<void>>> = {
  // Stock counts (B-W2a-15): a counted line that differs. B-W2b-15: and an adjustment move made with a code (its count's
  // COUNT moves carry their line's code too: counted once, by the line).
  async ADJUSTMENT(client, used) {
    for (const row of await client.stockCountLine.groupBy({ by: ['reasonCode'], where: { reasonCode: { not: null } }, _count: { _all: true } })) add(used, row.reasonCode, row._count._all)
    for (const row of await client.stockMove.groupBy({ by: ['reasonCode'], where: { reason: 'ADJUSTMENT', reasonCode: { not: null }, reversalOfId: null }, _count: { _all: true } })) add(used, row.reasonCode, row._count._all)
  },
  // Quality holds (wave 6/7): the hold's reason.
  async HOLD(client, used) {
    for (const row of await client.qualityHold.groupBy({ by: ['reasonCode'], _count: { _all: true } })) add(used, row.reasonCode, row._count._all)
  },
  // Returns (wave 2/7): the customer's reason per line.
  async RETURN(client, used) {
    for (const row of await client.returnLine.groupBy({ by: ['reasonCode'], _count: { _all: true } })) add(used, row.reasonCode, row._count._all)
  },
  // Write-offs (B-W2a-11): one write-off per key. B-W2b-15: the code is the moves' reasonCode; a write-off of before W2b
  // has it only as the first word of its note.
  async WRITE_OFF(client, used) {
    const pattern = `${WRITE_OFF_COMMAND}:%`
    const rows = await client.$queryRaw<{ code: string; n: bigint }[]>`
      SELECT coalesce(m."reasonCode", split_part(m."note", ':', 1)) AS code, count(DISTINCT regexp_replace(m."idempotencyKey", ':[0-9]+$', '')) AS n
        FROM "StockMove" m
       WHERE m."reason" = 'SCRAP' AND m."idempotencyKey" LIKE ${pattern} AND (m."reasonCode" IS NOT NULL OR m."note" IS NOT NULL)
       GROUP BY 1`
    for (const row of rows) add(used, row.code.trim(), Number(row.n))
  },
  // Receiving discrepancies (B-W2a-31): no column yet; the code leads the note (`DAMAGED: …`).
  async DISCREPANCY(client, used) {
    const rows = await client.$queryRaw<{ code: string; n: bigint }[]>`
      SELECT substring(d."note" from '^([A-Z][A-Z0-9_]{1,39})(?::|$)') AS code, count(*) AS n
        FROM "ReceiptDiscrepancy" d
       WHERE d."note" ~ '^[A-Z][A-Z0-9_]{1,39}(:|$)'
       GROUP BY 1`
    for (const row of rows) add(used, row.code, Number(row.n))
  },
  // Supplier claims (B-W2a-44): no column yet; the code leads the claim's reason (`QUALITY: …`).
  async CLAIM(client, used) {
    const rows = await client.$queryRaw<{ code: string; n: bigint }[]>`
      SELECT substring(c."reason" from '^([A-Z][A-Z0-9_]{1,39})(?::|$)') AS code, count(*) AS n
        FROM "SupplierClaim" c
       WHERE c."reason" ~ '^[A-Z][A-Z0-9_]{1,39}(:|$)'
       GROUP BY 1`
    for (const row of rows) add(used, row.code, Number(row.n))
  },
}

export const reasonCodeStore: ReasonStore = {
  source: 'REASON_CODE',
  lists: ['PAUSE', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL', 'WRITE_OFF', 'RETURN', 'DISCREPANCY', 'CLAIM', 'DOWNGRADE'],

  async rows(client: Client, lists, filter = {}) {
    const rows = await client.reasonCode.findMany({
      where: { list: { in: lists as ReasonCodeList[] }, ...(filter.activeOnly ? { active: true } : {}) },
      select: SELECT,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })
    return rows.map(rowOf)
  },

  async row(client: Client, list, id) {
    const row = await client.reasonCode.findFirst({ where: { id, list: list as ReasonCodeList }, select: SELECT })
    return row ? rowOf(row) : null
  },

  async create(tx: Client, list, data: NewReasonRow) {
    const row = await tx.reasonCode.create({
      data: {
        id: data.id,
        list: list as ReasonCodeList,
        code: data.code,
        labelIt: data.labelIt,
        labelEn: data.labelEn,
        labelI18n: data.labelI18n,
        icon: data.icon,
        colour: data.colour,
        needsDetail: data.needsDetail,
        sortOrder: data.sortOrder,
        createdAt: data.at,
        updatedAt: data.at,
        createdById: data.createdById,
      },
      select: SELECT,
    })
    return rowOf(row)
  },

  async update(tx: Client, list: ReasonList, id, change, at) {
    const row = await tx.reasonCode.update({ where: { id }, data: { ...dataOf(change), updatedAt: at }, select: SELECT })
    if (row.list !== list) throw new Error(`ReasonCode ${id} is not of the ${list} list`)
    return rowOf(row)
  },

  async updateAtVersion(tx: Client, list, id, version, change, at) {
    const { count } = await tx.reasonCode.updateMany({ where: { id, list: list as ReasonCodeList, version }, data: { ...dataOf(change), version: { increment: 1 }, updatedAt: at } })
    if (count === 0) return null
    return rowOf(await tx.reasonCode.findUniqueOrThrow({ where: { id }, select: SELECT }))
  },

  async usage(client: Client, list) {
    const used = new Map<string, number>()
    await USAGE[list as ReasonCodeList]?.(client, used)
    return used
  },
}
