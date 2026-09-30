/**
 * One sheet OPERATION (a fill, a paste, an undo) → ONE `POST /api/products/bulk-save`.
 *
 * 🔴 Why (measured 2026-09-29, eBay · IT "Description theme", 250 variations): the sheet sent a fill as one
 * `PATCH /api/products/bulk` per row, all at once. Each request rebuilt the whole family on the server in its own
 * transaction; 26 of 250 rows were confirmed, 163 timed out in the browser, and 15 of those had saved anyway.
 *
 * How, without a second copy of any write rule: each row still runs its OWN commit (`commitChannelRow`,
 * `commitMasterRow`) — language groups, the master/channel split, the version-0 draft retry, the answer reading — and
 * only its SEND changes. Here the send hands the body to a collector instead of `fetch`. When every row of the
 * operation is waiting on the collector (or finished), the collector posts all of them as one request and gives each
 * row the status and body its own PATCH would have answered. A row whose commit needs a second send (its second
 * language, a retry at an adopted version) waits for the next round — normally there is exactly one.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { CommandKey, sendCommand } from '@/lib/command-key'
import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'

/** The part of a fetch `Response` the row commits read — typed as `Response` types it, so their reading is unchanged. */
export interface BulkAnswer {
  status: number
  ok: boolean
  retryAfter?: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors `Response.json()`
  json(): Promise<any>
}

/** Send ONE `PATCH /api/products/bulk` body — on its own, or as one unit of an operation. */
export type BulkSend = (body: Record<string, unknown>) => Promise<BulkAnswer>

/** The single-row path, unchanged: its own request with its own 30 s bound. */
export const directBulkSend: BulkSend = (body) => fetch(`${getBackendUrl()}/api/products/bulk`, {
  method: 'PATCH',
  signal: AbortSignal.timeout(30_000),
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export interface BulkSaveUnitWire extends Record<string, unknown> { key: string }

const answer = (status: number, body: unknown, retryAfter?: string | null): BulkAnswer => ({ status, ok: status >= 200 && status < 300, retryAfter, json: async () => body })

/**
 * POST one operation. No client timeout on purpose: a 500-row save can take longer than one row's 30 s, and a slow
 * answer is still THE answer — the writer paints "still waiting" meanwhile instead of inventing a failure.
 * Through `sendCommand`, the one door for keyed commands: the operation's id is its Idempotency-Key, so a resend after
 * a lost connection replays the stored answer and never applies twice.
 */
export type BulkSavePost = (operationId: string, units: BulkSaveUnitWire[]) => Promise<BulkAnswer>
export const postBulkSave: BulkSavePost = async (operationId, units) => {
  const { response, body } = await sendCommand(new CommandKey(() => operationId), `${getBackendUrl()}/api/products/bulk-save`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId, units }),
  })
  return answer(response.status, body, response.headers.get('Retry-After'))
}

/** Only the API's explicit whole-operation rollback contract permits an automatic replay. */
function busyRetryDelay(response: BulkAnswer, payload: unknown): number | null {
  if (response.status !== 503 || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const body = payload as Record<string, unknown>
  if (body.retryable !== true || body.nothingSaved !== true || 'units' in body || (body.saved !== undefined && body.saved !== 0)) return null
  const header = response.retryAfter?.trim()
  if (!header) return null
  const date = Date.parse(header)
  const delay = /^\d+$/.test(header) ? Number(header) * 1000
    : Number.isFinite(date) && new Date(date).toUTCString() === header ? Math.max(0, date - Date.now()) : NaN
  // Never shorten Retry-After. A longer or malformed delay leaves the edit for manual Retry.
  return Number.isFinite(delay) && delay <= 30_000 ? delay : null
}

/** Cancel only the wait. An in-flight request must keep its own authoritative answer. */
function waitForRetry(delay: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = (retry: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(retry) }
    const cancel = () => finish(false)
    const timer = setTimeout(() => finish(true), delay)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

type OperationPayload = { units?: Array<{ key: string; status: number; body: unknown }> } | null

async function postWithBusyRetry(post: BulkSavePost, id: string, units: BulkSaveUnitWire[], retrySignal?: AbortSignal) {
  // Freeze the wire values for this intent, even if a later edit changes an object held by the row.
  const snapshot = JSON.parse(JSON.stringify(units)) as BulkSaveUnitWire[]
  for (let attempt = 0; ; attempt++) {
    const res = await post(id, snapshot)
    const payload = await res.json().catch(() => null) as OperationPayload
    const delay = busyRetryDelay(res, payload)
    if (attempt >= 2 || delay === null || !(await waitForRetry(delay, retrySignal)) || retrySignal?.aborted) return { res, payload }
  }
}

/** The server's bounds (`bulk-save.service.ts`); an operation beyond them is sent as consecutive requests. */
const MAX_UNITS = 2_000
const MAX_CHANGES = 10_000


function chunk<W extends { unit: BulkSaveUnitWire }>(units: W[]): W[][] {
  const chunks: W[][] = []
  let current: W[] = [], changes = 0
  for (const entry of units) {
    const size = Array.isArray(entry.unit.changes) ? entry.unit.changes.length : 1
    if (current.length && (current.length >= MAX_UNITS || changes + size > MAX_CHANGES)) { chunks.push(current); current = []; changes = 0 }
    current.push(entry)
    changes += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

export const newOperationId = () => (globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(36).slice(2)}`)

/**
 * Run every row's own commit, with ONE bulk request per round. Resolves to each row's result (a commit that throws is
 * an unknown outcome, never a refusal — the writer reconciles it).
 */
export async function runBulkOperation<T>(
  requests: SheetWriteRequest<T>[],
  commitRow: (request: SheetWriteRequest<T>, send: BulkSend) => Promise<SheetWriteResult>,
  options: { post?: BulkSavePost; operationId?: string; retrySignal?: AbortSignal } = {},
): Promise<Map<string, SheetWriteResult>> {
  const post = options.post ?? postBulkSave
  const operationId = options.operationId ?? newOperationId()
  // destroy() deliberately flushes still-queued intent once with an already-aborted signal.
  // A later abort instead cancels all parts of an active operation that have not left yet.
  const teardownFlush = options.retrySignal?.aborted === true
  const results = new Map<string, SheetWriteResult>()
  type Waiting = { rowId: string; unit: BulkSaveUnitWire; resolve: (a: BulkAnswer) => void; reject: (e: unknown) => void }
  const state = new Map(requests.map((r) => [r.rowId, { done: false, sends: 0 }]))
  const waiting: Waiting[] = []
  let round = 0, units = 0, scheduled = false, sending = false

  /* A round goes when no row is still RUNNING (every row is waiting here, or finished). The check runs after the
     current turn, so continuations resolved in one round get to enqueue before the next one is decided. */
  const running = () => [...state.values()].some((s) => !s.done && s.sends === 0)
  const maybeSend = () => {
    if (scheduled || sending) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      if (!sending && waiting.length && !running()) void sendRound()
    }, 0)
  }

  const sendRound = async () => {
    sending = true
    const batch = waiting.splice(0)
    round++
    try {
      for (const [index, part] of chunk(batch).entries()) {
        if (!teardownFlush && options.retrySignal?.aborted) {
          for (const w of part) w.resolve(answer(400, { error: 'These edits were not sent because the sheet changed or closed.', nothingSaved: true }))
          continue
        }
        try {
          const { res, payload } = await postWithBusyRetry(post, `${operationId}:${round}:${index}`, part.map((w) => w.unit), options.retrySignal)
          if (res.ok && Array.isArray(payload?.units)) {
            const byKey = new Map(payload.units.map((u) => [u.key, u]))
            for (const w of part) {
              const own = byKey.get(w.unit.key)
              // A unit the answer does not name was never confirmed: the row reads it as "no answer", never "saved".
              w.resolve(own ? answer(own.status, own.body) : answer(502, { error: 'The save answered without this row.' }))
            }
          } else {
            // The whole operation was refused or failed: every unit hears the operation's own answer.
            for (const w of part) w.resolve(answer(res.status, payload))
          }
        } catch (error) {
          for (const w of part) w.reject(error)
        }
      }
    } finally {
      sending = false
      maybeSend()
    }
  }

  const sendFor = (rowId: string): BulkSend => (body) => new Promise<BulkAnswer>((resolve, reject) => {
    const row = state.get(rowId)!
    row.sends++
    waiting.push({
      rowId,
      unit: { ...body, key: `${rowId}#${++units}` },
      // The row runs again the moment its answer is handed over.
      resolve: (a) => { row.sends--; resolve(a) },
      reject: (e) => { row.sends--; reject(e) },
    })
    maybeSend()
  })

  await Promise.all(requests.map(async (request) => {
    try {
      results.set(request.rowId, await commitRow(request, sendFor(request.rowId)))
    } catch (error) {
      results.set(request.rowId, { ok: false, unreachable: true, reason: `Connection lost — checking whether this saved. ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      state.get(request.rowId)!.done = true
      maybeSend()
    }
  }))
  return results
}

/** The row commits' reading of a whole-operation refusal: the server said nothing of the operation was stored. */
export const nothingSaved = (body: unknown): boolean => (body as { nothingSaved?: unknown } | null)?.nothingSaved === true

/**
 * The grid's own start/end events of a multi-cell operation, as `SheetWriter` fences: everything a fill, a paste, an
 * undo, a redo or a range delete changes leaves as ONE save, sent the moment the grid says the operation ended.
 * (AG records each of these as ONE undo step too — so undoing a fill is one step and one save.)
 */
export function operationFence(writer: { beginOperation(): void; endOperation(): void }) {
  const begin = () => writer.beginOperation()
  const end = () => writer.endOperation()
  return {
    onFillStart: begin, onFillEnd: end,
    onPasteStart: begin, onPasteEnd: end,
    onUndoStarted: begin, onUndoEnded: end,
    onRedoStarted: begin, onRedoEnded: end,
    onCellSelectionDeleteStart: begin, onCellSelectionDeleteEnd: end,
  }
}
