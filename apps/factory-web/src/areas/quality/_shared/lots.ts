import { z } from 'zod'
import { CR_VI_STATUSES } from '@nexus/factory-domain/planning/usable'
import { CR_VI_EVIDENCE } from '@nexus/factory-domain/quality/lab/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * A lot as the lab module shows it (apps/factory-api modules/quality/lab contract `lotView`; `GET /quality/lots` and
 * `GET /quality/lots/:lotId`), shared by Inspections (the lots on hold, Owner answer Q3) and Tests & substances (SCR-054).
 * Unknown fields are ignored, so a new field on the API never breaks a page.
 */

export const LOT_STATUSES = ['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'] as const
export type LotStatus = (typeof LOT_STATUSES)[number]

export const lotSchema = z.object({
  id: z.string(),
  code: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), isPpeComponent: z.boolean() }),
  itemColourId: z.string().nullable(),
  supplierId: z.string().nullable(),
  supplierLotRef: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  shade: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receivedById: z.string().nullable(),
  receipt: z.object({ id: z.string(), number: z.string(), status: z.enum(['OPEN', 'POSTED', 'REVERSED', 'CANCELLED']) }).nullable(),
  qualityStatus: z.enum(LOT_STATUSES),
  qualityNote: z.string().nullable(),
  qualityDecidedAt: z.string().nullable(),
  qualityDecidedById: z.string().nullable(),
  hold: z.string().nullable(),
  crVi: z.object({
    required: z.boolean(),
    status: z.enum(CR_VI_STATUSES),
    limitMgKg: z.string().nullable(),
    valueMgKg: z.string().nullable(),
    evidence: z.enum(CR_VI_EVIDENCE).nullable(),
    testedOn: z.string().nullable(),
  }),
  /** The lot's state in one sentence (the API's words: English, kept as data). */
  words: z.string(),
  version: z.number(),
})
export type Lot = z.infer<typeof lotSchema>

export interface LotQuery {
  readonly status?: LotStatus | null
  /** QUARANTINE or BLOCKED (not usable). */
  readonly onHold?: boolean
  readonly q?: string | null
  readonly limit?: number
}

/** `GET /quality/lots`: newest received first, at most `limit` (200 at most; the list has no cursor). */
export async function listLots(api: ApiClient, query: LotQuery, signal?: AbortSignal): Promise<Lot[]> {
  const answer = await api.get('/quality/lots', {
    query: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.onHold ? { onHold: 'true' } : {}),
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      limit: query.limit ?? 50,
    },
    schema: z.object({ lots: z.array(lotSchema) }),
    signal,
  })
  return answer.lots
}

/** The tone of a lot's quality status. */
export const LOT_TONE: Record<LotStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  QUARANTINE: 'warning',
  RELEASED: 'success',
  REJECTED: 'neutral',
  BLOCKED: 'danger',
}

/** The tone of a lot's Cr VI state. */
export const CR_VI_TONE: Record<(typeof CR_VI_STATUSES)[number], 'success' | 'warning' | 'danger' | 'neutral'> = {
  NOT_REQUIRED: 'neutral',
  PENDING: 'warning',
  PASS: 'success',
  FAIL: 'danger',
}

/** The largest page the lists read (the API has no cursor: "Show more" reads a larger page, up to this). */
export const LIST_MAX = 200
