'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CellAction, MediaStrip, type MediaStripItem } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import type { ColDef, GridApi, ICellRendererParams } from '@/design-system/grid'
import { mediaLocaleSchema, type ProductMediaQuery } from '@nexus/shared/product-media'
import { useSaveReporter, useStudioProduct, useStudioScope } from '../contracts'
import type { SheetColumn } from '../sheet/master/types'
import { GalleryMediaPopup, PlanMediaPopup, type AppliedCells } from './MediaCellPopup'
import { cellAfterSave, type PlanPopupBase } from './mediaPopupModel'
import { CHANNEL_LABEL, type MediaChannel, type MediaRead } from '../images/plan-page/model'
import { planAddress } from './planCellTransfer'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import styles from './media.module.css'
import { useMediaCellActions, type MediaCellActions, type MediaRow } from './useMediaCellActions'

export const PRODUCT_MEDIA_COLUMN = 'productMedia'
const mediaColumn: SheetColumn = { key: PRODUCT_MEDIA_COLUMN, writeField: '', label: 'Product media', group: 'Media', groupKey: 'media', kind: 'text', storage: 'localizedContent', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: 280, defaultVisible: true, helpText: 'Images, videos and media descriptions for the selected destination and language.' }

export function withProductMediaColumn<T extends SheetColumn>(columns: T[]): T[] {
  // Keep API identity in the catalogue; the shared gallery owns media authoring.
  const rest = columns.filter(column => column.managedBy !== PRODUCT_MEDIA_COLUMN && !(column.key === 'media' && column.label === 'Product media'))
  if (rest.some(column => column.key === PRODUCT_MEDIA_COLUMN)) return rest
  // After Description in every language mode: with two or more languages it arrives as `description@<lang>` columns,
  // and the gallery used to jump to the front of the sheet (2026-09-27).
  const isDescription = (column: T) => column.key === 'description' || column.key.startsWith('description@')
  const at = rest.reduce((last, column, index) => (isDescription(column) ? index + 1 : last), 0)
  return [...rest.slice(0, at), mediaColumn as T, ...rest.slice(at)]
}

export function useProductMediaEditor(onSaved: () => void, sheetLocale?: string | null) {
  const scope = useStudioScope()
  const reporter = useSaveReporter()
  const [selected, setSelected] = useState<{ row: MediaRow; anchor: HTMLElement | null; api: GridApi | null } | null>(null)
  const dirty = useRef(false), busy = useRef(false)
  const canEdit = usePermission('products.images.edit')
  // A pop-up with a change not yet saved (or a save on its way): switching scope or leaving the page asks first.
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value }, [])
  useEffect(() => scope.registerScopeChangeGuard(() => !dirty.current && !busy.current), [scope.registerScopeChangeGuard])
  const open = useCallback((row: MediaRow, anchor: HTMLElement | null, api?: GridApi | null) => setSelected({ row, anchor, api: api ?? null }), [])
  const channel = scope.scope === 'master' ? 'MASTER' : scope.scope.toUpperCase()
  const language = mediaLocaleSchema.safeParse(sheetLocale ?? scope.locale ?? 'und')
  const contextFor = (row?: MediaRow): ProductMediaQuery => ({ scope: channel, market: channel === 'MASTER' ? 'GLOBAL' : scope.coordinate?.marketplace ?? scope.market ?? 'GLOBAL', locale: language.success ? language.data : sheetLocale ?? scope.locale ?? 'und',
    ...(channel === 'MASTER' ? {} : { accountId: scope.accountId, listingId: row?.listing?.id, aliasKey: row?.aliasId ?? '' }) })
  const context = contextFor(selected?.row)
  const actions = useMediaCellActions({ contextFor, canEdit, reporter, onSettled: onSaved, onBusyChange: value => { busy.current = value } })
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (busy.current || dirty.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard)
  }, [])
  // The photo plan changed (the Media page, another tab or person): the sheet refreshes this family's cells.
  const refreshTimer = useRef<number | null>(null)
  const product = useStudioProduct()
  const familyRoot = product.parentId ?? product.id
  useInvalidationChannel(['product-media.changed'], event => {
    if (event.id && event.id !== familyRoot) return
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => { refreshTimer.current = null; if (!busy.current) onSaved() }, 500)
  })
  useEffect(() => () => { if (refreshTimer.current) window.clearTimeout(refreshTimer.current) }, [])
  const accountLabel = scope.accounts.find(account => account.id === scope.accountId)?.label
  const channelLabel = channel === 'MASTER' ? null : CHANNEL_LABEL[channel as MediaChannel] ?? channel
  const contextLabel = channelLabel ? [`${channelLabel} ${context.market === 'GLOBAL' ? '' : context.market}`.trim(), accountLabel, selected?.row.aliasId ? `Listing ${(selected.row.aliasPosition ?? 0) + 1}` : 'Main listing'].filter(Boolean).join(' · ') : null
  const planTarget = selected?.row.productMediaSet ? planAddress(context) : null
  /** Enter in the plan pop-up: every row of this sheet's layer shows its new photos at once (all sizes of a colour). */
  const applyToCells = (next: MediaRead, base: PlanPopupBase): AppliedCells => {
    const api = selected?.api
    if (!api || api.isDestroyed()) return { restore: () => undefined, done: () => undefined }
    const target = JSON.stringify(planTarget)
    const touched: Array<{ node: { data?: MediaRow }; before: Pick<MediaRow, 'productMedia' | 'productMediaSet'> }> = []
    api.forEachNode(node => {
      const row = node.data as MediaRow | undefined
      if (!row?.productMediaSet || JSON.stringify(planAddress(contextFor(row))) !== target) return
      const cell = cellAfterSave(next, base, row.productId ?? row.id, context.locale)
      if (JSON.stringify(cell.items) === JSON.stringify(row.productMedia) && JSON.stringify(cell.set) === JSON.stringify(row.productMediaSet)) return
      touched.push({ node, before: { productMedia: row.productMedia, productMediaSet: row.productMediaSet } })
      row.productMedia = cell.items; row.productMediaSet = cell.set; row.productMediaSaving = true
    })
    const refresh = () => { if (!api.isDestroyed() && touched.length) api.refreshCells({ rowNodes: touched.map(t => t.node) as never, columns: [PRODUCT_MEDIA_COLUMN], force: true }) }
    refresh()
    return {
      restore: () => { for (const t of touched) if (t.node.data) Object.assign(t.node.data, t.before, { productMediaSaving: false }); refresh() },
      done: () => { for (const t of touched) if (t.node.data) t.node.data.productMediaSaving = false; refresh() },
    }
  }
  /** Enter in the gallery pop-up: the row's cell shows its new list at once. */
  const applyToRow = (items: MediaStripItem[]): AppliedCells => {
    const current = selected, api = current?.api
    if (!current) return { restore: () => undefined, done: () => undefined }
    const row = current.row, before = row.productMedia
    let node: { data?: MediaRow } | null = null
    api?.forEachNode(n => { if (n.data === row) node = n })
    const refresh = () => { if (api && !api.isDestroyed() && node) api.refreshCells({ rowNodes: [node] as never, columns: [PRODUCT_MEDIA_COLUMN], force: true }) }
    row.productMedia = items; row.productMediaSaving = true; refresh()
    return {
      restore: () => { row.productMedia = before; row.productMediaSaving = false; refresh() },
      done: () => { row.productMediaSaving = false; refresh() },
    }
  }
  const closePlan = () => {
    const current = selected
    // Only this pop-up's own row: a late answer must never close a pop-up opened on another cell meanwhile.
    setSelected(now => now && current && now.row === current.row ? null : now)
    if (current) actions.clearError(current.row)
    // Focus goes back to the cell, as after every sheet pop-up.
    const api = current?.api
    if (api && current) requestAnimationFrame(() => {
      if (api.isDestroyed()) return
      let index: number | null = null
      api.forEachNode(node => { if (node.data === current.row && node.rowIndex != null) index = node.rowIndex })
      if (index != null) api.setFocusedCell(index, PRODUCT_MEDIA_COLUMN)
    })
  }
  const planElement = selected?.row.productMediaSet
    ? <PlanMediaPopup key={JSON.stringify([selected.row.id, context])} productId={selected.row.productId ?? selected.row.id} rowProductId={selected.row.productId ?? selected.row.id}
        title={selected.row.sku || selected.row.name || 'Product'} address={planTarget} locale={context.locale} canEdit={canEdit} anchor={selected.anchor}
        initial={selected.row.productMedia ?? []} onApply={applyToCells} onSaved={onSaved} onClose={closePlan} onDirtyChange={onDirtyChange}
        reporter={reporter} onOpenMediaPage={() => scope.setTab('images')} />
    : undefined
  const galleryElement = selected && !selected.row.productMediaSet
    ? <GalleryMediaPopup key={JSON.stringify([selected.row.id, context])} productId={selected.row.productId ?? selected.row.id} title={selected.row.sku || selected.row.name || 'Product'}
        context={context} contextLabel={contextLabel} channelLabel={channelLabel} canEdit={canEdit} anchor={selected.anchor} initial={selected.row.productMedia ?? []}
        onApply={applyToRow} onSaved={onSaved} onClose={closePlan} onDirtyChange={onDirtyChange} reporter={reporter} onOpenMediaPage={() => scope.setTab('images')} />
    : null
  return { open, actions, element: planElement ?? galleryElement }
}

/** AG owns fill/paste; a gallery edit opens the same editor from every native open gesture. */
function MediaEditorGateway(p: { data: MediaRow; eGridCell: HTMLElement; api: GridApi; open(row: MediaRow, anchor: HTMLElement | null, api?: GridApi | null): void }) {
  useEffect(() => { p.api.stopEditing(true); p.open(p.data, p.eGridCell, p.api) }, [])
  return null
}

export function productMediaColumn<Row extends MediaRow>(open: (row: Row, anchor: HTMLElement | null, api?: GridApi | null) => void, actions?: MediaCellActions): ColDef<Row> {
  return { colId: PRODUCT_MEDIA_COLUMN, headerName: 'Product media', width: 280, minWidth: 170,
    editable: p => !!p.data && !!actions?.canEdit() && !p.data.productMediaSaving && !p.data.productMediaError,
    sortable: false, filter: false, cellDataType: false,
    cellClass: 'nds-ag-cell nds-reveal-row',
    cellClassRules: { 'nds-cell-is-saving': p => !!p.data?.productMediaSaving, 'nds-cell-is-refused': p => !!p.data && !!actions?.error(p.data) },
    valueGetter: p => p.data && actions ? actions.value(p.data) : null,
    valueFormatter: p => p.data?.productMedia?.map(item => item.alt || item.type).join(', ') ?? '',
    valueSetter: p => { if (p.data && p.newValue !== p.oldValue) actions?.copy(p.data, p.newValue, () => { if (!p.api.isDestroyed()) p.api.refreshCells({ rowNodes: [p.node!], columns: [PRODUCT_MEDIA_COLUMN], force: true }) }); return false },
    cellEditor: MediaEditorGateway, cellEditorParams: { open },
    // Only controls own their pointer gesture; the cell body and bottom-right fill handle stay native.
    cellRendererParams: { suppressMouseEventHandling: (p: { event: MouseEvent }) => p.event.target instanceof Element && !!p.event.target.closest('[data-nds-cell-action], [data-nds-media-drag]') },
    onCellDoubleClicked: p => { if (p.data && !p.column.isCellEditable(p.node) && !p.isEventHandlingSuppressed) open(p.data, p.event?.target instanceof HTMLElement ? p.event.target.closest('[role="gridcell"]') : null, p.api as GridApi) },
    suppressKeyboardEvent: p => { if (p.data && ['Enter', 'F2', 'Delete', 'Backspace'].includes(p.event.key) && !p.event.ctrlKey && !p.event.metaKey && !p.event.altKey) { p.event.preventDefault(); p.event.stopPropagation(); open(p.data, p.event.target instanceof HTMLElement ? p.event.target.closest('[role="gridcell"]') : null, p.api as GridApi); return true } return false },
    cellRenderer: (p: ICellRendererParams<Row>) => {
      if (!p.data) return null
      const row = p.data, label = row.sku || row.name || 'Product'
      const refresh = () => { if (!p.api.isDestroyed()) p.api.refreshCells({ rowNodes: [p.node], columns: [PRODUCT_MEDIA_COLUMN], force: true }) }
      const focus = () => { if (p.node.rowIndex != null) { p.api.setFocusedCell(p.node.rowIndex, PRODUCT_MEDIA_COLUMN); p.api.clearCellSelection(); p.api.addCellRange({ rowStartIndex: p.node.rowIndex, rowEndIndex: p.node.rowIndex, columns: [PRODUCT_MEDIA_COLUMN] }) } }
      return <div className={styles.cell} aria-busy={row.productMediaSaving || undefined}>
        {row.productMediaError ? <span>Media needs attention</span> : row.productMedia ? <MediaStrip items={row.productMedia} label={label}
          limit={Math.max(1, Math.min(5, Math.floor(((p.column?.getActualWidth() ?? 280) - 80) / 36)))}
          onReorder={actions?.canEdit() && !row.productMediaSaving && !row.productMediaSet ? ids => actions.reorder(row, ids, refresh) : undefined}
          onFocusCell={focus} onOpen={() => open(row, p.eGridCell, p.api as GridApi)} /> : <span>Manage media</span>}
        <CellAction label={`${actions?.canEdit() ? 'Edit' : 'View'} product media: ${label}`} description={actions?.error(row) || (row.productMediaSaving ? 'Saving media…' : !actions?.canEdit() ? 'View images and videos. Media editing is unavailable with your current permissions.'
          : row.productMediaSet ? planCellHint(row) : 'Drag thumbnails to reorder. Drag the bottom-right handle to copy the gallery. Enter or F2 opens the editor.')} onFocusCell={focus} onActivate={anchor => open(row, anchor, p.api as GridApi)} />
      </div>
    },
  }
}

/** What a photo plan cell stands for: "Nero · shared by 3 SKUs, then 2 common photos". */
export function planCellHint(row: MediaRow): string {
  const set = row.productMediaSet!
  const common = (row.productMedia ?? []).filter(item => item.muted).length
  const who = set.ref === 'common' ? 'Common · every variant' : set.ref.startsWith('sku:') ? `${set.label}` : `${set.label} · shared by ${set.sharedBy} SKU${set.sharedBy === 1 ? '' : 's'}`
  return `${who}${common ? `, then ${common} common photo${common === 1 ? '' : 's'}` : ''}. Photo plan: Enter or F2 edits this set; copy, paste and the fill handle copy its photos.`
}
