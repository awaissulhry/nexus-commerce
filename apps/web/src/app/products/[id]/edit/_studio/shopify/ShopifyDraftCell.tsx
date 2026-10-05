'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NativeEdit } from '@nexus/shared/shopify-information'
import { nativeEmptyClearFields, nativeFieldValueError, nativeNullableFields } from '@nexus/shared/shopify-information'
import { validateShopifyField, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { Banner, KeyValue } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'
import { EDITOR_CAPS, EDITOR_KEY_HINT_PANEL, editorBox, type ColDef, type GridApi } from '@/design-system/grid'
import { useStudioScope } from '../contracts'
import type { ChannelSheetRow, SheetColumn, StudioCellValue } from '../sheet/channel/types'
import type { InformationField } from '@nexus/shared/shopify-information'
import { LinkedFieldEditor } from './LinkedFieldEditor'
import { EntryEditor } from './EntryEditor'
import { ShopifyNativeEditor } from './ShopifyNativeEditor'
import { InformationTagsEditor } from './InformationTagsEditor'
import { informationValueLabel, informationDraftCellError } from './informationEditing'
import { linkedEndpoint, linkedRequest } from './api'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { isShopifyHistoryValue, noteShopifyEdit, noteShopifyReplay, replayShopifyHistory } from './draftHistory'
import { optimisticCell } from '../sheet/channel/savedCellPatch'
import { rememberChosenReferenceLabel } from '../sheet/referenceOptions'
import { shopifyKeepsOwnValue } from '../sheet/channel/channelCellProvenance'
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
     a picture preview are not "outside" — nor are the date calendar and the option lists its controls open in <body>:
     a day picked with the mouse closed the pop-up unsaved (measured on the lab's Date row, B3b). A value that cannot be
     saved holds the press back. */
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || ref.current?.contains(target)) return
      if (target.closest('[aria-modal="true"], .nds-backdrop, [role="tooltip"], .nds-thumb-preview, .nds-dp-pop, .nds-combo-pop')) return
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

/**
 * A follower that keeps a saved Nexus draft value while its sharing rule still copies the source (the API's `divergence`,
 * `channel-sheet-projection.ts`). Both facts are shown: the value kept here and the value Shopify receives on publish —
 * also when they are equal, because the conflict is the rule, not the text. Showing them writes nothing.
 * `follows` (S1 item 5 f): the cell follows Shared on a product Shopify already holds, and Shopify keeps its own value.
 */
export function ShopifyDivergenceBanner({ type, kept, divergence, follows = false, names }: { type: string; kept: string | null; divergence: StudioCellValue['divergence']; follows?: boolean; names?: Record<string, string> }) {
  if (!divergence) return null
  if (follows) return <Banner tone="warning" title="Shopify keeps its own value">
    <KeyValue dense items={[
      { label: 'Shared value, shown here', value: informationValueLabel(type, kept, names) },
      { label: 'Shopify has', value: informationValueLabel(type, shopifyRawValue(divergence.publishesAs), names) },
    ]} />
    <p>{divergence.note}</p>
  </Banner>
  return <Banner tone="warning" title="Shopify receives the shared value">
    <KeyValue dense items={[
      { label: 'Saved draft, kept here', value: informationValueLabel(type, kept, names) },
      { label: 'Shopify receives', value: informationValueLabel(type, shopifyRawValue(divergence.publishesAs), names) },
    ]} />
    <p>{divergence.note}</p>
  </Banner>
}

/**
 * The pop-up's footer line: where Enter saves and what sends it on (D5). A row already on Shopify (`row.shopify`: a
 * persisted Shopify product or variant) is sent by Review and synchronize…; Publish cannot update a product already on
 * Shopify (`SHOPIFY_EXISTING_NOT_YET`). A row not on Shopify yet is created by Publish. Pure, so it is tested without a grid.
 */
export function shopifyPanelFooter(row: Pick<ChannelSheetRow, 'shopify'>): string {
  return row.shopify ? 'Saves in Nexus · Review and synchronize… sends it to Shopify' : 'Saves in Nexus · Publish to send it to Shopify'
}

export type ShopifyPanelSave = { kind: 'close' } | { kind: 'refuse'; message: string } | { kind: 'commit'; value: string | null }
/**
 * What Enter / a click outside does with the pop-up's value. Reading a cell and leaving it unchanged closes without a
 * write — also for a cell that shows a sharing conflict. Pure, so the no-write rule is tested without a grid.
 */
export function shopifyPanelSave(p: { field: InformationField; schema: ShopifyStoreSchema; value: string | null; baseline: string | null; locked: boolean
  translated: boolean; contentWrite: boolean; current: string | null | undefined; hasSession: boolean }): ShopifyPanelSave {
  const { field, schema, value, baseline } = p
  if (p.locked || value === baseline) return { kind: 'close' }
  const current = schema.definitions.find(d => d.ownerType === field.owner && d.namespace === field.definition?.namespace && d.key === field.definition?.key)
  const problem = field.definition && JSON.stringify(current) !== JSON.stringify(field.definition) ? 'Shopify changed this field’s rules. Your value stays here; reload the sheet to use the new rules.'
    : p.translated && value === null ? null : informationDraftCellError(field, value, baseline, p.contentWrite)
  if (problem) return { kind: 'refuse', message: `Not saved: ${problem}` }
  if (p.current === undefined || p.current !== baseline) return { kind: 'refuse', message: 'Not saved: the cell changed while this editor was open. Reopen it to review both values.' }
  if (!p.hasSession) return { kind: 'refuse', message: 'Not saved: the cell edit session ended. Reopen this editor to save your value.' }
  return { kind: 'commit', value }
}

export function useShopifyDraftCell(schema: ShopifyStoreSchema | null | undefined, getApi: () => GridApi<ChannelSheetRow> | null, historyRefused?: ShopifyHistoryRefused) {
  const scope = useStudioScope()
  const canPublish = usePermission('products.publish')
  const canEdit = usePermission('products.edit'), canAdjustInventory = usePermission('inventory.adjust')
  const [entry, setEntry] = useState<{ id: string | null; copy?: boolean; type?: string } | null>(null)
  /* Bumped after an entry is saved: the pop-up's pick list is read again, so a new entry shows at once (B2). */
  const [referenceVersion, setReferenceVersion] = useState(0)
  const [selected, setSelected] = useState<Selected | null>(null), [value, setValue] = useState<string | null>(null), [error, setError] = useState('')
  /* A category field the store has not switched on (`standardTemplateId`): switching it on is its only action. */
  const [switchOn, setSwitchOn] = useState<'idle' | 'busy' | 'done'>('idle')
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
    setSelected({ row, column, anchor, baseline, session }); setValue(baseline); setError(''); setSwitchOn('idle')
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
  const contentWrite = !!selected?.row.values[selected.column.key]?.contentAcknowledgement && !selected?.row.values[selected.column.key]?.shopifyWrite
  /** Save = the old "Save draft" checks, then commit. Returns false (and says why) when the value may not be saved. */
  const save = (): boolean => {
    if (!selected || !field || !schema) return true
    const node = getApi()?.getRowNode(selected.row.rowId)
    const decision = shopifyPanelSave({ field, schema, value, baseline: selected.baseline, locked, translated, contentWrite, hasSession: !!selected.session,
      current: node ? shopifyRawValue(node.data?.values[selected.column.key]?.value) : undefined })
    if (decision.kind === 'close') { close(); return true }
    if (decision.kind === 'refuse') { setError(decision.message); return false }
    selected.session!.commit(decision.value)
    close(true)
    return true
  }
  const template = field?.definition?.standardTemplateId ? field.definition : null
  /* Switching on writes to the Shopify store at once; Shopify creates the field and its value list. The server checks the
     field belongs to this family's category, then tells every open sheet (`shopify.schema.changed`) to reload it. */
  const switchOnField = async () => {
    if (!template || !field) return
    setSwitchOn('busy'); setError('')
    try {
      await linkedRequest(linkedEndpoint(path, '/enable-field'), 'POST', { ownerType: field.owner, namespace: template.namespace, key: template.key })
      setSwitchOn('done')
      /* The server announces it too, but this tab must not depend on the event stream (off against a local API): re-read the
         store's fields now, which reloads the sheet with the field switched on. Other tabs hear it through the channel. */
      if (scope.accountId) emitInvalidation({ type: 'shopify.schema.changed', id: scope.accountId })
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Shopify did not switch on this field.'); setSwitchOn('idle') }
  }
  /* A field not switched on explains itself in its own banner below; the generic read-only note would repeat it. */
  const reason = permissionReason || (template ? null : field?.reason || (selected ? selected.row.values[selected.column.key]?.writeBlockedReason : null))
  const divergence = selected?.row.values[selected.column.key]?.divergence
  const clearsToEmpty = !translated && !!field && !field.definition && nativeEmptyClearFields.includes(field.id)
  const warning = !locked && field && !(translated && value === null) && !informationDraftCellError(field, value, selected?.baseline ?? null, contentWrite)
    ? field.definition ? validateShopifyField(field.definition, value) : nativeFieldValueError(field.id as NativeEdit['field'], value, selected?.baseline ?? null) : null
  return { open, closed, historyRefused, element: selected && field && schema ? <><CellPanel anchor={selected.anchor} label={`${field.label}: ${selected.row.sku}`} onSave={save} onCancel={() => close()}
    footer={<><span className="nds-editor-keyhint">{EDITOR_KEY_HINT_PANEL}</span><span className={styles.hint}>{template ? 'Switching on changes the Shopify store at once' : shopifyPanelFooter(selected.row)}</span></>}>
    <div className={styles.stack}>
      <div className={styles.cellPanelHead}><strong>{field.label}</strong><span>{selected.row.sku}</span></div>
      {error && <Banner tone="danger">{error}</Banner>}{reason && <Banner tone="neutral">{reason}</Banner>}
      {warning && <Banner tone="warning" title="Can save as a Nexus draft">Fix this before publishing: {warning}</Banner>}
      <ShopifyDivergenceBanner type={field.type} kept={selected.baseline} divergence={divergence} follows={shopifyKeepsOwnValue(selected.row.values[selected.column.key])} names={selected.column.optionLabels} />
      {template ? <Banner tone={switchOn === 'done' ? 'success' : 'info'} title={switchOn === 'done' ? `${field.label} is switched on in Shopify` : `${field.label} is not switched on in this Shopify store`}
          action={switchOn === 'done' ? undefined : <Button size="sm" variant="primary" disabled={!canPublish || switchOn === 'busy'} onClick={() => void switchOnField()}>{switchOn === 'busy' ? 'Switching on…' : 'Switch on in Shopify'}</Button>}>
          {switchOn === 'done' ? 'The sheet reloads this field. Open the cell again to choose its values.'
            : `Shopify offers it for this product’s category. Switch it on to add it to the store; you choose values after that.${canPublish ? '' : ' Your Nexus role needs publish permission to switch it on.'}`}
        </Banner>
        : field.definition ? <LinkedFieldEditor path={path} schema={schema} definition={field.definition} value={value} disabled={locked} showErrors={!warning} referenceVersion={referenceVersion} onChange={next => { setValue(next); setError('') }}
        onOpenEntry={id => setEntry({ id })} onCopyEntry={!locked && canPublish ? id => setEntry({ id, copy: true }) : undefined}
        onCreateEntry={!locked && canPublish ? type => setEntry({ id: null, type }) : undefined} />
        : field.id === 'tags' ? <InformationTagsEditor original={selected.baseline} disabled={locked} onChange={setValue} />
        : <ShopifyNativeEditor path={path} schema={schema} field={field} value={value} disabled={locked} onChange={setValue} names={selected.column.optionLabels}
          onChosen={(id, label) => rememberChosenReferenceLabel(selected.column.key, scope.accountId, id, label)} />}
      {/* A cleared theme template is saved as '' (the store's default template): Clear offers it too (Wave 2 D3). */}
      {!field.definition && (translated || nativeNullableFields.includes(field.id) || nativeEmptyClearFields.includes(field.id)) && value !== null && !(clearsToEmpty && value === '') && <Button size="xs" variant="quiet" disabled={locked} onClick={() => setValue(clearsToEmpty ? '' : null)}>{translated ? 'Use primary language' : 'Clear value'}</Button>}
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
/** A history step this cell cannot restore exactly (`draftHistory.ts`): the row, the column and the earlier value. */
export type ShopifyHistoryRefused = (row: ChannelSheetRow, column: SheetColumn, earlier: string) => void
export function shopifyDraftColumn(column: SheetColumn, open: Open, closed?: Closed, onHistoryRefused?: ShopifyHistoryRefused): Partial<ColDef<ChannelSheetRow>> {
  const field = column.shopifyField!
  return {
    cellEditor: Gateway, cellEditorSelector: undefined, cellEditorPopup: true, cellEditorParams: { open, closed: closed ?? (() => undefined), definition: column },
    cellDataType: false, valueParser: p => p.newValue,
    valueSetter: p => {
      const old = p.data?.values[column.key]
      if (!p.data || !old || !old.writable) return false
      /* An undo/redo step of this cell: its value AND its own/follow state. The envelope stops here — the cell gets the
         raw value, and the write takes the intent the state needs. */
      if (isShopifyHistoryValue(p.newValue)) {
        const replay = replayShopifyHistory(old, p.newValue)
        if (replay.kind === 'refuse') onHistoryRefused?.(p.data, column, informationValueLabel(field.type, shopifyRawValue(replay.earlier), column.optionLabels))
        if (replay.kind !== 'apply') return false
        noteShopifyReplay(replay)
        p.data.values = { ...p.data.values, [column.key]: replay.cell }
        return true
      }
      // The sheet's one optimistic cell: an edit Shopify does not have yet reads `pending` before the save answers.
      const next = optimisticCell(old, p.newValue, p.data.rowKind)
      noteShopifyEdit(old, next)
      p.data.values = { ...p.data.values, [column.key]: next }
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
      // W3-4 — a category, sales channel or unit price in words; the names are the column's (taxonomy, store publications).
      return informationValueLabel(field.type, raw, column.optionLabels)
    },
  }
}
