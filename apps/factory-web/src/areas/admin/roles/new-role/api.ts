import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { GRAINS, ROLE_AUDIENCES, roleSchema } from '../../shared/api'

/**
 * New role (B-W2b-413 on B-W2b-404's API; PLT-031; design admin.roles pop:new-role): the ready-made roles with whether the
 * person may copy them (`copyable`: an office template, not the owner's, nothing the person lacks) from
 * `GET /auth/roles/templates`, and `POST /auth/roles` (roles.manage; always a fresh code) that makes the copy. The key is
 * `custom.<slug>`; the slug comes from the name (model.ts).
 */

export const templateSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  audience: z.enum(ROLE_AUDIENCES),
  requireMfa: z.boolean(),
  permissions: z.array(z.string()),
  grains: z.array(z.enum(GRAINS)),
  copyable: z.boolean(),
})
export type RoleTemplate = z.infer<typeof templateSchema>

export const roleTemplates = (api: ApiClient) => api.get('/auth/roles/templates', { schema: z.object({ templates: z.array(templateSchema) }) }).then((answer) => answer.templates)

export const createRole = (api: ApiClient, body: { key: string; name: string; basedOn: string }) => api.post('/auth/roles', { body, schema: roleSchema, idempotencyKey: newIdempotencyKey() })
