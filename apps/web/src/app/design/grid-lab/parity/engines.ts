/**
 * AGL — the two engines behind each contract, handed to the scenarios as ONE object.
 *
 * WHY THE COMPONENTS ARRIVE AS PROPS
 * The scenario modules never import a grid. `GridLabClient.tsx` is the one file that names the legacy
 * `WorkspaceGrid` / `DataGrid` and the AG-backed pair, and builds this object. Two reasons:
 *
 * 1. Design §2.18 — at the end of the programme the legacy components are removed from the design
 *    system and a frozen copy lives under `app/design/grid-lab/legacy/`. Re-pointing the lab is then
 *    the two imports in GridLabClient.tsx, not a hunt through every scenario.
 * 2. `scripts/check-grid-kit-ratchet.mjs` counts the FILES that import a retiring kit and fails when
 *    the count rises. The lab already counts once (GridLabClient.tsx); a scenario file importing the
 *    legacy grid directly would read as a new page built on it.
 *
 * `null` for an engine means "not landed yet" — the tab renders the legacy side and a labelled
 * placeholder, and the probe reports the AG side as pending rather than measured-empty.
 */
import type { ComponentType } from 'react'
import type { GridPrefs, WorkspaceGridProps } from '@/design-system/patterns'
import type { DataGridProps } from '@/design-system/components'
import type { ParityRow } from './fixture'

/** Design §5/§7 — the three ADDITIVE props the AG-backed WorkspaceGrid gains. Never passed to the legacy side. */
export interface AgWorkspaceExtras {
  chromeless?: boolean
  prefs?: GridPrefs
  onPrefsChange?: (next: GridPrefs) => void
  rowHeight?: number
}

export type WorkspaceEngine = ComponentType<WorkspaceGridProps<ParityRow> & AgWorkspaceExtras>
export type DataGridEngine = ComponentType<DataGridProps<ParityRow>>

export interface ParityEngines {
  legacyWorkspace: WorkspaceEngine | null
  agWorkspace: WorkspaceEngine | null
  legacyDataGrid: DataGridEngine | null
  agDataGrid: DataGridEngine | null
}

export type Side = 'legacy' | 'ag'
export type ParityKind = 'workspace' | 'datagrid'
