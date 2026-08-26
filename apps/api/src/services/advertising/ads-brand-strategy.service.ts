/**
 * RPX.1 — the Brand tab: Amazon's brand funnel, read ONE CATEGORY NODE AT A TIME.
 *
 * ── 🔴 Why this service exists at all ──────────────────────────────────────────
 *
 * Amazon returns the SAME brand-week at several category-tree depths — three nodes for DE, ES
 * and FR, six or seven for IT — each carrying its own median and top-performer benchmark. The
 * report registry models that correctly: `categoryNodeName` is part of the grain and its column
 * tip says, in as many words, that dropping the dimension double-counts.
 *
 * The pinned Total row and the KPI tiles above it summed across those depths anyway. Measured on
 * production 2026-08-26 over 28 Jul – 26 Aug, all markets:
 *
 *     brand customers        276 shown   ·  91 honest   (3.03× overstated)
 *     add to carts         1,248 shown   · 410 honest   (3.04×)
 *     detail page views   11,481 shown   · 3,759 honest (3.05×)
 *
 * For DE, ES and FR the three nodes carry IDENTICAL values, so the multiplier is exactly three.
 * A figure that is three times too large is not a rounding question — it is a different claim.
 *
 * So every number this service returns comes from exactly ONE row: one market, one week, one
 * node. Nothing here sums, averages or blends across nodes, and there is no code path that can.
 *
 * ── The other three rules ──────────────────────────────────────────────────────
 *
 * · **Never blend markets.** Amazon computes each median against ONE market's category tree, and
 *   the four trees are different objects. The all-markets view compares RATIOS (ours ÷ our own
 *   median) rather than totals, which is the only cross-market comparison that means anything.
 *
 * · **Indices are not percentiles.** BM.0 tested this rather than assuming it: a brand sitting
 *   exactly on the category median reads 0.717 awareness, not 0.500. They are composite scores
 *   and are labelled as such; no percentile is ever computed from them, and no conversion rate
 *   is derived between funnel stages because Amazon publishes no mapping between them.
 *
 * · **A tie is not a win.** Engagement rate and new-to-brand rate come back identical for us,
 *   the category median AND the top performers in all four markets. `discriminates: false` says
 *   so, so the client can render it as a benchmark that cannot separate anyone rather than as
 *   a level result.
 *
 * The benchmark definitions are NOT redeclared here — `BRAND_BENCHMARKS` and `BRAND_BAND_KEYS`
 * are imported from the report registry, so the grid, the export and this endpoint read one
 * list. Two of Amazon's key names break their own pattern and are documented there; a second
 * copy is how the wrong one gets used.
 */
import prisma from '../../db.js'
import { BRAND_BENCHMARKS, BRAND_BAND_KEYS, type BenchmarkTrio } from './ads-report-specs.js'

/** Every value in Amazon's `metrics` payload arrives as a STRING, or is absent. Never 0. */
function payloadNum(metrics: Record<string, unknown> | null, key: string): number | null {
  if (!metrics) return null
  const raw = metrics[key]
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** A Prisma Decimal, a number, a string or null — all of which this column can hand back. */
function colNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'object' && 'toNumber' in (v as object)
    ? (v as { toNumber(): number }).toNumber()
    : Number(v as number)
  return Number.isFinite(n) ? n : null
}

export type Verdict = 'ahead' | 'behind' | 'level' | 'no-median' | 'no-value'

/**
 * Inside ±10 % of the median is called level.
 *
 * A benchmark that flips between "ahead" and "behind" on a 2 % wobble teaches an operator to
 * ignore it. The band is stated in the payload so the threshold is never a black box.
 */
const LEVEL_BAND = 0.1

export interface BrandBenchmark {
  id: string
  label: string
  format: string
  help?: string
  value: number | null
  median: number | null
  top: number | null
  /** ours ÷ median. Null when either side is missing, or the median is 0 (a ratio would be ∞). */
  ratio: number | null
  verdict: Verdict
  /**
   * |ln(ratio)| — how far from the median, on a scale where 5× ahead and a fifth behind are the
   * same distance. This is what the client sorts by; a subtraction would rank 798-vs-151 as 646
   * times more important than 1-vs-9, which is backwards.
   */
  distance: number | null
  /** False when ours, the median and the top are all the same figure. */
  discriminates: boolean
}

export interface BrandBand {
  id: string
  label: string
  lower: number | null
  upper: number | null
  medianLower: number | null
  medianUpper: number | null
  topLower: number | null
  topUpper: number | null
  discriminates: boolean
}

export interface BrandStageMetric extends BrandBenchmark {}

export interface BrandStage {
  id: 'awareness' | 'consideration' | 'purchase'
  label: string
  /** Amazon's composite score for the stage, 0–1. NOT a percentile. */
  index: number | null
  metrics: BrandStageMetric[]
}

export interface BrandNode {
  name: string
  treeName: string | null
  /** Path depth. The shallowest node in a market is its root and is the default. */
  depth: number
  weeks: number
  isRoot: boolean
}

export interface BrandMarketFreshness {
  marketplace: string
  lastWeek: string | null
  lagDays: number | null
  nodes: number
}

export interface BrandSeriesPoint {
  week: string
  awarenessIndex: number | null
  considerationIndex: number | null
  salesIndex: number | null
  brandCustomers: number | null
  addToCarts: number | null
  viewedDetailPageOnly: number | null
  /** Amazon's own median for this node-week, so a trend can be read against its category. */
  brandCustomersMedian: number | null
}

export interface BrandMarketRatio {
  marketplace: string
  node: string
  week: string | null
  indices: { awareness: number | null; consideration: number | null; sales: number | null }
  benchmarks: BrandBenchmark[]
}

export interface BrandStrategy {
  marketplace: string
  brandName: string | null
  node: BrandNode | null
  nodes: BrandNode[]
  week: string | null
  weeksHeld: number
  firstWeek: string | null
  lastWeek: string | null
  lagDays: number | null
  freshness: BrandMarketFreshness[]
  indices: { awareness: number | null; consideration: number | null; sales: number | null }
  stages: BrandStage[]
  /** All thirteen benchmarked figures for the chosen node-week, furthest from the median first. */
  benchmarks: BrandBenchmark[]
  bands: BrandBand[]
  series: BrandSeriesPoint[]
  /** One row per market, each against its OWN category tree. Populated for the all-markets view. */
  byMarket: BrandMarketRatio[]
  levelBand: number
  caveats: string[]
  elapsedMs: number
}

interface Row {
  marketplace: string
  brandName: string
  categoryNodeName: string
  categoryNodeTreeName: string | null
  computationDate: Date
  metrics: unknown
  awarenessIndex: unknown
  considerationIndex: unknown
  salesIndex: unknown
  brandCustomers: number | null
  addToCarts: number | null
  viewedDetailPageOnly: number | null
  highValueCustomers: number | null
  brandedSearchesOnly: number | null
  brandedSearchesAndDetailPageViews: number | null
  newToBrandCustomerRate: unknown
  customerConversionRate: unknown
}

const iso = (d: Date): string => d.toISOString().slice(0, 10)

/** Path depth of a node name. `/Categorie/Moto…` is 2; a deeper child is 3. */
const depthOf = (name: string): number => name.split('/').filter(Boolean).length

/**
 * OUR value for a trio, taken from the promoted column when there is one and from the raw
 * payload otherwise. `ownKey` is the payload key and is declared on the trio, never guessed.
 */
function ownValue(row: Row, trio: BenchmarkTrio, metrics: Record<string, unknown> | null): number | null {
  const promoted = (row as unknown as Record<string, unknown>)[trio.ownKey]
  if (promoted !== undefined) return colNum(promoted)
  return payloadNum(metrics, trio.ownKey)
}

function buildBenchmark(row: Row, trio: BenchmarkTrio, metrics: Record<string, unknown> | null): BrandBenchmark {
  const value = ownValue(row, trio, metrics)
  const median = payloadNum(metrics, trio.medianKey)
  const top = payloadNum(metrics, trio.topKey)

  // A median of 0 makes the ratio undefined, not infinite — say nothing rather than something huge.
  const ratio = value != null && median != null && median !== 0 ? value / median : null
  const distance = ratio != null && ratio > 0 ? Math.abs(Math.log(ratio)) : null

  let verdict: Verdict
  if (value == null) verdict = 'no-value'
  else if (median == null) verdict = 'no-median'
  else if (ratio == null) verdict = 'no-median'
  else if (Math.abs(ratio - 1) <= LEVEL_BAND) verdict = 'level'
  else verdict = ratio > 1 ? 'ahead' : 'behind'

  // Ours = median = top means the benchmark cannot separate anyone in this category.
  const discriminates = !(value != null && median != null && top != null && value === median && median === top)

  return {
    id: trio.id,
    label: trio.label,
    format: trio.format,
    help: trio.help,
    value, median, top, ratio, verdict, distance, discriminates,
  }
}

/** The three stages, and which benchmarked figures Amazon reports inside each. */
const STAGE_MAP: Array<{ id: BrandStage['id']; label: string; index: 'awarenessIndex' | 'considerationIndex' | 'salesIndex'; metrics: string[] }> = [
  { id: 'awareness', label: 'Awareness', index: 'awarenessIndex', metrics: ['viewedDetailPageOnly', 'brandedSearchesOnly'] },
  { id: 'consideration', label: 'Consideration', index: 'considerationIndex', metrics: ['addToCarts', 'brandedSearchesAndDetailPageViews'] },
  { id: 'purchase', label: 'Purchase', index: 'salesIndex', metrics: ['brandCustomers', 'highValueCustomers'] },
]

function buildBands(metrics: Record<string, unknown> | null): BrandBand[] {
  const g = (k: string) => payloadNum(metrics, k)
  const lower = g('engagedShopperRateLowerBound')
  const upper = g('engagedShopperRateUpperBound')
  const medianLower = g('engagedShopperRateCategoryMedianLowerBound')
  const medianUpper = g('engagedShopperRateCategoryMedianUpperBound')
  const topLower = g('engagedShopperRateCategoryTopPerformersLowerBound')
  const topUpper = g('engagedShopperRateCategoryTopPerformersUpperBound')
  const same = lower != null && upper != null
    && lower === medianLower && upper === medianUpper
    && lower === topLower && upper === topUpper
  return [{
    id: 'engagedShopperRate',
    label: 'Shopper engagement rate',
    lower, upper, medianLower, medianUpper, topLower, topUpper,
    discriminates: !same,
  }]
}

/** All rows we hold, newest first, for one market — the caller picks the node. */
async function rowsFor(marketplace: string | null): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(`
    SELECT "marketplace", "brandName", "categoryNodeName", "categoryNodeTreeName",
           "computationDate", "metrics",
           "awarenessIndex", "considerationIndex", "salesIndex",
           "brandCustomers", "addToCarts", "viewedDetailPageOnly", "highValueCustomers",
           "brandedSearchesOnly", "brandedSearchesAndDetailPageViews",
           "newToBrandCustomerRate", "customerConversionRate"
    FROM "AmazonAdsBrandBuildingMetric"
    ${marketplace ? 'WHERE "marketplace" = $1' : ''}
    ORDER BY "computationDate" DESC`, ...(marketplace ? [marketplace] : []))
}

export async function brandStrategy(opts: {
  /** A single market, or null for the all-markets ratio view. */
  marketplace: string | null
  /** Category node to read. Omitted = each market's root (its shallowest node). */
  node?: string | null
  /** How many weeks of history to return in the series. */
  weeks?: number
}): Promise<BrandStrategy> {
  const started = Date.now()
  const weeksWanted = Math.max(1, Math.min(52, opts.weeks ?? 12))

  const [all, freshRows] = await Promise.all([
    rowsFor(opts.marketplace),
    prisma.$queryRawUnsafe<Array<{ marketplace: string; last: Date | null; nodes: number }>>(`
      SELECT "marketplace", MAX("computationDate") AS last, COUNT(DISTINCT "categoryNodeName")::int AS nodes
      FROM "AmazonAdsBrandBuildingMetric" GROUP BY 1 ORDER BY 1`),
  ])

  const today = new Date()
  const freshness: BrandMarketFreshness[] = freshRows.map((r) => ({
    marketplace: r.marketplace,
    lastWeek: r.last ? iso(r.last) : null,
    lagDays: r.last ? Math.round((today.getTime() - r.last.getTime()) / 86_400_000) : null,
    nodes: Number(r.nodes),
  }))

  const caveats: string[] = [
    'Amazon publishes Brand Metrics weekly, and the request’s aggregation level is ignored — every grain returns the same weekly payload.',
    'Awareness, consideration and sales are Amazon’s composite INDICES, not percentile ranks: a brand sitting exactly on the category median reads about 0.72, not 0.50. No conversion rate is derived between stages, because Amazon publishes no mapping between them.',
  ]

  // ── the all-markets view: ratios only, never a blended total ────────────────
  if (!opts.marketplace) {
    const byMarket: BrandMarketRatio[] = []
    const markets = [...new Set(all.map((r) => r.marketplace))].sort()
    for (const m of markets) {
      const mine = all.filter((r) => r.marketplace === m)
      const root = [...mine].sort((a, b) => depthOf(a.categoryNodeName) - depthOf(b.categoryNodeName))[0]
      if (!root) continue
      const latest = mine
        .filter((r) => r.categoryNodeName === root.categoryNodeName)
        .sort((a, b) => b.computationDate.getTime() - a.computationDate.getTime())[0]
      if (!latest) continue
      const met = (latest.metrics ?? null) as Record<string, unknown> | null
      byMarket.push({
        marketplace: m,
        node: latest.categoryNodeName,
        week: iso(latest.computationDate),
        indices: {
          awareness: colNum(latest.awarenessIndex),
          consideration: colNum(latest.considerationIndex),
          sales: colNum(latest.salesIndex),
        },
        benchmarks: BRAND_BENCHMARKS.map((t) => buildBenchmark(latest, t, met)),
      })
    }
    caveats.push('Across markets only RATIOS are comparable: each market is measured against its own category tree, and the four trees are different objects. Nothing here is summed across markets.')
    return {
      marketplace: 'ALL', brandName: null, node: null, nodes: [], week: null,
      weeksHeld: 0, firstWeek: null, lastWeek: null, lagDays: null,
      freshness,
      indices: { awareness: null, consideration: null, sales: null },
      stages: [], benchmarks: [], bands: [], series: [], byMarket,
      levelBand: LEVEL_BAND, caveats, elapsedMs: Date.now() - started,
    }
  }

  // ── one market ─────────────────────────────────────────────────────────────
  const nodeCounts = new Map<string, { tree: string | null; weeks: Set<string> }>()
  for (const r of all) {
    let e = nodeCounts.get(r.categoryNodeName)
    if (!e) { e = { tree: r.categoryNodeTreeName, weeks: new Set() }; nodeCounts.set(r.categoryNodeName, e) }
    e.weeks.add(iso(r.computationDate))
  }
  const minDepth = Math.min(...[...nodeCounts.keys()].map(depthOf), Number.POSITIVE_INFINITY)
  const nodes: BrandNode[] = [...nodeCounts.entries()]
    .map(([name, e]) => ({
      name, treeName: e.tree, depth: depthOf(name), weeks: e.weeks.size, isRoot: depthOf(name) === minDepth,
    }))
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))

  const chosenName = opts.node && nodeCounts.has(opts.node)
    ? opts.node
    : nodes.find((n) => n.isRoot)?.name ?? nodes[0]?.name ?? null
  const node = nodes.find((n) => n.name === chosenName) ?? null

  const nodeRows = all
    .filter((r) => r.categoryNodeName === chosenName)
    .sort((a, b) => b.computationDate.getTime() - a.computationDate.getTime())
  const latest = nodeRows[0] ?? null
  const met = (latest?.metrics ?? null) as Record<string, unknown> | null

  const benchmarks = latest ? BRAND_BENCHMARKS.map((t) => buildBenchmark(latest, t, met)) : []
  const ranked = [...benchmarks].sort((a, b) => {
    // Anything without a distance sinks, in both directions — an absence is not a small gap.
    if (a.distance == null && b.distance == null) return 0
    if (a.distance == null) return 1
    if (b.distance == null) return -1
    return b.distance - a.distance
  })

  const byId = new Map(benchmarks.map((b) => [b.id, b]))
  const stages: BrandStage[] = latest
    ? STAGE_MAP.map((s) => ({
      id: s.id,
      label: s.label,
      index: colNum(latest[s.index]),
      metrics: s.metrics.map((id) => byId.get(id)).filter((b): b is BrandBenchmark => !!b),
    }))
    : []

  const series: BrandSeriesPoint[] = nodeRows
    .slice(0, weeksWanted)
    .map((r) => {
      const m = (r.metrics ?? null) as Record<string, unknown> | null
      return {
        week: iso(r.computationDate),
        awarenessIndex: colNum(r.awarenessIndex),
        considerationIndex: colNum(r.considerationIndex),
        salesIndex: colNum(r.salesIndex),
        brandCustomers: r.brandCustomers ?? null,
        addToCarts: r.addToCarts ?? null,
        viewedDetailPageOnly: r.viewedDetailPageOnly ?? null,
        brandCustomersMedian: payloadNum(m, 'brandCustomersCategoryMedian'),
      }
    })
    .reverse()

  const weeksAll = [...new Set(nodeRows.map((r) => iso(r.computationDate)))].sort()
  const lastWeek = weeksAll[weeksAll.length - 1] ?? null
  const lagDays = lastWeek
    ? Math.round((today.getTime() - new Date(`${lastWeek}T00:00:00Z`).getTime()) / 86_400_000)
    : null

  if (nodes.length > 1) {
    caveats.push(`Amazon reports this brand-week at ${nodes.length} category depths, each with its own benchmark. Every figure here comes from ONE of them — the ${node?.isRoot ? 'root' : 'selected'} node — because adding them together counts the same shoppers more than once.`)
  }
  const mute = benchmarks.filter((b) => !b.discriminates)
  if (mute.length) {
    caveats.push(`${mute.length === 1 ? 'One benchmark returns' : `${mute.length} benchmarks return`} the same figure for us, the category median and the top performers, so ${mute.length === 1 ? 'it cannot' : 'they cannot'} tell anyone apart in this category: ${mute.map((b) => b.label).join(', ')}.`)
  }

  return {
    marketplace: opts.marketplace,
    brandName: latest?.brandName ?? null,
    node,
    nodes,
    week: lastWeek,
    weeksHeld: weeksAll.length,
    firstWeek: weeksAll[0] ?? null,
    lastWeek,
    lagDays,
    freshness,
    indices: {
      awareness: colNum(latest?.awarenessIndex),
      consideration: colNum(latest?.considerationIndex),
      sales: colNum(latest?.salesIndex),
    },
    stages,
    benchmarks: ranked,
    bands: buildBands(met),
    series,
    byMarket: [],
    levelBand: LEVEL_BAND,
    caveats,
    elapsedMs: Date.now() - started,
  }
}
