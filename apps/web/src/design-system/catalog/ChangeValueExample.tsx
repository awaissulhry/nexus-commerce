'use client'

import { ChangeValue } from '../grid/renderers/ChangeCell'
import type { ChangeLine } from '../grid/renderers/changeValue'

/*
 * 2026-10-05 — approvals grid G1: before → after. Verify: the old value is muted, the new one strong; "→ €44.90" is a
 * new value, "€3 → removed" a removal; a screen reader hears "Price: from €49.90 to €44.90" (one sentence per line,
 * then "and 2 more changes"), never the arrow. The 160 px box shows a compact line ellipsizing with its "+N more"
 * kept whole. Check light and dark, and a 390 px width.
 */
const PRICE: ChangeLine = { label: 'Price', from: '€49.90', to: '€44.90' }
const LINES: ChangeLine[] = [
  PRICE,
  { label: 'Stock', from: '3', to: '5' },
  { label: 'Sale price', from: null, to: '€39.90' },
  { label: 'Handling fee', from: '€3.00', to: null },
  { label: 'Title (IT)', from: 'Giacca Gale nera', to: 'Giacca da moto Gale in pelle nera, protezioni CE livello 2' },
]

const row = { display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 'var(--nds-space-10)', alignItems: 'baseline', fontSize: 'var(--nds-font-size-base)' } as const
const note = { color: 'var(--nds-text-muted)', fontSize: 'var(--nds-font-size-sm)' } as const
const narrow = {
  display: 'flex', alignItems: 'center', width: 160, height: 28, padding: '0 var(--nds-space-10)',
  border: '1px solid var(--nds-border-subtle)', borderRadius: 'var(--nds-radius-sm)', background: 'var(--nds-surface)',
} as const

export function ChangeValueExample() {
  return <section id="change-value-example">
    <h3>Before → after — <code>ChangeValue</code> · <code>changeColumn</code></h3>
    <p>What a request changes. In a grid row it is one line with “+N more” and the full list in the column’s tooltip; in a drawer every line.</p>
    <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)', maxWidth: 640 }}>
      <div role="listitem" style={row}><span style={note}>full · drawer</span><ChangeValue changes={LINES} more={2} /></div>
      <div role="listitem" style={row}><span style={note}>compact · grid row</span><ChangeValue changes={LINES} more={2} compact /></div>
      <div role="listitem" style={row}><span style={note}>compact, no label</span><ChangeValue changes={[PRICE]} compact hideLabels /></div>
      <div role="listitem" style={row}><span style={note}>160 px cell</span><span style={narrow}><ChangeValue changes={LINES.slice(4)} more={1} compact /></span></div>
    </div>
  </section>
}
