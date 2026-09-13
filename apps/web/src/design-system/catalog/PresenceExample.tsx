'use client'

import { useState } from 'react'
import { AsOf, Disclosure, Menu, PresenceMark, SummaryTable, ToastProvider, useActionConfirm } from '../components'
import { Button, Pill } from '../primitives'
import { CellSaveMark } from '../grid/renderers/CellSaveMark'
import { ProvenanceMark } from '../grid/renderers/provenanceMark'
import { PRESENCE_INTENTS, type Presence } from '../grid/renderers/presence'
import { SheetStatuses } from '../grid/toolbars/SheetStatus'
import { GridViewsMenu, type GridViewsMenuProps } from '../grid/toolbars/GridViewsMenu'
import { AxesPanel } from '../grid/editors/AxesPanelEditor'
import type { VariationThemeCell } from '../grid/renderers/variationTheme'
import { GALE_AMAZON_DE_DERIVED, GALE_SHOPIFY_DROPPED } from '../../../../../docs/fixtures/vt1/fixtures'

/** Local demonstrations only: interactions update this catalog's React state and make no requests. */
export function PresenceExample() {
  return <ToastProvider><PresenceControls /></ToastProvider>
}

function PresenceControls() {
  const [result, setResult] = useState('No action taken')
  const [axes, setAxes] = useState<VariationThemeCell>(GALE_SHOPIFY_DROPPED)
  const confirm = useActionConfirm()
  const p: Presence = { intent: 'LIVE', intentAt: '2026-09-13T12:00:00Z', fact: 'SELLING', observedAt: '2026-09-13T12:01:00Z', now: Date.parse('2026-09-13T12:02:00Z'), freshnessMs: 300000, inFlight: false }
  const views: GridViewsMenuProps<unknown>['views'] = {
    views: [], activeId: null,
    save: async name => { setResult(`View saved: ${name}`); return 'catalog-view' },
    apply: () => {}, remove: async () => {}, rename: async () => {},
    duplicate: async () => 'catalog-copy', setDefault: async () => {}, clearDefault: async () => {},
  }
  return <section data-testid="presence-catalog" style={{ display: 'grid', gap: 'var(--nds-space-14)', marginBlock: 'var(--nds-space-18)' }}>
    <h3>Presence and consequences</h3>
    <p>Intent is a Tag; channel observation is a Pill with an as-of. A recorded reference does not verify selling.</p>
    {PRESENCE_INTENTS.map(intent => <PresenceMark key={intent} presence={{ ...p, intent, fact: 'UNKNOWN', observedAt: null }} />)}
    <PresenceMark presence={p} via="Channel read" />
    <div>Compact intent: <PresenceMark presence={p} axis="intent" compact /> · Compact observation: <PresenceMark presence={p} axis="fact" compact /></div>
    <PresenceMark presence={{ ...p, fact: 'SUPPRESSED' }} via="Channel read" />
    <PresenceMark presence={{ ...p, now: p.now + 600000 }} via="Earlier channel read" />
    <div>Absent check: <AsOf at={null} /> · Absent event: <AsOf at={null} kind="event" /></div>
    <div>Save states: <CellSaveMark state="saving" /> <CellSaveMark state="waiting" /> <CellSaveMark state="unknown" /></div>
    <div>Value provenance: {(['outdated','inherited','inheritedOverride','pinned','mapped','mappedShared','ai','aiStale','formula','refused'] as const).map(provenance => <ProvenanceMark key={provenance} provenance={provenance} />)}</div>
    <SheetStatuses status={[{ tone: 'neutral', label: 'Read only', detail: 'Choose a coordinate first.' }, { tone: 'warning', label: 'Pending write' }, { tone: 'info', label: 'Checking' }, { tone: 'danger', label: 'Read failed', detail: 'Try again.' }]} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
      <Menu label="Presence actions" selectedId="reset" items={[
        { id: 'inspect', label: 'Inspect', onSelect: () => setResult('Inspected') },
        { id: 'held', label: 'Remove listing', tone: 'danger', disabled: true, title: 'Wait for the pending write to finish.', description: 'Wait for the pending write to finish.', onSelect: () => setResult('ERROR: held action ran') },
        { id: 'reset', label: 'Reset demo', tone: 'danger', onSelect: () => setResult('No action taken') },
        { id: 'separator', separator: true },
        { id: 'check', label: 'Check status', onSelect: () => setResult('Status checked in this demonstration') },
      ]} />
      <Button variant="primary" onClick={() => setResult('Primary clicked')}>Primary focus</Button>
      <Button variant="danger" onClick={async () => setResult(await confirm.ask({
        level: 'type-to-confirm', title: 'Remove CATALOG-1?', reach: 'local-destructive',
        subject: { kind: 'sku', value: 'CATALOG-1' }, confirmPhrase: 'CATALOG-1',
        reversal: { verb: 'None', fidelity: 'none' }, acknowledge: 'I accept the loss shown above.',
        consequences: ['The demonstration record would be removed.'], sideEffects: ['No channel is contacted.'],
        findings: [{ severity: 'unknown', blocking: false, label: 'Advertising history', asOf: null }],
        review: { title: 'Captured plan', rows: [{ label: 'Record', before: 'Present', after: 'Removed' }] },
      }) ? 'Confirmed in the demonstration' : 'Cancelled')}>Review removal</Button>
      <GridViewsMenu views={views} />
    </div>
    <Disclosure summary="Held and editable axes">
      <p>Theme-controlled inclusion stays keyboard reachable; changing an editable axis updates only this demonstration.</p>
      <div data-testid="held-axes"><AxesPanel cell={GALE_AMAZON_DE_DERIVED} host="cell" onChange={() => setResult('ERROR: held checkbox changed')} /></div>
      <div data-testid="editable-axes"><AxesPanel cell={axes} host="cell" onChange={next => { setAxes(next); setResult('Editable axis changed') }} /></div>
    </Disclosure>
    <Disclosure tone="warning" summary="Warning disclosure" open>There is a consequence to review.</Disclosure>
    <Disclosure tone="danger" summary="Danger disclosure">This consequence is irreversible.</Disclosure>
    <SummaryTable label="Row tone belongs to a Pill" columns={['Check', 'Result']} rows={[{ id: 'order', cells: ['Open orders', <Pill key="result" tone="warning">Not checked</Pill>] }]} />
    <output data-testid="presence-result">{result}</output>
    {confirm.element}
  </section>
}
