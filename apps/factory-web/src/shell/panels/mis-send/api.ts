import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { MIS_SEND_WARNINGS, RECIPIENT_KINDS, RECIPIENT_SOURCES, type MisSendCheck, type MisSendDraft } from './model'

/**
 * The mis-send guard's one call (apps/factory-api platform/email-out/mis-send; B-W2b-397): `POST
 * /threads/:recordType/:recordId/emails/check` with what the composer holds. Read only on the API's side: no
 * Idempotency-Key, nothing written. The answer is checked against the codes the screen knows.
 */

const organisation = z.object({ id: z.string(), name: z.string() })
const checkSchema = z.object({
  party: organisation.nullable(),
  recipients: z.array(z.object({ address: z.string(), kind: z.enum(RECIPIENT_KINDS), source: z.enum(RECIPIENT_SOURCES).nullable(), organisation: organisation.nullable(), personName: z.string().nullable() })),
  warnings: z.array(z.object({ code: z.enum(MIS_SEND_WARNINGS), items: z.array(z.string()) })),
  attachments: z.array(z.object({ id: z.string(), name: z.string(), sizeBytes: z.number().int(), audience: z.enum(['PARTY', 'OFFICE']) })),
})

const enc = encodeURIComponent

export async function checkMisSend(api: ApiClient, record: { readonly type: string; readonly id: string }, draft: MisSendDraft, signal?: AbortSignal): Promise<MisSendCheck> {
  const subject = draft.subject.trim()
  return api.post(`/threads/${enc(record.type)}/${enc(record.id)}/emails/check`, {
    body: { to: [...draft.to], ...(subject ? { subject } : {}), body: draft.body, attachments: [...draft.attachments] },
    schema: checkSchema,
    signal,
  })
}

/** Why the check could not run (a key of `mail-depth`) and whether trying again may help. */
export function checkProblem(error: unknown): { problem: string; retry: boolean } {
  if (!isApiError(error)) return { problem: 'misSend.problem.failed', retry: true }
  switch (error.kind) {
    case 'forbidden':
    case 'step_up':
      return { problem: 'misSend.problem.forbidden', retry: false }
    case 'not_found':
      return { problem: 'misSend.problem.notFound', retry: false }
    case 'invalid':
      return { problem: 'misSend.problem.invalid', retry: false }
    case 'signed_out':
      return { problem: 'misSend.problem.signedOut', retry: false }
    case 'rate_limited':
      return { problem: 'misSend.problem.rateLimited', retry: true }
    case 'unavailable':
      return { problem: 'misSend.problem.unavailable', retry: true }
    default:
      return { problem: 'misSend.problem.failed', retry: true }
  }
}
