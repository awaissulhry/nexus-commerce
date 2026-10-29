import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { RegisterKind, RegisterRisk, RegisterSourceType, RegisterStatus } from '@nexus/factory-domain/compliance/register/rules'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'

/**
 * The PPE register's ONE storage seam (B-W1-43). Everything the module reads or writes of a PpeRegisterEntry goes
 * through here: the columns (quality.prisma), the row lock, the audit row of every write (the whole record before and
 * after) and the reference, which the company's PPE_REGISTER number series issues (allocateNumber, in the writing
 * command: no gap, never twice).
 */

type Client = FactoryClient | CommandTx

export interface EntryRecord {
  readonly id: string
  readonly companyId: string
  readonly reference: string
  readonly kind: RegisterKind
  readonly status: RegisterStatus
  readonly styleId: string
  readonly styleRevisionId: string | null
  readonly batchNumbers: readonly string[]
  readonly serials: readonly string[]
  readonly lotIds: readonly string[]
  readonly workOrderIds: readonly string[]
  readonly shipmentIds: readonly string[]
  /** Who reported it (a customer or distributor). */
  readonly partyId: string | null
  /** The office user who follows it up. */
  readonly ownerId: string | null
  readonly sourceType: RegisterSourceType | null
  readonly sourceId: string | null
  readonly reportedAt: Date
  readonly description: string
  readonly investigation: string | null
  readonly risk: RegisterRisk
  readonly actionTaken: string | null
  readonly actionCompletedAt: Date | null
  readonly distributorsInformedAt: Date | null
  readonly authorityNotifiedAt: Date | null
  readonly authorityReference: string | null
  readonly closedAt: Date | null
  readonly closedById: string | null
  readonly closeReason: string | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly createdById: string | null
}

/** The facts a write may set (never the id, company, reference, kind, report time or creation: the trigger keeps them). */
export type EntryChanges = Partial<
  Pick<
    EntryRecord,
    | 'styleId'
    | 'styleRevisionId'
    | 'batchNumbers'
    | 'serials'
    | 'lotIds'
    | 'workOrderIds'
    | 'shipmentIds'
    | 'partyId'
    | 'ownerId'
    | 'description'
    | 'investigation'
    | 'risk'
    | 'actionTaken'
    | 'actionCompletedAt'
    | 'distributorsInformedAt'
    | 'authorityNotifiedAt'
    | 'authorityReference'
    | 'status'
    | 'closedAt'
    | 'closedById'
    | 'closeReason'
  >
>

export type NewEntry = Pick<EntryRecord, 'id' | 'companyId' | 'reference' | 'kind' | 'reportedAt' | 'description' | 'createdById'> &
  Partial<Pick<EntryRecord, 'sourceType' | 'sourceId'>> &
  Omit<EntryChanges, 'status' | 'closedAt' | 'closedById' | 'closeReason'>

const COLUMNS = {
  id: true,
  companyId: true,
  reference: true,
  kind: true,
  status: true,
  styleId: true,
  styleRevisionId: true,
  batchNumbers: true,
  serials: true,
  lotIds: true,
  workOrderIds: true,
  shipmentIds: true,
  partyId: true,
  ownerId: true,
  sourceType: true,
  sourceId: true,
  reportedAt: true,
  description: true,
  investigation: true,
  risk: true,
  actionTaken: true,
  actionCompletedAt: true,
  distributorsInformedAt: true,
  authorityNotifiedAt: true,
  authorityReference: true,
  closedAt: true,
  closedById: true,
  closeReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PpeRegisterEntrySelect
type Row = Prisma.PpeRegisterEntryGetPayload<{ select: typeof COLUMNS }>

const recordOf = (row: Row): EntryRecord => ({
  ...row,
  // The lists are never NULL in practice (default empty); a NULL reads as empty.
  batchNumbers: row.batchNumbers ?? [],
  serials: row.serials ?? [],
  lotIds: row.lotIds ?? [],
  workOrderIds: row.workOrderIds ?? [],
  shipmentIds: row.shipmentIds ?? [],
  sourceType: row.sourceType as RegisterSourceType | null,
})

// ---- reads ---------------------------------------------------------------------------------------------------------------

export async function readEntry(client: Client, entryId: string): Promise<EntryRecord | null> {
  const row = await client.ppeRegisterEntry.findUnique({ where: { id: entryId }, select: COLUMNS })
  return row ? recordOf(row) : null
}

/** The entry another record opened, if any (one per source record: the partial unique index). */
export async function readEntryBySource(client: Client, sourceType: RegisterSourceType, sourceId: string): Promise<EntryRecord | null> {
  const row = await client.ppeRegisterEntry.findFirst({ where: { sourceType, sourceId }, select: COLUMNS })
  return row ? recordOf(row) : null
}

export interface EntryFilter {
  /** The caller's scope (scopeWhere over companyId and partyId). */
  readonly scope: Prisma.PpeRegisterEntryWhereInput
  readonly kind?: RegisterKind | undefined
  readonly status?: RegisterStatus | undefined
  readonly risk?: RegisterRisk | undefined
  readonly styleId?: string | undefined
  readonly companyId?: string | undefined
  /** Reported at or after / before these instants. */
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  /** In the reference or the description, any case. */
  readonly search?: string | undefined
  readonly limit: number
}

/** The register, newest report first. */
export async function readEntries(client: Client, filter: EntryFilter): Promise<EntryRecord[]> {
  const where: Prisma.PpeRegisterEntryWhereInput = {
    AND: [
      filter.scope,
      filter.kind ? { kind: filter.kind } : {},
      filter.status ? { status: filter.status } : {},
      filter.risk ? { risk: filter.risk } : {},
      filter.styleId ? { styleId: filter.styleId } : {},
      filter.companyId ? { companyId: filter.companyId } : {},
      filter.from ? { reportedAt: { gte: filter.from } } : {},
      filter.to ? { reportedAt: { lt: filter.to } } : {},
      filter.search
        ? { OR: [{ reference: { contains: filter.search, mode: 'insensitive' } }, { description: { contains: filter.search, mode: 'insensitive' } }] }
        : {},
    ],
  }
  const rows = await client.ppeRegisterEntry.findMany({ where, select: COLUMNS, orderBy: [{ reportedAt: 'desc' }, { reference: 'desc' }, { id: 'asc' }], take: filter.limit })
  return rows.map(recordOf)
}

// ---- writes (inside the caller's command) --------------------------------------------------------------------------------

/** Locks the entry's row (FOR UPDATE) and reads it, checking the version the caller read. */
export async function lockEntry(tx: CommandTx, entryId: string, expectedVersion?: number): Promise<EntryRecord> {
  const locked = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "PpeRegisterEntry" WHERE id = ${entryId}::uuid FOR UPDATE`
  if (!locked[0]) throw new NotFoundError('Register entry not found.')
  if (expectedVersion !== undefined && expectedVersion !== locked[0].version) throw new StaleVersionError('PpeRegisterEntry', entryId, locked[0].version, expectedVersion)
  return (await readEntry(tx, entryId))!
}

/** What the audit rows record of an entry: the whole record. */
export function audited(record: EntryRecord): Record<string, unknown> {
  const iso = (value: Date | null) => (value ? toUtcIso(value) : null)
  return {
    reference: record.reference,
    kind: record.kind,
    status: record.status,
    styleId: record.styleId,
    styleRevisionId: record.styleRevisionId,
    batchNumbers: [...record.batchNumbers],
    serials: [...record.serials],
    lotIds: [...record.lotIds],
    workOrderIds: [...record.workOrderIds],
    shipmentIds: [...record.shipmentIds],
    partyId: record.partyId,
    ownerId: record.ownerId,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    reportedAt: iso(record.reportedAt),
    description: record.description,
    investigation: record.investigation,
    risk: record.risk,
    actionTaken: record.actionTaken,
    actionCompletedAt: iso(record.actionCompletedAt),
    distributorsInformedAt: iso(record.distributorsInformedAt),
    authorityNotifiedAt: iso(record.authorityNotifiedAt),
    authorityReference: record.authorityReference,
    closedAt: iso(record.closedAt),
    closedById: record.closedById,
    closeReason: record.closeReason,
  }
}

const list = (values: readonly string[] | undefined) => (values === undefined ? undefined : [...values])

/** The columns a change writes (a field left undefined keeps its value; null clears it). */
const columnsOf = (changes: EntryChanges): Prisma.PpeRegisterEntryUncheckedUpdateInput =>
  Object.fromEntries(
    Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? [...(value as unknown[])] : value]),
  )

export interface WriteOptions {
  /** The audit action (`compliance.register.<what>`); default the command's name. */
  readonly action?: string
  readonly reason?: string
}

/** Inserts a new OPEN entry and records its audit row. */
export async function insertEntry(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, entry: NewEntry, options: WriteOptions = {}): Promise<EntryRecord> {
  const { tx, now } = tools
  const row = await tx.ppeRegisterEntry.create({
    data: {
      id: entry.id,
      companyId: entry.companyId,
      reference: entry.reference,
      kind: entry.kind,
      styleId: entry.styleId!,
      styleRevisionId: entry.styleRevisionId ?? null,
      batchNumbers: list(entry.batchNumbers) ?? [],
      serials: list(entry.serials) ?? [],
      lotIds: list(entry.lotIds) ?? [],
      workOrderIds: list(entry.workOrderIds) ?? [],
      shipmentIds: list(entry.shipmentIds) ?? [],
      partyId: entry.partyId ?? null,
      ownerId: entry.ownerId ?? null,
      sourceType: entry.sourceType ?? null,
      sourceId: entry.sourceId ?? null,
      reportedAt: entry.reportedAt,
      description: entry.description,
      investigation: entry.investigation ?? null,
      risk: entry.risk ?? 'ASSESSING',
      actionTaken: entry.actionTaken ?? null,
      actionCompletedAt: entry.actionCompletedAt ?? null,
      distributorsInformedAt: entry.distributorsInformedAt ?? null,
      authorityNotifiedAt: entry.authorityNotifiedAt ?? null,
      authorityReference: entry.authorityReference ?? null,
      createdAt: now,
      updatedAt: now,
      createdById: entry.createdById,
    },
    select: COLUMNS,
  })
  const record = recordOf(row)
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'PpeRegisterEntry', recordId: record.id, companyId: record.companyId, after: audited(record), ...(options.reason ? { reason: options.reason } : {}) })
  return record
}

/** Updates a LOCKED entry (lockEntry first), moves its version, and records the audit row (before and after). */
export async function updateEntry(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, before: EntryRecord, changes: EntryChanges, options: WriteOptions = {}): Promise<EntryRecord> {
  const { tx, now } = tools
  const row = await tx.ppeRegisterEntry.update({ where: { id: before.id }, data: { ...columnsOf(changes), updatedAt: now, version: { increment: 1 } }, select: COLUMNS })
  const after = recordOf(row)
  tools.audit({
    ...(options.action ? { action: options.action } : {}),
    recordType: 'PpeRegisterEntry',
    recordId: before.id,
    companyId: before.companyId,
    before: audited(before),
    after: audited(after),
    ...(options.reason ? { reason: options.reason } : {}),
  })
  return after
}

/**
 * The entry's reference: the next number of the company's PPE_REGISTER series for the year of the report day
 * (`REG-{YYYY}-{N:4}` in the seed), taken inside the writing command (the series row's lock; no gap, never twice). No
 * series → 404 in words (an admin sets one up under numbering).
 */
export async function nextReference(tools: Pick<CommandTools, 'tx' | 'context' | 'now' | 'audit'>, companyId: string, reportedAt: Date, entryId: string): Promise<string> {
  const issued = await allocateNumber(tools, { companyId, kind: 'PPE_REGISTER' }, { type: 'PpeRegisterEntry', id: entryId, date: businessDate(reportedAt) })
  return issued.formatted
}
