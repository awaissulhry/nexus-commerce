import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { READ_LOG_RECORD_TYPES } from './registry'

/**
 * Who looked (B-W2b-399; PLT-074; design admin.audit "Who looked"; Owner answer W2b-6 question 3 = A), for administrators and
 * the Owner only (audit.reads.view over every company). Rows, never a figure: no count, no total, no grouping by person.
 *
 *   GET  /audit/reads?recordType&recordId        the reads of ONE record, newest first ("Lucia downloaded cost sheet JK-210 ·
 *                                                10:40"): who, how (VIEW, DOWNLOAD, EXPORT), where (OFFICE, API, SYSTEM), when
 *   POST /audit/reads/person {userId, reason}    one person's reads, only on this explicit search: the reason (3 to 500
 *                                                characters) is an audit row on the person (`audit.searchReadsOfPerson`),
 *                                                written before any row is read
 * Paging: `before` = the last row's id; `nextBefore` null on the last page.
 */

export const READ_ACTIONS = ['VIEW', 'DOWNLOAD', 'EXPORT'] as const
export const READ_SURFACES = ['OFFICE', 'API', 'SYSTEM'] as const

const page = { before: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }

export const recordReadView = output({
  id: id(),
  at: instant(),
  action: z.enum(READ_ACTIONS),
  surface: z.enum(READ_SURFACES),
  reader: output({ id: id(), name: z.string().nullable() }),
})
export type RecordReadView = z.infer<typeof recordReadView>

export const recordReadsContract = defineContract({
  querystring: input({ recordType: z.enum(READ_LOG_RECORD_TYPES), recordId: id(), ...page }),
  response: { 200: output({ reads: z.array(recordReadView), nextBefore: id().nullable() }) },
})

export const personReadView = output({
  id: id(),
  at: instant(),
  action: z.enum(READ_ACTIONS),
  surface: z.enum(READ_SURFACES),
  record: output({ type: z.enum(READ_LOG_RECORD_TYPES), id: id() }),
})
export type PersonReadView = z.infer<typeof personReadView>

export const personReadsContract = defineContract({
  body: input({
    userId: id(),
    /** Why this person's reads are looked at: kept as the audit row's reason. */
    reason: z.string().trim().min(3).max(500),
    from: instant().optional(),
    to: instant().optional(),
    ...page,
  }),
  response: { 200: output({ person: output({ id: id(), name: z.string() }), reads: z.array(personReadView), nextBefore: id().nullable() }) },
})

/**
 * B-W2b-413: whether the read log is on (THE SWITCH, switch.ts; GATE-PRIVACY): off on staging and production until the staff
 * notice carries its line, so "Who looked" says so instead of showing an empty log as if nobody looked.
 */
export const readLogStatusContract = defineContract({ response: { 200: output({ on: z.boolean() }) } })
