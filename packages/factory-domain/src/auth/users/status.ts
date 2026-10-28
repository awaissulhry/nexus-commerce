import { defineMachine } from '../../state/machine'

/**
 * The life of a user (features PLT-015, PLT-016), checked by command() before every status change:
 *
 *   INVITED ──accept──► ACTIVE ──suspend──► SUSPENDED
 *      │                  │  ◄──reactivate──  │
 *      └──revoke / deactivate──► DEACTIVATED ◄─┘
 *   DEACTIVATED ──invite again──► INVITED
 *
 * The tenant always keeps an administrator (PLT-030): suspending or deactivating its last active one is refused. An
 * administrator is an ACTIVE person with a live assignment, over every company, of a role that holds roles.assign
 * (factory-domain auth/roles ADMIN_PERMISSION; the owner and admin templates do): without one, nobody could give
 * anyone access again. The API reads the facts inside the command's transaction (platform/auth/roles/admins.ts).
 */

export type UserStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'

export interface AdminFacts {
  /** The user whose status changes is an administrator. */
  readonly isAdmin: boolean
  /** Active administrators of the tenant other than this user. */
  readonly otherActiveAdmins: number
}

/** The guard: what a move that removes an administrator needs. Without its facts the move is refused (fail closed). */
export const keepsAnAdmin = (facts: AdminFacts | undefined): readonly string[] => {
  if (facts === undefined) return ['the administrator check']
  return facts.isAdmin && facts.otherActiveAdmins === 0 ? ['another active administrator of the tenant'] : []
}

export const userStatus = defineMachine<UserStatus, AdminFacts | undefined>({
  name: 'user',
  states: ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'],
  transitions: {
    INVITED: ['ACTIVE', 'DEACTIVATED'],
    ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
    SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
    DEACTIVATED: ['INVITED'],
  },
  guards: { SUSPENDED: keepsAnAdmin, DEACTIVATED: keepsAnAdmin },
})
