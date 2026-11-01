import { beforeRelease, RELEASE_BULK_LIMIT, releaseFieldOf } from '@nexus/factory-domain/production/work-orders/bulk'
import { WORKORDERS_RELEASE } from '@nexus/factory-domain/production/work-orders/permissions'
import type { BulkRefusal } from '@nexus/factory-domain/views/bulk/rules'
import { mayOn, officeContextOf } from '../../../../modules/production/work-orders/access'
import { releaseRow, releaseRowsFor, type ReleaseRow } from '../../../../modules/production/work-orders/bulk-release'
import { ReleaseBlockedError } from '../../../../modules/production/work-orders/release'
import { BulkRowRefused, defineBulkTarget } from '../target'

/**
 * Production › Work orders, "Release N work orders" (B-W2b-51; MES-017; design production.workorders h.act "Release…
 * (selection-aware, W2b bulk)", wo-grid selection row "'Release 4 work orders' (W2b, ReviewChangesModal with per-row
 * blockers)"): the list's selection released through the frame's preview — field `status` → `RELEASED` — each row
 * through the module's own release (workorders.release over the row's company and site, its version check, the site's
 * release lock, its audit row, workorder.released). A row its release check holds is refused `held` with `reasons`, the
 * codes of the checks that block it (CERTIFICATE, MATERIAL, DEPOSIT, …: the screen words them); a row released already
 * (or started, finished) reads RELEASED and is already so; a cancelled one is held. No material override in bulk.
 * At most RELEASE_BULK_LIMIT rows (each row's check is heavy). Per work order only: no person, no money.
 */

const held = (row: ReleaseRow): BulkRefusal | null => {
  if (!beforeRelease(row)) return { code: 'held', status: row.status }
  return row.blocking.length > 0 ? { code: 'held', field: 'status', status: row.status, reasons: row.blocking } : null
}

export const workOrderRelease = defineBulkTarget<ReleaseRow>({
  listKey: 'production.work-orders.release',
  permission: WORKORDERS_RELEASE,
  maxRows: RELEASE_BULK_LIMIT,
  fields: {
    status: { kind: 'choice', choices: ['RELEASED'], read: (row) => releaseFieldOf(row), held },
  },
  load: (caller, ids) => releaseRowsFor(caller, ids),
  idOf: (row) => row.id,
  labelOf: (row) => row.number,
  versionOf: (row) => row.version,
  statusOf: (row) => row.status,
  rowHeld: (caller, row) => (mayOn(officeContextOf(caller), WORKORDERS_RELEASE, row) ? null : { code: 'forbidden' }),
  async write(caller, row, _changes, version, idempotencyKey) {
    try {
      return await releaseRow(caller, row, version, idempotencyKey)
    } catch (error) {
      if (error instanceof ReleaseBlockedError) throw new BulkRowRefused({ code: 'held', field: 'status', status: row.status, reasons: [...error.codes] })
      throw error
    }
  },
})
