import type { Prisma } from '@nexus/factory-db'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { FLOOR_DISCARD_REASON } from '@nexus/factory-domain/floor-sync/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { discardForModuleRefusal } from '../../../platform/floor-sync/store'
import type { Reader } from './store'

/**
 * THE seam of the floor's refused scans (B-W1-42 server side of A1 §3.8 and PLAN risk 17: "refused actions are kept and
 * shown"; data of SCR-023, the sync queue, B-W0-30; design floor.sync "Refused, with a fix"): the FloorScanRefusal rows.
 * Every scan a device's offline queue sent that the server refused, with its code, words, one fix, whether it may pass
 * when sent again, what was sent and when (device and server time), once per device × client scan id × code (the unique
 * key). The device keeps its own (a floor command); a refusal is open until the device's discard (or the office's), or
 * until the same client scan id is accepted later: the scan (or correction request) command marks it resolved
 * (`resolveRefusals`). The …_production_scan_records_guards trigger keeps what was sent fixed and each close once.
 */

export const REFUSED_ACTIONS = ['REPORT', 'UNDO', 'ASK_CORRECTION'] as const

/** Why a refused scan discarded in the office's refused scans list left the floor sync's open list too. */
const SCAN_OFFICE_DISCARD_REASON = 'Discarded in the office, in the refused scans list.'
export type RefusedAction = (typeof REFUSED_ACTIONS)[number]

export interface FloorScanRefusal {
  readonly id: string
  readonly companyId: string | null
  readonly siteId: string
  readonly deviceId: string
  readonly clientScanId: string
  readonly action: RefusedAction
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly final: boolean
  readonly workOrderId: string | null
  readonly bundleId: string | null
  readonly workOrderOperationId: string | null
  /** The code the device read, as sent. */
  readonly scanned: string | null
  readonly goodQuantity: number
  readonly scrapQuantity: number
  readonly reworkQuantity: number
  /** The signed-in worker who sent it (a site that names workers); null at a site that records the station only. */
  readonly workerId: string | null
  readonly stationId: string | null
  readonly deviceTime: string | null
  readonly serverTime: string
  readonly discardedAt: string | null
  readonly discardedById: string | null
  readonly version: number
}

export type RefusalDraft = Omit<FloorScanRefusal, 'id' | 'serverTime' | 'discardedAt' | 'discardedById' | 'version'>

export interface RefusalState extends FloorScanRefusal {
  /** The scan the same client scan id became when sent again and accepted, or null. */
  readonly resolvedByScanId: string | null
  /** The correction request it became (an ask sent again), or null. */
  readonly resolvedByRequestId: string | null
}

const COLUMNS = {
  id: true,
  siteId: true,
  deviceId: true,
  clientScanId: true,
  action: true,
  code: true,
  message: true,
  fix: true,
  final: true,
  workOrderId: true,
  bundleId: true,
  workOrderOperationId: true,
  scanned: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  workerId: true,
  stationId: true,
  deviceTime: true,
  serverTime: true,
  discardedAt: true,
  discardedById: true,
  resolvedByScanId: true,
  resolvedByRequestId: true,
  version: true,
} as const satisfies Prisma.FloorScanRefusalSelect

type Row = Prisma.FloorScanRefusalGetPayload<{ select: typeof COLUMNS }>

const at = (value: Date | null) => (value ? toUtcIso(value) : null)

async function statesOf(db: Reader, rows: readonly Row[]): Promise<RefusalState[]> {
  if (rows.length === 0) return []
  const companies = new Map((await db.site.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.siteId))] } }, select: { id: true, companyId: true } })).map((row) => [row.id, row.companyId]))
  return rows.map((row) => ({ ...row, companyId: companies.get(row.siteId) ?? null, deviceTime: at(row.deviceTime), serverTime: toUtcIso(row.serverTime), discardedAt: at(row.discardedAt) }))
}

/** The refusal already kept for this device, client scan id and code; thrown to roll an empty command back. */
class Recorded extends Error {
  constructor(readonly row: RefusalState) {
    super('recorded already')
  }
}

const findKept = async (db: Reader, draft: Pick<RefusalDraft, 'deviceId' | 'clientScanId' | 'code'>) => {
  const row = await db.floorScanRefusal.findFirst({ where: { deviceId: draft.deviceId, clientScanId: draft.clientScanId, code: draft.code }, select: COLUMNS })
  return row ? ((await statesOf(db, [row]))[0] ?? null) : null
}

/**
 * Keeps a refusal (once per device, client scan id and code) and announces it (production.scan_refused): a floor command
 * of the device that sent it, keyed by the device, the client scan id and the code (a resend answers the same row).
 */
export async function recordRefusal(caller: CommandCaller, draft: RefusalDraft): Promise<FloorScanRefusal> {
  const known = await caller.withClient((client) => findKept(client, draft))
  if (known) return known
  try {
    const { result } = await command(caller, { name: 'production.recordScanRefusal', idempotencyKey: `r.${draft.deviceId}.${draft.clientScanId}.${draft.code}`, input: draft }, async (tools) => {
      const id = newId()
      const { count } = await tools.tx.floorScanRefusal.createMany({
        data: [
          {
            id,
            siteId: draft.siteId,
            deviceId: draft.deviceId,
            clientScanId: draft.clientScanId,
            action: draft.action,
            code: draft.code,
            message: draft.message,
            fix: draft.fix,
            final: draft.final,
            workOrderId: draft.workOrderId,
            bundleId: draft.bundleId,
            workOrderOperationId: draft.workOrderOperationId,
            scanned: draft.scanned,
            goodQuantity: draft.goodQuantity,
            scrapQuantity: draft.scrapQuantity,
            reworkQuantity: draft.reworkQuantity,
            workerId: draft.workerId,
            stationId: draft.stationId,
            deviceTime: draft.deviceTime ? new Date(draft.deviceTime) : null,
            serverTime: tools.now,
            createdById: draft.workerId,
            createdAt: tools.now,
            updatedAt: tools.now,
          },
        ],
        skipDuplicates: true,
      })
      // Kept by a request that raced this one: answer that row (nothing written here).
      if (count === 0) throw new Recorded((await findKept(tools.tx, draft))!)
      const row = (await findKept(tools.tx, draft))!
      tools.audit({ action: 'production.recordScanRefusal', recordType: 'FloorScanRefusal', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { ...draft }, reason: row.message })
      tools.emit({
        type: 'production.scan_refused',
        subject: row.workOrderId ?? row.deviceId,
        companyId: row.companyId,
        siteId: row.siteId,
        payload: { refusalId: row.id, deviceId: row.deviceId, code: row.code, final: row.final, workOrderId: row.workOrderId, bundleId: row.bundleId },
      })
      return row
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row
    throw error
  }
}

/** Marks the device's open refusals of this client scan id resolved by the scan or request it became (inside that command). */
export async function resolveRefusals(tx: CommandTx, now: Date, by: { readonly deviceId: string; readonly clientScanId: string } & ({ readonly scanId: string } | { readonly requestId: string })): Promise<number> {
  const resolved = 'scanId' in by ? { resolvedByScanId: by.scanId } : { resolvedByRequestId: by.requestId }
  const open = 'scanId' in by ? { resolvedByScanId: null } : { resolvedByRequestId: null }
  const { count } = await tx.floorScanRefusal.updateMany({ where: { deviceId: by.deviceId, clientScanId: by.clientScanId, ...open }, data: { ...resolved, version: { increment: 1 }, updatedAt: now } })
  return count
}

export interface RefusalFilter {
  readonly siteIds?: readonly string[]
  readonly deviceId?: string
  readonly workOrderId?: string
  /** Only the open ones: not discarded, not resolved. */
  readonly open?: boolean
}

/** The refusals that match, with what resolved them, newest first, in the caller's scope. */
export async function readRefusals(db: Reader, filter: RefusalFilter = {}): Promise<RefusalState[]> {
  const rows = await db.floorScanRefusal.findMany({
    where: {
      ...(filter.siteIds ? { siteId: { in: [...filter.siteIds] } } : {}),
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter.workOrderId ? { workOrderId: filter.workOrderId } : {}),
      ...(filter.open ? { discardedAt: null, resolvedByScanId: null, resolvedByRequestId: null } : {}),
    },
    select: COLUMNS,
    orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
  })
  return statesOf(db, rows)
}

/** One refusal with what resolved it, or null, in the caller's scope. */
export async function readRefusal(db: Reader, refusalId: string): Promise<RefusalState | null> {
  if (!isUuid(refusalId)) return null
  const row = await db.floorScanRefusal.findUnique({ where: { id: refusalId }, select: COLUMNS })
  return row ? ((await statesOf(db, [row]))[0] ?? null) : null
}

/**
 * Discards a refusal (the device's "Discard": it will not be recorded; the team leader sees that it was), once: a
 * discarded one is answered as it is. `caller`: the device that sent it, or the office; `by`: who discarded (the worker
 * at a site that names workers, the office user; null at a site that records the station only) and why. The floor sync's
 * refused action of the same scan (platform/floor-sync, B-W0-30) is discarded in the same command.
 */
export async function discardRefusal(caller: CommandCaller, refusal: RefusalState, by: { readonly discardedById: string | null; readonly idempotencyKey?: string | undefined; readonly reason?: string | undefined }): Promise<RefusalState> {
  if (refusal.discardedAt) return refusal
  try {
    const { result } = await command(caller, { name: 'production.discardScanRefusal', idempotencyKey: by.idempotencyKey, input: { refusalId: refusal.id, discardedById: by.discardedById } }, async (tools) => {
      await tools.tx.$queryRaw`SELECT "id" FROM "FloorScanRefusal" WHERE "id" = ${refusal.id}::uuid FOR UPDATE`
      const current = (await readRefusal(tools.tx, refusal.id))!
      if (current.discardedAt) throw new Recorded(current)
      const { count } = await tools.tx.floorScanRefusal.updateMany({ where: { id: current.id, version: current.version, discardedAt: null }, data: { discardedAt: tools.now, discardedById: by.discardedById, version: current.version + 1, updatedAt: tools.now } })
      if (count !== 1) throw new StaleVersionError('FloorScanRefusal', current.id, current.version + 1, current.version)
      const row = (await readRefusal(tools.tx, current.id))!
      tools.audit({ action: 'production.discardScanRefusal', recordType: 'FloorScanRefusal', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { discardedAt: null, version: current.version }, after: { discardedAt: row.discardedAt, discardedById: row.discardedById, version: row.version }, ...(by.reason ? { reason: by.reason } : {}) })
      const audience = tools.context.audience === 'floor' ? 'FLOOR' : 'OFFICE'
      await discardForModuleRefusal(tools, { type: 'FloorScanRefusal', id: row.id }, { discardedById: by.discardedById, discardedBy: audience, reason: by.reason ?? (audience === 'FLOOR' ? FLOOR_DISCARD_REASON : SCAN_OFFICE_DISCARD_REASON) })
      return row
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row
    throw error
  }
}
