import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * The owner digest (B-W2b-435; ANA-032): GET|PUT /insights/digest, PUT /insights/digest/switch, GET /insights/digest/preview, POST
 * /insights/digest/test — checked by their schemas (unknown fields dropped). The shapes mirror apps/factory-api
 * modules/insights/digest/contract.ts. The preview's mail lines are the e-mail itself, as it would go out, in the language asked.
 */

export const DIGEST_SECTIONS = ['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'] as const
export type DigestSection = (typeof DIGEST_SECTIONS)[number]
export type DigestLocale = 'it' | 'en'

const locale = z.enum(['it', 'en'])
const section = z.enum(DIGEST_SECTIONS)

export const digestSchema = z.object({
  asOf: z.string(),
  setting: z.object({
    saved: z.boolean(),
    enabled: z.boolean(),
    enabledAt: z.string().nullable(),
    companyId: z.string().nullable(),
    sendTime: z.string(),
    timeZone: z.string(),
    weekdays: z.array(z.number()),
    locale,
    sections: z.array(section),
    lastSentAt: z.string().nullable(),
    version: z.number(),
  }),
  email: z.string().nullable(),
  held: z.enum(['OFF', 'MAIL_OFF']).nullable(),
  nextAt: z.string().nullable(),
  companies: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      timeZone: z.string(),
      mailOn: z.boolean(),
      mailOnAt: z.string().nullable(),
      maySwitch: z.boolean(),
      switchVersion: z.number(),
      recipients: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean(), group: z.boolean(), sendTime: z.string(), timeZone: z.string(), locale })).nullable(),
    }),
  ),
})
export type Digest = z.infer<typeof digestSchema>
export type DigestSetting = Digest['setting']
export type DigestCompany = Digest['companies'][number]

const itemSchema = z.object({ label: z.string(), days: z.number().nullable(), place: z.string().nullable(), record: z.object({ type: z.string(), id: z.string() }).nullable() })

export const previewSchema = z.object({
  asOf: z.string(),
  locale,
  companyId: z.string().nullable(),
  day: z.string(),
  today: z.string(),
  companies: z.array(z.string()),
  wouldSend: z.boolean(),
  sections: z.array(
    z.object({
      section,
      state: z.enum(['READY', 'NO_ACCESS', 'FAILED']),
      count: z.number(),
      extra: z.number().nullable(),
      percent: z.string().nullable(),
      // Money only with its grain: absent for a reader without it.
      priceValue: z.number().nullable().optional(),
      costValue: z.number().nullable().optional(),
      currency: z.string().nullable(),
      items: z.array(itemSchema),
    }),
  ),
  mail: z.object({ subject: z.string(), lines: z.array(z.string()), to: z.string().nullable() }),
})
export type DigestPreview = z.infer<typeof previewSchema>
export type PreviewSection = DigestPreview['sections'][number]

export interface SaveDigestBody {
  readonly enabled: boolean
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: DigestLocale
  readonly sections: readonly DigestSection[]
  readonly companyId: string | null
  readonly version: number
}

export function getDigest(api: ApiClient, signal?: AbortSignal): Promise<Digest> {
  return api.get('/insights/digest', { schema: digestSchema, signal })
}

/** PUT /insights/digest: my morning e-mail at the version read (0: never saved). */
export function saveDigest(api: ApiClient, body: SaveDigestBody): Promise<Digest> {
  return api.request('PUT', '/insights/digest', { body, schema: digestSchema, idempotencyKey: newIdempotencyKey() })
}

/** PUT /insights/digest/switch: a company's morning e-mail on or off (the owner's), at the version read (0: never switched). */
export function switchDigestMail(api: ApiClient, body: { companyId: string; on: boolean; version: number }): Promise<Digest> {
  return api.request('PUT', '/insights/digest/switch', { body, schema: digestSchema, idempotencyKey: newIdempotencyKey() })
}

/** GET /insights/digest/preview: today's digest as it would go out (a draft's company and sections, when editing). */
export function getPreview(api: ApiClient, query: { locale: DigestLocale; companyId?: string | null; sections?: readonly DigestSection[] }, signal?: AbortSignal): Promise<DigestPreview> {
  return api.get('/insights/digest/preview', {
    query: { locale: query.locale, ...(query.companyId !== undefined ? { companyId: query.companyId ?? 'all' } : {}), ...(query.sections ? { sections: query.sections.join(',') } : {}) },
    schema: previewSchema,
    signal,
  })
}

/** POST /insights/digest/test: "Send me a test" now. */
export function sendTest(api: ApiClient, body: { locale: DigestLocale }): Promise<{ sent: boolean; to: string; subject: string }> {
  return api.post('/insights/digest/test', { body, schema: z.object({ sent: z.boolean(), to: z.string(), subject: z.string() }), idempotencyKey: newIdempotencyKey() })
}
