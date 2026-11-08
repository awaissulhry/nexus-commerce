import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * SCR-182's calls (B-W2b-121 on the merged API of B-W2b-112 cut orders and tickets, B-W2b-116 lays, B-W2b-117 recut tickets,
 * secondary processes and trolleys). A floor session reads its own site only; nothing here names a person or carries money.
 * A rule's refusal is a 409 `refusal/<CODE>` (task-api.ts): the screen shows its own words for the code, never the API's.
 *
 *   tickets      the site's tickets to cut, a ticket's card by its code, the start scan and the end scan (online only)
 *   the lay      read, a roll spread / Undo last roll / the count at both ends (online first: kept on the tablet as
 *                `production.lay.roll | undo | count` when the network fails), fabric used (online only)
 *   stickers     a ply run of a counted lay and its print (online only)
 *   recuts       the site's recut tickets waiting, one by its code, start / finish, print (online only)
 *   to sewing    the site's open trolleys, a trolley label read, load / unload / send / receive (online first:
 *                `production.trolley.*`), a bundle's secondary processes and their one-tap move (online only)
 * Every online-first try and its queued retry are ONE action: the try's Idempotency-Key is the queue's `<device>.<client event id>`
 * (B-W2b-77), so the office answers the retry `duplicate` when the try did arrive.
 */

const words = z.object({ it: z.string(), en: z.string() })
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const material = z.object({ item: z.object({ code: z.string(), name: z.string() }), colour: z.object({ code: z.string(), name: z.string() }).nullable() })

export const LAY_STATUSES = ['PLANNED', 'SPREADING', 'CHECKED', 'CUT', 'CANCELLED'] as const
export type LayStatus = (typeof LAY_STATUSES)[number]
export const TICKET_STATUSES = ['OPEN', 'STARTED', 'DONE', 'VOID'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

const printJob = z.object({ id: z.string(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), lastError: z.string().nullable() })
export type PrintJob = z.infer<typeof printJob>

// ---- tickets (B-W2b-112) ------------------------------------------------------------------------------------------------------

const ticketShape = z.object({
  id: z.string(),
  number: z.string(),
  code: z.string(),
  status: z.enum(TICKET_STATUSES),
  layId: z.string().nullable(),
  laySeq: z.number().nullable(),
  startedAt: z.string().nullable(),
  doneAt: z.string().nullable(),
  version: z.number(),
})

const waitingSchema = z.object({
  tickets: z.array(
    ticketShape.extend({
      cutOrder: z.object({ id: z.string(), number: z.string(), kind: z.string(), marker: z.string().nullable(), dueDate: z.string().nullable(), material }),
      lay: z.object({ id: z.string(), seq: z.number(), plies: z.number(), status: z.enum(LAY_STATUSES) }).nullable(),
      ratio: z.string(),
      styles: z.array(z.string()),
    }),
  ),
})
export type WaitingTicket = z.infer<typeof waitingSchema>['tickets'][number]

/** GET /production/cut-tickets/waiting: the site's tickets OPEN or STARTED of released or running cut orders, oldest first. */
export async function fetchWaitingTickets(api: ApiClient): Promise<TaskOutcome<readonly WaitingTicket[]>> {
  const answer = await floorRead(api, '/production/cut-tickets/waiting', { schema: waitingSchema })
  return answer.ok ? { ok: true, value: answer.value.tickets } : answer
}

const plyRunSchema = z.object({ id: z.string(), seq: z.number(), firstPly: z.number(), lastPly: z.number(), parts: z.array(z.string()), labelCount: z.number(), status: z.enum(['PLANNED', 'PRINTED', 'VOID']), printedAt: z.string().nullable() })
export type PlyRun = z.infer<typeof plyRunSchema>

export const ticketCardSchema = z.object({
  ticket: ticketShape,
  cutOrder: z.object({
    id: z.string(),
    number: z.string(),
    kind: z.enum(['FABRIC', 'LEATHER']),
    status: z.string(),
    material: z.object({ item: ref, colour: ref.nullable() }),
    marker: z.object({ name: z.string(), length: z.string(), uom: z.string(), widthCm: z.string().nullable(), words }).nullable(),
    ratio: z.string().nullable(),
    plies: z.number().nullable(),
    garments: z.number(),
    dueDate: z.string().nullable(),
    station: ref.nullable(),
  }),
  lay: z.object({ id: z.string(), seq: z.number(), of: z.number(), plies: z.number(), status: z.enum(LAY_STATUSES), counted: z.number().nullable(), version: z.number() }).nullable(),
  lines: z.array(z.object({ workOrder: z.object({ id: z.string(), number: z.string() }), style: ref, colourway: ref, size: z.string(), ratio: z.number().nullable(), quantity: z.number() })),
  parts: z.array(z.string()),
  plyRuns: z.array(plyRunSchema),
  next: z.object({ next: z.enum(['START', 'FINISH', 'NONE']), refusal: z.object({ code: z.string(), message: z.string() }).nullable() }),
})
export type TicketCard = z.infer<typeof ticketCardSchema>

/** GET /production/cut-tickets/scan?code=: the ticket's card (404: no such ticket at this site; 409 TICKET_IS_RECUT). */
export const fetchTicket = (api: ApiClient, code: string): Promise<TaskOutcome<TicketCard>> => floorRead(api, '/production/cut-tickets/scan', { query: { code }, schema: ticketCardSchema })

/** POST /production/cut-tickets/start | finish {code}: the start scan, the end scan (online only: no queue kind carries them). */
export const scanTicketMove = (api: ApiClient, move: 'start' | 'finish', code: string, key: string): Promise<TaskOutcome<TicketCard>> =>
  floorWrite(api, 'POST', `/production/cut-tickets/${move}`, { body: { code }, schema: ticketCardSchema, idempotencyKey: key })

// ---- the lay at the table (B-W2b-116) -------------------------------------------------------------------------------------------

const fabricUsedSchema = z.object({
  posted: z.boolean(),
  uom: z.string(),
  plies: z.number(),
  estimated: z.string(),
  recorded: z.string(),
  confirmed: z.string().nullable(),
  confirmedAt: z.string().nullable(),
})
export type FabricUsed = z.infer<typeof fabricUsedSchema>

const layRollSchema = z.object({
  id: z.string(),
  seq: z.number(),
  code: z.string(),
  lotCode: z.string(),
  plies: z.number(),
  splices: z.number(),
  endLoss: z.string(),
  endReturned: z.string(),
  uom: z.string(),
  used: z.string(),
  shade: z.string().nullable(),
})
export type LayRoll = z.infer<typeof layRollSchema>

export const layViewSchema = z.object({
  lay: z.object({
    id: z.string(),
    seq: z.number(),
    of: z.number(),
    plies: z.number(),
    status: z.enum(LAY_STATUSES),
    plyMetres: z.string(),
    counted: z.object({ left: z.number(), right: z.number(), checkedAt: z.string() }).nullable(),
    cutAt: z.string().nullable(),
    version: z.number(),
  }),
  cutOrder: z.object({ id: z.string(), number: z.string(), ratio: z.string(), garmentsPerPly: z.number() }),
  ticket: z.object({ id: z.string(), number: z.string(), code: z.string(), status: z.enum(TICKET_STATUSES) }).nullable(),
  rolls: z.array(layRollSchema),
  spread: z.object({ plies: z.number(), rolls: z.number(), needed: z.number(), used: z.string() }),
  fabricUsed: fabricUsedSchema.nullable(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  can: z.object({ spread: z.boolean(), count: z.boolean(), fabricUsed: z.boolean() }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
})
export type LayView = z.infer<typeof layViewSchema>

/** GET /production/lays/:layId: the lay report roll by roll, its sums, the count, the fabric used once CUT, what the table may do. */
export const fetchLay = (api: ApiClient, layId: string): Promise<TaskOutcome<LayView>> => floorRead(api, `/production/lays/${seg(layId)}`, { schema: layViewSchema })

/** The office's key for a queued retry (`<device>.<client event id>`, platform/floor-sync): the try sends the same (B-W2b-77). */
export const keyOf = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

/** A roll spread on the lay (its label scanned): the body of POST …/rolls and of the queued `production.lay.roll` (with layId). */
export interface RollBody {
  readonly code: string
  readonly plies?: number
  readonly splices?: number
  readonly endLoss?: string
  readonly endReturned?: string
  readonly uom?: 'M'
}

/** A roll on the lay, online first (kept as `production.lay.roll` {layId, …} when the network fails). */
export const addRollOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, layId: string, body: RollBody) =>
  onlineFirst(queue, {
    online,
    kind: 'production.lay.roll',
    payload: { layId, ...body },
    attempt: (clientEventId) => floorWrite(api, 'POST', `/production/lays/${seg(layId)}/rolls`, { body, schema: layViewSchema, idempotencyKey: keyOf(deviceId, clientEventId) }),
  })

/** Undo last roll, online first (`production.lay.undo` {layId}). */
export const undoRollOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, layId: string) =>
  onlineFirst(queue, {
    online,
    kind: 'production.lay.undo',
    payload: { layId },
    attempt: (clientEventId) => floorWrite(api, 'POST', `/production/lays/${seg(layId)}/rolls/undo`, { body: {}, schema: layViewSchema, idempotencyKey: keyOf(deviceId, clientEventId) }),
  })

/** Both ends counted, online first (`production.lay.count` {layId, left, right}); a difference is refused and stored nowhere. */
export const countOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, layId: string, count: { readonly left: number; readonly right: number }) =>
  onlineFirst(queue, {
    online,
    kind: 'production.lay.count',
    payload: { layId, ...count },
    attempt: (clientEventId) => floorWrite(api, 'POST', `/production/lays/${seg(layId)}/count`, { body: count, schema: layViewSchema, idempotencyKey: keyOf(deviceId, clientEventId) }),
  })

/** POST /production/lays/:layId/fabric-used: `{}` confirms the lay report's figure; `confirmed` + uom corrects it (online only). */
export const confirmFabric = (api: ApiClient, layId: string, body: { readonly confirmed?: string; readonly uom?: 'M' }, key: string): Promise<TaskOutcome<LayView>> =>
  floorWrite(api, 'POST', `/production/lays/${seg(layId)}/fabric-used`, { body, schema: layViewSchema, idempotencyKey: key })

// ---- ply stickers (B-W2b-112) ---------------------------------------------------------------------------------------------------

const stickerText = z.tuple([z.string(), z.string(), z.string()])
const runAnswer = z.object({ run: plyRunSchema, stickersPerPly: z.number().optional(), preview: z.array(stickerText).optional(), job: printJob.nullable(), problem: z.string().nullable() })
export type RunAnswer = z.infer<typeof runAnswer>

/** POST /production/lays/:layId/ply-runs: the next unnumbered plies, the pattern's parts, printed on the station's label printer. */
export const makeRun = (api: ApiClient, layId: string, language: 'it' | 'en', key: string): Promise<TaskOutcome<RunAnswer>> =>
  floorWrite(api, 'POST', `/production/lays/${seg(layId)}/ply-runs`, { body: { language }, schema: runAnswer, idempotencyKey: key })

/** POST /production/ply-runs/:runId/print: the run printed again. */
export const reprintRun = (api: ApiClient, runId: string, language: 'it' | 'en', key: string): Promise<TaskOutcome<RunAnswer>> =>
  floorWrite(api, 'POST', `/production/ply-runs/${seg(runId)}/print`, { body: { language }, schema: runAnswer, idempotencyKey: key })

const stickersAnswer = z.object({ run: plyRunSchema, stickers: z.array(z.object({ ply: z.number(), lines: stickerText })) })

/** GET /production/ply-runs/:runId/stickers: the run's stickers in words (the first few are previewed). */
export async function fetchStickers(api: ApiClient, runId: string, language: 'it' | 'en'): Promise<TaskOutcome<readonly (readonly [string, string, string])[]>> {
  const answer = await floorRead(api, `/production/ply-runs/${seg(runId)}/stickers`, { query: { language }, schema: stickersAnswer })
  return answer.ok ? { ok: true, value: answer.value.stickers.map((sticker) => sticker.lines) } : answer
}

// ---- recut tickets (B-W2b-117) ---------------------------------------------------------------------------------------------------

export const recutSchema = z.object({
  id: z.string(),
  number: z.string(),
  code: z.string(),
  status: z.enum(TICKET_STATUSES),
  workOrder: z.object({ id: z.string(), number: z.string(), dueDate: z.string().nullable(), rush: z.boolean(), style: z.object({ code: z.string(), name: z.string() }) }),
  cell: z.object({ colourwayCode: z.string(), size: z.string() }),
  bundle: z.object({ code: z.string(), part: z.string().nullable() }).nullable(),
  part: z.string().nullable(),
  quantity: z.number(),
  lot: z.object({ code: z.string(), shade: z.string().nullable() }).nullable(),
  endBits: z.boolean(),
  from: words,
  printedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  version: z.number(),
})
export type Recut = z.infer<typeof recutSchema>

const recutsAnswer = z.object({ rows: z.array(recutSchema), counts: z.object({ open: z.number(), started: z.number() }) })
export type RecutsWaiting = z.infer<typeof recutsAnswer>

/** GET /production/recut-tickets/waiting: the site's OPEN / STARTED recuts (started first, then due, then oldest). */
export const fetchRecuts = (api: ApiClient): Promise<TaskOutcome<RecutsWaiting>> => floorRead(api, '/production/recut-tickets/waiting', { schema: recutsAnswer })

const recutCard = z.object({ ticket: recutSchema, next: z.object({ next: z.enum(['START', 'FINISH', 'NONE']), refusal: z.object({ code: z.string(), message: z.string() }).nullable() }) })
export type RecutCard = z.infer<typeof recutCard>

/** GET /production/recut-tickets/scan?code=: the recut's card and what a tap does next (409 TICKET_IS_CUT: a cut ticket). */
export const fetchRecut = (api: ApiClient, code: string): Promise<TaskOutcome<RecutCard>> => floorRead(api, '/production/recut-tickets/scan', { query: { code }, schema: recutCard })

/** POST /production/recut-tickets/start | finish {code}: one tap each (online only). */
export const moveRecut = (api: ApiClient, move: 'start' | 'finish', code: string, key: string): Promise<TaskOutcome<RecutCard>> =>
  floorWrite(api, 'POST', `/production/recut-tickets/${move}`, { body: { code }, schema: recutCard, idempotencyKey: key })

const labelLines = z.object({ heading: z.string(), title: z.string(), fields: z.array(z.object({ label: z.string(), value: z.string() })) })
const recutPrinted = z.object({ ticket: recutSchema, label: labelLines, job: printJob.nullable(), problem: z.string().nullable() })
export type RecutPrinted = z.infer<typeof recutPrinted>

/** POST /production/recut-tickets/:id/print: on the site's label printer (the label's words come back for the preview). */
export const printRecut = (api: ApiClient, ticketId: string, language: 'it' | 'en', key: string): Promise<TaskOutcome<RecutPrinted>> =>
  floorWrite(api, 'POST', `/production/recut-tickets/${seg(ticketId)}/print`, { body: { language }, schema: recutPrinted, idempotencyKey: key })

// ---- trolleys to sewing and secondary processes (B-W2b-117) ------------------------------------------------------------------------

export const TROLLEY_STATUSES = ['LOADING', 'SENT', 'RECEIVED', 'CANCELLED'] as const
export type TrolleyStatus = (typeof TROLLEY_STATUSES)[number]

export const trolleySchema = z.object({
  id: z.string(),
  trolleyCode: z.string(),
  status: z.enum(TROLLEY_STATUSES),
  line: ref,
  sentAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  counts: z.object({ bundles: z.number(), received: z.number(), missing: z.number() }),
  bundles: z.array(
    z.object({
      id: z.string(),
      bundle: z.object({ id: z.string(), code: z.string(), part: z.string().nullable(), quantity: z.number() }),
      workOrder: z.object({ id: z.string(), number: z.string() }),
      cell: z.object({ colourwayCode: z.string(), size: z.string() }),
      receivedAt: z.string().nullable(),
    }),
  ),
  version: z.number(),
})
export type Trolley = z.infer<typeof trolleySchema>

const openAnswer = z.object({ here: ref.nullable(), rows: z.array(trolleySchema) })
export type OpenTrolleys = z.infer<typeof openAnswer>

/** GET /production/trolleys/open: the site's trolleys loading or on their way; those coming to this tablet's line first. */
export const fetchOpenTrolleys = (api: ApiClient): Promise<TaskOutcome<OpenTrolleys>> => floorRead(api, '/production/trolleys/open', { schema: openAnswer })

const scanAnswer = z.object({ code: z.string(), trolley: trolleySchema.nullable(), next: z.enum(['LOAD', 'RECEIVE', 'NONE']) })
export type TrolleyScan = z.infer<typeof scanAnswer>

/** GET /production/trolleys/scan?code=: the label's open trolley (null: a scan starts a load) and what the next scan does. */
export const scanTrolley = (api: ApiClient, code: string): Promise<TaskOutcome<TrolleyScan>> => floorRead(api, '/production/trolleys/scan', { query: { code }, schema: scanAnswer })

const loaded = z.object({ trolley: trolleySchema, warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(), differences: z.string().nullable().optional() })
export type TrolleyAnswer = z.infer<typeof loaded>

export type TrolleyMove =
  | { readonly kind: 'production.trolley.load'; readonly body: { readonly trolley: string; readonly bundle: string } }
  | { readonly kind: 'production.trolley.unload'; readonly body: { readonly trolley: string; readonly bundle: string } }
  | { readonly kind: 'production.trolley.send'; readonly body: { readonly trolley: string } }
  | { readonly kind: 'production.trolley.receive'; readonly body: { readonly trolley: string; readonly missing?: readonly string[] } }

const TROLLEY_PATH: Readonly<Record<TrolleyMove['kind'], string>> = {
  'production.trolley.load': '/production/trolleys/load',
  'production.trolley.unload': '/production/trolleys/unload',
  'production.trolley.send': '/production/trolleys/send',
  'production.trolley.receive': '/production/trolleys/receive',
}

/** A trolley step, online first (kept as the same `production.trolley.*` kind with the route's body). */
export const trolleyOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, move: TrolleyMove) =>
  onlineFirst(queue, {
    online,
    kind: move.kind,
    payload: { ...move.body },
    attempt: (clientEventId) => floorWrite(api, 'POST', TROLLEY_PATH[move.kind], { body: move.body, schema: loaded, idempotencyKey: keyOf(deviceId, clientEventId) }),
  })

const processSchema = z.object({ id: z.string(), kind: z.string(), words, status: z.string(), version: z.number() })
const bundleProcesses = z.object({
  bundle: z.object({ id: z.string(), code: z.string() }),
  processes: z.array(processSchema),
  next: z.object({ processId: z.string(), move: z.enum(['start', 'done']), words }).nullable(),
  toSewing: words.nullable(),
})
export type BundleProcesses = z.infer<typeof bundleProcesses>

/** GET /production/secondary-processes/bundle?code=: what the bundle waits for before sewing, and the one tap here. */
export const fetchProcesses = (api: ApiClient, code: string): Promise<TaskOutcome<BundleProcesses>> => floorRead(api, '/production/secondary-processes/bundle', { query: { code }, schema: bundleProcesses })

/** POST /production/secondary-processes/:id/start | done (online only). */
export async function moveProcess(api: ApiClient, processId: string, move: 'start' | 'done', key: string): Promise<TaskOutcome<{ readonly status: string }>> {
  const answer = await floorWrite(api, 'POST', `/production/secondary-processes/${seg(processId)}/${move}`, { body: {}, schema: z.object({ process: processSchema }), idempotencyKey: key })
  return answer.ok ? { ok: true, value: { status: answer.value.process.status } } : answer
}
