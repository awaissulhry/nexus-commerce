import type { UserStatus } from '@nexus/factory-db'
import { defineMachine } from '@nexus/factory-domain/state/machine'
import type { CommandTx } from '../../../core/command'

/**
 * The life of a user (features PLT-015, PLT-016), checked by command() before every status change:
 *
 *   INVITED ──accept──► ACTIVE ──suspend──► SUSPENDED
 *      │                  │  ◄──reactivate──  │
 *      └──revoke / deactivate──► DEACTIVATED ◄─┘
 *   DEACTIVATED ──invite again──► INVITED
 *
 * Suspending or deactivating the tenant's last active owner is refused (the tenant would have nobody left to manage
 * it); the roles step widens this to "the last holder of the admin permissions".
 *
 * This machine sits beside its commands for now; factory-domain/src/auth/users is the home the roles step can move it
 * to (it was outside this step's folders).
 */

export interface OwnerFacts {
  /** The user whose status changes is an owner. */
  readonly isOwner: boolean
  /** Active owners of the tenant other than this user. */
  readonly otherActiveOwners: number
}

const keepsAnOwner = (facts: OwnerFacts | undefined): readonly string[] => {
  if (facts === undefined) return ['the owner check']
  return facts.isOwner && facts.otherActiveOwners === 0 ? ['another active owner of the tenant'] : []
}

export const userStatus = defineMachine<UserStatus, OwnerFacts | undefined>({
  name: 'user',
  states: ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'],
  transitions: {
    INVITED: ['ACTIVE', 'DEACTIVATED'],
    ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
    SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
    DEACTIVATED: ['INVITED'],
  },
  guards: { SUSPENDED: keepsAnOwner, DEACTIVATED: keepsAnOwner },
})

/** The facts of the owner guard, read inside the command's transaction. */
export const ownerFacts =
  (userId: string) =>
  async (tx: CommandTx): Promise<OwnerFacts> => {
    const [target, otherActiveOwners] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { isOwner: true } }),
      tx.user.count({ where: { isOwner: true, status: 'ACTIVE', id: { not: userId } } }),
    ])
    return { isOwner: target.isOwner, otherActiveOwners }
  }
