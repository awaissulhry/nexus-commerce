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
import { Button, Checkbox } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/components'
import { WorkspaceGrid } from '@/design-system/patterns/workspace-grid/WorkspaceGrid'
import { AgWorkspaceGrid } from '@/design-system/patterns/workspace-grid/engine/AgWorkspaceGrid'
import { LAB_COLUMNS, LAB_ROWS, LAB_ROW_ID, type LabRow } from './fixture'

const renderFirst = (r: LabRow) => (
  <>
    <span className={r.live ? 'dot live' : 'dot'} />
    <span className="t">{r.name}</span>
  </>
)

const firstSortValue = (r: LabRow) => r.name

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
  return {
    // getBoundingClientRect, not offsetHeight: subpixel matters here. A 0.024px shortfall has
    // already doubled a row height in this codebase once.
    rowHeight: Math.round(row.getBoundingClientRect().height * 100) / 100,
    headerHeight: Math.round(head.getBoundingClientRect().height * 100) / 100,
    cellFontSize: cellCs.fontSize,
    headerFontSize: headCs.fontSize,
    cellColor: cellCs.color,
    rowBorderColor: cellCs.borderBottomColor,
  }
}

export function GridLabClient() {
  const [selLegacy, setSelLegacy] = useState<Set<string>>(new Set())
  const [selAg, setSelAg] = useState<Set<string>>(new Set())
  const [sideBar, setSideBar] = useState(false)
  const [setFilters, setSetFilters] = useState(false)
  const [probes, setProbes] = useState<{ legacy: Probe; ag: Probe } | null>(null)

  const runProbe = useCallback(() => {
    // Measured in a frame of its own, after any pending style/layout work — reading in the same
    // tick as a mutation returns a half-applied cascade.
    requestAnimationFrame(() => {
      setProbes({
        legacy: measure(
          '.gl-legacy .nds-wsgrid tbody tr',
          '.gl-legacy .nds-wsgrid tbody tr td',
          '.gl-legacy .nds-wsgrid thead th',
        ),
        ag: measure('.gl-ag .ag-center-cols-container .ag-row', '.gl-ag .ag-cell', '.gl-ag .ag-header-row'),
      })
    })
  }, [])

  return (
    <div className="h10-shell" style={{ display: 'block', minHeight: '100vh' }}>
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
            showTotal
            customizable={false}
            defaultSort={{ key: 'spend', dir: 'desc' }}
          />
        </section>

        <section className="gl-ag" style={{ display: 'grid', gap: 8 }}>
          <h2 className="text-lg font-heading" style={{ margin: 0 }}>
            AG Grid Enterprise 36.1.0 — same props
          </h2>
          <AgWorkspaceGrid<LabRow>
            rows={LAB_ROWS}
            rowId={LAB_ROW_ID}
            firstColLabel="Campaign"
            renderFirst={renderFirst}
            firstSortValue={firstSortValue}
            columns={LAB_COLUMNS}
            selectable
            selected={selAg}
            onSelectedChange={setSelAg}
            showTotal
            defaultSort={{ key: 'spend', dir: 'desc' }}
            enableSideBar={sideBar}
            enableSetFilters={setFilters}
            height={560}
          />
        </section>
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

function ProbeTable({ legacy, ag }: { legacy: Probe; ag: Probe }) {
  const rows: ProbeRow[] = PROBE_FIELDS.map(([field, property]) => ({
    key: field,
    property,
    legacy: fmt(legacy[field]),
    ag: fmt(ag[field]),
    same: legacy[field] === ag[field],
  }))

  return (
    <div style={{ maxWidth: 720 }}>
      <DataGrid<ProbeRow> columns={PROBE_COLUMNS} rows={rows} rowKey={(r) => r.key} size="sm" />
    </div>
  )
}

const fmt = (v: string | number | null) => (v === null ? 'not found' : typeof v === 'number' ? `${v}px` : v)
