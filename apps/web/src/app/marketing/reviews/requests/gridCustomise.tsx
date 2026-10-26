'use client'

/**
 * Reviews › Requests — "Customise" for the Queue and Rules grids: the DS PreferencesModal over AG's column state
 * (which columns show, their order), opened from the toolbar and from every header's ⋮ menu (`columnDialog`). The same
 * bridge the Bids view uses (`columnStateToPrefs` / `prefsToColumnState`); the selection column never shows in it.
 */
import { useCallback, useMemo, useState, type ReactNode, type RefObject } from 'react'
import {
  AG_SELECTION_COL,
  columnStateToPrefs,
  prefsToColumnState,
  type GridApi,
  type PrefsBridgeOptions,
} from '@/design-system/grid'
import { PreferencesModal, type PreferencesValue } from '@/design-system/patterns'

export interface GridColumnSpec {
  key: string
  label: string
  /** Always shown, never moved (the identity and actions columns). */
  locked?: boolean
  /** Off until a person adds it in Customise. */
  hidden?: boolean
}

const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []

export interface GridCustomise {
  openCustomise: () => void
  /** For NexusGrid's `columnDialog`: Customise and Reset in every header's menu. */
  columnDialog: { customise: () => void; reset: () => void }
  /** The dialog while it is open. */
  modal: ReactNode
}

export function useGridCustomise<T>(apiRef: RefObject<GridApi<T> | null>, specs: readonly GridColumnSpec[]): GridCustomise {
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: specs.map((c) => ({ key: c.key, locked: c.locked })) }), [specs])
  const allColumns = useMemo(() => specs.map((c) => ({ key: c.key, label: c.label, locked: c.locked })), [specs])
  const defaults = useMemo<PreferencesValue>(() => ({
    visibleColumns: specs.filter((c) => !c.hidden).map((c) => c.key),
    lockedColumns: [],
    stickyFirstColumn: true,
    stickyLastColumn: false,
    pageSize: 0,
    sortBy: '',
    sortDir: 'asc',
  }), [specs])
  const [open, setOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(defaults)

  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState().filter((c) => c.colId !== AG_SELECTION_COL), current, bridge))
    setOpen(true)
  }, [apiRef, bridge])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, bridge), applyOrder: true })
    setPrefs(next)
  }, [apiRef, bridge])
  const reset = useCallback(() => {
    apiRef.current?.resetColumnState()
    setPrefs(defaults)
  }, [apiRef, defaults])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset }), [openCustomise, reset])
  const close = useCallback(() => setOpen(false), [])

  const modal = open ? (
    <PreferencesModal
      open
      onClose={close}
      title="Customise columns"
      value={prefs}
      onConfirm={applyPrefs}
      allColumns={allColumns}
      defaultVisible={defaults.visibleColumns}
      pageSizeChoices={NO_CHOICES}
      sortFieldOptions={NO_SORT_OPTIONS}
      showSticky={false}
    />
  ) : null

  return { openCustomise, columnDialog, modal }
}
