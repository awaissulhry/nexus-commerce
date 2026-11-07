import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { isPartnerKind, partnerKindsOf, type PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { actorOf, type PartnerContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../auth/portal/authenticator'

/**
 * The portal session a partner route of B-W2b-168 works for: the context (audience partner, the person, the party), the
 * portal session (the company whose portal it is, the person's name, kind and language, an office preview) and the actor
 * for can(). A link session is not a portal session: these routes are the portal's.
 */
export interface PartnerCaller {
  readonly context: PartnerContext
  readonly session: PortalSession
  readonly actor: Actor
}

export function partnerCallerOf(request: FastifyRequest): PartnerCaller {
  const context = request.factoryContext
  if (!context || context.audience !== 'partner') throw new ForbiddenError()
  return { context, session: portalSessionOf(request), actor: actorOf(context) }
}

/**
 * The partner kinds whose portal the session shows: the person's own kind; an office preview (no person kind) shows every
 * kind the party's roles fit. Read in the partner scope (the party's own row).
 */
export async function kindsOfSession(client: FactoryClient, caller: PartnerCaller): Promise<PartnerKind[]> {
  const kind = caller.session.person.partnerKind
  if (isPartnerKind(kind)) return [kind]
  const party = await client.party.findUnique({ where: { id: caller.context.partyId }, select: { roles: true } })
  return party ? partnerKindsOf(party.roles) : []
}
