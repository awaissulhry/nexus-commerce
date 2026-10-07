/**
 * ADS AUTONOMY W4-3 (Owner 10-07: Claude works like a worker — every Amazon ads action on the Nexus screens has a tool) —
 * set-campaign-settings: what a person sets on a campaign's Details tab (marketing/ads/campaigns/[id]) and with the Ad
 * Manager's bulk "Portfolio" menu, for up to 100 Sponsored Products campaigns in ONE request (one step of the daily cap):
 *
 *   portfolioId      into a portfolio (Amazon's id, one of the campaign's own market that Amazon holds: CM-21), or out
 *                    of its portfolio (null)
 *   name             a new name (one campaign at a time; a market takes one campaign per name)
 *   endDate          the last day it runs, or none (null: it runs until stopped)
 *   biddingStrategy  Amazon's names: legacyForSales ("Dynamic bids - down only"), autoForSales ("Dynamic bids - up and
 *                    down": Amazon may raise each bid up to 100 %), manual ("Fixed bids")
 *
 * The screens' own write: updateCampaignWithSync (PATCH /advertising/campaigns/:id), queued for Amazon after the 5-minute
 * cancel window — the Details tab and the bulk menu send exactly these fields through it. One write per campaign.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview names each campaign from → to and where it lands (live at
 * Amazon on which profile, or sandbox); a refusal is not queued; it runs only as an approved request, as the approver
 * with changeSetId = the approval; `execute` refuses when what was approved moved. A person's approval is his own click
 * (4A: it passes the live-write allowlist, as on the screen); a run by the business's rule is a machine's write, so the
 * allowlist binds it (`ruleGate`: a campaign off the allowlist never runs by rule). Whatever can add spend — up-and-down
 * bidding (or fixed bids after down only), an end date removed or moved later, leaving a portfolio's budget cap for a
 * looser one or none — is listed in `raises` and said in the effect; the Owner's code rule (ads-code-rule.ts) makes it a
 * day-to-day change: a person's approval sends it with no authenticator code (settingsStepUp decides it). Strategy-bound
 * (ads-autonomy-kit.ts): the settings kind; by default nothing runs by rule (maxItems 0, no market or campaign listed).
 * Undo asks this tool to put each campaign's settings back.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { campaignNameKey, campaignNameProblem } from '@nexus/shared/ads-campaign-name'
import prisma from '../../../db.js'
import { updateCampaignWithSync, type CampaignPatch } from '../../advertising/ads-mutation.service.js'
import { campaignNamedInMarket } from '../../advertising/ads-create.service.js'
import { portfolioDetails, type PortfolioDetail } from '../../advertising/ads-portfolio.service.js'
import { playbookHolds } from '../../advertising/ads-playbook/held.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { ADDS_NO_SPEND, addsSpendWords, codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import { checkLiveReach, type LiveReach } from './ads-tool-guards.js'
import { approvedRun, BY_RULE_WORDS, canonical, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, spOnlyRefusal, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, type KitItem } from './ads-autonomy-kit.js'
import { capMove, capOf, currencyOfMarket, type HeldCap } from './ads-portfolio.tools.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-campaign-settings'
/** The most campaigns one request names. */
const MAX_CAMPAIGNS = 100
/** At most this many campaigns are listed in a preview; the rest are counted. */
const LINES_SHOWN = 50

const STRATEGIES = ['legacyForSales', 'autoForSales', 'manual'] as const
type Strategy = (typeof STRATEGIES)[number]
/** Amazon's API names ↔ Nexus's stored enum (Campaign.biddingStrategy). */
const STORED: Record<Strategy, 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'> = { legacyForSales: 'LEGACY_FOR_SALES', autoForSales: 'AUTO_FOR_SALES', manual: 'MANUAL' }
const API_NAME: Record<string, Strategy> = { LEGACY_FOR_SALES: 'legacyForSales', AUTO_FOR_SALES: 'autoForSales', MANUAL: 'manual' }
/** The Details tab's own words for each. */
const STRATEGY_WORDS: Record<Strategy, string> = { legacyForSales: 'Dynamic bids - down only', autoForSales: 'Dynamic bids - up and down', manual: 'Fixed bids' }
/** How high Amazon may bid with each: down only (at most the bid) < fixed (the bid) < up and down (up to twice it). */
const STRATEGY_RANK: Record<Strategy, number> = { legacyForSales: 0, manual: 1, autoForSales: 2 }

const SETTINGS = ['portfolioId', 'name', 'endDate', 'biddingStrategy'] as const
type Setting = (typeof SETTINGS)[number]
const SETTING_WORDS: Record<Setting, string> = { portfolioId: 'Portfolio', name: 'Name', endDate: 'End date', biddingStrategy: 'Bidding strategy' }

/** The settings of one campaign, in this tool's own words (what a request asks, and what a change records). */
interface Values { portfolioId?: string | null; name?: string; endDate?: string | null; biddingStrategy?: Strategy }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const today = () => new Date().toISOString().slice(0, 10)
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const named = (list: string[], shown = 3) => (list.length > shown ? `${list.slice(0, shown).join(', ')} and ${list.length - shown} more` : list.join(', '))

// ── What a request names ──────────────────────────────────────────────────────────────────────────

const ID = z.string().trim().min(1).max(64)
const DATE = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')
const settingArgs = {
  portfolioId: ID.nullable().optional()
    .describe("into this portfolio: Amazon's portfolio id (portfolioId in ad-portfolios), one of the campaign's own market that Amazon holds; null = out of its portfolio"),
  name: z.string().trim().min(1).max(128).optional().describe('a new name (one campaign per name in a market)'),
  endDate: DATE.nullable().optional().describe('the last day it runs (YYYY-MM-DD, today or later); null = no end date: it runs until stopped'),
  biddingStrategy: z.enum(STRATEGIES).optional()
    .describe('Amazon\'s bidding strategy: legacyForSales = "Dynamic bids - down only"; autoForSales = "Dynamic bids - up and down" (Amazon may raise each bid up to 100 %); manual = "Fixed bids"'),
}
const input = z.object({
  campaignIds: z.array(ID).max(MAX_CAMPAIGNS).optional()
    .describe(`the campaigns that all take the settings given beside them: Nexus ids (campaignId in ad-campaigns), at most ${MAX_CAMPAIGNS}`),
  ...settingArgs,
  name: settingArgs.name.describe('a new name: only with ONE campaign in campaignIds (a market takes one campaign per name)'),
  campaigns: z.array(z.object({ campaignId: ID.describe('Nexus campaign id (campaignId in ad-campaigns)'), ...settingArgs })).max(MAX_CAMPAIGNS).optional()
    .describe(`instead of campaignIds: each campaign with its own settings (an undo puts each back this way), at most ${MAX_CAMPAIGNS}`),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const CAMPAIGN_SELECT = {
  id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, externalCampaignId: true, portfolioId: true,
  startDate: true, endDate: true, biddingStrategy: true,
} as const
type CampaignRow = { id: string; name: string; type: unknown; adProduct: string | null; marketplace: string | null; status: unknown; externalCampaignId: string | null; portfolioId: string | null; startDate: Date; endDate: Date | null; biddingStrategy: unknown }

/** A campaign's settings now, in this tool's words. */
const valuesOf = (c: CampaignRow): Required<Values> => ({
  portfolioId: c.portfolioId ?? null, name: c.name, endDate: day(c.endDate), biddingStrategy: API_NAME[String(c.biddingStrategy)] ?? 'legacyForSales',
})

/** A value as a person reads it. */
function wordsOf(setting: Setting, value: unknown, portfolios: ReadonlyMap<string, PortfolioDetail>): string {
  if (setting === 'portfolioId') {
    if (value == null) return 'no portfolio'
    const pf = portfolios.get(String(value))
    return pf ? `portfolio "${pf.name}"` : `portfolio ${String(value)}`
  }
  if (setting === 'endDate') return value == null ? 'no end date' : String(value)
  if (setting === 'biddingStrategy') return STRATEGY_WORDS[value as Strategy] ?? String(value)
  return `"${String(value)}"`
}

/** One campaign's change: each setting from → to, which way it moves spend and why. */
interface Item {
  campaignId: string
  label: string
  market: string | null
  set: Partial<Record<Setting, { from: unknown; to: unknown }>>
  direction: 'raise' | 'cut' | 'same'
  raisesWhy: string[]
  /** The settings that can add spend. */
  raising: Setting[]
  /** A campaign an ads playbook built: a portfolio move leaves the playbook's portfolio. */
  playbookBuilt?: true
}

/**
 * set-campaign-settings' code decision, in ONE place: the Owner's code rule (ads-code-rule.ts) makes up-and-down bidding,
 * an end date removed or moved later and a looser portfolio cap a day-to-day change — listed in raises and said in the
 * effect, and a person's approval sends it (no stepUp).
 */
function settingsStepUp(raising: readonly Item[]): { stepUp?: StepUp; noCode?: string } {
  if (!raising.length) return { noCode: ADDS_NO_SPEND }
  if (!needsCode('set-campaign-settings')) return { noCode: DAY_TO_DAY_NO_CODE }
  return {
    stepUp: {
      what: `changes settings that can add spend on ${plural(raising.length, 'campaign')}`,
      raises: [...new Set(raising.flatMap((i) => i.raising.map((s) => SETTING_WORDS[s])))],
      needs: STEP_UP_NEEDS,
      how: 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in Claude with theirs. '
        + "By rule only inside this tool's limits (allowUpAndDown, allowEndDateRemoval), which are loosened only with that code.",
    },
  }
}

/**
 * The caps of these portfolios, in the shape capMove compares (null: none). FAIL CLOSED: a cap Nexus cannot read (an
 * unknown policy, no amount or currency) is an UnreadCap, and any move into or out of it counts as a raise.
 */
async function capsOf(portfolios: ReadonlyMap<string, PortfolioDetail>): Promise<Map<string, HeldCap | null>> {
  const out = new Map<string, HeldCap | null>()
  for (const [id, pf] of portfolios) out.set(id, capOf(pf, pf.cap?.currency ?? (await currencyOfMarket(pf.market))))
  return out
}

/** Pure — which way one setting moves spend, and why when it can add spend. */
export function settingMove(setting: Setting, from: unknown, to: unknown, ctx: { fromCap?: HeldCap | null; toCap?: HeldCap | null; words: (s: Setting, v: unknown) => string }): { direction: 'raise' | 'cut' | 'same'; why: string | null } {
  if (setting === 'biddingStrategy') {
    const a = STRATEGY_RANK[from as Strategy] ?? 0, b = STRATEGY_RANK[to as Strategy] ?? 0
    if (b > a) return { direction: 'raise', why: `its bidding strategy moves from ${ctx.words(setting, from)} to ${ctx.words(setting, to)}: Amazon may bid ${to === 'autoForSales' ? 'up to twice its bids' : 'its full bids, never lowering them'}` }
    return { direction: b < a ? 'cut' : 'same', why: null }
  }
  if (setting === 'endDate') {
    if (to == null && from != null) return { direction: 'raise', why: `its end date ${String(from)} is removed: it keeps spending until stopped` }
    if (from == null && to != null) return { direction: 'cut', why: null }
    if (String(to) > String(from)) return { direction: 'raise', why: `its end date moves later, from ${String(from)} to ${String(to)}: it spends longer` }
    return { direction: 'cut', why: null }
  }
  if (setting === 'portfolioId') {
    // The budget caps it leaves and joins (capMove: a cap let go, a looser one, or one Nexus cannot read is a raise).
    const move = capMove(ctx.fromCap ?? null, ctx.toCap ?? null)
    return move.direction === 'raise'
      ? { direction: 'raise', why: `it moves from ${ctx.words(setting, from)} to ${ctx.words(setting, to)}: ${move.why}` }
      : { direction: move.direction, why: null }
  }
  return { direction: 'same', why: null }
}

/** A campaign's portfolio Nexus holds no row for: its cap is unknown, so leaving it counts as a raise (fail closed). */
const UNKNOWN_PORTFOLIO: HeldCap = { unread: true, why: 'Nexus holds no copy of that portfolio', policy: null, amountCents: null, currency: null }

/** Why Nexus cannot change this campaign's settings at all; null when it may. */
function cannotChange(c: CampaignRow): string | null {
  const notSp = spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name })
  if (notSp) return notSp
  if (String(c.status) === 'ARCHIVED') return 'it is archived: Amazon does not change an archived campaign'
  if (String(c.status) === 'DRAFT') return 'it is a draft in Nexus and was never sent to Amazon'
  if (!c.externalCampaignId) return 'Nexus holds no Amazon id for it: it is not at Amazon'
  return null
}

const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult, items: [] as Item[] })

/** Where the writes land: every campaign must answer the same, or the request is refused (as ads-status.tools.ts). */
async function reachOf(writes: RuleWrite[]): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
  const profiles = new Set<string>()
  const past = new Map<string, { limit: string; reason: string }>()
  for (const { label: _label, ...intent } of writes) {
    const reach = await checkLiveReach(intent)
    if (reach.reach === 'refused') return { refused: reach }
    if (reach.reach === 'live') {
      profiles.add(reach.profileId)
      for (const l of reach.pastOwnLimits ?? []) past.set(`${l.limit}|${l.reason}`, { limit: l.limit, reason: l.reason })
    }
  }
  if (!profiles.size) return { reach: { reach: 'sandbox' } }
  return { reach: { reach: 'live', profileId: [...profiles].sort().join(','), ...(past.size ? { pastOwnLimits: [...past.values()] } : {}) } }
}

/** The request decided: its preview, and every campaign it changes (all of them, not only the lines shown). */
async function decide(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; items: Item[] }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: Args = parsed.data
  const shared: Values = Object.fromEntries(SETTINGS.filter((s) => a[s] !== undefined).map((s) => [s, a[s]])) as Values
  if (a.campaignIds?.length && a.campaigns?.length) return refuse('Name the campaigns one way: campaignIds (all take the settings beside them) or campaigns (each with its own settings), not both.')
  if (a.campaigns?.length && Object.keys(shared).length) return refuse('With campaigns, each campaign carries its own settings: give none beside the list.')
  const asks: Array<{ campaignId: string; values: Values }> = a.campaigns?.length
    ? a.campaigns.map(({ campaignId, ...values }) => ({ campaignId, values: Object.fromEntries(SETTINGS.filter((s) => values[s] !== undefined).map((s) => [s, values[s]])) as Values }))
    : (a.campaignIds ?? []).map((campaignId) => ({ campaignId, values: shared }))
  if (!asks.length) return refuse('Name the campaigns: campaignIds (with the settings for all of them) or campaigns (each with its own settings).')
  if (asks.length > MAX_CAMPAIGNS) return refuse(`${asks.length} campaigns named: at most ${MAX_CAMPAIGNS} change in one request. Split them.`)
  const twice = asks.map((x) => x.campaignId).filter((id, i, all) => all.indexOf(id) !== i)
  if (twice.length) return refuse(`Not queued: campaign ${named([...new Set(twice)])} is named twice.`)
  if (a.campaignIds && a.campaignIds.length > 1 && shared.name !== undefined) return refuse('A name is for one campaign: rename one campaign per request (or give each its own name in campaigns).')

  // The campaigns first: one of another business reads as not found, before anything else is said.
  const rows = await prisma.campaign.findMany({ where: { id: { in: asks.map((x) => x.campaignId) } }, select: CAMPAIGN_SELECT }) as CampaignRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = asks.filter((x) => !byId.has(x.campaignId)).map((x) => x.campaignId)
  if (missing.length) return refuse(`Not queued: campaign ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.`)
  const label = (c: CampaignRow) => `campaign "${c.name}"`
  const cannot = asks.map((x) => byId.get(x.campaignId)!).filter((c) => cannotChange(c))
  if (cannot.length) return refuse(`Not queued: ${named(cannot.map((c) => `${label(c)}: ${cannotChange(c)}`))}.`)
  const empty = asks.filter((x) => !Object.keys(x.values).length)
  if (empty.length) return refuse(`Nothing to change for ${named(empty.map((x) => label(byId.get(x.campaignId)!)))}: give portfolioId, name, endDate or biddingStrategy.`)

  // Portfolios — where they go (Amazon must hold it, in the campaign's own market: CM-21) and where they are now.
  const targetIds = [...new Set(asks.map((x) => x.values.portfolioId).filter((id): id is string => typeof id === 'string'))]
  const currentIds = [...new Set(rows.map((r) => r.portfolioId).filter((id): id is string => !!id))]
  const portfolios = new Map((await portfolioDetails({ portfolioIds: [...new Set([...targetIds, ...currentIds])] })).map((p) => [p.portfolioId, p]))
  for (const id of targetIds) {
    const pf = portfolios.get(id)
    if (!pf) return refuse(`Not queued: portfolio ${id} not found in this business (portfolioId in ad-portfolios).`)
    if (!pf.atAmazon) return refuse(`Not queued: portfolio "${pf.name}" was made in Nexus while writes were closed and Amazon does not know it, so Amazon refuses a campaign in it. Make it again with set-portfolio once writes are open.`)
    if ((pf.state ?? '').toUpperCase() === 'ARCHIVED') return refuse(`Not queued: portfolio "${pf.name}" is archived: no campaign can be moved into it.`)
  }
  const words = (s: Setting, v: unknown) => wordsOf(s, v, portfolios)
  const caps = await capsOf(portfolios)
  const built = await playbookHolds(rows.map((r) => r.id))

  const items: Item[] = []
  const already: string[] = []
  const newNames = new Map<string, string>()
  for (const ask of asks) {
    const c = byId.get(ask.campaignId)!
    const now = valuesOf(c)
    const set: Item['set'] = {}
    for (const s of SETTINGS) {
      const to = ask.values[s]
      if (to === undefined) continue
      if (to === now[s]) continue
      set[s] = { from: now[s], to }
    }
    if (!Object.keys(set).length) { already.push(label(c)); continue }
    if (set.portfolioId && typeof set.portfolioId.to === 'string') {
      const pf = portfolios.get(set.portfolioId.to)!
      if (pf.market && c.marketplace && pf.market !== c.marketplace) {
        return refuse(`Not queued: portfolio "${pf.name}" is in ${pf.market} and ${label(c)} in ${c.marketplace}: a portfolio holds one market's campaigns.`)
      }
    }
    if (set.name) {
      const name = String(set.name.to)
      const problem = campaignNameProblem(name)
      if (problem) return refuse(`Not queued: ${problem}`)
      const taken = c.marketplace ? await campaignNamedInMarket(c.marketplace, name) : null
      if (taken && taken.id !== c.id) return refuse(`Not queued: ${c.marketplace} already has a campaign named "${taken.name}": Amazon takes one campaign per name, so give ${label(c)} another name.`)
      const other = newNames.get(campaignNameKey(name))
      if (other) return refuse(`Not queued: two campaigns of this request would both be named "${name}" (${other} and ${label(c)}).`)
      newNames.set(campaignNameKey(name), label(c))
    }
    if (set.endDate && set.endDate.to != null) {
      const end = String(set.endDate.to)
      const valid = !Number.isNaN(Date.parse(`${end}T00:00:00Z`)) && new Date(`${end}T00:00:00Z`).toISOString().slice(0, 10) === end
      if (!valid) return refuse(`Not queued: ${end} is not a real date (YYYY-MM-DD).`)
      if (end < today()) return refuse(`Not queued: the end date ${end} of ${label(c)} is in the past, which would end it at once. To stop a campaign for a while lower its bids (suppress-campaign); for a real stop pause it (pause-ads).`)
      if (end < day(c.startDate)!) return refuse(`Not queued: the end date ${end} of ${label(c)} is before its start date ${day(c.startDate)}.`)
    }
    const raisesWhy: string[] = []
    const raising: Setting[] = []
    let cuts = false
    for (const [s, v] of Object.entries(set) as Array<[Setting, { from: unknown; to: unknown }]>) {
      const move = settingMove(s, v.from, v.to, {
        words,
        // A portfolio Nexus does not hold (synced away) has a cap it cannot read: fail closed.
        fromCap: s === 'portfolioId' && v.from ? (caps.has(String(v.from)) ? caps.get(String(v.from))! : UNKNOWN_PORTFOLIO) : null,
        toCap: s === 'portfolioId' && v.to ? caps.get(String(v.to)) ?? null : null,
      })
      if (move.direction === 'raise') { raisesWhy.push(move.why!); raising.push(s) }
      if (move.direction === 'cut') cuts = true
    }
    items.push({
      campaignId: c.id, label: label(c), market: c.marketplace, set, raisesWhy, raising,
      direction: raisesWhy.length ? 'raise' : cuts ? 'cut' : 'same',
      ...(set.portfolioId && built.get(c.id) === 'built' ? { playbookBuilt: true as const } : {}),
    })
  }
  if (!items.length) return refuse(`Nothing would change: ${named(already)} ${already.length === 1 ? 'has' : 'have'} these settings already.`)

  // Where it lands: each campaign's write, judged as the approver's (4A); the gate's answer as a run by rule is in ruleGate.
  const writes: RuleWrite[] = items.map((i) => ({
    campaignId: i.campaignId, marketplace: i.market,
    changes: (Object.keys(i.set) as Setting[]).map((s) => ({ field: s, valueCents: null })), label: i.label,
  }))
  const reach = await reachOf(writes)
  if ('refused' in reach) return refuse(reachRefusal(reach.refused))
  const stored = reach.reach

  const kit: KitItem[] = items.map((i) => ({
    entity: { kind: 'campaign', id: i.campaignId },
    change: {
      field: 'setting', setting: (Object.keys(i.set) as Setting[]).map((s) => SETTING_WORDS[s].toLowerCase()).join(', '),
      from: (Object.entries(i.set) as Array<[Setting, { from: unknown }]>).map(([s, v]) => `${SETTING_WORDS[s]}: ${words(s, v.from)}`).join('; '),
      to: (Object.entries(i.set) as Array<[Setting, { to: unknown }]>).map(([s, v]) => `${SETTING_WORDS[s]}: ${words(s, v.to)}`).join('; '),
      ...(i.direction === 'raise' ? { raises: true } : i.direction === 'cut' ? { cuts: true } : {}),
    },
  }))
  const facts = await ruleFactsFor({ tool: TOOL, limits: SETTINGS_LIMITS, items: kit, writes, approvalId: ctx.approvalId ?? null })

  const raising = items.filter((i) => i.direction === 'raise')
  const raises = raising.flatMap((i) => i.raisesWhy.map((why) => ({ campaignId: i.campaignId, label: i.label, why })))
  const lines = items.map((i) => ({
    campaignId: i.campaignId,
    label: i.label,
    market: i.market,
    changes: (Object.entries(i.set) as Array<[Setting, { from: unknown; to: unknown }]>).map(([s, v]) => ({ label: SETTING_WORDS[s], from: words(s, v.from), to: words(s, v.to) })),
  }))
  const warnings = items.filter((i) => i.playbookBuilt).map((i) => `${i.label} was built by an ads playbook: a portfolio move here leaves the playbook's own portfolio (its next build or sync still uses that one). A person decides; it never runs by rule.`)
  const counts = SETTINGS.map((s) => [s, items.filter((i) => i.set[s]).length] as const).filter(([, n]) => n)
  const effect = `Changes the settings of ${plural(items.length, 'Sponsored Products campaign')} (${counts.map(([s, n]) => `${SETTING_WORDS[s].toLowerCase()} on ${n}`).join(', ')}): `
    + `${named(lines.map((l) => `${l.label} — ${l.changes.map((x) => `${x.label.toLowerCase()} ${x.from} → ${x.to}`).join(', ')}`))}.`
    + (already.length ? ` ${plural(already.length, 'campaign')} already set so ${already.length === 1 ? 'is' : 'are'} left as ${already.length === 1 ? 'it is' : 'they are'}.` : '')
    + ' Queued for Amazon: each write is sent after the 5-minute cancel window.'
    + addsSpendWords(raises.map((r) => `${r.label}: ${r.why}`), !!settingsStepUp(raising).stepUp)
  return {
    items,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        totals: { changing: items.length, already: already.length },
        changes: lines.slice(0, LINES_SHOWN),
        ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
        raises,
        ...settingsStepUp(raising),
        ...(warnings.length ? { warnings } : {}),
        // AA-W2-6's facts name every campaign an enabled rule or schedule also moves.
        alsoChangedBy: facts.limitFacts.engineOwned.map((e) => ({ campaignId: e.campaignId, label: e.label, by: e.by })),
        // Every campaign's change, compact (the limits judge all of them, not only the lines shown).
        items: items.map((i) => ({ campaignId: i.campaignId, market: i.market, set: i.set, direction: i.direction, ...(i.playbookBuilt ? { playbookBuilt: true } : {}) })),
        // Every campaign named with the values it starts from and gets: a move of any after approval is caught.
        basis: hash({ items: items.map((i) => [i.campaignId, i.set]), already, caps: items.flatMap((i) => (i.set.portfolioId ? [caps.get(String(i.set.portfolioId.from)) ?? null, caps.get(String(i.set.portfolioId.to)) ?? null] : [])) }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        undoNote: 'Undo asks this tool to put each campaign\'s settings back as they were (its own request, approved like this one).',
        ...facts,
      },
    },
  }
}

// ── The other door: undo-ad-change ────────────────────────────────────────────────────────────────

/**
 * One rule for both doors: undo-ad-change puts a campaign's recorded settings back through the rollback service, with
 * none of set-campaign-settings' own checks. What would add spend that way — a looser bidding strategy, an end date removed or moved later, a
 * portfolio's cap let go (or one Nexus cannot read) — is refused there and asked of set-campaign-settings, which lists it
 * as a raise and judges it by its own limits; a portfolio change (set-portfolio, its own entity) only through undo-change
 * of its request. Null: it may go on.
 */
export async function settingsUndoRefusal(rows: ReadonlyArray<{ entityType: string; entityId: string; wrote: unknown; restores: unknown }>): Promise<string | null> {
  if (rows.some((r) => r.entityType === 'PORTFOLIO')) {
    return 'Not undone: it holds a portfolio change (set-portfolio), which undo-ad-change cannot put back. undo-change of that request asks set-portfolio for the old name and cap (a raise is listed in its preview).'
  }
  const asked = rows.filter((r) => r.entityType === 'CAMPAIGN').map((r) => {
    const before = (r.restores ?? {}) as Record<string, unknown>
    const after = (r.wrote ?? {}) as Record<string, unknown>
    const back: Values = {}
    if ('biddingStrategy' in before && before.biddingStrategy !== after.biddingStrategy && API_NAME[String(before.biddingStrategy)]) back.biddingStrategy = API_NAME[String(before.biddingStrategy)]
    if ('endDate' in before && before.endDate !== after.endDate) back.endDate = before.endDate ? String(before.endDate).slice(0, 10) : null
    if ('portfolioId' in before && (before.portfolioId ?? null) !== (after.portfolioId ?? null)) back.portfolioId = (before.portfolioId as string | null | undefined) ?? null
    return { campaignId: r.entityId, back }
  }).filter((x) => Object.keys(x.back).length)
  if (!asked.length) return null
  const rows_ = await prisma.campaign.findMany({ where: { id: { in: asked.map((x) => x.campaignId) } }, select: CAMPAIGN_SELECT }) as CampaignRow[]
  const byId = new Map(rows_.map((r) => [r.id, r]))
  const ids = [...new Set(asked.flatMap((x) => [x.back.portfolioId, byId.get(x.campaignId)?.portfolioId]).filter((id): id is string => !!id))]
  const portfolios = new Map((await portfolioDetails({ portfolioIds: ids })).map((p) => [p.portfolioId, p]))
  const caps = await capsOf(portfolios)
  const words = (s: Setting, v: unknown) => wordsOf(s, v, portfolios)
  const raises: string[] = []
  for (const x of asked) {
    const c = byId.get(x.campaignId)
    if (!c) continue
    const now = valuesOf(c)
    for (const [s, to] of Object.entries(x.back) as Array<[Setting, unknown]>) {
      if (to === now[s]) continue
      const move = settingMove(s, now[s], to, {
        words,
        fromCap: s === 'portfolioId' && now.portfolioId ? (caps.has(now.portfolioId) ? caps.get(now.portfolioId)! : UNKNOWN_PORTFOLIO) : null,
        toCap: s === 'portfolioId' && to ? caps.get(String(to)) ?? null : null,
      })
      if (move.direction === 'raise') raises.push(`campaign "${c.name}": ${move.why}`)
    }
  }
  if (!raises.length) return null
  return `Not undone: putting these campaign settings back would add spend — ${named(raises, 2)}. set-campaign-settings does that, as a raise its preview lists: ask for it there (undo-change of a Claude request asks it for you).`
}

// ── Limits: what may run by the business's rule ───────────────────────────────────────────────────

/**
 * Claude's limits for a settings change run by rule: the kit's (maxItems 0 — every request waits for a person until he
 * types a number), where it may run (a listed market or a listed campaign; none by default), and what it may do there.
 */
const SETTINGS_LIMITS = adKitLimits({ maxItems: 0 }, {
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
    .describe('the markets where a settings change may run by rule; empty = none (beside the campaigns listed)'),
  campaignIds: z.array(ID).max(250).default([])
    .describe('the campaigns (Nexus ids) where a settings change may run by rule, beside the markets; empty = none'),
  allowRename: z.boolean().default(false).describe('let a campaign be renamed by rule; never by default'),
  allowUpAndDown: z.boolean().default(false).describe('let a campaign switch to up-and-down bidding (autoForSales: Amazon may raise each bid up to 100 %) by rule; never by default'),
  allowEndDateRemoval: z.boolean().default(false).describe('let a campaign\'s end date be removed or moved later by rule (it keeps spending longer); never by default'),
})

/** set-campaign-settings' own checks around the kit's (C1–C7). Pure. */
function settingsRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; items?: Array<{ campaignId: string; market: string | null; set: Partial<Record<Setting, { from: unknown; to: unknown }>>; playbookBuilt?: boolean }> }
  if (p.action !== TOOL || !Array.isArray(p.items)) return 'there is no preview of this settings change to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  const campaigns = (limits.campaignIds as string[] | undefined) ?? []
  const outside = p.items.find((i) => !(i.market && markets.includes(i.market)) && !campaigns.includes(i.campaignId))
  if (outside) {
    const listed = [...markets, ...campaigns.map((id) => `campaign ${id}`)]
    return `a settings change runs by rule only in the markets or campaigns this business lists (${listed.length ? named(listed, 10) : 'none listed'}); campaign ${outside.campaignId} is ${outside.market ? `in ${outside.market}` : 'in no market'}: a person decides`
  }
  const common = ruleRefusal(preview, limits)
  if (common) return common
  if (p.items.some((i) => i.set.name) && limits.allowRename !== true) return 'a rename runs by rule only with allowRename; a person decides'
  if (p.items.some((i) => i.set.biddingStrategy?.to === 'autoForSales') && limits.allowUpAndDown !== true) {
    return 'up-and-down bidding lets Amazon raise each bid up to 100 %: it runs by rule only with allowUpAndDown; a person decides'
  }
  if (p.items.some((i) => i.set.endDate && i.set.endDate.from != null && (i.set.endDate.to == null || String(i.set.endDate.to) > String(i.set.endDate.from))) && limits.allowEndDateRemoval !== true) {
    return 'removing an end date (or moving it later) keeps a campaign spending longer: it runs by rule only with allowEndDateRemoval; a person decides'
  }
  if (p.items.some((i) => i.playbookBuilt)) return 'it moves a campaign an ads playbook built out of the playbook\'s portfolio; a person decides'
  return null
}

// ── Running an approved request, and its undo ─────────────────────────────────────────────────────

/** One campaign's settings as a change records them (only the ones it changed), in this tool's words. */
type Recorded = { campaignId: string } & Values

const patchOf = (values: Values): CampaignPatch => ({
  ...(values.name !== undefined ? { name: values.name } : {}),
  ...(values.portfolioId !== undefined ? { portfolioId: values.portfolioId } : {}),
  ...(values.endDate !== undefined ? { endDate: values.endDate == null ? null : new Date(`${values.endDate}T00:00:00.000Z`) } : {}),
  ...(values.biddingStrategy !== undefined ? { biddingStrategy: STORED[values.biddingStrategy] } : {}),
})

/** What is stored NOW for each campaign of a change record, in its own shape (the undo guard compares it with `after`). */
async function settingsNow(change: ToolChange): Promise<{ campaigns: Recorded[] }> {
  const recorded = ((change.after as { campaigns?: Recorded[] } | null)?.campaigns) ?? []
  const rows = recorded.length ? await prisma.campaign.findMany({ where: { id: { in: recorded.map((r) => r.campaignId) } }, select: CAMPAIGN_SELECT }) as CampaignRow[] : []
  const byId = new Map(rows.map((r) => [r.id, valuesOf(r)]))
  return {
    campaigns: recorded.map((r) => {
      const now = byId.get(r.campaignId)
      if (!now) return { campaignId: r.campaignId, name: 'NOT_FOUND' }
      return { campaignId: r.campaignId, ...Object.fromEntries(SETTINGS.filter((s) => s in r).map((s) => [s, now[s]])) }
    }),
  }
}

/** C2 — undo asks this tool to set each campaign's settings back, each with its own values. */
export const SET_CAMPAIGN_SETTINGS_UNDO: ToolUndo = {
  current: settingsNow,
  request(change) {
    const before = ((change.before as { campaigns?: Recorded[] } | null)?.campaigns) ?? []
    if (!before.length) return { refusal: 'This change does not record the settings it replaced.' }
    return { tool: TOOL, args: { campaigns: before, why: 'undo of an earlier campaign settings change' } }
  },
}

async function runApproved(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, items } = await decide(args, ctx)
  const refusal = recheck(ctx, fresh, ['basis'])
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { raises: unknown[]; reach: StoredReach; effect: string }
  // Never by rule: a portfolio move of a campaign an ads playbook built (withinLimits refuses it too; this holds the line
  // whatever decided it).
  if (ctx.decidedVia === 'auto' && items.some((i) => i.playbookBuilt)) {
    return notRun('Not run: it moves a campaign an ads playbook built out of the playbook\'s portfolio, which never runs by rule: a person approves it.')
  }
  // The code, as settingsStepUp decided it on this fresh dry run (none under the Owner's code rule).
  const gate = await codeGate(ctx, fresh.preview)
  if ('refusal' in gate) return notRun(gate.refusal)
  const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const failed: string[] = []
  const before: Recorded[] = []
  const after: Recorded[] = []
  for (const item of items) {
    const from = Object.fromEntries(Object.entries(item.set).map(([s, v]) => [s, v!.from])) as Values
    const to = Object.fromEntries(Object.entries(item.set).map(([s, v]) => [s, v!.to])) as Values
    const out = await updateCampaignWithSync({
      campaignId: item.campaignId, patch: patchOf(to),
      actor: run.actor, reason: run.reason, changeSetId: run.changeSetId,
      manual: run.manual, // 4A — a person approved it: his own click
      confirmOwnLimits: run.confirmOwnLimits,
    })
    if (!out.ok) { failed.push(`${item.label} (${out.error ?? 'refused'})`); continue }
    before.push({ campaignId: item.campaignId, ...from })
    after.push({ campaignId: item.campaignId, ...to })
  }
  const change = before.length ? { before: { changeSetId: run.changeSetId, campaigns: before }, after: { campaigns: after } } : undefined
  const data = {
    changed: before.length,
    failed: failed.length,
    reach: p.reach,
    changeSetId: run.changeSetId,
    note: 'Queued for Amazon: each change is sent after the 5-minute cancel window. approval-status follows them.',
  }
  if (failed.length) {
    return { ok: false, data, ...(change ? { change } : {}), error: `${before.length ? `Partly run: ${before.length} changed, ` : 'Not run: '}${failed.length} refused by the write — ${named(failed)}. The rest stays as it was${before.length ? '; undo-change puts back what ran' : ''}.` }
  }
  return { ok: true, data, change }
}

const setCampaignSettings: AgentTool = {
  name: TOOL,
  title: 'Change campaign settings',
  input,
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
  limits: SETTINGS_LIMITS,
  withinLimits: settingsRefusal,
  undo: SET_CAMPAIGN_SETTINGS_UNDO,
  description:
    `Change the settings of Amazon Sponsored Products campaigns, as the campaign's Details tab and the Ad Manager's bulk Portfolio menu do (up to ${MAX_CAMPAIGNS} in one request): `
    + 'move them into a portfolio (portfolioId from ad-portfolios, one of their own market that Amazon holds) or out of '
    + 'one (null), rename one campaign, set or remove an end date, and set the bidding strategy (legacyForSales = '
    + '"Dynamic bids - down only", autoForSales = "Dynamic bids - up and down", manual = "Fixed bids"). campaignIds take '
    + 'the same settings; campaigns gives each its own. Budgets, bids, placements and status have their own tools. '
    + `${BY_RULE_WORDS} (by default it does not: maxItems 0, no market or campaign listed), and by rule only on a campaign `
    + 'on the live-write allowlist. Whatever can add spend — up-and-down bidding (or fixed bids after down only), an end '
    + "date removed or moved later, leaving a portfolio's budget cap for a looser one or none — is listed in raises and "
    + 'said in the preview: a day-to-day change, so a person\'s approval sends it with no authenticator code. The preview '
    + 'lists each campaign from → to, where it lands (live at Amazon or sandbox), the '
    + 'rules that also move it and the limits that apply; each write is queued for Amazon with a 5-minute cancel window. '
    + 'Refused, and not queued, when a campaign is not found, archived, a draft or not Sponsored Products, a portfolio is '
    + 'not found, archived, made in Nexus only or in another market, a name is taken in the market, an end date is in '
    + 'the past, or Amazon\'s write gate would refuse it. A campaign an ads playbook built may be moved out of its '
    + 'portfolio, with a warning (never by rule). Undo puts each campaign\'s settings back.',
  async handler(args, ctx) {
    return (await decide(args, ctx)).result
  },
  async execute(args, ctx) {
    return runApproved(args, ctx)
  },
}

export const ADS_CAMPAIGN_SETTINGS_TOOLS: AgentTool[] = [setCampaignSettings]
