import { z } from 'zod'
import { APPROVAL_KINDS } from '@nexus/factory-domain/approvals-out/kinds'
import { SCAN_STATES } from '@nexus/factory-domain/product/techpack/scan'
import { BRAND_ROUND_STATUSES, STYLE_STAGES, WAITING_RECORD_TYPES } from '@nexus/factory-domain/sales/portal-samples/rules'
import { SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { readFromStore } from '../../../record-panels/store'

/**
 * What the brand's Samples & tech packs page reads (B-W2b-262's API; design portal.customer.samples, SCR-225): the page in
 * one answer (GET /portal/samples) and the logged open of a BRAND tech pack PDF. The decision itself is B-W2b-184's portal
 * answer, read and sent through Home's own calls (`../home/api`: fetchApproval, answerApproval, approvalFileBytes) so a
 * request is answered the same way from Home and from here. Each answer is checked; the web reads only what it uses. No
 * money and no office person ever comes.
 */

const words = z.object({ it: z.string(), en: z.string() })
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })
const roundRef = z.object({ id: z.string(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number(), label: words })

export const techPackSchema = z.object({
  id: z.string(),
  revision: z.number(),
  revisionStatus: z.enum(['DRAFT', 'RELEASED', 'OBSOLETE']).catch('DRAFT'),
  version: z.number(),
  language: z.string(),
  printed: z.string(),
  createdAt: z.string(),
  state: z.enum(SCAN_STATES).catch('CURRENT'),
})
export type TechPack = z.infer<typeof techPackSchema>

export const waitingSchema = z.object({
  requestId: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  recordType: z.enum(WAITING_RECORD_TYPES),
  recordId: z.string(),
  label: words,
  style: style.nullable(),
  round: roundRef.nullable(),
  swatch: z.object({ id: z.string(), kind: z.enum(['COLOUR', 'LEATHER']) }).nullable(),
  question: z.string(),
  askedAt: z.string(),
  dueAt: z.string(),
  receivedAt: z.string().nullable(),
  version: z.number(),
})
export type WaitingRead = z.infer<typeof waitingSchema>

export const styleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  season: z.string().nullable(),
  stage: z.enum(STYLE_STAGES).catch('IN_DEVELOPMENT'),
  latestRound: z.object({ id: z.string(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number(), status: z.enum(BRAND_ROUND_STATUSES) }).nullable(),
  nextDate: z.string().nullable(),
  waiting: z.number(),
  openRounds: z.number(),
  techPack: techPackSchema.nullable(),
  techPacks: z.array(techPackSchema),
})
export type StyleRead = z.infer<typeof styleSchema>

export const roundSchema = z.object({
  id: z.string(),
  number: z.string(),
  kind: z.enum(SAMPLE_KINDS),
  roundNo: z.number(),
  label: words,
  style,
  status: z.enum(BRAND_ROUND_STATUSES),
  stage: z.enum(SAMPLE_STAGES),
  decision: z.enum(SAMPLE_DECISIONS).nullable(),
  decidedAt: z.string().nullable(),
  dueDate: z.string().nullable(),
  pieces: z.number(),
  shipment: z.object({ carrierName: z.string().nullable(), trackingNumber: z.string().nullable(), trackingUrl: z.string().nullable(), sentAt: z.string().nullable(), receivedAt: z.string().nullable() }).nullable(),
  waitingRequestId: z.string().nullable(),
  createdAt: z.string(),
})
export type RoundRead = z.infer<typeof roundSchema>

export const samplesSchema = z.object({
  asOf: z.string(),
  mayApprove: z.boolean(),
  waiting: z.array(waitingSchema).nullable(),
  styles: z.array(styleSchema),
  rounds: z.array(roundSchema),
  counts: z.object({ waiting: z.number().nullable(), styles: z.number(), rounds: z.number(), open: z.number() }),
})
export type SamplesRead = z.infer<typeof samplesSchema>

export const fetchSamples = (api: ApiClient, signal?: AbortSignal): Promise<SamplesRead> => api.get('/portal/samples', { schema: samplesSchema, signal })

const openSchema = z.object({
  techPack: z.object({ id: z.string(), styleCode: z.string(), revision: z.number(), version: z.number(), language: z.string(), printed: z.string(), name: z.string() }),
  download: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})

/** A BRAND tech pack PDF's bytes (ONE logged open: the API writes the audit row, then the 60-second address is read at once). */
export async function techPackBytes(api: ApiClient, documentId: string, mode: 'preview' | 'download'): Promise<{ name: string; bytes: Uint8Array }> {
  const answer = await api.post(`/portal/samples/tech-packs/${encodeURIComponent(documentId)}/download`, { body: { mode }, schema: openSchema, idempotencyKey: newIdempotencyKey() })
  const bytes = await readFromStore({ method: 'GET', url: answer.download.url, headers: answer.download.headers, expiresAt: answer.download.expiresAt })
  return { name: answer.techPack.name, bytes }
}
