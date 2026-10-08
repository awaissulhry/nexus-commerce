'use client'

/**
 * "Sells from" — the From cell's pop-up (Step 2, Owner 2026-10-07: "super simple", like the Products page's Available
 * pop-up). One DS Modal anchored on the cell, the Case pop-up's size (Matrix polish, Owner 2026-10-08: one width and
 * one placement for the cell pop-ups; "<Thing> · <SKU>" titles; focus on the first warehouse, not the ✕):
 *
 *     Sells from · SKU                            Amazon EU
 *     [ This product | Every product ]
 *     ⠿ [x] IT-MAIN  Main warehouse       12 avail.
 *     ⠿ [ ] MI-3PL   Milan 3PL             4 avail.
 *     Ticked warehouses sell, the top one first. Listings show the sum.
 *     Use the default (IT-MAIN)            ← This product, when it differs
 *     Changes the default for 18 listings  ← Every product (a dry run)
 *                                  [Cancel] [Save]
 *
 * This product writes the listing's own list through the Matrix door (`cell: 'source'`; equal to the default = `[]`).
 * Every product writes the market default (`POST /api/stock/sync-control/market-sources`, Amazon EU = one list for the
 * group). Both hand the page a sentence and an Undo for its toast. The rules are `sellsFrom.ts`.
 */
import { useEffect, useState } from 'react'

import { Banner, Modal } from '@/design-system/components'
import { Button, SegmentedControl } from '@/design-system/primitives'

import type { CoordinateKey, MatrixCells, MatrixCoordinate, MatrixLocation, MatrixRowRead, MatrixWriteOutcome, SourceCell } from './contract'
import {
  defaultLink, dryRunSentence, marketName, marketSavedSentence, marketSourcesTarget, productCodesToWrite, productSavedSentence, saveHeld, startingCodes,
  type SellsFromScope,
} from './sellsFrom'
import { SellsFromPicker } from './SellsFromPicker'
import { listBefore, postMarketSources, type MarketSourcesAnswer, type MarketSourcesRequest } from './source'
import styles from './SellsFrom.module.css'
import dialogs from './dialogs.module.css'
import { useFocusOffClose } from './dialogFocus'

export interface SellsFromTarget {
  rowId: string
  sku: string
  coordinate: MatrixCoordinate
  /** The cell it opened from (the Modal anchors on it on a wide screen). */
  anchor: HTMLElement | null
}

/** What a save hands the page: the toast's sentence, and the Undo that puts it back (resolves with the receipt). */
export interface SellsFromSaved { sentence: string; undo: () => Promise<string>; scope: SellsFromScope }

/** Mounted once per opening (the page renders it only while a cell is open): every choice starts fresh from the cell. */
export interface SellsFromDialogProps {
  target: SellsFromTarget
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  rowOf: (rowId: string) => MatrixRowRead | null
  locations: readonly MatrixLocation[]
  /** This product: the Matrix door (a `source` cell write at the cell's current version, quiet); null = no cell there now. */
  writeSource: (rowId: string, key: CoordinateKey, codes: string[]) => Promise<MatrixWriteOutcome | null>
  /** Every product: the market default route. Injectable for a test; the real route by default. */
  postMarket?: (body: MarketSourcesRequest) => Promise<MarketSourcesAnswer>
  onClose: () => void
  onSaved: (saved: SellsFromSaved) => void
}

const SCOPES = [{ value: 'product', label: 'This product' }, { value: 'market', label: 'Every product' }]

interface DryRun { answer: MarketSourcesAnswer | null; error: string | null }

export function SellsFromDialog(p: SellsFromDialogProps) {
  const { target, locations } = p
  const coord = target.coordinate
  const post = p.postMarket ?? ((body: MarketSourcesRequest) => postMarketSources(body))
  /* The cell as it was when the pop-up opened: the choices start from it, and Save compares against it. */
  const [src] = useState<SourceCell | null>(() => p.cellsOf(target.rowId, coord.key)?.source ?? null)
  const [scope, setScope] = useState<SellsFromScope>('product')
  const [drafts, setDrafts] = useState<Record<SellsFromScope, string[]>>(() => ({
    product: src ? startingCodes(src, 'product', locations) : [],
    market: src ? startingCodes(src, 'market', locations) : [],
  }))
  const [dry, setDry] = useState<DryRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useFocusOffClose()

  /* Every product: what the save would change — once per opening (it counts the market's listings, whatever the list). */
  useEffect(() => {
    if (scope !== 'market' || dry) return
    let live = true
    post({ ...marketSourcesTarget(coord), codes: [], dryRun: true }).then(
      (answer) => { if (live) setDry({ answer, error: null }) },
      (e: unknown) => { if (live) setDry({ answer: null, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { live = false }
  }, [coord, scope, dry]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!src) return null
  const where = marketName(coord)
  const draft = drafts[scope]
  const setDraft = (codes: string[]) => { setDrafts((d) => ({ ...d, [scope]: codes })); setError(null) }
  const held = busy ? 'Saving…' : saveHeld(scope, draft, src, locations)
  const link = scope === 'product' ? defaultLink(draft, src) : null
  const row = p.rowOf(target.rowId)
  const unitsOf = (code: string) => row?.stock.locations.find((l) => l.code.toUpperCase() === code.toUpperCase())?.available ?? 0

  const save = async () => {
    if (held !== null) return
    setBusy(true); setError(null)
    try {
      if (scope === 'product') {
        const codes = productCodesToWrite(draft, src)
        const before = [...src.own]
        const outcome = await p.writeSource(target.rowId, coord.key, codes)
        if (!outcome) { setError('This listing is no longer here. Close and open the pop-up again.'); return }
        if (outcome.outcome === 'refused' || outcome.outcome === 'conflict') { setError(outcome.reason ?? 'Not saved'); return }
        if (outcome.outcome === 'applied') {
          p.onSaved({
            scope,
            sentence: productSavedSentence(target.sku, where, codes, src),
            undo: async () => {
              const back = await p.writeSource(target.rowId, coord.key, before)
              if (!back || back.outcome === 'refused' || back.outcome === 'conflict') throw new Error(back?.reason ?? 'Not put back')
              return `Put back: ${productSavedSentence(target.sku, where, before, src)}`
            },
          })
        }
        p.onClose()
        return
      }
      const body = { ...marketSourcesTarget(coord), codes: [...draft] }
      const answer = await post(body)
      if (!answer.noop) {
        const previous = listBefore(answer)
        p.onSaved({
          scope,
          sentence: marketSavedSentence(where, answer.codes.length ? answer.codes : draft, answer.listings),
          undo: async () => {
            await post({ ...body, codes: previous })
            return `Put back the ${where} default`
          },
        })
      }
      p.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <span className={styles.status} role="status">{held === 'Saving…' || held === 'Nothing to change' ? '' : held ?? ''}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={p.onClose}>Cancel</Button>
      <Button size="sm" variant="primary" onClick={() => { void save() }} aria-disabled={held !== null || undefined}>{busy ? 'Saving…' : 'Save'}</Button>
    </>
  )

  return (
    <Modal open onClose={p.onClose} size="md" className={dialogs.box} anchor={target.anchor} title={`Sells from · ${target.sku}`} subtitle={where} footer={footer}>
      <div className={styles.body}>
        <SegmentedControl ariaLabel="Applies to" size="sm" className={dialogs.seg} value={scope} onChange={(v) => { setScope(v as SellsFromScope); setError(null) }} options={SCOPES} />
        {error && <Banner tone="danger">{error}</Banner>}
        <SellsFromPicker label={`Sells from · ${where}, in sale order`} locations={locations} value={draft} onChange={setDraft} unitsOf={unitsOf} disabled={busy} autoFocusFirst />
        <p className={styles.hint}>Ticked warehouses sell, the top one first. Listings show the sum.</p>
        {link && <div><Button size="sm" variant="link" inline onClick={() => setDraft([...src.marketDefault])}>{link}</Button></div>}
        {scope === 'market' && (
          dry?.error ? <Banner tone="warning">{dry.error}</Banner>
            : <p className={styles.hint} role="status">{dry?.answer ? dryRunSentence(dry.answer) : 'Counting the listings…'}</p>
        )}
      </div>
    </Modal>
  )
}
