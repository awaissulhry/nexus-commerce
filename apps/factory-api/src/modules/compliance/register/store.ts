import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { formatReference, referenceNumber, type RegisterKind, type RegisterRisk, type RegisterSourceType, type RegisterStatus } from '@nexus/factory-domain/compliance/register/rules'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'

/**
 * The PPE register's ONE storage seam (B-W1-43). Everything the module reads or writes of a PpeRegisterEntry goes
 * through here, so the schema step that gives the register its missing columns changes this file alone.
 *
 * INTERIM — until that schema step (lead's plan: risk enum, authorityReference, closeReason, actionCompletedAt, ownerId,
 * sourceType/sourceId, the structured concern (styleRevisionId, lotIds, workOrderIds, shipmentIds), NumberKind PPE_REGISTER): the facts the table has no column for yet live
 * in the entry's own audit rows. Every write here records the entry's WHOLE record as the audit row's `after` (with
 * those facts under `extra`), so the newest audit row of the entry holds them; an entry no audit row describes (one a
 * seed wrote) has the defaults (risk ASSESSING, nothing else). The reference comes from `nextReference` (an advisory
 * lock per company, the year's highest REG number + 1; the unique key backs it), until the numbering module issues
 * PPE_REGISTER numbers.
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
  batchNumbers: true,
  serials: true,
  partyId: true,
  reportedAt: true,
  description: true,
  investigation: true,
  actionTaken: true,
  distributorsInformedAt: true,
  authorityNotifiedAt: true,
  closedAt: true,
  closedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PpeRegisterEntrySelect
type Row = Prisma.PpeRegisterEntryGetPayload<{ select: typeof COLUMNS }>

// ---- INTERIM: the facts without a column, in the entry's audit rows ------------------------------------------------------

interface Extra {
  readonly styleRevisionId: string | null
  readonly lotIds: readonly string[]
  readonly workOrderIds: readonly string[]
  readonly shipmentIds: readonly string[]
  readonly ownerId: string | null
  readonly sourceType: RegisterSourceType | null
  readonly sourceId: string | null
  readonly risk: RegisterRisk
  readonly actionCompletedAt: Date | null
  readonly authorityReference: string | null
  readonly closeReason: string | null
}
const NO_EXTRA: Extra = Object.freeze({
  styleRevisionId: null,
  lotIds: [],
  workOrderIds: [],
  shipmentIds: [],
  ownerId: null,
  sourceType: null,
  sourceId: null,
  risk: 'ASSESSING',
  actionCompletedAt: null,
  authorityReference: null,
  closeReason: null,
})
const EXTRA_KEYS = Object.keys(NO_EXTRA) as (keyof Extra)[]

const AUDIT_ACTIONS = 'compliance.register.'
type Stored = Record<string, unknown>
const date = (value: unknown): Date | null => (typeof value === 'string' ? new Date(value) : null)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

function extraFrom(after: unknown): Extra {
  const stored = (after as { extra?: Stored } | null)?.extra
  if (!stored || typeof stored !== 'object') return NO_EXTRA
  return {
    styleRevisionId: text(stored.styleRevisionId),
    lotIds: strings(stored.lotIds),
    workOrderIds: strings(stored.workOrderIds),
    shipmentIds: strings(stored.shipmentIds),
    ownerId: text(stored.ownerId),
    sourceType: text(stored.sourceType) as RegisterSourceType | null,
    sourceId: text(stored.sourceId),
    risk: (text(stored.risk) as RegisterRisk | null) ?? 'ASSESSING',
    actionCompletedAt: date(stored.actionCompletedAt),
    authorityReference: text(stored.authorityReference),
    closeReason: text(stored.closeReason),
  }
}

async function extrasOf(client: Client, ids: readonly string[]): Promise<Map<string, Extra>> {
  if (ids.length === 0) return new Map()
  const rows = await client.auditLog.findMany({
    where: { recordType: 'PpeRegisterEntry', recordId: { in: [...ids] }, action: { startsWith: AUDIT_ACTIONS } },
    select: { recordId: true, after: true },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    distinct: ['recordId'],
  })
  return new Map(rows.map((row) => [row.recordId, extraFrom(row.after)]))
}

const recordOf = (row: Row, extra: Extra): EntryRecord => ({ ...row, ...extra })

// ---- reads ---------------------------------------------------------------------------------------------------------------

export async function readEntry(client: Client, entryId: string): Promise<EntryRecord | null> {
  const row = await client.ppeRegisterEntry.findUnique({ where: { id: entryId }, select: COLUMNS })
  if (!row) return null
  return recordOf(row, (await extrasOf(client, [row.id])).get(row.id) ?? NO_EXTRA)
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
      filter.styleId ? { styleId: filter.styleId } : {},
      filter.companyId ? { companyId: filter.companyId } : {},
      filter.from ? { reportedAt: { gte: filter.from } } : {},
      filter.to ? { reportedAt: { lt: filter.to } } : {},
      filter.search
        ? { OR: [{ reference: { contains: filter.search, mode: 'insensitive' } }, { description: { contains: filter.search, mode: 'insensitive' } }] }
        : {},
    ],
  }
  // INTERIM: risk is not a column yet; the page is read whole and filtered here.
  const rows = await client.ppeRegisterEntry.findMany({
    where,
    select: COLUMNS,
    orderBy: [{ reportedAt: 'desc' }, { reference: 'desc' }, { id: 'asc' }],
    take: filter.risk ? undefined : filter.limit,
  })
  const extras = await extrasOf(client, rows.map((row) => row.id))
  const records = rows.map((row) => recordOf(row, extras.get(row.id) ?? NO_EXTRA))
  return (filter.risk ? records.filter((record) => record.risk === filter.risk) : records).slice(0, filter.limit)
}

// ---- writes (inside the caller's command) --------------------------------------------------------------------------------

/** Locks the entry's row (FOR UPDATE) and reads it, checking the version the caller read. */
export async function lockEntry(tx: CommandTx, entryId: string, expectedVersion?: number): Promise<EntryRecord> {
  const locked = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM "PpeRegisterEntry" WHERE id = ${entryId}::uuid FOR UPDATE`
  if (!locked[0]) throw new NotFoundError('Register entry not found.')
  if (expectedVersion !== undefined && expectedVersion !== locked[0].version) throw new StaleVersionError('PpeRegisterEntry', entryId, locked[0].version, expectedVersion)
  return (await readEntry(tx, entryId))!
}

/** What the audit rows record of an entry: the whole record (INTERIM: the facts without a column under `extra`). */
export function audited(record: EntryRecord): Record<string, unknown> {
  const iso = (value: Date | null) => (value ? toUtcIso(value) : null)
  const extra = Object.fromEntries(EXTRA_KEYS.map((key) => [key, key === 'actionCompletedAt' ? iso(record.actionCompletedAt) : record[key]]))
  return {
    reference: record.reference,
    kind: record.kind,
    status: record.status,
    styleId: record.styleId,
    batchNumbers: [...record.batchNumbers],
    serials: [...record.serials],
    partyId: record.partyId,
    reportedAt: iso(record.reportedAt),
    description: record.description,
    investigation: record.investigation,
    actionTaken: record.actionTaken,
    distributorsInformedAt: iso(record.distributorsInformedAt),
    authorityNotifiedAt: iso(record.authorityNotifiedAt),
    closedAt: iso(record.closedAt),
    closedById: record.closedById,
    extra,
  }
}

const columnsOf = (changes: EntryChanges): Prisma.PpeRegisterEntryUncheckedUpdateInput => {
  const data: Prisma.PpeRegisterEntryUncheckedUpdateInput = {}
  if (changes.styleId !== undefined) data.styleId = changes.styleId
  if (changes.batchNumbers !== undefined) data.batchNumbers = [...changes.batchNumbers]
  if (changes.serials !== undefined) data.serials = [...changes.serials]
  if (changes.partyId !== undefined) data.partyId = changes.partyId
  if (changes.description !== undefined) data.description = changes.description
  if (changes.investigation !== undefined) data.investigation = changes.investigation
  if (changes.actionTaken !== undefined) data.actionTaken = changes.actionTaken
  if (changes.distributorsInformedAt !== undefined) data.distributorsInformedAt = changes.distributorsInformedAt
  if (changes.authorityNotifiedAt !== undefined) data.authorityNotifiedAt = changes.authorityNotifiedAt
  if (changes.status !== undefined) data.status = changes.status
  if (changes.closedAt !== undefined) data.closedAt = changes.closedAt
  if (changes.closedById !== undefined) data.closedById = changes.closedById
  return data
}

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
      batchNumbers: [...(entry.batchNumbers ?? [])],
      serials: [...(entry.serials ?? [])],
      partyId: entry.partyId ?? null,
      reportedAt: entry.reportedAt,
      description: entry.description,
      investigation: entry.investigation ?? null,
      actionTaken: entry.actionTaken ?? null,
      distributorsInformedAt: entry.distributorsInformedAt ?? null,
      authorityNotifiedAt: entry.authorityNotifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
      createdById: entry.createdById,
    },
    select: COLUMNS,
  })
  const record = recordOf(row, {
    ...NO_EXTRA,
    styleRevisionId: entry.styleRevisionId ?? null,
    lotIds: [...(entry.lotIds ?? [])],
    workOrderIds: [...(entry.workOrderIds ?? [])],
    shipmentIds: [...(entry.shipmentIds ?? [])],
    ownerId: entry.ownerId ?? null,
    sourceType: entry.sourceType ?? null,
    sourceId: entry.sourceId ?? null,
    risk: entry.risk ?? 'ASSESSING',
    actionCompletedAt: entry.actionCompletedAt ?? null,
    authorityReference: entry.authorityReference ?? null,
  })
  tools.audit({ ...(options.action ? { action: options.action } : {}), recordType: 'PpeRegisterEntry', recordId: record.id, companyId: record.companyId, after: audited(record), ...(options.reason ? { reason: options.reason } : {}) })
  return record
}

/** Updates a LOCKED entry (lockEntry first), moves its version, and records the audit row (before and after). */
export async function updateEntry(tools: Pick<CommandTools, 'tx' | 'audit' | 'now'>, before: EntryRecord, changes: EntryChanges, options: WriteOptions = {}): Promise<EntryRecord> {
  const { tx, now } = tools
  const row = await tx.ppeRegisterEntry.update({ where: { id: before.id }, data: { ...columnsOf(changes), updatedAt: now, version: { increment: 1 } }, select: COLUMNS })
  const extra: Extra = Object.fromEntries(EXTRA_KEYS.map((key) => [key, changes[key as keyof EntryChanges] !== undefined ? changes[key as keyof EntryChanges] : before[key]])) as unknown as Extra
  const after = recordOf(row, extra)
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
 * The entry's reference (INTERIM, until NumberKind PPE_REGISTER): `REG-<year of the report day>-<n>`, n = the year's
 * highest number in the company + 1, under an advisory lock per company (two first entries of a year wait for each
 * other; the unique key (tenant, company, reference) backs it).
 */
export async function nextReference(tools: Pick<CommandTools, 'tx' | 'context'>, companyId: string, reportedAt: Date): Promise<string> {
  const { tx, context } = tools
  if (context.audience === 'platform') throw new NotFoundError('Register entry not found.')
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ppe-register', ${context.tenantId}::uuid, ${companyId}::uuid), 0))`
  const year = businessDate(reportedAt).slice(0, 4)
  const rows = await tx.ppeRegisterEntry.findMany({ where: { companyId, reference: { startsWith: `REG-${year}-` } }, select: { reference: true } })
  const highest = rows.reduce((max, row) => Math.max(max, referenceNumber(row.reference, year) ?? 0), 0)
  return formatReference(year, highest + 1)
}
