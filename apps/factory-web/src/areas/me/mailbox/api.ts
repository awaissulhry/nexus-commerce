import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { MailboxMessage } from './model'

/**
 * B-W2b-F58: `GET /local/mailbox` — the local test server's FAKE mail (apps/factory-api platform/local; FACTORY_ENV=local
 * only). Elsewhere the API has no such route (404): the page then answers 404 too.
 */
const schema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      sentAt: z.string(),
      templateKey: z.string(),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      bcc: z.array(z.string()),
      subject: z.string(),
      text: z.string(),
      links: z.array(z.string()),
    }),
  ),
})

/** How many mails the page shows (the API keeps the newest 200). */
export const MAILBOX_LIMIT = 100

export type MailboxRead =
  | { kind: 'ok'; messages: MailboxMessage[] }
  /** Not the local test server: the route does not exist. */
  | { kind: 'absent' }
  | { kind: 'signed_out' }
  | { kind: 'failed'; code: string }

export async function readMailbox(api: ApiClient): Promise<MailboxRead> {
  try {
    const answer = await api.get('/local/mailbox', { query: { limit: MAILBOX_LIMIT }, schema })
    return { kind: 'ok', messages: answer.messages }
  } catch (error) {
    if (!isApiError(error)) throw error
    if (error.kind === 'not_found') return { kind: 'absent' }
    if (error.kind === 'signed_out') return { kind: 'signed_out' }
    return { kind: 'failed', code: error.code }
  }
}
