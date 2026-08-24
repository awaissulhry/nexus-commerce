// MetricStrip — the KPI tile row that sits above every ads surface.
// Composition ported from the DS catalog's "Metric strip" cell and from the AI
// Advertising dashboard (apps/web/src/app/marketing/ads/ai-advertising/
// AiAdvertisingDashboard.tsx), which builds the same `Metric[]`.
//
// `delta.positive` is the DIRECTION OF GOODNESS, not the sign of the number:
// ACoS falling is `positive: true` even though the arrow points down. The strip
// colours the tile green for true and red for false, so getting this backwards
// paints a win red.
import { MetricStrip } from '@nexus/design-system'

/** The canonical five: spend, sales, efficiency, return and reach, week over week. */
export const AdsOverview = () => (
  <MetricStrip
    metrics={[
      { label: 'Spend', value: '€1,284', delta: { value: '▲ 12%', positive: false } },
      { label: 'Sales', value: '€8,640', delta: { value: '▲ 9%', positive: true } },
      { label: 'ACoS', value: '14.9%', delta: { value: '▼ 1.3pt', positive: true } },
      { label: 'ROAS', value: '6.73×', delta: { value: '▲ 0.4×', positive: true } },
      { label: 'Impressions', value: '412,880', delta: { value: '▼ 3%', positive: false } },
    ]}
  />
)

/** A bad week, stated plainly: sales down, ACoS up, every tile red. */
export const DownWeek = () => (
  <MetricStrip
    metrics={[
      { label: 'Spend', value: '€1,902', delta: { value: '▲ 34%', positive: false } },
      { label: 'Sales', value: '€6,110', delta: { value: '▼ 21%', positive: false } },
      { label: 'ACoS', value: '31.1%', delta: { value: '▲ 8.4pt', positive: false } },
      { label: 'PPC Orders', value: '148', delta: { value: '▼ 26%', positive: false } },
    ]}
  />
)

/** `delta` is optional — counts with no prior period render as value-only tiles. */
export const NoDeltas = () => (
  <MetricStrip
    metrics={[
      { label: 'Active goals', value: '7' },
      { label: 'Pending proposals', value: '23' },
      { label: 'Managed campaigns', value: '212' },
      { label: 'Daily cap', value: '€450' },
    ]}
  />
)

/** Values are ReactNode: a missing metric prints an em dash rather than a fake zero. */
export const UnknownMetric = () => (
  <MetricStrip
    metrics={[
      { label: 'Spend', value: '€318', delta: { value: '▲ 4%', positive: false } },
      { label: 'Sales', value: '€1,090', delta: { value: '▲ 11%', positive: true } },
      { label: 'ACoS', value: '—' },
      { label: 'Share of voice', value: '—' },
    ]}
  />
)
