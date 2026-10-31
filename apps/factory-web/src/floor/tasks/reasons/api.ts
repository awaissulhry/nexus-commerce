import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { AsOfMemory, type Remembered } from '../shared/as-of'
import { floorRead, type TaskOutcome } from '../shared/task-api'
import { fromListReason, type ListReason, type PickerList, type PickerReason } from './model'

/**
 * SCR-091's read: the active reasons of one or more lists in tile order (`GET /reasons?list=…`, B-W2a-18: office AND
 * floor, any signed-in session; nothing personal or secret). The floor gets no live message when the office changes a
 * list (the event has no site): the picker reads again on view, and keeps the last answer for the rest of the visit so
 * an offline tablet still offers the reasons it saw ("from this tablet, as of …").
 */

const listReason = z.object({
  id: z.string(),
  list: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  needsDetail: z.boolean(),
  sortOrder: z.number(),
}) satisfies z.ZodType<ListReason>

export const reasonsSchema = z.object({ reasons: z.array(listReason) })

const KEPT = new AsOfMemory<readonly PickerReason[]>(20)
const keyOf = (lists: readonly string[]) => [...lists].sort().join(',')

/** The reasons of the lists from the office, kept for the visit. */
export async function fetchListReasons(api: ApiClient, lists: readonly string[]): Promise<TaskOutcome<readonly PickerReason[]>> {
  const answer = await floorRead(api, '/reasons', { query: { list: lists.join(',') }, schema: reasonsSchema })
  if (!answer.ok) return answer
  const reasons = answer.value.reasons.map(fromListReason)
  KEPT.keep(keyOf(lists), reasons)
  return { ok: true, value: reasons }
}

/** The reasons this tablet read last for the lists in this visit, with their as-of time; null when none. */
export function keptListReasons(lists: readonly string[]): Remembered<readonly PickerReason[]> | null {
  return KEPT.get(keyOf(lists))
}

/** What the picker shows before a read answers: the reasons this tablet kept in this visit, else "loading". */
export function listBeforeRead(lists: readonly string[]): PickerList {
  const kept = keptListReasons(lists)
  return kept ? { state: 'ready', reasons: kept.value, asOf: null } : { state: 'loading', reasons: [], asOf: null }
}

/**
 * A host's read of its lists for the picker (Hold lot, Receive back, any later floor step): the office's answer, else what
 * this tablet kept with its as-of time, else why not (offline, failed). `signedOut`: the session ended (the host signs out).
 */
export async function readListReasons(api: ApiClient, lists: readonly string[], online: boolean): Promise<{ list: PickerList; signedOut: boolean }> {
  if (online) {
    const answer = await fetchListReasons(api, lists)
    if (answer.ok) return { list: { state: 'ready', reasons: answer.value, asOf: null }, signedOut: false }
    const kept = keptListReasons(lists)
    const signedOut = answer.problem.kind === 'signedOut'
    if (kept) return { list: { state: 'ready', reasons: kept.value, asOf: kept.asOf }, signedOut }
    return { list: { state: answer.problem.kind === 'offline' ? 'offline' : 'error', reasons: [], asOf: null }, signedOut }
  }
  const kept = keptListReasons(lists)
  return { list: kept ? { state: 'ready', reasons: kept.value, asOf: kept.asOf } : { state: 'offline', reasons: [], asOf: null }, signedOut: false }
}
