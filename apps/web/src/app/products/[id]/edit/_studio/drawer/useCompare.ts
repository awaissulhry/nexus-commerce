'use client'

/**
 * PES.4.6 — the same field, across coordinates.
 *
 * **Built on an endpoint that exists.** This lane originally asked PES.5 for a dedicated
 * `POST /api/products/:id/compare`. It is not in their §3, and the hub approved §3 — so rather
 * than block the pane on a contract nobody owns, compare is assembled from the approved read:
 * `GET /api/products/:id/studio/sheet?scope=…` returns the WHOLE family for one scope, so N
 * targets is N of those reads, and the field is picked out of the row that matches.
 *
 * That is a better answer than the endpoint asked for, not a workaround for its absence. It means
 * the compare pane and the sheet see byte-identical values by construction — same service, same
 * resolver, same provenance — where a second endpoint would have been a second chance to disagree.
 * The cost is one request per target instead of one for all of them; targets are a handful, they
 * are fetched only when the pane is opened, and they run in parallel.
 *
 * The drawer cannot answer this locally: the sheet is loaded for ONE scope, so what the same field
 * carries on Amazon DE, or in the German locale, or on a second listing alias, is not in the row
 * object. Asking for it is the point of the pane.
 */

import { useCallback, useMemo } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { NotShipped, studioFetch, useStudioRead, type StudioReadStatus } from './useStudioRead'
import { resolveLayer, type CompareCell, type CompareRow, type CompareTarget, type SheetColumn, type StudioRow } from './types'

export type CompareStatus = StudioReadStatus

export interface CompareState {
  status: CompareStatus
  rows: CompareRow[]
  targets: CompareTarget[]
  error: string | null
  reload: () => void
}

interface StudioSheetResponse {
  scope?: { label?: string }
  columns?: SheetColumn[]
  rows?: StudioRow[]
}

/** Frozen: see `NO_ENTRIES` in useFieldHistory — `?? []` in a return is a new array per render. */
const NO_ROWS: CompareRow[] = Object.freeze([]) as unknown as CompareRow[]

/**
 * One scope's family read. `null` ONLY when the coordinate genuinely has no listing.
 *
 * 🔴 This used to map `400 → null` alongside 204, described as "a coordinate with no listing is a
 * legitimate answer". That tolerance is what made a contract bug invisible for this pane's whole
 * life: the query sent `marketplace=` while `product-studio.routes.ts:116` reads `market=`, so
 * EVERY read 400'd, every 400 became `null`, and the pane rendered "No listing on this coordinate"
 * — a confident, wrong, plausible sentence, for every target, always (FE.1, #342.1).
 *
 * So the param is fixed AND the tolerance is narrowed, because fixing only the param would leave
 * the next mismatch just as silent. 204 means no listing. A 400 is a request this code got wrong,
 * and it now says so.
 */
async function readScope(
  productId: string,
  target: CompareTarget,
  /** The market the drawer is open on — see `NoMarket` below. */
  fallbackMarket: string | undefined,
  signal: AbortSignal,
): Promise<StudioSheetResponse | null> {
  // 🔴 The route requires `market` for EVERY scope, master included, and PES.3's master target
  // carries no marketplace of its own (`scope: {kind:'master', label:'Master'}`). So it comes from
  // the coordinate when it has one and from the open drawer otherwise.
  const market = target.scope.marketplace ?? fallbackMarket
  if (!market) throw new NoMarket(target.label)
  const qs = new URLSearchParams({ scope: target.scope.kind, market })
  if (target.scope.kind === 'channel') {
    if (!target.scope.accountId) throw new Error('Choose an account before comparing this channel.')
    qs.set('accountId', target.scope.accountId)
  }
  if (target.scope.channel) qs.set('channel', target.scope.channel)
  if (target.scope.locale) qs.set('locale', target.scope.locale)
  // `studioFetch` raises NotShipped on 404/501; the hook turns that into `unavailable`.
  const res = await studioFetch(`${getBackendUrl()}/api/products/${productId}/studio/sheet?${qs}`, signal)
  if (res.status === 204) return null
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; hint?: string } | null
    throw new Error(body?.error ? `${body.error}${body.hint ? ` (${body.hint})` : ''}` : `HTTP ${res.status}`)
  }
  return (await res.json()) as StudioSheetResponse
}

/** No market could be determined for a target — a request we refuse to send rather than let 400. */
class NoMarket extends Error {
  constructor(label: string) {
    super(`No market is known for ${label}, so it cannot be read.`)
  }
}

export function useCompare(
  productId: string | null,
  /** Column keys to compare. One, today — the field the operator opened the pane on. */
  fieldKeys: string[],
  targets: CompareTarget[],
  /** Which row of the family: a variation compares against the same variation elsewhere. */
  rowId: string | null,
  enabled: boolean,
  /** The market the drawer is open on — the route demands one even for `scope=master`. */
  market: string | undefined,
): CompareState {
  // Serialised so the read re-runs on CONTENT change, not on every parent render handing over a
  // freshly-built array holding the same items.
  const key = JSON.stringify({ fieldKeys, targets: targets.map((t) => [t.id, t.scope]), rowId })

  const run = useCallback(
    async (signal: AbortSignal): Promise<CompareRow[]> => {
      if (!productId) throw new Error('useCompare: run called while disabled')
      const reads = await Promise.all(
        targets.map((t) =>
          readScope(productId, t, market, signal).then(
            (r) => ({ target: t, sheet: r, failed: false as const, reason: '' }),
            (e: unknown) => {
              if (e instanceof NotShipped) throw e
              /**
               * 🔴 An ABORT is not a coordinate that failed to read — it is this hook's own
               * cancellation, and it must reach `useStudioRead` rather than be absorbed here.
               *
               * Found by the #342 negative control: with the staleness guard off, every target
               * rendered "This coordinate could not be read: signal is aborted without reason".
               * That is harmless while superseded results are discarded, but the 30s DEADLINE
               * aborts the same controller and is NOT superseded — so swallowing it would have
               * resolved `run` successfully with ten targets each blaming the marketplace for an
               * internal timeout, and the honest "given up on, not answered" sentence would never
               * have been reached. Rethrowing lets the hook say which of the two actually happened.
               */
              if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e
              // One coordinate failing must not blank the whole comparison — the others are still
              // worth reading, and the failed column carries WHY. A generic "could not be read"
              // is how #342.1 stayed hidden; the server's own sentence is the useful one.
              return {
                target: t,
                sheet: null,
                failed: true as const,
                reason: e instanceof Error ? e.message : String(e),
              }
            },
          ),
        ),
      )

      return fieldKeys.map((fieldKey) => {
        const label =
          reads.find((r) => r.sheet?.columns?.some((c) => c.key === fieldKey))?.sheet?.columns?.find(
            (c) => c.key === fieldKey,
          )?.label ?? fieldKey

        const cells: CompareCell[] = reads.map(({ target, sheet, failed, reason }) => {
          if (failed) {
            return {
              targetId: target.id,
              label: target.label,
              value: null,
              layer: 'unknown',
              exists: false,
              readOnlyReason: `This coordinate could not be read: ${reason}`,
            }
          }
          // Match the same row of the family. Falling back to the first row would compare a
          // variation against a parent and call them the same field.
          const row = sheet?.rows?.find((r) => r.id === rowId && (target.scope.kind !== 'channel' || (r.aliasId ?? '') === (target.scope.aliasId ?? ''))) ?? null
          const cell = row?.values?.[fieldKey]
          return {
            targetId: target.id,
            label: target.label,
            value: cell?.value ?? null,
            layer: resolveLayer(cell),
            exists: sheet != null && row != null,
            readOnlyReason:
              cell?.editable === false ? 'This field is not editable on that coordinate.' : undefined,
          }
        })

        return { key: fieldKey, label, cells }
      })
      // `key` stands in for fieldKeys/targets/rowId by content — see above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [productId, key, market],
  )

  const read = useStudioRead(
    run,
    enabled && Boolean(productId) && fieldKeys.length > 0 && targets.length > 0,
  )

  return useMemo(
    () => ({
      status: read.status,
      rows: read.data ?? NO_ROWS,
      targets,
      error: read.error,
      reload: read.reload,
    }),
    [read, targets],
  )
}
