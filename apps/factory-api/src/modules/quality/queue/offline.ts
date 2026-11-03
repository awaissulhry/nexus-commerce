import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { FINAL_WHATS, INCOMING_WHATS, OFFLINE_LIMITS, OFFLINE_WORDS } from '@nexus/factory-domain/quality/queue/rules'
import type { CommandCaller } from '../../../core/command'
import { QUEUE_RECORD_KINDS } from './contract'
import { modelOf } from './models'
import { queueRows } from './queue'

/**
 * What a tablet keeps for working offline (B-W2b-106; QHS-062; design floor.final, floor.incoming, floor.inline "Works
 * offline"; floor.mywork "offline: From the cache with its as-of time"): the inspector's queue (their own and those nobody
 * took yet, as GET /quality/queue scope mine) and, for each open record they may record, at most OFFLINE_LIMITS.records, the
 * record with its plan as its module answers it (the plan's checks are frozen on the record, so the copy stays right while
 * the record is open). Which writes the queue keeps and which wait for the network are said in words. Read only; the floor.
 *
 *   GET /quality/queue/offline
 */
export async function offlinePack(caller: CommandCaller) {
  if (caller.factoryContext?.audience !== 'floor') throw new ForbiddenError('The offline pack is a floor tablet’s.')
  const { rows, now } = await queueRows(caller, { scope: 'mine', limit: OFFLINE_LIMITS.rows })
  const recordable = rows.filter((row) => row.recordType !== null && row.id !== null && row.may.record)
  const kept = recordable.slice(0, OFFLINE_LIMITS.records)
  const records = []
  for (const row of kept) {
    records.push({ key: row.key, recordType: row.recordType!, id: row.id!, kind: row.kind, version: row.version ?? 1, model: await modelOf(caller, { recordType: row.recordType!, id: row.id! }) })
  }
  return {
    asOf: toUtcIso(now),
    keepUntil: toUtcIso(new Date(now.getTime() + OFFLINE_LIMITS.keepHours * 3_600_000)),
    rows: rows.slice(0, OFFLINE_LIMITS.rows),
    records,
    queues: { kinds: [...QUEUE_RECORD_KINDS], final: [...FINAL_WHATS], incoming: [...INCOMING_WHATS] },
    words: OFFLINE_WORDS,
    capped: recordable.length > kept.length,
  }
}
