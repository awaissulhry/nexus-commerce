'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CellAction, MediaStrip } from '@/design-system/components'
import { usePermission } from '@/lib/auth/AuthProvider'
import type { ColDef, ICellRendererParams } from '@/design-system/grid'
import { mediaLocaleSchema, type ProductMediaQuery } from '@nexus/shared/product-media'
import { useSaveReporter, useStudioScope } from '../contracts'
import type { SheetColumn } from '../sheet/master/types'
import { ProductMediaDialog } from './ProductMediaDialog'
import styles from './media.module.css'
import { useMediaCellActions, type MediaCellActions, type MediaRow } from './useMediaCellActions'

export const PRODUCT_MEDIA_COLUMN = 'productMedia'
const mediaColumn: SheetColumn = { key: PRODUCT_MEDIA_COLUMN, writeField: '', label: 'Product media', group: 'Media', groupKey: 'media', kind: 'text', storage: 'localizedContent', scope: 'global', requiredBy: [], editable: false, formulaWritable: false, width: 280, defaultVisible: true, helpText: 'Images, videos and media descriptions for the selected destination and language.' }

export function withProductMediaColumn<T extends SheetColumn>(columns: T[]): T[] {
  // Keep API identity in the catalogue; the shared gallery owns media authoring.
  const rest = columns.filter(column => column.managedBy !== PRODUCT_MEDIA_COLUMN && !(column.key === 'media' && column.label === 'Product media'))
  if (rest.some(column => column.key === PRODUCT_MEDIA_COLUMN)) return rest
  const at = Math.max(0, rest.findIndex(column => column.key === 'description') + 1)
  return [...rest.slice(0, at), mediaColumn as T, ...rest.slice(at)]
}

export function useProductMediaEditor(onSaved: () => void, sheetLocale?: string | null) {
  const scope = useStudioScope()
  const reporter = useSaveReporter()
  const [selected, setSelected] = useState<{ row: MediaRow; anchor: HTMLElement | null } | null>(null)
  const dirty = useRef(false), busy = useRef(false)
  const canEdit = usePermission('products.images.edit')
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value }, [])
  useEffect(() => scope.registerScopeChangeGuard(() => !dirty.current && !busy.current), [scope.registerScopeChangeGuard])
  const open = useCallback((row: MediaRow, anchor: HTMLElement | null) => setSelected({ row, anchor }), [])
  const channel = scope.scope === 'master' ? 'MASTER' : scope.scope.toUpperCase()
  const language = mediaLocaleSchema.safeParse(sheetLocale ?? scope.locale ?? 'und')
  const contextFor = (row?: MediaRow): ProductMediaQuery => ({ scope: channel, market: channel === 'MASTER' ? 'GLOBAL' : scope.coordinate?.marketplace ?? scope.market ?? 'GLOBAL', locale: language.success ? language.data : sheetLocale ?? scope.locale ?? 'und',
    ...(channel === 'MASTER' ? {} : { accountId: scope.accountId, listingId: row?.listing?.id, aliasKey: row?.aliasId ?? '' }) })
  const context = contextFor(selected?.row)
  const actions = useMediaCellActions({ contextFor, canEdit, reporter, onSettled: onSaved, onBusyChange: value => { busy.current = value } })
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (busy.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard)
  }, [])
  const accountLabel = scope.accounts.find(account => account.id === scope.accountId)?.label
  const contextLabel = [channel === 'MASTER' ? 'Shared product' : [channel, accountLabel, selected?.row.aliasId ? `Listing ${(selected.row.aliasPosition ?? 0) + 1}` : 'Primary listing'].filter(Boolean).join(' · '), context.market, context.locale === 'und' ? 'All languages' : context.locale].join(' · ')
  return { open, actions, element: selected ? <ProductMediaDialog key={JSON.stringify([selected.row.id, context])} productId={selected.row.productId ?? selected.row.id} title={selected.row.sku || selected.row.name || 'Product'} context={context} contextLabel={contextLabel} anchor={selected.anchor} onClose={() => setSelected(null)} onSaved={() => { actions.clearError(selected.row); onSaved() }} onDirtyChange={onDirtyChange} /> : null }
}

/** AG owns fill/paste; a gallery edit opens the same dialog from every native open gesture. */
function MediaEditorGateway(p: { data: MediaRow; eGridCell: HTMLElement; api: { stopEditing(cancel: boolean): void }; open(row: MediaRow, anchor: HTMLElement | null): void }) {
  useEffect(() => { p.api.stopEditing(true); p.open(p.data, p.eGridCell) }, [])
  return null
}

export function productMediaColumn<Row extends MediaRow>(open: (row: Row, anchor: HTMLElement | null) => void, actions?: MediaCellActions): ColDef<Row> {
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
    onCellDoubleClicked: p => { if (p.data && !p.column.isCellEditable(p.node) && !p.isEventHandlingSuppressed) open(p.data, p.event?.target instanceof HTMLElement ? p.event.target.closest('[role="gridcell"]') : null) },
    suppressKeyboardEvent: p => { if (p.data && ['Enter', 'F2', 'Delete', 'Backspace'].includes(p.event.key) && !p.event.ctrlKey && !p.event.metaKey && !p.event.altKey) { p.event.preventDefault(); p.event.stopPropagation(); open(p.data, p.event.target instanceof HTMLElement ? p.event.target.closest('[role="gridcell"]') : null); return true } return false },
    cellRenderer: (p: ICellRendererParams<Row>) => {
      if (!p.data) return null
      const row = p.data, label = row.sku || row.name || 'Product'
      const refresh = () => { if (!p.api.isDestroyed()) p.api.refreshCells({ rowNodes: [p.node], columns: [PRODUCT_MEDIA_COLUMN], force: true }) }
      const focus = () => { if (p.node.rowIndex != null) { p.api.setFocusedCell(p.node.rowIndex, PRODUCT_MEDIA_COLUMN); p.api.clearCellSelection(); p.api.addCellRange({ rowStartIndex: p.node.rowIndex, rowEndIndex: p.node.rowIndex, columns: [PRODUCT_MEDIA_COLUMN] }) } }
      return <div className={styles.cell} aria-busy={row.productMediaSaving || undefined}>
        {row.productMediaError ? <span>Media needs attention</span> : row.productMedia ? <MediaStrip items={row.productMedia} label={label}
          limit={Math.max(1, Math.min(5, Math.floor(((p.column?.getActualWidth() ?? 280) - 80) / 36)))}
          onReorder={actions?.canEdit() && !row.productMediaSaving ? ids => actions.reorder(row, ids, refresh) : undefined}
          onFocusCell={focus} onOpen={() => open(row, p.eGridCell)} /> : <span>Manage media</span>}
        <CellAction label={`${actions?.canEdit() ? 'Edit' : 'View'} product media: ${label}`} description={actions?.error(row) || (row.productMediaSaving ? 'Saving media…' : !actions?.canEdit() ? 'View images and videos. Media editing is unavailable with your current permissions.' : 'Drag thumbnails to reorder. Drag the bottom-right handle to copy the gallery. Enter or F2 opens the editor.')} onFocusCell={focus} onActivate={anchor => open(row, anchor)} />
      </div>
    },
  }
}
