'use client'

/**
 * AGL — one scenario = one props set rendered by both engines, side by side. Left legacy, right AG.
 *
 * The `data-parity-*` attributes are the probe's map: a `[data-parity-scenario]` section per scenario,
 * a `[data-parity-side]` box per engine, and `data-parity-pending` on a side whose engine has not
 * landed, so the runner can say "AG side pending" instead of "measured nothing".
 *
 * Both sides sit inside the same `.h10-shell` cascade (the lab's file header explains the stylesheet
 * order); each is a grid-column of the same width, so the only variable is the engine.
 */
import type { ReactNode } from 'react'
import type { ParityKind, Side } from './engines'

export function Pair({ id, kind, title, note, header, legacy, ag, exempt }: {
  id: string
  kind: ParityKind
  title: string
  note?: ReactNode
  /** rendered ONCE above both sides — a shared filter bar, a shared control */
  header?: ReactNode
  legacy: ReactNode
  ag: ReactNode
  /** probe groups this scenario cannot compare by construction (reported, never judged) — read by the runner off the DOM */
  exempt?: string[]
}) {
  return (
    <section data-parity-scenario={id} data-parity-kind={kind} data-parity-exempt={(exempt ?? []).join(' ')} id={`parity-${id}`} style={{ display: 'grid', gap: 10, scrollMarginTop: 16 }}>
      <header style={{ display: 'grid', gap: 4 }}>
        <h2 className="nds-type-lg font-heading" style={{ margin: 0 }}>
          <code className="nds-type-md" style={{ color: 'var(--nds-text-2)', marginRight: 8 }}>{id}</code>{title}
        </h2>
        {note && <p className="nds-type-md" style={{ margin: 0, maxWidth: 1100, color: 'var(--nds-text-2)' }}>{note}</p>}
      </header>
      {header}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <SideBox side="legacy" label="Today — legacy">{legacy}</SideBox>
        <SideBox side="ag" label="AG Grid — same props" pending={ag === null}>{ag}</SideBox>
      </div>
    </section>
  )
}

/**
 * A BLOCK, not a grid. Measured: as a grid container this box let the legacy `.nds-card` (a grid item,
 * `min-width: auto`) grow to its table's min-content — 1627px inside a 742px column — so the left panel
 * spilled under the right one and nothing scrolled. In block layout the card takes the column's width
 * and the `.nds-wsgrid` inside it scrolls, exactly as it does on the console page.
 */
function SideBox({ side, label, pending, children }: { side: Side; label: string; pending?: boolean; children: ReactNode }) {
  return (
    <div data-parity-side={side} {...(pending ? { 'data-parity-pending': '' } : {})} style={{ display: 'block', minWidth: 0 }}>
      <div className="nds-type-sm" style={{ color: 'var(--nds-text-3)', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      {pending ? <PendingBox /> : children}
    </div>
  )
}

/** The AG engine has not landed. Loud, sized like a grid so the page keeps its shape, never mistaken for an empty grid. */
function PendingBox() {
  return (
    <div style={{ border: '1px dashed var(--nds-border)', borderRadius: 12, padding: 28, minHeight: 200, display: 'grid', placeItems: 'center', color: 'var(--nds-text-2)', background: 'var(--nds-surface-sunken)' }}>
      <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
        <b>AG side pending</b>
        <span className="nds-type-sm">The AG-backed component has not landed in <code>design-system/grid</code> yet. The probe reports this side as pending, not as measured.</span>
      </div>
    </div>
  )
}
