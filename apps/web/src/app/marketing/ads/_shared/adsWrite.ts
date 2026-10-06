/**
 * PR 1d (CM-8, CM-10, CM-11, CM-26) — the one reader of the ads write routes for the campaign-manager screens.
 *
 * The PATCH routes answer 200 with `{ ok: false, error }` for a refusal (Sponsored Brands or Display, a bound, the
 * write gate asked at click time), and 400/404 for others. The detail, ad-group and console screens read only the
 * HTTP status, or nothing at all, so a refused edit was toasted as saved and then put back in silence. The adds
 * answer 200 only when Amazon holds the item (202 saved in Nexus only, 403 refused, 502 Amazon refused it). Every
 * screen reads both through here, and shows the server's own reason.
 */
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, commandKeyFor, sendCommand } from '@/lib/command-key'
import { askSendAnyway, confirmed, notSentPastLimits, readNeedsConfirmation, type OwnLimitLine } from './sendAnyway'

/**
 * CM-27 — one timing for a person's edit on every campaign-manager screen: sent to Amazon now (the ads drain picks it
 * up within a minute), as the Campaigns grid and the campaign Details tab always did. The Ad Groups, Targets, Negatives
 * and Ads tabs held theirs for a 5-minute grace window that no tray on those pages could cancel, so the same status or
 * bid change reached Amazon at once from one page and five minutes later from the next.
 */
export const SEND_NOW = { applyImmediately: true } as const

/** applied = written with nothing to send; queued = written and on its way to Amazon; refused / error = not changed. */
export type WriteOutcome = 'applied' | 'queued' | 'refused' | 'error'
export interface WriteResult { ok: boolean; outcome: WriteOutcome; reason: string | null }

/** The server's short codes, in words. A server sentence is shown as it is. */
const CODE_WORDS: Record<string, string> = {
  entity_orphaned: 'Amazon no longer has this item, so nothing was sent.',
  not_found: 'Nexus no longer holds this item.',
  bid_below_floor_5_cents: 'Nexus refuses bids under 5 cents.',
  status_required: 'Choose a status first.',
  portfolio_not_found: 'Nexus no longer holds this portfolio.',
  amazon_rejected: 'Amazon refused it.',
  no_active_connection_for_marketplace: 'There is no Amazon Ads connection for this market.',
}

/** The reason a person reads. Pure. */
export function reasonText(error: unknown, status?: number): string {
  if (typeof error === 'string' && error.trim()) return CODE_WORDS[error.trim()] ?? error.trim()
  return status ? `The server answered ${status} without a reason.` : 'No answer from the server.'
}

/** One write's answer → its outcome. Pure (the screens' tests drive it). */
/** The reason an answer carries: a sentence (`reason`), a refusal object, or an error code. */
const said = (b: { reason?: unknown; refusal?: unknown; error?: unknown }): unknown =>
  b.reason ?? (b.refusal as { reason?: unknown } | null | undefined)?.reason ?? b.error

export function readWrite(status: number, body: unknown): WriteResult {
  const b = (body ?? {}) as { ok?: unknown; error?: unknown; reason?: unknown; refusal?: unknown; outboundQueueId?: unknown }
  if (status >= 200 && status < 300 && b.ok !== false) {
    return { ok: true, outcome: b.outboundQueueId ? 'queued' : 'applied', reason: null }
  }
  const reason = reasonText(said(b), status)
  // A decision the server made (a refusal, a bound, Amazon's own no) is a refusal; a crash or no answer is an error.
  return { ok: false, outcome: status >= 500 && b.ok !== false && !b.reason ? 'error' : 'refused', reason }
}

/** One PATCH (or POST), and the own limits it waits on (3A) when the server says so. Never throws. */
async function sendWrite(path: string, body: Record<string, unknown>, method: 'PATCH' | 'POST'): Promise<{ result: WriteResult; waits: OwnLimitLine[] | null }> {
  try {
    const r = await fetch(`${getBackendUrl()}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const answer = await r.json().catch(() => ({}))
    return { result: readWrite(r.status, answer), waits: readNeedsConfirmation(r.status, answer) }
  } catch (e) {
    return { result: { ok: false, outcome: 'error', reason: e instanceof Error ? e.message : 'No answer from the server.' }, waits: null }
  }
}

/**
 * PATCH (or POST) one ads write and read its answer. Never throws. 3A — past his own limits it asks "Send anyway"
 * (SendAnywayHost) and, when he says yes, sends the same body again with `confirmOwnLimits`.
 */
export async function adsWrite(path: string, body: Record<string, unknown>, method: 'PATCH' | 'POST' = 'PATCH'): Promise<WriteResult> {
  const first = await sendWrite(path, body, method)
  if (!first.waits) return first.result
  if (!(await askSendAnyway(first.waits))) return { ok: false, outcome: 'refused', reason: notSentPastLimits(first.waits) }
  return (await sendWrite(path, confirmed(body), method)).result
}

export interface EachResult { done: string[]; queued: number; failed: Array<{ id: string; reason: string }> }

/** Many PATCHes, one request each, read together. Never throws. */
export async function adsWriteMany(items: Array<{ id: string; path: string; body: Record<string, unknown> }>): Promise<EachResult> {
  const out: EachResult = { done: [], queued: 0, failed: [] }
  const results = await Promise.all(items.map(async ({ id, path, body }) => ({ id, r: await adsWrite(path, body) })))
  for (const { id, r } of results) {
    if (r.ok) { out.done.push(id); if (r.outcome === 'queued') out.queued++ } else out.failed.push({ id, reason: r.reason ?? 'Not changed.' })
  }
  return out
}

/** The same write for many ids, one request each (`/api/advertising/<base>/<id>`). Never throws. */
export function adsWriteEach(base: string, ids: string[], body: Record<string, unknown>): Promise<EachResult> {
  return adsWriteMany(ids.map((id) => ({ id, path: `/api/advertising/${base}/${id}`, body })))
}

/**
 * What a batch of writes did, in one toast: how many changed, that a queued change reaches Amazon after the wait,
 * and why the others did not (the first reason, and how many share it). Pure.
 */
export function eachSummary(res: EachResult, noun: string): { tone: 'success' | 'warning' | 'danger'; text: string } {
  const n = (k: number) => `${k} ${noun}${k === 1 ? '' : 's'}`
  const parts: string[] = []
  if (res.done.length) parts.push(`${n(res.done.length)} saved${res.queued ? ' — Amazon gets the change in a few minutes' : ''}`)
  if (res.failed.length) {
    const first = res.failed[0]!.reason
    const same = res.failed.filter((f) => f.reason === first).length
    const rest = res.failed.length - same
    parts.push(`${n(res.failed.length)} not changed: ${first}${same > 1 ? ` (${same}×)` : ''}${rest ? ` · ${rest} for other reasons` : ''}`)
  }
  if (!parts.length) return { tone: 'success', text: 'Nothing to change.' }
  return { tone: res.failed.length ? (res.done.length ? 'warning' : 'danger') : 'success', text: parts.join(' · ') }
}

/** What one add (keyword, target, product ad, ad group) did: on Amazon, saved in Nexus only, or not added. */
export interface AddResult { added: boolean; savedOnly: boolean; reason: string | null }

/** An add's answer → whether Amazon holds it. 202 = saved in Nexus only (the campaign is not on Amazon yet). Pure. */
export function readAdd(status: number, body: unknown): AddResult {
  const b = (body ?? {}) as { ok?: unknown; error?: unknown; reason?: unknown; refusal?: unknown }
  if (status === 202) return { added: false, savedOnly: true, reason: reasonText(said(b), status) }
  if (status >= 200 && status < 300 && b.ok !== false && !b.error && !b.refusal) return { added: true, savedOnly: false, reason: null }
  return { added: false, savedOnly: false, reason: reasonText(said(b), status) }
}

/**
 * CM-33 — the key slot of one add: the route and what is added. A press whose answer was lost keeps its key (sendCommand),
 * so sending the same add again waits for it or replays its answer instead of adding it twice; a deliberate add of the
 * same thing later is a new key once the first one answered.
 */
export const addSlotName = (path: string, body: Record<string, unknown>): string => `ads-add:${path}:${JSON.stringify(body)}`

/** POST one add, as one keyed command, and read its answer. Never throws. 3A — past his own limits it asks "Send anyway". */
export async function adsAdd(path: string, body: Record<string, unknown>): Promise<AddResult> {
  try {
    const send = (b: Record<string, unknown>) => sendCommand(commandKeyFor(addSlotName(path, b)), `${getBackendUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    let sent = await send(body)
    const waits = readNeedsConfirmation(sent.response.status, sent.body)
    if (waits) {
      if (!(await askSendAnyway(waits))) return { added: false, savedOnly: false, reason: notSentPastLimits(waits) }
      sent = await send(confirmed(body))
    }
    if (sent.conflict) return { added: false, savedOnly: false, reason: commandConflictMessage(sent.conflict, 'add') }
    return readAdd(sent.response.status, sent.body ?? {})
  } catch (e) {
    return { added: false, savedOnly: false, reason: e instanceof Error ? e.message : 'No answer from the server.' }
  }
}

/**
 * CM-33 — the older console screens' adds, keyed like `adsAdd` (one key per add, kept while the answer is unknown) but
 * answering the raw status and body those screens read. Throws when no answer arrived, as `fetch` does.
 */
export async function adsKeyedPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any }> {
  const sent = await sendCommand(commandKeyFor(addSlotName(path, body)), `${getBackendUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { ok: sent.response.ok, status: sent.response.status, body: sent.body }
}

/** Many adds in one sentence: how many Amazon took, how many were saved in Nexus only, and why the rest were not. Pure. */
export function addSummary(results: AddResult[], noun: string): { allAdded: boolean; anyAdded: boolean; text: string } {
  const n = (k: number) => `${k} ${noun}${k === 1 ? '' : 's'}`
  const added = results.filter((r) => r.added).length
  const saved = results.filter((r) => r.savedOnly)
  const failed = results.filter((r) => !r.added && !r.savedOnly)
  const parts: string[] = []
  if (added) parts.push(`${n(added)} added on Amazon`)
  if (saved.length) parts.push(`${n(saved.length)} saved in Nexus only: ${saved[0]!.reason}`)
  if (failed.length) {
    const first = failed[0]!.reason
    const same = failed.filter((f) => f.reason === first).length
    parts.push(`${n(failed.length)} not added: ${first}${same > 1 && same < failed.length ? ` (${same}×, others for other reasons)` : ''}`)
  }
  return { allAdded: added === results.length, anyAdded: added + saved.length > 0, text: parts.join(' · ') }
}

/** CM-25 — a negative Nexus holds that Amazon never took blocks nothing: the Negatives tabs say so instead of "Enabled". */
export const NOT_ON_AMAZON_TIP = 'Amazon has never taken this negative, so it blocks nothing. Add it again to send it to Amazon.'
