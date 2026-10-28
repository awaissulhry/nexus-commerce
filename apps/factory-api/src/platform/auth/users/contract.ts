import { z } from 'zod'
import type { UserStatus } from '@nexus/factory-db'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/** The user list and the lifecycle commands (features PLT-015, PLT-016, PLT-070). */

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const satisfies readonly UserStatus[]

export const userView = output({
  id: id(),
  email: z.string(),
  displayName: z.string(),
  locale: z.string(),
  status: z.enum(USER_STATUSES),
  isOwner: z.boolean(),
  /** Two-factor is set up. */
  mfaEnabled: z.boolean(),
  lastSignInAt: instant().nullable(),
  /** The open invitation's expiry, for an invited user. */
  invitationExpiresAt: instant().nullable(),
  version: z.number().int(),
})

export const listUsersContract = defineContract({ response: { 200: output({ users: z.array(userView) }) } })

const change = input({
  /** The version the caller read (edit-conflict guard). */
  version: z.number().int().min(1),
  reason: z.string().trim().min(1).max(500).optional(),
})

const changed = output({ id: id(), status: z.enum(USER_STATUSES), version: z.number().int(), sessionsEnded: z.number().int() })

export const userChangeContract = defineContract({
  params: input({ userId: id() }),
  body: change,
  response: { 200: changed },
})

export type UserChangeBody = z.infer<typeof change>
