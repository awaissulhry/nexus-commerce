import { useState } from 'react'
import { Checkbox } from '@nexus/design-system'

/** Checked, unchecked and `disabled` — the label is a prop, not a child. */
export const States = () => {
  const [enabled, setEnabled] = useState(true)
  const [paused, setPaused] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      <Checkbox label="Paused" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
      <Checkbox label="Archived" checked={false} disabled readOnly />
      <Checkbox label="Locked by Seller Central" checked disabled readOnly />
    </div>
  )
}

const MARKETS = [
  { code: 'de', label: 'Amazon.de — Germany' },
  { code: 'it', label: 'Amazon.it — Italy' },
  { code: 'fr', label: 'Amazon.fr — France' },
  { code: 'es', label: 'Amazon.es — Spain' },
  { code: 'nl', label: 'Amazon.nl — Netherlands' },
]

/** A stacked multi-select group with a caption and a summary line — the panel idiom. */
export const MarketplaceGroup = () => {
  const [picked, setPicked] = useState<string[]>(['de', 'it', 'fr'])
  const toggle = (code: string) =>
    setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Publish to marketplaces</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {MARKETS.map((m) => (
          <Checkbox
            key={m.code}
            label={m.label}
            checked={picked.includes(m.code)}
            onChange={() => toggle(m.code)}
          />
        ))}
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {picked.length} of {MARKETS.length} selected — EU quantity is shared across all of them.
      </span>
    </div>
  )
}

/** A rich label: any node works, so a row can carry a trailing count or hint. */
export const RichLabels = () => {
  const [only, setOnly] = useState(true)
  const [halo, setHalo] = useState(false)
  const hint = { fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 400 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, maxWidth: 380 }}>
      <Checkbox
        checked={only}
        onChange={(e) => setOnly(e.target.checked)}
        label={
          <span>
            Same-SKU sales only <span style={hint}>· excludes halo attribution</span>
          </span>
        }
      />
      <Checkbox
        checked={halo}
        onChange={(e) => setHalo(e.target.checked)}
        label={
          <span>
            Include 14-day attribution <span style={hint}>· 41 campaigns affected</span>
          </span>
        }
      />
    </div>
  )
}
