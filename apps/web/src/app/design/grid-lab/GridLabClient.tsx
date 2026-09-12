'use client'

/**
 * AG.2 → AGL — the parity lab. Both grid engines, same rows, same columns, side by side.
 *
 * WHY THIS PAGE EXISTS
 * "Looks the same" is not a migration criterion. This page renders the hand-rolled `WorkspaceGrid` /
 * DS `DataGrid` and the AG-backed components behind the IDENTICAL props from ONE fixture and ONE column
 * array, then MEASURES both off the live DOM (`window.__parityProbe()`, `npm run grid:parity`). A
 * migration that changes a row height by 4px across 65 ads screens is a visual regression nobody would
 * file and everybody would notice.
 *
 * WHY THE STYLESHEET IMPORTS LOOK ODD
 * The frozen `legacy/workspace-grid.css` loads only in this comparison lab, immediately AFTER `ads.css`,
 * verified in that position. The grid also renders inside `.h10-shell`, where several semantic
 * tokens are re-declared. Reproducing the cascade byte-for-byte, in the same order, inside the
 * same shell class, is the difference between a parity lab and a decorative one — get it wrong
 * and the left panel is not the grid operators actually use.
 *
 * WHY THE ENGINES ARE BUILT HERE AND HANDED DOWN
 * This is the ONE file that names a grid component. The scenario modules under ./parity take both
 * engines as a prop (see ./parity/engines.ts): re-pointing the legacy side at the frozen copy the
 * design keeps for the end of the programme (§2.18) is the two imports below, and the grid-kit
 * ratchet keeps counting the lab once rather than once per scenario file.
 */

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/app/_shared/shared-shell.css'
import '@/app/marketing/ads/ads.css'
import './legacy/workspace-grid.css'

import { useCallback, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { DataGrid } from '@/design-system/components'
// The legacy engine is the FROZEN copy (design §2.18): `patterns/workspace-grid/WorkspaceGrid` now
// re-exports the AG engine, so importing it there would put AG on both sides and prove nothing.
import { LegacyWorkspaceGrid } from './legacy/LegacyWorkspaceGrid.stories'
import { WorkspaceGrid as AgWorkspaceGrid } from '@/design-system/grid/workspace'
import { DataGrid as AgDataGrid } from '@/design-system/grid/datagrid'
import { MasterSheet } from '@/app/products/_sheet/MasterSheet'
import { GridModuleCatalog } from './GridModuleCatalog'
import { GdsScenarios } from './GdsScenarios'
import { GridFeatureLab } from './GridFeatureLab'
import { DataGridParityTab, WorkspaceParityTab } from './parity/ParityTabs'
import type { ParityEngines } from './parity/engines'

/**
 * The engine pair per contract. The AG-backed components are lanes AGW (`grid/workspace`) and AGD
 * (`grid/datagrid`); until each lands its slot is `null` and the tab renders the legacy side beside a
 * labelled placeholder — the probe reports that side as pending, never as measured-empty. Both landed
 * (workspace 17:30, datagrid 2026-09-06).
 */
const ENGINES: ParityEngines = {
  legacyWorkspace: LegacyWorkspaceGrid,
  agWorkspace: AgWorkspaceGrid,
  legacyDataGrid: DataGrid,
  agDataGrid: AgDataGrid,
}

type LabTab = 'workspace' | 'datagrid' | 'features' | 'gds' | 'sheet' | 'modules'
const TABS: ReadonlyArray<readonly [LabTab, string]> = [
  ['workspace', 'Workspace parity'],
  ['datagrid', 'DataGrid parity'],
  ['features', 'Enterprise features'],
  ['gds', 'GDS scenarios'],
  ['sheet', 'Master sheet'],
  ['modules', 'Modules'],
]
const isTab = (t: string | null): t is LabTab => TABS.some(([id]) => id === t)

/** ONE tab strip for every branch below — the earlier copy per branch drifted the moment a tab was added. */
function TabBar({ tab, onTab }: { tab: LabTab; onTab: (t: LabTab) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--nds-border-subtle)', paddingBottom: 10, flexWrap: 'wrap' }}>
      {TABS.map(([id, label]) => (
        <Button key={id} variant={tab === id ? 'primary' : 'ghost'} size="sm" onClick={() => onTab(id)}>{label}</Button>
      ))}
    </div>
  )
}

export function GridLabClient({ initialScenario = 'all', initialTab }: { initialScenario?: string; initialTab?: string }) {
  // `?tab=` opens a tab directly — the conformance and parity runners need a URL, not a click.
  // `?tab=sheet` is the MASTER SHEET on live data (MS.3); it lives here until the Owner decides
  // where it belongs (docs/2026-08-29-master-sheet-design.md §8.3), and moving it is one mount.
  // `?tab=parity` (the AG.2 spike's name) still lands on the workspace parity.
  const [tab, setTabState] = useState<LabTab>(isTab(initialTab ?? null) ? initialTab as LabTab : 'workspace')

  const setTab = useCallback((t: LabTab) => {
    setTabState(t)
    // Keep the address shareable. A fresh `{}` state, never `window.history.state` (a state carrying
    // Next's marker makes the router skip its apply — memory: reference_next_query_cursor).
    try { window.history.replaceState({}, '', `?tab=${t}`) } catch { /* ignore */ }
  }, [])

  if (tab === 'modules') {
    return (
      <main style={{ padding: 24, display: 'grid', gap: 18, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Grid modules — what we use, and what we hold</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 940, color: 'var(--nds-text-2)' }}>
            AG Grid Enterprise 36.1.0 ships <b>40</b> modules. We register <b>9</b>. The other <b>31</b>{' '}are capability we
            already hold and have never switched on. Every feature name below is AG Grid&rsquo;s own; the italic line is what it would
            mean on our surfaces. Where seeing it is what decides it, <b>See it</b> opens a live grid with that module actually on.
          </p>
        </header>
        <TabBar tab={tab} onTab={setTab} />
        <GridModuleCatalog />
      </main>
    )
  }

  if (tab === 'sheet') {
    return (
      <main style={{ padding: 24, display: 'grid', gap: 16, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>The master sheet — live</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
            Real products, real channel readiness, real writes. One market at a time; every edit autosaves on its own
            and paints the server's answer on that cell. <code>docs/2026-08-29-master-sheet-design.md</code>.
          </p>
        </header>
        <TabBar tab={tab} onTab={setTab} />
        <MasterSheet market="IT" height={720} />
      </main>
    )
  }

  if (tab === 'gds') {
    return (
      <main style={{ padding: 24, display: 'grid', gap: 20, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Grid design system — scenarios</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
            Every scenario the GDS spec names, from frozen fixtures, rendered OUTSIDE the console shell so light and
            dark can both be measured. <code>design-system/docs/GRID.md</code> is written from these numbers.
          </p>
        </header>
        <TabBar tab={tab} onTab={setTab} />
        <GdsScenarios />
      </main>
    )
  }

  /**
   * `.h10-shell` is worn here for its CASCADE, not its layout: the grid has to sit inside the same
   * token scope the ads console gives it (see the file header). But the class is an APP SHELL —
   * `height: 100dvh; overflow: hidden`, with `.h10-main` as the inner scroller — and this page is a
   * long document, not a fixed-viewport console. `display: block` had already taken `.h10-main`
   * out of the flex column that made it scroll.
   *
   * Measured, not guessed: the shell sat at 962px holding 1958px of content with overflow hidden —
   * about 1000px clipped, no scrollbar, wheel dead. It hid from me because `overflow: hidden` still
   * permits PROGRAMMATIC scrolling, so every `scrollIntoView` I used to verify a section worked
   * while a person could not reach it at all.
   *
   * `height: auto` + `overflow: visible` hands scrolling back to the app's own #main-content.
   */
  return (
    <div
      className="h10-shell"
      style={{ display: 'block', height: 'auto', minHeight: '100vh', overflow: 'visible' }}
    >
      <main className="h10-main" style={{ padding: 24, display: 'grid', gap: 20 }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0 }}>
            {tab === 'workspace' ? 'Workspace grid parity' : tab === 'datagrid' ? 'DataGrid parity' : 'Grid feature lab'}
          </h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 1000, color: 'var(--nds-text-2)' }}>
            {tab === 'features' ? (
              <>Every enterprise feature, on the DS grid, from a frozen fixture.</>
            ) : (
              <>
                One fixture, one column array, two engines. The left panel is the grid operators use today; the right is
                AG Grid Enterprise behind the same props. Every scenario is one props set of the{' '}
                <code>{tab === 'workspace' ? 'WorkspaceGridProps' : 'DataGridProps'}</code> contract; the probe measures
                both sides off the live DOM and the runner judges them — headers excepted, by the Owner&rsquo;s exemption.
              </>
            )}
          </p>
        </header>

        <TabBar tab={tab} onTab={setTab} />

        {tab === 'features' ? <GridFeatureLab /> : tab === 'datagrid' ? <DataGridParityTab engines={ENGINES} initialScenario={initialScenario} /> : <WorkspaceParityTab engines={ENGINES} initialScenario={initialScenario} />}
      </main>
    </div>
  )
}
