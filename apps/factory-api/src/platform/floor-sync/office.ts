import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { FLOOR_SYNC_DISCARD, FLOOR_SYNC_VIEW } from '@nexus/factory-domain/floor-sync/permissions'
import { StaleVersionError, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { officeOf } from '../../modules/production/scans/access'
import { workerNames } from '../../modules/production/scans/store'
import { readRefused, readRefusedOne, type RefusedStatus } from './store'
import { discardWithModule, refusedView } from './sync'

/**
 * The office's side of the floor sync (B-W0-30; PLT-239; design floor.sync connections "Production › Labour &
 * corrections", "Admin › Devices & printers"): the refused actions of the floor tablets of the sites the person's
 * floorsync.view reaches (scopeWhere over company and site), open by default — the ones someone must act on — and a
 * discard with a reason (floorsync.discard, can() on the tablet's company and site). A list names devices and stations,
 * never a worker; one record names its worker where the site names workers (W1 Owner answer: worker names only inside one
 * record).
 */

const devicesOf = async (db: Parameters<Parameters<CommandCaller['withClient']>[0]>[0], ids: readonly string[]) =>
  new Map((await db.device.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))

export async function listRefused(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly deviceId?: string | undefined; readonly kind?: string | undefined; readonly status: RefusedStatus | 'ALL'; readonly limit: number }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const scope = scopeWhere(actorOf(context), FLOOR_SYNC_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.FloorRefusedActionWhereInput
    const rows = await readRefused(db, {
      scope,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status !== 'ALL' ? { status: query.status } : {}),
      limit: query.limit,
    })
    const devices = await devicesOf(db, rows.map((row) => row.deviceId))
    return { refused: rows.map((row) => ({ ...refusedView(row), device: { id: row.deviceId, name: devices.get(row.deviceId) ?? '' } })) }
  })
}

async function reachable(caller: CommandCaller, refusedId: string, permission: typeof FLOOR_SYNC_VIEW | typeof FLOOR_SYNC_DISCARD) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => readRefusedOne(db, refusedId))
  if (!row || !can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Refused action not found.')
  return { context, row }
}

export async function refusedOne(caller: CommandCaller, refusedId: string) {
  const { row } = await reachable(caller, refusedId, FLOOR_SYNC_VIEW)
  return caller.withClient(async (db) => {
    const devices = await devicesOf(db, [row.deviceId])
    const names = await workerNames(db, [row.workerId])
    return {
      refused: {
        ...refusedView(row),
        device: { id: row.deviceId, name: devices.get(row.deviceId) ?? '' },
        worker: row.workerId ? { id: row.workerId, name: names.get(row.workerId) ?? '' } : null,
        discardedById: row.discardedById,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        moduleRefusal: row.moduleRefusal,
      },
    }
  })
}

/** The office discards a refused action with a reason (version-guarded); the module's own record of it with it. */
export async function discardRefusedInOffice(caller: CommandCaller, refusedId: string, body: { readonly reason: string; readonly version: number }, idempotencyKey: string | undefined) {
  const { context, row } = await reachable(caller, refusedId, FLOOR_SYNC_DISCARD)
  if (row.status === 'OPEN' && row.version !== body.version) throw new StaleVersionError('FloorRefusedAction', row.id, row.version, body.version)
  const kept = await discardWithModule(caller, row, { discardedById: context.actorId, discardedBy: 'OFFICE', reason: body.reason.trim() }, idempotencyKey)
  return { refused: refusedView(kept) }
}
