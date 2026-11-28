import type { z } from 'zod'
import { badEventRefusal, moduleRefusal, type SyncRefusal } from '@nexus/factory-domain/floor-sync/rules'
import type { CommandCaller } from '../../../core/command'
import type { Applied, QueuedEvent } from '../../../platform/floor-sync/kinds'
import { suggestionBody } from '../floornotes/contract'
import { tellOffice } from '../floornotes/suggestions'
import { setFlags } from './flags'
import { sayLate } from './late'
import { flagsBody, lateBody } from './signals-contract'

/**
 * The offline queue's leader signals and suggestions (owb- order workflow, S5 fl3; factory-domain floor-sync/kinds:
 * production.baskets.flag, production.baskets.late, floor.suggestion), each through its own command with the queue's key
 * (`<device>.<client event id>`): a resent event changes nothing. A suggestion WITHOUT the name is refused here (the queue's
 * ledger keeps the worker and the device): the phone sends it online only.
 *
 * WAITING FOR ITS CALLER: platform/floor-sync/kinds.ts `applyQueued` (not S5's file) needs, in its switch,
 *   case 'production.baskets.flag': case 'production.baskets.late': case 'floor.suggestion':
 *     return await applyBasketSignal(caller, event, context.key)
 * asked in LF/shared-asks.md (2026-11-28, S5-server-B). A module refusal thrown here is mapped by that file's refusalOfError
 * (CallRefusedError, or a DomainError naming `refusal/<CODE>`).
 */

/** The payload as its module's body, or the first problem in words. */
function parsedBody<Schema extends z.ZodType>(schema: Schema, value: unknown): { ok: true; value: z.infer<Schema> } | { ok: false; refusal: SyncRefusal } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  return { ok: false, refusal: badEventRefusal(issue ? `${issue.message} (${issue.path.join('/') || 'payload'})` : 'the payload is not valid.') }
}

const refused = (refusal: SyncRefusal): Applied => ({ status: 'refused', refusal, moduleRefusal: null })

/** Applies one queued leader signal or suggestion. */
export async function applyBasketSignal(caller: CommandCaller, event: QueuedEvent, key: string): Promise<Applied> {
  const envelope = { clientEventId: event.clientEventId, ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}) }
  switch (event.kind) {
    case 'production.baskets.flag': {
      const body = parsedBody(flagsBody, { ...event.payload, ...envelope })
      if (!body.ok) return refused(body.refusal)
      const result = await setFlags(caller, body.value, key)
      return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'Bundle', id: body.value.bundleIds[0]! } }
    }
    case 'production.baskets.late': {
      const body = parsedBody(lateBody, { ...event.payload, ...envelope })
      if (!body.ok) return refused(body.refusal)
      const result = await sayLate(caller, body.value, key)
      return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'FloorLateWarning', id: result.warnings[0]?.id ?? body.value.bundleIds[0]! } }
    }
    case 'floor.suggestion': {
      const body = parsedBody(suggestionBody, { ...event.payload, ...envelope })
      if (!body.ok) return refused(body.refusal)
      if (!body.value.withName) return refused(moduleRefusal({ code: 'ANON_ONLINE', message: 'A message without your name goes only when the network is there.', fix: 'Send it again when the network is back.', final: true }))
      const result = await tellOffice(caller, body.value, key, { queued: true })
      return { status: result.replayed ? 'duplicate' : 'accepted', result: { type: 'FloorSuggestion', id: result.suggestion.id } }
    }
    default:
      return refused(badEventRefusal(`${event.kind} is not a basket signal.`))
  }
}
