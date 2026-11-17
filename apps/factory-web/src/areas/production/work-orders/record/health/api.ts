import { z } from 'zod'
import { BRAND_HEALTHS, HEALTH_REASON_CODES, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-PR-05a — the health of a work order's sales order(s) as the office reads and steers it (B-PR-35, apps/factory-api
 * modules/production/brand/contract.ts): GET reads the computed health, the health the customer reads, a person's raise with the
 * office's own note, and who the order waits on; PUT raises it to At risk with a curated reason (and an office-only note); DELETE
 * clears the raise. Every write sends the production state's version as read. The answer's shape is checked (unknown fields dropped).
 * Another customer's order answers 404 in the words of an unknown id (the brand wall is the API's): this page asks only for the
 * work order's own orders.
 */

const person = z.object({ id: z.string(), name: z.string() })

export const brandHealthSchema = z.object({
  orderId: z.string(),
  number: z.string(),
  partyId: z.string(),
  kept: z.boolean(),
  computed: z.enum(BRAND_HEALTHS).nullable(),
  health: z.enum(BRAND_HEALTHS).nullable(),
  reasonCode: z.enum(HEALTH_REASON_CODES).nullable(),
  raise: z
    .object({
      reasonCode: z.enum(HEALTH_REASON_CODES),
      note: z.string().nullable(),
      setAt: z.string(),
      setBy: person.nullable(),
      until: z.string(),
      stands: z.boolean(),
    })
    .nullable(),
  waitingOn: z.enum(WAITING_ON).nullable(),
  waitingSince: z.string().nullable(),
  version: z.number().nullable(),
})
export type BrandHealthView = z.infer<typeof brandHealthSchema>

const oneHealth = z.object({ health: brandHealthSchema })
const path = (orderId: string) => `/production/brand-orders/${encodeURIComponent(orderId)}/health`

/** GET — the order's health as the office reads it (workorders.view over its company and customer). */
export async function getBrandHealth(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<BrandHealthView> {
  return (await api.get(path(orderId), { schema: oneHealth, signal })).health
}

/** PUT — raise to At risk (production.brand.manage): a curated reason the customer reads, an office-only note. */
export async function raiseBrandHealth(api: ApiClient, orderId: string, body: { reasonCode: HealthReasonCode; note: string | null; version: number | null }, idempotencyKey: string): Promise<BrandHealthView> {
  return (
    await api.request('PUT', path(orderId), {
      body: { reasonCode: body.reasonCode, ...(body.note ? { note: body.note } : {}), ...(body.version !== null ? { version: body.version } : {}) },
      schema: oneHealth,
      idempotencyKey,
    })
  ).health
}

/** DELETE — clear the raise (production.brand.manage); the computed health speaks again. */
export async function clearBrandHealth(api: ApiClient, orderId: string, version: number | null, idempotencyKey: string): Promise<BrandHealthView> {
  return (await api.request('DELETE', path(orderId), { query: version !== null ? { version } : {}, schema: oneHealth, idempotencyKey })).health
}
