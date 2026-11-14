import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { auditEntrySchema, listAudit, type AuditPage, type AuditQuery } from '../api'

/**
 * The audit search in depth (B-W2b-413 on B-W2b-399's API; PLT-077; design admin.audit "Table view" filters + "IP (W2b)"):
 * with an address typed the log is read from `GET /audit/search` (the same filters, matched through the sessions signed in
 * from it: `ipMatch` SESSIONS), else from `GET /audit` as before; one entry's context (`GET /audit/entries/:id`) gives the
 * country of the session it was written in, when one is known ("IP in the table"). The export follows the address (its
 * `ip`, `from`, `to` terms are the export source's).
 */

const searchAnswer = z.object({ entries: z.array(auditEntrySchema), nextBefore: z.string().nullable(), ipMatch: z.enum(['SESSIONS']).nullable() })
const entryAnswer = z.object({ context: z.object({ ipCountry: z.string().nullable(), serverTime: z.string(), deviceTime: z.string().nullable() }) })

/** One page of the log: the search when an address is typed (no tile counts there), else `GET /audit`. */
export async function readAudit(api: ApiClient, query: AuditQuery): Promise<AuditPage> {
  if (!query.ip) return listAudit(api, query)
  const answer = await api.get('/audit/search', {
    query: {
      actorId: query.actorId ?? undefined,
      audience: query.audience ?? undefined,
      recordType: query.recordType ?? undefined,
      recordId: query.recordId ?? undefined,
      action: query.action ?? undefined,
      ip: query.ip,
      companyId: query.companyId ?? undefined,
      siteId: query.siteId ?? undefined,
      requestId: query.requestId ?? undefined,
      view: query.view ?? undefined,
      from: query.from ?? undefined,
      to: query.to ?? undefined,
      before: query.before ?? undefined,
      limit: query.limit,
    },
    schema: searchAnswer,
  })
  return { entries: answer.entries, nextBefore: answer.nextBefore, counts: null }
}

/** The country of the office session an entry was written in (null: none known). */
export const entryCountry = (api: ApiClient, entryId: string) => api.get(`/audit/entries/${encodeURIComponent(entryId)}`, { schema: entryAnswer }).then((answer) => answer.context.ipCountry)
