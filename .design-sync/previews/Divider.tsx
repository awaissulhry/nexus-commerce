import { Divider, Pill } from '@nexus/design-system'

const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-tertiary)',
  marginBottom: 6,
}

const line: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 13,
  color: 'var(--text-secondary)',
  padding: '3px 0',
}

const METRICS = [
  { label: 'Spend', value: '€2,340' },
  { label: 'Sales', value: '€13,260' },
  { label: 'ACOS', value: '17.6%' },
]

/** Horizontal is the default: a hairline that separates two blocks inside one panel. */
export const BetweenSections = () => (
  <div style={{ maxWidth: 320 }}>
    <div style={eyebrow}>Campaign</div>
    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
      Helmets · Auto
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <Pill tone="success">Active</Pill>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Amazon DE · Sponsored Products</span>
    </div>

    <Divider />

    <div style={{ marginTop: 14 }}>
      <div style={eyebrow}>Last 7 days</div>
      {METRICS.map((m) => (
        <div key={m.label} style={line}>
          <span>{m.label}</span>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.value}</span>
        </div>
      ))}
    </div>
  </div>
)

/** `orientation="vertical"` stretches to the row's height — the separator between metric-strip cells. */
export const VerticalInMetricStrip = () => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'stretch',
      gap: 18,
      padding: '12px 16px',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--h10-radius-lg)',
    }}
  >
    {METRICS.map((m, i) => (
      <span key={m.label} style={{ display: 'inline-flex', alignItems: 'stretch', gap: 18 }}>
        {i > 0 && <Divider orientation="vertical" />}
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
          <span style={eyebrow}>{m.label}</span>
          <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{m.value}</span>
        </span>
      </span>
    ))}
  </div>
)
