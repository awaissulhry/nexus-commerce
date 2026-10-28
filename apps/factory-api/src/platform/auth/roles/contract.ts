import { z } from 'zod'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { PERMISSION_RISKS } from '@nexus/factory-domain/auth/permissions/registry'
import { ROLE_AUDIENCES } from '@nexus/factory-domain/auth/roles/templates'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/** Roles, templates and assignments (features PLT-029, PLT-030, PLT-032). Writes carry the version they read. */

const grain = z.enum(GRAINS)
const permissionName = z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/).max(100)
const ids = z.array(id()).max(200)

const content = output({
  name: z.string(),
  description: z.string().nullable(),
  requireMfa: z.boolean(),
  permissions: z.array(z.string()),
  grains: z.array(grain),
})

export const templateView = content.extend({ key: z.string(), audience: z.enum(ROLE_AUDIENCES) })

export const roleView = content.extend({
  id: id(),
  key: z.string(),
  system: z.boolean(),
  basedOn: z.string().nullable(),
  audience: z.enum(ROLE_AUDIENCES),
  version: z.number().int(),
  /** People holding it now. */
  holders: z.number().int(),
  /** A system role that differs from its template (a sync brings it up to date). */
  outdated: z.boolean(),
  /** A custom role: what its template now has that it lacks (never added by itself). */
  templateAdds: output({ permissionsAdded: z.array(z.string()), grainsAdded: z.array(grain) }),
})

export const listTemplatesContract = defineContract({
  response: {
    200: output({
      templates: z.array(templateView),
      permissions: z.array(output({ name: z.string(), area: z.string(), description: z.string(), risk: z.enum(PERMISSION_RISKS) })),
      grains: z.array(output({ grain, description: z.string() })),
    }),
  },
})

export const listRolesContract = defineContract({ response: { 200: output({ roles: z.array(roleView) }) } })

export const createRoleContract = defineContract({
  body: input({
    /** The custom role's key is `custom.<key>`. */
    key: z.string().trim().max(48),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    /** A template to copy: its permissions, grains and two-factor rule unless the body names them. */
    basedOn: z.string().max(48).optional(),
    requireMfa: z.boolean().optional(),
    permissions: z.array(permissionName).max(500).optional(),
    grains: z.array(z.string().max(16)).max(GRAINS.length).optional(),
  }),
  response: { 200: roleView },
})

export const editRoleContract = defineContract({
  params: input({ roleId: id() }),
  body: input({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    requireMfa: z.boolean().optional(),
    permissions: z.array(permissionName).max(500).optional(),
    grains: z.array(z.string().max(16)).max(GRAINS.length).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  response: { 200: roleView },
})

export const syncTemplatesContract = defineContract({
  response: { 200: output({ created: z.number().int(), updated: z.number().int() }) },
})

export const assignmentView = output({
  id: id(),
  userId: id(),
  roleId: id(),
  roleKey: z.string(),
  roleName: z.string(),
  allCompanies: z.boolean(),
  companyIds: z.array(id()),
  siteIds: z.array(id()),
  partyIds: z.array(id()),
  validFrom: instant(),
  validTo: instant().nullable(),
  endedAt: instant().nullable(),
  /** Gives access now: started, not past validTo, not ended. */
  live: z.boolean(),
  version: z.number().int(),
})
export type AssignmentView = z.infer<typeof assignmentView>

/** One role with its scope, as an assignment or an invitation names it. */
export const assignmentInput = input({
  roleId: id(),
  /** Every company of the tenant, also later ones. Otherwise name companyIds. */
  allCompanies: z.boolean().default(false),
  companyIds: ids.default([]),
  /** Empty: no site limit. */
  siteIds: ids.default([]),
  /** Empty: no party limit. */
  partyIds: ids.default([]),
  validFrom: instant().optional(),
  validTo: instant().optional(),
})
export type AssignmentInput = z.infer<typeof assignmentInput>

export const listAssignmentsContract = defineContract({
  params: input({ userId: id() }),
  response: { 200: output({ assignments: z.array(assignmentView) }) },
})

export const assignContract = defineContract({
  params: input({ userId: id() }),
  body: assignmentInput.extend({ reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: assignmentView },
})

export const endAssignmentContract = defineContract({
  params: input({ assignmentId: id() }),
  body: input({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500).optional() }),
  response: { 200: assignmentView },
})

export type CreateRoleBody = z.infer<typeof createRoleContract.body>
export type EditRoleBody = z.infer<typeof editRoleContract.body>
export type AssignBody = z.infer<typeof assignContract.body>
export type EndAssignmentBody = z.infer<typeof endAssignmentContract.body>
