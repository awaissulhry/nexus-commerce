'use client'

/**
 * /design/grid-lab — the grid engine's lab: every tab draws the CURRENT engines from frozen fixtures (or, `?tab=sheet`,
 * live data), outside the console shell so light and dark can both be measured.
 *
 * The parity tabs that drew the hand-rolled WorkspaceGrid and the HTML-table DataGrid beside their AG successors are
 * gone (grid audit wave 4, 2026-10-13): no page renders the old engines any more, so there is nothing left to compare.
 */

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

import { useCallback, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { MasterSheet } from '@/app/products/_sheet/MasterSheet'
import { GridModuleCatalog } from './GridModuleCatalog'
import { GdsScenarios } from './GdsScenarios'
import { MatrixScenario } from './MatrixScenario'
import { PublishReviewScenario } from './PublishReviewScenario'
import { GridFeatureLab } from './GridFeatureLab'

type LabTab = 'gds' | 'features' | 'sheet' | 'matrix' | 'publish' | 'modules'
const TABS: ReadonlyArray<readonly [LabTab, string]> = [
  ['gds', 'GDS scenarios'],
  ['features', 'Enterprise features'],
  ['sheet', 'Master sheet'],
  ['matrix', 'Matrix cells'],
  ['publish', 'Publish review'],
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

export function GridLabClient({ initialTab }: { initialTab?: string }) {
  // `?tab=` opens a tab directly — the conformance runner (`scripts/check-grid-chrome.mjs`) needs a URL, not a click.
  // `?tab=sheet` is the MASTER SHEET on live data (MS.3); it lives here until the Owner decides
  // where it belongs (docs/2026-08-29-master-sheet-design.md §8.3), and moving it is one mount.
  // An unknown tab (the retired `workspace`, `datagrid`, `parity`) lands on the GDS scenarios.
  const [tab, setTabState] = useState<LabTab>(isTab(initialTab ?? null) ? initialTab as LabTab : 'gds')

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

  /* MX.G — `?tab=matrix`: the eight Matrix cell kinds in every §3.4 state, from the page's own
     preview fixture, outside the shell so both themes can be measured. */
  if (tab === 'matrix') {
    return (
      <main style={{ padding: 24, display: 'grid', gap: 20, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Matrix cells — the eight kinds, every state</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
            The engine&rsquo;s Matrix cell kinds (<code>design-system/grid/matrix</code>) on a six-row fixture, with the real write
            path into the page&rsquo;s in-memory store. <code>docs/2026-09-13-matrix-page-design.md</code> §3.4.
          </p>
        </header>
        <TabBar tab={tab} onTab={setTab} />
        <MatrixScenario />
      </main>
    )
  }

  /* Grid audit wave 3 — `?tab=publish`: the Publish review's one table inside the Publish window's surface, from a fixture
     (a local box cannot read the channels, so the window's own review cannot be opened here). */
  if (tab === 'publish') {
    return (
      <main style={{ padding: 24, display: 'grid', gap: 20, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Publish review — one row per change</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
            The Publish window&rsquo;s table on a GALE family across three Amazon markets: problems first, each product with its
            fields (Channel now → Nexus sends), what a Full update removes, a Delete, a market that could not be read.
          </p>
        </header>
        <TabBar tab={tab} onTab={setTab} />
        <PublishReviewScenario />
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

  return (
    <main style={{ padding: 24, display: 'grid', gap: 20, background: 'var(--nds-bg)', minHeight: '100vh', alignContent: 'start' }}>
      <header style={{ display: 'grid', gap: 6 }}>
        <h1 className="text-3xl font-heading" style={{ margin: 0, color: 'var(--nds-text)' }}>Grid feature lab</h1>
        <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
          Every enterprise feature, on the DS grid, from a frozen fixture.
        </p>
      </header>
      <TabBar tab={tab} onTab={setTab} />
      <GridFeatureLab />
    </main>
  )
}
