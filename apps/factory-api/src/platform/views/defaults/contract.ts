import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { savedViewView, viewParams } from '../contract'

/**
 * My default view of a list (B-W2b-24, followup Z12:07; PLT-163 "Views personal, team or role default"): one of my own
 * views of a list marked as the one the list opens on for me (before any role default). Office only, views.save.
 *
 *   PUT    /views/:viewId/personal-default             mark it (another view of mine of that list loses the mark)
 *   DELETE /views/:viewId/personal-default?version=    take the mark off
 *
 * Both answer the view as it is now and the list's default for me (null after an unmark).
 */

const version = z.number().int().min(1)

const answer = { 200: output({ view: savedViewView, personalDefaultId: id().nullable() }) }

export const setPersonalDefaultContract = defineContract({
  params: viewParams,
  body: input({ version }),
  response: answer,
})
export type SetPersonalDefaultBody = z.infer<typeof setPersonalDefaultContract.body>

export const clearPersonalDefaultContract = defineContract({
  params: viewParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: answer,
})
