import { getBackendUrl } from '@/lib/backend-url'
import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'
import type { ChannelSheetRow } from '../sheet/channel/types'
import type { ShopifySheetWrite } from '@nexus/shared/shopify-information'
import { postBulkSave, postWithBusyRetry, type BulkAnswer, type BulkSavePost, type BulkSaveUnitWire, type BulkSend } from '../sheet/bulkOperation'

/** The server's bound for one `POST …/shopify-linked/cells` (`shopifySheetChangesSchema`). */
const MAX_CELLS = 1_000
/** The unit marker a Shopify row's send carries through the common bulk operation (`runBulkOperation`). */
const SHOPIFY_UNIT = 'shopifyCells'

type WireCell = { ownerId?: string; fieldId?: string; token?: string; baseline?: string | null; colId: string; intent: string; contentAddress?: unknown; value: string | null; receiptKey?: string }
type ShopifyUnit = { productId: string; query: Record<string, string>; cells: WireCell[]; phase: ShopifyPhase }
type Answer = Pick<BulkAnswer, 'status' | 'ok' | 'json'>

/**
 * Where a cell's write must go in one sheet action so every token stays valid (lane01 ordering rule):
 * 0 — a FOLLOWER set detaches it (its token holds the shared source's pending state, so it goes before the source moves);
 * 1 — sources, own values and everything that is not shared;
 * 2 — a follower RESET attaches it again (its returned token holds the source's final state, so it goes after).
 */
export type ShopifyPhase = 0 | 1 | 2
function cellPhase(write: ShopifySheetWrite | undefined, intent: string): ShopifyPhase {
  const sharing = write?.sharing
  if (!sharing) return 1
  if (intent === 'reset' || intent === 'reset-list') return sharing.sourceOwnerId !== write!.ownerId ? 2 : 1
  return sharing.follows ? 0 : 1
}
/** A row's phase is its earliest cell's: a row is one request, and a detach in it must not wait behind a source change. */
const requestPhase = (req: SheetWriteRequest<ChannelSheetRow>): ShopifyPhase =>
  req.cells.length ? Math.min(...req.cells.map(cell => cellPhase(req.row?.values[cell.colId]?.shopifyWrite, cell.intent))) as ShopifyPhase : 1

/** One sheet action's rows in write order (follower detach → sources → follower attach), stable within each phase. */
export function orderShopifyColumnRequests<T extends SheetWriteRequest<ChannelSheetRow>>(requests: readonly T[]): T[] {
  return requests.map((request, index) => ({ request, index, phase: requestPhase(request) }))
    .sort((a, b) => a.phase - b.phase || a.index - b.index).map(entry => entry.request)
}

const refusedCells = (req: SheetWriteRequest<ChannelSheetRow>, reason: string) => Object.fromEntries(req.cells.map(cell => [cell.colId, { ok: false, reason }]))

/**
 * One row's batch, through the common SheetWriter. A response confirms only a Nexus draft. With `bulkSend` the row is
 * one unit of a sheet operation (`runBulkOperation`) and leaves through `createShopifyBulkPost`; without it, on its own.
 */
export async function commitShopifySheetRow(req: SheetWriteRequest<ChannelSheetRow>, coord: { accountId?: string; locale?: string; bulkSend?: BulkSend }): Promise<SheetWriteResult> {
  const row = req.row
  if (!row?.shopify || !coord.accountId) return { ok: false, reason: 'The Shopify listing identity is unavailable. Reload the sheet.' }
  const cells: WireCell[] = req.cells.map(cell => {
    const write = row.values[cell.colId]?.shopifyWrite
    // Sharing facts are read-only display/ordering facts: never sent as part of a write.
    const address = write ? { ownerId: write.ownerId, fieldId: write.fieldId, token: write.token, baseline: write.baseline } : {}
    return { ...address, colId: cell.colId, intent: cell.intent, contentAddress: row.values[cell.colId]?.contentAddress,
      value: cell.value == null ? null : typeof cell.value === 'object' ? JSON.stringify(cell.value) : String(cell.value) }
  })
  if (cells.some(cell => !cell.token)) return { ok: false, reason: 'The cell has no Shopify draft write address. Reload before editing.' }
  try {
    const query = { accountId: coord.accountId, listingId: row.shopify.listingId, market: 'GLOBAL', ...(coord.locale ? { locale: coord.locale } : {}) }
    const response: Answer = coord.bulkSend
      ? await coord.bulkSend({ [SHOPIFY_UNIT]: { productId: row.shopify.productId, query, cells, phase: requestPhase(req) } satisfies ShopifyUnit })
      : await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(row.shopify.productId)}/shopify-linked/cells?${new URLSearchParams(query)}`, {
        method: 'POST', credentials: 'include', signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells }),
      })
    const body = await response.json().catch(() => null)
    if (response.status >= 500 || response.ok && (!body || typeof body.ok !== 'boolean' || !body.cells)) return { ok: false, unreachable: true, reason: 'The draft save could not be confirmed. Checking the saved values.' }
    if (!response.ok) {
      const reason = body?.error ?? `The draft save was refused (${response.status}).`
      return { ok: false, conflict: response.status === 409, reason, cells: refusedCells(req, reason) }
    }
    if (cells.some(cell => {
      const result = body.cells[cell.colId]
      return typeof result?.ok !== 'boolean' || result.ok && (!result.shopifyWrite?.token || result.shopifyWrite.ownerId !== cell.ownerId || result.shopifyWrite.fieldId !== cell.fieldId)
    })) return { ok: false, unreachable: true, reason: 'The response did not confirm every requested cell identity. Checking the saved draft.' }
    if (body.listing?.id === row.listing?.id && Number.isSafeInteger(body.listing?.version)) row.listing!.version = body.listing.version
    for (const [colId, outcome] of Object.entries(body.cells) as Array<[string, { ok: boolean; shopifyWrite?: ShopifySheetWrite }]>) {
      if (!outcome.ok || !outcome.shopifyWrite) continue
      // Inventory's two physical columns share one structured owner value and draft token.
      for (const cell of Object.values(row.values)) if (cell.shopifyWrite?.ownerId === outcome.shopifyWrite.ownerId && cell.shopifyWrite.fieldId === outcome.shopifyWrite.fieldId) cell.shopifyWrite = outcome.shopifyWrite
      if (row.values[colId]) row.values[colId].shopifyWrite = outcome.shopifyWrite
    }
    return body as SheetWriteResult
  } catch { return { ok: false, unreachable: true, reason: 'The response was interrupted. Checking whether the Nexus draft was saved.' } }
}

const shopifyUnit = (unit: BulkSaveUnitWire): ShopifyUnit | null => {
  const candidate = (unit as Record<string, unknown>)[SHOPIFY_UNIT] as ShopifyUnit | undefined
  return candidate && typeof candidate === 'object' && Array.isArray(candidate.cells) ? candidate : null
}
const answer = (status: number, body: unknown): Answer => ({ status, ok: status >= 200 && status < 300, json: async () => body })

/**
 * The post of ONE sheet action (a Set column, a paste, an undo) for the common bulk engine. Ordinary units go to the
 * bulk-save route exactly as before (an operation without Shopify units is forwarded unchanged, retry contract included).
 * Shopify units are grouped by their exact destination — family, listing, account, market, locale — and sent to that
 * destination's cells route in requests of at most 1,000 cells, in write order (`ShopifyPhase`). Every request carries
 * `actionId`, the action's STABLE id: the engine's own request keys change per round and chunk and are never that id.
 *
 * Each unit hears its own answer: a partly saved request keeps every saved cell saved and every refusal refused; a group
 * that never left (the sheet closed) is "not sent" for its own units only. Receipt keys are unique across the action.
 */
export function createShopifyBulkPost(actionId: string, options: { postOrdinary?: BulkSavePost; signal?: AbortSignal } = {}): BulkSavePost {
  const postOrdinary = options.postOrdinary ?? postBulkSave
  // destroy() flushes still-queued intent once with an already-aborted signal; only a LATER abort cancels unsent work.
  const teardownFlush = options.signal?.aborted === true
  let receipts = 0
  return async (operationId, units) => {
    const shopify = units.flatMap(unit => { const cells = shopifyUnit(unit); return cells ? [{ unit, shopify: cells }] : [] })
    if (!shopify.length) return postOrdinary(operationId, units)
    const answers: Array<{ key: string; status: number; body: unknown }> = []
    const ordinary = units.filter(unit => !shopifyUnit(unit))
    if (ordinary.length) {
      const { res, payload } = await postWithBusyRetry(postOrdinary, operationId, ordinary, options.signal)
      const byKey = new Map((res.ok && Array.isArray(payload?.units) ? payload!.units! : []).map(entry => [entry.key, entry]))
      for (const unit of ordinary) answers.push(res.ok && Array.isArray(payload?.units)
        ? byKey.get(unit.key) ?? { key: unit.key, status: 502, body: { error: 'The save answered without this row.' } }
        : { key: unit.key, status: res.status, body: payload })
    }
    const groups = new Map<string, typeof shopify>()
    for (const entry of [...shopify].sort((a, b) => a.shopify.phase - b.shopify.phase)) {
      const destination = JSON.stringify([entry.shopify.productId, Object.entries(entry.shopify.query).sort(([a], [b]) => a.localeCompare(b))])
      groups.set(destination, [...(groups.get(destination) ?? []), entry])
    }
    for (const group of groups.values()) {
      const parts: Array<typeof shopify> = []
      for (const entry of group) {
        const last = parts.at(-1)
        if (last && last.reduce((sum, e) => sum + e.shopify.cells.length, 0) + entry.shopify.cells.length <= MAX_CELLS) last.push(entry)
        else parts.push([entry])
      }
      for (const part of parts) {
        if (!teardownFlush && options.signal?.aborted) {
          for (const { unit } of part) answers.push({ key: unit.key, status: 400, body: { error: 'These edits were not sent because the sheet changed or closed.', nothingSaved: true } })
          continue
        }
        const sent = part.map(entry => ({ ...entry, cells: entry.shopify.cells.map(cell => ({ ...cell, receiptKey: String(++receipts) })) }))
        const { productId, query } = part[0].shopify
        let status: number, body: Record<string, any> | null
        try {
          const response = await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/shopify-linked/cells?${new URLSearchParams(query)}`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: actionId, cells: sent.flatMap(entry => entry.cells) }),
          })
          status = response.status
          body = await response.json().catch(() => null)
        } catch { status = 502; body = null }
        const confirmed = status >= 200 && status < 300 && !!body && typeof body.ok === 'boolean' && !!body.cells && typeof body.cells === 'object'
        for (const entry of sent) {
          if (!confirmed) { answers.push({ key: entry.unit.key, status: status >= 200 && status < 300 ? 502 : status, body }); continue }
          // Each unit's own cells, by the receipt keys this request gave them; a cell the answer omits stays unconfirmed.
          const cells = Object.fromEntries(entry.cells.flatMap(cell => body!.cells[cell.receiptKey!] ? [[cell.colId, body!.cells[cell.receiptKey!]]] : []))
          answers.push({ key: entry.unit.key, status: 200, body: { ok: entry.cells.every(cell => cells[cell.colId]?.ok === true), cells, listing: body!.listing } })
        }
      }
    }
    return answer(200, { units: answers })
  }
}
