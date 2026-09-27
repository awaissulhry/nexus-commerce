'use client'
import { useMemo, useRef } from 'react'
import { useToast, type MediaStripItem } from '@/design-system/components'
import type { ProductMediaQuery } from '@nexus/shared/product-media'
import type { SaveReporter } from '../types'
import { mediaClipboardValue, mediaSummary, readMediaClipboard, reorderMediaCell, transferMediaCell, type MediaCellSnapshot } from './mediaCellTransfer'
import { pasteOps, planAddress, planCellSnapshot, planClipboardValue, readPlanClipboard, sendPlanOps } from './planCellTransfer'

export type MediaRow = { id: string; name?: string | null; sku?: string; productId?: string; aliasId?: string | null; aliasPosition?: number; listing?: { id: string } | null; productMedia?: MediaStripItem[]; productMediaError?: string; productMediaSaving?: boolean; productMediaWriteError?: string
  /** Photo plan families (images P3c): the set the cell edits — Common, the value's set or the SKU's own set. */
  productMediaSet?: { ref: string; label: string; sharedBy: number } }
export interface MediaCellActions {
  canEdit(): boolean
  error(row: MediaRow): string | undefined
  clearError(row: MediaRow): void
  value(row: MediaRow): string
  copy(row: MediaRow, value: unknown, refresh: () => void): void
  reorder(row: MediaRow, ids: string[], refresh: () => void): void
}

export function useMediaCellActions(input: { contextFor(row: MediaRow): ProductMediaQuery; canEdit: boolean; onSettled(): void; onBusyChange?(busy: boolean): void; reporter?: SaveReporter }): MediaCellActions {
  const { toast } = useToast()
  const live = useRef({ ...input, toast }); live.current = { ...input, toast }
  const pending = useRef(new Set<string>())
  const errors = useRef(new Map<string, string>())
  return useMemo(() => {
    const snapshot = (row: MediaRow): MediaCellSnapshot => ({ productId: row.productId ?? row.id, context: live.current.contextFor(row), items: (row.productMedia ?? []).map(item => ({ id: item.id, type: item.type, alt: item.alt ?? '' })) })
    /** One key per thing a write changes: the older gallery of (product, context), or ONE plan set on one layer. */
    const keyOf = (row: MediaRow) => {
      const plan = planCellSnapshot(row)
      return plan ? `plan:${JSON.stringify([planAddress(live.current.contextFor(row)), plan.set])}` : JSON.stringify([row.productId ?? row.id, live.current.contextFor(row)])
    }
    /** `operation` answers with the cell's new photos, or `null` when the sheet's refresh brings them (photo plan). */
    function run(row: MediaRow, key: string, operation: () => Promise<MediaStripItem[] | null>, refresh: () => void) {
      if (!live.current.canEdit || pending.current.has(key) || row.productMediaError) return
      pending.current.add(key); row.productMediaSaving = true; row.productMediaWriteError = undefined
      errors.current.delete(key)
      const reporter = live.current.reporter, writeId = crypto.randomUUID(), subject = `product-media:${key}`
      reporter?.pending(writeId, subject)
      live.current.onBusyChange?.(true); refresh()
      void operation().then(saved => { if (saved) row.productMedia = saved; reporter?.resolved(writeId, true, undefined, subject) }).catch(error => {
        row.productMediaWriteError = error instanceof Error ? error.message : 'The media result could not be confirmed. Reload before retrying.'
        errors.current.set(key, row.productMediaWriteError)
        reporter?.resolved(writeId, false, row.productMediaWriteError, subject)
        live.current.toast(`${row.sku || row.name || 'Product'}: ${row.productMediaWriteError}`, 'danger', { duration: 10000 })
      }).finally(() => {
        row.productMediaSaving = false; pending.current.delete(key); refresh()
        if (!pending.current.size) { live.current.onBusyChange?.(false); live.current.onSettled() }
      })
    }
    return {
      canEdit: () => live.current.canEdit,
      error: row => errors.current.get(keyOf(row)),
      clearError: row => { const key = keyOf(row); errors.current.delete(key); row.productMediaWriteError = undefined; live.current.reporter?.cleared([`product-media:${key}`]) },
      value: row => { const plan = planCellSnapshot(row); return plan ? planClipboardValue(plan) : mediaClipboardValue(snapshot(row)) },
      copy: (row, value, refresh) => {
        const target = planCellSnapshot(row)
        if (target) {
          // A photo plan row: the target row's set gets the copied set's photos, on the layer this sheet edits.
          const source = readPlanClipboard(value), address = planAddress(live.current.contextFor(row))
          if (!source) { live.current.toast(readMediaClipboard(value) ? 'This product uses the photo plan. Copy a Product media cell of a product on the photo plan, or place the photos on the Media page.' : 'Copy a Product media cell to paste its photos.', 'warning'); return }
          if (!address) { live.current.toast('This listing has no account, so its photos cannot be set here.', 'warning'); return }
          const ops = pasteOps(source, target)
          if (!ops.length) return
          // Rows that share one set (every size of a colour) write it once.
          run(row, keyOf(row), () => sendPlanOps(target.productId, address, ops).then(() => null), refresh)
          return
        }
        if (readPlanClipboard(value)) { live.current.toast('That cell comes from a product on the photo plan; this product is not on it yet. Start using the photo plan on its Media page first.', 'warning'); return }
        const source = readMediaClipboard(value), snap = snapshot(row)
        if (!source) { live.current.toast('Copy a Product media cell to paste a gallery, including its images and videos.', 'warning'); return }
        if (JSON.stringify([source.productId, source.context]) === JSON.stringify([snap.productId, snap.context])) return
        run(row, keyOf(row), () => transferMediaCell(source, snap).then(mediaSummary), refresh)
      },
      reorder: (row, ids, refresh) => { const target = snapshot(row); run(row, keyOf(row), () => reorderMediaCell(target, ids).then(mediaSummary), refresh) },
    }
  }, [input.canEdit])
}
