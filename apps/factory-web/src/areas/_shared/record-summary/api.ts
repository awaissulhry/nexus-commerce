import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * B-TH-272 (threads plan TH-6, PL5; O-REC-ANY.summary, O-REC-ANY.thread) — the generic record page's calls, through the ONE client:
 *
 *   GET /records/<type>/<id>/summary   B-TH-076: the record's type in words, its label, its state in words and its parent as a link,
 *                                      in the reader's own scope (404 for a record outside it, in neutral words: never "someone
 *                                      else's"; the parent only when the reader may open it too).
 *                                      Follow-up (th9-web-b): the office answer also names the record's party (who "Reply to"
 *                                      writes to), before the first message too; the portal answer never does.
 *   GET /parties/<id>                  the party's roles (parties.view), for the head's words ("Waiting on customer" / "supplier").
 *
 * Each answer is checked against the shape the page reads; a field it does not read is ignored, so a new field never breaks it.
 */

const enc = encodeURIComponent

const words = z.object({ it: z.string(), en: z.string() })
const link = z.object({ recordType: z.string(), recordId: z.string(), type: words, label: z.string().nullable() })

export const summarySchema = z.object({
  summary: z.object({
    recordType: z.string(),
    recordId: z.string(),
    type: words,
    label: z.string().nullable(),
    /** The portal reader's own reference; always null in the office answer (kept for the shape). */
    theirRef: z.string().nullable().default(null),
    state: z.object({ code: z.string(), words }).nullable(),
    parent: link.nullable(),
    // ---- follow-up (th9-web-b): office only — the record's party (null: none, or a record never shared); absent in a portal answer.
    party: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    // ---- end follow-up
  }),
})

export type RecordSummary = z.infer<typeof summarySchema>['summary']
export type SummaryWords = z.infer<typeof words>
export type SummaryLink = z.infer<typeof link>

export interface SummaryKey {
  readonly type: string
  readonly id: string
}

/** GET /records/<type>/<id>/summary (threads.read over the record; 404 outside the reader's scope). */
export async function readRecordSummary(api: ApiClient, record: SummaryKey, signal?: AbortSignal): Promise<RecordSummary> {
  const answer = await api.get(`/records/${enc(record.type)}/${enc(record.id)}/summary`, { schema: summarySchema, signal })
  return answer.summary
}

const partyAnswer = z.object({ party: z.object({ id: z.string(), legalName: z.string(), tradeName: z.string().nullable().optional(), roles: z.array(z.string()).default([]) }).passthrough() })

export interface PartyFacts {
  readonly id: string
  readonly name: string
  readonly roles: readonly string[]
}

/** GET /parties/<id> (parties.view): the party's name and roles (the generic page reads its roles: the name comes with the summary). */
export async function readPartyFacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<PartyFacts> {
  const answer = await api.get(`/parties/${enc(partyId)}`, { schema: partyAnswer, signal })
  return { id: answer.party.id, name: answer.party.legalName, roles: answer.party.roles }
}
