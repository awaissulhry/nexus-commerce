'use client'

/**
 * /design/media-popup — the REAL Product media pop-up (`PlanMediaPopup`, the production component) on a made-up family
 * (Lane C, docs/product-media-popup/PLAN-2026-09-28.md §8). The cells are the sheet's own `MediaStrip`, resolved with
 * the sheet's own resolver; the reads and writes are answered in the page (`mediaPopupFixture.ts`). Nothing is sent to
 * any server or channel.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, MediaStrip, PressableRow } from '@/design-system/components'
import { Button, Checkbox, SegmentedControl } from '@/design-system/primitives'

import type { SaveReporter } from '../../products/[id]/edit/_studio/types'
import { PlanMediaPopup, type AppliedCells } from '../../products/[id]/edit/_studio/media/MediaCellPopup'
import { cellAfterSave, planBase, type PlanPopupBase } from '../../products/[id]/edit/_studio/media/mediaPopupModel'
import type { PlanAddress } from '../../products/[id]/edit/_studio/media/planCellTransfer'
import type { MediaRead } from '../../products/[id]/edit/_studio/images/plan-page/model'
import { LAB_EBAY, LAB_PRODUCT, LAB_VARIANTS, installLabMedia, installLabPhotos, labRead, labSwitches, onLabChange, resetLab, type LabSwitches } from './mediaPopupFixture'

installLabMedia()

const ROWS = [{ productId: LAB_PRODUCT, sku: 'LAB-JACKET' }, ...LAB_VARIANTS.map(v => ({ productId: v.productId, sku: v.sku }))]
type Where = 'shared' | 'ebay'
const SWITCHES: Array<{ key: keyof LabSwitches; label: string }> = [
  { key: 'someoneElse', label: 'Someone else changes the set before my next save lands' },
  { key: 'refuseNext', label: 'The server refuses my next save' },
  { key: 'nearDuplicate', label: 'My next upload looks like a library photo' },
  { key: 'slow', label: 'Slow network (1 s per answer)' },
]
const reporter: SaveReporter = { pending: () => undefined, resolved: () => undefined, cleared: () => undefined }

export function MediaPopupLab() {
  const [ready, setReady] = useState<boolean | null>(null)
  const [read, setRead] = useState<MediaRead>(() => labRead())
  const [where, setWhere] = useState<Where>('shared')
  const [canEdit, setCanEdit] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Record<string, ReturnType<typeof cellAfterSave>>>({})
  const [notice, setNotice] = useState('')
  const [, redraw] = useState(0)
  const cells = useRef(new Map<string, HTMLDivElement | null>())
  useEffect(() => { void installLabPhotos().then(setReady) }, [])
  useEffect(() => onLabChange(() => { setRead(labRead()); redraw(n => n + 1) }), [])

  const address: PlanAddress = where === 'shared' ? { layer: 'SHARED' } : LAB_EBAY
  // Each cell as the sheet resolves it (the server's resolver), unless a save just showed it at once.
  const base = useMemo(() => planBase(read, { rowProductId: LAB_PRODUCT, address }), [read, where])
  const cellOf = (productId: string) => overlay[productId] ?? cellAfterSave(read, base, productId, 'it')

  const onApply = (next: MediaRead, popupBase: PlanPopupBase): AppliedCells => {
    setOverlay(Object.fromEntries(ROWS.map(r => [r.productId, cellAfterSave(next, popupBase, r.productId, 'it')])))
    return { restore: () => setOverlay({}), done: () => undefined }
  }
  const openRow = ROWS.find(r => r.productId === open)

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 760, padding: 24, color: 'var(--nds-text)' }}>
      <h1>Product media pop-up lab</h1>
      <p>The production Product media pop-up on a made-up family on the photo plan: two colours, three sizes. Open a cell,
        drag a photo, add from the family&apos;s photos, then press Enter or click outside to save; Esc cancels. Every
        name and picture here is invented; nothing is sent to a server or a channel.</p>
      {ready === null && <p role="status">Preparing the lab&apos;s photos…</p>}
      {ready === false && <Banner tone="warning">This browser cannot draw the lab&apos;s photos, so they show as unavailable. Everything else works.</Banner>}
      {notice && <Banner tone="neutral">{notice}</Banner>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <SegmentedControl ariaLabel="Sheet" value={where} onChange={value => { setWhere(value as Where); setOpen(null); setOverlay({}) }}
          options={[{ value: 'shared', label: 'Shared sheet' }, { value: 'ebay', label: 'eBay IT listing' }]} />
        <Checkbox label="No photo editing permission" checked={!canEdit} onChange={event => setCanEdit(!event.target.checked)} />
        <Button size="sm" variant="secondary" onClick={() => { resetLab(); setOverlay({}); setOpen(null) }}>Start again</Button>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {SWITCHES.map(s => <Checkbox key={s.key} label={s.label} checked={labSwitches[s.key]} onChange={event => { labSwitches[s.key] = event.target.checked; redraw(n => n + 1) }} />)}
      </div>
      {ready !== null && <div style={{ display: 'grid', gap: 6 }}>
        {ROWS.map(row => {
          const cell = cellOf(row.productId)
          return <div key={row.productId} ref={el => { cells.current.set(row.productId, el) }}>
            <PressableRow label={`${row.sku} · ${cell.set.label}`} expanded={open === row.productId} onClick={() => { setOverlay({}); setOpen(open === row.productId ? null : row.productId) }} stacked>
              <MediaStrip items={cell.items} label={`Product media: ${row.sku}`} limit={8} />
            </PressableRow>
          </div>
        })}
      </div>}
      {openRow && <PlanMediaPopup key={`${openRow.productId}:${where}`} productId={openRow.productId} rowProductId={openRow.productId} title={openRow.sku}
        address={address} locale="it" canEdit={canEdit} anchor={cells.current.get(openRow.productId) ?? null}
        initial={cellOf(openRow.productId).items} onApply={onApply} reporter={reporter}
        onSaved={() => { setOverlay({}); setNotice(`${openRow.sku}: saved in the lab.`) }}
        onClose={() => setOpen(null)}
        onOpenMediaPage={() => setNotice('The Media page is not part of the lab.')} />}
    </div>
  )
}
