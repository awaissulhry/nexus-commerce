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
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Grid parity lab</h1>
          <p style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)', fontSize: 13 }}>
            One fixture, one column array, two engines. The left panel is the grid operators use
            today; the right is AG Grid Enterprise behind the same props. Sort the <b>ACoS</b> or{' '}
            <b>CTR</b> column in both — the rows with no measurement must sink to the bottom in{' '}
            <i>both</i> directions, which is the contract the hand-rolled grid documents and AG
            Grid&rsquo;s default breaks.
          </p>
        </header>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="acr-btn" onClick={runProbe}>
            Measure both
          </button>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={sideBar} onChange={(e) => setSideBar(e.target.checked)} />
            Columns / Filters tool panel <span style={{ color: 'var(--nds-text-2)' }}>(enterprise)</span>
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={setFilters} onChange={(e) => setSetFilters(e.target.checked)} />
            Set filters on every column <span style={{ color: 'var(--nds-text-2)' }}>(enterprise)</span>
          </label>
        </div>

        {probes && <ProbeTable legacy={probes.legacy} ag={probes.ag} />}

        <section className="gl-legacy" style={{ display: 'grid', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
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
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
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

function ProbeTable({ legacy, ag }: { legacy: Probe; ag: Probe }) {
  const rows: Array<[string, string, string, boolean]> = [
    ['Row height', fmt(legacy.rowHeight), fmt(ag.rowHeight), legacy.rowHeight === ag.rowHeight],
    ['Header height', fmt(legacy.headerHeight), fmt(ag.headerHeight), legacy.headerHeight === ag.headerHeight],
    ['Cell font-size', fmt(legacy.cellFontSize), fmt(ag.cellFontSize), legacy.cellFontSize === ag.cellFontSize],
    ['Header font-size', fmt(legacy.headerFontSize), fmt(ag.headerFontSize), legacy.headerFontSize === ag.headerFontSize],
    ['Cell colour', fmt(legacy.cellColor), fmt(ag.cellColor), legacy.cellColor === ag.cellColor],
    ['Row rule colour', fmt(legacy.rowBorderColor), fmt(ag.rowBorderColor), legacy.rowBorderColor === ag.rowBorderColor],
  ]

  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 12.5, maxWidth: 720 }}>
      <thead>
        <tr>
          {['Property', 'WorkspaceGrid', 'AG Grid', ''].map((h) => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 12px', borderBottom: '1px solid var(--nds-grey-200)' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b, same]) => (
          <tr key={label}>
            <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--nds-grey-150)' }}>{label}</td>
            <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--nds-grey-150)', fontVariantNumeric: 'tabular-nums' }}>{a}</td>
            <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--nds-grey-150)', fontVariantNumeric: 'tabular-nums' }}>{b}</td>
            <td style={{ padding: '6px 12px', borderBottom: '1px solid var(--nds-grey-150)' }}>
              {same ? '✓ match' : '✕ differs'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const fmt = (v: string | number | null) => (v === null ? 'not found' : typeof v === 'number' ? `${v}px` : v)
