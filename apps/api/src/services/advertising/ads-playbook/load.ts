/**
 * ADS PLAYBOOK PB-2 — the reads behind the playbook resolver and its views, in batches: a market's playbook rows (and
 * which of their scopes still exist), the business's templates, the history, the links a product's playbook holds, and
 * a capture's source (live campaigns through the blueprint reader, their hourly plans, the floor targets, the
 * portfolio). The catalog (parents, categories, ancestry) is the ads strategy's own loader (ads-strategy/load.ts),
 * reused. Every query goes through the business-scoped client: row-level security keeps each read inside the business.
 */
import prisma from '../../../db.js'
import { loadSourceCampaigns, type CampaignSelector } from '../ads-blueprint.service.js'
import { liveScopes } from '../ads-strategy/load.js'
import { indexPlaybook, type PlaybookIndex, type PlaybookOrphan, type PlaybookRow, type TemplateRow } from './resolve.js'
import type { CaptureSchedule } from './capture.js'
import type { SourceCampaign } from '../../ads-core/ads-blueprint.js'

export const PLAYBOOK_ROW_SELECT = {
  id: true, channel: true, market: true, level: true, scopeId: true, label: true, version: true, templateId: true, overrides: true,
  enrolled: true, state: true, nameToken: true, portfolioName: true, dailyBudgetCents: true, baseBidCents: true, terms: true,
  phaseRecipes: true, compiledVersion: true, compiledTemplateVersion: true, updatedAt: true, updatedBy: true,
} as const

export const TEMPLATE_ROW_SELECT = {
  id: true, channel: true, adProduct: true, name: true, version: true, status: true, doc: true, capturedFrom: true, updatedAt: true, updatedBy: true,
} as const

/** Every playbook row of one market and channel, market row first, then categories, then products. */
export async function loadPlaybookRows(market: string, channel = 'AMAZON'): Promise<PlaybookRow[]> {
  return prisma.adsPlaybook.findMany({ where: { channel, market }, select: PLAYBOOK_ROW_SELECT, orderBy: [{ level: 'asc' }, { label: 'asc' }] })
}

/** Every template of the business (a handful), by name. */
export async function loadTemplates(channel = 'AMAZON'): Promise<TemplateRow[]> {
  return prisma.adsPlaybookTemplate.findMany({ where: { channel }, select: TEMPLATE_ROW_SELECT, orderBy: { name: 'asc' } })
}

/** The markets that hold at least one playbook row, for a channel. */
export async function playbookMarkets(channel = 'AMAZON'): Promise<string[]> {
  const rows = await prisma.adsPlaybook.findMany({ where: { channel }, distinct: ['market'], select: { market: true } })
  return rows.map((r) => r.market).sort()
}

/** One market's playbook, indexed, with the rows whose category or product is gone set apart. */
export async function loadPlaybookIndex(market: string, channel = 'AMAZON'): Promise<{ index: PlaybookIndex; orphans: PlaybookOrphan[]; rows: PlaybookRow[]; templates: TemplateRow[] }> {
  const [rows, templates] = await Promise.all([loadPlaybookRows(market, channel), loadTemplates(channel)])
  const live = rows.some((r) => r.level !== 'MARKET') ? await liveScopes(rows) : { categories: new Set<string>(), products: new Set<string>() }
  return { ...indexPlaybook(market, rows, templates, live, channel), rows, templates }
}

/** The history: one template's versions, or a market's playbook rows' (one scope's, when `scope` is given), newest first. */
export async function playbookVersions(
  where: { kind: 'template'; refId?: string } | { kind: 'playbook'; market: string; scope: { level: string; scopeId: string } | null },
  limit: number,
) {
  return prisma.adsPlaybookVersion.findMany({
    where: where.kind === 'template'
      ? { kind: 'template', ...(where.refId ? { refId: where.refId } : {}) }
      : { kind: 'playbook', market: where.market, ...(where.scope ? { level: where.scope.level, scopeId: where.scope.scopeId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    take: limit,
    select: {
      id: true, kind: true, refId: true, version: true, market: true, level: true, scopeId: true, op: true, values: true, changes: true,
      direction: true, via: true, approvalId: true, actor: true, actorUserId: true, stepUpAt: true, reason: true, createdAt: true,
    },
  })
}

/** What the given PRODUCT playbook rows own (slot campaigns, compiled rules, hourly-plan groups, the portfolio). */
export async function playbookLinks(playbookIds: readonly string[]) {
  if (!playbookIds.length) return []
  return prisma.adsPlaybookLink.findMany({
    where: { playbookId: { in: [...playbookIds] } },
    orderBy: [{ kind: 'asc' }, { key: 'asc' }],
    select: { playbookId: true, kind: true, key: true, refId: true, adGroupId: true, origin: true, compiledVersion: true, updatedAt: true },
  })
}

/**
 * PB-10 — every bid a sync of this playbook planned for a keyword or target it added at the floor (its version rows op
 * sync, `sync.plannedBids`), the newest plan for each, by AdTarget.id. START gives them (ads-playbook/sync.ts).
 */
export async function plannedSyncBids(playbookId: string): Promise<Map<string, number>> {
  const rows = await prisma.adsPlaybookVersion.findMany({ where: { kind: 'playbook', refId: playbookId, op: 'sync' }, orderBy: { version: 'asc' }, select: { changes: true } })
  const out = new Map<string, number>()
  for (const r of rows) {
    for (const c of (Array.isArray(r.changes) ? r.changes : []) as Array<{ field?: unknown; to?: unknown }>) {
      if (c?.field !== 'sync.plannedBids' || !Array.isArray(c.to)) continue
      for (const b of c.to as Array<{ adTargetId?: unknown; startBidCents?: unknown }>) if (typeof b?.adTargetId === 'string' && typeof b.startBidCents === 'number') out.set(b.adTargetId, b.startBidCents)
    }
  }
  return out
}

/**
 * PB-10 — the keywords and targets a sync of this playbook added at the floor that still bid it (START has not given
 * them their planned bid): no home yet (isolation.ts).
 */
export async function waitingSyncedTargets(playbookId: string, floorCents: number): Promise<Set<string>> {
  const planned = await plannedSyncBids(playbookId)
  if (!planned.size) return new Set()
  const rows = await prisma.adTarget.findMany({ where: { id: { in: [...planned.keys()] }, isNegative: false, bidCents: { lte: floorCents } }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

/** The names and states of linked campaigns, for the links a view shows. */
export async function campaignNames(campaignIds: readonly string[]) {
  if (!campaignIds.length) return new Map<string, { name: string; status: string; marketplace: string | null }>()
  const rows = await prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true, status: true, marketplace: true } })
  return new Map(rows.map((c) => [c.id, { name: c.name, status: String(c.status), marketplace: c.marketplace }]))
}

export interface CaptureSource {
  campaigns: Array<{ id: string; source: SourceCampaign; marketplace: string | null; portfolioId: string | null }>
  schedules: CaptureSchedule[]
  floorTargets: Set<string>
  /** The portfolio every campaign shares, with its name; null when they share none. */
  portfolio: { id: string; name: string | null } | null
}

/**
 * A capture's source: the selected campaigns as the blueprint reader gives them (archived targets left out), their
 * hourly plans (AdSchedule), the RankTarget keys that hold bids at the floor, and their shared portfolio.
 */
export async function loadCaptureSource(selector: Pick<CampaignSelector, 'campaignIds' | 'portfolioId' | 'namePrefix' | 'marketplace'>): Promise<CaptureSource> {
  const { campaigns, ids } = await loadSourceCampaigns({ ...selector, excludeArchivedTargets: true })
  const [facts, schedules, floors] = await Promise.all([
    ids.length ? prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true, portfolioId: true } }) : Promise.resolve([]),
    ids.length
      ? prisma.adSchedule.findMany({ where: { campaignId: { in: ids } }, select: { campaignId: true, windows: true, defaultTargetKey: true, timezone: true, targetOverrides: true } })
      : Promise.resolve([]),
    prisma.rankTarget.findMany({ where: { pause: true }, select: { key: true } }),
  ])
  const byId = new Map(facts.map((f) => [f.id, f]))
  const portfolioIds = [...new Set(facts.map((f) => f.portfolioId))]
  let portfolio: CaptureSource['portfolio'] = null
  if (portfolioIds.length === 1 && portfolioIds[0]) {
    const named = await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: portfolioIds[0] }, select: { name: true } })
    portfolio = { id: portfolioIds[0], name: named?.name ?? null }
  }
  return {
    campaigns: ids.map((id, i) => ({ id, source: campaigns[i], marketplace: byId.get(id)?.marketplace ?? null, portfolioId: byId.get(id)?.portfolioId ?? null })),
    schedules,
    floorTargets: new Set(floors.map((f) => f.key)),
    portfolio,
  }
}
