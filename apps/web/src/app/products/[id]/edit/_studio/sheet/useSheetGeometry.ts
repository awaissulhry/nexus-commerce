'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BAND_WIDTH_FLOOR, buildSkuFont, deriveBandWidthFromDom, findKeyBearingBand, measureLongestSku, type GridApi } from '@/design-system/grid'
import { revealColumn, revealStash, traceRevealSkip, type RevealIntent, type RevealRequest } from '../drawer'

/** Measure the actual identity band and replay cell reveals only after the layout is ready. */
export function useSheetGeometry<Row extends { sku: string }>({ scope, rows, getGridApi, gridReady, recordId }: {
  scope: 'master' | 'channel'
  rows: Row[]
  getGridApi: () => GridApi<Row> | null
  gridReady: GridApi<Row> | null
  recordId: string | null
}) {
  const [bandWidth, setBandWidth] = useState(BAND_WIDTH_FLOOR)
  const bandWidthRef = useRef(bandWidth)
  bandWidthRef.current = bandWidth
  const bandDerivedRef = useRef(false)
  const live = useRef({ scope, rows, getGridApi, recordId })
  live.current = { scope, rows, getGridApi, recordId }
  const pendingReveal = useRef<RevealRequest | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealNow = useCallback((key: string, intent: RevealIntent = 'uncover') => {
    const api = live.current.getGridApi()
    if (!api || api.isDestroyed()) return traceRevealSkip(key, intent, 'no-api')
    const host = document.querySelector<HTMLElement>('.nds-grid-sheet .ag-root-wrapper')
    if (!host) return traceRevealSkip(key, intent, 'no-host')
    return revealColumn(api, host, key, intent, live.current.recordId != null, bandDerivedRef.current)
  }, [])
  const replayReveal = useCallback(() => {
    const pending = pendingReveal.current
    if (pending) pendingReveal.current = revealStash(pending, { kind: 'replay', served: revealNow(pending.colKey, pending.intent) })
  }, [revealNow])
  const revealCell = useCallback((colKey: string, intent: RevealIntent = 'uncover') => {
    pendingReveal.current = revealStash(pendingReveal.current, {
      kind: 'request', request: { colKey, intent }, served: revealNow(colKey, intent),
    })
  }, [revealNow])
  const remeasureSoon = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current)
    const api = live.current.getGridApi()
    if (!api || !live.current.rows.length) return
    let tries = 0
    const attempt = () => {
      if (live.current.getGridApi() !== api || api.isDestroyed()) return
      const next = deriveBandWidthFromDom(findKeyBearingBand(), measureLongestSku(live.current.rows.map(row => row.sku), buildSkuFont()))
      if (next == null) {
        if (tries++ < (live.current.scope === 'master' ? 20 : 40)) { retryTimer.current = setTimeout(attempt, 50); return }
        if (live.current.scope === 'master') {
          bandDerivedRef.current = true
          replayReveal()
        }
        return
      }
      const first = !bandDerivedRef.current
      bandDerivedRef.current = true
      if (Math.abs(next - bandWidthRef.current) < 0.5) { if (first) replayReveal(); return }
      bandWidthRef.current = next
      setBandWidth(next)
      // Master applies its measured width through autoGroupColumnDef on React's next render;
      // channel applies it directly. Preserve the original reveal timing in each scope.
      if (live.current.scope === 'channel') api.setColumnWidths([{ key: 'ag-Grid-AutoColumn', newWidth: next }])
    }
    attempt()
  }, [replayReveal])
  useEffect(() => {
    if (!gridReady) return
    remeasureSoon()
    const observer = new MutationObserver(replayReveal)
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-resting-left'] })
    const visible = () => { if (scope === 'master' && document.visibilityState === 'visible') remeasureSoon() }
    document.addEventListener('visibilitychange', visible)
    gridReady.addEventListener('displayedColumnsChanged', replayReveal)
    gridReady.addEventListener('columnResized', replayReveal)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', visible)
      if (retryTimer.current) clearTimeout(retryTimer.current)
      if (!gridReady.isDestroyed()) {
        gridReady.removeEventListener('displayedColumnsChanged', replayReveal)
        gridReady.removeEventListener('columnResized', replayReveal)
      }
    }
  }, [scope, gridReady, rows, remeasureSoon, replayReveal])
  useEffect(() => {
    if (recordId == null) pendingReveal.current = revealStash(pendingReveal.current, { kind: 'recordClosed' })
    else replayReveal()
  }, [recordId, replayReveal])
  return { bandWidth, bandWidthRef, bandDerivedRef, revealCell, revealNow, replayReveal, remeasureSoon }
}
