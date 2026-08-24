// Heatmap — intensity grid, cell opacity scales with value ÷ max.
// `data` is a 2-D array read as rows × cols: data[r][c] pairs with
// rowLabels[r] and colLabels[c]. A flat array renders nothing (row.map).
//
// The dayparting story is ported straight from the DS catalog's
// "Charts · Heatmap · dayparting" section (DAYS / HOURS / HEAT_DATA).
import { Card, Heatmap } from '@nexus/design-system'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// Only every sixth hour is labelled — 24 legible ticks do not fit the row.
const HOURS = Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? `${h}` : ''))

// Deterministic (Math.sin, no random): a daytime bell that climbs through the
// week, which is what hour-of-week click share actually looks like.
const CLICK_SHARE = DAYS.map((_, d) =>
  Array.from({ length: 24 }, (_, h) => {
    const peak = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI))
    return Math.round(peak * 100 * (0.55 + d * 0.07))
  }),
)

// Row labels are clipped at 36px by the stylesheet, so they stay short.
const PLACEMENTS = ['Top', 'Rest', 'Pages']
const PLACEMENT_SPEND = [
  [148, 162, 171, 158, 186, 121, 96],
  [72, 81, 84, 79, 92, 58, 47],
  [39, 44, 41, 46, 53, 31, 24],
]

const MARKETS = ['DE', 'FR', 'IT', 'ES', 'UK']
const WEEKS = ['W23', 'W24', 'W25', 'W26', 'W27', 'W28', 'W29', 'W30']
// W27 is the Prime-Day week — it spikes every marketplace, which is what gives
// the grid a column an eye can find. Intensity is normalised to the whole
// matrix's max, so the smaller markets stay honestly pale.
const MARKET_SPEND = [
  [1840, 1910, 2040, 1980, 3620, 2350, 2280, 2460],
  [620, 660, 710, 690, 1180, 780, 810, 860],
  [980, 1020, 1110, 1180, 1990, 1190, 1310, 1380],
  [410, 440, 470, 520, 910, 590, 610, 640],
  [1280, 1340, 1290, 1420, 2870, 1470, 1560, 1640],
]

const eur = (v: number) => `€${v.toLocaleString('en-IE')}`

/** Hour-of-week dayparting — 7 × 24, the grid the bid-schedule editor reads from. */
export const Dayparting = () => (
  <Card header="Click share by hour · last 28 days">
    <Heatmap data={CLICK_SHARE} rowLabels={DAYS} colLabels={HOURS} format={(v) => `${v}%`} />
  </Card>
)

/** A short, wide matrix: three placements against the days of one week. */
export const PlacementByDay = () => (
  <Card header="Spend by placement">
    <Heatmap data={PLACEMENT_SPEND} rowLabels={PLACEMENTS} colLabels={DAYS} format={eur} />
  </Card>
)

/** Marketplaces down, weeks across — five rows, eight columns, one €-formatted scale. */
export const MarketplaceWeeks = () => (
  <Card header="Ad spend by marketplace · W23–W30">
    <Heatmap data={MARKET_SPEND} rowLabels={MARKETS} colLabels={WEEKS} format={eur} />
  </Card>
)

/** `colLabels` is optional — the same matrix as above without it, so the header row disappears and the rows shift left. */
export const NoColumnLabels = () => (
  <Card header="Spend by placement · unlabelled columns">
    <Heatmap data={PLACEMENT_SPEND} rowLabels={PLACEMENTS} format={eur} />
  </Card>
)
