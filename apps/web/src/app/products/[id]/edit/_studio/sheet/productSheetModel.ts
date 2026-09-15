import type { ReactNode } from 'react'
import type { NexusGridProps } from '@/design-system/grid/NexusGrid'
import type { GridSheetStatusProps } from '@/design-system/grid/hosts/GridSheet'
import type { PreferencesModalProps } from '@/design-system/patterns/PreferencesModal'
import type { StudioDockProps } from '../drawer/StudioDock'
import type { SheetRow } from '../drawer/types'
import type { SheetToolbarProps } from './SheetToolbar'
import type { SheetFooterNoteProps } from './SheetFooterNote'
import type { SheetColumnsApi } from './useSheetColumns'

type CommonToolbarProps = 'views' | 'presets' | 'activePresetId' | 'languagesView' | 'onApplyPreset'
  | 'viewsEmptyLabel' | 'onSaveCurrentView' | 'onUpdateCurrentView' | 'describeView'
  | 'chips' | 'activeChipId' | 'onChipToggle'

/** Scope adapters supply data and domain actions; ProductSheetSurface owns the UI. */
export interface ProductSheetModel<Row, Page, DrawerRow extends SheetRow = SheetRow> {
  scope: 'master' | 'channel'
  loading: boolean
  unavailable: boolean
  backendMissing: boolean
  errorLabel: string
  errorMessage?: string | null
  retry: () => void
  columns: SheetColumnsApi<Page>
  toolbar: Omit<SheetToolbarProps<Page>, CommonToolbarProps>
  toolbarExtra?: ReactNode
  status: GridSheetStatusProps
  footerNote: SheetFooterNoteProps
  footerBefore?: ReactNode
  /** Rendered inside the status strip BEFORE the note slot — the channel scope's cross-channel notice sat there. */
  footerLead?: ReactNode
  footerExtra?: ReactNode
  notice?: ReactNode
  grid: Omit<NexusGridProps<Row>, 'fill' | 'rows' | 'treeData' | 'groupHeaderHeight'>
  gridOverlay?: ReactNode
  drawer: StudioDockProps<DrawerRow> | null
  preferences: PreferencesModalProps | null
  before?: ReactNode
  afterGrid?: ReactNode
  beforePreferences?: ReactNode
  afterPreferences?: ReactNode
  after?: ReactNode
}
