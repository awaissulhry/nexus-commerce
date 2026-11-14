import { z } from 'zod'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { roleView } from '../contract'

/**
 * Custom roles in depth (B-W2b-404; PLT-031): archive and restore (the version read), and the review of a change before it
 * is saved (the ReviewChangesModal of "Change role"). Refusals travel as codes in their paths; the web says its words.
 */

const grain = z.enum(GRAINS)
const permissionName = z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/).max(100)

export const archiveRoleContract = defineContract({
  params: input({ roleId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500) }),
  response: { 200: roleView },
})

export const restoreRoleContract = defineContract({
  params: input({ roleId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: roleView },
})

export const reviewRoleContract = defineContract({
  params: input({ roleId: id() }),
  body: input({
    name: z.string().trim().min(1).max(100).optional(),
    requireMfa: z.boolean().optional(),
    permissions: z.array(permissionName).max(500).optional(),
    grains: z.array(z.string().max(16)).max(GRAINS.length).optional(),
  }),
  response: {
    200: output({
      /** The role's version now (a save sends it back). */
      version: z.number().int(),
      permissionsAdded: z.array(z.string()),
      permissionsRemoved: z.array(z.string()),
      grainsAdded: z.array(grain),
      grainsRemoved: z.array(grain),
      requireMfa: output({ before: z.boolean(), after: z.boolean() }),
      /** It gives something the role did not (a permission, a grain, two-factor no longer asked). */
      raises: z.boolean(),
      /** Saving asks for a fresh code: it raises rights, or it changes the two-factor rule. */
      asksFreshCode: z.boolean(),
      /** People who hold it now: they get the change at their next request. */
      holders: z.number().int(),
      /** Why saving would be refused (empty: it can be saved). */
      refusals: z.array(output({ path: z.string(), message: z.string() })),
    }),
  },
})

export type ArchiveRoleBody = z.infer<typeof archiveRoleContract.body>
export type RestoreRoleBody = z.infer<typeof restoreRoleContract.body>
export type ReviewRoleBody = z.infer<typeof reviewRoleContract.body>
