import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { RequestContext } from '../../../core/context'

/**
 * The read log and the security events are about the whole group (B-W2b-399; Owner answer W2b-6 question 3 = A): read only
 * with the permission over EVERY company (the administrator's and the Owner's roles), never through a role limited to some
 * companies, which would see the reads and refusals of people and records outside them. The manifest's `tenant` scope checks
 * the permission is held; this checks it is held everywhere.
 */
export const holdsEverywhere = (grants: readonly Grant[], permission: Permission): boolean =>
  grants.some((grant) => grant.companies === 'all' && grant.sites === 'all' && grant.parties === 'all' && grant.permissions.includes(permission))

export function assertEverywhere(context: RequestContext, permission: Permission, words: string): void {
  if (context.audience !== 'office' || !holdsEverywhere(context.grants, permission)) throw new ForbiddenError(words)
}
