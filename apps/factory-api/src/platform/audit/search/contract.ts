import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { fieldLineView } from '../../threads/contract'
import { AUDIT_AUDIENCES, AUDIT_VIEWS, auditListEntry, RECORD_TYPE } from '../contract'

/**
 * The audit viewer's search (B-W2b-399; PLT-077; design admin.audit "Table view" filters: who, record, action, surface,
 * company and site, date range, IP), audit.read over the rows (as GET /audit):
 *
 *   GET /audit/search                  the entries matching every filter given, newest first, each with its field lines
 *                                      ("price 480 → 520"; a money field of a grain the reader lacks named as hidden) and
 *                                      the actor's name (an office person; a floor worker never). `ip`: the address typed,
 *                                      matched through the sessions signed in from it (Session.ipHash: the rows their
 *                                      people wrote while those sessions lived; `ipMatch` SESSIONS) — the audit row keeps no
 *                                      address of its own (a schema need for an exact match).
 *   GET /audit/entries/:entryId        one entry: before and after (money only with its grain), its lines, its context (the
 *                                      request, the Idempotency-Key, the device and its time, the country of the session it
 *                                      was written in when one is known), the other rows of the same request, and the record
 *                                      it names (type and id: the screens open it).
 * The export of a search is the list's export (`admin.audit`, search/export-source.ts).
 */

export const searchQuery = {
  actorId: id().optional(),
  audience: z.enum(AUDIT_AUDIENCES).optional(),
  recordType: z.string().regex(RECORD_TYPE).optional(),
  recordId: id().optional(),
  /** An action, or the start of one (`roles.` for every role write). */
  action: z.string().regex(/^[a-z][A-Za-z0-9.]{0,99}$/).optional(),
  /** An IPv4 or IPv6 address (matched through the sessions signed in from it). */
  ip: z.string().trim().min(2).max(45).optional(),
  companyId: id().optional(),
  siteId: id().optional(),
  requestId: z.string().min(1).max(100).optional(),
  view: z.enum(AUDIT_VIEWS).optional(),
  from: instant().optional(),
  to: instant().optional(),
}

export const searchEntry = auditListEntry.extend({
  /** The changed fields from → to (platform/threads/timeline/field-lines.ts), money of a grain the reader lacks as hidden. */
  lines: z.array(fieldLineView),
})
export type SearchEntryView = z.infer<typeof searchEntry>

export const searchContract = defineContract({
  querystring: input({ ...searchQuery, before: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      entries: z.array(searchEntry),
      nextBefore: id().nullable(),
      /** How the address was matched: SESSIONS (through the sessions signed in from it); null without an address. */
      ipMatch: z.enum(['SESSIONS']).nullable(),
    }),
  },
})

export const entryContract = defineContract({
  params: input({ entryId: id() }),
  response: {
    200: output({
      entry: searchEntry,
      context: output({
        /** The country of the office session the row was written in, when exactly one was live then and it is known. */
        ipCountry: z.string().nullable(),
        serverTime: instant(),
        deviceTime: instant().nullable(),
      }),
      /** The other rows the same request wrote (at most 50), oldest first. */
      siblings: z.array(output({ id: id(), at: instant(), action: z.string(), recordType: z.string(), recordId: id(), before: grainedJson(), after: grainedJson() })),
    }),
  },
})
