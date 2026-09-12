'use client'
import { useMemo, useRef } from 'react'
import { useToast, type MediaStripItem } from '@/design-system/components'
import type { ProductMediaQuery, ProductMediaWorkspace } from '@nexus/shared/product-media'
import type { SaveReporter } from '../types'
import { mediaClipboardValue, mediaSummary, readMediaClipboard, reorderMediaCell, transferMediaCell, type MediaCellSnapshot } from './mediaCellTransfer'

export type MediaRow = { id: string; name?: string | null; sku?: string; productId?: string; aliasId?: string | null; aliasPosition?: number; listing?: { id: string } | null; productMedia?: MediaStripItem[]; productMediaError?: string; productMediaSaving?: boolean; productMediaWriteError?: string }
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
    function run(row: MediaRow, target: MediaCellSnapshot, operation: () => Promise<ProductMediaWorkspace>, refresh: () => void) {
      const key = JSON.stringify([target.productId, target.context])
      if (!live.current.canEdit || pending.current.has(key) || row.productMediaError) return
      pending.current.add(key); row.productMediaSaving = true; row.productMediaWriteError = undefined
      errors.current.delete(key)
      const reporter = live.current.reporter, writeId = crypto.randomUUID(), subject = `product-media:${key}`
      reporter?.pending(writeId, subject)
      live.current.onBusyChange?.(true); refresh()
      void operation().then(saved => { row.productMedia = mediaSummary(saved); reporter?.resolved(writeId, true, undefined, subject) }).catch(error => {
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
      error: row => errors.current.get(JSON.stringify([row.productId ?? row.id, live.current.contextFor(row)])),
      clearError: row => { const key = JSON.stringify([row.productId ?? row.id, live.current.contextFor(row)]); errors.current.delete(key); row.productMediaWriteError = undefined; live.current.reporter?.cleared([`product-media:${key}`]) },
      value: row => mediaClipboardValue(snapshot(row)),
      copy: (row, value, refresh) => {
        const source = readMediaClipboard(value), target = snapshot(row)
        if (!source) { live.current.toast('Copy a Product media cell to paste a gallery, including its images and videos.', 'warning'); return }
        if (JSON.stringify([source.productId, source.context]) === JSON.stringify([target.productId, target.context])) return
        run(row, target, () => transferMediaCell(source, target), refresh)
      },
      reorder: (row, ids, refresh) => { const target = snapshot(row); run(row, target, () => reorderMediaCell(target, ids), refresh) },
    }
  }, [input.canEdit])
}
