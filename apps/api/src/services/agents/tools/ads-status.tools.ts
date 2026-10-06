/**
 * ADS AUTONOMY AA-W2-12 (agent-results/5 §3b, §9; Owner 2026-10-06) — a real pause of Amazon Sponsored Products ads, and
 * switching back on what a Claude request paused. The old "never pause an ad" was the Owner's tactic for a TEMPORARY
 * stop, and it stays one: a temporary stop is low bids (suppress-campaign), because an ad serves again about a minute
 * after its bids go back, but only about an hour after a pause is lifted. These tools are for a real pause, where the
 * business allows that kind. Both follow ads-change-kit.ts — previewed first, refused and not queued when Amazon's write
 * gate would refuse it, run only as an approved request (as the approver, changeSetId = the approval), re-checked in
 * `execute` — and both are strategy-bound (ads-autonomy-kit.ts): one may run by the business's rule only inside its own
 * limits and the ads strategy, and by default every request waits for a person (maxItems 0).
 *
 *   pause-ads    campaigns, ad groups, keywords and product targets, product ads: ENABLED → PAUSED. A pause lets go of
 *                spend, so a halt does not hold it (the write carries `letsGo`, ads-mutation.service.ts isLetGoWrite).
 *                Undo: enable-ads.
 *   enable-ads   PAUSED → ENABLED, only for an ad whose last status change Nexus recorded is a pause a Claude request made
 *                (pause-ads) and that Amazon has not reported changed since: never one a person paused, in Nexus or at
 *                Amazon (the SYNC.1 lesson, ads-mutation.service.ts). An archived ad cannot be enabled (Amazon's rule).
 *                Spend resumes, so a halt stops it. Undo: pause-ads.
 *   archive-ads  AA-W2-13 — ENABLED or PAUSED → ARCHIVED, for good: Amazon cannot switch an archived ad on again (its
 *                API calls this delete: ads-api-client.ts SP_V3_ARCHIVE; the write carries `letsGo`, so the worker sends
 *                it as that delete, and a halt does not hold it — it lets go). The one irreversible tool the contract
 *                lets above ask (IRREVERSIBLE_AUTO): by default it runs nothing alone, raising its level and its limits
 *                takes two separate codes (claude-trust.service.ts), and the advice is to keep it at ask. No undo.
 *
 * One request names at most 100 ads. An ad already where it is asked to go is left as it is (counted); an ad Nexus cannot
 * change (not found, not Sponsored Products, archived, a draft, not at Amazon, gone at Amazon, a negative, or — for an
 * enable — not paused by a Claude request) refuses the whole request, naming it.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { updateAdGroupWithSync, updateAdTargetWithSync, updateCampaignWithSync, updateProductAdWithSync, type MutationOutcome } from '../../advertising/ads-mutation.service.js'
import { amountLabel, campaignCurrency, checkLiveReach, type LiveReach } from './ads-tool-guards.js'
import { approvedRun, notRun, reachNote, reachRefusal, recheck, spOnlyRefusal, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote, type KitItem } from './ads-autonomy-kit.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { STATUS_CAMPAIGN_SELECT, adGroupStatuses, adGroupsForStatus, externalStatusChanges, highestServingBids, servingUnder } from '../../advertising/ads-status-lookup.service.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

/** The most ads one request names. */
const MAX_ADS = 100
/** At most this many lines are listed in a preview; the rest are counted. */
const LINES_SHOWN = 20
/** The pause, enable and archive tools, by the kind of change. */
const TOOL = { pause: 'pause-ads', enable: 'enable-ads', archive: 'archive-ads' } as const
type Kind = keyof typeof TOOL
/** The statuses each kind changes from, and the one it writes. */
const MOVE: Record<Kind, { from: readonly string[]; to: 'PAUSED' | 'ENABLED' | 'ARCHIVED' }> = {
  pause: { from: ['ENABLED'], to: 'PAUSED' },
  enable: { from: ['PAUSED'], to: 'ENABLED' },
  archive: { from: ['ENABLED', 'PAUSED'], to: 'ARCHIVED' },
}
/** What every archive preview says: it is for good. */
const PERMANENT = 'PERMANENT: Amazon cannot switch an archived ad on again. Amazon\'s API calls this delete. Its reports keep its history. To advertise it again, a new one is created.'

const LEVELS = ['campaign', 'adGroup', 'target', 'productAd'] as const
type Level = (typeof LEVELS)[number]
const LEVEL_WORDS: Record<Level, [string, string]> = {
  campaign: ['campaign', 'campaigns'],
  adGroup: ['ad group', 'ad groups'],
  target: ['keyword or target', 'keywords and targets'],
  productAd: ['product ad', 'product ads'],
}
/** How Amazon's statuses read on a card. */
const STATUS_WORDS: Record<string, string> = { ENABLED: 'Enabled', PAUSED: 'Paused', ARCHIVED: 'Archived', DRAFT: 'Draft' }
/** The AdvertisingActionLog / AdDrift entity type of each level. */
const ENTITY_TYPE: Record<Level, 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'PRODUCT_AD'> = { campaign: 'CAMPAIGN', adGroup: 'AD_GROUP', target: 'AD_TARGET', productAd: 'PRODUCT_AD' }

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

// ── What a request names ──────────────────────────────────────────────────────────────────────────

interface StatusArgs {
  campaignIds?: string[]
  adGroupIds?: string[]
  targetIds?: string[]
  productAds?: Array<{ adGroupId: string; product: string }>
}

/** One ad a request names, as Nexus holds it now. */
interface Ad {
  level: Level
  id: string
  label: string
  status: string
  campaign: { id: string; name: string; marketplace: string | null; currency: string; status: string; dailyBudgetCents: number; type: string | null; adProduct: string | null }
  /** A product ad's ad group and the SKU or ASIN it was named by (its undo names it the same way). */
  adGroupId: string | null
  product?: string
  /** Why Nexus cannot change it at all (not by the kind of change), or null. */
  cannot: string | null
}

/** An ad as a change record stores it: enough to name it again in an undo. */
interface StatusItem {
  level: Level
  id: string
  status: string
  adGroupId?: string
  product?: string
}

const CAMPAIGN_SELECT = STATUS_CAMPAIGN_SELECT
type CampaignRow = { id: string; name: string; type: unknown; adProduct: string | null; marketplace: string | null; status: unknown; dailyBudget: unknown; dailyBudgetCurrency: string | null }

const campaignOf = (c: CampaignRow): Ad['campaign'] => ({
  id: c.id, name: c.name, marketplace: c.marketplace, currency: campaignCurrency(c), status: String(c.status),
  dailyBudgetCents: Math.round(Number(c.dailyBudget) * 100), type: c.type == null ? null : String(c.type), adProduct: c.adProduct,
})

/** Why an ad cannot be paused or enabled at all, whatever the kind; null when it may be. */
function cannotChange(c: CampaignRow, status: string, externalId: string | null, orphaned: boolean): string | null {
  const notSp = spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name })
  if (notSp) return notSp
  if (status === 'DRAFT') return 'it is a draft in Nexus and was never sent to Amazon'
  if (!externalId) return 'Nexus holds no Amazon id for it: it is not at Amazon'
  if (orphaned) return 'Amazon no longer has it (Nexus marked it gone)'
  return null
}

const unique = (ids: readonly string[] | undefined) => [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))]

/** Every ad the request names, in its order (campaigns, ad groups, targets, product ads), and what was not found. */
async function loadAds(a: StatusArgs): Promise<{ ads: Ad[]; missing: string[] }> {
  const campaignIds = unique(a.campaignIds), groupIds = unique(a.adGroupIds), targetIds = unique(a.targetIds)
  const productAds = [...new Map((a.productAds ?? []).map((p) => [`${p.adGroupId.trim()}|${p.product.trim()}`, { adGroupId: p.adGroupId.trim(), product: p.product.trim() }])).values()]
  const [campaigns, groups, targets, ads] = await Promise.all([
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { ...CAMPAIGN_SELECT, externalCampaignId: true } }) : [],
    adGroupsForStatus(groupIds),
    targetIds.length
      ? prisma.adTarget.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, kind: true, expressionValue: true, status: true, isNegative: true, externalTargetId: true, orphanedAt: true, adGroupId: true, adGroup: { select: { campaign: { select: CAMPAIGN_SELECT } } } },
      })
      : [],
    productAds.length
      ? prisma.adProductAd.findMany({
        where: {
          adGroupId: { in: [...new Set(productAds.map((p) => p.adGroupId))] },
          OR: [{ sku: { in: productAds.map((p) => p.product) } }, { asin: { in: productAds.map((p) => p.product) } }],
        },
        select: { id: true, sku: true, asin: true, status: true, externalAdId: true, adGroupId: true, adGroup: { select: { campaign: { select: CAMPAIGN_SELECT } } } },
        orderBy: { id: 'asc' },
      })
      : [],
  ])
  const out: Ad[] = []
  const missing: string[] = []
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]))
  const campaignRows = byId(campaigns), groupRows = byId(groups), targetRows = byId(targets)
  for (const id of campaignIds) {
    const c = campaignRows.get(id)
    if (!c) { missing.push(`campaign ${id}`); continue }
    out.push({ level: 'campaign', id, label: `campaign "${c.name}"`, status: String(c.status), campaign: campaignOf(c), adGroupId: null, cannot: cannotChange(c, String(c.status), c.externalCampaignId, false) })
  }
  for (const id of groupIds) {
    const g = groupRows.get(id)
    if (!g) { missing.push(`ad group ${id}`); continue }
    out.push({ level: 'adGroup', id, label: `ad group "${g.name}" (campaign "${g.campaign.name}")`, status: String(g.status), campaign: campaignOf(g.campaign), adGroupId: g.id, cannot: cannotChange(g.campaign, String(g.status), g.externalAdGroupId, !!g.orphanedAt) })
  }
  for (const id of targetIds) {
    const t = targetRows.get(id)
    if (!t) { missing.push(`target ${id}`); continue }
    const label = `${t.kind === 'KEYWORD' ? 'keyword' : 'target'} "${t.expressionValue}" (campaign "${t.adGroup.campaign.name}")`
    const cannot = t.isNegative
      ? 'it is a negative keyword: it blocks a search term and serves no ad (undo-ad-change retires one Claude created)'
      : cannotChange(t.adGroup.campaign, String(t.status), t.externalTargetId, !!t.orphanedAt)
    out.push({ level: 'target', id, label, status: String(t.status), campaign: campaignOf(t.adGroup.campaign), adGroupId: t.adGroupId, cannot })
  }
  for (const p of productAds) {
    // The SKU first, then the ASIN: a seller's ad is named by its SKU. The same ad named twice is one ad.
    const row = ads.find((ad) => ad.adGroupId === p.adGroupId && ad.sku === p.product) ?? ads.find((ad) => ad.adGroupId === p.adGroupId && ad.asin === p.product)
    if (!row) { missing.push(`the ad of ${p.product} in ad group ${p.adGroupId}`); continue }
    if (out.some((ad) => ad.level === 'productAd' && ad.id === row.id)) continue
    out.push({
      level: 'productAd', id: row.id, label: `the ad of ${row.sku ?? row.asin ?? p.product} (campaign "${row.adGroup.campaign.name}")`, status: String(row.status),
      campaign: campaignOf(row.adGroup.campaign), adGroupId: row.adGroupId, product: p.product, cannot: cannotChange(row.adGroup.campaign, String(row.status), row.externalAdId, false),
    })
  }
  return { ads: out, missing }
}

const itemOf = (ad: Ad): StatusItem => ({ level: ad.level, id: ad.id, status: ad.status, ...(ad.level === 'productAd' ? { adGroupId: ad.adGroupId ?? '', product: ad.product ?? '' } : {}) })

/** "a, b and 3 more". */
function named(list: string[], shown = 3): string {
  const head = list.slice(0, shown)
  return list.length > shown ? `${head.join(', ')} and ${list.length - shown} more` : head.join(', ')
}

// ── What a paused campaign or ad group holds, and what a restart serves again ─────────────────────

interface Holds { adGroups: number; targets: number; productAds: number }

/** The enabled ad groups, keywords and targets, and product ads that stop serving with each campaign and ad group paused. */
const holdsOf = (ads: Ad[], kind: Kind): Promise<Holds> =>
  servingUnder(ads.filter((a) => a.level === 'campaign').map((a) => a.id), ads.filter((a) => a.level === 'adGroup').map((a) => a.id), { paused: kind === 'archive' })

/** The highest bid that serves again with each ad switched back on (advertising/ads-status-lookup.service.ts). */
const highestBids = (ads: Ad[]): Promise<Map<string, number | null>> => highestServingBids(ads.map((a) => ({ level: a.level, id: a.id, adGroupId: a.adGroupId })))

// ── Who paused it (enable-ads) ────────────────────────────────────────────────────────────────────

type PausedBy =
  | { by: 'claude'; approvalId: string; at: Date }
  | { by: 'person' | 'rule' | 'unrecorded'; actor: string | null; at: Date }
  | { by: 'amazon'; approvalId: string; at: Date; seenAt: Date }
  | { by: 'none'; lastRecorded: string | null }

const statusOf = (payload: unknown): string | null => {
  const s = (payload as { status?: unknown } | null)?.status
  return typeof s === 'string' ? s : null
}

/**
 * For each paused ad, who paused it: the last status change Nexus recorded for it (AdvertisingActionLog) must be a pause a
 * Claude request made (its change set names a pause-ads change that names this ad), and Amazon must not have reported its
 * status changed outside Nexus since (an AdDrift EXTERNAL_CHANGE). Anything else is a person's (in Nexus, or at Amazon
 * — Seller Central — when no pause is on record) or an automation's, and enable-ads never switches it back on.
 */
async function pausesOnRecord(ads: Ad[]): Promise<Map<string, PausedBy>> {
  const out = new Map<string, PausedBy>()
  if (!ads.length) return out
  const byType = new Map<string, string[]>()
  for (const ad of ads) byType.set(ENTITY_TYPE[ad.level], [...(byType.get(ENTITY_TYPE[ad.level]) ?? []), ad.id])
  const logs = await prisma.advertisingActionLog.findMany({
    where: { OR: [...byType].map(([entityType, ids]) => ({ entityType, entityId: { in: ids } })) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { entityType: true, entityId: true, executionId: true, userId: true, payloadBefore: true, payloadAfter: true, rolledBackAt: true, createdAt: true },
    take: 5000,
  })
  const last = new Map<string, (typeof logs)[number]>()
  for (const log of logs) {
    const key = `${log.entityType}:${log.entityId}`
    if (last.has(key)) continue
    const from = statusOf(log.payloadBefore), to = statusOf(log.payloadAfter)
    if (to && from !== to) last.set(key, log)
  }
  const sets = [...new Set([...last.values()].map((l) => l.executionId).filter((id): id is string => !!id))]
  const changes = sets.length
    ? await prisma.agentChange.findMany({ where: { approvalId: { in: sets }, toolName: TOOL.pause }, select: { approvalId: true, after: true } })
    : []
  const drift = await externalStatusChanges([...byType].map(([entityType, ids]) => ({ entityType, ids })))
  for (const ad of ads) {
    const key = `${ENTITY_TYPE[ad.level]}:${ad.id}`
    const log = last.get(key)
    if (!log || statusOf(log.payloadAfter) !== 'PAUSED' || log.rolledBackAt) {
      out.set(`${ad.level}:${ad.id}`, { by: 'none', lastRecorded: log ? statusOf(log.payloadAfter) : null })
      continue
    }
    const claude = log.executionId && changes.some((c) => c.approvalId === log.executionId
      && (((c.after as { items?: StatusItem[] } | null)?.items) ?? []).some((i) => i.level === ad.level && i.id === ad.id))
    if (claude) {
      const seen = drift.find((d) => `${d.entityType}:${d.entityId}` === key && d.lastDetectedAt >= log.createdAt)
      out.set(`${ad.level}:${ad.id}`, seen ? { by: 'amazon', approvalId: log.executionId!, at: log.createdAt, seenAt: seen.lastDetectedAt } : { by: 'claude', approvalId: log.executionId!, at: log.createdAt })
      continue
    }
    const actor = log.userId ?? null
    out.set(`${ad.level}:${ad.id}`, { by: actor?.startsWith('user:') ? 'person' : actor?.startsWith('automation:') ? 'rule' : 'unrecorded', actor, at: log.createdAt })
  }
  return out
}

function pausedByWords(p: PausedBy): string {
  switch (p.by) {
    case 'claude': return `Claude request ${p.approvalId} paused it (${when(p.at)})`
    case 'amazon': return `Claude request ${p.approvalId} paused it (${when(p.at)}), but Amazon reported its status changed outside Nexus since (${when(p.seenAt)}): a person may have paused it at Amazon`
    case 'person': return `a person paused it in Nexus (${p.actor}, ${when(p.at)})`
    case 'rule': return `a Nexus rule or engine paused it (${p.actor}, ${when(p.at)})`
    case 'unrecorded': return `it was paused by a writer Nexus did not record (${when(p.at)})`
    case 'none': return p.lastRecorded
      ? `the last status Nexus recorded for it is ${STATUS_WORDS[p.lastRecorded] ?? p.lastRecorded}: it was paused at Amazon (Seller Central) since`
      : 'Nexus has no record of who paused it: it was paused at Amazon (Seller Central), or before Nexus kept a record'
  }
}

// ── The decision both tools make, in the dry run and again in `execute` ───────────────────────────

/** Where the writes land: every campaign they touch must answer the same, or the request is refused. */
async function reachOf(ads: Ad[], kind: Kind): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
  const campaigns = new Map<string, string | null>()
  for (const ad of ads) campaigns.set(ad.campaign.id, ad.campaign.marketplace)
  const profiles = new Set<string>()
  for (const [campaignId, marketplace] of [...campaigns].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // A pause or an archive lets go of spend: like a suppression, the halt does not hold it. An enable starts spend: the
    // halt binds.
    const reach = await checkLiveReach({ campaignId, marketplace, changes: [{ field: 'status', valueCents: null }], isSuppression: kind !== 'enable' })
    if (reach.reach === 'refused') return { refused: reach }
    if (reach.reach === 'live') profiles.add(reach.profileId)
  }
  // Some of it live, some in sandbox: it is live (that is what reaches Amazon), on every profile named.
  return { reach: profiles.size ? { reach: 'live', profileId: [...profiles].sort().join(',') } : { reach: 'sandbox' } }
}

/** A request decided: its preview, and every ad it changes (all of them, not only the lines shown). */
async function decide(kind: Kind, args: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; changing: Ad[] }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, changing: [] as Ad[] })
  const a = args as StatusArgs
  const asked = unique(a.campaignIds).length + unique(a.adGroupIds).length + unique(a.targetIds).length + (a.productAds?.length ?? 0)
  if (!asked) return refuse('Name the ads: campaignIds, adGroupIds, targetIds (keywords and product targets) or productAds (each by its ad group and SKU or ASIN).')
  if (asked > MAX_ADS) return refuse(`${asked} ads named: at most ${MAX_ADS} change in one request. Split them.`)
  const { ads, missing } = await loadAds(a)
  if (missing.length) return refuse(`Not queued: ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.`)
  const cannot = ads.filter((ad) => ad.cannot)
  if (cannot.length) return refuse(`Not queued: ${named(cannot.map((ad) => `${ad.label}: ${ad.cannot}`))}.`)
  const { from, to } = MOVE[kind]
  const archived = kind === 'archive' ? [] : ads.filter((ad) => ad.status === 'ARCHIVED')
  if (archived.length) {
    return refuse(`Not queued: ${named(archived.map((ad) => ad.label))} ${archived.length === 1 ? 'is' : 'are'} archived${kind === 'enable' ? ': Amazon cannot switch an archived ad on again; to advertise it again, a new one is created' : ' already: an archived ad serves no more'}.`)
  }
  const changing = ads.filter((ad) => from.includes(ad.status))
  const already = ads.filter((ad) => ad.status === to)
  if (!changing.length) return refuse(`Nothing would change: ${named(already.map((ad) => ad.label))} ${already.length === 1 ? 'is' : 'are'} already ${STATUS_WORDS[to].toLowerCase()}.`)

  // enable-ads — only what a Claude request paused; never what a person paused, in Nexus or at Amazon.
  const pausedBy = kind === 'enable' ? await pausesOnRecord(changing) : new Map<string, PausedBy>()
  const notClaude = kind === 'enable' ? changing.filter((ad) => pausedBy.get(`${ad.level}:${ad.id}`)?.by !== 'claude') : []
  if (notClaude.length) {
    return refuse(`Not queued: enable-ads switches back on only what a Claude request paused (pause-ads), never what a person paused, in Nexus or at Amazon. ${named(notClaude.map((ad) => `${ad.label}: ${pausedByWords(pausedBy.get(`${ad.level}:${ad.id}`) ?? { by: 'none', lastRecorded: null })}`))}.`)
  }

  const reach = await reachOf(changing, kind)
  if ('refused' in reach) return refuse(reachRefusal(reach.refused))
  const stored = reach.reach
  const [holds, bids] = await Promise.all([
    kind !== 'enable' ? holdsOf(changing, kind) : Promise.resolve(null),
    kind === 'enable' ? highestBids(changing) : Promise.resolve(new Map<string, number | null>()),
  ])

  // The facts the business's rule is judged on (strategy-bound): a campaign's status starts or stops its daily budget.
  const items: KitItem[] = changing.map((ad) => ({
    entity: { kind: ad.level, id: ad.id },
    change: { field: 'status', from: ad.status, to, ...(ad.level === 'campaign' ? { dailyBudgetCents: ad.campaign.dailyBudgetCents } : {}) },
  }))
  const facts = await buildLimitFacts({ tool: TOOL[kind], items, approvalId: ctx.approvalId ?? null, projectMonth: kind === 'enable' })

  const budgets: Record<string, number> = {}
  // The daily budgets that stop (a campaign that serves now) or start again.
  for (const ad of changing.filter((x) => x.level === 'campaign' && (kind === 'enable' || x.status === 'ENABLED'))) budgets[ad.campaign.currency] = (budgets[ad.campaign.currency] ?? 0) + ad.campaign.dailyBudgetCents
  const budgetWords = Object.entries(budgets).map(([cur, cents]) => amountLabel(cents, cur)).join(' and ')
  const highest = kind === 'enable'
    ? changing.reduce<{ cents: number; currency: string } | null>((best, ad) => {
      const cents = bids.get(`${ad.level}:${ad.id}`)
      return cents != null && (!best || cents > best.cents) ? { cents, currency: ad.campaign.currency } : best
    }, null)
    : null
  const counts = LEVELS.map((level) => [level, changing.filter((ad) => ad.level === level).length] as const).filter(([, n]) => n)
  const countWords = counts.map(([level, n]) => plural(n, LEVEL_WORDS[level])).join(', ')
  const one = new Set(changing.map((ad) => ad.campaign.id)).size === 1 ? changing[0].campaign : null

  const holdsWords = holds && (holds.adGroups || holds.targets || holds.productAds)
    ? [holds.adGroups ? plural(holds.adGroups, LEVEL_WORDS.adGroup) : '', holds.targets ? plural(holds.targets, LEVEL_WORDS.target) : '', holds.productAds ? plural(holds.productAds, LEVEL_WORDS.productAd) : ''].filter(Boolean).join(', ')
    : ''
  const effect = kind === 'archive'
    ? `Archives ${plural(changing.length, ['ad', 'ads'])} at Amazon, for good (${countWords}): ${named(changing.map((ad) => ad.label))}. ${PERMANENT}`
      + (holdsWords ? ` With them, everything they hold stops for good: ${holdsWords}.` : '')
      + (budgetWords ? ` ${budgetWords} of daily budget stops spending.` : '')
      + (already.length ? ` ${plural(already.length, ['ad', 'ads'])} already archived ${already.length === 1 ? 'is' : 'are'} left as ${already.length === 1 ? 'it is' : 'they are'}.` : '')
    : kind === 'pause'
    ? `Pauses ${plural(changing.length, ['ad', 'ads'])} at Amazon (${countWords}): ${named(changing.map((ad) => ad.label))}.`
      + (holdsWords ? ` With them stop ${holdsWords} they hold (their own status stays).` : '')
      + (budgetWords ? ` ${budgetWords} of daily budget stops spending.` : '')
      + ' enable-ads switches them back on; they serve again about an hour after that.'
      + (already.length ? ` ${plural(already.length, ['ad', 'ads'])} already paused ${already.length === 1 ? 'is' : 'are'} left as ${already.length === 1 ? 'it is' : 'they are'}.` : '')
    : `Switches ${plural(changing.length, ['ad', 'ads'])} back on at Amazon that a Claude request paused (${countWords}): ${named(changing.map((ad) => ad.label))}. Spend resumes`
      + (budgetWords ? `: ${budgetWords} of daily budget` : '')
      + (highest ? `${budgetWords ? ',' : ':'} the highest bid serving again ${amountLabel(highest.cents, highest.currency)}` : '')
      + '. They serve again about an hour after Amazon takes the change.'
      + (already.length ? ` ${plural(already.length, ['ad', 'ads'])} already enabled ${already.length === 1 ? 'is' : 'are'} left as ${already.length === 1 ? 'it is' : 'they are'}.` : '')

  const lines = changing.map((ad) => ({
    label: ad.label,
    marketplace: ad.campaign.marketplace,
    fromLabel: STATUS_WORDS[ad.status] ?? ad.status,
    toLabel: STATUS_WORDS[to],
    ...(kind === 'enable' ? { pausedBy: pausedByWords(pausedBy.get(`${ad.level}:${ad.id}`)!) } : {}),
    ...(kind === 'enable' && bids.get(`${ad.level}:${ad.id}`) != null ? { highestBidCents: bids.get(`${ad.level}:${ad.id}`), currency: ad.campaign.currency } : {}),
  }))
  // Every ad named, its status, and (for an enable) the pause it lifts and the spend it restarts: a move on any of them
  // after approval is caught, not only on the lines shown.
  const basis = createHash('sha256').update(ads.map((ad) => [
    ad.level, ad.id, ad.status,
    ...(kind === 'enable' && from.includes(ad.status) ? [(pausedBy.get(`${ad.level}:${ad.id}`) as { approvalId?: string } | undefined)?.approvalId ?? '', ad.level === 'campaign' ? ad.campaign.dailyBudgetCents : '', bids.get(`${ad.level}:${ad.id}`) ?? ''] : []),
  ].join(':')).join('|')).digest('base64url').slice(0, 32)

  return {
    changing,
    result: {
      ok: true,
      preview: {
        action: TOOL[kind],
        summary: effect,
        ...(one ? { campaign: { id: one.id, name: one.name, marketplace: one.marketplace } } : {}),
        totals: { changing: changing.length, [kind === 'pause' ? 'alreadyPaused' : kind === 'enable' ? 'alreadyEnabled' : 'alreadyArchived']: already.length },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        ...(holds ? { holds } : {}),
        ...(budgetWords ? { [kind === 'enable' ? 'budgetsResume' : 'budgetsStop']: budgets } : {}),
        ...(kind === 'archive' ? { permanent: PERMANENT } : {}),
        // enable-ads — every ad's highest bid serving again, in its campaign's currency (not only the lines shown).
        ...(kind === 'enable' ? { restartBids: Object.fromEntries(changing.map((ad) => [`${ad.level}:${ad.id}`, { cents: bids.get(`${ad.level}:${ad.id}`) ?? null, currency: ad.campaign.currency }])) } : {}),
        basis,
        reach: stored,
        reachNote: reachNote(stored),
        warning: kind === 'archive'
          ? `${PERMANENT} To stop an ad for a while, lower its bids (suppress-campaign) or pause it (pause-ads) instead.`
          : kind === 'pause'
          ? 'A real pause: a paused ad serves again only about an hour after enable-ads switches it on. To stop it for a while, lower its bids instead (suppress-campaign): it serves again about a minute after they go back.'
          : 'Spend resumes: these ads compete in auctions again with the bids and budgets shown.',
        limitFacts: facts,
        limitsNote: limitsNote(facts),
        effect,
      },
    },
  }
}

// ── Limits: what may run by the business's rule ───────────────────────────────────────────────────

/**
 * The Claude limits of both tools: the kit's (maxItems 0 — every request waits for a person until he types a number;
 * one change of an ad by rule a day; never an ad an engine also moves) and the kinds of ad it may change by rule.
 */
const STATUS_LIMITS = adKitLimits({ maxItems: 0 }, {
  levels: z.array(z.enum(LEVELS)).max(LEVELS.length).default([...LEVELS])
    .describe('the kinds of ad it may change by rule: campaign, adGroup, target (keywords and product targets), productAd; fewer is tighter'),
})

/** The kinds of ad the business's limits let change by rule: an ad of another kind waits for a person. */
function levelsRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const facts = limitFactsOf(preview)
  if (!facts) return null
  const allowed = new Set(Array.isArray(limits.levels) ? (limits.levels as string[]) : LEVELS)
  const kinds = [...new Set(facts.this.entities.map((key) => key.slice(0, key.indexOf(':'))))].filter((level) => !allowed.has(level))
  return kinds.length
    ? `it changes ${kinds.map((level) => LEVEL_WORDS[level as Level]?.[1] ?? level).join(' and ')}, which this tool's limits do not let change by rule (levels); a person decides`
    : null
}

/**
 * archive-ads — C3 for every ad it archives, a paused one too (whose archive stops no spend today, so the kit does not
 * count it as a cut): never a protected product's ads, by rule.
 */
function archiveProtectedRefusal(preview: unknown): string | null {
  const facts = limitFactsOf(preview)
  if (!facts) return null
  for (const scope of Object.values(facts.scopes)) {
    if (scope.limits.protect !== true || !scope.sources.protect) continue
    return `${scope.label}: the ads strategy protects a product it advertises (${strategyWords(scope.sources.protect)}), so archiving its ads waits for a person`
  }
  return null
}

/**
 * enable-ads — a restart never brings back a bid above the ads strategy's highest bid where it lands: each ad's highest
 * bid serving again against the band of its scope (an ad group or a campaign takes the safer value across its products).
 */
function restartBidRefusal(preview: unknown): string | null {
  const facts = limitFactsOf(preview)
  if (!facts) return null
  const bids = (preview as { restartBids?: Record<string, { cents?: unknown; currency?: unknown }> } | null)?.restartBids
  if (!bids) return 'the preview does not say which bids serve again; a person decides'
  for (const key of facts.this.entities) {
    const bid = bids[key]
    if (!bid) return `the preview does not say which bid serves again for ${facts.labels[key] ?? key}; a person decides`
    const scope = facts.scopes[facts.entityScopes[key] ?? '']
    const max = scope?.limits.maxBidCents
    if (typeof bid.cents !== 'number' || max == null || bid.cents <= max || !scope.sources.maxBidCents) continue
    const currency = typeof bid.currency === 'string' ? bid.currency : 'EUR'
    return `${facts.labels[key] ?? key} would serve again with a bid of ${amountLabel(bid.cents, currency)}, above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBidCents)}); a person decides`
  }
  return null
}

// ── Running an approved request ───────────────────────────────────────────────────────────────────

/** What is stored NOW for each ad of a change record, in its own shape (the undo guard compares it with `after`). */
async function statusesNow(change: ToolChange): Promise<{ items: StatusItem[] }> {
  const items = ((change.after as { items?: StatusItem[] } | null)?.items) ?? []
  const ids = (level: Level) => items.filter((i) => i.level === level).map((i) => i.id)
  const [campaigns, groups, targets, ads] = await Promise.all([
    ids('campaign').length ? prisma.campaign.findMany({ where: { id: { in: ids('campaign') } }, select: { id: true, status: true } }) : [],
    adGroupStatuses(ids('adGroup')),
    ids('target').length ? prisma.adTarget.findMany({ where: { id: { in: ids('target') } }, select: { id: true, status: true } }) : [],
    ids('productAd').length ? prisma.adProductAd.findMany({ where: { id: { in: ids('productAd') } }, select: { id: true, status: true } }) : [],
  ])
  const now = new Map<string, string>()
  for (const [level, rows] of [['campaign', campaigns], ['adGroup', groups], ['target', targets], ['productAd', ads]] as const) {
    for (const r of rows as Array<{ id: string; status: unknown }>) now.set(`${level}:${r.id}`, String(r.status))
  }
  return { items: items.map((i) => ({ ...i, status: now.get(`${i.level}:${i.id}`) ?? 'NOT_FOUND' })) }
}

/** The arguments that name these ads again (an undo asks the other tool for exactly them). */
function argsOf(items: StatusItem[]): Record<string, unknown> {
  const of = (level: Level) => items.filter((i) => i.level === level).map((i) => i.id)
  const productAds = items.filter((i) => i.level === 'productAd').map((i) => ({ adGroupId: i.adGroupId ?? '', product: i.product ?? '' }))
  return {
    ...(of('campaign').length ? { campaignIds: of('campaign') } : {}),
    ...(of('adGroup').length ? { adGroupIds: of('adGroup') } : {}),
    ...(of('target').length ? { targetIds: of('target') } : {}),
    ...(productAds.length ? { productAds } : {}),
  }
}

/** C2 — undo of a pause asks enable-ads for the same ads, and the other way round. */
function undoBy(tool: string, status: string, why: string): ToolUndo {
  return {
    current: statusesNow,
    request(change) {
      const items = (((change.before as { items?: StatusItem[] } | null)?.items) ?? []).filter((i) => i.status === status)
      if (!items.length) return { refusal: 'This change does not record the ads it changed.' }
      return { tool, args: { ...argsOf(items), why } }
    },
  }
}

async function runApproved(kind: Kind, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, changing } = await decide(kind, args, ctx)
  const refusal = recheck(ctx, fresh, ['totals', 'basis'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { reach: StoredReach; effect: string }
  // AA-W2-1 — a run the business's rule decided says so in the ads audit.
  const said = String(args.why ?? '').trim() || (kind === 'pause' ? 'a real pause' : kind === 'archive' ? 'archived for good' : 'switching back on what Claude paused')
  const run = approvedRun(ctx, ctx.decidedVia === 'auto' ? `${said} (run by rule)` : said)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const { to } = MOVE[kind]
  // A pause or an archive carries `letsGo`: it lets go of spend, so a halt does not hold it at Amazon's door either
  // (isLetGoWrite), and the worker sends an archive as Amazon's delete operation.
  const common = { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual, ...(kind !== 'enable' ? { letsGo: true } : {}) }
  const failed: string[] = []
  for (const ad of changing) {
    let out: MutationOutcome
    if (ad.level === 'campaign') out = await updateCampaignWithSync({ campaignId: ad.id, patch: { status: to }, ...common, confirmOwnLimits: run.confirmOwnLimits })
    else if (ad.level === 'adGroup') out = await updateAdGroupWithSync({ adGroupId: ad.id, patch: { status: to }, ...common, confirmOwnLimits: run.confirmOwnLimits })
    else if (ad.level === 'target') out = await updateAdTargetWithSync({ adTargetId: ad.id, patch: { status: to }, ...common, confirmOwnLimits: run.confirmOwnLimits })
    else out = await updateProductAdWithSync({ productAdId: ad.id, status: to, ...common })
    if (!out.ok) failed.push(`${ad.label} (${out.error ?? 'refused'})`)
  }
  const items = changing.map(itemOf)
  const change = { before: { changeSetId: run.changeSetId, items }, after: await statusesNow({ before: null, after: { items } }) }
  const done = changing.length - failed.length
  const data = {
    [kind === 'pause' ? 'paused' : kind === 'enable' ? 'enabled' : 'archived']: done,
    failed: failed.length,
    reach: p.reach,
    changeSetId: run.changeSetId,
    note: 'Queued for Amazon: each change is sent after the 5-minute cancel window. approval-status follows them.',
  }
  if (failed.length) {
    const what = kind === 'pause' ? 'paused' : kind === 'enable' ? 'switched on' : 'archived'
    return { ok: false, data, change, error: `Partly run: ${done} ${what}, ${failed.length} refused by the write — ${named(failed)}. The rest stays as it was${kind === 'archive' ? '' : '; undo-change puts back what ran'}.` }
  }
  return { ok: true, data, change }
}

// ── The tools ─────────────────────────────────────────────────────────────────────────────────────

const idList = (what: string) => z.array(z.string().trim().min(1).max(64)).max(MAX_ADS).optional().describe(what)

const STATUS_INPUT = z.object({
  campaignIds: idList('campaigns: Nexus campaign ids (campaignId in ad-campaigns)'),
  adGroupIds: idList('ad groups: Nexus ad group ids (adGroupId in ad-targets)'),
  targetIds: idList('keywords and product targets: Nexus target ids (targetId in ad-targets)'),
  productAds: z.array(z.object({
    adGroupId: z.string().trim().min(1).max(64).describe('the ad group the ad is in (adGroupId in ad-targets)'),
    product: z.string().trim().min(1).max(64).describe('the SKU or ASIN the ad advertises'),
  })).max(MAX_ADS).optional().describe('product ads, each named by its ad group and the SKU or ASIN it advertises'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})

const pauseAds: AgentTool = {
  name: TOOL.pause,
  title: 'Pause Amazon ads',
  input: STATUS_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: STATUS_LIMITS,
  withinLimits: (preview, limits) => commonRefusal(preview, limits) ?? levelsRefusal(preview, limits),
  undo: undoBy(TOOL.enable, 'ENABLED', 'undo of a pause'),
  description:
    `Pause Amazon Sponsored Products ads for real: campaigns, ad groups, keywords and product targets, or product ads (up to ${MAX_ADS} `
    + 'in one request). Only when a real pause is meant: a paused ad serves again about an hour after it is switched back '
    + 'on. To stop an ad for a while, lower its bids instead (suppress-campaign, or a lower bid): it serves again about a '
    + 'minute after they go back. A person approves it in Nexus, unless the business lets it run by its rule inside its '
    + 'limits and the ads strategy. The preview lists each ad from Enabled to Paused, what a paused campaign or ad group '
    + 'holds, the daily budget that stops, where it lands (live at Amazon or sandbox) and each limit with where it comes '
    + 'from. Refused, and not queued, when an ad is not found, archived, a draft or not Sponsored Products, or when '
    + 'Amazon\'s write gate would refuse it (a halt does not block a pause: it only lets go). enable-ads (or undo-change) '
    + 'switches them back on.',
  async handler(args, ctx) {
    return (await decide('pause', args, ctx)).result
  },
  async execute(args, ctx) {
    return runApproved('pause', args, ctx)
  },
}

const enableAds: AgentTool = {
  name: TOOL.enable,
  title: 'Switch paused Amazon ads on',
  input: STATUS_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: STATUS_LIMITS,
  withinLimits: (preview, limits) => commonRefusal(preview, limits) ?? levelsRefusal(preview, limits) ?? restartBidRefusal(preview),
  undo: undoBy(TOOL.pause, 'PAUSED', 'undo of an enable'),
  description:
    `Switch Amazon Sponsored Products ads back on that a Claude request paused (pause-ads): campaigns, ad groups, keywords `
    + `and product targets, or product ads (up to ${MAX_ADS}). Never an ad a person paused, in Nexus or at Amazon (Seller `
    + 'Central): that stays theirs to switch on. An archived ad cannot be switched on at all (Amazon\'s rule). Spend '
    + 'resumes: the preview lists each ad from Paused to Enabled, who paused it, the daily budget and the highest bid that '
    + 'serve again, this month\'s forecast where a monthly cap is set, and where it lands. A person approves it in Nexus, '
    + 'unless the business lets it run by its rule inside its limits and the ads strategy. Refused, and not queued, when '
    + 'Amazon\'s write gate would refuse it (a halt stops an enable). pause-ads (or undo-change) pauses them again.',
  async handler(args, ctx) {
    return (await decide('enable', args, ctx)).result
  },
  async execute(args, ctx) {
    return runApproved('enable', args, ctx)
  },
}

const archiveAds: AgentTool = {
  name: TOOL.archive,
  title: 'Archive Amazon ads for good',
  input: STATUS_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Amazon cannot switch an archived ad on again: nothing puts it back.
  reversibility: 'none',
  maxClaudeTrust: 'auto',
  limits: STATUS_LIMITS,
  withinLimits: (preview, limits) => commonRefusal(preview, limits) ?? levelsRefusal(preview, limits) ?? archiveProtectedRefusal(preview),
  description:
    `Archive Amazon Sponsored Products ads for good: campaigns, ad groups, keywords and product targets, or product ads (up `
    + `to ${MAX_ADS}), enabled or paused. PERMANENT: Amazon cannot switch an archived ad on again (its API calls this `
    + 'delete); reports keep its history, and to advertise it again a new one is created. Only when it is meant for good: '
    + 'to stop an ad for a while lower its bids (suppress-campaign), for a real pause use pause-ads. A person approves it in '
    + 'Nexus, unless the business lets it run by its rule inside its limits and the ads strategy (by default nothing is '
    + 'archived by rule, and the advice is to keep it that way). The preview lists each ad, what a campaign or ad group '
    + 'holds that stops with it, the daily budget that stops, and where it lands. Refused, and not queued, when an ad is '
    + 'not found, a draft or not Sponsored Products, or when Amazon\'s write gate would refuse it (a halt does not block an '
    + 'archive: it only lets go). It cannot be undone.',
  async handler(args, ctx) {
    return (await decide('archive', args, ctx)).result
  },
  async execute(args, ctx) {
    return runApproved('archive', args, ctx)
  },
}

export const ADS_STATUS_TOOLS: AgentTool[] = [pauseAds, enableAds, archiveAds]
