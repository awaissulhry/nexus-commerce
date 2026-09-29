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
import { directBulkSend, nothingSaved, type BulkSend } from '../bulkOperation'
import { fetchStudioRead, StudioReadError, studioReadMessage } from '../../studio-read'

import type { SheetWriteRequest, SheetWriteResult } from '@/design-system/grid'

import { wireAliasKey } from './types'
import { wholeListWriteField } from './provenance'
import type { AliasGroup, ChannelScopeChannel, ChannelScopePage, ChannelSheetRow, SheetListing } from './types'

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
  /**
   * Only the LANGUAGES changed and the new read is on its way (2026-09-27): `data` is still the last page of this
   * coordinate, which the surface dims and holds, instead of blanking to a skeleton.
   */
  switching: boolean
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
  const switching = !!response?.data && response.url !== url && sameCoordinate(response.url, url)
  const data = response?.url === url || switching ? response?.data ?? null : null
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
  return { data, loading: current ? loading : !switching, switching, error: current ? error : null, backendMissing: current && backendMissing, reload, refresh, applyLocal }
}

/** Two reads of the same coordinate that differ only in the languages asked for. */
export function sameCoordinate(a: string, b: string): boolean {
  const withoutLanguages = (href: string) => {
    const parsed = new URL(href, 'http://sheet.invalid')
    parsed.searchParams.delete('locales')
    parsed.searchParams.sort()
    return parsed.toString()
  }
  return withoutLanguages(a) === withoutLanguages(b)
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

/* ── Product-sheet create path, step 6 (the Owner's D1 = A, 2026-09-27) ─────────────────────────────────────────────
 *
 * The first channel-scope save on a coordinate where the product has no listing starts the family's inert DRAFT
 * (parent + every variant) on the server, in the save's own transaction. The token for "I saw no listing" is version
 * 0 — the projection's convention, and the one the bulk route now accepts:
 *   - a channel write on a row with no listing sends `expectedVersion: 0` (it used to send none, which the price and
 *     fulfilment doors refused with the wrong reason);
 *   - a 200 may carry `createdListings` (the whole started family): every grid row it names adopts its listing at once,
 *     so the next save on ANY row of the family carries the real id and version without a reload;
 *   - a 409 to token 0 names the listing that was there after all (`listingId`, `currentVersion`): the row adopts it
 *     and the save is sent ONCE more at that version — never a loop. Every other conflict is answered as before.
 */

/** "I saw no listing on this coordinate" — a listing's own version is never 0 (the schema starts it at 1). */
export const NO_LISTING_VERSION = 0

/** One listing a save started, as the server reports it (`createdListings[]`). */
export interface CreatedListing {
  productId: string
  listingId: string
  /** The version it holds after the save's writes; `null` when the server could not read it back. */
  version: number | null
}

/** The listings a save started, from its answer. Anything malformed is left out rather than guessed. */
export function createdListingsOf(body: unknown): CreatedListing[] {
  const list = (body as { createdListings?: unknown } | null)?.createdListings
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const e = entry as { productId?: unknown; listingId?: unknown; version?: unknown } | null
    if (!e || typeof e.productId !== 'string' || typeof e.listingId !== 'string') return []
    const version = typeof e.version === 'number' && Number.isSafeInteger(e.version) ? e.version : null
    return [{ productId: e.productId, listingId: e.listingId, version }]
  })
}

/** The API's `FOLLOW_FLAGS` (`studio-sheet.service.ts`): all true on a started draft, their schema default. */
const FOLLOW_FLAGS = ['followMasterTitle', 'followMasterDescription', 'followMasterPrice', 'followMasterQuantity', 'followMasterImages', 'followMasterBulletPoints'] as const

/**
 * A listing the save STARTED: every field is what `ensureDraftListings` writes (the API's one creator — DRAFT, never
 * published, paused, no channel id, no price or quantity), so the row reads as the draft it is until the next read.
 */
export function startedDraftListing(id: string, version: number): SheetListing {
  return {
    id, version, listingStatus: 'DRAFT', isPublished: false, offerActive: true, price: null, quantity: null,
    externalListingId: null, syncPaused: true, follows: Object.fromEntries(FOLLOW_FLAGS.map((flag) => [flag, true])),
  }
}

/**
 * A listing known only from a version-0 conflict: its id and version, nothing else. Its status reads "not recorded"
 * (empty) and it carries no channel id until the sheet's next read, which follows every settled save — so nothing on
 * screen calls it a draft (`isStillDraftListing` is false for it) or a live listing meanwhile.
 */
function conflictListing(id: string, version: number): SheetListing {
  return { id, version, listingStatus: '', isPublished: false, offerActive: true, price: null, quantity: null, externalListingId: null, follows: {} }
}

/**
 * Adopt the listings a save started into every grid row they belong to: the saved row and its family, because the
 * server starts the parent and every variant together. Only rows of the saved row's alias that hold no listing yet
 * (a started draft never replaces a listing the sheet already read); an entry without a read-back version is left for
 * the next read — a save on that row sends 0 and adopts from the conflict. Returns the rows it changed.
 */
export function adoptCreatedListings(
  rows: Iterable<ChannelSheetRow>,
  created: readonly CreatedListing[],
  aliasId: string | null,
): ChannelSheetRow[] {
  const adopted: ChannelSheetRow[] = []
  for (const row of rows) {
    if (row.listing || (row.aliasId ?? '') !== (aliasId ?? '')) continue
    const hit = created.find((entry) => entry.productId === row.id)
    if (!hit || hit.version === null) continue
    row.listing = startedDraftListing(hit.listingId, hit.version)
    adopted.push(row)
  }
  return adopted
}

/** The listings a variation-theme save at version 0 started, from the projection it answers with. */
export function projectionStartedListings(payload: unknown): CreatedListing[] {
  const read = payload as {
    version?: unknown
    parent?: { id?: unknown; listing?: { listingId?: unknown } }
    children?: Array<{ id?: unknown; listing?: { listingId?: unknown } }>
  } | null
  const parentId = read?.parent?.id, parentListing = read?.parent?.listing?.listingId
  if (typeof parentId !== 'string' || typeof parentListing !== 'string') return []
  const version = typeof read?.version === 'number' && Number.isSafeInteger(read.version) ? read.version : null
  // The projection states the PARENT listing's version only; a variant's is left for the next read.
  return [{ productId: parentId, listingId: parentListing, version }, ...(Array.isArray(read?.children) ? read.children : []).flatMap((child) =>
    typeof child?.id === 'string' && typeof child.listing?.listingId === 'string' ? [{ productId: child.id, listingId: child.listing.listingId, version: null }] : [])]
}

/**
 * A variation-theme save on a coordinate that HAS a listing: the projection answers with its parent listing's new
 * version (`ProjectionRead.version`). It is the LISTING's number, so it goes to the row's listing — the one the
 * projection names — and never to the product version the sheet writer tracks.
 */
export function adoptProjectionListingVersion(row: ChannelSheetRow | null, payload: unknown): void {
  const read = payload as { version?: unknown; parent?: { listing?: { listingId?: unknown } } } | null
  if (!row?.listing || !Number.isSafeInteger(read?.version) || read?.parent?.listing?.listingId !== row.listing.id) return
  row.listing.version = read!.version as number
}

/** Where a channel write goes, and how the host hears about the drafts a save started. */
export interface ChannelWriteCoord {
  channel: ChannelScopeChannel
  marketplace: string
  accountId?: string
  locale?: string
  kindOf?: (colId: string) => string | undefined
  /** Every row the grid holds, so a started family is adopted into all of them — not only the saved one. */
  familyRows?: () => Iterable<ChannelSheetRow>
  /** A save started listings on this coordinate (`adopted`: the rows that now hold one). */
  onListingsCreated?: (created: CreatedListing[], adopted: ChannelSheetRow[]) => void
  /**
   * How this row's `PATCH /api/products/bulk` body leaves: on its own (default), or as one unit of the sheet
   * operation's single bulk-save request (`runBulkOperation`, `bulkOperation.ts`). Everything else here is the same.
   */
  bulkSend?: BulkSend
}

function reportCreated(req: SheetWriteRequest<ChannelSheetRow>, coord: ChannelWriteCoord, created: CreatedListing[]): void {
  if (!created.length) return
  const rows = [...(req.row ? [req.row] : []), ...(coord.familyRows?.() ?? [])]
  // Adopted whether or not a host listens: the next save's token depends on it.
  const adopted = adoptCreatedListings(rows, created, req.row?.aliasId ?? null)
  coord.onListingsCreated?.(created, adopted)
}

async function commitChannelLanguage(
  req: SheetWriteRequest<ChannelSheetRow>,
  coord: ChannelWriteCoord,
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
  // A channel write CAS-guards the LISTING; with no listing on the row yet, 0 says "I saw none" and the server starts
  // the family's draft (create path, step 6). Never the product's version as a stand-in.
  const casVersion = touchesChannel ? row.listing ? row.listing.version : NO_LISTING_VERSION : req.expectedVersion

  try {
    const send = (expectedVersion: number | undefined) => (coord.bulkSend ?? directBulkSend)({
      changes: changes.map((c) => c.change),
      // `aliasKey`, not `aliasId` — and never omitted. The server treats an absent key as `''`
      // only as a courtesy; naming it is what makes the override merge land on THIS alias's
      // listing rather than the primary (§14's ON CONFLICT names the five-column key).
      marketplaceContexts: [
        { channel: coord.channel, marketplace: coord.marketplace, ...(coord.accountId ? { accountId: coord.accountId } : {}), ...(coord.locale ? { locale: coord.locale } : {}), aliasKey: wireAliasKey(row.aliasId) },
      ],
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })
    let res = await send(casVersion)
    let body = await res.json().catch(() => null)
    /**
     * The version-0 conflict: a listing WAS there (another tab's first save, or any other creator, won the race). The
     * 409 names it — adopt its id and version and send the same edit ONCE more at that version. The retry's own answer
     * is final: a second conflict is reported like every other, never retried again.
     */
    if (touchesChannel && casVersion === NO_LISTING_VERSION && res.status === 409 && body?.code === 'VERSION_CONFLICT' &&
        body.versionOf === 'channelListing' && typeof body.listingId === 'string' && Number.isSafeInteger(body.currentVersion) &&
        (!row.listing || row.listing.id === body.listingId)) {
      if (row.listing) row.listing.version = body.currentVersion
      else row.listing = conflictListing(body.listingId, body.currentVersion)
      res = await send(body.currentVersion)
      body = await res.json().catch(() => null)
    }
    // A 5xx is "no answer" — unless the bulk save states nothing of it was stored (rolled back): that is a refusal.
    if (res.status >= 500 && !nothingSaved(body) || res.ok && (!body || typeof body.updated !== 'number' && !Array.isArray(body.errors))) {
      return { ok: false, unreachable: true, reason: 'Save confirmation was unavailable. Checking the stored values.' }
    }
    // The drafts this save started: adopted into the saved row and its whole family BEFORE the version write-back
    // below, which then lands on the listing the saved row now holds.
    if (res.ok) reportCreated(req, coord, createdListingsOf(body))
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
  coord: ChannelWriteCoord,
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
      /* Create path, step 6 — a theme saved at version 0 ("no listing here") started the family's draft on this
         coordinate (`writeProjectionMapping`, step 4). The projection it answers with names the started listings. */
      const themed = await commitVariationTheme({ ...req, cells: theme }, productId, (after, payload) => {
        if (after.write?.endpoint !== 'projection') return
        // The projection's `version` is the parent LISTING's: onto `row.listing`, never the row's product version.
        if (after.write.expectedVersion !== NO_LISTING_VERSION) return adoptProjectionListingVersion(req.row, payload)
        // The projection lists every listing the family now has here; a variant the sheet already showed listed was
        // not started by this save, so it is not reported as started.
        const aliasKey = req.row?.aliasId ?? ''
        const listed = new Set([...(coord.familyRows?.() ?? [])].filter((row) => row.listing && (row.aliasId ?? '') === aliasKey).map((row) => row.id))
        reportCreated(req, coord, projectionStartedListings(payload).filter((entry) => !listed.has(entry.productId)))
      })
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
