import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { beforeRelease, blockingCodes } from '@nexus/factory-domain/production/work-orders/bulk'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_RELEASE, WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { ReleaseCheckCode } from '@nexus/factory-domain/production/work-orders/release'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOn, officeContextOf } from './access'
import { checklistOf, readBasics, readReleaseFacts } from './facts'
import { releaseWorkOrder } from './release'
import { newPlanCache } from './release/blockers'
import { HEADER } from './store'
import { todayNow } from './work-orders'

/**
 * The bulk release's rows (B-W2b-51; MES-017; design wo-grid selection row "'Release 4 work orders' (W2b,
 * ReviewChangesModal with per-row blockers)"): what the list frame's bulk target `production.work-orders.release`
 * (apps/factory-api platform/views/bulk/targets/work-order-release.ts) reads and writes.
 *
 *   read    the asked work orders the caller may see (workorders.view over their companies and sites), each one before
 *           its release that the caller may release checked with THE release check (./facts checklistOf, the record's
 *           and the release command's one answer; a site's plan read once for all its drafts), keeping the codes of the
 *           checks that block it.
 *   write   one row through the module's own release (./release releaseWorkOrder: its version check, the site's release
 *           lock, the check again under it, the frozen spec, the batch number, its audit row and workorder.released);
 *           a check that holds it then throws ReleaseBlockedError with the codes.
 */

export interface ReleaseRow {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  readonly heldFromStatus: WorkOrderStatus | null
  readonly version: number
  readonly companyId: string
  readonly siteId: string
  /** The codes of the release checks that block it now (empty: releasable, or not before its release). */
  readonly blocking: readonly ReleaseCheckCode[]
}

/** The rows of a bulk release, as the caller may see them now. */
export async function releaseRowsFor(caller: CommandCaller, ids: readonly string[]): Promise<ReleaseRow[]> {
  const context = officeContextOf(caller)
  const wanted = ids.filter(isUuid)
  if (wanted.length === 0) return []
  const today = todayNow()
  return caller.withClient(async (client) => {
    const rows = await client.workOrder.findMany({
      where: { AND: [scopeWhere(actorOf(context), WORKORDERS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput, { id: { in: wanted } }] },
      select: HEADER,
    })
    const plans = newPlanCache()
    const out: ReleaseRow[] = []
    for (const row of rows) {
      let blocking: ReleaseCheckCode[] = []
      if (beforeRelease(row) && mayOn(context, WORKORDERS_RELEASE, row)) blocking = blockingCodes(checklistOf(await readReleaseFacts(client, await readBasics(client, row), today, plans), null).checks)
      out.push({ id: row.id, number: row.number, status: row.status, heldFromStatus: row.heldFromStatus, version: row.version, companyId: row.companyId, siteId: row.siteId, blocking })
    }
    return out
  })
}

/** One row released through the module's own command (its ReleaseBlockedError says what holds it). */
export async function releaseRow(caller: CommandCaller, row: ReleaseRow, version: number, idempotencyKey: string | undefined): Promise<ReleaseRow> {
  const { workOrder } = await releaseWorkOrder(caller, row.id, { version }, idempotencyKey)
  return { ...row, status: workOrder.status, heldFromStatus: null, version: workOrder.version, blocking: [] }
}
