import { Button, Card, Pill, Tag } from '@nexus/design-system'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

const KPI = [
  { label: 'Spend', value: '€1,284.60' },
  { label: 'Ad sales', value: '€5,912.30' },
  { label: 'ACOS', value: '21.7%' },
  { label: 'Orders', value: '318' },
] as const

const LISTINGS = [
  { asin: 'B0C7K2QM4L', title: 'RS9 Race Helmet · Matte Black · M', state: 'Active', tone: 'success' },
  { asin: 'B09XYT3RVP', title: 'TR4 Touring Glove · Brown · 9', state: 'Active', tone: 'success' },
  { asin: 'B0BF5NQ8ZD', title: 'AX2 Textile Jacket · Grey · XL', state: 'Suppressed', tone: 'danger' },
] as const

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
      {label}
    </div>
    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{value}</div>
  </div>
)

/** The plain surface: `padded` gives the body its inset, nothing else. */
export const Padded = () => (
  <Card padded>
    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Helmets · Auto</div>
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
      Sponsored Products · Amazon DE · daily budget €45.00
    </div>
    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
      <Pill tone="success">Active</Pill>
      <Tag tone="info">Amazon DE</Tag>
      <Tag>Auto targeting</Tag>
    </div>
  </Card>
)

/** `elevated` adds the resting shadow — for a card that floats over the page background. */
export const Elevated = () => (
  <Card padded elevated>
    <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
      {KPI.map((k) => (
        <Metric key={k.label} label={k.label} value={k.value} />
      ))}
    </div>
  </Card>
)

/** `header` swaps in a bordered head row; `headerAction` is its right-aligned slot. */
export const WithHeader = () => (
  <Card header="Budget utilisation · last 7 days" headerAction={<Button size="sm">Export</Button>}>
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      6 of 14 campaigns hit their daily cap before 18:00 CET. Raising the cap on <b>Brand Defense</b> and{' '}
      <b>Helmets · Auto</b> would have released an estimated <b>€212</b> of demand.
    </div>
  </Card>
)

/** Bare `<Card>` — no `padded`, no `header`. The body runs edge to edge, so rows own their gutters. */
export const Flush = () => (
  <Card>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '11px 16px',
        borderBottom: '1px solid var(--border-default)',
        fontSize: 12,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-tertiary)',
      }}
    >
      Listings needing attention
    </div>
    {LISTINGS.map((l, i) => (
      <div
        key={l.asin}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 16px',
          borderBottom: i === LISTINGS.length - 1 ? 'none' : '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{l.title}</div>
          <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{l.asin}</div>
        </div>
        <Pill tone={l.tone}>{l.state}</Pill>
      </div>
    ))}
  </Card>
)
