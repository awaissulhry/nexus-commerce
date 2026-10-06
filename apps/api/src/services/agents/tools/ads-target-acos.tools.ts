/**
 * MCP phase 3 T5 — set-campaign-target-acos: the target ACoS of Amazon campaigns, so a market can get one target (the
 * same target on every campaign of that market). Until now only a person could set it, on Ads › Rules & Automation ›
 * Apply Rules, bulk action "Target ACoS" (typed as a percent). That action calls
 * `PATCH /advertising/campaigns/:id/automation { targetAcos }`, i.e. `setBidAutomation` (campaign-settings.service.ts),
 * once per campaign: this tool calls the same service, the same way.
 *
 *   unit      typed as a percent, like the screen (0.01–100; a list may put back any stored value, 0–500); STORED as a
 *             FRACTION in `Campaign.dynamicBidding.targetAcos` (25 % → 0.25), the unit every reader expects.
 *   read by   Nexus's bid optimiser (ads autonomy W0): auto-bid, autopilot plans and the target-ACoS bid rules move the
 *             campaign's keyword bids toward it — unless a rule or an autopilot plan sets a target of its own — ahead of
 *             the business default (tune-ad-engine account-target-acos) and profit data; a target of 0 % is skipped
 *             there (ads-target-acos-resolver.ts). Their writes reach Amazon only on campaigns on the live-write allowlist.
 *             Also the external bidding engine (services/bidding-engine, a separate service), when it runs, as its
 *             ACoS goal (`GET /api/internal/bidding/contexts`, bidding-bridge.service.ts; 30 % when unset; in live
 *             ads mode only allowlisted campaigns). Shown in Apply Rules, the bid grid ("Goal"), suggestions and
 *             ad-campaigns.
 *   reach     Nexus only: nothing is sent to Amazon (openWorld false, as set-campaign-live-writes).
 *   audit     one AdvertisingActionLog row per campaign, `set_campaign_goal` as `PUT /campaigns/:id/goal` writes it, as
 *             the approver, with the request and its why in the note. Not stamped as a change set and no Amazon
 *             status: undo-ad-change has nothing to put back at Amazon. Undo is this tool, with the old values.
 *   trust     ADS AUTONOMY AA-W2-8 — strategy-bound, up to `auto`: a Nexus record, fully reversible — but Nexus's
 *             auto-bid and the external engine bid toward it, so a higher target lets bids rise. By rule only inside the
 *             tool's limits (each move in points; a raise is 0 points by default, so every raise waits for a person) and
 *             the ads strategy where each campaign lands (ads-autonomy-kit.ts C1–C7), and a raise never past the ACoS
 *             target the strategy sets there; a cleared or 0 % target (the optimiser falls back) never runs by rule.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { setBidAutomation } from '../../advertising/campaign-settings.service.js'
import { adsMode } from '../../advertising/ads-api-client.js'
import { approvedRun, BY_RULE_WORDS, notRun, ruleFactsFor, ruleRefusal, strategyFactsMoney } from './ads-change-kit.js'
import { adKitLimits, limitFactsOf, STEP_POINT_LIMITS, type KitItem } from './ads-autonomy-kit.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

/** The most campaigns one request sets (a list, or a market): the tool contract bounds every list to 250. */
const MAX_CAMPAIGNS = 250
/** Lines the approval card shows; the full list is in `campaigns`. */
const LINES_SHOWN = 20
/**
 * The last fallback when a campaign has no target: Nexus's bid optimiser's flat 30 % (after the business default and
 * profit data) and the external bidding engine's (bidding-bridge.service.ts DEFAULT_TARGET_ACOS).
 */
const ENGINE_FALLBACK_PCT = 30
/** What Nexus's bid optimiser uses for a campaign without a target of its own (ads-target-acos-resolver.ts). */
const NO_TARGET_WORDS = `Nexus uses the business default, profit data or ${ENGINE_FALLBACK_PCT}%`
/** The rule action that can set a campaign target too (automation-action-handlers.ts). */
const RULE_ACTION = 'set_campaign_target_acos'

type Fraction = number | null

/** The stored fraction as a percent, to 2 decimals (0.25 → 25); null when unset. */
const pctOf = (fraction: Fraction): number | null => (fraction == null ? null : Math.round(fraction * 10_000) / 100)
/** A percent as the stored fraction (25 → 0.25), to 4 decimals. */
const fractionOf = (pct: number | null): Fraction => (pct == null ? null : Math.round(pct * 100) / 10_000)
const round2 = (n: number) => Math.round(n * 100) / 100
const fromWords = (pct: number | null) => (pct == null ? `none (${NO_TARGET_WORDS})` : `${pct}%`)
const toWords = (pct: number | null) => (pct == null ? `none (cleared: ${NO_TARGET_WORDS})` : `${pct}%`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The target a campaign stores now: `dynamicBidding.targetAcos`, a fraction, or null. */
function storedTarget(dynamicBidding: unknown): Fraction {
  const v = (dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** What each named campaign stores now, keys sorted: what a change recorded, and what its undo compares. */
async function targetsNow(campaignIds: string[]): Promise<{ targets: Record<string, Fraction> }> {
  const rows = campaignIds.length
    ? await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dynamicBidding: true } })
    : []
  return { targets: Object.fromEntries(rows.sort((x, y) => (x.id < y.id ? -1 : 1)).map((r) => [r.id, storedTarget(r.dynamicBidding)])) }
}

const CAMPAIGN_SELECT = { id: true, name: true, marketplace: true, status: true, liveBidWritesEnabled: true, dynamicBidding: true } as const
type CampaignRow = { id: string; name: string; marketplace: string | null; status: string; liveBidWritesEnabled: boolean; dynamicBidding: unknown }

interface TargetArgs {
  campaignIds?: string[]
  market?: string
  targetAcosPct?: number
  targets?: Array<{ campaignId: string; targetAcosPct: number | null }>
}

type Mode = 'campaigns' | 'market' | 'list'

/** The campaigns a request names, each with the target asked (percent; null clears) — or why it cannot be read. */
async function askedTargets(a: TargetArgs): Promise<
  { mode: Mode; asked: Array<{ campaign: CampaignRow; toPct: number | null }>; archivedLeftOut: number } | { refusal: string }
> {
  const given = [a.campaignIds?.length ? 'campaignIds' : null, a.market ? 'market' : null, a.targets?.length ? 'targets' : null].filter(Boolean)
  if (given.length !== 1) {
    return { refusal: 'Name the campaigns one way: campaignIds (from ad-campaigns) or a market, with targetAcosPct; or targets (each campaign with its own target).' }
  }
  const notFound = (ids: string[]) => ({ refusal: `Campaign not found: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''} (use campaignId from ad-campaigns).` })

  if (a.targets?.length) {
    if (a.targetAcosPct != null) return { refusal: 'Give targets (each campaign with its own target), or campaigns and one targetAcosPct — not both.' }
    const wanted = new Map<string, number | null>()
    for (const t of a.targets) {
      const pct = t.targetAcosPct == null ? null : round2(Number(t.targetAcosPct))
      if (wanted.has(t.campaignId) && wanted.get(t.campaignId) !== pct) return { refusal: `Campaign ${t.campaignId} is named twice with different targets.` }
      wanted.set(t.campaignId, pct)
    }
    const rows = await prisma.campaign.findMany({ where: { id: { in: [...wanted.keys()] } }, select: CAMPAIGN_SELECT })
    const found = new Map(rows.map((r) => [r.id, r as CampaignRow]))
    const missing = [...wanted.keys()].filter((id) => !found.has(id))
    if (missing.length) return notFound(missing)
    return { mode: 'list', asked: [...wanted].map(([id, toPct]) => ({ campaign: found.get(id)!, toPct })), archivedLeftOut: 0 }
  }

  if (a.targetAcosPct == null) return { refusal: 'Give targetAcosPct: the target ACoS in percent (e.g. 25 for 25%), above 0 and at most 100.' }
  const toPct = round2(Number(a.targetAcosPct))
  if (!(toPct > 0)) return { refusal: 'targetAcosPct must be above 0 (at most 100).' }

  if (a.campaignIds?.length) {
    const ids = [...new Set(a.campaignIds)]
    const rows = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: CAMPAIGN_SELECT })
    const found = new Map(rows.map((r) => [r.id, r as CampaignRow]))
    const missing = ids.filter((id) => !found.has(id))
    if (missing.length) return notFound(missing)
    return { mode: 'campaigns', asked: ids.map((id) => ({ campaign: found.get(id)!, toPct })), archivedLeftOut: 0 }
  }

  // A market: every campaign of it but the archived ones (an archived campaign never serves again at Amazon).
  const market = String(a.market)
  const [rows, archivedLeftOut] = await Promise.all([
    prisma.campaign.findMany({ where: { marketplace: market, status: { not: 'ARCHIVED' } }, select: CAMPAIGN_SELECT }),
    prisma.campaign.count({ where: { marketplace: market, status: 'ARCHIVED' } }),
  ])
  if (!rows.length) return { refusal: `No Amazon campaign in market ${market}${archivedLeftOut ? ` but ${plural(archivedLeftOut, 'archived one')}, which are left out` : ''}.` }
  if (rows.length > MAX_CAMPAIGNS) return { refusal: `${market} has ${rows.length} campaigns: at most ${MAX_CAMPAIGNS} are set in one request. Name them with campaignIds, in parts.` }
  return { mode: 'market', asked: rows.map((r) => ({ campaign: r as CampaignRow, toPct })), archivedLeftOut }
}

interface TargetWrite {
  campaignId: string
  fromFraction: Fraction
  toFraction: Fraction
}

/** A request decided: its preview, and every write it makes. */
async function decide(args: Record<string, unknown>, ctx?: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; writes: TargetWrite[] }> {
  const a = args as TargetArgs
  const read = await askedTargets(a)
  if ('refusal' in read) return { result: { ok: false, error: read.refusal }, writes: [] }

  const rows = read.asked
    .map(({ campaign, toPct }) => {
      const fromFraction = storedTarget(campaign.dynamicBidding)
      return { campaign, fromFraction, fromPct: pctOf(fromFraction), toPct }
    })
    .sort((x, y) => (x.campaign.id < y.campaign.id ? -1 : 1))
  const changing = rows.filter((r) => r.fromPct !== r.toPct)
  const unchanged = rows.filter((r) => r.fromPct === r.toPct)
  if (!changing.length) {
    const only = rows.length === 1 ? rows[0] : null
    return {
      result: { ok: false, error: only
        ? `${only.campaign.name} already has a target ACoS of ${fromWords(only.fromPct)}: nothing would change.`
        : `All ${rows.length} campaigns already have ${read.mode === 'list' ? 'these targets' : `a target ACoS of ${fromWords(rows[0].toPct)}`}: nothing would change.` },
      writes: [],
    }
  }

  // An unset target counts as the 30 % fallback: a raise is judged against it. (Before a campaign has a target, Nexus's
  // optimiser may use the business default or profit data instead: the first-target warning below says so.)
  const used = (pct: number | null) => pct ?? ENGINE_FALLBACK_PCT
  const raised = changing.filter((r) => used(r.toPct) > used(r.fromPct)).length
  const lowered = changing.filter((r) => used(r.toPct) < used(r.fromPct)).length
  const firstSet = changing.filter((r) => r.fromPct == null).length
  const firstSetNotRaised = changing.filter((r) => r.fromPct == null && !(used(r.toPct) > used(r.fromPct))).length
  const cleared = changing.filter((r) => r.toPct == null).length
  // W0 — a target Nexus's optimiser skips: 0 % (only a list can carry one, to put a stored value back; 500 % is its top).
  const skippedByOptimiser = changing.filter((r) => r.toPct != null && r.toPct <= 0).length
  const live = adsMode() === 'live'
  const engineSees = live ? changing.filter((r) => r.campaign.liveBidWritesEnabled).length : changing.length

  const markets = [...new Set(changing.map((r) => r.campaign.marketplace ?? '?'))].sort()
  const where = read.mode === 'market' ? ` in ${a.market}` : markets.length === 1 ? ` in ${markets[0]}` : ` in ${markets.length} markets (${markets.join(', ')})`
  const n = changing.length
  const one = read.mode === 'list' ? null : changing[0].toPct
  const summary = (one == null
    ? `Sets the target ACoS of ${plural(n, 'Amazon campaign')}${where}, each to its own value (stored as fractions)`
    : `Sets the target ACoS of ${plural(n, 'Amazon campaign')}${where} to ${one}% (stored as the fraction ${fractionOf(one)})`)
    + ', in Nexus only: nothing is sent to Amazon.'
    + (unchanged.length ? ` ${plural(unchanged.length, 'campaign')} already at ${read.mode === 'list' ? 'the target asked' : 'that target'} ${unchanged.length === 1 ? 'is' : 'are'} left as ${unchanged.length === 1 ? 'it is' : 'they are'}.` : '')

  const warnings = [
    raised ? `A higher target ACoS lets Nexus's auto-bid and the external bidding engine bid higher on ${plural(raised, 'campaign')} (an unset target counts as the ${ENGINE_FALLBACK_PCT}% fallback): ad spend can rise.` : null,
    firstSetNotRaised ? `${plural(firstSetNotRaised, 'campaign')} had no target ACoS: Nexus's bid optimiser moved ${firstSetNotRaised === 1 ? 'its' : 'their'} bids toward the business default or profit data (${ENGINE_FALLBACK_PCT}% without either), so where that was lower, bids can still rise.` : null,
    cleared ? `${plural(cleared, 'campaign')} ${cleared === 1 ? 'loses its' : 'lose their'} target: Nexus's bid optimiser then uses the business default, profit data or ${ENGINE_FALLBACK_PCT}%, the external bidding engine its ${ENGINE_FALLBACK_PCT}% fallback.` : null,
    skippedByOptimiser ? `${plural(skippedByOptimiser, 'campaign')} ${skippedByOptimiser === 1 ? 'gets a target' : 'get targets'} of 0%: Nexus's bid optimiser skips ${skippedByOptimiser === 1 ? 'it' : 'them'} and uses the business default, profit data or ${ENGINE_FALLBACK_PCT}%.` : null,
  ].filter((w): w is string => !!w)

  const rules = (await prisma.automationRule.findMany({ where: { domain: 'advertising', enabled: true }, select: { id: true, name: true, actions: true }, orderBy: { name: 'asc' } }))
    .filter((r) => Array.isArray(r.actions) && r.actions.some((x) => String((x as { type?: unknown } | null)?.type ?? '') === RULE_ACTION))
    .slice(0, 10)
    .map((r) => ({ kind: 'rule' as const, id: r.id, name: r.name }))

  const line = (r: (typeof rows)[number]) => ({ campaignId: r.campaign.id, name: r.campaign.name, marketplace: r.campaign.marketplace, fromPct: r.fromPct, toPct: r.toPct })
  const writes = changing.map((r) => ({ campaignId: r.campaign.id, fromFraction: r.fromFraction, toFraction: fractionOf(r.toPct) }))
  // AA-W2-8 — what a run by rule is judged on: each campaign's move in points (no target before reads as 0, so a first
  // target is a raise of all of it), in Nexus only. A cleared or 0 % target is left out: targetRefusal holds it.
  const items = changing.filter((r) => r.toPct != null && r.toPct > 0)
    .map((r): KitItem => ({ entity: { kind: 'campaign', id: r.campaign.id }, change: { field: 'targetAcosPct', fromPct: r.fromPct, toPct: r.toPct as number }, nexusOnly: true }))
  // Nexus only: no write for the gate to judge (the bid engines' own writes are judged when they write).
  const facts = await ruleFactsFor({ tool: TOOL_NAME, limits: TARGET_LIMITS, items, writes: [], approvalId: ctx?.approvalId })
  return {
    writes,
    result: {
      ok: true,
      preview: {
        action: 'set-campaign-target-acos',
        mode: read.mode,
        ...(read.mode === 'market' ? { market: a.market } : {}),
        targetAcosPct: one,
        unit: 'Typed as a percent; Nexus stores a fraction (25% is stored as 0.25).',
        summary,
        // The approval card's lines (the first 20), in words.
        changes: changing.slice(0, LINES_SHOWN).map((r) => ({
          label: `${r.campaign.name} · target ACoS`, channel: 'AMAZON', marketplace: r.campaign.marketplace,
          fromLabel: fromWords(r.fromPct), toLabel: toWords(r.toPct),
        })),
        ...(n > LINES_SHOWN ? { moreChanges: n - LINES_SHOWN } : {}),
        // Every campaign it sets, from → to in percent (null = no target).
        campaigns: changing.map(line),
        ...(unchanged.length ? { leftAsTheyAre: unchanged.slice(0, LINES_SHOWN).map(line) } : {}),
        totals: { changing: n, raised, lowered, firstSet, cleared, unchanged: unchanged.length, archivedLeftOut: read.archivedLeftOut },
        // Every campaign asked, with what it stores now and what it gets: a change to any of them (or a campaign added to
        // the market) between approval and run stops the run.
        basis: createHash('sha256').update(rows.map((r) => `${r.campaign.id}:${r.fromFraction ?? '-'}:${fractionOf(r.toPct) ?? '-'}`).join('|')).digest('base64url').slice(0, 32),
        reachesAmazon: false,
        reachNote: 'Nexus only: nothing is sent to Amazon by this change.',
        readBy: `Nexus's bid optimiser — auto-bid, autopilot plans and the target-ACoS bid rules, when they run — moves each campaign's keyword bids toward it, unless a rule or an autopilot plan sets a target of its own, ahead of the business default target ACoS (tune-ad-engine account-target-acos) and profit data. The external bidding engine (a separate service), when it runs, reads it as its ACoS goal too. Both reach Amazon only on campaigns on the live-write allowlist${live ? `: ${engineSees} of these ${n}` : ' (in live ads mode)'}. Nexus shows it in Apply Rules, the bid grid ("Goal"), suggestions and ad-campaigns.`,
        alsoChangedBy: rules,
        ...(rules.length ? { alsoChangedByNote: `${plural(rules.length, 'enabled ad rule')} can set a campaign's target ACoS (${RULE_ACTION}) and may change these again.` } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...facts,
        effect: summary,
      },
    },
  }
}

/**
 * AA-W2-8 — the rows of a target change no run by rule may make (pure, on the preview's full `campaigns` list): a
 * cleared or 0 % target (Nexus's optimiser then falls back to the business default, profit data or 30 %: what that does
 * to the bids is not known here), and a raise past the ACoS target the ads strategy sets where the campaign lands (a
 * campaign's own target comes before the strategy's in the engines' chain, so a higher one would let them bid past it).
 */
function targetRefusal(preview: unknown): string | null {
  const rows = (preview as { campaigns?: unknown } | null | undefined)?.campaigns
  if (!Array.isArray(rows) || !rows.length) return 'the preview does not list the campaigns it sets; a person decides'
  const list = rows as Array<{ campaignId: string; name: string; fromPct: number | null; toPct: number | null }>
  const cleared = list.find((r) => r.toPct == null || !(r.toPct > 0))
  if (cleared) {
    return `${cleared.name}: its target ACoS ${cleared.toPct == null ? 'is cleared' : 'becomes 0%'}, so Nexus's bid optimiser falls back to ${NO_TARGET_WORDS.replace(/^Nexus uses /, '')} — what that does to its bids is not judged by rule; a person decides`
  }
  const facts = limitFactsOf(preview)
  if (!facts) return null // ruleRefusal says it
  for (const r of list) {
    if (!((r.toPct as number) > (r.fromPct ?? 0))) continue
    const scope = facts.scopes[facts.entityScopes[`campaign:${r.campaignId}`] ?? '']
    const cap = scope?.limits.strategyTargetAcosPct
    const source = scope?.sources.target
    if (cap != null && source && (r.toPct as number) > cap) {
      return `${r.name}: the new target ACoS ${r.toPct}% is above the ${cap}% the ads strategy sets there (${strategyWords(source)}), and a campaign's own target comes first for the bid engines; a person decides`
    }
  }
  return null
}

/** C2 — undo of a target change: each campaign's earlier target (or none) put back, through this tool's list. */
export const SET_CAMPAIGN_TARGET_ACOS_UNDO: ToolUndo = {
  current: (change) => targetsNow(Object.keys(((change.after as { targets?: Record<string, unknown> } | null)?.targets) ?? {})),
  request(change) {
    const before = (change.before as { targets?: Record<string, Fraction> } | null)?.targets
    if (!before || !Object.keys(before).length) return { refusal: 'This change does not record the targets it replaced.' }
    return {
      tool: 'set-campaign-target-acos',
      args: {
        targets: Object.entries(before).map(([campaignId, fraction]) => ({ campaignId, targetAcosPct: pctOf(fraction) })),
        why: 'undo of an earlier target ACoS change',
      },
    }
  },
}

const TOOL_NAME = 'set-campaign-target-acos'
/** AA-W2-8 — its Claude limits: up to 50 campaigns a request; each move in points, a raise 0 by default. */
const TARGET_LIMITS = adKitLimits({ maxItems: 50 }, STEP_POINT_LIMITS)

const setCampaignTargetAcos: AgentTool = {
  name: TOOL_NAME,
  title: 'Set campaign target ACoS',
  input: z.object({
    campaignIds: z.array(z.string().trim().min(1).max(64).describe('Nexus campaign id (campaignId in ad-campaigns)'))
      .max(MAX_CAMPAIGNS).optional()
      .describe(`the Amazon campaigns to set, at most ${MAX_CAMPAIGNS}; or give a market instead`),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('every Amazon campaign of this market (e.g. IT), archived ones left out: one target for the market'),
    targetAcosPct: z.coerce.number().min(0.01).max(100).optional()
      .describe('with campaignIds or market: the target ACoS in percent, as the screen takes it (25 = 25%), above 0 and at most 100; Nexus stores it as a fraction (0.25)'),
    targets: z.array(z.object({
      campaignId: z.string().trim().min(1).max(64).describe('Nexus campaign id (campaignId in ad-campaigns)'),
      targetAcosPct: z.coerce.number().min(0).max(500).nullable()
        .describe('its target ACoS in percent (0–500, the range Nexus stores), or null to clear it'),
    })).max(MAX_CAMPAIGNS).optional()
      .describe(`instead of campaignIds or market: each campaign with its own target (at most ${MAX_CAMPAIGNS}); how an earlier change is put back`),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
  }),
  // The route the screen's action calls (PATCH /advertising/campaigns/:id/automation) needs exactly this.
  requires: [F.adsAutomationManage],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: nothing is sent to Amazon by it. Nexus's auto-bid and the external bidding engine bid toward it when they run.
  openWorld: false,
  reversibility: 'full',
  // AA-W2-8 — a Nexus record, put back in full by undo — but Nexus's auto-bid and the external engine bid toward it, so
  // a higher target lets bids rise: it may run by rule only inside its limits (a raise waits for a person until the
  // business sets how many points one may be) and the ads strategy.
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  limits: TARGET_LIMITS,
  withinLimits: (preview, limits) => targetRefusal(preview) ?? ruleRefusal(preview, limits),
  // The ads strategy's facts and lines hold money (bid limits, budgets by rule, its ACoS target): hidden from a person
  // without ad spend. Not its own targetAcosPct: anyone who may set a campaign's target sees it, as before.
  restrictedFields: strategyFactsMoney(['targetAcosPct']),
  undo: SET_CAMPAIGN_TARGET_ACOS_UNDO,
  description:
    'Set the target ACoS of Amazon campaigns: the campaigns named (campaignIds), or every campaign of a market (market) '
    + 'to give that market one target, with targetAcosPct in percent as the screen takes it (Ads › Rules & Automation › '
    + 'Apply Rules › Target ACoS). Nexus stores it as a fraction (25% → 0.25). Nexus only: nothing is sent to Amazon by '
    + 'this change, but Nexus\'s auto-bid now steers toward it: its bid optimiser (auto-bid, autopilot plans and the '
    + 'target-ACoS bid rules) moves the campaign\'s keyword bids toward this target, unless a rule or a plan sets its own, '
    + 'ahead of the business default and profit data, and writes them to Amazon on campaigns on the live-write allowlist; the external '
    + 'bidding engine reads it too when it runs. Nothing changes until it is approved: the person who asked may confirm it '
    + `in Claude when the business allows that. ${BY_RULE_WORDS}: a move no larger, in points, than its limits allow `
    + '(a raise waits for a person until the business sets how large one may be), and never above the target ACoS the '
    + 'ads strategy sets for the campaign. The preview lists every campaign from → to, what reads it, the ads strategy\'s '
    + 'limits that apply, and warns when a higher target lets bids rise. Undo puts each earlier target back.',
  async handler(args, ctx) {
    return (await decide(args, ctx)).result
  },
  async execute(args, ctx) {
    // One decision: re-checked against what was approved (the basis fingerprints every campaign asked), then run in full.
    const { result: fresh, writes } = await decide(args, ctx)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { basis: string; summary: string }
    const approved = (ctx.approvedPreview as { basis?: unknown } | undefined)?.basis
    if (approved !== undefined && approved !== p.basis) {
      return notRun('Not run: what you approved has moved since — a campaign\'s target ACoS (or the market\'s campaigns) changed. Ask for it again with the values as they are now.')
    }
    const run = approvedRun(ctx, String(args.why ?? '') || p.summary)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)

    const written: TargetWrite[] = []
    const failed: Array<{ campaignId: string; why: string }> = []
    for (const w of writes) {
      // The screen's own write: the same service, the same fraction (null clears).
      const out = await setBidAutomation(w.campaignId, { targetAcos: w.toFraction })
      if (out.error) failed.push({ campaignId: w.campaignId, why: out.error })
      else written.push(w)
    }
    if (written.length) {
      await prisma.advertisingActionLog.createMany({
        data: written.map((w) => ({
          userId: run.actor,
          actionType: 'set_campaign_goal',
          entityType: 'CAMPAIGN',
          entityId: w.campaignId,
          payloadBefore: { targetAcos: w.fromFraction },
          payloadAfter: { targetAcos: w.toFraction, note: `target ACoS ${fromWords(pctOf(w.fromFraction))} → ${toWords(pctOf(w.toFraction))}` },
          evidence: { metric: 'operator_goal', note: `${run.reason} — Nexus only: never sent to Amazon.` },
        })),
      })
    }
    const ids = written.map((w) => w.campaignId).sort()
    const change = written.length
      ? {
          before: { targets: Object.fromEntries([...written].sort((x, y) => (x.campaignId < y.campaignId ? -1 : 1)).map((w) => [w.campaignId, w.fromFraction])) },
          after: await targetsNow(ids),
        }
      : undefined
    const data = { set: written.length, failed: failed.length, targets: change?.after.targets ?? {}, reachesAmazon: false, note: 'Saved in Nexus at once; nothing is sent to Amazon.' }
    if (failed.length) {
      return {
        ok: false,
        error: `Partly run: ${written.length} set, ${failed.length} not (${failed.slice(0, 3).map((f) => `${f.campaignId}: ${f.why}`).join('; ')}).${written.length ? ' undo-change puts back the ones set.' : ' Nothing changed.'}`,
        data,
        ...(change ? { change } : {}),
      }
    }
    return { ok: true, data, change }
  },
}

export const ADS_TARGET_ACOS_TOOLS: AgentTool[] = [setCampaignTargetAcos]
