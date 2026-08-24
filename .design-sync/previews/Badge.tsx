import { Badge } from '@nexus/design-system'

const PROGRAMS = [
  { program: 'sp', label: 'SP', meaning: 'Sponsored Products' },
  { program: 'sb', label: 'SB', meaning: 'Sponsored Brands' },
  { program: 'sd', label: 'SD', meaning: 'Sponsored Display' },
  { program: 'auto', label: 'A', meaning: 'Automatic targeting' },
  { program: 'manual', label: 'M', meaning: 'Manual targeting' },
] as const

const CAMPAIGNS = [
  { program: 'sp', label: 'SP', targeting: 'auto', t: 'A', name: 'Helmets · Auto', spend: '€1,284' },
  { program: 'sb', label: 'SB', targeting: 'manual', t: 'M', name: 'Brand Defense', spend: '€642' },
  { program: 'sd', label: 'SD', targeting: 'auto', t: 'A', name: 'Retargeting · DE', spend: '€318' },
  { program: 'sp', label: 'SP', targeting: 'manual', t: 'M', name: 'Gloves · Manual', spend: '€96' },
] as const

/** The whole `program` axis: three Amazon ad programs, then the two targeting badges. */
export const Programs = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    {PROGRAMS.map((p) => (
      <Badge key={p.program} program={p.program}>{p.label}</Badge>
    ))}
  </div>
)

/** What each abbreviation stands for — the badge is always the abbreviation, never the full name. */
export const LabelledPrograms = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
    {PROGRAMS.map((p) => (
      <div key={p.program} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 26, display: 'inline-flex', justifyContent: 'flex-start' }}>
          <Badge program={p.program}>{p.label}</Badge>
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{p.meaning}</span>
      </div>
    ))}
  </div>
)

/** The canonical use: program + targeting badge prefixing a campaign name in a grid row. */
export const InCampaignRows = () => (
  <div>
    {CAMPAIGNS.map((c) => (
      <div
        key={c.name}
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Badge program={c.program}>{c.label}</Badge>
          <Badge program={c.targeting}>{c.t}</Badge>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span>
        </span>
        <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{c.spend}</span>
      </div>
    ))}
  </div>
)
