'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { GridApi } from '@/design-system/grid'
import type { PreferencesModalProps, PreferencesValue } from '@/design-system/patterns/PreferencesModal'
import type { SheetColumnsApi } from './useSheetColumns'
import type { RevealIntent } from '../drawer'

/** Personal layouts and named views follow the same save/reset flow on every scope. */
export function useSheetPreferences<Row, Page>(options: {
  scope: 'master' | 'channel'
  sheetColumns: SheetColumnsApi<Page>
  getGridApi: () => GridApi<Row> | null
  bandWidthRef: MutableRefObject<number>
  bandDerivedRef: MutableRefObject<boolean>
  revealCell: (key: string, intent?: RevealIntent) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PreferencesValue | null>(null)
  const live = useRef(options)
  live.current = options
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current) }, [])
  const openCustomise = useCallback(() => {
    if (!live.current.getGridApi()) return
    setDraft(live.current.sheetColumns.currentPreferences())
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
  const confirm = useCallback(async (next: PreferencesValue) => {
    const { getGridApi, sheetColumns } = live.current
    const api = getGridApi()
    const visible = new Set((api?.getColumnState() ?? []).filter(column => !column.hide).map(column => column.colId))
    const firstNew = next.visibleColumns.find(key => !visible.has(key))
    await sheetColumns.savePreferences(next)
    setDraft(next)
    if (firstNew) {
      if (revealTimer.current) clearTimeout(revealTimer.current)
      revealTimer.current = setTimeout(() => {
        if (live.current.getGridApi() === api) live.current.revealCell(firstNew, 'uncover')
      }, 0)
    }
  }, [])
  const saveAs = useCallback(async (name: string, next: PreferencesValue) => {
    await live.current.sheetColumns.savePreferencesAs(name, next)
    setDraft(next)
  }, [])
  const update = useCallback(async (next: PreferencesValue) => {
    const { sheetColumns } = live.current
    if (sheetColumns.active.kind !== 'saved') return
    const id = sheetColumns.active.id
    const view = sheetColumns.gridState.views.find(view => view.id === id)
    if (!view) throw new Error('That view no longer exists')
    await sheetColumns.updatePreferences(view, next)
    setDraft(next)
  }, [])
  const { sheetColumns } = options
  const preferences: PreferencesModalProps = {
    open, onClose: () => setOpen(false),
    value: draft ?? { visibleColumns: [], lockedColumns: options.scope === 'master' ? ['product'] : [], stickyFirstColumn: true, stickyLastColumn: false, pageSize: 0, sortBy: '', sortDir: 'asc' },
    onConfirm: confirm,
    allColumns: sheetColumns.preferenceColumns, defaultVisible: sheetColumns.allColumnKeys,
    pageSizeChoices: [], sortFieldOptions: [], showSticky: false,
    groupToggles: true, inViewCount: true, attributeGroups: true,
    onReloadSaved: sheetColumns.reloadSavedPreferences,
    viewSave: { activeName: sheetColumns.activeViewName, onSaveAs: saveAs, onUpdate: sheetColumns.activeViewName ? update : undefined },
    title: sheetColumns.activeViewName ? `Customise columns · ${sheetColumns.activeViewName}` : 'Customise columns',
    listHint: options.scope === 'master'
      ? 'Organise attributes into groups and choose their order. Save keeps your personal layout for this market, including after a reload.'
      : 'Organise channel attributes into groups and choose their order. Save keeps your personal layout for this channel and market after a reload.',
  }
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])
  return { preferences, columnDialog, openCustomise }
}
