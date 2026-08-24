// PerformanceGraph — the dual-axis trend card. Ported from the DS catalog's
// "Charts · Performance · dual-axis" section and from the live eBay ads trend
// card (apps/web/src/app/marketing/ads/ebay/_dash/TrendCard.tsx), which offers
// exactly these three metric pairings.
//
// Recharts' ResponsiveContainer measures its PARENT: `height` is passed as a
// number so it is definite, and every story sits inside a Card body (a plain
// block with a definite width). Without a sized parent the chart collapses to
// zero and the card renders blank.
import { Card, PerformanceGraph, type ChartSeries } from '@nexus/design-system'

// ── Capture determinism, not decoration ──────────────────────────────────────
// Recharts draws each line with a 1.5s mount animation (react-smooth walks
// stroke-dasharray from 0 to the path length). BurnDownChart passes
// isAnimationActive={false}; PerformanceGraph does not forward it, so a card
// captured ~600ms after mount froze the series half-drawn — Jun 8 of a 14-day
// window, and a different day on every run. Pinning the FINAL frame is the only
// lever a preview has, and it lives at module scope so the story JSX an agent
// copies stays a plain <PerformanceGraph …/>.
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = '.recharts-line-curve{stroke-dasharray:none!important}'
  document.head.appendChild(style)
}

interface Point extends Record<string, number | string> {
  day: string
  spend: number
  sales: number
  acos: number
  clicks: number
  impressions: number
}

// A fortnight of Sponsored Products delivery for one portfolio. ACOS is the
// honest quotient of the spend and sales on the same row — a trend chart that
// invents its own third series is the fastest way to teach a design agent a lie.
const TREND: Point[] = [
  { day: 'Jun 1', spend: 62, sales: 258, acos: 24.0, clicks: 148, impressions: 5120 },
  { day: 'Jun 2', spend: 88, sales: 402, acos: 21.9, clicks: 205, impressions: 6840 },
  { day: 'Jun 3', spend: 104, sales: 388, acos: 26.8, clicks: 241, impressions: 7910 },
  { day: 'Jun 4', spend: 121, sales: 640, acos: 18.9, clicks: 279, impressions: 9260 },
  { day: 'Jun 5', spend: 118, sales: 512, acos: 23.0, clicks: 268, impressions: 8880 },
  { day: 'Jun 6', spend: 96, sales: 511, acos: 18.8, clicks: 224, impressions: 7420 },
  { day: 'Jun 7', spend: 79, sales: 300, acos: 26.3, clicks: 186, impressions: 6180 },
  { day: 'Jun 8', spend: 91, sales: 470, acos: 19.4, clicks: 212, impressions: 7060 },
  { day: 'Jun 9', spend: 126, sales: 705, acos: 17.9, clicks: 291, impressions: 9640 },
  { day: 'Jun 10', spend: 148, sales: 902, acos: 16.4, clicks: 338, impressions: 11280 },
  { day: 'Jun 11', spend: 139, sales: 640, acos: 21.7, clicks: 316, impressions: 10510 },
  { day: 'Jun 12', spend: 112, sales: 690, acos: 16.2, clicks: 259, impressions: 8630 },
  { day: 'Jun 13', spend: 94, sales: 402, acos: 23.4, clicks: 218, impressions: 7250 },
  { day: 'Jun 14', spend: 107, sales: 648, acos: 16.5, clicks: 246, impressions: 8180 },
]

// Canon palette hexes (design-system/tokens/colors.ts) — Recharts takes real
// colours, not CSS custom properties, so JS consumers read the same values the
// stylesheet does.
const eur = (v: number) => `€${v.toFixed(2)}`
const SPEND: ChartSeries = { key: 'spend', label: 'Ad spend', color: '#e5484d', axis: 'left', format: eur }
const SALES: ChartSeries = { key: 'sales', label: 'Ad sales', color: '#1f6fde', axis: 'right', format: eur }
const ACOS: ChartSeries = { key: 'acos', label: 'ACOS', color: '#b87503', axis: 'right', format: (v) => `${v.toFixed(1)}%` }
const CLICKS: ChartSeries = { key: 'clicks', label: 'Clicks', color: '#12855f', axis: 'left', format: (v) => Math.round(v).toLocaleString('en-IE') }
const IMPRESSIONS: ChartSeries = { key: 'impressions', label: 'Impressions', color: '#1f6fde', axis: 'right', format: (v) => Math.round(v).toLocaleString('en-IE') }

/** The default pairing: money on both axes, but on independent scales — €148 of spend and €902 of sales stay legible together. */
export const SpendVsSales = () => (
  <Card header="Performance trend · Helmets · Auto">
    <PerformanceGraph data={TREND} xKey="day" left={SPEND} right={SALES} height={240} />
  </Card>
)

/** Two units at once is what the right axis is FOR: € on the left, % on the right. */
export const SpendVsAcos = () => (
  <Card header="Spend against ACOS · last 14 days">
    <PerformanceGraph data={TREND} xKey="day" left={SPEND} right={ACOS} height={240} />
  </Card>
)

/** Same unit, wildly different magnitudes — clicks in the hundreds against impressions in the tens of thousands. */
export const ClicksVsImpressions = () => (
  <Card header="Traffic · clicks and impressions">
    <PerformanceGraph data={TREND} xKey="day" left={CLICKS} right={IMPRESSIONS} height={240} />
  </Card>
)

/** A compact 160px graph, the size the ads console uses inside a detail drawer. */
export const Compact = () => (
  <Card header="Sparkline height">
    <PerformanceGraph data={TREND} xKey="day" left={SPEND} right={SALES} height={160} />
  </Card>
)
