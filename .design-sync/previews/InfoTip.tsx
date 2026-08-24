import { InfoTip, Input, Pill, Select } from '@nexus/design-system'

const label: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 5,
}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', marginBottom: 12 }

const th: React.CSSProperties = {
  textAlign: 'right',
  padding: '6px 0 6px 18px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--text-tertiary)',
  borderBottom: '1px solid var(--border-default)',
  whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  textAlign: 'right',
  padding: '6px 0 6px 18px',
  fontSize: 13,
  color: 'var(--text-primary)',
  borderBottom: '1px solid var(--border-subtle)',
  fontVariantNumeric: 'tabular-nums',
}

/** The dominant call site: an ⓘ after a form label, explaining the field without widening it. */
export const FieldLabels = () => (
  <div style={{ maxWidth: 300 }}>
    <div style={field}>
      <span style={label}>
        Target ACoS
        <InfoTip tip="The efficiency target the AI steers toward. Strategy presets scale it — Liquidate and Impression &amp; Click deliberately run above it while they work." />
      </span>
      <Input suffix="%" defaultValue="22" size={6} />
    </div>
    <div style={field}>
      <span style={label}>
        Max bid
        <InfoTip tip="The AI never bids above this. Empty = the €3.00 default ceiling." />
      </span>
      <Input prefix="€" defaultValue="1.40" size={6} />
    </div>
    <div style={field}>
      <span style={label}>
        Marketplace
        <InfoTip tip="The Amazon marketplace these campaigns launch in. Suggestions, budgets and the preview are all scoped to it." />
      </span>
      <Select defaultValue="de">
        <option value="de">Amazon DE</option>
        <option value="it">Amazon IT</option>
        <option value="uk">Amazon UK</option>
      </Select>
    </div>
  </div>
)

/** In a grid header, where the tooltip must escape the scrolling pane — the reason InfoTip portals. */
export const ColumnHeaders = () => (
  <table style={{ borderCollapse: 'collapse' }}>
    <thead>
      <tr>
        <th style={{ ...th, textAlign: 'left', paddingLeft: 0 }}>Campaign</th>
        <th style={th}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Spend
            <InfoTip tip="Amazon-reported cost for the selected window, in the marketplace currency. Excludes anything spent outside the window." />
          </span>
        </th>
        <th style={th}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Ad sales
            <InfoTip tip="14-day attributed sales for this campaign only. Same-SKU and halo sales are separate columns — adding them here would double-count." />
          </span>
        </th>
        <th style={th}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ACoS
            <InfoTip tip="Spend ÷ ad sales, as a percentage. Blank when the campaign has spend but no attributed sales yet." />
          </span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style={{ ...td, textAlign: 'left', paddingLeft: 0, fontWeight: 600 }}>Helmets · Auto</td>
        <td style={td}>€1,284</td>
        <td style={td}>€8,640</td>
        <td style={td}>14.9%</td>
      </tr>
      <tr>
        <td style={{ ...td, textAlign: 'left', paddingLeft: 0, fontWeight: 600 }}>Brand Defense</td>
        <td style={td}>€642</td>
        <td style={td}>€3,120</td>
        <td style={td}>20.6%</td>
      </tr>
    </tbody>
  </table>
)

/** With `children` it wraps an existing control instead of drawing its own ⓘ — no second tab stop, no second name. */
export const WrappingAControl = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <InfoTip tip="Amazon stopped delivery at 14:20 UTC — the daily budget was exhausted. The budget day rolls at 00:00 UTC, not marketplace midnight.">
      <Pill tone="warning">Out of budget</Pill>
    </InfoTip>
    <InfoTip tip="This campaign has spend but no attributed sales in the window, so ACoS has no defined value.">
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)', borderBottom: '1px dotted var(--border-strong)' }}>
        ACoS —
      </span>
    </InfoTip>
  </div>
)
