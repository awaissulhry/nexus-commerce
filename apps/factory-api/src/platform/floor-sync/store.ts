import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventSummary } from '@nexus/factory-domain/floor-sync/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'

/**
 * THE seam of the floor sync's two tables (B-W0-30; factory-db floor-sync.prisma): the per-device sync ledger
 * (FloorSyncEvent, append-only) and the refused actions (FloorRefusedAction). Every write is a command of the tablet
 * that sent the event (floor), or of the office (a discard); the …_floor_sync_guards triggers stay the last word.
 */

export type Reader = Pick<FactoryClient, 'floorSyncEvent' | 'floorRefusedAction'> | Pick<CommandTx, 'floorSyncEvent' | 'floorRefusedAction'>

// ---- the ledger --------------------------------------------------------------------------------------------------------------------

export interface LedgerRow {
  readonly id: string
  readonly siteId: string
  readonly deviceId: string
  readonly clientEventId: string
  readonly kind: string
  readonly deviceSeq: number
  readonly deviceTime: string | null
  readonly serverTime: string
  readonly clockSkewSeconds: number | null
  readonly outcome: 'ACCEPTED' | 'DUPLICATE'
  readonly resultType: string
  readonly resultId: string
}

const LEDGER = {
  id: true,
  siteId: true,
  deviceId: true,
  clientEventId: true,
  kind: true,
  deviceSeq: true,
  deviceTime: true,
  serverTime: true,
  clockSkewSeconds: true,
  outcome: true,
  resultType: true,
  resultId: true,
} as const satisfies Prisma.FloorSyncEventSelect

const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

function ledgerRow(row: Prisma.FloorSyncEventGetPayload<{ select: typeof LEDGER }>): LedgerRow {
  return { ...row, deviceTime: at(row.deviceTime), serverTime: toUtcIso(row.serverTime) }
}

/** The tablet's recorded events among these client event ids. */
export async function readLedger(db: Reader, deviceId: string, clientEventIds: readonly string[]): Promise<Map<string, LedgerRow>> {
  if (clientEventIds.length === 0) return new Map()
  const rows = await db.floorSyncEvent.findMany({ where: { deviceId, clientEventId: { in: [...clientEventIds] } }, select: LEDGER })
  return new Map(rows.map((row) => [row.clientEventId, ledgerRow(row)]))
}

/** The tablet's last recorded event's server time ("last sent"), or null. */
export async function lastRecordedAt(db: Reader, deviceId: string): Promise<string | null> {
  const row = await db.floorSyncEvent.findFirst({ where: { deviceId }, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }], select: { serverTime: true } })
  return row ? toUtcIso(row.serverTime) : null
}

export interface LedgerDraft {
  readonly companyId: string
  readonly siteId: string
  readonly deviceId: string
  readonly clientEventId: string
  readonly kind: string
  readonly deviceSeq: number
  readonly deviceTime: string | null
  readonly clockSkewSeconds: number | null
  readonly outcome: 'ACCEPTED' | 'DUPLICATE'
  readonly resultType: string
  readonly resultId: string
}

/** The event is in the ledger already (a send that raced this one): its row; thrown to roll the empty command back. */
class Recorded<Row> extends Error {
  constructor(readonly row: Row) {
    super('recorded already')
  }
}

/**
 * floorsync.recordEvent — the tablet's event is recorded: one ledger row (once per device and client event id: a send
 * that raced this one answers the row it wrote) and its open refused actions marked RESOLVED by it, in one command.
 */
export async function recordEvent(caller: CommandCaller, draft: LedgerDraft): Promise<LedgerRow> {
  const known = (await caller.withClient((client) => readLedger(client, draft.deviceId, [draft.clientEventId]))).get(draft.clientEventId)
  if (known) return known
  try {
    const { result } = await command(caller, { name: 'floorsync.recordEvent', idempotencyKey: `fs.e.${draft.deviceId}.${draft.clientEventId}`, input: draft, ...(draft.deviceTime ? { deviceTime: new Date(draft.deviceTime) } : {}) }, async (tools) => {
      const id = newId()
      const { count } = await tools.tx.floorSyncEvent.createMany({
        data: [
          {
            id,
            siteId: draft.siteId,
            deviceId: draft.deviceId,
            clientEventId: draft.clientEventId,
            kind: draft.kind,
            deviceSeq: draft.deviceSeq,
            deviceTime: draft.deviceTime ? new Date(draft.deviceTime) : null,
            serverTime: tools.now,
            clockSkewSeconds: draft.clockSkewSeconds,
            outcome: draft.outcome,
            resultType: draft.resultType,
            resultId: draft.resultId,
            requestId: tools.context.requestId,
            createdAt: tools.now,
          },
        ],
        skipDuplicates: true,
      })
      if (count === 0) throw new Recorded((await readLedger(tools.tx, draft.deviceId, [draft.clientEventId])).get(draft.clientEventId)!)
      const row = (await readLedger(tools.tx, draft.deviceId, [draft.clientEventId])).get(draft.clientEventId)!
      tools.audit({ recordType: 'FloorSyncEvent', recordId: row.id, companyId: draft.companyId, siteId: draft.siteId, after: { ...draft } })
      // The same event refused before (it was sent again and passed): its refused actions are resolved by this row.
      const open = await tools.tx.floorRefusedAction.findMany({ where: { deviceId: draft.deviceId, clientEventId: draft.clientEventId, status: 'OPEN' }, select: { id: true, version: true } })
      for (const refused of open) {
        await tools.tx.floorRefusedAction.update({ where: { id: refused.id }, data: { status: 'RESOLVED', resolvedByEventId: row.id, resolvedAt: tools.now, version: refused.version + 1, updatedAt: tools.now }, select: { id: true } })
        tools.audit({ action: 'floorsync.resolveRefused', recordType: 'FloorRefusedAction', recordId: refused.id, companyId: draft.companyId, siteId: draft.siteId, before: { status: 'OPEN' }, after: { status: 'RESOLVED', resolvedByEventId: row.id } })
        tools.emit({ type: 'floor.refused_action_closed', subject: refused.id, companyId: draft.companyId, siteId: draft.siteId, payload: { refusedId: refused.id, deviceId: draft.deviceId, status: 'RESOLVED', by: 'SYSTEM' } })
      }
      return row
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row as LedgerRow
    // Two sends at once: the unique key refused this one after the other committed; its row is the answer.
    const raced = (await caller.withClient((client) => readLedger(client, draft.deviceId, [draft.clientEventId])).catch(() => new Map<string, LedgerRow>())).get(draft.clientEventId)
    if (raced) return raced
    throw error
  }
}

// ---- refused actions ------------------------------------------------------------------------------------------------------------

export type RefusedStatus = 'OPEN' | 'RESOLVED' | 'DISCARDED'

export interface RefusedRow {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly deviceId: string
  readonly clientEventId: string
  readonly kind: string
  readonly deviceSeq: number
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly final: boolean
  readonly summary: EventSummary
  readonly payload: unknown
  readonly moduleRefusal: { readonly type: string; readonly id: string } | null
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceTime: string | null
  readonly serverTime: string
  readonly status: RefusedStatus
  readonly resolvedByEventId: string | null
  readonly resolvedAt: string | null
  readonly discardedAt: string | null
  readonly discardedById: string | null
  readonly discardedBy: 'FLOOR' | 'OFFICE' | null
  readonly discardReason: string | null
  readonly version: number
}

const REFUSED = {
  id: true,
  companyId: true,
  siteId: true,
  deviceId: true,
  clientEventId: true,
  kind: true,
  deviceSeq: true,
  code: true,
  message: true,
  fix: true,
  final: true,
  summary: true,
  payload: true,
  moduleRefusalType: true,
  moduleRefusalId: true,
  workerId: true,
  stationId: true,
  deviceTime: true,
  serverTime: true,
  status: true,
  resolvedByEventId: true,
  resolvedAt: true,
  discardedAt: true,
  discardedById: true,
  discardedBy: true,
  discardReason: true,
  version: true,
} as const satisfies Prisma.FloorRefusedActionSelect

function refusedRow(row: Prisma.FloorRefusedActionGetPayload<{ select: typeof REFUSED }>): RefusedRow {
  const { moduleRefusalType, moduleRefusalId, ...rest } = row
  return {
    ...rest,
    summary: (row.summary ?? {}) as EventSummary,
    moduleRefusal: moduleRefusalType && moduleRefusalId ? { type: moduleRefusalType, id: moduleRefusalId } : null,
    deviceTime: at(row.deviceTime),
    serverTime: toUtcIso(row.serverTime),
    resolvedAt: at(row.resolvedAt),
    discardedAt: at(row.discardedAt),
  }
}

export interface RefusedFilter {
  /** Where-clause of the caller's scope (the office: scopeWhere over company and site). */
  readonly scope?: Prisma.FloorRefusedActionWhereInput
  readonly siteId?: string
  readonly deviceId?: string
  readonly kind?: string
  readonly status?: RefusedStatus
  readonly clientEventIds?: readonly string[]
  readonly limit?: number
}

/** Refused actions, newest first, in the caller's scope. */
export async function readRefused(db: Reader, filter: RefusedFilter = {}): Promise<RefusedRow[]> {
  const where: Prisma.FloorRefusedActionWhereInput = {
    AND: [
      filter.scope ?? {},
      {
        ...(filter.siteId ? { siteId: filter.siteId } : {}),
        ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.clientEventIds ? { clientEventId: { in: [...filter.clientEventIds] } } : {}),
      },
    ],
  }
  const rows = await db.floorRefusedAction.findMany({ where, select: REFUSED, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }], ...(filter.limit ? { take: filter.limit } : {}) })
  return rows.map(refusedRow)
}

/** One refused action in the caller's scope, or null. */
export async function readRefusedOne(db: Reader, refusedId: string): Promise<RefusedRow | null> {
  if (!isUuid(refusedId)) return null
  const row = await db.floorRefusedAction.findUnique({ where: { id: refusedId }, select: REFUSED })
  return row ? refusedRow(row) : null
}

export interface RefusedDraft {
  readonly companyId: string
  readonly siteId: string
  readonly deviceId: string
  readonly clientEventId: string
  readonly kind: string
  readonly deviceSeq: number
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly final: boolean
  readonly summary: EventSummary
  readonly payload: unknown
  readonly moduleRefusal: { readonly type: string; readonly id: string } | null
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceTime: string | null
}

const findKept = async (db: Reader, draft: Pick<RefusedDraft, 'deviceId' | 'clientEventId' | 'code'>): Promise<RefusedRow | null> => {
  const row = await db.floorRefusedAction.findFirst({ where: { deviceId: draft.deviceId, clientEventId: draft.clientEventId, code: draft.code }, select: REFUSED })
  return row ? refusedRow(row) : null
}

/**
 * floorsync.recordRefused — keeps a refused action (once per device, client event id and code) and announces it
 * (floor.action_refused): a command of the tablet that sent it. A refusal kept before (the same code) answers that row.
 */
export async function recordRefused(caller: CommandCaller, draft: RefusedDraft): Promise<RefusedRow> {
  const known = await caller.withClient((client) => findKept(client, draft))
  if (known) return known
  try {
    const { result } = await command(caller, { name: 'floorsync.recordRefused', idempotencyKey: `fs.r.${draft.deviceId}.${draft.clientEventId}.${draft.code}`.slice(0, 128), input: draft }, async (tools) => {
      const { count } = await tools.tx.floorRefusedAction.createMany({
        data: [
          {
            id: newId(),
            companyId: draft.companyId,
            siteId: draft.siteId,
            deviceId: draft.deviceId,
            clientEventId: draft.clientEventId,
            kind: draft.kind,
            deviceSeq: draft.deviceSeq,
            code: draft.code,
            message: draft.message,
            fix: draft.fix,
            final: draft.final,
            summary: draft.summary as Prisma.InputJsonValue,
            payload: (draft.payload ?? {}) as Prisma.InputJsonValue,
            moduleRefusalType: draft.moduleRefusal?.type ?? null,
            moduleRefusalId: draft.moduleRefusal?.id ?? null,
            workerId: draft.workerId,
            stationId: draft.stationId,
            deviceTime: draft.deviceTime ? new Date(draft.deviceTime) : null,
            serverTime: tools.now,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: draft.workerId,
          },
        ],
        skipDuplicates: true,
      })
      if (count === 0) throw new Recorded((await findKept(tools.tx, draft))!)
      const row = (await findKept(tools.tx, draft))!
      tools.audit({ recordType: 'FloorRefusedAction', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { kind: draft.kind, clientEventId: draft.clientEventId, deviceSeq: draft.deviceSeq, code: draft.code, final: draft.final, summary: draft.summary }, reason: draft.message })
      tools.emit({ type: 'floor.action_refused', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { refusedId: row.id, deviceId: row.deviceId, kind: row.kind, code: row.code, final: row.final } })
      return row
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row as RefusedRow
    const raced = await caller.withClient((client) => findKept(client, draft)).catch(() => null)
    if (raced) return raced
    throw error
  }
}

export interface Discard {
  /** The worker (a site that names workers), the office user; null: a station's tablet. */
  readonly discardedById: string | null
  readonly discardedBy: 'FLOOR' | 'OFFICE'
  readonly reason: string
}

/** Inside a command: the open refused action is discarded (version-guarded), audited and announced. */
export async function discardInCommand(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, row: Pick<RefusedRow, 'id' | 'companyId' | 'siteId' | 'deviceId' | 'version' | 'status'>, discard: Discard): Promise<void> {
  const { count } = await tools.tx.floorRefusedAction.updateMany({
    where: { id: row.id, version: row.version, status: 'OPEN' },
    data: { status: 'DISCARDED', discardedAt: tools.now, discardedById: discard.discardedById, discardedBy: discard.discardedBy, discardReason: discard.reason, version: row.version + 1, updatedAt: tools.now },
  })
  if (count !== 1) throw new StaleVersionError('FloorRefusedAction', row.id, row.version + 1, row.version)
  tools.audit({ action: 'floorsync.discardRefused', recordType: 'FloorRefusedAction', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'OPEN', version: row.version }, after: { status: 'DISCARDED', discardedBy: discard.discardedBy, discardedById: discard.discardedById, version: row.version + 1 }, reason: discard.reason })
  tools.emit({ type: 'floor.refused_action_closed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { refusedId: row.id, deviceId: row.deviceId, status: 'DISCARDED', by: discard.discardedBy } })
}

/**
 * A module discarded its own record of a refusal (a scan's FloorScanRefusal, from its own screens or through the floor
 * sync): the refused actions that name it are discarded with it, inside the module's command. Called by the module.
 */
export async function discardForModuleRefusal(tools: Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>, moduleRefusal: { readonly type: string; readonly id: string }, discard: Discard): Promise<number> {
  const rows = await tools.tx.floorRefusedAction.findMany({ where: { moduleRefusalType: moduleRefusal.type, moduleRefusalId: moduleRefusal.id, status: 'OPEN' }, select: { id: true, companyId: true, siteId: true, deviceId: true, version: true, status: true } })
  for (const row of rows) await discardInCommand(tools, row, discard)
  return rows.length
}

/** floorsync.discardRefused — the refused action is discarded (once; a discarded one answers as it is). */
export async function discardRefused(caller: CommandCaller, row: RefusedRow, discard: Discard, idempotencyKey: string | undefined): Promise<RefusedRow> {
  if (row.status !== 'OPEN') return row
  try {
    const { result } = await command(caller, { name: 'floorsync.discardRefused', idempotencyKey, input: { refusedId: row.id, version: row.version, ...discard } }, async (tools) => {
      await tools.tx.$queryRaw`SELECT "id" FROM "FloorRefusedAction" WHERE "id" = ${row.id}::uuid FOR UPDATE`
      const current = (await readRefusedOne(tools.tx, row.id))!
      if (current.status !== 'OPEN') throw new Recorded(current)
      await discardInCommand(tools, current, discard)
      return (await readRefusedOne(tools.tx, row.id))!
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row as RefusedRow
    throw error
  }
}
