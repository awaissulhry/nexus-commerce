'use client'

/**
 * PES.3 — the channel scope's data: read one channel×market, save ONE CELL at a time.
 *
 * Reads `GET /api/products/:id/studio/sheet?scope=channel&…` (PES.5 §3.2, Owner-approved
 * 2026-09-01). Writes stay on `PATCH /api/products/bulk` — §3.2 is explicit that "the write path
 * itself is unchanged" — driven by PES.2's `SheetWriter`, which owns batching, version advancement
 * and per-row serialisation (hub ruling #11). This module supplies only its `commit`.
 *
 * Autosave per cell, no page-level Save, no dirty-sheet state; a refusal is a RESULT that stays on
 * the cell rather than a toast that scrolls away.
 *
 * ── Honesty about the backend ───────────────────────────────────────────────────────────────────
 * PES.5's route is approved but not deployed yet. Until it is, this reports `backendMissing` and the
 * sheet says so on screen. It NEVER substitutes fixture rows: a channel scope drawing plausible
 * aliases from a fixture would be a page lying about live listings.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { commitShopifySheetRow } from '../../shopify/channelSheetWriter'
import { applyNormalizedReferenceChanges } from '../normalizedReferenceChanges'

import { commitLanguageGroups } from '../languageWrites'
import { commitVariationTheme } from '../master/masterWrite'
import { columnLanguages } from '../languages'
import { getBackendUrl } from '@/lib/backend-url'
import { fetchStudioRead, StudioReadError, studioReadMessage } from '../../studio-read'

import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'

import { wireAliasKey } from './types'
import { wholeListWriteField } from './provenance'
import type { AliasGroup, ChannelScopeChannel, ChannelScopePage, ChannelSheetRow } from './types'

export interface UseChannelSheetOptions {
  schemaRevision?: string

  accountId?: string
  /** The route's `[id]`. May be a parent or a child — PES.5 resolves to the family root. */
  productId: string
  channel: ChannelScopeChannel
  marketplace: string
  locale?: string
  locales?: string[] | null
  view?: string
}

export interface ChannelSheetState {
  data: ChannelScopePage | null
  loading: boolean
  error: string | null
  /**
   * True when the failure is specifically "PES.5's route is not deployed yet" (404 / 501). The sheet
   * renders an honest notice for this instead of an empty grid — an empty grid and a missing
   * endpoint look identical to an operator, and only one is a fact about the catalogue.
   */
  backendMissing: boolean
  reload: () => void
  /** Reconcile saved values and provenance without replacing the grid with a loading state. */
  refresh: (canApply: () => boolean) => Promise<void>
  applyLocal: (rowId: string, mutate: (row: ChannelSheetRow) => void) => void
}

/**
 * PES.5 §3.2.
 *
 * 🔴 The market parameter is `market`, NOT `marketplace`. §3.2's prose writes `&marketplace=`, but
 * the shipped route reads `q.market` and answers `400 {"error":"market is required"}` — verified
 * against the running service, not the doc. The RESPONSE still calls it `scope.marketplace`, so the
 * two names genuinely coexist and only the request side takes `market`.
 */
export function channelScopeUrl(o: UseChannelSheetOptions): string {
  const params = new URLSearchParams({
    scope: 'channel',
    channel: o.channel,
    market: o.marketplace,
  })
  if (o.accountId) params.set('accountId', o.accountId)
  if (o.locale) params.set('locale', o.locale)
  if (o.locales) params.set('locales', o.locales.join(','))
  if (o.view) params.set('view', o.view)
  return `${getBackendUrl()}/api/products/${o.productId}/studio/sheet?${params}`
}

/** A successful HTTP response must contain a sheet before it can replace the current view. */
export function channelSheetResponse(body: unknown): ChannelScopePage {
  const page = body as Partial<ChannelScopePage> | null
  if (!page || !Array.isArray(page.rows) || !Array.isArray(page.columns) || !Array.isArray(page.aliases) ||
      !page.scope || typeof page.scope.channel !== 'string' || typeof page.scope.marketplace !== 'string' ||
      !page.meta || !Array.isArray(page.meta.schemaMissing) || !Array.isArray(page.meta.schemaAge)) {
    throw new Error('The information response was incomplete. Try again.')
  }
  return page as ChannelScopePage
}

export function useChannelSheet(options: UseChannelSheetOptions): ChannelSheetState {
  const url = channelScopeUrl(options)
  const activeUrl = useRef(url)
  activeUrl.current = url
  const [response, setResponse] = useState<{ url: string; data: ChannelScopePage | null } | null>(null)
  const data = response?.url === url ? response.data : null
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backendMissing, setBackendMissing] = useState(false)
  const [nonce, setNonce] = useState(0)
  // A slow coordinate must not paint over a faster one the operator has since switched to.
  const requestRef = useRef(0)

  useEffect(() => {
    const mine = ++requestRef.current
    let cancelled = false
    const abort = new AbortController()
    setLoading(true)
    setError(null)
    setBackendMissing(false)

    // Keep the current coordinate's schema during reload so AG retains column state.
    // `response.url === url` above already prevents another coordinate's data from showing.
    fetchStudioRead(url, abort.signal)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new StudioReadError(res.status, body)
        return channelSheetResponse(body)
      })
      .then((body) => {
        if (cancelled || mine !== requestRef.current || activeUrl.current !== url) return
        setResponse({ url, data: body })
      })
      .catch((err: unknown) => {
        if (cancelled || mine !== requestRef.current || activeUrl.current !== url) return
        setResponse(previous => previous?.url === url ? previous : { url, data: null })
        setBackendMissing(!!(err as { backendMissing?: boolean })?.backendMissing)
        setError(studioReadMessage(err))
      })
      .finally(() => {
        if (!cancelled && mine === requestRef.current && activeUrl.current === url) setLoading(false)
      })

    return () => {
      cancelled = true
      requestRef.current++
      abort.abort()
    }
  }, [url, nonce, options.schemaRevision])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const refresh = useCallback(async (canApply: () => boolean) => {
    if (activeUrl.current !== url) return
    const mine = ++requestRef.current
    try {
      const res = await fetch(url, {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return
      const body = channelSheetResponse(await res.json())
      if (mine === requestRef.current && activeUrl.current === url && canApply()) setResponse({ url, data: body })
    } catch {
      // Preserve the confirmed edit if the follow-up read is temporarily unavailable.
    }
  }, [url])

  const applyLocal = useCallback((rowId: string, mutate: (row: ChannelSheetRow) => void) => {
    setResponse((prev) => {
      if (!prev?.data || prev.url !== url || activeUrl.current !== url) return prev
      const rows = prev.data.rows.map((r) => {
        const id = `${r.aliasId ?? 'primary'}:${r.id}`
        if (id !== rowId && r.id !== rowId) return r
        const next = { ...r, values: { ...r.values } } as ChannelSheetRow
        mutate(next)
        return next
      })
      return { url, data: { ...prev.data, rows } }
    })
  }, [url])

  const current = response?.url === url
  return { data, loading: current ? loading : true, error: current ? error : null, backendMissing: current && backendMissing, reload, refresh, applyLocal }
}

/**
 * Send ONE row's batch of cell edits — the `commit` PES.2's `SheetWriter` asks this lane for.
 *
 * The writer owns batching, version advancement and per-row serialisation; this owns only the wire.
 * Two rules it must not get wrong:
 *
 *  1. **The write target comes from the CELL**, not from this client. PES.5 §3.2 sends `writeField`
 *     + `writeTarget` "so the grid never has to re-derive where a cell writes". Re-deriving it here
 *     is exactly how a channel edit silently lands on the master record.
 *  2. **A reset is not "write null".** The substrate carries `intent` per cell, so a reset rides as
 *     `intent: 'reset'` and the server restores `follows` / deletes the override key, letting the
 *     value fall back up the cascade. Writing null instead would pin an explicit blank.
 *
 * A refusal is a RESULT, never an exception, and `version` is returned on success AND on a 409 so
 * the writer stays able to retry instead of stuck one version behind for the session.
 */
/**
 * Does this cell's write land on the ChannelListing rather than the Product?
 *
 * The SERVER's answer (`writeTarget`), never a client copy of the API's `CHANNEL_FIELD_MAP`
 * (D15.16.4). Exported so the write contract's test can assert the predicate itself rather than
 * only its consequences.
 */
export const writeLandsOnListing = (cell: { writeTarget?: string } | null | undefined): boolean =>
  cell?.writeTarget === 'channelListing'

async function commitChannelLanguage(
  req: SheetWriteRequest<ChannelSheetRow>,
  coord: { channel: ChannelScopeChannel; marketplace: string; accountId?: string; locale?: string },
): Promise<SheetWriteResult> {
  const row = req.row
  if (!row) return { ok: false, reason: 'The grid no longer holds this row — reload the sheet' }
  if (row.shopify && req.cells.every(cell => !!row.values[cell.colId]?.shopifyWrite && !row.values[cell.colId]?.contentAcknowledgement)) return commitShopifySheetRow(req, coord)
  if (req.cells.some(cell => !!row.values[cell.colId]?.shopifyWrite && !row.values[cell.colId]?.contentAcknowledgement)) {
    const results: SheetWriteResult[] = [], cells: NonNullable<SheetWriteResult['cells']> = {}
    // Shared/listing CAS first; the narrow Shopify adapter independently checks each draft cell.
    for (const native of [false, true]) {
      const subset = req.cells.filter(cell => (!!row.values[cell.colId]?.shopifyWrite && !row.values[cell.colId]?.contentAcknowledgement) === native)
      const result = await commitChannelRow({ ...req, cells: subset }, coord)
      results.push(result)
      for (const cell of subset) cells[cell.colId] = { ...(result.cells?.[cell.colId] ?? { ok: result.ok, reason: result.reason }), unreachable: result.cells?.[cell.colId]?.unreachable ?? !!result.unreachable }
    }
    return { ok: results.every(result => result.ok), cells, version: results[0].version, conflict: results.some(result => result.conflict), unreachable: results.some(result => result.unreachable), reason: results.find(result => !result.ok)?.reason }
  }

  const changes = req.cells.map(({ colId, value, intent }) => {
    const cell = row.values?.[colId]
    const address = intent === 'reset' || intent === 'reset-list' ? cell?.contentAcknowledgement?.pin.address ?? cell?.contentAddress : cell?.contentAddress
    const isReset = intent === 'reset' || intent === 'reset-list'
    return {
      colId,
      change: {
        id: row.id,
        contentAddress: address,
        ...(cell?.contentAcknowledged || isReset && cell?.contentAcknowledgement ? { contentAcknowledged: true } : {}),
        contentVersion: cell?.contentVersion,
        // Fall back to the column key only when the server sent no cell for it; a made-up
        // writeField would be a write aimed at nothing.
        field: intent === 'reset-list' ? wholeListWriteField(cell?.writeField ?? colId) ?? cell?.writeField ?? colId : cell?.writeField ?? colId,
        value: isReset ? null : value,
        /**
         * 🔴 THE ROW THE WRITE LANDS ON, from the server's own `writeTarget` (#697, hub-ruled).
         *
         * This was `cell.writeVerb`, under a comment of mine asserting that sending `target:
         * 'channel'` for the six column-backed fields (`{amazon,ebay}_{title,description,
         * variationTheme}` — `writeTarget: 'channelListing'`, `writeVerb: 'master'`) "would send
         * both routes and land the write twice over". **Verified against the route before changing
         * it, and it is false today:** `isChannelChange` (`products.routes.ts:1354`) routes a
         * NON-`attr_*` field by its field NAME and ignores `target` entirely, and the write is an
         * `if (v.cascade) … else if (isCh) … else` chain (`:2536`) — one branch, never two. What
         * `target` actually decides for these fields is `hasMasterTargetedChange` (`:2703`), i.e.
         * WHICH ROW's version the CAS guards, and the audit row's layer (`:2946`).
         *
         * So the old pairing sent the PRODUCT's version as the token for a write that only ever
         * touched the listing — captured on the wire at 14:52: `field: amazon_title`, `target:
         * "master"`, `expectedVersion: 3`, on a row whose listing was at 82. Wrong in both
         * directions: a concurrent listing change did not conflict, and a concurrent product change
         * would have 409'd a write that never touched the product.
         *
         * `writeTarget` is the SERVER's statement of where the write lands, so target and token now
         * come from one source. It is deliberately NOT a client copy of the API's
         * `CHANNEL_FIELD_MAP` (D15.16.4): a client that re-derives the routing drifts the first time
         * a field is added to the map, and that map has grown twice already.
         *
         * Defaulting to `'master'` when the server sent no cell matches the endpoint's own default
         * — the safe direction is the shared record refusing the edit, not a silent channel write.
         */
        target: cell?.contentAcknowledgement ? address?.tier === 'pin' ? 'channel' : 'master' : writeLandsOnListing(cell) ? 'channel' : cell?.writeVerb ?? 'master',
        intent: intent === 'reset-list' ? 'reset' : intent,
      },
    }
  })

  const touchesChannel = changes.some(c => c.change.target === 'channel')
  const touchesMaster = changes.some(c => c.change.target !== 'channel')
  // Each persisted row has its own counter. Split a mixed paste into two guarded writes,
  // and retain each cell's verdict if one scope fails or loses its connection.
  if (touchesChannel && touchesMaster) {
    const cells: NonNullable<SheetWriteResult['cells']> = {}
    const results: SheetWriteResult[] = []
    for (const target of ['master', 'channel'] as const) {
      const subset = req.cells.filter((_, i) => (changes[i].change.target === 'channel') === (target === 'channel'))
      const result = await commitChannelRow({ ...req, cells: subset }, coord)
      results.push(result)
      for (const cell of subset) cells[cell.colId] = {
        ...(result.cells?.[cell.colId] ?? { ok: result.ok, reason: result.reason }),
        unreachable: result.cells?.[cell.colId]?.unreachable ?? !!result.unreachable,
      }
    }
    return {
      ok: results.every(r => r.ok), cells, version: results[0].version,
      conflict: results.some(r => r.conflict), unreachable: results.some(r => r.unreachable),
      reason: results.find(r => !r.ok)?.reason,
    }
  }
  const casVersion = touchesChannel ? row.listing?.version : req.expectedVersion

  try {
    const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
      method: 'PATCH',
        signal: AbortSignal.timeout(30_000),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        changes: changes.map((c) => c.change),
        // `aliasKey`, not `aliasId` — and never omitted. The server treats an absent key as `''`
        // only as a courtesy; naming it is what makes the override merge land on THIS alias's
        // listing rather than the primary (§14's ON CONFLICT names the five-column key).
        marketplaceContexts: [
          { channel: coord.channel, marketplace: coord.marketplace, ...(coord.accountId ? { accountId: coord.accountId } : {}), ...(coord.locale ? { locale: coord.locale } : {}), aliasKey: wireAliasKey(row.aliasId) },
        ],
        ...(casVersion !== undefined ? { expectedVersion: casVersion } : {}),
      }),
    })
    const body = await res.json().catch(() => null)
    if (res.status >= 500 || res.ok && (!body || typeof body.updated !== 'number' && !Array.isArray(body.errors))) {
      return { ok: false, unreachable: true, reason: 'Save confirmation was unavailable. Checking the stored values.' }
    }
    const raw = typeof body?.currentVersion === 'number' ? body.currentVersion : undefined
    /**
     * 🔴 `versionOf` says WHICH ROW the number belongs to — read it, never infer it.
     *
     * The two counters are unrelated (89% of listings differ from their product), so applying a
     * listing version to the product row, or the reverse, silently poisons the next CAS with a
     * number from the wrong table. Before this field existed a channel conflict returned the
     * PRODUCT's version and the sheet reported "someone changed this listing (v1)" while the
     * listing was at 19.
     *
     * A listing version is written straight back onto `row.listing` so the NEXT edit on this row
     * chains without a refetch — and is deliberately NOT returned as the write result's `version`,
     * which the sheet writer applies to the product row it tracks.
     */
    const versionOf: 'channelListing' | 'product' | undefined = body?.versionOf
    if (versionOf === 'channelListing' && raw !== undefined && row.listing) row.listing.version = raw
    const version = versionOf === 'product' ? raw : undefined

    if (res.status === 404 || res.status === 501) {
      return { ok: false, reason: 'The channel write path is not deployed yet (PES.5)' }
    }
    if (res.status === 409) {
      if (['AMBIGUOUS_CONNECTION', 'LISTING_SCOPE_MISMATCH'].includes(body?.code ?? body?.error)) {
        return { ok: false, reason: body?.message || 'Reload and choose the correct listing and account before editing.' }
      }
      // Hand the server's version back so the writer can retry rather than stay behind.
      return {
        ok: false,
        conflict: true,
        version,
        // Name the row the number belongs to, or say nothing about a version at all. Asserting a
        // listing version we were handed from the product row is how the old message said "v1"
        // about a listing sitting at 19.
        reason: body?.message || body?.error || (
          versionOf === 'channelListing'
            ? `Someone else changed this listing (now v${raw ?? '?'}). Review the edit before reloading.`
            : versionOf === 'product'
              ? `Someone else changed this product (now v${raw ?? '?'}). Review the edit before reloading.`
              : 'Someone else changed this row first. Review the edit before reloading.'),
      }
    }
    if (!res.ok) {
      const first = Array.isArray(body?.errors) ? body.errors[0] : undefined
      return { ok: false, reason: first?.error || body?.message || body?.error || `Refused (HTTP ${res.status})` }
    }

    // A 200 can still carry per-cell refusals alongside partial success. Map them back onto the
    // cells that caused them so each one paints its own outcome.
    applyNormalizedReferenceChanges(body ?? {}, row, changes.map(({ colId, change }) => ({ colId, field: change.field, value: change.value })))
    const errors: Array<{ id?: string; field?: string; error?: string }> = Array.isArray(body?.errors) ? body.errors : []
    if (errors.length > 0) {
      const cells: Record<string, { ok: boolean; reason?: string }> = {}
      for (const { colId, change } of changes) {
        const hit = errors.find((e) => e.field === change.field && (e.id === undefined || e.id === row.id))
        cells[colId] = hit ? { ok: false, reason: hit.error || 'Refused' } : { ok: true }
      }
      return { ok: false, version, cells }
    }
    /**
     * 🔴 `updated: 0` IS A SUCCESS WHEN THE SERVER SAYS WHY (#700, measured on screen).
     *
     * This branch was written when `updated: 0` meant "nothing happened and nobody said why" — the
     * silent-drop shape, which must never paint as saved. PES.5's #675 then made a no-op EXPLICIT:
     * a request whose values already match returns `200 { success: true, updated: 0, unchanged: n }`
     * with the listing's own version. Against that response the old test read a stated success as a
     * failure — measured on the screen at 15:19: a refusal corrected back to its stored value
     * answered `{updated: 0, unchanged: 1, currentVersion: 82, versionOf: 'channelListing'}` and the
     * header still said "1 change not saved", with the operator's cell showing the right value and
     * nothing left to save. That is the honest-UI rule broken in the direction nobody checks: a lie
     * about work still being OUTSTANDING.
     *
     * `unchanged` is what separates the two. Without it — an older server, or a drop nobody
     * explained — the guard stands exactly as before.
     */
    if (body?.updated === 0) {
      const unchanged = typeof body?.unchanged === 'number' ? body.unchanged : 0
      if (unchanged === 0) {
        return { ok: false, version, reason: 'The server accepted the request but changed nothing' }
      }
    }

    return { ok: true, version }
  } catch (err) {
    return { ok: false, unreachable: true, reason: `Connection lost — refresh to check whether this saved. ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * `[+ Add listing alias]` — PES.5 §3.4.
 *
 * The server creates the alias AND its `ChannelListing` rows (family root + children) with no
 * overrides, so the new alias opens fully inheriting. Nothing is sent to the channel: it is a local
 * record until the operator publishes it explicitly through the preflight-first path.
 */
export async function addListingAlias(input: {
  productId: string
  channel: ChannelScopeChannel
  marketplace: string
  accountId?: string
  label?: string
}): Promise<{ ok: boolean; alias?: AliasGroup; reason?: string }> {
  const { productId, channel, marketplace, label, accountId } = input
  try {
    const res = await fetch(`${getBackendUrl()}/api/products/${productId}/aliases`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, marketplace, label, accountId }),
    })
    const body = await res.json().catch(() => null)
    if (res.status === 404 || res.status === 501) {
      return { ok: false, reason: 'The alias route is not deployed yet (PES.5 §3.4)' }
    }
    if (!res.ok) return { ok: false, reason: body?.message || body?.error || `Refused (HTTP ${res.status})` }
    return { ok: true, alias: body as AliasGroup }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Rename or reorder an alias (PES.5 §3.4). Archiving (`DELETE`) is deliberately NOT wired here:
 * it takes a live listing's local record out of the sheet, so it asks first, separately.
 */
export async function updateListingAlias(input: {
  productId: string
  aliasId: string
  accountId?: string
  label?: string
  position?: number
}): Promise<{ ok: boolean; reason?: string }> {
  const { productId, aliasId, ...patch } = input
  try {
    const res = await fetch(`${getBackendUrl()}/api/products/${productId}/aliases/${aliasId}`, {
      method: 'PATCH',
        signal: AbortSignal.timeout(30_000),
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.status === 404 || res.status === 501) {
      return { ok: false, reason: 'The alias route is not deployed yet (PES.5 §3.4)' }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      return { ok: false, reason: body?.message || body?.error || `Refused (HTTP ${res.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}


export function commitChannelRow(
  req: SheetWriteRequest<ChannelSheetRow>,
  coord: { channel: ChannelScopeChannel; marketplace: string; accountId?: string; locale?: string; kindOf?: (colId: string) => string | undefined },
): Promise<SheetWriteResult> {
  /**
   * VT.2 — a `variationTheme` cell leaves by its OWN route, exactly as the master sheet's does.
   *
   * The split sits here for the same reason the Shopify split sits in `commitChannelLanguage`: a
   * fill or a paste can carry one theme cell beside ordinary ones, and each half must reach the
   * route that accepts it. `variation_theme` was removed from `CHANNEL_WRITABLE` and from
   * `CHANNEL_FIELD_MAP` by VT.1, so the bulk route would refuse the whole batch.
   *
   * 🔴 Routed on `kindOf` — the COLUMN's kind — and never on `writeField` or on the shape of the
   * value. The adapter supplies it because this function is not given the column set; when it is
   * absent nothing is split, which is the old behaviour exactly.
   */
  const theme = coord.kindOf ? req.cells.filter((c) => coord.kindOf!(c.colId) === 'variationTheme') : []
  if (theme.length > 0) {
    const rest = req.cells.filter((c) => coord.kindOf!(c.colId) !== 'variationTheme')
    /* 🔴 `row.id`, the bare PRODUCT id — never `rowId`, which is this scope's grid identity
       (`aliasKey:productId`, because the same child under three aliases is three rows). A rowId in
       the URL would address no product at all. */
    const productId = req.row?.id ?? req.rowId.split(':').pop() ?? req.rowId
    return (async () => {
      const themed = await commitVariationTheme({ ...req, cells: theme }, productId)
      if (rest.length === 0) return themed
      const other = await commitChannelRow({ ...req, cells: rest }, coord)
      return {
        ok: themed.ok && other.ok,
        cells: { ...themed.cells, ...other.cells },
        version: other.version ?? themed.version,
        conflict: themed.conflict || other.conflict,
        unreachable: themed.unreachable || other.unreachable,
        reason: themed.reason ?? other.reason,
      }
    })()
  }
  return commitLanguageGroups(req, key => columnLanguages([key])[0] ?? coord.locale,
    (request, language) => commitChannelLanguage(request, { ...coord, locale: language }))
}
