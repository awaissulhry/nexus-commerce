import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The search index's events (plan A1 §3.4; B-W2a-32; PLT-153). The index itself follows the records' own events (the
 * worker's handler `search.index`, apps/factory-api platform/search): it emits nothing for them. One event of its own:
 *
 *   search.rebuild_requested  a person (search.rebuild) asked for the tenant's index to be read again from the records,
 *                             all record types or the ones named; the worker's handler `search.rebuild` does it, one
 *                             command per page of records. A replay of the event writes nothing new.
 *
 * Record type names only: never a record's words. No live rule (nothing on a screen changes until entries change).
 */
export const events = [
  defineEvent({
    type: 'search.rebuild_requested',
    context: 'search',
    description: "The tenant's search index is to be read again from its records (every record type, or the ones named).",
    payload: z.strictObject({
      /** The record types to read again (the API's model names); null: every type that has an indexer. */
      recordTypes: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]*$/)).min(1).max(100).nullable(),
      requestedById: z.uuid().nullable(),
    }),
  }),
] as const
