'use client'

/**
 * PES.3 — the route half of the Errors & Sync console: read the coordinate, render the pane.
 *
 * Split from the console itself for the same reason every other lane splits it: the pane takes
 * plain props and can be rendered in a test without the frame's providers, while this file is the
 * only place that knows about `useStudioScope()`.
 */
import { useCallback } from 'react'

import { useStudioProduct, useStudioRecord, useStudioScope } from '../contracts'
import { ReadinessPanel } from './ReadinessPanel'
import { ErrorsSyncConsole } from './ErrorsSyncConsole'

export function ErrorsSyncTab() {
  const { coordinate, options, scope, setTab, accountId, listingId } = useStudioScope()
  const product = useStudioProduct()
  const record = useStudioRecord()

  /**
   * Jump to the row, or to the sheet when the row cannot be known.
   *
   * PES.5 now resolves the alias server-side for 396 of 441 rows, returning COMPONENTS
   * (`aliasId` / `aliasKey` / `aliasResolved`) rather than a composed id — so the composition stays
   * here, where the format lives (hub #143). `rowId` is null for the 45 that are product-only; those
   * land on the sheet rather than on a row guessed from `primary:`.
   */
  /**
   * Jump to the row, or to the sheet when the row cannot be known.
   *
   * Both writes land now: PES.1 coalesces every URL patch in a tick into ONE navigation against the
   * freshest URL (`contracts.tsx:636`), so `setTab` no longer loses `rec` to `record.open`. Before
   * that fix this was tab-only and the control said "Open sheet", because nothing may claim a
   * precision the navigation cannot deliver.
   *
   * `rowId` is null for the ~10% of rows whose alias the server could not resolve; those still
   * reach the sheet rather than a row guessed from `primary:`.
   */
  const jump = useCallback(
    (rowId: string | null) => {
      setTab('sheet')
      if (rowId) record.open(rowId)
    },
    [setTab, record],
  )

  if (!coordinate) return <ReadinessPanel />

  const label =
    options.channels.find((c) => c.id === scope)?.label ?? `${coordinate.channel} · ${coordinate.marketplace}`

  return (
    <>
    <ReadinessPanel />
    <ErrorsSyncConsole
      productId={product.id}
      channel={coordinate.channel}
      marketplace={coordinate.marketplace}
      accountId={accountId}
      listingId={listingId}
      scopeLabel={label}
      onJumpToRow={jump}
    />
    </>
  )
}
