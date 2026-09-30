'use client'

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GridApi } from '@/design-system/grid'
import type { PreferencesModalProps, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import type { SheetColumnsApi } from './useSheetColumns'
import type { RevealIntent } from '../drawer'
import { getBackendUrl } from '@/lib/backend-url'
import { familyAttributesElsewhere, type FamilyAttributePlaces, type FamilyElsewhere } from './familyPlaces'
import { FamilyAttributesElsewhere } from './FamilyAttributesElsewhere'

/** Personal layouts and named views follow the same save/reset flow on every scope. */
export function useSheetPreferences<Row, Page>(options: {
  scope: 'master' | 'channel'
  sheetColumns: SheetColumnsApi<Page>
  getGridApi: () => GridApi<Row> | null
  bandWidthRef: MutableRefObject<number>
  bandDerivedRef: MutableRefObject<boolean>
  revealCell: (key: string, intent?: RevealIntent) => void
  /**
   * P1 (issue #15) — the product whose family's attributes Customise accounts for: the columns of this sheet, and the
   * channel it shows (`null` = the Shared product sheet). Read when Customise opens, never with the sheet.
   */
  family?: { productId: string; channel: string | null; columns: () => ReadonlyArray<{ key: string; writeField?: string }> }
}) {
  const [open, setOpen] = useState(false)
  /* `new-view`: opened by the views menu's "New view…" — the same dialog, with the name field open. */
  const [intent, setIntent] = useState<'edit' | 'new-view'>('edit')
  const [draft, setDraft] = useState<PreferencesValue | null>(null)
  const live = useRef(options)
  live.current = options
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current) }, [])
  const openCustomise = useCallback(() => {
    if (!live.current.getGridApi()) return
    setDraft(live.current.sheetColumns.currentPreferences())
    setIntent('edit')
    setOpen(true)
  }, [])
  /** "New view…" — build on what is on screen, then name it. Save as view is the way out. */
  const openNewView = useCallback(() => {
    if (!live.current.getGridApi()) return
    setDraft(live.current.sheetColumns.currentPreferences())
    setIntent('new-view')
    setOpen(true)
  }, [])
  const resetColumns = useCallback(() => {
    const { getGridApi, sheetColumns, bandWidthRef, bandDerivedRef, scope } = live.current
    const api = getGridApi()
    if (!api) return
    api.resetColumnState()
    if (scope === 'channel' && bandDerivedRef.current) api.setColumnWidths([{ key: 'ag-Grid-AutoColumn', newWidth: bandWidthRef.current }])
    sheetColumns.gridState.forget()
    setDraft(null)
    const ground = sheetColumns.presets[0]
    if (ground) sheetColumns.applyPreset(ground)
  }, [])
  /* TOOLBAR REBUILD (2026-09-27) — Save keeps the view's NAME: on the operator's own saved view it updates that view;
     anywhere else (a built-in view, a teammate's, My layout) it keeps the arrangement as My layout. */
  const confirm = useCallback(async (next: PreferencesValue) => {
    const { getGridApi, sheetColumns } = live.current
    const api = getGridApi()
    const visible = new Set((api?.getColumnState() ?? []).filter(column => !column.hide).map(column => column.colId))
    // Keys are FIELDS; with languages split a field is on screen when any of its language columns is.
    const firstNew = next.visibleColumns.find(key => !sheetColumns.gridKeysOf(key).some(colId => visible.has(colId)))
    const own = sheetColumns.ownActiveView
    if (own) await sheetColumns.updatePreferences(own, next)
    else await sheetColumns.savePreferences(next)
    setDraft(next)
    if (firstNew) {
      if (revealTimer.current) clearTimeout(revealTimer.current)
      revealTimer.current = setTimeout(() => {
        const colId = live.current.sheetColumns.gridKeysOf(firstNew)[0]
        if (colId && live.current.getGridApi() === api) live.current.revealCell(colId, 'uncover')
      }, 0)
    }
  }, [])
  const saveAs = useCallback(async (name: string, next: PreferencesValue) => {
    await live.current.sheetColumns.savePreferencesAs(name, next)
    setDraft(next)
  }, [])
  const [places, setPlaces] = useState<FamilyAttributePlaces | 'loading' | 'error' | null>(null)
  const familyProductId = options.family?.productId
  useEffect(() => {
    if (!open || !familyProductId) return
    let current = true
    setPlaces('loading')
    fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(familyProductId)}/studio/family-attributes`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: FamilyAttributePlaces) => { if (current) setPlaces(body) })
      .catch(() => { if (current) setPlaces('error') })
    return () => { current = false }
  }, [open, familyProductId])
  const family = live.current.family
  const elsewhere: FamilyElsewhere | 'loading' | 'error' | null = !family || places === null ? null
    : places === 'loading' || places === 'error' ? places : familyAttributesElsewhere(places, family.columns(), family.channel)
  const { sheetColumns } = options
  const own = sheetColumns.ownActiveView
  const where = options.scope === 'master' ? 'the shared product' : 'this channel'
  const preferences: PreferencesModalProps = {
    open, onClose: () => setOpen(false),
    value: draft ?? { visibleColumns: [], lockedColumns: options.scope === 'master' ? ['product'] : [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' },
    onConfirm: confirm,
    allColumns: sheetColumns.preferenceColumns, defaultVisible: sheetColumns.allColumnKeys,
    pageSizeChoices: [], sortFieldOptions: [], showSticky: false,
    groupToggles: true, inViewCount: true, attributeGroups: true, bulkPick: true, rememberInteraction: true,
    onReloadSaved: sheetColumns.reloadSavedPreferences,
    // Save already updates the operator's own view, so the footer offers no second "Update" button.
    viewSave: { activeName: sheetColumns.activeViewName, onSaveAs: saveAs, startNaming: intent === 'new-view' },
    confirmLabel: own ? `Save “${own.name}”` : 'Save',
    ...(elsewhere ? { workspaceSlot: createElement(FamilyAttributesElsewhere, { state: elsewhere }) } : {}),
    title: intent === 'new-view' ? 'New view' : `Customise columns · ${viewLabel(sheetColumns)}`,
    listHint: own
      ? `Tick the attributes to show. Save updates your view “${own.name}” for ${where}, on every product and market.`
      : `Tick the attributes to show. Save keeps them as My layout for ${where}, on every product and market. Languages come from the Languages menu.`,
  }
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])
  return { preferences, columnDialog, openCustomise, openNewView }
}

/** What the Customise title names: the saved view, the built-in view, or My layout. */
function viewLabel<Page>(columns: SheetColumnsApi<Page>): string {
  const active = columns.active
  if (active.kind === 'saved') return active.name
  if (active.kind === 'preset') return active.label
  if (active.kind === 'all') return columns.presets.find(preset => preset.id === 'all')?.label ?? 'All attributes'
  return columns.emptyLabel
}
