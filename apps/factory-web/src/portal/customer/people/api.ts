import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * owb-po4.3 — Your people's own read: the factory people for this customer's brand (`GET /portal/factory-people`, server step
 * owb-po2.4: the office people of the customer's pool — names, role words, a picture of letters or an icon; never a worker, never a
 * team, no phone or e-mail). Parsed with the portal's own schema: zod keeps only what is named here. Until the server builds the
 * read (a 404) or when it fails, the page draws no card for it — never an empty one that says "nobody".
 */
const factoryPerson = z.object({
  id: z.string(),
  name: z.string(),
  role: z.object({ en: z.string(), it: z.string() }),
  picture: z
    .object({
      kind: z.enum(['LETTERS', 'ICON']).catch('LETTERS'),
      icon: z.string().nullable().optional(),
      colour: z.string().nullable().optional(),
    })
    .optional(),
})
export const factoryPeopleSchema = z.object({ people: z.array(factoryPerson) })
export type FactoryPeople = z.infer<typeof factoryPeopleSchema>

export const fetchFactoryPeople = (api: ApiClient, signal?: AbortSignal): Promise<FactoryPeople> => api.get('/portal/factory-people', { schema: factoryPeopleSchema, signal })
