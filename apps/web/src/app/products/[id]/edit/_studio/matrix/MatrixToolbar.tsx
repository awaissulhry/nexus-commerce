'use client'

/**
 * MX.P — the Matrix toolbar IS `SheetToolbar` (CH.1: a sheet's chrome is a property of the SHEET), with
 * this page's count, presets and one stated absence.
 *
 *   count      `21 rows · 1 parent · 20 variants` (§3.9, verbatim)
 *   views      the ONE views menu — presets `Everything · Inventory · Pricing · Listings` and the
 *              operator's saved views on surface `product-edit:views:matrix`
 *   chips      the five Matrix chips, registered by the surface through `useRegisterViewChip`
 *   Customise  the ONE `PreferencesModal`, opened by the surface
 *   Export     what is on screen (D15.2 key row: `sku` + `<key>.<kind>`)
 *   Import     HELD, with the reason — the toolbar's own `absent` contract renders the sentence as a
 *              disabled overflow item; a bare `disabled` Import button would be a silent hold
 *   ⋯          Reload
 */
import type { MenuItemDef } from '@/design-system/components'
import type { GridStateApi, GridViewPreset, SavedGridView, SheetStatus } from '@/design-system/grid'

import type { ViewChip } from '../types'
import { SheetToolbar, type AbsentControl } from '../sheet/SheetToolbar'

/** The one omission, and its reason — rendered in the DOM by `SheetToolbar`. */
export const MATRIX_IMPORT_HELD: readonly AbsentControl[] = [
  { control: 'import', reason: 'Import lands with the Matrix service' },
]

export interface MatrixPageState { search: string }

export interface MatrixToolbarProps {
  visible: number
  total: number
  selected: number
  hasParent: boolean
  variants: number
  loading: boolean
  unavailable: boolean
  search: string
  onSearch: (v: string) => void
  chips: readonly ViewChip[]
  activeChipId: string | null
  onChipToggle: (id: string | null) => void
  views: GridStateApi<MatrixPageState>
  presets: readonly GridViewPreset[]
  activePresetId: string | null
  onApplyPreset: (preset: GridViewPreset) => void
  onSaveCurrentView: (name: string) => Promise<unknown>
  onUpdateCurrentView: (view: SavedGridView<MatrixPageState>) => Promise<unknown>
  viewsEmptyLabel: string
  onCustomise: () => void
  onExport: () => void
  exportDisabled: boolean
  onReload: () => void
  overflow?: readonly MenuItemDef[]
  status?: readonly SheetStatus[]
}

export function MatrixToolbar(p: MatrixToolbarProps) {
  return (
    <SheetToolbar<MatrixPageState>
      visible={p.visible}
      total={p.total}
      selected={p.selected}
      descriptor={!p.loading && !p.unavailable ? <span className="nds-cell-muted"> · {p.hasParent ? '1 parent' : 'no parent'} · {p.variants} {p.variants === 1 ? 'variant' : 'variants'}</span> : null}
      search={p.search}
      onSearch={p.onSearch}
      views={p.views}
      presets={p.presets}
      activePresetId={p.activePresetId}
      onApplyPreset={p.onApplyPreset}
      onSaveCurrentView={p.onSaveCurrentView}
      onUpdateCurrentView={p.onUpdateCurrentView}
      viewsEmptyLabel={p.viewsEmptyLabel}
      chips={p.chips}
      activeChipId={p.activeChipId}
      onChipToggle={p.onChipToggle}
      onCustomise={p.onCustomise}
      onExport={p.onExport}
      exportPurpose="editing"
      exportDisabled={p.exportDisabled}
      onReload={p.onReload}
      loading={p.loading}
      unavailable={p.unavailable}
      overflow={p.overflow}
      absent={MATRIX_IMPORT_HELD}
      status={p.status}
    />
  )
}
