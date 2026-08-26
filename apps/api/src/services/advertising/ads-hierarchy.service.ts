/**
 * GX.2 — the drill-down hierarchy: Market → Portfolio → Campaign → { Product | Target }.
 *
 * ── Why the last step is a FORK, not a level ──────────────────────────────────
 *
 * Product and Target both hang off the ad group, and each independently accounts for ~100% of
 * its campaign's spend. Measured on production over 1 Jul – 25 Aug, Italy: campaign €3,378.04 ·
 * targets €3,200.63 (99.9% since the targeting ingest began) · products €2,697.15. They are two
 * decompositions of the SAME money — which product did it advertise, which keyword did it bid on
 * — so nesting one inside the other would multiply a campaign's spend by itself. A campaign
 * expands into one or the other, chosen by the caller.
 *
 * Ad group sits between them in Amazon's model and is deliberately absent: `spAdGroups` has never
 * been requested, so there are no ad-group performance rows to show. Skipping the rung keeps the
 * arithmetic exact; inventing it would not.
 *
 * ── The remainder row is the point ────────────────────────────────────────────
 *
 * A tree makes one promise the moment it draws a chevron: these rows are what that row is made
 * of. Where the children do not reach the parent, the difference is returned as its own node with
 * the reason attached — never left for the eye to subtract, and never hidden. Every competitor's
 * grid will expand a campaign and show children that do not add up with nothing on screen to say
 * so; this is the cheapest differentiating thing in the whole surface.
 *
 * ── Three invariants ──────────────────────────────────────────────────────────
 *
 * 1. **One metric registry.** `coreMetrics` is imported from the report specs, not redeclared, so
 *    ACOS here is the same expression as ACOS on the grid, the totals row and the export.
 * 2. **The AMS duplicates are excluded everywhere.** 659 stream-written daily rows would inflate
 *    every Italian node — see ads-core/ams-daily.
 * 3. **Derived metrics are never summed or subtracted.** A remainder's ACOS is recomputed from
 *    its own spend and sales; differencing two ACOS values produces a number that means nothing.
 */
import prisma from '../../db.js'
import { excludeAmsDailySql } from '../ads-core/ams-daily.js'
import { coreMetrics, type Metric } from './ads-report-specs.js'

export type HierarchyLevel = 'root' | 'market' | 'portfolio' | 'campaign'
export type Decompose = 'product' | 'target'
export type NodeKind = 'market' | 'portfolio' | 'campaign' | 'product' | 'target' | 'remainder'

export interface HierarchyNode {
  /** Stable, and the key the client expands on. Carries its own path — see `parseNodeId`. */
  id: string
  label: string
  /** A second line: an ASIN under a product, a match type under a target. */
  sub: string | null
  kind: NodeKind
  /** False on a leaf and on the remainder — the client must not draw a chevron it cannot open. */
  expandable: boolean
  /** Where clicking the label goes. Null when the thing has no page of its own. */
  href: string | null
  metrics: Record<string, number | null>
}

export interface HierarchyResult {
  level: HierarchyLevel
  parentId: string | null
  /** What one row of `nodes` IS, in the operator's words. */
  childLabel: string
  decompose: Decompose | null
  nodes: HierarchyNode[]
  /** The parent's own figures, so the client can show what the children are being read against. */
  parentMetrics: Record<string, number | null> | null
  /** Present when the children do not reach the parent. Already included in `nodes` as well. */
  remainder: { amount: number; pctOfParent: number; reason: string } | null
  columns: Array<{ id: string; label: string; format: string; help?: string }>
  caveats: string[]
  elapsedMs: number
}

/** Additive measures — the only ones a remainder may be computed by subtraction. */
const ADDITIVE = ['impressions', 'clicks', 'cost', 'sales', 'orders', 'units'] as const

const METRICS: Metric[] = coreMetrics('p')
const SELECT_METRICS = METRICS.map((m) => `${m.sql} AS "${m.id}"`).join(', ')
const AMS = excludeAmsDailySql('p')

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = typeof v === 'bigint' ? Number(v) : Number(v as number)
  return Number.isFinite(n) ? n : null
}

function readMetrics(row: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const m of METRICS) out[m.id] = num(row[m.id])
  return out
}

/**
 * Recompute the derived metrics from a set of additive ones.
 *
 * Used for the remainder, where subtraction is legitimate for counts and money and meaningless
 * for rates. Mirrors `coreMetrics` exactly — if that changes, this must, and the test in
 * ads-hierarchy.vitest.test.ts fails when they drift.
 */
export function deriveMetrics(base: Record<string, number | null>): Record<string, number | null> {
  const g = (k: string) => base[k] ?? 0
  const imps = g('impressions'); const clicks = g('clicks')
  const cost = g('cost'); const sales = g('sales'); const orders = g('orders')
  return {
    ...base,
    ctr: imps > 0 ? clicks / imps : null,
    cpc: clicks > 0 ? cost / clicks : null,
    acos: sales > 0 ? cost / sales : null,
    roas: cost > 0 ? sales / cost : null,
    cvr: clicks > 0 ? orders / clicks : null,
  }
}

/** `market:IT` · `portfolio:IT:1234` · `portfolio:IT:__none` · `campaign:<localId>` */
export function parseNodeId(id: string): { kind: string; parts: string[] } {
  const [kind, ...parts] = id.split(':')
  return { kind, parts }
}

const NO_PORTFOLIO = '__none'

interface Query {
  level: HierarchyLevel
  parentId: string | null
  from: string
  to: string
  decompose: Decompose
  /** Restrict the root level to these markets. */
  marketplaces: string[]
}

/** Whitelisted, never escaped — anything not a country code is dropped rather than quoted. */
const marketIn = (alias: string, codes: string[]) => {
  const ok = codes.filter((c) => /^[A-Z]{2,12}$/.test(c))
  return ok.length ? ` AND ${alias}."marketplace" IN (${ok.map((c) => `'${c}'`).join(', ')})` : ''
}

export async function hierarchyChildren(q: Query): Promise<HierarchyResult> {
  const started = Date.now()
  const caveats: string[] = []
  const columns = METRICS.map((m) => ({ id: m.id, label: m.label, format: m.format, help: m.help }))
  const win = `p."date" >= $1::date AND p."date" <= $2::date`
  const args = [q.from, q.to]

  const base = (extra: string, from = '"AmazonAdsDailyPerformance" p') =>
    `FROM ${from} WHERE ${win} AND ${AMS} ${extra}`

  // ── root → markets ─────────────────────────────────────────────────────────
  if (q.level === 'root') {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT p."marketplace" AS id, ${SELECT_METRICS}
       ${base(`AND p."entityType" = 'CAMPAIGN'${marketIn('p', q.marketplaces)}`)}
       GROUP BY 1 ORDER BY 1`, ...args)
    return done({
      level: 'root', parentId: null, childLabel: 'Market', decompose: null,
      nodes: rows.map((r) => ({
        id: `market:${r.id}`,
        label: String(r.id),
        sub: null,
        kind: 'market' as NodeKind,
        expandable: true,
        href: null,
        metrics: readMetrics(r),
      })),
      parentMetrics: null, remainder: null, columns, caveats,
    })
  }

  // ── market → portfolios (+ the campaigns in none) ──────────────────────────
  if (q.level === 'market') {
    const market = parseNodeId(q.parentId ?? '').parts[0]
    if (!market || !/^[A-Z]{2,12}$/.test(market)) throw new HierarchyError('a market node id is required', 400)
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT COALESCE(c."portfolioId", '${NO_PORTFOLIO}') AS id,
              COALESCE(MAX(f."name"), '') AS name,
              COUNT(DISTINCT c."id")::int AS campaigns, ${SELECT_METRICS}
       ${base(`AND p."entityType" = 'CAMPAIGN' AND p."marketplace" = $3`,
        `"AmazonAdsDailyPerformance" p
         JOIN "Campaign" c ON c."id" = p."localEntityId"
         LEFT JOIN "AmazonAdsPortfolio" f ON f."externalPortfolioId" = c."portfolioId"`)}
       GROUP BY 1 ORDER BY 1`, ...args, market)
    const parent = await parentTotals(`AND p."entityType" = 'CAMPAIGN' AND p."marketplace" = $3`, [...args, market])
    // 148 of 220 campaigns carry no portfolio; a bucket, never a hidden remainder.
    if (rows.some((r) => r.id === NO_PORTFOLIO)) {
      caveats.push('Campaigns Amazon has not put in a portfolio are grouped under “No portfolio”. That is a real bucket, not a leftover — dropping it would lose their spend from the market total.')
    }
    return done({
      level: 'market', parentId: q.parentId, childLabel: 'Portfolio', decompose: null,
      nodes: rows.map((r) => {
        const none = r.id === NO_PORTFOLIO
        return {
          id: `portfolio:${market}:${r.id}`,
          label: none ? 'No portfolio' : (String(r.name || r.id)),
          sub: `${Number(r.campaigns)} ${Number(r.campaigns) === 1 ? 'campaign' : 'campaigns'}`,
          kind: 'portfolio' as NodeKind,
          expandable: true,
          href: none ? null : '/marketing/ads/portfolios',
          metrics: readMetrics(r),
        }
      }),
      parentMetrics: parent, remainder: null, columns, caveats,
    })
  }

  // ── portfolio → campaigns ──────────────────────────────────────────────────
  if (q.level === 'portfolio') {
    const [market, portfolio] = parseNodeId(q.parentId ?? '').parts
    if (!market || !portfolio) throw new HierarchyError('a portfolio node id is required', 400)
    const clause = portfolio === NO_PORTFOLIO ? 'c."portfolioId" IS NULL' : 'c."portfolioId" = $4'
    const extra = [...args, market, ...(portfolio === NO_PORTFOLIO ? [] : [portfolio])]
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT c."id" AS id, COALESCE(c."name", p."entityId") AS name, c."status"::text AS status, ${SELECT_METRICS}
       ${base(`AND p."entityType" = 'CAMPAIGN' AND p."marketplace" = $3 AND ${clause}`,
        `"AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c."id" = p."localEntityId"`)}
       GROUP BY 1, 2, 3 ORDER BY 3 DESC NULLS LAST`, ...extra)
    const parent = await parentTotals(`AND p."entityType" = 'CAMPAIGN' AND p."marketplace" = $3 AND ${clause}`,
      extra, `"AmazonAdsDailyPerformance" p JOIN "Campaign" c ON c."id" = p."localEntityId"`)
    return done({
      level: 'portfolio', parentId: q.parentId, childLabel: 'Campaign', decompose: null,
      nodes: rows.map((r) => ({
        id: `campaign:${r.id}`,
        label: String(r.name),
        sub: String(r.status ?? ''),
        kind: 'campaign' as NodeKind,
        expandable: true,
        // GX.4 — the window travels with the link. Without it the campaign page seeds its own
        // last-30-days and the figure you clicked changes on arrival, which breaks the trace at
        // the first hop.
        href: `/marketing/ads/campaigns/${r.id}?startDate=${q.from}&endDate=${q.to}`,
        metrics: readMetrics(r),
      })),
      parentMetrics: parent, remainder: null, columns, caveats,
    })
  }

  // ── campaign → products OR targets ─────────────────────────────────────────
  const campaignId = parseNodeId(q.parentId ?? '').parts[0]
  if (!campaignId) throw new HierarchyError('a campaign node id is required', 400)

  const product = q.decompose === 'product'
  const join = product
    ? `"AmazonAdsDailyPerformance" p
       JOIN "AdProductAd" a ON a."id" = p."localEntityId"
       JOIN "AdGroup" g ON g."id" = a."adGroupId"`
    : `"AmazonAdsDailyPerformance" p
       JOIN "AdTarget" t ON t."id" = p."localEntityId"
       JOIN "AdGroup" g ON g."id" = t."adGroupId"`
  const idCol = product ? 'a."id"' : 't."id"'
  const labelCol = product ? `COALESCE(a."asin", p."entityId")` : `COALESCE(t."expressionValue", p."entityId")`
  const subCol = product ? `COALESCE(a."sku", '')` : `COALESCE(t."expressionType", t."kind", '')`
  const grain = product ? 'PRODUCT_AD' : 'AD_TARGET'

  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${idCol} AS id, ${labelCol} AS name, ${subCol} AS sub, ${SELECT_METRICS}
     ${base(`AND p."entityType" = '${grain}' AND g."campaignId" = $3`, join)}
     GROUP BY 1, 2, 3 ORDER BY 3 DESC NULLS LAST`, ...args, campaignId)

  // The parent is the CAMPAIGN row, not the sum of these — that is the whole point of the check.
  const parent = await parentTotals(`AND p."entityType" = 'CAMPAIGN' AND p."localEntityId" = $3`, [...args, campaignId])

  const nodes: HierarchyNode[] = rows.map((r) => ({
    id: `${q.decompose}:${r.id}`,
    label: String(r.name),
    sub: String(r.sub || '') || null,
    kind: (product ? 'product' : 'target') as NodeKind,
    expandable: false,
    href: `/marketing/ads/campaigns/${campaignId}?startDate=${q.from}&endDate=${q.to}&tab=${product ? 'ads' : 'ad-groups'}`,
    metrics: readMetrics(r),
  }))

  // ── the remainder ──────────────────────────────────────────────────────────
  let remainder: HierarchyResult['remainder'] = null
  const parentCost = parent?.cost ?? null
  if (parentCost != null) {
    const childCost = nodes.reduce((t, n) => t + (n.metrics.cost ?? 0), 0)
    const gap = parentCost - childCost
    // 🔴 A CENT is the only threshold. There used to be a 0.5%-of-parent floor beside it, and it
    // quietly broke the tree's one promise the moment the data got good: after GX.1 recovered the
    // missing product days, one campaign's children summed to €539.01 against a parent of €539.54
    // and NO remainder row was drawn, because €0.53 is 0.098% — under the floor. Fifty-three cents
    // of real money simply vanished from a grid whose entire claim is that every level adds up.
    //
    // The percentage floor was guarding against float noise, which the absolute one already does:
    // summing fifteen products cannot drift a cent. A small remainder is a small remainder, and it
    // gets a row saying so.
    if (gap > 0.01 && parentCost > 0) {
      const additive: Record<string, number | null> = {}
      for (const k of ADDITIVE) {
        const pv = parent[k]
        if (pv == null) { additive[k] = null; continue }
        additive[k] = Math.max(0, pv - nodes.reduce((t, n) => t + (n.metrics[k] ?? 0), 0))
      }
      const reason = product
        ? 'Days where the campaign spent and Amazon’s advertised-product report never landed. Recoverable days are re-requested by the gap-filler; days past Amazon’s ~95-day retention never can be.'
        : 'Spend on days before the targeting report began being ingested, or on targets Amazon did not report.'
      remainder = { amount: Number(gap.toFixed(2)), pctOfParent: gap / parentCost, reason }
      nodes.push({
        id: `remainder:${campaignId}:${q.decompose}`,
        label: product ? 'Unattributed to a product' : 'Unattributed to a target',
        sub: reason,
        kind: 'remainder',
        expandable: false,
        href: null,
        metrics: deriveMetrics(additive),
      })
      caveats.push(`${(remainder.pctOfParent * 100).toFixed(1)}% of this campaign’s spend has no ${q.decompose} attribution in this window and is shown as its own row rather than left for the eye to subtract.`)
      // 🔴 The two surfaces reconcile differently, and a reader who clicks through deserves to
      // know before the number changes. The campaign detail page ALLOCATES the campaign total
      // down by product-ad share so its children always sum to the parent; this reports what
      // Amazon actually reported per child and names the shortfall. Measured 2026-08-26: on a
      // window where the product feed is complete the two agree to the cent (€0.00 apart on
      // three campaigns), so this is not two definitions fighting — the remainder IS the measure
      // of where the feed is incomplete, and it shrinks to nothing as those days are recovered.
      caveats.push('Opening this campaign shows the same total, with these figures scaled up to fill the gap — that page allocates the campaign total across its children, while this one reports what Amazon reported for each and names the difference. Where the feed is complete the two agree exactly.')
    }
  }

  caveats.push(product
    ? 'A campaign expands into products OR targets, never both nested: each accounts for ~100% of the same spend, so nesting one inside the other would count it twice.'
    : 'Targeting rows begin 5 Jul 2026, when that report was first requested. A window reaching further back will show the earlier spend as unattributed.')

  return done({
    level: 'campaign', parentId: q.parentId, childLabel: product ? 'Product' : 'Target',
    decompose: q.decompose, nodes, parentMetrics: parent, remainder, columns, caveats,
  })

  // ── helpers ────────────────────────────────────────────────────────────────
  async function parentTotals(extra: string, params: unknown[], from = '"AmazonAdsDailyPerformance" p') {
    const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${SELECT_METRICS} FROM ${from} WHERE ${win} AND ${AMS} ${extra}`, ...params)
    return r[0] ? readMetrics(r[0]) : null
  }
  function done(x: Omit<HierarchyResult, 'elapsedMs'>): HierarchyResult {
    return { ...x, elapsedMs: Date.now() - started }
  }
}

export class HierarchyError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
