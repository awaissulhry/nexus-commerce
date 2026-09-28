'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NativeEdit } from '@nexus/shared/shopify-information'
import { nativeFieldValueError, nativeNullableFields } from '@nexus/shared/shopify-information'
import { validateShopifyField, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { EDITOR_CAPS, EDITOR_KEY_HINT_PANEL, editorBox, type ColDef, type GridApi } from '@/design-system/grid'
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
type Closed = (session: EditSession) => void
function Gateway(p: { data: ChannelSheetRow; definition: SheetColumn; eGridCell: HTMLElement; open: Open; closed: Closed; api: GridApi<ChannelSheetRow>; onValueChange: (value: unknown) => void }) {
  // Keep AG's edit session alive while the pop-up panel (outside AG's popup layer) owns focus. Committing through its
  // reactive editor contract records one ordinary undo action and reaches the sheet writer. When AG ends the edit by
  // itself, the panel goes too — it never outlives the session it would commit into.
  useEffect(() => {
    const session: EditSession = { commit: value => { p.onValueChange(value); p.api.stopEditing() }, cancel: () => p.api.stopEditing(true) }
    p.open(p.data, p.definition, p.eGridCell, session)
    return () => p.closed(session)
  }, [])
  return null
}

/**
 * The Shopify cell pop-up (sheet pop-up rebuild P1, docs/sheet-popup-editor/PLAN-2026-09-27.md §4.1): a panel UNDER the
 * cell, not a dialog over the sheet — the cell and its row stay in view, as in Shopify's bulk editor and the approved
 * Option A text editor. No Cancel / Save buttons: Enter or a click outside saves, Esc cancels, one key line. A value that
 * does not pass the field's rules is NOT saved — the panel stays open and says why (a click outside is then held back).
 * It carries `ag-custom-component-popup`, so AG does not end the edit when focus moves into it.
 */
export function CellPanel({ anchor, label, onSave, onCancel, children, footer }: {
  anchor: HTMLElement | null; label: string; onSave(): boolean; onCancel(): void; children: ReactNode; footer: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  /* It starts OFF-SCREEN, not hidden: a hidden element cannot take focus, and the first focus must not wait for a frame
     (a background tab draws none). The layout effect places it before the first paint. */
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -10000, top: 0 })
  const save = useRef(onSave); save.current = onSave
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!el) return
      const vw = window.innerWidth, vh = window.innerHeight
      /* A phone gets a sheet across the screen: a cell-anchored box would not fit beside a 390px cell. */
      if (!anchor?.isConnected || vw < 640) { setStyle({ position: 'fixed', left: 12, right: 12, top: 56, maxHeight: vh - 68 }); return }
      const a = anchor.getBoundingClientRect()
      const box = editorBox({ cellWidth: a.width, cellHeight: a.height, roomToRight: vw - 16, kind: 'media' })
      const maxHeight = Math.min(EDITOR_CAPS.media.height, vh - 16)
      const height = Math.min(el.scrollHeight, maxHeight)
      const left = Math.max(8, Math.min(a.left, vw - box.width - 8))
      const below = a.bottom + 4, above = a.top - height - 4
      const top = below + height <= vh - 8 ? below : above >= 8 ? above : Math.max(8, vh - height - 8)
      setStyle({ position: 'fixed', left, top, width: box.width, maxHeight })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    const observer = new ResizeObserver(place); if (ref.current) observer.observe(ref.current)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])
  /* Focus lands on the first control, else the panel — without focus inside, no key would reach it, and the page's
     own shortcuts (G then R opens Pricing) would take the typing (measured on /design/shopify-popup, 2026-09-28). */
  useEffect(() => {
    const el = ref.current
    /* In ORDER of preference, not document order: a chip's × comes before the search line in the DOM, and focus on it
       sent typing to the page (measured 2026-09-28). */
    const first = ['input:not([type="color"]):not([disabled])', 'textarea:not([disabled])', '[role="listbox"][tabindex="0"]', 'button:not([disabled])']
      .map(selector => el?.querySelector<HTMLElement>(selector)).find(Boolean)
    ;(first ?? el)?.focus({ preventScroll: true })
  }, [])
  /* Focus must not fall out. A control that removes itself on use (the single-entry list closes on a pick) drops focus to
     the page — Chrome sends no focusout for a removed element — and then Esc and Enter reach nothing (measured on
     /design/shopify-popup, 2026-09-28). So after every update, focus on the bare page comes back to the panel. Focus in a
     dialog it opened, or anywhere else real, is left alone. */
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true })
  })
  /* A press outside saves, like Shopify. Presses inside a dialog it opened (the picker, the entry editor), a tooltip or
     a picture preview are not "outside". A value that cannot be saved holds the press back. */
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || ref.current?.contains(target)) return
      if (target.closest('[aria-modal="true"], .nds-backdrop, [role="tooltip"], .nds-thumb-preview')) return
      if (!save.current()) { event.preventDefault(); event.stopPropagation() }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    /* Plain letters stay inside the pop-up: the page's chords (G then R opens Pricing) listen on the window and skip only
       text fields, so a letter typed while a button in here has focus would leave the page (measured 2026-09-28). */
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation()
    if (event.defaultPrevented) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (event.key === 'Tab') {
      /* Tab moves between the panel's controls and wraps; it never falls out onto the page behind. */
      const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])') ?? [])
        .filter(el => !el.matches(':disabled') && el.getClientRects().length > 0)
      if (!all.length) return
      const i = all.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && i <= 0) { event.preventDefault(); all[all.length - 1].focus() }
      else if (!event.shiftKey && i === all.length - 1) { event.preventDefault(); all[0].focus() }
      return
    }
    /* In a multi-line box Enter adds a line, so Ctrl/⌘+Enter saves there — and anywhere else in the panel (gap G5). */
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) { event.preventDefault(); onSave(); return }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if ((event.target as HTMLElement).closest('textarea, button, a[href], [contenteditable="true"]')) return
      event.preventDefault()
      onSave()
    }
  }
  if (typeof document === 'undefined') return null
  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1} className={`ag-custom-component-popup nds-readable ${styles.cellPanel}`} style={style} onKeyDown={keys}>
      <div className={styles.cellPanelBody}>{children}</div>
      <div className={styles.cellPanelFoot}>{footer}</div>
    </div>,
    document.body,
  )
}

export function useShopifyDraftCell(schema: ShopifyStoreSchema | null | undefined, getApi: () => GridApi<ChannelSheetRow> | null) {
  const scope = useStudioScope()
  const canPublish = usePermission('products.publish')
  const canEdit = usePermission('products.edit'), canAdjustInventory = usePermission('inventory.adjust')
  const [entry, setEntry] = useState<{ id: string | null; copy?: boolean; type?: string } | null>(null)
  /* Bumped after an entry is saved: the pop-up's pick list is read again, so a new entry shows at once (B2). */
  const [referenceVersion, setReferenceVersion] = useState(0)
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
  /* AG ended the edit by itself (the row re-rendered, the grid scrolled it away): drop the panel, write nothing. */
  const closed: Closed = useCallback(session => { setSelected(current => current?.session === session ? null : current); setEntry(null) }, [])
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
  /** Save = the old "Save draft" checks, then commit. Returns false (and says why) when the value may not be saved. */
  const save = (): boolean => {
    if (!selected || !field || !schema) return true
    if (locked || value === selected.baseline) { close(); return true }
    const current = schema.definitions.find(d => d.ownerType === field.owner && d.namespace === field.definition?.namespace && d.key === field.definition?.key)
    const problem = field.definition && JSON.stringify(current) !== JSON.stringify(field.definition) ? 'Shopify changed this field’s rules. Your value stays here; close and open the cell again to use the new rules.'
      : translated && value === null ? null : field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, selected.baseline)
    if (problem) { setError(`Not saved: ${problem}`); return false }
    const node = getApi()?.getRowNode(selected.row.rowId)
    if (!node || shopifyRawValue(node.data?.values[selected.column.key]?.value) !== selected.baseline) { setError('Not saved: the cell changed while this editor was open. Reopen it to review both values.'); return false }
    if (!selected.session) { setError('Not saved: the cell edit session ended. Reopen this editor to save your value.'); return false }
    selected.session.commit(value)
    close(true)
    return true
  }
  const reason = permissionReason || field?.reason || (selected ? selected.row.values[selected.column.key]?.writeBlockedReason : null)
  return { open, closed, element: selected && field && schema ? <><CellPanel anchor={selected.anchor} label={`${field.label}: ${selected.row.sku}`} onSave={save} onCancel={() => close()}
    footer={<><span className="nds-editor-keyhint">{EDITOR_KEY_HINT_PANEL}</span><span className={styles.hint}>Saves in Nexus · Publish to send it to Shopify</span></>}>
    <div className={styles.stack}>
      <div className={styles.cellPanelHead}><strong>{field.label}</strong><span>{selected.row.sku}</span></div>
      {error && <Banner tone="danger">{error}</Banner>}{reason && <Banner tone="neutral">{reason}</Banner>}
      {field.definition ? <LinkedFieldEditor path={path} schema={schema} definition={field.definition} value={value} disabled={locked} referenceVersion={referenceVersion} onChange={next => { setValue(next); setError('') }}
        onOpenEntry={id => setEntry({ id })} onCopyEntry={!locked && canPublish ? id => setEntry({ id, copy: true }) : undefined}
        onCreateEntry={!locked && canPublish ? type => setEntry({ id: null, type }) : undefined} />
        : field.id === 'tags' ? <InformationTagsEditor original={selected.baseline} disabled={locked} onChange={setValue} />
        : <ShopifyNativeEditor path={path} schema={schema} field={field} value={value} disabled={locked} onChange={setValue} />}
      {!field.definition && (translated || nativeNullableFields.includes(field.id)) && value !== null && <Button size="xs" variant="quiet" disabled={locked} onClick={() => setValue(null)}>{translated ? 'Use primary language' : 'Clear value'}</Button>}
    </div>
  </CellPanel>{entry && <EntryEditor key={`${entry.id}:${!!entry.copy}:${entry.type ?? ''}`} id={entry.id} copy={entry.copy} initialType={entry.type} path={path} schema={schema} canPublish={canPublish && !locked}
    onClose={() => setEntry(null)} onSaved={saved => {
      setReferenceVersion(v => v + 1)
      /* A copy replaces the entry it was copied from; a NEW entry is picked straight away (Shopify's "Add new entry"). */
      const list = field.type.startsWith('list.')
      if (entry.copy) setValue(previous => list ? JSON.stringify(JSON.parse(previous ?? '[]').map((id: string) => id === entry.id ? saved.id : id)) : saved.id)
      else if (!entry.id) setValue(previous => list ? JSON.stringify([...JSON.parse(previous ?? '[]'), saved.id]) : saved.id)
      if (entry.copy || !entry.id) setEntry(null)
    }} />}</> : null }
}
export function shopifyDraftColumn(column: SheetColumn, open: Open, closed?: Closed): Partial<ColDef<ChannelSheetRow>> {
  const field = column.shopifyField!
  return {
    cellEditor: Gateway, cellEditorSelector: undefined, cellEditorPopup: true, cellEditorParams: { open, closed: closed ?? (() => undefined), definition: column },
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
