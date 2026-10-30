import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'

/**
 * The counts' ONE storage seam (B-W2a-15): every column the module reads or writes of StockCount and StockCountLine
 * (factory-db stockcount.prisma), the row locks, and the audit row of every write (a count's whole header before and
 * after, its value marked with the cost grain; a line's counted columns). The …_stock_plan_w2a_guards triggers hold the
 * moves and the history; the callers check the same rules first, in words.
 */

type Client = FactoryClient | CommandTx

export const COUNT_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  kind: true,
  locationId: true,
  itemId: true,
  lotId: true,
  itemKind: true,
  inventoryDate: true,
  countTeam: true,
  status: true,
  startedAt: true,
  snapshotAt: true,
  submittedAt: true,
  submittedById: true,
  differenceAmount: true,
  approvalRequired: true,
  approvedAt: true,
  approvedById: true,
  approvalNote: true,
  rejectedAt: true,
  rejectedById: true,
  rejectReason: true,
  appliedAt: true,
  appliedById: true,
  signedOffAt: true,
  signedOffById: true,
  valuedListFileId: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.StockCountSelect
export type CountRow = Prisma.StockCountGetPayload<{ select: typeof COUNT_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  siteId: true,
  countId: true,
  seq: true,
  locationId: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  origin: true,
  expectedQuantity: true,
  countedQuantity: true,
  countedAt: true,
  countedById: true,
  recountRequestedAt: true,
  recountRequestedById: true,
  recountQuantity: true,
  recountedAt: true,
  recountedById: true,
  reasonCode: true,
  reasonNote: true,
  moveId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.StockCountLineSelect
export type LineRow = Prisma.StockCountLineGetPayload<{ select: typeof LINE_COLUMNS }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const text = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(4))

// ---- reads ---------------------------------------------------------------------------------------------------------------

export function readCount(client: Client, countId: string): Promise<CountRow | null> {
  return client.stockCount.findUnique({ where: { id: countId }, select: COUNT_COLUMNS })
}

export function readLines(client: Client, countId: string, where: Prisma.StockCountLineWhereInput = {}, page?: { readonly afterSeq?: number; readonly take?: number }): Promise<LineRow[]> {
  return client.stockCountLine.findMany({
    where: { AND: [{ countId }, where, page?.afterSeq !== undefined ? { seq: { gt: page.afterSeq } } : {}] },
    select: LINE_COLUMNS,
    orderBy: { seq: 'asc' },
    ...(page?.take !== undefined ? { take: page.take } : {}),
  })
}

// ---- locks ---------------------------------------------------------------------------------------------------------------

/** Locks the count's row (FOR UPDATE: a move of the count) and reads it, checking the version the caller read. */
export async function lockCount(tx: CommandTx, countId: string, expectedVersion?: number): Promise<CountRow> {
  const locked = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "StockCount" WHERE id = ${countId}::uuid FOR UPDATE`
  if (!locked[0]) throw new NotFoundError('Stock count not found.')
  if (expectedVersion !== undefined && expectedVersion !== locked[0].version) throw new StaleVersionError('StockCount', countId, locked[0].version, expectedVersion)
  return (await readCount(tx, countId))!
}

/**
 * Takes the count's row FOR SHARE (as the line trigger does) and reads it: lines are written while no move of the count
 * runs, and many people type lines at once without waiting for each other.
 */
export async function shareCount(tx: CommandTx, countId: string): Promise<CountRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "StockCount" WHERE id = ${countId}::uuid FOR SHARE`
  if (!locked[0]) throw new NotFoundError('Stock count not found.')
  return (await readCount(tx, countId))!
}

/**
 * One count's start or line at a time per site and stock key: a transaction lock per site for the moments that freeze or
 * add stock keys (start, an added line), so two counts never take the same stock key at once.
 */
export async function lockSiteCounts(tx: CommandTx, tenantId: string, siteId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.stock-count-keys', ${tenantId}::uuid, ${siteId}::uuid), 0))`
}

// ---- the audit rows ------------------------------------------------------------------------------------------------------

/** What an audit row records of a count: its whole header; the differences' value marked with the cost grain. */
export function audited(row: CountRow): Record<string, unknown> {
  return {
    number: row.number,
    kind: row.kind,
    siteId: row.siteId,
    locationId: row.locationId,
    itemId: row.itemId,
    lotId: row.lotId,
    itemKind: row.itemKind,
    inventoryDate: day(row.inventoryDate),
    countTeam: row.countTeam,
    status: row.status,
    startedAt: iso(row.startedAt),
    snapshotAt: iso(row.snapshotAt),
    submittedAt: iso(row.submittedAt),
    submittedById: row.submittedById,
    differenceAmount: row.differenceAmount === null ? null : markMoney('cost', row.differenceAmount),
    approvalRequired: row.approvalRequired,
    approvedAt: iso(row.approvedAt),
    approvedById: row.approvedById,
    approvalNote: row.approvalNote,
    rejectedAt: iso(row.rejectedAt),
    rejectedById: row.rejectedById,
    rejectReason: row.rejectReason,
    appliedAt: iso(row.appliedAt),
    appliedById: row.appliedById,
    signedOffAt: iso(row.signedOffAt),
    signedOffById: row.signedOffById,
    valuedListFileId: row.valuedListFileId,
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    note: row.note,
  }
}

/** What an audit row records of a line: its stock key, what was expected and what was counted (no cost). */
export function auditedLine(row: LineRow): Record<string, unknown> {
  return {
    countId: row.countId,
    seq: row.seq,
    locationId: row.locationId,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    origin: row.origin,
    expectedQuantity: text(row.expectedQuantity),
    countedQuantity: text(row.countedQuantity),
    countedAt: iso(row.countedAt),
    countedById: row.countedById,
    recountRequestedAt: iso(row.recountRequestedAt),
    recountRequestedById: row.recountRequestedById,
    recountQuantity: text(row.recountQuantity),
    recountedAt: iso(row.recountedAt),
    recountedById: row.recountedById,
    reasonCode: row.reasonCode,
    reasonNote: row.reasonNote,
    moveId: row.moveId,
  }
}

export interface WriteOptions {
  /** The audit action; default the command's name. */
  readonly action?: string
  readonly reason?: string
}

type Tools = Pick<CommandTools, 'tx' | 'audit' | 'now'>

// ---- count writes ---------------------------------------------------------------------------------------------------------

export type NewCount = Pick<CountRow, 'id' | 'companyId' | 'siteId' | 'number' | 'kind' | 'locationId' | 'itemId' | 'lotId' | 'itemKind' | 'inventoryDate' | 'countTeam' | 'note' | 'createdById'>

export async function insertCount(tools: Tools, count: NewCount, options: WriteOptions = {}): Promise<CountRow> {
  const row = await tools.tx.stockCount.create({
    data: { ...count, status: 'DRAFT', createdAt: tools.now, updatedAt: tools.now },
    select: COUNT_COLUMNS,
  })
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'StockCount', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: audited(row), ...(options.reason ? { reason: options.reason } : {}) })
  return row
}

export type CountChanges = Partial<
  Pick<
    CountRow,
    | 'countTeam'
    | 'note'
    | 'status'
    | 'startedAt'
    | 'snapshotAt'
    | 'submittedAt'
    | 'submittedById'
    | 'differenceAmount'
    | 'approvalRequired'
    | 'approvedAt'
    | 'approvedById'
    | 'approvalNote'
    | 'rejectedAt'
    | 'rejectedById'
    | 'rejectReason'
    | 'appliedAt'
    | 'appliedById'
    | 'signedOffAt'
    | 'signedOffById'
    | 'valuedListFileId'
    | 'cancelledAt'
    | 'cancelReason'
  >
>

/**
 * Updates a LOCKED count (lockCount first) in ONE statement, so a move writes its columns with its status (the trigger
 * checks them together), moves its version, and records the audit row (before and after).
 */
export async function updateCount(tools: Tools, before: CountRow, changes: CountChanges, options: WriteOptions = {}): Promise<CountRow> {
  const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Prisma.StockCountUncheckedUpdateInput
  const row = await tools.tx.stockCount.update({ where: { id: before.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: COUNT_COLUMNS })
  tools.audit({
    ...(options.action ? { action: options.action } : {}),
    recordType: 'StockCount',
    recordId: before.id,
    companyId: before.companyId,
    siteId: before.siteId,
    before: audited(before),
    after: audited(row),
    ...(options.reason ? { reason: options.reason } : {}),
  })
  return row
}

// ---- line writes ----------------------------------------------------------------------------------------------------------

export type NewLine = Pick<LineRow, 'id' | 'siteId' | 'countId' | 'seq' | 'locationId' | 'itemId' | 'itemColourId' | 'lotId' | 'hideId' | 'origin' | 'createdById'> & {
  readonly expectedQuantity: string
} & Partial<Pick<LineRow, 'countedAt' | 'countedById' | 'reasonCode' | 'reasonNote'>> & { readonly countedQuantity?: string | null }

/** The snapshot's lines, in one statement (their audit is the start's row on the count: the frozen line count). */
export async function insertSnapshotLines(tx: CommandTx, now: Date, lines: readonly NewLine[]): Promise<void> {
  for (let start = 0; start < lines.length; start += 1000) {
    await tx.stockCountLine.createMany({ data: lines.slice(start, start + 1000).map((line) => ({ ...line, createdAt: now, updatedAt: now })) })
  }
}

/** One line found while counting (ADDED), with its audit row. */
export async function insertLine(tools: Tools, line: NewLine, options: WriteOptions = {}): Promise<LineRow> {
  const row = await tools.tx.stockCountLine.create({ data: { ...line, createdAt: tools.now, updatedAt: tools.now }, select: LINE_COLUMNS })
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'StockCountLine', recordId: row.id, siteId: row.siteId, after: auditedLine(row), ...(options.reason ? { reason: options.reason } : {}) })
  return row
}

export type LineChanges = Partial<
  Pick<LineRow, 'countedAt' | 'countedById' | 'recountRequestedAt' | 'recountRequestedById' | 'recountedAt' | 'recountedById' | 'reasonCode' | 'reasonNote' | 'moveId'>
> & { readonly countedQuantity?: string | null; readonly recountQuantity?: string | null }

/**
 * Updates a line at the version the caller read (compare-and-set: a line two people typed at once is refused to the
 * second, 409 naming its line), moves its version, and records the audit row. `expectedVersion` undefined: the version
 * read here (the apply naming its move).
 */
export async function updateLine(tools: Tools, before: LineRow, changes: LineChanges, expectedVersion: number | undefined, options: WriteOptions = {}): Promise<LineRow> {
  const version = expectedVersion ?? before.version
  const data = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) as Prisma.StockCountLineUncheckedUpdateManyInput
  const { count } = await tools.tx.stockCountLine.updateMany({ where: { id: before.id, version }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } } })
  if (count !== 1) {
    const current = await tools.tx.stockCountLine.findUnique({ where: { id: before.id }, select: { version: true } })
    if (!current) throw new NotFoundError(`Line ${before.seq} not found.`)
    throw new LineChangedError(before.seq, current.version, version)
  }
  const row = (await tools.tx.stockCountLine.findUnique({ where: { id: before.id }, select: LINE_COLUMNS }))!
  tools.audit({
    ...(options.action ? { action: options.action } : {}),
    recordType: 'StockCountLine',
    recordId: row.id,
    siteId: row.siteId,
    before: auditedLine(before),
    after: auditedLine(row),
    ...(options.reason ? { reason: options.reason } : {}),
  })
  return row
}

/** Removes a line found while counting (the trigger allows it only while the count is DRAFT or COUNTING). */
export async function deleteLine(tools: Tools, before: LineRow, expectedVersion: number, options: WriteOptions = {}): Promise<void> {
  const { count } = await tools.tx.stockCountLine.deleteMany({ where: { id: before.id, version: expectedVersion } })
  if (count !== 1) {
    const current = await tools.tx.stockCountLine.findUnique({ where: { id: before.id }, select: { version: true } })
    if (!current) throw new NotFoundError(`Line ${before.seq} not found.`)
    throw new LineChangedError(before.seq, current.version, expectedVersion)
  }
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'StockCountLine', recordId: before.id, siteId: before.siteId, before: auditedLine(before), ...(options.reason ? { reason: options.reason } : {}) })
}

/** A line changed since it was read (another person typed it). */
export class LineChangedError extends ConflictError {
  override name = 'LineChangedError'
  override readonly issues: readonly Issue[]
  constructor(seq: number, current: number, sent: number) {
    super(`Line ${seq} changed since it was read (version ${sent}); it is now at version ${current}. Reload it and type it again.`)
    this.issues = [{ path: `lines/${seq}/version`, message: `The current version is ${current}.` }]
  }
}
