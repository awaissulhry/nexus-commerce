import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { AsOfMemory, codeKey, type Remembered } from '../shared/as-of'
import { seg, taskProblemOf, type TaskOutcome, type TaskProblem } from '../shared/task-api'
import { stepKey } from '../mywork/warehouse/api'
import { COUNT_PASSES, DIFFERENCE_KINDS, type BinDone, type BinRead, type Finished, type ScanAnswer, type ToCount } from './model'

/**
 * Count's calls (B-W2b-310 on B-W2b-299's API, apps/factory-api modules/inventory/counts-depth; office and floor,
 * inventory.counts.scan): What to count (`GET /inventory/stock-counts/to-count`), the bin scanned (`GET …/bin?placeCode=`, blind),
 * one unit (`POST …/:countId/scans`, online first, else kept in the tablet's queue as inventory.count.scan with the same body under
 * the try's id), Bin done (`GET …/:countId/bins/:locationId`: the differences, the expected numbers revealed now; online only) and
 * Finish bin (`POST …/finish`, online first, else kept as inventory.count.finishBin). Every answer is checked against the fields the
 * screen reads; no field carries money or a person. What the tablet read in this visit is kept for an offline count ("as of").
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string(), labelCode: z.string().nullable() })
const countRef = z.object({ id: z.string(), number: z.string(), kind: z.string(), status: z.string(), freezeMoves: z.boolean() })
const ref = z.object({ id: z.string(), code: z.string() })

const binLine = z.object({
  lineId: z.string(),
  seq: z.number(),
  origin: z.enum(['SNAPSHOT', 'ADDED']),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), uom: z.string(), tracking: z.string() }),
  lot: ref.nullable(),
  hide: ref.nullable(),
  pass: z.enum(COUNT_PASSES).nullable(),
  scans: z.number(),
  scanned: z.string(),
})

const toCountSchema = z.object({
  asOf: z.string(),
  bins: z.array(z.object({ count: countRef, location: place, kind: z.enum(COUNT_PASSES), lines: z.number(), since: z.string(), yours: z.boolean() })),
}) satisfies z.ZodType<ToCount>

const binSchema = z.object({ location: place, counts: z.array(countRef), count: countRef.nullable(), lines: z.array(binLine) }) satisfies z.ZodType<BinRead>

const scanSchema = z.object({ scanId: z.string(), count: countRef, line: binLine, added: z.boolean(), quantity: z.string() }) satisfies z.ZodType<ScanAnswer>

const difference = z.object({
  lineId: z.string(),
  seq: z.number(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), uom: z.string() }),
  lot: ref.nullable(),
  hide: ref.nullable(),
  pass: z.enum(COUNT_PASSES),
  expected: z.string(),
  scanned: z.string(),
  scans: z.number(),
  difference: z.string(),
  kind: z.enum(DIFFERENCE_KINDS),
})

const binDoneSchema = z.object({ count: countRef, location: place, differences: z.array(difference), none: z.boolean(), movedSinceStart: z.number(), note: z.object({ en: z.string(), it: z.string() }).nullable() }) satisfies z.ZodType<BinDone>

const finishSchema = z.object({ count: countRef, location: place, differences: z.array(difference), recountsAsked: z.array(z.object({ lineId: z.string(), seq: z.number() })), lines: z.number(), counted: z.number() }) satisfies z.ZodType<Finished>

/**
 * The screen's problem for a failed count call: a rule's `refusal/<CODE>` in a 409 or a 400 (UNKNOWN_LABEL, QUANTITY … are
 * validations), the label of no place of this site (400 `placeCode` / `body/placeCode`: NOT_A_PLACE), else the floor's general
 * problem. The API's English is never drawn: the code picks the screen's words. Exported for the tests.
 */
export function countProblemOf(error: unknown): TaskProblem {
  if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')) {
    for (const issue of error.issues) {
      const match = /^refusal\/([A-Z][A-Z0-9_]*)$/.exec(issuePath(issue))
      if (match) return { kind: 'refused', code: match[1]!, message: issue.message ?? error.message, fix: null }
    }
    if (error.kind === 'invalid' && error.issues.some((issue) => /(?:^|\/)placeCode$/.test(issuePath(issue)))) return { kind: 'refused', code: 'NOT_A_PLACE', message: error.message, fix: null }
  }
  return taskProblemOf(error)
}

async function read<T>(api: ApiClient, path: string, query: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<TaskOutcome<T>> {
  try {
    return { ok: true, value: await api.get(path, { query, schema }) }
  } catch (error) {
    return { ok: false, problem: countProblemOf(error) }
  }
}

async function write<T>(api: ApiClient, path: string, body: unknown, schema: z.ZodType<T>, idempotencyKey: string): Promise<TaskOutcome<T>> {
  try {
    await api.get('/auth/csrf')
    return { ok: true, value: await api.request('POST', path, { body, schema, idempotencyKey }) }
  } catch (error) {
    return { ok: false, problem: countProblemOf(error) }
  }
}

/** What to count at this site, and the bins read in this visit (offline they open "as of"; nothing is stored). */
const TO_COUNT = new AsOfMemory<ToCount>(4)
const BINS = new AsOfMemory<BinRead>(60)

export async function fetchToCount(api: ApiClient, siteId: string): Promise<TaskOutcome<ToCount>> {
  const answer = await read(api, '/inventory/stock-counts/to-count', {}, toCountSchema)
  if (answer.ok) TO_COUNT.keep(siteId, answer.value)
  return answer
}

export const keptToCount = (siteId: string): Remembered<ToCount> | null => TO_COUNT.get(siteId)

const binKey = (code: string, countId?: string | null) => `${codeKey(code)}|${countId ?? ''}`

export async function fetchBin(api: ApiClient, placeCode: string, countId?: string | null): Promise<TaskOutcome<BinRead>> {
  const answer = await read(api, '/inventory/stock-counts/bin', { placeCode: placeCode.trim(), ...(countId ? { countId } : {}) }, binSchema)
  if (answer.ok) {
    BINS.keep(binKey(placeCode, countId), answer.value)
    if (answer.value.count) BINS.keep(binKey(placeCode, answer.value.count.id), answer.value)
  }
  return answer
}

export const keptBin = (placeCode: string, countId?: string | null): Remembered<BinRead> | null => BINS.get(binKey(placeCode, countId)) ?? (countId ? null : BINS.get(binKey(placeCode, null)))

/** The bin as this tablet last saw it (after a unit's answer), so an offline visit opens the newest copy. */
export const keepBin = (placeCode: string, bin: BinRead): void => {
  BINS.keep(binKey(placeCode, bin.count?.id ?? null), bin)
  BINS.keep(binKey(placeCode, null), bin)
}

export interface ScanBody {
  /** The bin's label (or its code). */
  readonly placeCode: string
  /** What was scanned: a hide's, roll's or remnant's tag, a lot's label; absent: the pad for `lineId`. */
  readonly code?: string
  readonly lineId?: string
  /** In the item's base unit: a lot's label or the pad. */
  readonly quantity?: string
}

/** One unit, online first: a network failure keeps it on the tablet (inventory.count.scan) with the same body, under the try's id. */
export const scanOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, countId: string, body: ScanBody) =>
  onlineFirst(queue, {
    online,
    kind: 'inventory.count.scan',
    payload: { countId, ...body },
    attempt: (clientEventId) => write(api, `/inventory/stock-counts/${seg(countId)}/scans`, { ...body, scannedAt: new Date().toISOString() }, scanSchema, stepKey(deviceId, clientEventId)),
  })

/** Bin done: the differences, the expected numbers shown now (online only: they are the office's). */
export const fetchBinDone = (api: ApiClient, countId: string, locationId: string): Promise<TaskOutcome<BinDone>> => read(api, `/inventory/stock-counts/${seg(countId)}/bins/${seg(locationId)}`, {}, binDoneSchema)

/** Finish bin, online first: a network failure keeps it on the tablet (inventory.count.finishBin), after the units it waits for. */
export const finishOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, countId: string, locationId: string) =>
  onlineFirst(queue, {
    online,
    kind: 'inventory.count.finishBin',
    payload: { countId, locationId },
    attempt: (clientEventId) => write(api, `/inventory/stock-counts/${seg(countId)}/bins/${seg(locationId)}/finish`, { occurredAt: new Date().toISOString() }, finishSchema, stepKey(deviceId, clientEventId)),
  })
