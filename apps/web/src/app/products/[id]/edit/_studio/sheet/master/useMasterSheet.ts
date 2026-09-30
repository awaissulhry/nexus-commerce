'use client'
import { sheetReadFailure } from './sheetReadFailure'


/**
 * PES.2 — the master sheet's data: one family, one market, and the ONE write path.
 *
 * READ. `GET /api/products/:id/studio/sheet` (PES.5 §3.2) when it exists; otherwise the live
 * catalogue read narrowed to this family (`?parentIds=<id>`, which already returns a parent with
 * its children) run through `adaptLegacySheet`. The two are distinguished on screen, never
 * silently: `meta.source` says which, and the status strip shows it.
 *
 * WRITE. Every edit goes through the DS `SheetWriter` — per-row `expectedVersion` that advances
 * from the server's answer, per-row batching, per-row serialisation, per-cell outcomes. This file
 * supplies only `commit`: the part that knows the endpoints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CellSaveTracker, SheetWriter, type GridApi, type SheetWriteRequest, type SheetWriteResult } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { fetchStudioRead, StudioReadError, studioReadMessage } from '../../studio-read'
import { compactSheetUrl, masterSheetUrl } from '../../sheetUrls'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'

import { adaptLegacySheet, type LegacySheetPage } from './adaptLegacy'
import { recoverSheetRow, unconfirmedIn } from '../sheetRecovery'
import { commitMasterRow } from './masterWrite'
import { runBulkOperation, type BulkSend } from '../bulkOperation'
import { preserveContentVersions } from '../contentVersions'
import { verifyContract, type StudioRow, type StudioSheet } from './types'

export interface UseMasterSheetOptions {
  locales?: string[] | null
  /** The product whose family this sheet edits. May be a parent or a child. */
  productId: string
  market: string
  locale: string
  /** Reported to PES.1's header so it can say "autosave ✓" without guessing. */
  onWriteStart?: (writeId: string, rowId: string) => void
  onWriteEnd?: (writeId: string, ok: boolean, message?: string, rowId?: string) => void
  /** An accepted variation-theme save changed the family's axes (`MasterCommitContext.onVariationThemeSaved`). */
  onVariationThemeSaved?: () => void
  /**
   * A batch SETTLED — the server answered, or we gave up on it.
   *
   * 🔴 `ok` is the whole point and ignoring it is the defect this exists to prevent (#705): this
   * fires for every settled batch, refusals included, so a caller stamping a "Saved" clock from it
   * unconditionally writes a false time over a refused write.
   */
  onSettled?: (info: { rowId: string; ok: boolean; savedAt: string }) => void
  /**
   * R-VT-15 — the server REFUSED these cells, with its own sentence. Fired once per settled batch,
   * never for a cell that got no answer (that is `unknown`, and it has its own sentence). The engine
   * reports; the adapter says it, because the toast provider belongs to the route.
   */
  onRefused?: (refusals: ReadonlyArray<{ rowId: string; colId: string; reason?: string }>) => void
}

export interface MasterSheetState {
  sheet: StudioSheet | null
  loading: boolean
  /**
   * Only the LANGUAGES changed and the new read is on its way (2026-09-27). The last sheet stays on screen — the
   * surface dims it and holds every edit — instead of blanking to a skeleton for the length of a multi-language read.
   */
  switching: boolean
  error: string | null
  /** Contract problems found in a response we still rendered — shown, never swallowed. */
  contractProblems: string[]
  reload: () => void
  refresh: () => void
  writer: SheetWriter<StudioRow>
  tracker: CellSaveTracker
  /** Rows the server moved under us; the sheet offers a refresh rather than fighting the 409. */
  conflicts: string[]
  bindGrid: (api: GridApi<StudioRow> | null) => void
}


export function useMasterSheet(opts: UseMasterSheetOptions): MasterSheetState {
  const { productId, market, locale } = opts
  const localesQuery = opts.locales ? `&locales=${encodeURIComponent(opts.locales.join(','))}` : ''
  const [sheet, setSheet] = useState<StudioSheet | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const lastRead = useRef<{ coordinate: string; locales: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contractProblems, setProblems] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<string[]>([])
  const [nonce, setNonce] = useState(0)
  const quietRead = useRef(false)
  const requestRef = useRef(0)
  const apiRef = useRef<GridApi<StudioRow> | null>(null)
  const sheetRef = useRef<StudioSheet | null>(null)
  sheetRef.current = sheet
  const optsRef = useRef(opts)
  optsRef.current = opts
  const productIdRef = useRef(productId)
  productIdRef.current = productId

  const unsettledWrites = useRef(new Map<string, string>())

  const tracker = useMemo(() => new CellSaveTracker(), [])

  /* ── the write path ─────────────────────────────────────────────────────────────────────── */

  const commit = useCallback(
    // The refs are read HERE, at call time, so the write always sees the current sheet and options
    // rather than the ones that existed when this callback was built.
    // `bulkSend` present = this row is one unit of a sheet operation, sent with every other row it changed as ONE
    // bulk-save request (`runBulkOperation`, `bulkOperation.ts`). Everything else about the row's save is the same.
    async (req: SheetWriteRequest<StudioRow>, bulkSend?: BulkSend): Promise<SheetWriteResult> => {
      let completed: Parameters<NonNullable<UseMasterSheetOptions['onWriteEnd']>> | undefined
      const result = await commitMasterRow(req, { sheet: sheetRef.current, bulkSend, opts: {
        onWriteStart: (id, rowId) => optsRef.current.onWriteStart?.(id, rowId),
        onWriteEnd: (...args) => { completed = args },
      }, locale, market, onVariationThemeSaved: () => optsRef.current.onVariationThemeSaved?.() })
      if (completed) {
        if (result.unreachable) unsettledWrites.current.set(req.rowId, completed[0])
        else optsRef.current.onWriteEnd?.(...completed)
      }
      return result
    },
    [locale, market],
  )

  const writer = useMemo(
    () =>
      new SheetWriter<StudioRow>({
        mergeRow: preserveContentVersions,
        tracker,
        commit,
        // A fill, a paste, an undo — every row it changed leaves as ONE request (measured 2026-09-29 on the channel
        // scope: one request per row made 224 of 250 rows fail or go unconfirmed; this scope sent the same shape).
        commitBatch: (requests) => runBulkOperation(requests, commit),
        // ONE read for every row a lost answer left unknown, for the reason `readBack` below reads quietly.
        readBackBatch: async (requests) => {
          const url = `${getBackendUrl()}/api/products/${productIdRef.current}/studio/sheet?market=${encodeURIComponent(market)}&locale=${encodeURIComponent(locale)}${localesQuery}`
          const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000) }).catch(() => null)
          if (!res?.ok) return null
          const page = await res.json().catch(() => null)
          const reads = await Promise.all(requests.map((request) => recoverSheetRow(page, request, { channel: 'MASTER', market, locale, busy: unconfirmedIn(tracker, request.rowId) })))
          return new Map(requests.flatMap((request, i) => (reads[i] ? [[request.rowId, reads[i]!] as const] : [])))
        },
        getApi: () => apiRef.current,
        /* 🔴 A QUIET read — never `reload()`. `reload()` begins `setLoading(true)`, which drops the
           grid's rows and takes the `unknown` mark with them; measured against a real outage, the
           operator's edit vanished and the sheet sat empty for the whole cold boot. This fetches the
           one row and touches no React state, so the mark and the typed value stay on screen while
           the writer keeps asking.
           `null` means the read did not answer — still unreachable — never "the row is empty". */
        readBack: async (request) => {
          // 🔴 `productIdRef`, not `productId`. This memo's deps are `[tracker, commit]` — adding
          // the id would rebuild the writer and orphan its queue — so a captured `productId` goes
          // stale the moment the route's param changes without a remount, and the reconcile would
          // then read a DIFFERENT product's sheet, never find the row, and retry forever behind an
          // outage banner for a server that is perfectly well. Read at call time, as `commit` does.
          const url = `${getBackendUrl()}/api/products/${productIdRef.current}/studio/sheet?market=${encodeURIComponent(market)}&locale=${encodeURIComponent(locale)}${localesQuery}`
          const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000) }).catch(() => null)
          if (!res?.ok) return null
          return recoverSheetRow(await res.json().catch(() => null), request, { channel: 'MASTER', market, locale, busy: unconfirmedIn(tracker, request.rowId) })
        },
        // Through `optsRef` for the reason `readRow` gives above: this memo's deps are
        // `[tracker, commit]`, and adding the callback would rebuild the writer and orphan its queue.
        onSettled: (info) => {
          optsRef.current.onSettled?.(info)
          // Re-resolve inherited rows, formulas and validation after a confirmed
          // save. The quiet reader preserves pending/refused cells and focus.
          if (info.ok && writer.pending === 0 && !tracker.hasUnconfirmedChanges) {
            quietRead.current = true; setNonce(n => n + 1)
          }
        },
        onReconciled: (info) => {
          const ok = info.ok && !Object.keys(sheetRef.current?.rows.find(row => row.id === info.rowId)?.values ?? {}).some(key => tracker.get(info.rowId, key)?.state === 'refused')
          optsRef.current.onWriteEnd?.(unsettledWrites.current.get(info.rowId) ?? `recovery:${info.rowId}`, ok, ok ? undefined : 'Review the highlighted edits against the stored values.', info.rowId)
          unsettledWrites.current.delete(info.rowId)
          optsRef.current.onSettled?.({ ...info, ok })
          if (ok && writer.pending === 0 && !tracker.hasUnconfirmedChanges) { quietRead.current = true; setNonce(n => n + 1) }
        },
        // R-VT-15 — through `optsRef` like every other callback here, for the reason `readBack` gives:
        // this memo's deps are `[tracker, commit, localesQuery]` and a callback in them would rebuild
        // the writer and orphan its queue.
        onRefused: (refusals) => optsRef.current.onRefused?.(refusals),
        onConflict: (rowId) => setConflicts((prev) => (prev.includes(rowId) ? prev : [...prev, rowId])),
      }),
    [tracker, commit, localesQuery],
  )
  /* 🔴 `arm()` in the BODY, not just `destroy()` in the cleanup. StrictMode runs mount → cleanup →
     mount, and `useMemo` hands back the SAME writer on the second mount because its deps did not
     change — so a cleanup-only effect left this sheet holding a destroyed writer, and every edit
     was discarded silently before it reached the network. Arming on each mount undoes the previous
     cleanup; the queue survives, so nothing in flight is lost. */
  useEffect(() => {
    writer.arm()
    return () => writer.destroy()
  }, [writer])

  /* ── the read ───────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const mine = ++requestRef.current
    let cancelled = false
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
    const quiet = quietRead.current
    /* A language switch on the same product, market and first language keeps the sheet it has until the new one
       arrives. Any other change (product, market, first language) is a new sheet and shows the skeleton. */
    const coordinate = JSON.stringify([productId, market, locale])
    const languageSwitch = !quiet && !!sheetRef.current && lastRead.current?.coordinate === coordinate && lastRead.current.locales !== localesQuery
    lastRead.current = { coordinate, locales: localesQuery }
    if (languageSwitch) {
      apiRef.current?.stopEditing(true)
      setSwitching(true)
    } else if (!quiet) setLoading(true)
    quietRead.current = false
    setError(null)
    setProblems([])
    setConflicts([])

    const backend = getBackendUrl()
    /**
     * 🔴 `?market=`, NOT `?marketplace=`.
     *
     * PES.5 §3.2's doc example writes `&marketplace=`, and the route rejects it — it SELECTS a
     * market with `?market=IT`, while `scope.marketplace` in the RESPONSE is the resolved
     * coordinate, a different thing. The route answers 400 with that explanation because PES.3
     * lost debugging time to exactly this, and then so did I. The scope is derived server-side
     * from the presence of `channel`, so master sends neither `scope` nor `channel`.
     */
    const studioUrl = masterSheetUrl(productId, market, locale, opts.locales)
    const legacyUrl = `${backend}/api/products/sheet?market=${encodeURIComponent(market)}&parentIds=${encodeURIComponent(productId)}&limit=1`

    const load = async (): Promise<StudioSheet> => {
      // P2 — the compact wire form (each column's shared cell once); decoded here to today's shape.
      const studio = await fetchStudioRead(compactSheetUrl(studioUrl), signal)
      if (studio && studio.ok) {
        const body = decodeSheetCells((await studio.json()) as StudioSheet)
        return { ...body, meta: { ...body.meta, source: 'studio' } }
      }
      const failureBody: unknown = await studio?.json().catch(() => null)
      const failure = sheetReadFailure(studio?.status ?? 0, failureBody)
      if (!failure.fallback) throw new StudioReadError(studio.status, failureBody)
      const res = await fetch(legacyUrl, { credentials: 'include', cache: 'no-store', signal })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.message || body?.error || `HTTP ${res.status}`)
      return adaptLegacySheet(body as LegacySheetPage, productId)
    }

    void load()
      .then((next) => {
        if (cancelled || mine !== requestRef.current) return
        const api = apiRef.current
        if (quiet && api && !api.isDestroyed() && api.getEditingCells().length > 0) return
        if (quiet) {
          for (const row of next.rows) {
            const previous = sheetRef.current?.rows.find(old => old.id === row.id)
            if (!previous) continue
            for (const key of Object.keys(row.values)) {
              const state = tracker.get(row.id, key)?.state
              if (state && ['refused', 'unknown', 'saving', 'pending'].includes(state) && previous.values[key]) row.values[key] = previous.values[key]
            }
          }
        }
        setProblems(verifyContract(next))
        setSheet(next)
        // Teach the writer every row's version BEFORE the first edit can be made.
        writer.seed(next.rows.map((r) => ({ id: r.id, version: r.version, row: r })))
      })
      .catch((err: unknown) => {
        if (cancelled || mine !== requestRef.current) return
        // A QUIET read (after a confirmed save, or "Refresh progress") that fails keeps the sheet on screen:
        // the edit is already confirmed, and the next save or refresh reads again. Recording it as a load error
        // replaced the whole grid with "Could not load shared product information" mid-edit. The channel sheet
        // keeps its sheet the same way (`useChannelSheet` refresh).
        if (quiet && sheetRef.current) return
        setError(studioReadMessage(err))
      })
      .finally(() => {
        if (!cancelled && mine === requestRef.current) { setLoading(false); setSwitching(false) }
      })

    return () => { cancelled = true; abort.abort() }
  }, [productId, market, locale, localesQuery, nonce, writer])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const refresh = useCallback(() => { quietRead.current = true; setNonce(n => n + 1) }, [])
  const bindGrid = useCallback((api: GridApi<StudioRow> | null) => { apiRef.current = api }, [])

  return { sheet, loading, switching, error, contractProblems, reload, refresh, writer, tracker, conflicts, bindGrid }
}
