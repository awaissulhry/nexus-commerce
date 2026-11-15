import { z } from 'zod'
import { TEST_MODE_REFUSALS } from '@nexus/factory-domain/shipping/test-mode/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Test carrier mode per site (B-W2b-412 on B-W2b-390's API; apps/factory-api modules/shipping/test-mode): each site's mode,
 * since when it is live, and whether it may go live now (the refusal's code; the API's English `words`, `message` and
 * `warning` are dropped: the screen says its own). Going live asks a fresh code (403 `stepUp`).
 */

export const testModeSiteSchema = z.object({
  siteId: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  hasSettings: z.boolean(),
  version: z.number().nullable(),
  testMode: z.boolean(),
  liveSince: z.string().nullable(),
  goLive: z.object({ ready: z.boolean(), refusal: z.object({ code: z.enum(TEST_MODE_REFUSALS) }).nullable(), testLabelsToClear: z.number() }),
})
export type TestModeSite = z.infer<typeof testModeSiteSchema>

/** GET /shipping/test-mode?companyId (shipping.settings.view since B-W2b-F49, the page's own right): every active site the reader reaches. */
export const readTestModes = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<TestModeSite[]> =>
  api.get('/shipping/test-mode', { query: { companyId: companyId ?? undefined }, schema: z.object({ sites: z.array(testModeSiteSchema) }), signal }).then((answer) => answer.sites)

/** PUT /shipping/sites/:siteId/test-mode (shipping.settings.manage; going live asks a fresh code). */
export const switchTestMode = (api: ApiClient, siteId: string, body: { testMode: boolean; version?: number }, idempotencyKey: string): Promise<{ site: TestModeSite; clearedTestLabels: number }> =>
  api.request('PUT', `/shipping/sites/${encodeURIComponent(siteId)}/test-mode`, { body, schema: z.object({ site: testModeSiteSchema, clearedTestLabels: z.number() }), idempotencyKey })
