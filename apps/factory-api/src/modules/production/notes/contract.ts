import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { NOTE_MENTIONS_MAX, NOTE_RECORD_TYPES, NOTE_RECORDS_MAX } from '@nexus/factory-domain/production-brand/notes'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { MAX_BODY_LENGTH } from '@nexus/factory-domain/threads/rules'

/**
 * B-PR-43a — note to N records and ask the supervisor (production plan §1, §3; lead pick L23; review fixes R-47, R-55). Office only.
 * The write takes an Idempotency-Key (one per batch). Refusals in words: the note itself or a mention that is no active office
 * person (400), none of the records seen (404, "None of these records was found."), seen but none writable (403), a text that
 * names another customer without the writer's tick (409 refusal/NAMES_OTHER_CUSTOMER, each such record at body/records/<index>).
 * A record the writer does not see is only counted (`unknown`), never named.
 */

const recordRef = input({ type: z.enum(NOTE_RECORD_TYPES), id: id() })
const recordView = output({ type: z.enum(NOTE_RECORD_TYPES), id: id(), label: z.string() })

/** The draft, the same for the check and the write. */
export const noteDraftShape = {
  /** Sales orders and work orders, 1 to 100, of one or several customers (internal notes only). */
  records: z.array(recordRef).min(1).max(NOTE_RECORDS_MAX),
  body: z.string().max(MAX_BODY_LENGTH),
  /** Office people to mention (each only on the records they read). */
  mentions: z.array(id()).max(NOTE_MENTIONS_MAX).optional(),
  /** "Ask the supervisor": each record's own production supervisor is mentioned on its note. */
  askSupervisor: z.boolean().optional(),
  /** "This text names no other customer": the writer confirms the text, where the check found another customer's name (R-47). */
  namesNoOtherCustomer: z.boolean().optional(),
  /**
   * B-PR-43b "Needs an answer": an issue on each record written on (a work order of several customers or of none raises none) and
   * ONE task per customer and supervisor, due at raise + 1 working day, 08:00 company time.
   */
  needsAnswer: z.boolean().optional(),
}

export const checkNotesContract = defineContract({
  body: input(noteDraftShape),
  response: {
    200: output({
      /** The records the writer sees, in the order picked. */
      records: z.array(
        output({
          type: z.enum(NOTE_RECORD_TYPES),
          id: id(),
          label: z.string(),
          customer: output({ id: id(), name: z.string() }).nullable(),
          canWrite: z.boolean(),
          why: z.string().nullable(),
          /** As a list says it: never a name. */
          supervisor: z.enum(SUPERVISOR_MARKS),
        }),
      ),
      /** Records the writer does not see: counted, never named. */
      unknown: z.number().int(),
      /** Different customers among the records seen (an office note never reaches any of them). */
      customers: z.number().int(),
      /** Each person mentioned and the writable records they cannot read (not mentioned there; the note is still written). */
      people: z.array(output({ userId: id(), name: z.string(), cannotRead: z.array(recordView) })),
      /** "Ask the supervisor" or "Needs an answer": the writable records that have none (their task goes to nobody yet). */
      noSupervisor: z.array(recordView),
      // B-PR-43b: "Needs an answer": the writable records that raise no issue (a work order of several customers or of none).
      noIssue: z.array(output({ type: z.enum(NOTE_RECORD_TYPES), id: id(), label: z.string(), why: z.string() })),
      /** The writable records whose text names another customer, with the names the writer may know. */
      namesOtherCustomer: z.array(output({ type: z.enum(NOTE_RECORD_TYPES), id: id(), label: z.string(), names: z.array(z.string()) })),
      /** Send is held: some text names another customer and the writer has not ticked "This text names no other customer". */
      held: z.boolean(),
    }),
  },
})

export const writeNotesContract = defineContract({
  body: input(noteDraftShape),
  response: {
    200: output({
      /** The batch every note of this action carries (threads' bell folds it into one item per reader). */
      batchId: id(),
      written: z.array(output({ type: z.enum(NOTE_RECORD_TYPES), id: id(), label: z.string(), messageId: id(), mentioned: z.array(id()), supervisorAsked: z.boolean(), /* B-PR-43b */ issueId: id().nullable() })),
      /** Records the writer sees that were not written on, each with why. */
      skipped: z.array(output({ type: z.enum(NOTE_RECORD_TYPES), id: id(), label: z.string(), why: z.string() })),
      /** Each person left out of some notes (they cannot read those records). */
      notMentioned: z.array(output({ userId: id(), records: z.array(recordView) })),
      /** Records the writer does not see: counted, never named. */
      unknown: z.number().int(),
      /**
       * B-PR-43b "Needs an answer" (null: not asked): the tasks made (each on a sales order: one per customer and supervisor; not
       * assigned: nobody may be given it there yet) and the records that raise no issue, with why.
       */
      issues: output({
        tasks: z.array(output({ taskId: id(), type: z.string(), id: id(), label: z.string(), assigned: z.boolean(), records: z.number().int() })),
        notRaised: z.array(output({ type: z.string(), id: id(), label: z.string(), why: z.string() })),
      }).nullable(),
    }),
  },
})
