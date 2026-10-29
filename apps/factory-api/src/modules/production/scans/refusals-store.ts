import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../../core/command'
import { readCorrectionRequests } from './corrections-store'
import type { Reader } from './store'

/**
 * THE seam of the floor's refused scans (B-W1-42 server side of A1 §3.8 and PLAN risk 17: "refused actions are kept and
 * shown"; data of SCR-023, the sync queue, B-W0-30; design floor.sync "Refused, with a fix"): every scan a device's
 * offline queue sent that the server refused, with its code, words, one fix, whether it may pass when sent again, what
 * was sent and when (device and server time), once per device × client scan id × code. A refusal is open until the
 * device's discard (or the office's), or until the same client scan id is accepted later (resolved: the scan, or the
 * correction request, it became).
 *
 * INTERIM (until the schema step, the lead's SCHEMA token): a refusal is the newest of its audit rows (recordType
 * FloorScanRefusal, the whole row in `after`), written by a command in the tenant's system context (the floor role reads
 * no audit rows, and the once-per-code check must read them), its site and company set on the row; "resolved" is read at
 * read time from the scans and requests. Then: the FloorScanRefusal table (unique per device, client scan id and code;
 * the floor inserts its own and discards them, the scan command marks resolvedByScanId). The signatures stay.
 */

export const REFUSED_ACTIONS = ['REPORT', 'UNDO', 'ASK_CORRECTION'] as const
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

const RECORD = 'FloorScanRefusal'

/** The refusal already on record for this device, client scan id and code; thrown to roll an empty command back. */
class Recorded extends Error {
  constructor(readonly row: FloorScanRefusal) {
    super('recorded already')
  }
}

function newest(rows: readonly { readonly recordId: string; readonly after: unknown }[]): FloorScanRefusal[] {
  const byId = new Map<string, FloorScanRefusal>()
  for (const row of rows) byId.set(row.recordId, row.after as FloorScanRefusal)
  return [...byId.values()]
}

async function rowsOf(db: Reader, where: { readonly siteIds?: readonly string[]; readonly recordId?: string }) {
  return db.auditLog.findMany({
    where: { recordType: RECORD, ...(where.siteIds ? { siteId: { in: [...where.siteIds] } } : {}), ...(where.recordId ? { recordId: where.recordId } : {}) },
    select: { recordId: true, after: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
}

const findRecorded = async (db: Reader, draft: Pick<RefusalDraft, 'siteId' | 'deviceId' | 'clientScanId' | 'code'>) =>
  newest(await rowsOf(db, { siteIds: [draft.siteId] })).find((row) => row.deviceId === draft.deviceId && row.clientScanId === draft.clientScanId && row.code === draft.code) ?? null

/**
 * Keeps a refusal (once per device, client scan id and code) and announces it (production.scan_refused). `system`: the
 * request's tenant system view (access.ts systemView).
 */
export async function recordRefusal(system: CommandCaller, draft: RefusalDraft): Promise<FloorScanRefusal> {
  const known = await system.withClient((client) => findRecorded(client, draft))
  if (known) return known
  try {
    const { result } = await command(system, { name: 'production.recordScanRefusal', input: draft }, async (tools) => {
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-refusal', ${draft.deviceId}::uuid, ${draft.clientScanId}::text), 0))`
      const raced = await findRecorded(tools.tx, draft)
      if (raced) throw new Recorded(raced)
      const companyId = draft.companyId ?? (await tools.tx.site.findUnique({ where: { id: draft.siteId }, select: { companyId: true } }))?.companyId ?? null
      const row: FloorScanRefusal = { ...draft, companyId, id: newId(), serverTime: toUtcIso(tools.now), discardedAt: null, discardedById: null, version: 1 }
      tools.audit({ action: 'production.recordScanRefusal', recordType: RECORD, recordId: row.id, companyId, siteId: row.siteId, after: row, reason: row.message })
      tools.emit({
        type: 'production.scan_refused',
        subject: row.workOrderId ?? row.deviceId,
        companyId,
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

export interface RefusalFilter {
  readonly siteIds?: readonly string[]
  readonly deviceId?: string
  readonly workOrderId?: string
  /** Only the open ones: not discarded, not resolved. */
  readonly open?: boolean
}

/** The refusals that match, with what resolved them, newest first. An office or system reader. */
export async function readRefusals(db: Reader, filter: RefusalFilter = {}): Promise<RefusalState[]> {
  const rows = newest(await rowsOf(db, filter.siteIds ? { siteIds: filter.siteIds } : {})).filter(
    (row) => (filter.deviceId === undefined || row.deviceId === filter.deviceId) && (filter.workOrderId === undefined || row.workOrderId === filter.workOrderId),
  )
  if (rows.length === 0) return []
  const scans = await db.operationScan.findMany({
    where: { deviceId: { in: [...new Set(rows.map((row) => row.deviceId))] }, clientScanId: { in: [...new Set(rows.map((row) => row.clientScanId))] } },
    select: { id: true, deviceId: true, clientScanId: true },
  })
  const asks = rows.some((row) => row.action === 'ASK_CORRECTION') ? await readCorrectionRequests(db, filter.siteIds ? { siteIds: filter.siteIds } : {}) : []
  const states = rows.map((row) => ({
    ...row,
    resolvedByScanId: scans.find((scan) => scan.deviceId === row.deviceId && scan.clientScanId === row.clientScanId)?.id ?? null,
    resolvedByRequestId: asks.find((ask) => ask.deviceId === row.deviceId && ask.clientRequestId === row.clientScanId)?.id ?? null,
  }))
  return states
    .filter((row) => !filter.open || (row.discardedAt === null && row.resolvedByScanId === null && row.resolvedByRequestId === null))
    .sort((a, b) => (a.serverTime === b.serverTime ? b.id.localeCompare(a.id) : b.serverTime.localeCompare(a.serverTime)))
}

/** One refusal with what resolved it, or null. An office or system reader. */
export async function readRefusal(db: Reader, refusalId: string): Promise<RefusalState | null> {
  if (!isUuid(refusalId)) return null
  const row = newest(await rowsOf(db, { recordId: refusalId }))[0]
  if (!row) return null
  return (await readRefusals(db, { siteIds: [row.siteId], deviceId: row.deviceId })).find((state) => state.id === refusalId) ?? null
}

/**
 * Discards a refusal (the device's "Discard": it will not be recorded; the team leader sees that it was). Once: a
 * discarded one is answered as it is. `system`: the request's tenant system view; `by`: who discarded (the worker at a
 * site that names workers, the office user; null at a site that records the station only).
 */
export async function discardRefusal(system: CommandCaller, refusal: FloorScanRefusal, by: { readonly discardedById: string | null; readonly idempotencyKey?: string | undefined }): Promise<FloorScanRefusal> {
  if (refusal.discardedAt) return refusal
  try {
    const { result } = await command(system, { name: 'production.discardScanRefusal', idempotencyKey: by.idempotencyKey, input: { refusalId: refusal.id, discardedById: by.discardedById } }, async (tools) => {
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-refusal', ${refusal.deviceId}::uuid, ${refusal.clientScanId}::text), 0))`
      const current = newest(await rowsOf(tools.tx, { recordId: refusal.id }))[0] ?? refusal
      if (current.discardedAt) throw new Recorded(current)
      const row: FloorScanRefusal = { ...current, discardedAt: toUtcIso(tools.now), discardedById: by.discardedById, version: current.version + 1 }
      tools.audit({ action: 'production.discardScanRefusal', recordType: RECORD, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { discardedAt: null, version: current.version }, after: row })
      return row
    })
    return result
  } catch (error) {
    if (error instanceof Recorded) return error.row
    throw error
  }
}
