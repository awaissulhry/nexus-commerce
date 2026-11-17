import { SUPERVISOR_TAG_WORDS } from '@nexus/factory-domain/production-brand/supervisor'
import { registerOwnerResolver, type OwnerResolver } from '../../../platform/threads/owner'
import { registerPeopleTagger, type PeopleTagger } from '../../../platform/threads/people-tags'
import { supervisorOf, supervisorOfOrder } from './resolver'

/**
 * T7 / T8 (threads agreements 2026-11-17; production plan §3 "Supervisor"; review fix R-62: the threads platform never imports
 * this module — the module registers through the threads' own hooks, once, when its routes load):
 *
 *   T7  a note's @ list (GET /threads/<type>/<id>/people) puts the record's production supervisor first, tagged "Supervisor"
 *       ("Supervisore"), on a sales order and a work order (./resolver supervisorOf: the order's own, else the customer's
 *       default; a work order's single order's, else the default; none for a work order of no customer). The tag only marks a
 *       person the list already holds — a reader of that record — so it names nobody to a writer who could not mention him.
 *   T8  who answers a sales order's conversation (the thread's head, B-TH-028): the thread's own owner → the order's production
 *       supervisor (SUPERVISOR) → its maker.
 *
 * Office only: the customer is never told who supervises (R-41; the portal's thread answers carry no head and no people list).
 */

export const SUPERVISOR_TAGGER = 'production.supervisor'

/** T7: the record's production supervisor, tagged (none: no tag). */
export const supervisorTagger: PeopleTagger = async (client, record) => {
  const found = await supervisorOf(client, record)
  return found?.userId ? new Map([[found.userId, SUPERVISOR_TAG_WORDS]]) : new Map()
}

/** T8: a sales order's responsible person in the owner chain — its production supervisor (null: none). */
export const supervisorOwner: OwnerResolver = async (client, salesOrderId) => (await supervisorOfOrder(client, salesOrderId))?.userId ?? null

/** Registers both hooks (idempotent: the same name and source replace themselves). */
export function registerSupervisorThreadHooks(): void {
  registerPeopleTagger('SalesOrder', SUPERVISOR_TAGGER, supervisorTagger)
  registerPeopleTagger('WorkOrder', SUPERVISOR_TAGGER, supervisorTagger)
  registerOwnerResolver('SalesOrder', 'SUPERVISOR', supervisorOwner)
}
