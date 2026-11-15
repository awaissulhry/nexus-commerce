import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Customs settings (B-W2b-412 on B-W2b-409's API; apps/factory-api modules/shipping/customs settings.ts): the company's EORI
 * and each site's broker-pack switch (send the broker's pack by link). Switching it on asks a fresh code (403 `stepUp`).
 */

export const customsSettingsSchema = z.object({
  company: z.object({ id: z.string(), name: z.string(), eori: z.string().nullable(), version: z.number(), mayManage: z.boolean() }),
  sites: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), hasSettings: z.boolean(), brokerPackOn: z.boolean(), version: z.number().nullable(), mayManage: z.boolean() })),
})
export type CustomsSettings = z.infer<typeof customsSettingsSchema>

const base = (companyId: string) => `/shipping/companies/${encodeURIComponent(companyId)}`

/** GET /shipping/companies/:companyId/customs (shipping.settings.view). */
export const readCustomsSettings = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<CustomsSettings> => api.get(`${base(companyId)}/customs`, { schema: customsSettingsSchema, signal })

const changed = z.object({ changed: z.boolean(), settings: customsSettingsSchema })

/** PUT …/eori (shipping.settings.manage): normalised by the API; null clears it. */
export const setEori = (api: ApiClient, companyId: string, body: { eori: string | null; version: number }, idempotencyKey: string) =>
  api.request('PUT', `${base(companyId)}/eori`, { body, schema: changed, idempotencyKey })

/** PUT /shipping/sites/:siteId/broker-pack (shipping.settings.manage; on asks a fresh code). */
export const switchBrokerPack = (api: ApiClient, siteId: string, body: { on: boolean; version: number }, idempotencyKey: string) =>
  api.request('PUT', `/shipping/sites/${encodeURIComponent(siteId)}/broker-pack`, { body, schema: changed, idempotencyKey })
