import { Tag } from '@nexus/design-system'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>{children}</div>
)

const IMPORT_ROWS = [
  { sku: 'HLM-RS9-BLK-M', outcome: 'new listing', tone: 'neutral', check: 'OK', checkTone: 'success' },
  { sku: 'HLM-RS9-BLK-L', outcome: 'price changed', tone: 'info', check: 'OK', checkTone: 'success' },
  { sku: 'GLV-TR4-BRN-9', outcome: 'no EAN', tone: 'warning', check: 'Skipped', checkTone: 'warning' },
  { sku: 'JKT-AX2-GRY-XL', outcome: 'title too long', tone: 'danger', check: 'Blocked', checkTone: 'danger' },
] as const

/** The tone axis. Tag is the metadata chip — Pill is entity *status*, Badge is the ad *program*. */
export const Tones = () => (
  <Row>
    <Tag>neutral</Tag>
    <Tag tone="info">info</Tag>
    <Tag tone="success">success</Tag>
    <Tag tone="warning">warning</Tag>
    <Tag tone="danger">danger</Tag>
  </Row>
)

/** What Tag actually labels day to day: marketplace, fulfilment channel, entity type, rule trigger. */
export const Metadata = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Row>
      <Tag tone="info">Amazon DE</Tag>
      <Tag tone="info">Amazon IT</Tag>
      <Tag tone="info">eBay UK</Tag>
      <Tag tone="info">Shopify</Tag>
    </Row>
    <Row>
      <Tag>FBA</Tag>
      <Tag>FBM</Tag>
      <Tag>Parent ASIN</Tag>
      <Tag>Variation</Tag>
    </Row>
    <Row>
      <Tag tone="warning">ACOS &gt; 30%</Tag>
      <Tag tone="success">Bid −15%</Tag>
      <Tag tone="danger">Budget capped</Tag>
    </Row>
  </div>
)

/** Two tag columns in an import review table — the register the flat-file wizard uses. */
export const ImportReview = () => (
  <div>
    {IMPORT_ROWS.map((r) => (
      <div
        key={r.sku}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '7px 0',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 13,
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>{r.sku}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Tag tone={r.tone}>{r.outcome}</Tag>
          <Tag tone={r.checkTone}>{r.check}</Tag>
        </span>
      </div>
    ))}
  </div>
)
