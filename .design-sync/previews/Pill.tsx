import { Pill } from '@nexus/design-system'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
)

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 0',
  borderBottom: '1px solid var(--border-subtle)',
  fontSize: 13,
}

const CAMPAIGNS = [
  { name: 'Helmets · Auto', state: 'Active', tone: 'success' },
  { name: 'Brand Defense', state: 'Active', tone: 'success' },
  { name: 'Retargeting · DE', state: 'Out of budget', tone: 'warning' },
  { name: 'Gloves · Manual', state: 'Archived', tone: 'neutral' },
] as const

const CHANNELS = [
  { name: 'Amazon DE', state: 'Synced', tone: 'success', note: '2 min ago' },
  { name: 'Amazon IT', state: 'Scheduled', tone: 'info', note: 'next run 04:00' },
  { name: 'eBay UK', state: 'Retrying', tone: 'warning', note: '3 of 5 attempts' },
  { name: 'Shopify', state: 'Token expired', tone: 'danger', note: 'reconnect required' },
] as const

/** The tone axis, labelled the way the prop doc maps it: Active→success · Paused→warning · Archived→neutral · Error→danger. */
export const Tones = () => (
  <Row>
    <Pill tone="success">Active</Pill>
    <Pill tone="warning">Paused</Pill>
    <Pill tone="neutral">Archived</Pill>
    <Pill tone="danger">Error</Pill>
    <Pill tone="info">Scheduled</Pill>
  </Row>
)

/** The canonical use: entity state at the end of a campaign row, never a bare colour swatch. */
export const InCampaignRows = () => (
  <div>
    {CAMPAIGNS.map((c) => (
      <div key={c.name} style={rowStyle}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span>
        <Pill tone={c.tone}>{c.state}</Pill>
      </div>
    ))}
  </div>
)

/** Pill also carries connection health per marketplace — the same five tones, a different noun. */
export const ChannelHealth = () => (
  <div>
    {CHANNELS.map((c) => (
      <div key={c.name} style={rowStyle}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{c.note}</span>
          <Pill tone={c.tone}>{c.state}</Pill>
        </span>
      </div>
    ))}
  </div>
)
