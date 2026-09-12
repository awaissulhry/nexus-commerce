'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeEdit } from '@nexus/shared/shopify-information'
import { nativeFieldValueError, nativeNullableFields } from '@nexus/shared/shopify-information'
import { validateShopifyField, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Banner, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import type { ColDef, GridApi } from '@/design-system/grid'
import { useStudioScope } from '../contracts'
import type { ChannelSheetRow, SheetColumn } from '../sheet/channel/types'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { EntryEditor } from './EntryEditor'
import { ShopifyNativeEditor } from './ShopifyNativeEditor'
import { InformationTagsEditor } from './InformationTagsEditor'
import { informationValueLabel } from './informationEditing'
import styles from './information.module.css'

export const shopifyRawValue = (value: unknown): string | null => value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
type EditSession = { commit: (value: string | null) => void; cancel: () => void }
type Selected = { row: ChannelSheetRow; column: SheetColumn; anchor: HTMLElement | null; baseline: string | null; session?: EditSession }
type Open = (row: ChannelSheetRow, column: SheetColumn, anchor: HTMLElement | null, session?: EditSession) => void
function Gateway(p: { data: ChannelSheetRow; definition: SheetColumn; eGridCell: HTMLElement; open: Open; api: GridApi<ChannelSheetRow>; onValueChange: (value: unknown) => void }) {
  // Keep AG's edit session alive while the portalled dialog owns focus. Committing through its
  // reactive editor contract records one ordinary undo action and reaches the sheet writer.
  useEffect(() => { p.open(p.data, p.definition, p.eGridCell, {
    commit: value => { p.onValueChange(value); p.api.stopEditing() },
    cancel: () => p.api.stopEditing(true),
  }) }, [])
  return null
}
export function useShopifyDraftCell(schema: ShopifyStoreSchema | null | undefined, getApi: () => GridApi<ChannelSheetRow> | null) {
  const scope = useStudioScope()
  const canPublish = usePermission('products.publish')
  const canEdit = usePermission('products.edit'), canAdjustInventory = usePermission('inventory.adjust')
  const [entry, setEntry] = useState<{ id: string; copy?: boolean } | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null), [value, setValue] = useState<string | null>(null), [error, setError] = useState('')
  const dirty = useRef(false); dirty.current = !!entry || !!selected && value !== selected.baseline
  useEffect(() => scope.registerScopeChangeGuard(() => !dirty.current), [scope.registerScopeChangeGuard])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard)
  }, [])
  const open: Open = useCallback((row, column, anchor, session) => {
    if (!session && row.values[column.key]?.writable && canEdit && (column.shopifyField?.id !== 'inventory' || canAdjustInventory)) {
      const api = getApi(), node = api?.getRowNode(row.rowId)
      if (node?.rowIndex != null) api?.startEditingCell({ rowIndex: node.rowIndex, colKey: column.key })
      return
    }
    const baseline = shopifyRawValue(row.values[column.key]?.value)
    setSelected({ row, column, anchor, baseline, session }); setValue(baseline); setError('')
  }, [getApi, canEdit, canAdjustInventory])
  const close = (committed = false) => {
    if (!committed) selected?.session?.cancel()
    const cell = selected; setSelected(null)
    if (cell) requestAnimationFrame(() => { const api = getApi(), node = api?.getRowNode(cell.row.rowId); if (node?.rowIndex != null) api?.setFocusedCell(node.rowIndex, cell.column.key) })
  }
  const field = selected?.column.shopifyField
  const permissionReason = !canEdit ? 'Your Nexus role needs product editing permission to change this field.' : field?.id === 'inventory' && !canAdjustInventory ? 'Your Nexus role needs inventory adjustment permission to change stock.' : null
  const locked = !!permissionReason || !selected?.row.values[selected.column.key]?.writable || !!field?.reason
  const path = selected ? `/api/products/${encodeURIComponent(selected.row.shopify?.productId ?? selected.row.id)}/shopify-linked?${new URLSearchParams({ accountId: scope.accountId ?? '', market: 'GLOBAL', ...(selected.row.shopify?.listingId ?? selected.row.listing?.id ? { listingId: (selected.row.shopify?.listingId ?? selected.row.listing?.id)! } : {}), ...(scope.locale ? { locale: scope.locale } : {}) })}` : ''
  const translated = !!scope.locale && scope.locale !== 'und' && scope.locale !== schema?.locales.find(l => l.primary)?.locale
  return { open, element: selected && field && schema ? <><Modal open readable className="ag-custom-component-popup" size="sm" title={`${field.label}: ${selected.row.sku}`} anchor={selected.anchor} onClose={() => close()}
    footer={<><Button size="sm" onClick={() => close()}>Cancel</Button><Button size="sm" variant="primary" disabled={locked || value === selected.baseline} onClick={() => {
      const current = schema.definitions.find(d => d.ownerType === field.owner && d.namespace === field.definition?.namespace && d.key === field.definition?.key)
      const problem = field.definition && JSON.stringify(current) !== JSON.stringify(field.definition) ? 'This definition changed. Reopen the editor; your input is preserved here.'
        : translated && value === null ? null : field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, selected.baseline)
      if (problem) { setError(problem); return }
      const node = getApi()?.getRowNode(selected.row.rowId)
      if (!node || shopifyRawValue(node.data?.values[selected.column.key]?.value) !== selected.baseline) { setError('The cell changed while this editor was open. Reopen it to review both values.'); return }
      if (!selected.session) { setError('The cell edit session ended. Reopen this editor to save your value.'); return }
      selected.session.commit(value)
      close(true)
    }}>Save draft</Button></>}>
    <div className={styles.stack}>{error && <Banner tone="danger">{error}</Banner>}{(permissionReason || field.reason || selected.row.values[selected.column.key]?.writeBlockedReason) && <Banner tone="neutral">{permissionReason || field.reason || selected.row.values[selected.column.key]?.writeBlockedReason}</Banner>}
      {field.definition ? <LinkedFieldEditor path={path} schema={schema} definition={field.definition} value={value} disabled={locked} onChange={setValue}
        onOpenEntry={id => setEntry({ id })} onCopyEntry={!locked && canPublish ? id => setEntry({ id, copy: true }) : undefined} />
        : field.id === 'tags' ? <InformationTagsEditor original={selected.baseline} disabled={locked} onChange={setValue} />
        : <ShopifyNativeEditor path={path} schema={schema} field={field} value={value} disabled={locked} onChange={setValue} />}
      {!field.definition && (translated || nativeNullableFields.includes(field.id)) && value !== null && <Button size="xs" variant="quiet" disabled={locked} onClick={() => setValue(null)}>{translated ? 'Use primary language' : 'Clear value'}</Button>}
      <p className={styles.hint}>Saves in Nexus. Publish or synchronize this listing separately to update Shopify.</p>
    </div>
  </Modal>{entry && <EntryEditor key={`${entry.id}:${!!entry.copy}`} id={entry.id} copy={entry.copy} path={path} schema={schema} canPublish={canPublish && !locked}
    onClose={() => setEntry(null)} onSaved={saved => { if (entry.copy) {
      setValue(previous => field.type.startsWith('list.') ? JSON.stringify(JSON.parse(previous ?? '[]').map((id: string) => id === entry.id ? saved.id : id)) : saved.id)
      setEntry(null)
    } }} />}</> : null }
}
export function shopifyDraftColumn(column: SheetColumn, open: Open): Partial<ColDef<ChannelSheetRow>> {
  const field = column.shopifyField!
  return {
    cellEditor: Gateway, cellEditorSelector: undefined, cellEditorPopup: true, cellEditorParams: { open, definition: column },
    cellDataType: false, valueParser: p => p.newValue,
    valueSetter: p => {
      const old = p.data?.values[column.key]
      if (!p.data || !old || !old.writable) return false
      p.data.values = { ...p.data.values, [column.key]: { ...old, value: p.newValue, pinned: true, inherited: false } }
      return true
    },
    valueFormatter: p => {
      const raw = shopifyRawValue(p.value)
      if (field.id === 'inventory' && raw) {
        try { const inventory = JSON.parse(raw); const quantity = column.key === 'onHandQuantity' ? 'onHand' : 'available'; return inventory.locations.map((location: { name: string; available: number; onHand: number }) => `${location.name}: ${location[quantity] ?? 'Unavailable'}`).join(', ') } catch { return 'Stored inventory needs review' }
      }
      if (field.type.includes('_reference') && raw) {
        try { return (field.type.startsWith('list.') ? JSON.parse(raw) : [raw]).map((id: string) => column.optionLabels?.[id] ?? id).join(', ') } catch { return 'Stored references need review' }
      }
      return informationValueLabel(field.type, raw)
    },
  }
}
