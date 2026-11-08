import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { AllocationRefusal } from '@nexus/factory-domain/production/cutorders/allocation'
import { floorReadyRefusal } from '@nexus/factory-domain/production/cutting/rules'
import type { LayRefusal } from '@nexus/factory-domain/production/lays/rules'
import type { ReconcileRefusal } from '@nexus/factory-domain/production/lays/reconcile'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { asTenantSystem } from '../bundles/codes'

/**
 * Who may do what with a lay at the table and a cut order's reconciliation (B-W2b-116). The callers, can() per record and the
 * 404 / 403 words are the cut orders' (../cutorders/access: officeOf, workerOf, may, invalid, notFound). A rule's refusal is a 409
 * whose issue is `refusal/<CODE>` with the words (the tablet and the Cutting page read them; `refusal.<CODE>` in the web's words).
 */

export type LaysRefusal = LayRefusal | ReconcileRefusal | AllocationRefusal | { readonly code: 'FLOOR_NOT_READY'; readonly message: string }

export class LayRefusedError extends ConflictError {
  override name = 'LayRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: LaysRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: LaysRefusal): never => {
  throw new LayRefusedError(refusal)
}

/** The site's floor is ready for real work (platform/privacy, read as the tenant's system caller), or a 409 in the gate's words. */
export async function assertFloorReady(caller: CommandCaller, context: FloorContext, siteId: string): Promise<void> {
  const refusal = floorReadyRefusal(await asTenantSystem(caller, context).withClient((client) => floorReadinessFor(client, siteId, serverClock.now())))
  if (refusal) refuse({ code: 'FLOOR_NOT_READY', message: refusal.message })
}
