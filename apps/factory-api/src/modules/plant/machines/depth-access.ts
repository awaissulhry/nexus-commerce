import type { FastifyRequest } from 'fastify'
import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { MachineDepthRefusal } from '@nexus/factory-domain/plant/machines/status'
import type { CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, type SystemContext } from '../../../core/context'

/**
 * What machines in depth (B-W2b-136) shares between its routes: its refusal (a 409 with the issues `refusal/<CODE>` and
 * `fix`, as every plant refusal: the screens read the code), and the tenant's system caller for one machine's company and
 * site holding exactly the files or print permissions a route needs — after the module's own check of plant.view or
 * plant.machines.manage, so a person needs no files right to keep a machine's documents (the pattern of B-W2b-96's photos,
 * B-W2b-124's reports and B-W2b-143's data sheets).
 */

export class MachineRefusedError extends ConflictError {
  override name = 'MachineRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: MachineDepthRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

export const refuse = (refusal: MachineDepthRefusal): never => {
  throw new MachineRefusedError(refusal)
}

/** The tenant's system caller for one machine's company and site only, holding exactly these permissions. */
export function siteCaller(request: FastifyRequest, tenantId: string, place: { readonly companyId: string; readonly siteId: string }, permissions: readonly Permission[]): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  const grant: Grant = { permissions: [...permissions], companies: [place.companyId], sites: [place.siteId], parties: 'all' }
  const context: SystemContext = Object.freeze({ audience: 'system', tenantId, actorId: SYSTEM_ACTOR_ID, requestId: String(request.id), grants: [grant] })
  view.factoryContext = context
  return view
}
