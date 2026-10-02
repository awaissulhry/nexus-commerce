/**
 * MCP full control A14, A15 (docs/mcp-full-control/sections/01-ads.md §3, §6 steps 14–15) — Claude's eBay
 * Promoted Listings changes, through the audited eBay write layer (services/marketing/ebay-ads-write.service.ts):
 *
 *   set-ebay-ad-rates (A14)        the ad rate of listings a General (cost-per-sale) campaign already promotes; a rate
 *                                  above a listing's break-even is never set — no margin override is ever passed
 *   promote-ebay-listings (A14)    adds listings to a campaign (a General one at a rate per listing; a Priority one into
 *                                  an ad group); the same margin guardrail, no override
 *   set-ebay-campaign-budget (A14) the daily budget of a Priority (cost-per-click) campaign, in its own currency
 *   ebay-keywords-change (A14)     a Priority campaign's keyword BIDS (never a status: nothing is paused), new keywords
 *                                  and negative keywords
 *   create-ebay-campaign (A15)     a new campaign that starts as low as eBay allows: a General campaign at eBay's 2 %
 *                                  minimum rate with no listings (it spends nothing until promote-ebay-listings is
 *                                  approved); a Priority campaign has no low start (a daily budget from day one), so it
 *                                  is refused unless the market has an eBay spend ceiling that holds a month of it
 *
 * Money (budgets, bids) is in the campaign's own marketplace currency, as the write layer sends it (ebayMoneyCurrency).
 *
 * Like the Amazon ad tools: the preview says where it lands — live on the campaign's own eBay account, or SANDBOX when
 * eBay ad writes are off (NEXUS_MARKETING_WRITES_EBAY): "nothing reaches eBay" — and a refusal (the kill switch, the
 * halted state, the write gate's value cap) is not queued. It runs only as an approved request, as the approver; every
 * CampaignAction it writes carries the approval as `executionId`, so approval-status counts exactly its writes. eBay
 * writes have no cancel window: the approval is the only brake. Never a pause, an end or a removal (d3): an undo lowers.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { EBAY_MARKETPLACE_SHORT } from '../../ads-core/ebay-marketplace.js'
import {
  ebayAdGroupOf, ebayAdGroupTerms, ebayAdsByItem, ebayCampaignForChange, ebayCampaignNamed, ebayKeywordsById, ebayListingsByItem,
  ebayMarketCeiling, type EbayChangeCampaign,
} from '../../marketing/ebay-ads-change-read.service.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { amountLabel } from './ads-tool-guards.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const LIST_MAX = 250
/** eBay's lowest ad rate (General campaigns) and the lowest keyword bid this layer sets (Priority). */
const EBAY_MIN_RATE_PCT = 2
const EBAY_FLOOR_BID_CENTS = 2

const writes = () => import('../../marketing/ebay-ads-write.service.js')

// ── where it lands ──────────────────────────────────────────────────────────────────────────────

/** Where an approved eBay write lands, as the preview stores it: live on the campaign's own account, or sandbox. */
type EbayReach = { reach: 'live'; account: string } | { reach: 'sandbox' }

async function ebayReach(
  target: { marketplace: string; externalCampaignId?: string | null; account: string },
  valueCents = 0,
): Promise<{ reach: EbayReach; note: string } | { refused: string }> {
  const { ebayWritesHalted } = await writes()
  const halted = await ebayWritesHalted(target.marketplace)
  if (halted) return { refused: `Not queued: ${halted}.` }
  const { checkMarketingWriteGate } = await import('../../marketing/marketing-write-gate.js')
  const decision = checkMarketingWriteGate({ channel: 'EBAY', marketplace: target.marketplace, payloadValueCents: valueCents })
  if (decision.allowed === false) return { refused: `Not queued: eBay's write gate refuses it — ${decision.reason}.` }
  if (decision.mode !== 'live') {
    return { reach: { reach: 'sandbox' }, note: 'SANDBOX: eBay ad writes are off (NEXUS_MARKETING_WRITES_EBAY), so after approval it is recorded in Nexus only — nothing reaches eBay.' }
  }
  if (target.externalCampaignId?.startsWith('sandbox-')) {
    return { reach: { reach: 'sandbox' }, note: 'SANDBOX: this campaign exists in Nexus only (it was created while eBay writes were off), so nothing reaches eBay.' }
  }
  return {
    reach: { reach: 'live', account: target.account },
    note: 'live: after approval it is sent to eBay at once, on the campaign\'s own eBay account. eBay writes have no cancel window — the approval is the only brake.',
  }
}

/** `execute`'s re-check: the dry run still passes, the write lands where the person was told, nothing they approved moved. */
function ebayRecheck(ctx: ToolContext, fresh: ToolResult, material: readonly string[]): string | null {
  const approved = (ctx.approvedPreview as { reach?: EbayReach } | undefined)?.reach
  if (!approved || (approved.reach !== 'live' && approved.reach !== 'sandbox')) return 'Not run: this request does not record where it lands. Ask for it again.'
  if (!fresh.ok) return `Not run: ${fresh.error ?? 'it is no longer a valid change'}`
  const now = (fresh.preview ?? {}) as Record<string, unknown>
  const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
  if (canonical(now.reach) !== canonical(approved)) {
    const said = (r: unknown) => ((r as EbayReach | undefined)?.reach === 'live' ? 'live at eBay' : 'sandbox (Nexus only)')
    return `Not run: it was approved as ${said(approved)}, and it would now be ${said(now.reach)}.`
  }
  const moved = material.filter((key) => key in before && canonical(before[key]) !== canonical(now[key]))
  if (moved.length) return `Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the values as they are now.`
  return null
}

/** The eBay write layer's context for an approved run: the approver, the approval as change set, the reason. */
async function approvedOp(ctx: ToolContext, why: string) {
  const run = approvedRun(ctx, why)
  if ('refusal' in run) return { refusal: `Not run: ${run.refusal}.` }
  return { run, op: { actorUserId: ctx.userId ?? null, changeSetId: run.changeSetId, reason: run.reason } }
}

// ── shared facts ────────────────────────────────────────────────────────────────────────────────

const ebayCampaignIdArg = z.string().trim().min(1).max(64).describe('Nexus eBay campaign id (campaignId in ad-campaigns with channel ebay)')
const itemIdArg = z.string().trim().min(1).max(40).describe('the eBay item id (the listing number on eBay)')
const oneDecimal = (v: number) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9
const rateArg = z.coerce.number().min(EBAY_MIN_RATE_PCT).max(100).refine(oneDecimal, 'an ad rate has one decimal at most')
  .describe('ad rate in percent of the sale, 2–100 (eBay\'s bounds), one decimal at most')
const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the eBay audit')

const isGeneral = (c: EbayChangeCampaign) => (c.fundingModel ?? 'COST_PER_SALE') === 'COST_PER_SALE'
const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const short = (marketplace: string) => EBAY_MARKETPLACE_SHORT[marketplace] ?? 'IT'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function campaignOrRefusal(id: string): Promise<{ c: EbayChangeCampaign } | { error: string }> {
  const c = await ebayCampaignForChange(id)
  if (!c) return { error: `eBay campaign ${id} not found` }
  if (['ENDED', 'DELETED', 'ARCHIVED'].includes(String(c.status).toUpperCase())) return { error: `${c.name} has ended: eBay changes nothing in an ended campaign.` }
  return { c }
}

function twice(values: string[]): string[] {
  const seen = new Set<string>()
  const again = new Set<string>()
  for (const v of values) (seen.has(v.toLowerCase()) ? again : seen).add(v.toLowerCase())
  return [...again]
}

// ── set-ebay-ad-rates (A14) ─────────────────────────────────────────────────────────────────────

/** The rate each listed ad has now (its own, else the campaign's). */
async function currentRates(campaignId: string, itemIds: string[]): Promise<Record<string, number | null>> {
  const c = await ebayCampaignForChange(campaignId)
  const ads = await ebayAdsByItem(campaignId, itemIds)
  const campaignRate = num(c?.bidPercentage)
  return Object.fromEntries(itemIds.map((id) => [id, ads.has(id) ? (ads.get(id)!.ratePct ?? campaignRate) : null]))
}

async function ratesPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const found = await campaignOrRefusal(String(args.ebayCampaignId ?? ''))
  if ('error' in found) return { ok: false, error: found.error }
  const c = found.c
  if (!isGeneral(c)) return { ok: false, error: `${c.name} is a Priority (cost-per-click) campaign: its ads have no rate. Change its keyword bids with ebay-keywords-change.` }
  if (c.isRulesBased) return { ok: false, error: `${c.name} is rules-based: eBay applies the campaign's own rate to the listings its rules select, so its ads have no rate of their own here.` }
  if (c.adRateStrategy === 'DYNAMIC') return { ok: false, error: `${c.name} uses dynamic rates: eBay sets each ad's rate every day under the campaign's cap.` }
  const asked = (args.rates as Array<{ ebayItemId: string; ratePct: number }> | undefined) ?? []
  const repeated = twice(asked.map((r) => r.ebayItemId))
  if (repeated.length) return { ok: false, error: `Listed twice: ${repeated.slice(0, 5).join(', ')}.` }
  const ids = asked.map((r) => r.ebayItemId)
  const { loadBreakEvens, rateGuardrail } = await writes()
  const [ads, be] = await Promise.all([ebayAdsByItem(c.id, ids), loadBreakEvens(short(c.marketplace), ids)])
  const campaignRate = num(c.bidPercentage)
  const changes: Array<{ itemId: string; fromPct: number | null; toPct: number; breakEvenPct: number | null; warning: string | null }> = []
  const left = { noAd: [] as string[], same: [] as string[], aboveBreakEven: [] as Array<{ itemId: string; ratePct: number; breakEvenPct: number | null }> }
  for (const r of asked) {
    const ad = ads.get(r.ebayItemId)
    if (!ad) { left.noAd.push(r.ebayItemId); continue }
    const from = ad.ratePct ?? campaignRate
    if (from === r.ratePct) { left.same.push(r.ebayItemId); continue }
    const eco = be.get(r.ebayItemId)
    // No override, ever: a rate above the listing's break-even is refused here, as the write layer would refuse it.
    const guard = rateGuardrail(r.ratePct, eco?.be ?? null, eco?.status ?? null)
    if (guard.blocked) { left.aboveBreakEven.push({ itemId: r.ebayItemId, ratePct: r.ratePct, breakEvenPct: eco?.be ?? null }); continue }
    changes.push({ itemId: r.ebayItemId, fromPct: from, toPct: r.ratePct, breakEvenPct: eco?.be ?? null, warning: guard.warning })
  }
  const leftWords = [
    left.noAd.length ? `${plural(left.noAd.length, 'listing')} not promoted in it` : '',
    left.same.length ? `${left.same.length} already at that rate` : '',
    left.aboveBreakEven.length ? `${left.aboveBreakEven.length} above break-even (never set here)` : '',
  ].filter(Boolean).join(', ')
  if (!changes.length) return { ok: false, error: `${c.name}: nothing changes — ${leftWords}.` }
  const reach = await ebayReach({ marketplace: c.marketplace, externalCampaignId: c.externalCampaignId, account: c.channelConnectionId })
  if ('refused' in reach) return { ok: false, error: reach.refused }
  const up = changes.filter((x) => x.fromPct == null || x.toPct > x.fromPct).length
  return {
    ok: true,
    preview: {
      action: 'set-ebay-ad-rates',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace },
      changes,
      left,
      reach: reach.reach,
      reachNote: reach.note,
      effect: `Sets the ad rate of ${plural(changes.length, 'listing')} in ${c.name} (${up} up, ${changes.length - up} down)${leftWords ? `; left as they are: ${leftWords}` : ''}. eBay charges the rate only when a promoted listing sells. A rate above a listing's break-even is never set here.`,
    },
  }
}

const SET_EBAY_RATES_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { ebayCampaignId?: string; rates?: Record<string, number> }
    const id = String(after.ebayCampaignId ?? '')
    return { ebayCampaignId: id, rates: await currentRates(id, Object.keys(after.rates ?? {})) }
  },
  request(change) {
    const before = (change.before ?? {}) as { ebayCampaignId?: string; rates?: Record<string, number | null> }
    const rates = Object.entries(before.rates ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number').map(([ebayItemId, ratePct]) => ({ ebayItemId, ratePct }))
    if (!before.ebayCampaignId || !rates.length) return { refusal: 'This change does not record the rates it replaced.' }
    return { tool: 'set-ebay-ad-rates', args: { ebayCampaignId: before.ebayCampaignId, rates, why: 'undo of an earlier rate change' } }
  },
}

const setEbayAdRates: AgentTool = {
  name: 'set-ebay-ad-rates',
  title: 'Change eBay ad rates',
  input: z.object({
    ebayCampaignId: ebayCampaignIdArg,
    rates: z.array(z.object({ ebayItemId: itemIdArg, ratePct: rateArg })).min(1).max(LIST_MAX).describe('each promoted listing and its new ad rate, at most 250'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_EBAY_RATES_UNDO,
  description:
    'Set the ad rate of listings an eBay General (cost-per-sale) campaign already promotes. Nothing changes until a '
    + 'person approves it in Nexus; it always waits for a person. A rate above a listing\'s break-even is never set (no '
    + 'override). The preview lists each rate now and after, what is left alone and why, and where it lands: live on '
    + 'the campaign\'s eBay account, or SANDBOX when eBay ad writes are off (nothing reaches eBay). Undo sets the old rates back.',
  async handler(args) {
    return ratesPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await ratesPreview(args)
    const refusal = ebayRecheck(ctx, fresh, ['changes', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; changes: Array<{ itemId: string; fromPct: number | null; toPct: number }>; reach: EbayReach; effect: string }
    const approved = await approvedOp(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in approved) return notRun(approved.refusal!)
    const { setAdRates } = await writes()
    // Three arguments: the margin override is never passed.
    const out = await setAdRates(approved.op, p.campaign.id, p.changes.map((x) => ({ listingId: x.itemId, ratePct: x.toPct })))
    const done = new Set(out.results.filter((r) => r.ok).map((r) => r.key))
    const made = p.changes.filter((x) => done.has(x.itemId))
    const change = made.length
      ? {
          before: { ebayCampaignId: p.campaign.id, rates: Object.fromEntries(made.map((x) => [x.itemId, x.fromPct])), changeSetId: approved.run.changeSetId },
          after: { ebayCampaignId: p.campaign.id, rates: Object.fromEntries(made.map((x) => [x.itemId, x.toPct])) },
        }
      : undefined
    const failed = out.results.filter((r) => !r.ok).map((r) => ({ itemId: r.key, error: r.error ?? r.blocked ?? 'refused' }))
    if (!made.length) return { ok: false, error: `Not changed: eBay refused every rate (${failed.slice(0, 3).map((f) => `${f.itemId}: ${f.error}`).join('; ')}).` }
    return { ok: true, data: { ebayCampaignId: p.campaign.id, changed: made.length, failed, mode: out.mode, reach: p.reach, changeSetId: approved.run.changeSetId }, change }
  },
}

// ── promote-ebay-listings (A14) ─────────────────────────────────────────────────────────────────

async function promotePreview(args: Record<string, unknown>): Promise<ToolResult> {
  const found = await campaignOrRefusal(String(args.ebayCampaignId ?? ''))
  if ('error' in found) return { ok: false, error: found.error }
  const c = found.c
  const general = isGeneral(c)
  const adGroupId = typeof args.ebayAdGroupId === 'string' && args.ebayAdGroupId ? args.ebayAdGroupId : null
  if (general && c.isRulesBased) return { ok: false, error: `${c.name} is rules-based: eBay selects its listings by its rules. Promote listings in a key-based campaign.` }
  if (general && adGroupId) return { ok: false, error: `${c.name} is a General campaign: its ads have no ad group (leave ebayAdGroupId out).` }
  let group: { id: string; name: string } | null = null
  if (!general) {
    const smart = c.campaignTargetingType === 'SMART'
    if (smart && adGroupId) return { ok: false, error: `${c.name} is a Smart Priority campaign: it has no ad groups (leave ebayAdGroupId out).` }
    if (!smart) {
      if (!adGroupId) return { ok: false, error: `${c.name} is a manual Priority campaign: listings join an ad group — give ebayAdGroupId.` }
      group = await ebayAdGroupOf(c.id, adGroupId)
      if (!group) return { ok: false, error: `eBay ad group ${adGroupId} not found in ${c.name}` }
    }
  }
  const asked = (args.ads as Array<{ ebayItemId: string; ratePct?: number }> | undefined) ?? []
  const repeated = twice(asked.map((a) => a.ebayItemId))
  if (repeated.length) return { ok: false, error: `Listed twice: ${repeated.slice(0, 5).join(', ')}.` }
  const ids = asked.map((a) => a.ebayItemId)
  const dynamic = general && c.adRateStrategy === 'DYNAMIC'
  const dynCap = dynamic ? num((c.dynamicAdRatePrefs as Array<{ adRateCapPercent?: string }> | null)?.[0]?.adRateCapPercent) : null
  const defaultRate = num(args.defaultRatePct) ?? num(c.bidPercentage)
  const { loadBreakEvens, rateGuardrail } = await writes()
  const [listings, existing, be] = await Promise.all([ebayListingsByItem(ids), ebayAdsByItem(c.id, ids), general ? loadBreakEvens(short(c.marketplace), ids) : Promise.resolve(new Map())])
  const ownShort = short(c.marketplace)
  const knownShorts = new Set(Object.values(EBAY_MARKETPLACE_SHORT))
  const adds: Array<{ itemId: string; sku: string | null; ratePct: number | null; breakEvenPct: number | null; warning: string | null }> = []
  const left = { notListed: [] as string[], otherMarket: [] as string[], already: [] as string[], noRate: [] as string[], aboveBreakEven: [] as Array<{ itemId: string; ratePct: number; breakEvenPct: number | null }> }
  for (const a of asked) {
    const listing = listings.get(a.ebayItemId)
    if (!listing) { left.notListed.push(a.ebayItemId); continue }
    if (knownShorts.has(listing.marketplace) && listing.marketplace !== ownShort) { left.otherMarket.push(a.ebayItemId); continue }
    if (existing.has(a.ebayItemId)) { left.already.push(a.ebayItemId); continue }
    const eco = be.get(a.ebayItemId) as { be: number | null; status: string | null } | undefined
    if (!general) { adds.push({ itemId: a.ebayItemId, sku: listing.sku, ratePct: null, breakEvenPct: null, warning: null }); continue }
    const rate = dynamic ? dynCap : (num(a.ratePct) ?? defaultRate)
    if (rate == null) { if (dynamic) adds.push({ itemId: a.ebayItemId, sku: listing.sku, ratePct: null, breakEvenPct: eco?.be ?? null, warning: 'dynamic rate without a cap on record' }); else left.noRate.push(a.ebayItemId); continue }
    // No override, ever (for a dynamic campaign the guardrail judges its cap: the worst rate eBay may apply).
    const guard = rateGuardrail(rate, eco?.be ?? null, eco?.status ?? null)
    if (guard.blocked) { left.aboveBreakEven.push({ itemId: a.ebayItemId, ratePct: rate, breakEvenPct: eco?.be ?? null }); continue }
    adds.push({ itemId: a.ebayItemId, sku: listing.sku, ratePct: dynamic ? null : rate, breakEvenPct: eco?.be ?? null, warning: guard.warning })
  }
  const leftWords = [
    left.notListed.length ? `${left.notListed.length} not an eBay listing in Nexus` : '',
    left.otherMarket.length ? `${left.otherMarket.length} listed on another eBay market` : '',
    left.already.length ? `${left.already.length} already promoted in it` : '',
    left.noRate.length ? `${left.noRate.length} with no rate (give ratePct or defaultRatePct)` : '',
    left.aboveBreakEven.length ? `${left.aboveBreakEven.length} above break-even (never set here)` : '',
  ].filter(Boolean).join(', ')
  if (!adds.length) return { ok: false, error: `${c.name}: nothing to promote — ${leftWords}.` }
  const reach = await ebayReach({ marketplace: c.marketplace, externalCampaignId: c.externalCampaignId, account: c.channelConnectionId })
  if ('refused' in reach) return { ok: false, error: reach.refused }
  const rates = [...new Set(adds.map((a) => a.ratePct).filter((r): r is number => r != null))].sort((x, y) => x - y)
  return {
    ok: true,
    preview: {
      action: 'promote-ebay-listings',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace, fundingModel: c.fundingModel ?? 'COST_PER_SALE' },
      adGroup: group,
      adds,
      left,
      reach: reach.reach,
      reachNote: reach.note,
      effect: general
        ? `Promotes ${plural(adds.length, 'listing')} in ${c.name}${dynamic ? `, at a rate eBay sets daily under the ${dynCap ?? '?'}% cap` : ` at ${rates.length === 1 ? `${rates[0]}%` : `${rates[0]}–${rates[rates.length - 1]}%`}`}${leftWords ? `; left out: ${leftWords}` : ''}. eBay charges the rate only when a promoted listing sells.`
        : `Promotes ${plural(adds.length, 'listing')} in ${c.name}${group ? ` (ad group ${group.name})` : ''}${leftWords ? `; left out: ${leftWords}` : ''}. A Priority ad is paid per click on its keywords, within the campaign's daily budget.`,
    },
  }
}

const promoteEbayListings: AgentTool = {
  name: 'promote-ebay-listings',
  title: 'Promote eBay listings',
  input: z.object({
    ebayCampaignId: ebayCampaignIdArg,
    ads: z.array(z.object({ ebayItemId: itemIdArg, ratePct: rateArg.optional() })).min(1).max(LIST_MAX)
      .describe('each listing to promote, with its own ad rate for a General campaign (else defaultRatePct, else the campaign\'s rate), at most 250'),
    defaultRatePct: rateArg.optional().describe('General campaigns: the rate for a listing without its own (default: the campaign\'s rate)'),
    ebayAdGroupId: z.string().trim().min(1).max(64).optional().describe('manual Priority campaigns only: the Nexus eBay ad group the listings join'),
    why: whyArg,
  }),
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An ad is never removed by Nexus (d3): undo lowers each promoted listing to eBay's minimum rate instead.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { ebayCampaignId?: string; rates?: Record<string, number | null> }
      const id = String(after.ebayCampaignId ?? '')
      return { ...after, rates: await currentRates(id, Object.keys(after.rates ?? {})) }
    },
    request(change) {
      const after = (change.after ?? {}) as { ebayCampaignId?: string; rates?: Record<string, number | null> }
      const lowered = Object.entries(after.rates ?? {}).filter(([, r]) => typeof r === 'number' && r > EBAY_MIN_RATE_PCT).map(([ebayItemId]) => ({ ebayItemId, ratePct: EBAY_MIN_RATE_PCT }))
      if (!after.ebayCampaignId || !lowered.length) {
        return { refusal: 'Nothing to lower: Nexus never removes an ad, and these ads have no rate above eBay\'s 2% minimum (a Priority ad is lowered through its keywords\' bids, with ebay-keywords-change).' }
      }
      return { tool: 'set-ebay-ad-rates', args: { ebayCampaignId: after.ebayCampaignId, rates: lowered, why: 'undo of a promotion: lowered to eBay\'s 2% minimum (an ad is never removed)' } }
    },
  },
  description:
    'Promote listings in an eBay campaign: a General (cost-per-sale) campaign at a rate per listing, a manual Priority '
    + 'campaign into one of its ad groups. Nothing changes until a person approves it in Nexus; it always waits for a '
    + 'person. A rate above a listing\'s break-even is never set (no override); listings not on eBay in Nexus, on another '
    + 'market or already promoted are left out and counted. The preview says where it lands: live on the campaign\'s eBay '
    + 'account, or SANDBOX when eBay ad writes are off (nothing reaches eBay). An ad is never removed: undo lowers each '
    + 'promoted listing to eBay\'s 2% minimum rate.',
  async handler(args) {
    return promotePreview(args)
  },
  async execute(args, ctx) {
    const fresh = await promotePreview(args)
    const refusal = ebayRecheck(ctx, fresh, ['adds', 'adGroup', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; adGroup: { id: string } | null; adds: Array<{ itemId: string; ratePct: number | null }>; reach: EbayReach; effect: string }
    const approved = await approvedOp(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in approved) return notRun(approved.refusal!)
    const { promoteListings } = await writes()
    // Every rate is resolved here and passed per listing; the margin override is never passed.
    const out = await promoteListings(approved.op, {
      campaignId: p.campaign.id,
      items: p.adds.map((a) => ({ listingId: a.itemId, ...(a.ratePct != null ? { ratePct: a.ratePct } : {}) })),
      ...(p.adGroup ? { adGroupId: p.adGroup.id } : {}),
    })
    const done = new Set(out.results.filter((r) => r.ok && !r.warning?.startsWith('already')).map((r) => r.key))
    const made = p.adds.filter((a) => done.has(a.itemId))
    const failed = out.results.filter((r) => !r.ok).map((r) => ({ itemId: r.key, error: r.error ?? r.blocked ?? 'refused' }))
    if (!made.length) return { ok: false, error: `Not promoted: eBay refused every listing (${failed.slice(0, 3).map((f) => `${f.itemId}: ${f.error}`).join('; ')}).` }
    return {
      ok: true,
      data: { ebayCampaignId: p.campaign.id, promoted: made.length, failed, mode: out.mode, reach: p.reach, changeSetId: approved.run.changeSetId },
      change: {
        before: { ebayCampaignId: p.campaign.id, promoted: [], changeSetId: approved.run.changeSetId },
        after: { ebayCampaignId: p.campaign.id, rates: Object.fromEntries(made.map((a) => [a.itemId, a.ratePct])) },
      },
    }
  },
}

// ── set-ebay-campaign-budget (A14) ──────────────────────────────────────────────────────────────

async function budgetPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const found = await campaignOrRefusal(String(args.ebayCampaignId ?? ''))
  if ('error' in found) return { ok: false, error: found.error }
  const c = found.c
  if (isGeneral(c)) return { ok: false, error: `${c.name} is a General (cost-per-sale) campaign: it has no daily budget (eBay charges its rate per sale).` }
  const proposed = Math.round(Number(args.dailyBudgetCents))
  const { ebayMoneyCurrency } = await writes()
  let currency: string
  try {
    currency = await ebayMoneyCurrency(c.marketplace, c.budgetCurrency)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const current = c.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null
  if (current === proposed) return { ok: false, error: `The daily budget of ${c.name} is already ${amountLabel(proposed, currency)}.` }
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const used = c.budgetUpdatesDay != null && c.budgetUpdatesDay.getTime() === today.getTime() ? c.budgetUpdatesToday : 0
  if (used >= 15) return { ok: false, error: `${c.name}'s budget has been changed 15 times today: eBay allows 15 budget changes per campaign per day.` }
  const reach = await ebayReach({ marketplace: c.marketplace, externalCampaignId: c.externalCampaignId, account: c.channelConnectionId }, proposed)
  if ('refused' in reach) return { ok: false, error: reach.refused }
  return {
    ok: true,
    preview: {
      action: 'set-ebay-campaign-budget',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace },
      currency,
      currentBudgetCents: current,
      proposedBudgetCents: proposed,
      deltaCents: current == null ? null : proposed - current,
      budgetChangesToday: used,
      reach: reach.reach,
      reachNote: reach.note,
      effect: `Sets the daily budget of ${c.name} from ${current == null ? 'none' : amountLabel(current, currency)} to ${amountLabel(proposed, currency)} (budget change ${used + 1} of 15 today).`,
    },
  }
}

const setEbayCampaignBudget: AgentTool = {
  name: 'set-ebay-campaign-budget',
  title: 'Change an eBay campaign budget',
  input: z.object({
    ebayCampaignId: ebayCampaignIdArg,
    dailyBudgetCents: z.coerce.number().int().min(100).describe('new daily budget in minor units (cents) of the campaign\'s own currency, at least 100'),
    why: whyArg,
  }),
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const id = String((change.after as { ebayCampaignId?: unknown } | null)?.ebayCampaignId ?? '')
      const c = await ebayCampaignForChange(id)
      return { ebayCampaignId: id, dailyBudgetCents: c?.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null }
    },
    request(change) {
      const before = (change.before ?? {}) as { ebayCampaignId?: string; dailyBudgetCents?: number | null }
      if (!before.ebayCampaignId || !(Number(before.dailyBudgetCents) >= 100)) return { refusal: 'This change does not record the budget it replaced.' }
      return { tool: 'set-ebay-campaign-budget', args: { ebayCampaignId: before.ebayCampaignId, dailyBudgetCents: before.dailyBudgetCents, why: 'undo of an earlier budget change' } }
    },
  },
  description:
    'Set the daily budget of an eBay Priority (cost-per-click) campaign, in the campaign\'s own currency (never '
    + 'converted). Nothing changes until a person approves it in Nexus; it always waits for a person. eBay allows 15 '
    + 'budget changes per campaign per day. The preview shows the budget now and after and where it lands: live on the '
    + 'campaign\'s eBay account, or SANDBOX when eBay ad writes are off (nothing reaches eBay). Undo sets the old budget back.',
  async handler(args) {
    return budgetPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await budgetPreview(args)
    const refusal = ebayRecheck(ctx, fresh, ['currentBudgetCents', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { campaign: { id: string }; currentBudgetCents: number | null; proposedBudgetCents: number; currency: string; reach: EbayReach; effect: string }
    const approved = await approvedOp(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in approved) return notRun(approved.refusal!)
    const { updateBudget } = await writes()
    try {
      const out = await updateBudget(approved.op, p.campaign.id, p.proposedBudgetCents)
      return {
        ok: true,
        data: { ebayCampaignId: p.campaign.id, dailyBudgetCents: p.proposedBudgetCents, currency: p.currency, mode: out.mode, reach: p.reach, changeSetId: approved.run.changeSetId },
        change: {
          before: { ebayCampaignId: p.campaign.id, dailyBudgetCents: p.currentBudgetCents, changeSetId: approved.run.changeSetId },
          after: { ebayCampaignId: p.campaign.id, dailyBudgetCents: p.proposedBudgetCents },
        },
      }
    } catch (e) {
      return notRun(`Not run: the budget write was refused (${(e as Error).message}). Nothing changed.`)
    }
  },
}

// ── ebay-keywords-change (A14) ──────────────────────────────────────────────────────────────────

const bidArg = z.coerce.number().int().min(EBAY_FLOOR_BID_CENTS).max(10_000)
const keywordTextArg = z.string().trim().min(1).max(100).describe('the keyword (at most 10 words)')

async function keywordsPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const found = await campaignOrRefusal(String(args.ebayCampaignId ?? ''))
  if ('error' in found) return { ok: false, error: found.error }
  const c = found.c
  if (isGeneral(c) || c.campaignTargetingType === 'SMART') {
    return { ok: false, error: `${c.name} has no keywords of its own: keywords exist only in manual Priority (cost-per-click) campaigns.` }
  }
  const bids = (args.keywordBids as Array<{ ebayKeywordId: string; bidCents: number }> | undefined) ?? []
  const adds = (args.addKeywords as Array<{ text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bidCents: number }> | undefined) ?? []
  const negs = (args.addNegatives as Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }> | undefined) ?? []
  if (!bids.length && !adds.length && !negs.length) return { ok: false, error: `${c.name}: give keywordBids, addKeywords or addNegatives.` }
  // The currency the write layer sends its bids in: the campaign's own marketplace's.
  const { ebayMoneyCurrency } = await writes()
  let currency: string
  try {
    currency = await ebayMoneyCurrency(c.marketplace, c.budgetCurrency)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const repeated = twice([...bids.map((b) => b.ebayKeywordId), ...adds.map((a) => `${a.matchType} ${a.text}`), ...negs.map((n) => `negative ${n.matchType} ${n.text}`)])
  if (repeated.length) return { ok: false, error: `Listed twice: ${repeated.slice(0, 5).join(', ')}.` }

  const left = { notFound: [] as string[], same: [] as string[], dynamic: [] as string[], invalid: [] as string[], already: [] as string[] }
  const keywords = await ebayKeywordsById(c.id, bids.map((b) => b.ebayKeywordId))
  const bidChanges: Array<{ keywordId: string; text: string; matchType: string; fromCents: number; toCents: number }> = []
  for (const b of bids) {
    const k = keywords.get(b.ebayKeywordId)
    if (!k) { left.notFound.push(b.ebayKeywordId); continue }
    if (k.bidCents == null) { left.dynamic.push(b.ebayKeywordId); continue }
    if (k.bidCents === b.bidCents) { left.same.push(b.ebayKeywordId); continue }
    bidChanges.push({ keywordId: k.id, text: k.text, matchType: k.matchType, fromCents: k.bidCents, toCents: b.bidCents })
  }

  let group: { id: string; name: string } | null = null
  const newKeywords: Array<{ text: string; matchType: string; bidCents: number }> = []
  const negatives: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }> = []
  if (adds.length || negs.length) {
    const groupId = typeof args.ebayAdGroupId === 'string' ? args.ebayAdGroupId : ''
    if (!groupId) return { ok: false, error: `${c.name}: addKeywords and addNegatives need ebayAdGroupId (the ad group they join).` }
    group = await ebayAdGroupOf(c.id, groupId)
    if (!group) return { ok: false, error: `eBay ad group ${groupId} not found in ${c.name}` }
    const terms = await ebayAdGroupTerms(group.id)
    const valid = (text: string) => text.trim().length > 0 && text.length <= 100 && text.trim().split(/\s+/).length <= 10
    for (const a of adds) {
      if (!valid(a.text)) { left.invalid.push(a.text); continue }
      if (terms.keywords.has(`${a.matchType} ${a.text.trim().toLowerCase()}`)) { left.already.push(a.text); continue }
      newKeywords.push({ text: a.text.trim(), matchType: a.matchType, bidCents: a.bidCents })
    }
    for (const n of negs) {
      if (!valid(n.text)) { left.invalid.push(n.text); continue }
      if (terms.negatives.has(`${n.matchType} ${n.text.trim().toLowerCase()}`)) { left.already.push(n.text); continue }
      negatives.push({ text: n.text.trim(), matchType: n.matchType })
    }
  }
  const leftWords = [
    left.notFound.length ? `${left.notFound.length} keyword id${left.notFound.length === 1 ? '' : 's'} not in ${c.name}` : '',
    left.same.length ? `${left.same.length} already at that bid` : '',
    left.dynamic.length ? `${left.dynamic.length} under dynamic bidding (bids locked)` : '',
    left.invalid.length ? `${left.invalid.length} not a valid keyword (1–100 characters, at most 10 words)` : '',
    left.already.length ? `${left.already.length} already in the ad group` : '',
  ].filter(Boolean).join(', ')
  if (!bidChanges.length && !newKeywords.length && !negatives.length) return { ok: false, error: `${c.name}: nothing changes — ${leftWords}.` }
  const highest = Math.max(0, ...bidChanges.map((b) => b.toCents), ...newKeywords.map((k) => k.bidCents))
  const reach = await ebayReach({ marketplace: c.marketplace, externalCampaignId: c.externalCampaignId, account: c.channelConnectionId }, highest)
  if ('refused' in reach) return { ok: false, error: reach.refused }
  const parts = [
    bidChanges.length ? `changes ${plural(bidChanges.length, 'keyword bid')}` : '',
    newKeywords.length ? `adds ${plural(newKeywords.length, 'keyword')}` : '',
    negatives.length ? `adds ${plural(negatives.length, 'negative keyword')}` : '',
  ].filter(Boolean)
  return {
    ok: true,
    preview: {
      action: 'ebay-keywords-change',
      campaign: { id: c.id, name: c.name, marketplace: c.marketplace },
      currency,
      adGroup: group,
      bidChanges,
      adds: newKeywords,
      negatives,
      left,
      reach: reach.reach,
      reachNote: reach.note,
      effect: `In ${c.name}: ${parts.join(', ')}${leftWords ? `; left as they are: ${leftWords}` : ''}. A keyword's status is never changed here: nothing is paused.`,
    },
  }
}

/** The bids now of the keywords a change recorded (null for one that is gone). */
async function currentBids(campaignId: string, keywordIds: string[]): Promise<Record<string, number | null>> {
  const rows = await ebayKeywordsById(campaignId, keywordIds)
  return Object.fromEntries(keywordIds.map((id) => [id, rows.get(id)?.bidCents ?? null]))
}

const ebayKeywordsChange: AgentTool = {
  name: 'ebay-keywords-change',
  title: 'Change eBay keywords',
  input: z.object({
    ebayCampaignId: ebayCampaignIdArg,
    keywordBids: z.array(z.object({
      ebayKeywordId: z.string().trim().min(1).max(64).describe('Nexus eBay keyword id'),
      bidCents: bidArg.describe('its new bid in minor units (cents) of the campaign\'s own currency'),
    })).max(LIST_MAX).optional().describe('new bids for the campaign\'s keywords (a bid only: a keyword is never paused here), at most 250'),
    ebayAdGroupId: z.string().trim().min(1).max(64).optional().describe('the Nexus eBay ad group new keywords and negatives join'),
    addKeywords: z.array(z.object({
      text: keywordTextArg,
      matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']).describe('how it matches a search'),
      bidCents: bidArg.describe('its bid in minor units (cents) of the campaign\'s own currency'),
    })).max(LIST_MAX).optional().describe('keywords to add to the ad group, at most 250'),
    addNegatives: z.array(z.object({
      text: keywordTextArg,
      matchType: z.enum(['EXACT', 'PHRASE']).describe('how it blocks a search'),
    })).max(LIST_MAX).optional().describe('negative keywords to add to the ad group, at most 250'),
    why: whyArg,
  }),
  requires: [F.adsBidsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Bids go back; a keyword it added is lowered to the 2-cent floor (never paused, d3); a negative it added stays.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as { ebayCampaignId?: string; bids?: Record<string, number> }
      return { ...after, bids: await currentBids(String(after.ebayCampaignId ?? ''), Object.keys(after.bids ?? {})) }
    },
    request(change) {
      const before = (change.before ?? {}) as { ebayCampaignId?: string; bids?: Record<string, number> }
      const after = (change.after ?? {}) as { added?: string[] }
      const restore = Object.entries(before.bids ?? {}).map(([ebayKeywordId, bidCents]) => ({ ebayKeywordId, bidCents }))
      const lower = (after.added ?? []).map((ebayKeywordId) => ({ ebayKeywordId, bidCents: EBAY_FLOOR_BID_CENTS }))
      if (!before.ebayCampaignId || !(restore.length + lower.length)) return { refusal: 'Nothing to put back: this change moved no bid and added no keyword (a negative keyword it added stays).' }
      return { tool: 'ebay-keywords-change', args: { ebayCampaignId: before.ebayCampaignId, keywordBids: [...restore, ...lower], why: 'undo of an earlier keyword change: old bids back, added keywords to the 2-cent floor' } }
    },
  },
  description:
    'Change the keywords of an eBay manual Priority (cost-per-click) campaign: new bids for its keywords, new keywords '
    + 'and new negative keywords in one of its ad groups. A keyword\'s status is never changed (nothing is paused). Bids '
    + 'are in minor units of the campaign\'s own currency (never converted). Nothing changes until '
    + 'a person approves it in Nexus; it always waits for a person. The preview lists every change and what is left alone '
    + 'and why, and where it lands: live on the campaign\'s eBay account, or SANDBOX when eBay ad writes are off (nothing '
    + 'reaches eBay). Undo puts old bids back and lowers added keywords to the 2-cent floor; added negatives stay.',
  async handler(args) {
    return keywordsPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await keywordsPreview(args)
    const refusal = ebayRecheck(ctx, fresh, ['bidChanges', 'adds', 'negatives', 'adGroup', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as {
      campaign: { id: string }; adGroup: { id: string } | null; reach: EbayReach; effect: string
      bidChanges: Array<{ keywordId: string; fromCents: number; toCents: number }>
      adds: Array<{ text: string; matchType: string; bidCents: number }>; negatives: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>
    }
    const approved = await approvedOp(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in approved) return notRun(approved.refusal!)
    const w = await writes()
    const failed: Array<{ key: string; error: string }> = []
    let movedBids: typeof p.bidChanges = []
    if (p.bidChanges.length) {
      // A bid only: `status` is never passed, so nothing is paused or re-enabled. One result per update, in order.
      const out = await w.updateKeywords(approved.op, p.campaign.id, p.bidChanges.map((b) => ({ keywordId: b.keywordId, bidCents: b.toCents })))
      movedBids = p.bidChanges.filter((_, i) => out.results[i]?.ok)
      failed.push(...out.results.filter((r) => !r.ok).map((r) => ({ key: r.key, error: r.error ?? 'refused' })))
    }
    const addedBids: Record<string, number> = {}
    if (p.adds.length && p.adGroup) {
      const out = await w.addKeywords(approved.op, p.campaign.id, p.adGroup.id, p.adds)
      const ok = new Set(out.results.filter((r) => r.ok).map((r) => r.key.trim().toLowerCase()))
      const terms = await ebayAdGroupTerms(p.adGroup.id)
      for (const a of p.adds) {
        const id = ok.has(a.text.toLowerCase()) ? terms.keywords.get(`${a.matchType} ${a.text.toLowerCase()}`) : undefined
        if (id) addedBids[id] = a.bidCents
      }
      failed.push(...out.results.filter((r) => !r.ok).map((r) => ({ key: r.key, error: r.error ?? 'refused' })))
    }
    let negatives = 0
    if (p.negatives.length && p.adGroup) {
      const out = await w.addNegatives(approved.op, p.campaign.id, p.adGroup.id, p.negatives)
      negatives = out.results.filter((r) => r.ok).length
      failed.push(...out.results.filter((r) => !r.ok).map((r) => ({ key: r.key, error: r.error ?? 'refused' })))
    }
    const added = Object.keys(addedBids)
    const results = { bids: movedBids.length, added: added.length, negatives, failed }
    if (!(movedBids.length + added.length + negatives)) return { ok: false, error: `Not changed: eBay refused every change (${failed.slice(0, 3).map((f) => `${f.key}: ${f.error}`).join('; ')}).` }
    const change = {
      before: { ebayCampaignId: p.campaign.id, bids: Object.fromEntries(movedBids.map((b) => [b.keywordId, b.fromCents])), changeSetId: approved.run.changeSetId },
      after: { ebayCampaignId: p.campaign.id, bids: { ...Object.fromEntries(movedBids.map((b) => [b.keywordId, b.toCents])), ...addedBids }, added, negatives },
    }
    return { ok: true, data: { ebayCampaignId: p.campaign.id, ...results, reach: p.reach, changeSetId: approved.run.changeSetId }, change }
  },
}

// ── create-ebay-campaign (A15) ──────────────────────────────────────────────────────────────────

/** Days a month of a daily budget can run: a Priority campaign's budget must fit the market's monthly ceiling this many times. */
const DAYS_IN_A_MONTH = 31

async function createPreview(args: Record<string, unknown>): Promise<ToolResult> {
  const asked = String(args.market ?? '').trim().toUpperCase()
  const shortCode = EBAY_MARKETPLACE_SHORT[asked] ?? asked.replace(/^EBAY_/, '')
  const market = await prisma.marketplace.findFirst({
    where: { channel: 'EBAY', OR: [{ marketplaceId: asked }, { code: shortCode === 'GB' ? 'UK' : shortCode }] },
    select: { code: true, marketplaceId: true, currency: true },
  })
  if (!market) return { ok: false, error: `eBay marketplace ${asked} not found in Nexus (no eBay market of that code is set up).` }
  const marketplace = market.marketplaceId?.trim() || `EBAY_${market.code}`
  const name = String(args.name ?? '').trim()
  const fundingModel = args.fundingModel === 'COST_PER_CLICK' ? 'COST_PER_CLICK' : 'COST_PER_SALE'
  const currency = (market.currency ?? '').trim().toUpperCase() || null
  if (!currency) return { ok: false, error: `No currency is configured for EBAY/${market.code}. Set it on the marketplace first.` }
  const taken = await ebayCampaignNamed(marketplace, name)
  if (taken) return { ok: false, error: `${marketplace} already has an eBay campaign named "${name}" (${taken.id}): give the new one another name.` }
  // The account createCampaign itself will use (the write layer decides it, not this preview).
  const account = await (await writes()).newCampaignAccount()
  if (!account) return { ok: false, error: 'No eBay account is connected (or none is the primary): a campaign is created on the primary eBay account.' }
  const accountOut = { connectionId: account.id, name: (account as { accountLabel?: string | null }).accountLabel ?? (account as { displayName?: string | null }).displayName ?? null }

  let ceiling: { monthlyCapCents: number; currency: string } | null = null
  let dailyBudgetCents: number | null = null
  if (fundingModel === 'COST_PER_CLICK') {
    dailyBudgetCents = Math.round(Number(args.dailyBudgetCents))
    if (!(dailyBudgetCents >= 100)) return { ok: false, error: 'A Priority (cost-per-click) campaign needs dailyBudgetCents (at least 100).' }
    const row = await ebayMarketCeiling(marketplace)
    if (!row) {
      return { ok: false, error: `Set an eBay spend ceiling for ${marketplace} first: a Priority (cost-per-click) campaign has no low start on eBay — it spends its daily budget from the first day — so Claude creates one only in a market with a monthly eBay spend ceiling.` }
    }
    if (row.killSwitch) return { ok: false, error: `Not queued: kill switch is ON for EBAY/${marketplace} — all ad writes are halted.` }
    if (row.currency.trim().toUpperCase() !== currency) {
      return { ok: false, error: `${marketplace}'s eBay spend ceiling is in ${row.currency} and its budgets are in ${currency}: they cannot be compared (nothing is converted). Set the ceiling in ${currency} first.` }
    }
    if (dailyBudgetCents * DAYS_IN_A_MONTH > row.monthlyCapCents) {
      return { ok: false, error: `A daily budget of ${amountLabel(dailyBudgetCents, currency)} runs to ${amountLabel(dailyBudgetCents * DAYS_IN_A_MONTH, currency)} in a month, above ${marketplace}'s eBay spend ceiling of ${amountLabel(row.monthlyCapCents, row.currency)} a month.` }
    }
    ceiling = { monthlyCapCents: row.monthlyCapCents, currency: row.currency }
  }
  const reach = await ebayReach({ marketplace, account: account.id }, dailyBudgetCents ?? 0)
  if ('refused' in reach) return { ok: false, error: reach.refused }
  const general = fundingModel === 'COST_PER_SALE'
  return {
    ok: true,
    preview: {
      action: 'create-ebay-campaign',
      plan: {
        market: marketplace,
        name,
        fundingModel,
        ...(general ? { ratePct: EBAY_MIN_RATE_PCT, adRateStrategy: 'FIXED' } : { targeting: 'MANUAL', dailyBudgetCents }),
        currency,
      },
      account: accountOut,
      ceiling,
      reach: reach.reach,
      reachNote: reach.note,
      effect: general
        ? `Creates the eBay General (cost-per-sale) campaign "${name}" on ${marketplace} at eBay's lowest ad rate, ${EBAY_MIN_RATE_PCT}%, with no listings: it spends nothing until a person approves promote-ebay-listings, which sets each listing's rate (${EBAY_MIN_RATE_PCT}% unless asked otherwise).`
        : `Creates the eBay manual Priority (cost-per-click) campaign "${name}" on ${marketplace} with a daily budget of ${amountLabel(dailyBudgetCents!, currency)}, inside the market's eBay spend ceiling. It has no ad groups, keywords or listings yet, so it spends nothing until they are added.`,
      nextSteps: general ? ['promote-ebay-listings: the listings it promotes, and each one\'s rate'] : ['add an ad group in Nexus Ads → eBay, then ebay-keywords-change and promote-ebay-listings'],
    },
  }
}

const createEbayCampaign: AgentTool = {
  name: 'create-ebay-campaign',
  title: 'Create an eBay campaign',
  input: z.object({
    market: z.string().trim().toUpperCase().min(2).max(40).describe('the eBay marketplace: EBAY_IT, EBAY_DE, EBAY_FR, EBAY_ES or EBAY_GB (or IT, DE, …)'),
    name: z.string().trim().min(1).max(80).describe('the campaign name; it must be new in its market'),
    fundingModel: z.enum(['COST_PER_SALE', 'COST_PER_CLICK']).default('COST_PER_SALE')
      .describe('COST_PER_SALE (General: a rate per sale, starts at eBay\'s 2% minimum with no listings) or COST_PER_CLICK (Priority: a daily budget; only where the market has an eBay spend ceiling)'),
    dailyBudgetCents: z.coerce.number().int().min(100).optional().describe('Priority only: the daily budget in minor units of the market\'s currency, at least 100'),
    why: whyArg,
  }),
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Nexus never ends, deletes or pauses a campaign (d3): what is created stays.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Create a new eBay Promoted Listings campaign on the primary eBay account. A General (cost-per-sale) campaign starts '
    + 'as low as eBay allows: its rate is eBay\'s 2% minimum and it has no listings, so it spends nothing until a person '
    + 'approves promote-ebay-listings. A Priority (cost-per-click) campaign has no low start (it spends a daily budget), so '
    + 'it is refused unless the market has an eBay spend ceiling (in the market\'s currency) that holds 31 days of the budget. '
    + 'Nothing is created until a person approves it in Nexus; it always waits for a person. The preview shows the plan, '
    + 'the account and where it lands: live, or SANDBOX when eBay ad writes are off (nothing reaches eBay). It cannot be '
    + 'undone (Nexus never ends or deletes a campaign).',
  async handler(args) {
    return createPreview(args)
  },
  async execute(args, ctx) {
    const fresh = await createPreview(args)
    const refusal = ebayRecheck(ctx, fresh, ['plan', 'account', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { plan: { market: string; name: string; fundingModel: 'COST_PER_SALE' | 'COST_PER_CLICK'; ratePct?: number; dailyBudgetCents?: number | null }; reach: EbayReach; effect: string }
    const approved = await approvedOp(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in approved) return notRun(approved.refusal!)
    const { createCampaign } = await writes()
    try {
      const out = await createCampaign(approved.op, {
        name: p.plan.name,
        marketplace: p.plan.market,
        fundingModel: p.plan.fundingModel,
        ...(p.plan.fundingModel === 'COST_PER_SALE'
          ? { ratePct: EBAY_MIN_RATE_PCT, adRateStrategy: 'FIXED' as const }
          : { targetingType: 'MANUAL' as const, dailyBudgetCents: p.plan.dailyBudgetCents! }),
      })
      return {
        ok: true,
        data: { ebayCampaignId: out.campaignId, externalCampaignId: out.externalCampaignId, mode: out.mode, reach: p.reach, changeSetId: approved.run.changeSetId },
        change: { before: { ebayCampaignId: null }, after: { ebayCampaignId: out.campaignId, name: p.plan.name, market: p.plan.market } },
      }
    } catch (e) {
      return notRun(`Not run: the campaign was not created (${(e as Error).message}).`)
    }
  },
}

export const EBAY_AD_TOOLS: AgentTool[] = [setEbayAdRates, promoteEbayListings, setEbayCampaignBudget, ebayKeywordsChange, createEbayCampaign]
