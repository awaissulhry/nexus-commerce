import type { FastifyRequest } from 'fastify'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { EVERY_PARTY_WORDS, reachesEveryParty, type Permission } from '@nexus/factory-domain/core/permissions'
import { actorOf, requireContext } from '../../core/context'

/**
 * fix-pr-8 (the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But
 * we, as the production unit, should be able to see it all. And manage it all as well."; the B-PR-10 sweep of every office
 * route): the tenant's people — every person with its roles over the customers, a person's roles and sessions — are the
 * factory's, every customer's: a person limited to some customers is refused, in words that name none, before anything is read.
 */
export function assertEveryCustomer(request: FastifyRequest, permission: Permission): void {
  if (!reachesEveryParty(actorOf(requireContext(request)), permission)) throw new ForbiddenError(EVERY_PARTY_WORDS.en)
}
