import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import { readOrder, type PortalOrderRow } from './store'

/**
 * Who reads (B-W2b-175): a portal session of a customer (the route's manifest checked portal.salesOrders.view over the
 * session's party). Its orders are the party's (row-level security) in the portal's company; a price shows only with the
 * price grain of the person's role (an office preview holds none). The tenant's reads (names, audit rows, production
 * counts, the customer's settings) run in the office scope as the person, and only after the partner read found the order.
 */

export interface PortalReader {
  readonly session: PortalSession
  readonly actor: Actor
  readonly seesPrices: boolean
  /** A read in the tenant's scope (office, as the person). */
  inTenant<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
}

export function portalReader(app: FastifyInstance, request: FastifyRequest): PortalReader {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  const auth = portalOf(app).auth
  return { session, actor, seesPrices: heldGrains(actor).has('price'), inTenant: (work) => auth.inTenant(session.tenantId, session.userId, work) }
}

/** The order of the party in the portal's company, read in the partner scope, or 404. */
export async function partnerOrder(request: FastifyRequest, reader: PortalReader, orderId: string): Promise<PortalOrderRow> {
  const order = await request.withClient((client) => readOrder(client, reader.session.company.id, orderId))
  if (!order) throw new NotFoundError('Order not found.')
  return order
}
