import { z } from 'zod'
import { portalSignInHead, type PortalSignInHead } from '@nexus/factory-domain/branding/contracts'
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { CLAIM_HELD, PAPER_KINDS, STEP_STATES, TRACKING_PILLS, TRACKING_PROBLEMS, TRACKING_STEPS, TRACKING_VIAS } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { presignedSchema, type Presigned } from '../../record-panels/api'
import { StoreError, storeHeaders, storeUrl } from '../../record-panels/store'

/**
 * Track an order's calls (B-W2b-170; apps/factory-api modules/shipping/tracking-link; LOG-062): the tracking page of a
 * SHIPMENT_TRACK link (`GET /link/tracking`: codes and numbers only — the page says every word in the reader's language),
 * a paper's logged download, "Report a problem" (B-W2b-192's `POST /link/tracking/claim` → a claim link's address),
 * "Ask for a new link" (B-W2b-163's public `POST /link/renew`), and the public search of `/t` (`POST /tracking/search`,
 * whose page heads with the company's public branding: `GET /branding/portal-sign-in`). The link's token travels only in
 * `x-factory-link` (the client the landing made); a token the search answers stays in this page's memory.
 */

const instant = z.string()

export const trackingPageSchema = z.object({
  shipment: z.object({
    number: z.string(),
    status: z.enum(SHIPMENT_STATUSES),
    transportBy: z.enum(['SENDER', 'RECIPIENT', 'CARRIER']),
    carrierName: z.string().nullable(),
    packedAt: instant.nullable(),
    shippedAt: instant.nullable(),
    deliveredAt: instant.nullable(),
    returnedAt: instant.nullable(),
    expectedDeliveryAt: instant.nullable(),
  }),
  order: z.object({ customerRef: z.string().nullable(), number: z.string().nullable() }),
  pill: z.enum(TRACKING_PILLS),
  problem: z.enum(TRACKING_PROBLEMS).nullable(),
  steps: z.array(z.object({ code: z.enum(TRACKING_STEPS), state: z.enum(STEP_STATES), at: instant.nullable() })),
  parcels: z.array(z.object({ seq: z.number(), trackingNumber: z.string().nullable(), carrierPage: z.string().nullable(), status: z.enum(TRACKING_STATUSES).nullable() })),
  events: z.array(z.object({ id: z.string(), status: z.enum(TRACKING_STATUSES), place: z.string().nullable(), occurredAt: instant, parcelSeq: z.number().nullable() })),
  delivery: z.object({ city: z.string().nullable(), postcode: z.string().nullable(), country: z.string().nullable() }),
  papers: z.object({
    shown: z.boolean(),
    files: z.array(
      z.object({
        fileId: z.string(),
        kind: z.enum(PAPER_KINDS),
        number: z.string().nullable(),
        style: z.object({ code: z.string(), name: z.string() }).nullable(),
        language: z.string().nullable(),
        originalName: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
      }),
    ),
  }),
  claim: z.object({ held: z.enum(CLAIM_HELD).nullable() }),
  link: z.object({ endsAt: instant, via: z.enum(TRACKING_VIAS).nullable() }),
  timeZone: z.string(),
})
export type TrackingPage = z.infer<typeof trackingPageSchema>
export type Paper = TrackingPage['papers']['files'][number]

/** The tracking page (`GET /link/tracking`); reading uses nothing. */
export const readTracking = (api: ApiClient, signal?: AbortSignal): Promise<TrackingPage> => api.get('/link/tracking', { schema: trackingPageSchema, signal })

const downloadSchema = z.object({ fileId: z.string(), name: z.string(), download: presignedSchema })

/** A paper: the API logs it (DOWNLOADED on the link, an audit row on the file) under the key, then presigns it for 60 s. */
export async function downloadPaper(api: ApiClient, fileId: string, idempotencyKey: string): Promise<Presigned> {
  const answer = await api.post(`/link/tracking/papers/${encodeURIComponent(fileId)}/download`, { body: {}, schema: downloadSchema, idempotencyKey })
  return answer.download
}

/** The bytes behind a presigned GET (the store's request: no token, no cookie of the API). */
export async function presignedBytes(download: Presigned, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(storeUrl(download.url), { method: download.method, headers: storeHeaders(download), credentials: 'omit', cache: 'no-store', signal })
  if (!response.ok) throw new StoreError(response.status)
  return new Uint8Array(await response.arrayBuffer())
}

const claimSchema = z.object({ link: z.object({ id: z.string(), expiresAt: z.string() }), url: z.string().nullable() })

/** "Report a problem with this delivery": a claim link for the same shipment (B-W2b-192), its address once. */
export function reportProblem(api: ApiClient, idempotencyKey: string): Promise<z.infer<typeof claimSchema>> {
  return api.post('/link/tracking/claim', { body: {}, schema: claimSchema, idempotencyKey })
}

const renewSchema = z.object({ status: z.literal('requested'), message: z.string() })

/** "Ask for a new link" (public, the dead token in `x-factory-link`): one answer whatever the token. */
export function askForNewLink(api: ApiClient): Promise<z.infer<typeof renewSchema>> {
  return api.post('/link/renew', { body: {}, schema: renewSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- the public search (/t) -----------------------------------------------------------------------------------------

export type SearchHead = PortalSignInHead
const headAnswer = z.object({ head: portalSignInHead })

/** Whose tracking search this is (the company named by the address), for the page's head and whom to ask. */
export function readSearchHead(api: ApiClient, address: { readonly tenant: string; readonly company: string | null }): Promise<SearchHead> {
  return api.get('/branding/portal-sign-in', { query: { tenant: address.tenant, company: address.company ?? undefined }, schema: headAnswer }).then((answer) => answer.head)
}

export const searchAnswerSchema = z.object({ shipments: z.array(z.object({ token: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), shippedAt: z.string().nullable() })) })
export type SearchAnswer = z.infer<typeof searchAnswerSchema>

export interface SearchBody {
  readonly tenant: string
  readonly company: string | null
  readonly reference: string
  readonly postcode: string
  readonly proof?: { readonly challenge: string; readonly nonce: string }
}

/** `POST /tracking/search`: a one-day link per shipment found, or none (one answer for a miss). */
export function searchShipments(api: ApiClient, body: SearchBody, signal?: AbortSignal): Promise<SearchAnswer> {
  return api.post('/tracking/search', {
    body: { tenant: body.tenant, ...(body.company ? { company: body.company } : {}), reference: body.reference, postcode: body.postcode, ...(body.proof ? { proof: body.proof } : {}) },
    schema: searchAnswerSchema,
    signal,
  })
}

const challengeSchema = z.object({ challenge: z.string(), bits: z.number().int() })

/** A proof-of-work challenge for this network (asked only after the API answered 429 `challenge`). */
export const readChallenge = (api: ApiClient): Promise<z.infer<typeof challengeSchema>> => api.get('/abuse/challenge', { query: { policy: 'public.lookup' }, schema: challengeSchema })
