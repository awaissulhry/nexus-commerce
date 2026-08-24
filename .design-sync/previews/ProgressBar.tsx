import { ProgressBar } from '@nexus/design-system'

const LEVELS = [
  { label: 'Helmets · Auto', value: 0, right: '€0.00 of €45.00' },
  { label: 'Brand Defense', value: 24, right: '€7.20 of €30.00' },
  { label: 'Gloves · Exact', value: 64, right: '€16.00 of €25.00' },
  { label: 'Jackets · Broad', value: 100, right: '€60.00 of €60.00 — capped' },
] as const

/**
 * `value` is 0–100 and is the whole visual axis. The track is always full width of its
 * parent, so give it a sized container — an unbounded, valueless bar renders as nothing.
 */
export const Levels = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 340, maxWidth: '100%' }}>
    {LEVELS.map((l) => (
      <div key={l.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{l.label}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>{l.value}%</span>
        </div>
        <ProgressBar value={l.value} />
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{l.right}</div>
      </div>
    ))}
  </div>
)

/** `height` sizes the track in px — 4 for a hairline under a row, 7 (default), 12 for a hero. */
export const Heights = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 340, maxWidth: '100%' }}>
    {[4, 7, 12].map((h) => (
      <div key={h} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
          height={h}
          {h === 7 ? ' · default' : ''}
        </div>
        <ProgressBar value={72} height={h} />
      </div>
    ))}
  </div>
)

/** `indeterminate` ignores `value` and sweeps a 35% shuttle — for work with no known total. */
export const Indeterminate = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 340, maxWidth: '100%' }}>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>Polling Amazon for the report…</div>
    <ProgressBar indeterminate />
    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Reports queue serially — this can take a few minutes.</div>
  </div>
)

/** The real composition: a determinate job with its own count line above the track. */
export const BulkPublish = () => (
  <div
    style={{
      width: 360,
      maxWidth: '100%',
      padding: '14px 16px',
      border: '1px solid var(--border-default)',
      borderRadius: 10,
      background: 'var(--surface-card)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Publishing to Amazon DE</span>
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>128 of 200</span>
    </div>
    <ProgressBar value={64} height={10} />
    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>3 rows rejected — no EAN. Review after the run finishes.</div>
  </div>
)
