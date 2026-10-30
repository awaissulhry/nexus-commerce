import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_REPAIRS_VIEW } from '@nexus/factory-domain/sales/repairs/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf } from '../returns/access'
import { readRepair, type RepairRow } from './store'

/**
 * Who works on repairs (plan A1 §2.2, §3.11): the office over the companies, sites AND customers its grants reach (a role
 * limited to some customers sees only their repairs). A repair the caller may not see is not found; one it sees but may
 * not act on is forbidden. The floor reads no repair yet (MES-132, W2b).
 */

export { officeOf }

export interface RepairScope {
  readonly companyId: string
  /** The repairing site (none yet: before the repair is made). */
  readonly siteId?: string | null | undefined
  readonly partyId: string
}

const scopeOf = (row: RepairScope) => ({ companyId: row.companyId, ...(row.siteId ? { siteId: row.siteId } : {}), partyId: row.partyId })

export const mayOn = (context: OfficeContext, permission: Permission, row: RepairScope): boolean => can(actorOf(context), permission, scopeOf(row))

/** The repair the office caller sees (sales.repairs.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeRepair(caller: CommandCaller, repairId: string, permission: Permission = SALES_REPAIRS_VIEW): Promise<{ context: OfficeContext; repair: RepairRow }> {
  const context = officeOf(caller)
  const repair = isUuid(repairId) ? await caller.withClient((client) => readRepair(client, repairId)) : null
  if (!repair || !mayOn(context, SALES_REPAIRS_VIEW, repair)) throw new NotFoundError('Repair not found.')
  if (!mayOn(context, permission, repair)) throw new ForbiddenError()
  return { context, repair }
}
