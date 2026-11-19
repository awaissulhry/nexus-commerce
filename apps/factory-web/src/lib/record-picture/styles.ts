'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RowPicture } from './model'

/**
 * F-CP-110 (customer page plan C2c; 10-customer-page §4) — the picture viewer's styles strip: every line's picture of a record that has
 * more than one style ("+N"), read ONCE when the viewer opens (the host's own walled read: the order read for an order), each with
 * its style code and colour under it; a click shows that one large and "Open style" follows it. No price is ever drawn: a tile holds
 * the style, the colour and the picture only. States: reading (skeleton tiles), failed (words, Try again, and the record's lines door),
 * a line without a picture (the shirt mark).
 */

/** One line of the record, as the strip draws it. */
export interface StyleTile {
  readonly key: string
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  /** The colour in words ("BLK Nero"); null: none. */
  readonly colour: string | null
  readonly fileId: string | null
  /** The small preview's address (the read's own, about 60 s); null: no preview. */
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

/** The host's read of a record's lines (its walled route); the signal stops it when the viewer closes. */
export type ReadStyles = (recordId: string, signal: AbortSignal) => Promise<readonly StyleTile[]>

export type StylesRead = { readonly status: 'off' } | { readonly status: 'reading' } | { readonly status: 'ready'; readonly tiles: readonly StyleTile[] } | { readonly status: 'failed' }

/** A tile as the ONE picture part takes it. */
export const tilePicture = (tile: StyleTile): RowPicture => ({ styleId: tile.styleId, styleCode: tile.styleCode, styleName: tile.styleName, fileId: tile.fileId, small: tile.small !== null })

/** "STY-01 · BLK Nero" under a tile. */
export const tileWords = (tile: Pick<StyleTile, 'styleCode' | 'colour'>): string => (tile.colour ? `${tile.styleCode} · ${tile.colour}` : tile.styleCode)

/** The record's lines, read once while `wanted` (the viewer open on a record with "+N"); Try again reads them again. */
export function useRecordStyles(read: ReadStyles | null | undefined, recordId: string, wanted: boolean): { readonly state: StylesRead; readonly retry: () => void } {
  const on = wanted && !!read
  const [state, setState] = useState<StylesRead>(on ? { status: 'reading' } : { status: 'off' })
  const [turn, setTurn] = useState(0)
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    const reader = latest.current
    if (!on || !reader) {
      setState({ status: 'off' })
      return
    }
    const controller = new AbortController()
    setState({ status: 'reading' })
    reader(recordId, controller.signal).then(
      (tiles) => !controller.signal.aborted && setState({ status: 'ready', tiles }),
      () => !controller.signal.aborted && setState({ status: 'failed' }),
    )
    return () => controller.abort()
  }, [on, recordId, turn])
  const retry = useCallback(() => setTurn((now) => now + 1), [])
  return { state, retry }
}
