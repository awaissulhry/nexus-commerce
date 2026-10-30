import { z } from 'zod'
import { CHECK_CODES } from '@nexus/factory-domain/quality/lab/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * The lot record's read of the quality step (modules/quality/lab): the release checklist for the viewer
 * (`GET /quality/lots/:lotId/release-check`, quality.lots.view). Each check is drawn in this app's words from its code
 * and state; the API's sentences (`words`, `fix`) are English and never drawn. The decisions themselves (release, block,
 * reject, a Cr VI result, documents) stay in Compliance › Tests & substances: ONE edit path.
 */

export const QUALITY_CHECK_CODES = CHECK_CODES
export type CheckCode = (typeof CHECK_CODES)[number]

const checkSchema = z.object({ code: z.enum(CHECK_CODES), state: z.enum(['OK', 'OPEN', 'NOT_NEEDED']), fix: z.string().nullable() })
export type ReleaseCheck = z.infer<typeof checkSchema>
const releaseCheckSchema = z.object({
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.enum(['QUARANTINE', 'RELEASED', 'BLOCKED', 'REJECTED']), version: z.number() }),
  checklist: z.object({ mode: z.enum(['RELEASE', 'UNBLOCK']), checks: z.array(checkSchema), ready: z.boolean() }),
})
export type ReleaseChecklist = z.infer<typeof releaseCheckSchema>['checklist']

export const releaseCheck = async (api: ApiClient, lotId: string, signal?: AbortSignal): Promise<ReleaseChecklist> =>
  (await api.get(`/quality/lots/${encodeURIComponent(lotId)}/release-check`, { schema: releaseCheckSchema, signal })).checklist
