import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXPORT_FORMATS } from '@nexus/factory-domain/views/exports'
import { VIEW_AUDIENCES } from '@nexus/factory-domain/views/rules'
import { LIST_KEY, VIEW_LIMITS, viewStateSchema } from '@nexus/factory-domain/views/state'

/**
 * Saved views of the Office's lists (B-W2a-23; PLT-163; design shell.lists toolbar "Columns ▾ (views, then
 * Customise…)", pop:save-view): a person's own views, the views shared with a role they hold or with everyone, and a
 * role's default view of a list. A view is what the ONE list frame keeps (factory-domain views/state: the list's address
 * terms, its column layout, its density). The list's answer also says what the reader may do and whether the list can
 * be exported (platform/exports).
 */

const version = z.number().int().min(1)
export const listKey = () => z.string().regex(LIST_KEY).max(VIEW_LIMITS.listKey)
const name = () => z.string().trim().min(1).max(VIEW_LIMITS.name)

export const savedViewView = output({
  id: id(),
  listKey: z.string(),
  name: z.string(),
  ownerId: id(),
  /** The owner's name, for "Shared by …". */
  ownerName: z.string(),
  /** The reader made it. */
  mine: z.boolean(),
  audience: z.enum(VIEW_AUDIENCES),
  roleId: id().nullable(),
  roleName: z.string().nullable(),
  roleDefault: z.boolean(),
  companyId: id().nullable(),
  state: viewStateSchema,
  /** Why the reader may not change or remove it (null: they may). */
  changeHeld: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type SavedViewView = z.infer<typeof savedViewView>

export const listViewsContract = defineContract({
  querystring: input({ listKey: listKey() }),
  response: {
    200: output({
      views: z.array(savedViewView),
      /** The view the list opens on for the reader: the default of the first role they hold that has one. */
      roleDefaultId: id().nullable(),
      /** The office roles the reader holds now (they may share a view with one of them). */
      roles: z.array(output({ id: id(), name: z.string() })),
      /** Every office role, for views.manage (a role default for any role); empty otherwise. */
      allRoles: z.array(output({ id: id(), name: z.string() })),
      can: output({ save: z.boolean(), manage: z.boolean(), export: z.boolean() }),
      /** The list's export, when it has one and the reader may export it; null otherwise. */
      exports: output({ formats: z.array(z.enum(EXPORT_FORMATS)) }).nullable(),
    }),
  },
})

const sharing = {
  audience: z.enum(VIEW_AUDIENCES).optional(),
  roleId: id().nullable().optional(),
  roleDefault: z.boolean().optional(),
}

export const createViewContract = defineContract({
  body: input({ listKey: listKey(), name: name(), ...sharing, state: viewStateSchema }),
  response: { 201: output({ view: savedViewView }) },
})
export type CreateViewBody = z.infer<typeof createViewContract.body>

export const viewParams = input({ viewId: id() })

export const getViewContract = defineContract({
  params: viewParams,
  response: { 200: output({ view: savedViewView }) },
})

export const updateViewContract = defineContract({
  params: viewParams,
  body: input({ version, name: name().optional(), ...sharing, state: viewStateSchema.optional() }),
  response: { 200: output({ view: savedViewView }) },
})
export type UpdateViewBody = z.infer<typeof updateViewContract.body>

export const deleteViewContract = defineContract({
  params: viewParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: z.literal(true) }) },
})
