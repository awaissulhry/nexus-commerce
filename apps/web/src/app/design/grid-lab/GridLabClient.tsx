'use client'

/**
 * AG.2 — the parity lab. Both grid engines, same rows, same columns, side by side.
 *
 * WHY THIS PAGE EXISTS
 * "Looks the same" is not a migration criterion. This page renders the hand-rolled
 * `WorkspaceGrid` and the AG Grid engine from ONE fixture and ONE column array, then MEASURES
 * both off the live DOM. A migration that changes a row height by 4px across 65 ads screens is
 * a visual regression nobody would file and everybody would notice.
 *
 * WHY THE STYLESHEET IMPORTS LOOK ODD
 * `workspace-grid.css` is NOT loaded app-wide — it is imported by `marketing/ads/layout.tsx` and
 * nowhere else, and its own header records that it must load immediately AFTER `ads.css`,
 * verified in that position. The grid also renders inside `.h10-shell`, where several semantic
 * tokens are re-declared. Reproducing the cascade byte-for-byte, in the same order, inside the
 * same shell class, is the difference between a parity lab and a decorative one — get it wrong
 * and the left panel is not the grid operators actually use.
 */

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/app/_shared/shared-shell.css'
import '@/app/marketing/ads/ads.css'
import '@/design-system/styles/workspace-grid.css'

import { useCallback, useState } from 'react'
import { Button, Checkbox, Input } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { WorkspaceGrid, AdsFilterBar } from '@/design-system/patterns/workspace-grid/WorkspaceGrid'
import type { FilterState, GridFilter } from '@/design-system/patterns/workspace-grid/WorkspaceGrid'
import { LabNexusGrid } from './LabNexusGrid'
import { MasterSheet } from '@/app/products/_sheet/MasterSheet'
import { GridModuleCatalog } from './GridModuleCatalog'
import { GdsScenarios } from './GdsScenarios'
import { LAB_COLUMNS, LAB_ROWS, LAB_ROW_ID, type LabRow } from './fixture'
import { GridFeatureLab } from './GridFeatureLab'

const renderFirst = (r: LabRow) => (
  <>
    <span className={r.live ? 'dot live' : 'dot'} />
    <span className="t">{r.name}</span>
  </>
)

const firstSortValue = (r: LabRow) => r.name

/**
 * AG.3 — one filter bar, two engines, ONE state object. That is the whole point: a filter that
 * narrows the left grid and the right grid differently is the migration failing, and it can only
 * be seen if both are driven from the same value.
 *
 * `acos` is `number | null` in the fixture (null = never measured, NOT zero), and the shared
 * pipeline's rule is written in terms of NaN — so the accessor bridges the two deliberately.
 * Set a range and the unmeasured campaigns must leave BOTH grids: a row that has no ACoS has not
 * been measured against the range, and passing it would be the grid inventing a measurement.
 */
const LAB_FILTERS: GridFilter[] = [
  { key: 'acos', label: 'ACoS', kind: 'range', unit: '%', value: (r) => (r as LabRow).acos ?? NaN },
  {
    key: 'kind',
    label: 'Type',
    kind: 'select',
    options: [
      { value: 'SP', label: 'Sponsored Products' },
      { value: 'SB', label: 'Sponsored Brands' },
      { value: 'SD', label: 'Sponsored Display' },
    ],
    value: (r) => (r as LabRow).kind,
  },
]

/**
 * AG.3 — the same edit contract handed to both engines. `render` is the CALLER's, so the control
 * inside the cell is byte-identical in each grid; only the surrounding mechanics differ, which is
 * exactly the surface this lab exists to compare. Type into the left grid and the right one and
 * the input must keep focus in both — the engine reaches cells through context rather than
 * rebuilding its column defs, precisely so a keystroke does not tear the input out from under you.
 */
const LAB_EDIT = {
  label: 'Edit names',
  fields: [
    {
      key: '__first',
      initial: (r: LabRow) => r.name,
      render: (v: string, set: (n: string) => void) => (
        <Input value={v} onChange={(e) => set(e.target.value)} aria-label="Campaign name" />
      ),
    },
  ],
  onApply: async (edits: Array<{ id: string; values: Record<string, string> }>) => {
    // The lab persists nothing — it proves the DIFF, which is the half that can corrupt data.
    // eslint-disable-next-line no-console
    console.log('[grid-lab] onApply', JSON.stringify(edits))
  },
}

/** Bulk actions are a render prop, so the lab proves the slot works without inventing an action. */
const selectionActions = (ids: string[], clear: () => void) => (
  <Button variant="secondary" size="sm" onClick={clear}>
    Clear {ids.length} selected
  </Button>
)

/** One measured surface: what the DOM actually computed, not what the stylesheet intended. */
interface Probe {
  rowHeight: number | null
  headerHeight: number | null
  cellFontSize: string | null
  headerFontSize: string | null
  cellColor: string | null
  rowBorderColor: string | null
}

const EMPTY_PROBE: Probe = {
  rowHeight: null,
  headerHeight: null,
  cellFontSize: null,
  headerFontSize: null,
  cellColor: null,
  rowBorderColor: null,
}

function measure(rowSel: string, cellSel: string, headSel: string): Probe {
  const row = document.querySelector(rowSel)
  const cell = document.querySelector(cellSel)
  const head = document.querySelector(headSel)
  if (!row || !cell || !head) return EMPTY_PROBE
  const cellCs = getComputedStyle(cell)
  const headCs = getComputedStyle(head)
  /**
   * AG.3 — the row rule is read from whichever element actually carries it. The hand-rolled grid
   * puts `border-bottom` on the `td` (`.nds-wsgrid tbody td`); AG Grid's `rowBorder` param lands
   * on `.ag-row`. Reading only the cell reported the AG rule as `rgba(0, 0, 0, 0)` and the parity
   * table called it a difference — a probe artefact presented as a measurement, which is worse
   * than no measurement because someone acts on it.
   */
  const transparent = (c: string) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
  /**
   * Walk cell → row for the first element that actually paints a bottom rule. The hand-rolled
   * grid puts it on the `td`; AG Grid puts it on the cell CONTAINER (`.ag-grid-scrolling-cells`),
   * which is neither the cell nor the row — reading either one alone reported `rgba(0, 0, 0, 0)`
   * and the table called an invisible rule a colour difference.
   */
  const ruleColor = (() => {
    let n: Element | null = cell
    while (n) {
      const c = getComputedStyle(n).borderBottomColor
      if (!transparent(c) && getComputedStyle(n).borderBottomWidth !== '0px') return c
      if (n === row) break
      n = n.parentElement
    }
    return cellCs.borderBottomColor
  })()
  return {
    // getBoundingClientRect, not offsetHeight: subpixel matters here. A 0.024px shortfall has
    // already doubled a row height in this codebase once.
    rowHeight: Math.round(row.getBoundingClientRect().height * 100) / 100,
    headerHeight: Math.round(head.getBoundingClientRect().height * 100) / 100,
    cellFontSize: cellCs.fontSize,
    headerFontSize: headCs.fontSize,
    cellColor: cellCs.color,
    rowBorderColor: ruleColor,
  }
}

export function GridLabClient() {
  const [selLegacy, setSelLegacy] = useState<Set<string>>(new Set())
  const [sideBar, setSideBar] = useState(false)
  const [setFilters, setSetFilters] = useState(false)
  const [probes, setProbes] = useState<{ legacy: Probe; ag: Probe } | null>(null)
  const [fstate, setFstate] = useState<FilterState>({})
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  type LabTab = 'parity' | 'features' | 'gds' | 'sheet' | 'modules'
  // `?tab=gds` opens the GDS scenarios directly — the conformance runner needs a URL, not a click.
  // `?tab=sheet` is the MASTER SHEET on live data (MS.3); it lives here until the Owner decides
  // where it belongs (docs/2026-08-29-master-sheet-design.md §8.3), and moving it is one mount.
  const [tab, setTab] = useState<LabTab>(() => {
    if (typeof window === 'undefined') return 'parity'
    const t = new URLSearchParams(window.location.search).get('tab')
    return t === 'features' || t === 'gds' || t === 'sheet' || t === 'modules' ? t : 'parity'
  })

  const runProbe = useCallback(() => {
    // Measured in a frame of its own, after any pending style/layout work — reading in the same
    // tick as a mutation returns a half-applied cascade.
    requestAnimationFrame(() => {
      setProbes({
        // AG.3 — `:not(.h10-am-total)` is load-bearing. The pinned Total row renders FIRST in
        // tbody, so a bare `tbody tr` returned IT: bold, `--nds-grey-900`, its own height. The
        // table was comparing the legacy TOTAL row against an AG DATA row and reporting the
        // difference as an engine gap. Both sides now measure an ordinary data row.
        legacy: measure(
          '.gl-legacy .nds-wsgrid tbody tr:not(.h10-am-total)',
          '.gl-legacy .nds-wsgrid tbody tr:not(.h10-am-total) td',
          '.gl-legacy .nds-wsgrid thead th',
        ),
        // AG.3 — `.ag-center-cols-container` does not exist in AG Grid 36.1.0; the rows live in
        // `.ag-grid-scrolling-container`. The old selector matched NOTHING, so `measure` hit its
        // `!row` guard and returned EMPTY_PROBE — the parity table has been printing "not found"
        // for every AG value since AG.2, which reads as a measurement rather than a missed one.
        // Measured in the browser, not guessed. `:not(.ag-row-pinned)` keeps the pinned Total row
        // out: it is arithmetic, and its height is not the row height under comparison.
        ag: measure(
          '.gl-ag .ag-row:not(.ag-row-pinned)',
          '.gl-ag .ag-row:not(.ag-row-pinned) .ag-cell',
          '.gl-ag .ag-header-row',
        ),
      })
    })
  }, [])

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--nds-border-subtle)', paddingBottom: 10, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" onClick={() => setTab('parity')}>Engine parity</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('features')}>Enterprise features</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('gds')}>GDS scenarios</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('sheet')}>Master sheet</Button>
          <Button variant="primary" size="sm" onClick={() => setTab('modules')}>Modules</Button>
        </div>
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--nds-border-subtle)', paddingBottom: 10 }}>
          <Button variant="ghost" size="sm" onClick={() => setTab('parity')}>Engine parity</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('features')}>Enterprise features</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('gds')}>GDS scenarios</Button>
          <Button variant="primary" size="sm" onClick={() => setTab('sheet')}>Master sheet</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('modules')}>Modules</Button>
        </div>
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--nds-border-subtle)', paddingBottom: 10 }}>
          <Button variant="ghost" size="sm" onClick={() => setTab('parity')}>Engine parity</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('features')}>Enterprise features</Button>
          <Button variant="primary" size="sm" onClick={() => setTab('gds')}>GDS scenarios</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('sheet')}>Master sheet</Button>
          <Button variant="ghost" size="sm" onClick={() => setTab('modules')}>Modules</Button>
        </div>
        <GdsScenarios />
      </main>
    )
  }

  return (
    <div
      className="h10-shell"
      style={{ display: 'block', height: 'auto', minHeight: '100vh', overflow: 'visible' }}
    >
      <main className="h10-main" style={{ padding: 24, display: 'grid', gap: 20 }}>
        <header style={{ display: 'grid', gap: 6 }}>
          <h1 className="text-3xl font-heading" style={{ margin: 0 }}>Grid parity lab</h1>
          <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>
            One fixture, one column array, two engines. The left panel is the grid operators use
            today; the right is AG Grid Enterprise behind the same props. Sort the <b>ACoS</b> or{' '}
            <b>CTR</b> column in both — the rows with no measurement must sink to the bottom in{' '}
            <i>both</i> directions, which is the contract the hand-rolled grid documents and AG
            Grid&rsquo;s default breaks.
          </p>
        </header>

        {/* A TAB, not a second route — /design is already where this codebase judges a rendering
            decision, and the two labs answer different questions about the same engine. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--nds-border-subtle)', paddingBottom: 10 }}>
          <Button variant={tab === 'parity' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('parity')}>
            Engine parity
          </Button>
          <Button variant={tab === 'features' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('features')}>
            Enterprise features
          </Button>
          {/* never active here — the GDS tab returned above, outside the shell */}
          <Button variant="ghost" size="sm" onClick={() => setTab('gds')}>
            GDS scenarios
          </Button>
        </div>

        {tab === 'features' ? <GridFeatureLab /> : (
          <>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" onClick={runProbe}>
            Measure both
          </Button>
          <Checkbox
            checked={sideBar}
            onChange={(e) => setSideBar(e.target.checked)}
            label={
              <>
                Columns / Filters tool panel{' '}
                <span style={{ color: 'var(--nds-text-2)' }}>(enterprise)</span>
              </>
            }
          />
          <Checkbox
            checked={setFilters}
            onChange={(e) => setSetFilters(e.target.checked)}
            label={
              <>
                Set filters on every column{' '}
                <span style={{ color: 'var(--nds-text-2)' }}>(enterprise)</span>
              </>
            }
          />
        </div>

        {/* Rendered ONCE and handed to both grids with `hideFilterPanel`, the same shape the
            Rules & Automation pages use to show one bar instead of two. */}
        <AdsFilterBar filters={LAB_FILTERS} value={fstate} onChange={setFstate} defaultOpen />

        <p className="text-md" style={{ margin: 0, color: 'var(--nds-text-2)' }}>
          Last row clicked: <b>{lastClicked ?? 'none'}</b> — clicking a checkbox or a button inside
          a row must NOT count, in either grid.
        </p>

        {probes && <ProbeTable legacy={probes.legacy} ag={probes.ag} />}

        <section className="gl-legacy" style={{ display: 'grid', gap: 8 }}>
          <h2 className="text-lg font-heading" style={{ margin: 0 }}>
            Today — hand-rolled <code>WorkspaceGrid</code>
          </h2>
          <WorkspaceGrid<LabRow>
            rows={LAB_ROWS}
            rowId={LAB_ROW_ID}
            noun="campaign"
            firstColLabel="Campaign"
            renderFirst={renderFirst}
            firstSortValue={firstSortValue}
            columns={LAB_COLUMNS}
            selectable
            selected={selLegacy}
            onSelectedChange={setSelLegacy}
            selectionActions={selectionActions}
            onRowClick={(r) => setLastClicked(`${r.name} (WorkspaceGrid)`)}
            editMode={LAB_EDIT}
            filters={LAB_FILTERS}
            filterState={fstate}
            onFilterStateChange={setFstate}
            hideFilterPanel
            showTotal
            customizable={false}
            defaultSort={{ key: 'spend', dir: 'desc' }}
          />
        </section>

        <section className="gl-ag" style={{ display: 'grid', gap: 8 }}>
          <h2 className="text-lg font-heading" style={{ margin: 0 }}>
            AG Grid Enterprise — the DS grid (<code>NexusGrid</code>), same fixture
          </h2>
          <LabNexusGrid
            filters={LAB_FILTERS}
            filterState={fstate}
            onRowClick={(r) => setLastClicked(`${r.name} (AG Grid)`)}
            sideBar={sideBar}
            setFilters={setFilters}
          />
        </section>
          </>
        )}
      </main>
    </div>
  )
}

/** One measured property, as the parity grid renders it. */
interface ProbeRow {
  key: string
  property: string
  legacy: string
  ag: string
  same: boolean
}

const PROBE_FIELDS: Array<[keyof Probe, string]> = [
  ['rowHeight', 'Row height'],
  ['headerHeight', 'Header height'],
  ['cellFontSize', 'Cell font-size'],
  ['headerFontSize', 'Header font-size'],
  ['cellColor', 'Cell colour'],
  ['rowBorderColor', 'Row rule colour'],
]

/** The DS `DataGrid` rather than a hand-rolled HTML table. A lab whose whole argument is that the
 *  design system should own the grid has no business describing itself in a raw table — and the
 *  raw-primitives ratchet holds this file at zero, which is the same point enforced. `numeric`
 *  supplies the tabular figures the old inline `fontVariantNumeric` was reaching for. */
const PROBE_COLUMNS: Array<Column<ProbeRow>> = [
  { key: 'property', label: 'Property', render: (r) => r.property },
  { key: 'legacy', label: 'WorkspaceGrid', render: (r) => r.legacy, numeric: true },
  { key: 'ag', label: 'AG Grid', render: (r) => r.ag, numeric: true },
  { key: 'verdict', label: 'Match', render: (r) => (r.same ? '\u2713 match' : '\u2715 differs') },
]

/**
 * Heights compare with a sub-pixel tolerance; everything else is exact.
 *
 * A `<tr>` height is content-driven and lands on a fraction (45.95px); AG Grid virtualises off a
 * fixed integer row height and cannot be given one. Exact equality is therefore unreachable by
 * construction, and a row that can only ever read "✕ differs" teaches the reader to ignore the
 * table — which is worse than the 0.05px it is reporting. The raw numbers are still printed, so
 * nothing is hidden: a reader sees 45.95 vs 46 and can judge it. Anything at or above half a
 * pixel — including the 6.95px and 9.5px gaps this instrument found once it worked — still fails.
 */
const HEIGHT_FIELDS = new Set<keyof Probe>(['rowHeight', 'headerHeight'])
const probesMatch = (field: keyof Probe, a: Probe[keyof Probe], b: Probe[keyof Probe]) => {
  if (HEIGHT_FIELDS.has(field) && typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 0.5
  }
  return a === b
}

function ProbeTable({ legacy, ag }: { legacy: Probe; ag: Probe }) {
  const rows: ProbeRow[] = PROBE_FIELDS.map(([field, property]) => ({
    key: field,
    property,
    legacy: fmt(legacy[field]),
    ag: fmt(ag[field]),
    same: probesMatch(field, legacy[field], ag[field]),
  }))

  return (
    <div style={{ maxWidth: 720 }}>
      <DataGrid<ProbeRow> columns={PROBE_COLUMNS} rows={rows} rowKey={(r) => r.key} size="sm" />
    </div>
  )
}

const fmt = (v: string | number | null) => (v === null ? 'not found' : typeof v === 'number' ? `${v}px` : v)
