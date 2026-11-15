import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Our own carrier contracts (B-W2b-412 on B-W2b-400's API; LOG-033; apps/factory-api modules/shipping/carrier-accounts): per
 * company and site, the carrier, "use only our rates", live or switched off, and whether a sealed number is on file. The number
 * is WRITE-ONLY: sent once, never answered (only `endsIn`, its last four characters, right after it is sent). Adding a contract
 * or a new number asks a fresh code (403 `stepUp`). The API's English `words` is dropped: the screen says its own.
 */

export const contractSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string().nullable(),
  siteCode: z.string().nullable(),
  carrierCode: z.string(),
  carrierName: z.string(),
  ownRatesOnly: z.boolean(),
  active: z.boolean(),
  numberOnFile: z.boolean(),
  usedForSite: z.boolean().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Contract = z.infer<typeof contractSchema>

/** GET /shipping/carrier-contracts?companyId&siteId&includeOff=true (shipping.settings.view). */
export const listContracts = (api: ApiClient, query: { companyId: string; siteId: string | null }, signal?: AbortSignal): Promise<Contract[]> =>
  api.get('/shipping/carrier-contracts', { query: { companyId: query.companyId, siteId: query.siteId ?? undefined, includeOff: 'true' }, schema: z.object({ contracts: z.array(contractSchema) }), signal }).then((answer) => answer.contracts)

/** POST /shipping/carrier-contracts (shipping.settings.manage + a fresh code): 201 {contract, endsIn}. */
export const addContract = (api: ApiClient, body: { companyId: string; siteId: string | null; carrierCode: string; accountNumber: string; ownRatesOnly: boolean }, idempotencyKey: string) =>
  api.post('/shipping/carrier-contracts', { body, schema: z.object({ contract: contractSchema, endsIn: z.string() }), idempotencyKey })

/** PATCH /shipping/carrier-contracts/:id: "use only our rates" and / or a new number (a fresh code). */
export const changeContract = (api: ApiClient, contractId: string, body: { version: number; ownRatesOnly?: boolean; accountNumber?: string }, idempotencyKey: string) =>
  api.request('PATCH', `/shipping/carrier-contracts/${encodeURIComponent(contractId)}`, { body, schema: z.object({ contract: contractSchema, endsIn: z.string().nullable() }), idempotencyKey })

/** POST …/switch-off: the number removed, the row kept; a new contract may cover the scope again. */
export const switchOffContract = (api: ApiClient, contractId: string, version: number, idempotencyKey: string) =>
  api.post(`/shipping/carrier-contracts/${encodeURIComponent(contractId)}/switch-off`, { body: { version }, schema: z.object({ contract: contractSchema }), idempotencyKey })
