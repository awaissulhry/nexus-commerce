import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { FloorSite } from './model'

/**
 * The Floor languages calls (B-W2a-41; PLT-128): mirrors apps/factory-api platform/admin/org/contract.ts
 * (floorLanguagesSiteView, listFloorLanguagesContract, setFloorLanguagesContract); the web never imports the API's
 * source. An answer that does not match is a `contract` error, never half-read.
 */

export const floorSiteSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyCode: z.string(),
  companyName: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  locales: z.array(z.string()),
  version: z.number(),
  workers: z.record(z.string(), z.number()).nullable(),
  notice: z.object({ id: z.string(), label: z.string(), locales: z.array(z.string()) }).nullable(),
  canManage: z.boolean(),
})

const sitesAnswer = z.object({ sites: z.array(floorSiteSchema) })
const siteAnswer = z.object({ site: floorSiteSchema })

/** GET /org/floor-languages (sites.view): every active site the person sees, with its floor languages. */
export const listFloorLanguages = (api: ApiClient): Promise<FloorSite[]> => api.get('/org/floor-languages', { schema: sitesAnswer }).then((answer) => answer.sites)

/** PUT /org/sites/:siteId/floor-languages (sites.manage): the site's languages after the change, with the version read. */
export const setFloorLanguages = (api: ApiClient, siteId: string, body: { version: number; locales: readonly string[]; reason?: string }): Promise<FloorSite> =>
  api
    .request('PUT', `/org/sites/${encodeURIComponent(siteId)}/floor-languages`, { body: { ...body, locales: [...body.locales] }, schema: siteAnswer, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.site)
