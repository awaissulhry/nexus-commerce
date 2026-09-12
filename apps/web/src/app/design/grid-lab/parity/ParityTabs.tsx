'use client'

/**
 * AGL — the two parity tabs: `?tab=workspace` and `?tab=datagrid`. Each mounts its scenarios and exposes
 * the probe on `window.__parityProbe` for `scripts/check-workspace-parity.mjs` (and for a person in the
 * console). Rendered inside the lab's `.h10-shell` cascade by GridLabClient.tsx — the same stylesheet
 * order and token scope the ads console gives its grids.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { Listbox } from '@/design-system/components'
import type { ParityEngines, ParityKind } from './engines'
import { WorkspaceScenarios, WS_SCENARIOS } from './workspaceScenarios'
import { DataGridScenarios, DG_SCENARIOS } from './datagridScenarios'
import { makeProbe, type ProbeResult } from './probe'

function useProbeExposure() {
  useEffect(() => {
    /* Dev only, in the BLOCK form `check-global-exposure` recognises (the sibling of `__gdsProbe` in
       GdsScenarios.tsx). The runner needs it on a dev server, which is the only place it must exist. */
    if (process.env.NODE_ENV !== 'production') {
      window.__parityProbe = makeProbe()
      return () => { delete window.__parityProbe }
    }
  }, [])
}

function MeasureBar({ kind, count, pending }: { kind: ParityKind; count: number; pending: boolean }) {
  const [out, setOut] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const r: ProbeResult = await makeProbe()()
      setOut(JSON.stringify(r, null, 1))
    } finally { setBusy(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" onClick={run} disabled={busy}>{busy ? 'Measuring…' : 'Measure every scenario'}</Button>
        <span className="nds-type-sm" style={{ color: 'var(--nds-text-2)' }}>
          {count} scenarios · <code>window.__parityProbe()</code> returns what both sides computed · <code>npm run grid:parity</code> prints the table.
          {pending && <> · <b style={{ color: 'var(--nds-warning-strong)' }}>AG side pending</b> — <code>design-system/grid/{kind}</code> has not landed.</>}
        </span>
      </div>
      {out && <pre className="nds-type-xs" style={{ margin: 0, maxHeight: 280, overflow: 'auto', background: 'var(--nds-surface-sunken)', padding: 10, borderRadius: 8 }}>{out}</pre>}
    </div>
  )
}

function ScenarioPicker({ ids, value, onChange }: { ids: string[]; value: string; onChange: (value: string) => void }) {
  return <Listbox ariaLabel="Comparison scenario" width={300} value={value} onChange={onChange} options={[
    { value: 'all', label: 'All scenarios' }, ...ids.map((id) => ({ value: id, label: id })),
  ]} />
}

export function WorkspaceParityTab({ engines, initialScenario = 'all' }: { engines: ParityEngines; initialScenario?: string }) {
  const [scenario, setScenario] = useState(WS_SCENARIOS.some((s) => s.id === initialScenario) || initialScenario === 'controlled-filters' ? initialScenario : 'all')
  useProbeExposure()
  return (
    <div style={{ display: 'grid', gap: 28 }}>
      <MeasureBar kind="workspace" count={scenario === 'all' ? WS_SCENARIOS.length + 1 : 1} pending={!engines.agWorkspace} />
      <ScenarioPicker ids={[...WS_SCENARIOS.map((s) => s.id), 'controlled-filters']} value={scenario} onChange={setScenario} />
      <WorkspaceScenarios engines={engines} scenario={scenario} />
    </div>
  )
}

export function DataGridParityTab({ engines, initialScenario = 'all' }: { engines: ParityEngines; initialScenario?: string }) {
  const [scenario, setScenario] = useState(DG_SCENARIOS.some((s) => s.id === initialScenario) ? initialScenario : 'all')
  useProbeExposure()
  return (
    <div style={{ display: 'grid', gap: 28 }}>
      <MeasureBar kind="datagrid" count={scenario === 'all' ? DG_SCENARIOS.length : 1} pending={!engines.agDataGrid} />
      <ScenarioPicker ids={DG_SCENARIOS.map((s) => s.id)} value={scenario} onChange={setScenario} />
      <DataGridScenarios engines={engines} scenario={scenario} />
    </div>
  )
}
