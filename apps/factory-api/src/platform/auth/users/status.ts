import type { AdminFacts } from '@nexus/factory-domain/auth/users/status'
import type { CommandTx } from '../../../core/command'
import { activeAdmins } from '../roles/access'

/**
 * The user status machine lives in factory-domain (auth/users/status.ts): its guard keeps an active administrator of
 * the tenant (a person with roles.assign over every company, through a live role assignment). These are the facts it
 * needs, read inside the command's transaction.
 */
export { userStatus, type AdminFacts } from '@nexus/factory-domain/auth/users/status'

export const adminFacts =
  (userId: string, now: Date) =>
  async (tx: CommandTx): Promise<AdminFacts> => {
    const others = await activeAdmins(tx, now, { userId })
    const all = await activeAdmins(tx, now)
    return { isAdmin: all.has(userId), otherActiveAdmins: others.size }
  }
