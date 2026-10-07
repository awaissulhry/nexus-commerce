/**
 * ADS AUTONOMY W1-8 — what the strategy lets Claude do alone, for ONE change Claude asks for: the strategy's level for
 * the change's kind of ad action (`claudeAutonomy`, fields.ts CLAUDE_ACTION_TOOLS), where the change lands. Claude's
 * door (claude-trust.service.ts `claudeRuleForChange`) takes the LOWER of it and the business's own level for the tool:
 * the strategy narrows, never widens (Owner decision 2026-10-06).
 *
 *   where it lands   read from the change's arguments and, once its dry run has run, its preview — per tool (PLACES):
 *                    a target or a negative → its ad group; a budget, a placement, a stop, the allowlist → its
 *                    campaign; a new campaign → its products in its market; a suggestion → what it applies to; an ad
 *                    undo → every entity it puts back; an ads automation turned up or tuned (AA-W2-11) → what it acts
 *                    on, else its market (automation-scope.ts); a pause, an enable or an archive (AA-W2-12/13) → each
 *                    campaign, ad group and target it names (a product ad → its ad group). An ad group or a campaign
 *                    resolves through its products (the safer level across them, resolve.ts), a product through product
 *                    → parent → primary category → market.
 *   fail closed      a change that reaches a whole market (a selection by market), or that Nexus cannot place more
 *                    exactly inside a market, takes the STRICTEST level any row of that market sets for its kind; one
 *                    it cannot place in any market (an id not found, a whole-account rule), the strictest of the
 *                    business. Several places: the strictest of them.
 *   never narrowed   a tool outside CLAUDE_ACTION_TOOLS, every brake among them (BRAKE_TOOLS: stopping is never harder
 *                    than going); an eBay or marketing request (the strategy covers Amazon); a market where no row says
 *                    anything about the kind.
 *
 * Read fresh on every call (a change of the strategy takes effect at once), in the business the call runs in
 * (row-level security: one business's strategy never applies in another). A business without a strategy row that
 * speaks to the kind pays one query.
 */
import prisma from '../../../db.js'
import type { ClaudeTrust } from '../../agents/tool-types.js'
import { CLAUDE_ACTION_TOOLS, CLAUDE_LEVELS, type ClaudeActionType } from './fields.js'
import { openStrategy, type StrategyView } from './effective.js'
import { automationScope, tuneScope, type AutomationScope } from './automation-scope.js'
import type { ResolvedField, StrategyRow } from './resolve.js'

/**
 * Brakes are never narrowed, whatever a strategy says: stopping automation, turning one down, a guardrail (it holds
 * the tightening), cancelling a queued ad write before it is sent (W3-2). None is in CLAUDE_ACTION_TOOLS; this list
 * holds the line if one ever were (fields.vitest.test.ts).
 */
export const BRAKE_TOOLS = ['stop-automation', 'turn-down-automation', 'set-ad-guardrail', 'cancel-queued-ad-write'] as const

/**
 * Each tool's own kind: the first it is listed under. PB-9 — a tool of several ops may also be listed under an op's own
 * kind (apply-ads-playbook under phase), so the strategy's screens name it there; OP_ACTIONS gives each op its kind.
 */
const ACTION_OF: ReadonlyMap<string, ClaudeActionType> = (() => {
  const out = new Map<string, ClaudeActionType>()
  for (const [action, tools] of Object.entries(CLAUDE_ACTION_TOOLS)) for (const tool of tools) if (!out.has(tool)) out.set(tool, action as ClaudeActionType)
  return out
})()
/** Tests only: a tool treated as one kind of ad action (no ad tool may run by rule before W2). */
const treatedAs = new Map<string, ClaudeActionType>()

/**
 * PB-5a — a tool whose ops are different kinds of ad action: the kind of each op (null: the strategy never narrows that
 * op — an adopt only writes Nexus links). An op not listed, or no args, is the tool's kind in CLAUDE_ACTION_TOOLS.
 * PB-5b — an op that is several kinds at once lists them, its own kind first: every one narrows it (the strictest wins).
 * A playbook START puts campaigns on the allowlist and their planned bids back (restore and allowlist); its STOP is a stop.
 * PB-6c — a hero creates one campaign: a create, as a build.
 */
export const OP_ACTIONS: Readonly<Record<string, Readonly<Record<string, ClaudeActionType | readonly ClaudeActionType[] | null>>>> = {
  // PB-6c — a hero creates one campaign (a create). PB-10 — a sync builds slots and adds keywords and product ads: the create kind; its negatives alone are a kind of their
  // own (op sync-negatives). PB-9 — a phase switch is its own kind.
  'apply-ads-playbook': { build: 'create', adopt: null, hero: 'create', start: ['restore', 'allowlist'], stop: 'stop', sync: 'create', 'sync-negatives': 'negative', phase: 'phase' },
}

/**
 * W4-5 — a tool whose kinds follow its arguments beyond `op`, its own kind first (every one narrows it, the strictest
 * wins): harvest-search-term negates the term in its source too, unless asked not to (negateSource false); its undo
 * lifts that negative again (a retire).
 */
export const ARG_ACTIONS: Readonly<Record<string, (args: Record<string, unknown>) => readonly ClaudeActionType[]>> = {
  'harvest-search-term': (args) => (args.op === 'undo' ? ['harvest', 'retire'] : args.negateSource === false ? ['harvest'] : ['harvest', 'negative']),
}

/** Every kind of ad action a tool is for these args (its own kind first); empty: the strategy never narrows it. */
export function actionsOfTool(toolName: string, args?: unknown): ClaudeActionType[] {
  if ((BRAKE_TOOLS as readonly string[]).includes(toolName)) return []
  const op = args && typeof args === 'object' ? (args as { op?: unknown }).op : undefined
  const ops = OP_ACTIONS[toolName]
  if (ops && typeof op === 'string' && Object.prototype.hasOwnProperty.call(ops, op)) {
    const kinds = ops[op]
    return kinds == null ? [] : typeof kinds === 'string' ? [kinds] : [...kinds]
  }
  const byArgs = ARG_ACTIONS[toolName]
  if (byArgs && args && typeof args === 'object') return [...byArgs(args as Record<string, unknown>)]
  const one = ACTION_OF.get(toolName) ?? treatedAs.get(toolName)
  return one ? [one] : []
}

/** The kind of ad action a tool is (for these args: an op of OP_ACTIONS, its own kind), or null: the strategy never narrows it. */
export function actionOfTool(toolName: string, args?: unknown): ClaudeActionType | null {
  return actionsOfTool(toolName, args)[0] ?? null
}

/** Which strategy row set the level, as the door names it to Claude and to a person. */
export interface StrategyNarrowing {
  action: ClaudeActionType
  /** The strategy's level for this kind of action where the change lands. */
  level: ClaudeTrust
  /** The market of the row that set it. */
  market: string
  row: { scope: 'market' | 'category' | 'product'; label: string; version: number; strategyId: string; via?: 'parent'; product?: string }
  /** scope: where the change lands; market / business: the strictest row there, because it could not be placed exactly. */
  basis: 'scope' | 'market' | 'business'
  /** basis market or business: why it could not be placed exactly. */
  unplaced?: string
}

// ── Where a change lands ──────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {})
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const strs = (value: unknown): string[] => list(value).map(str).filter((s): s is string => !!s)
const marketOf = (value: unknown): string | null => str(value)?.toUpperCase() ?? null

/** The places one change lands on, per market (upper-case code), and what could not be placed more exactly. */
class Place {
  readonly adGroups = new Map<string, Set<string>>()
  readonly campaigns = new Map<string, Set<string>>()
  /** Market '*': the product wherever the strategy speaks (a rule scoped to a product in no market). */
  readonly products = new Map<string, Set<string>>()
  /** A whole market, or where nothing more exact was found inside it: market → why. */
  readonly wide = new Map<string, string>()
  /** Placed in no market: why. */
  nowhere: string | null = null
  /** Not an Amazon ad change. */
  outside = false

  private add(into: Map<string, Set<string>>, market: string, id: string) {
    into.set(market, (into.get(market) ?? new Set()).add(id))
  }
  market(market: string | null, why: string) {
    if (market) { if (!this.wide.has(market)) this.wide.set(market, why) } else this.notPlaced(why)
  }
  notPlaced(why: string) {
    this.nowhere ??= why
  }

  async targets(ids: Array<string | null>) {
    const asked = [...new Set(ids.filter((id): id is string => !!id))]
    if (!asked.length) return this.notPlaced('it names no target')
    const rows = await prisma.adTarget.findMany({ where: { id: { in: asked } }, select: { id: true, adGroupId: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } } })
    for (const row of rows) {
      const market = marketOf(row.adGroup.campaign.marketplace)
      if (market) this.add(this.adGroups, market, row.adGroupId)
      else this.notPlaced('a target\'s campaign has no market in Nexus')
    }
    if (rows.length < asked.length) this.notPlaced('a target it names was not found')
  }

  async adGroupIds(ids: Array<string | null>) {
    const asked = [...new Set(ids.filter((id): id is string => !!id))]
    if (!asked.length) return this.notPlaced('it names no ad group')
    const rows = await prisma.adGroup.findMany({ where: { id: { in: asked } }, select: { id: true, campaign: { select: { marketplace: true } } } })
    for (const row of rows) {
      const market = marketOf(row.campaign.marketplace)
      if (market) this.add(this.adGroups, market, row.id)
      else this.notPlaced('an ad group\'s campaign has no market in Nexus')
    }
    if (rows.length < asked.length) this.notPlaced('an ad group it names was not found')
  }

  async campaignIds(ids: Array<string | null>) {
    const asked = [...new Set(ids.filter((id): id is string => !!id))]
    if (!asked.length) return this.notPlaced('it names no campaign')
    const rows = await prisma.campaign.findMany({ where: { id: { in: asked } }, select: { id: true, marketplace: true } })
    for (const row of rows) {
      const market = marketOf(row.marketplace)
      if (market) this.add(this.campaigns, market, row.id)
      else this.notPlaced('a campaign has no market in Nexus')
    }
    if (rows.length < asked.length) this.notPlaced('a campaign it names was not found')
  }

  /** A campaign by its Amazon id: the whole campaign, or only its market (`wideWhy`: the ad group is chosen later). */
  async externalCampaign(externalCampaignId: string | null, wideWhy?: string) {
    const row = externalCampaignId
      ? await prisma.campaign.findFirst({ where: { externalCampaignId }, select: { id: true, marketplace: true } })
      : null
    if (!row) return this.notPlaced('the campaign it names was not found')
    const market = marketOf(row.marketplace)
    if (!market) return this.notPlaced('its campaign has no market in Nexus')
    if (wideWhy) this.market(market, wideWhy)
    else this.add(this.campaigns, market, row.id)
  }

  /** An ad group by its Amazon ids (in its campaign); else the campaign. */
  async externalAdGroup(externalCampaignId: string | null, externalAdGroupId: string | null) {
    const row = externalCampaignId && externalAdGroupId
      ? await prisma.adGroup.findFirst({ where: { externalAdGroupId, campaign: { externalCampaignId } }, select: { id: true, campaign: { select: { marketplace: true } } } })
      : null
    const market = row ? marketOf(row.campaign.marketplace) : null
    if (row && market) this.add(this.adGroups, market, row.id)
    else await this.externalCampaign(externalCampaignId)
  }

  /** Products by SKU in one market (a new campaign's). */
  async skus(market: string | null, skus: string[]) {
    if (!market) return this.notPlaced('it names no market')
    const rows = skus.length ? await prisma.product.findMany({ where: { sku: { in: [...new Set(skus)] }, deletedAt: null }, select: { id: true } }) : []
    if (!rows.length) return this.market(market, 'none of its products was found')
    for (const row of rows) this.add(this.products, market, row.id)
  }

  productIds(market: string | null, ids: string[]) {
    for (const id of ids) this.add(this.products, market ?? '*', id)
  }
}

type PlaceReader = (place: Place, args: Obj, preview: Obj | null) => Promise<void> | void

const byCampaignArg: PlaceReader = (place, args) => place.campaignIds([str(args.campaignId)])

/** Amazon rule suggestions: what each one applies to (ads-suggestion-decide.service.ts reads them the same way). */
async function suggestions(place: Place, ids: string[]) {
  if (!ids.length) return place.notPlaced('it names no suggestion')
  const rows = await prisma.adsRuleSuggestion.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { entityType: true, entityId: true, marketplace: true } })
  if (rows.length < new Set(ids).size) place.notPlaced('a suggestion it names was not found')
  const targets = rows.filter((r) => r.entityType === 'AD_TARGET').map((r) => r.entityId)
  const campaigns = rows.filter((r) => r.entityType === 'CAMPAIGN').map((r) => r.entityId)
  if (targets.length) await place.targets(targets)
  if (campaigns.length) await place.campaignIds(campaigns)
  for (const row of rows.filter((r) => r.entityType !== 'AD_TARGET' && r.entityType !== 'CAMPAIGN')) {
    // SEARCH_TERM ids are `${externalCampaignId}:${query}`; anything else is held to its market.
    if (row.entityType === 'SEARCH_TERM') await place.externalCampaign(row.entityId.slice(0, Math.max(0, row.entityId.indexOf(':'))) || row.entityId)
    else place.market(marketOf(row.marketplace), 'a suggestion that names no campaign or target')
  }
}

/** An ad undo: every entity its recorded writes put back, and the negatives it retires. */
async function adUndo(place: Place, args: Obj, preview: Obj | null) {
  let setId = str(args.changeSetId)
  const actionLogId = str(args.actionLogId)
  let logs: Array<{ entityType: string; entityId: string }> = []
  if (actionLogId) {
    const one = await prisma.advertisingActionLog.findUnique({ where: { id: actionLogId }, select: { executionId: true, entityType: true, entityId: true } })
    if (!one) return place.notPlaced('the change it names was not found')
    if (one.executionId) setId = one.executionId
    else logs = [one]
  }
  if (setId) logs = await prisma.advertisingActionLog.findMany({ where: { executionId: setId, rolledBackAt: null }, select: { entityType: true, entityId: true } })
  const created = setId ? await prisma.agentChange.findFirst({ where: { approvalId: setId }, orderBy: { executedAt: 'desc' }, select: { after: true } }) : null
  const negatives = [...list(obj(created?.after).negatives), ...list(preview?.negatives)].map((n) => str(obj(n).targetId)).filter((id): id is string => !!id)
  if (!logs.length && !negatives.length) return place.notPlaced('the change set it names was not found')
  const of = (type: string) => logs.filter((l) => l.entityType === type).map((l) => l.entityId)
  if (of('AD_TARGET').length || negatives.length) await place.targets([...of('AD_TARGET'), ...negatives])
  if (of('AD_GROUP').length) await place.adGroupIds(of('AD_GROUP'))
  if (of('CAMPAIGN').length) await place.campaignIds(of('CAMPAIGN'))
  if (logs.some((l) => !['AD_TARGET', 'AD_GROUP', 'CAMPAIGN'].includes(l.entityType))) place.notPlaced('it puts back a write that names no campaign, ad group or target')
}

/** AA-W2-12/13 — a status change: every campaign, ad group (a product ad's too) and target it names. */
const byStatusArgs: PlaceReader = async (place, args) => {
  // PB-5a — archive-ads buildRunId: the campaigns a playbook build made. B-1 — or a Replicate run (replicate-ad-structure).
  const buildRunId = str(args.buildRunId)
  const built = buildRunId
    ? (await (await import('../ads-playbook/build.js')).buildRunCreated(buildRunId)) ?? (await (await import('../ads-blueprint-apply.service.js')).replicateRunCreated(buildRunId))
    : null
  if (buildRunId && !built) place.notPlaced('the playbook build or Replicate run it names was not found')
  const campaigns = [...strs(args.campaignIds), ...(built ?? [])]
  const adGroups = [...strs(args.adGroupIds), ...list(args.productAds).map((ad) => str(obj(ad).adGroupId))].filter((id): id is string => !!id)
  const targets = strs(args.targetIds)
  if (campaigns.length) await place.campaignIds(campaigns)
  if (adGroups.length) await place.adGroupIds(adGroups)
  if (targets.length) await place.targets(targets)
  if (!campaigns.length && !adGroups.length && !targets.length) place.notPlaced('it names no campaign, ad group, target or ad')
}

/** Where each ad change tool lands. Every tool of CLAUDE_ACTION_TOOLS has one (fields.vitest.test.ts). */
export const PLACES: Readonly<Record<string, PlaceReader>> = {
  'set-target-bid': (place, args) => place.targets([str(args.targetId)]),
  'bulk-ad-bid-change': async (place, args) => {
    const listed = list(args.bids).map((bid) => str(obj(bid).targetId))
    if (listed.length) return place.targets(listed)
    if (str(args.adGroupId)) return place.adGroupIds([str(args.adGroupId)])
    if (str(args.campaignId)) return place.campaignIds([str(args.campaignId)])
    place.market(marketOf(args.market), 'a selection by market reaches every ad group of it')
  },
  'create-negative-keyword': (place, args, preview) => {
    const adGroup = str(obj(preview?.adGroup).id)
    return adGroup ? place.adGroupIds([adGroup]) : place.externalAdGroup(str(args.externalCampaignId), str(args.externalAdGroupId))
  },
  'graduate-keyword': (place, args, preview) => {
    const adGroup = str(obj(preview?.destinationAdGroup).id)
    if (adGroup) return place.adGroupIds([adGroup])
    const destination = str(args.destExternalCampaignId)
    if (str(args.destExternalAdGroupId)) return place.externalAdGroup(destination ?? str(args.sourceExternalCampaignId), str(args.destExternalAdGroupId))
    if (destination) return place.externalCampaign(destination)
    // The harvest resolver chooses the destination inside the source's market when it runs.
    return place.externalCampaign(str(args.sourceExternalCampaignId), 'the ad group it lands in is chosen when it runs')
  },
  'set-placement-multipliers': byCampaignArg,
  'set-campaign-budget': byCampaignArg,
  'suppress-campaign': byCampaignArg,
  'restore-campaign': byCampaignArg,
  'set-campaign-live-writes': byCampaignArg,
  'set-campaign-target-acos': async (place, args) => {
    const ids = [...strs(args.campaignIds), ...list(args.targets).map((t) => str(obj(t).campaignId))]
    if (ids.length) await place.campaignIds(ids)
    if (str(args.market)) place.market(marketOf(args.market), 'it sets every campaign of the market')
    if (!ids.length && !str(args.market)) place.notPlaced('it names no campaign or market')
  },
  'decide-automation-suggestions': async (place, args) => {
    if (args.kind !== 'amazon-ads') { place.outside = true; return }
    await suggestions(place, list(args.decisions).map((d) => str(obj(d).suggestionId)).filter((id): id is string => !!id))
  },
  'create-ad-campaign': (place, args) => place.skus(marketOf(args.market), strs(args.skus)),
  // B-3 — a one-off SP Super Wizard set: the products it advertises.
  'build-sp-wizard-campaigns': (place, args) => place.skus(marketOf(args.market), strs(args.skus)),
  // B-1 — a copy lands on the products it advertises, in the market it is created in.
  'replicate-ad-structure': (place, args) => place.skus(marketOf(args.market), strs(args.skus)),
  // B-2 — an AI goal's products in one market, by SKU.
  'create-ai-goal-campaigns': (place, args) => place.skus(marketOf(args.market), list(args.goalProducts).map((p) => str(obj(p).sku)).filter((sku): sku is string => !!sku)),
  // PB-5a — one product's playbook in one market: the product (by id, else by SKU).
  'apply-ads-playbook': (place, args) => (str(args.productId)
    ? place.productIds(marketOf(args.market), [str(args.productId)!])
    : place.skus(marketOf(args.market), str(args.sku) ? [str(args.sku)!] : [])),
  'save-ad-rule': async (place, args) => {
    if (args.kind !== 'amazon-ads') { place.outside = true; return }
    const scope = obj(args.scope)
    const market = marketOf(scope.marketplace)
    if (scope.wholeAccount === true) return place.notPlaced('a rule for the whole account')
    if (str(scope.campaignId)) return place.campaignIds([str(scope.campaignId)])
    if (str(scope.productId)) return place.productIds(market, [str(scope.productId)!])
    if (market) return place.market(market, str(scope.portfolioId) ? 'a rule for a portfolio' : 'a rule for the whole market')
    place.notPlaced(args.scope ? 'a rule whose scope names no market, campaign or product' : 'an edit that keeps the rule\'s own scope')
  },
  'undo-ad-change': adUndo,
  'pause-ads': byStatusArgs,
  'enable-ads': byStatusArgs,
  'archive-ads': byStatusArgs,
  // W4-5 — targets and negatives: the ad groups and campaigns they land in (a negative named by its place too); the
  // negatives a retire lifts; a harvest's source and destination (its dry run names the destination it resolved); a
  // harvest destination: where it applies and the ad group it points to.
  'add-ad-targets': (place, args) => place.adGroupIds([str(args.adGroupId)]),
  'add-negative-targets': async (place, args) => {
    const each = list(args.negatives).map(obj)
    const adGroups = [...strs(args.adGroupIds), ...each.map((n) => str(n.adGroupId))].filter((id): id is string => !!id)
    const campaigns = [...strs(args.campaignIds), ...each.map((n) => str(n.campaignId))].filter((id): id is string => !!id)
    if (adGroups.length) await place.adGroupIds(adGroups)
    if (campaigns.length) await place.campaignIds(campaigns)
    if (!adGroups.length && !campaigns.length) place.notPlaced('it names no ad group or campaign')
  },
  'retire-negatives': async (place, args, preview) => {
    const resolved = list(preview?.negatives).map((n) => str(obj(n).targetId))
    const ids = [...strs(args.negativeIds), ...resolved].filter((id): id is string => !!id)
    const each = list(args.negatives).map(obj)
    const adGroups = each.map((n) => str(n.adGroupId)).filter((id): id is string => !!id)
    const campaigns = each.map((n) => str(n.campaignId)).filter((id): id is string => !!id)
    if (ids.length) await place.targets(ids)
    if (adGroups.length) await place.adGroupIds(adGroups)
    if (campaigns.length) await place.campaignIds(campaigns)
    if (!ids.length && !adGroups.length && !campaigns.length) place.notPlaced('it names no negative')
  },
  'harvest-search-term': async (place, args, preview) => {
    if (args.op === 'undo') return place.targets([str(args.keywordId), str(args.negativeId)])
    const destination = str(obj(preview?.destinationAdGroup).id) ?? str(args.destAdGroupId)
    await place.adGroupIds([str(args.sourceAdGroupId), destination])
  },
  'set-harvest-destination': async (place, args, preview) => {
    const scopeId = str(args.scopeId)
    if (args.scope === 'adGroup') await place.adGroupIds([scopeId])
    else if (args.scope === 'campaign') await place.campaignIds([scopeId])
    else if (args.scope === 'market') place.market(marketOf(scopeId), 'a harvest destination for the whole market')
    const destination = str(args.adGroupId) ?? str(obj(preview?.from).adGroupId)
    if (destination) await place.adGroupIds([destination])
    else if (args.scope !== 'adGroup' && args.scope !== 'campaign' && args.scope !== 'market') place.notPlaced('a harvest destination for a whole line, portfolio or the account that names no ad group')
  },
  // W3-3 — a stock lowering and its give-back: each ad group and campaign it names.
  'lower-ad-bids-for-stock': byStatusArgs,
  'restore-ad-bids-after-stock': byStatusArgs,
  // AA-W2-11 — an ads automation, where it acts: its products (through its campaigns), else its market.
  'turn-up-automation': async (place, args) => placeAutomation(place, await automationScope(String(args.automation ?? ''), str(args.rowId))),
  'tune-ad-engine': async (place, args) => {
    const setting = String(args.setting ?? '')
    const { SETTING_ARG } = await import('../ads-engine-tune.service.js')
    const values = obj(args[(SETTING_ARG as Record<string, string>)[setting] ?? ''])
    await placeAutomation(place, await tuneScope(setting, str(args.subjectId), values))
  },
}

/** AA-W2-11 — an automation's scope, on the door's places. */
async function placeAutomation(place: Place, scope: AutomationScope) {
  if ('outside' in scope) { place.outside = true; return }
  if ('unplaced' in scope) return place.notPlaced(scope.unplaced)
  if (scope.campaignIds.length) return place.campaignIds(scope.campaignIds)
  if (scope.productIds.length) return place.productIds(scope.market, scope.productIds)
  place.market(scope.market, `${scope.label} reaches the whole of ${scope.market}`)
}

// ── The strategy's level where it lands ───────────────────────────────────────────────────────────

const rank = (level: ClaudeTrust) => CLAUDE_LEVELS.indexOf(level)
const isLevel = (value: unknown): value is ClaudeTrust => typeof value === 'string' && (CLAUDE_LEVELS as readonly string[]).includes(value)
const SCOPE_OF: Record<string, StrategyNarrowing['row']['scope']> = { MARKET: 'market', CATEGORY: 'category', PRODUCT: 'product' }

/** Reused across the steps of one plan: the rows that speak to each kind, and each market's strategy, read once. */
export interface StrategyMemo {
  speaking?: Promise<Array<{ market: string; claudeAutonomy: unknown }>>
  views: Map<string, Promise<StrategyView>>
}
export const strategyMemo = (): StrategyMemo => ({ views: new Map() })

function fromField(action: ClaudeActionType, market: string, field: ResolvedField | undefined): StrategyNarrowing | null {
  if (!field?.source || !isLevel(field.value)) return null
  const s = field.source
  return {
    action, level: field.value, market, basis: 'scope',
    row: { scope: s.level, label: s.label, version: s.version, strategyId: s.strategyId, ...(s.via ? { via: s.via } : {}), ...(s.product ? { product: s.product } : {}) },
  }
}

/** The strictest level any usable row of the market sets for this kind (orphans and unreadable values left out). */
function strictestIn(view: StrategyView, action: ClaudeActionType, basis: 'market' | 'business', unplaced: string): StrategyNarrowing | null {
  let best: { row: StrategyRow; level: ClaudeTrust } | null = null
  for (const row of view.index.rows) {
    const level = view.index.settings.get(row.id)?.autonomy.get(action)
    if (level && (!best || rank(level) < rank(best.level))) best = { row, level }
  }
  if (!best) return null
  return {
    action, level: best.level, market: view.market, basis, unplaced,
    row: { scope: SCOPE_OF[best.row.level], label: best.row.label, version: best.row.version, strategyId: best.row.id },
  }
}

/**
 * The strategy's level for this change, or null when it says nothing (not an ad action, a brake, an eBay or
 * marketing request, or no row speaks to its kind where it lands). The caller takes the lower of this and the
 * business's level.
 */
export async function strategyLevelFor(toolName: string, args: unknown, preview?: unknown, memo: StrategyMemo = strategyMemo()): Promise<StrategyNarrowing | null> {
  const actions = actionsOfTool(toolName, args)
  if (!actions.length) return null
  memo.speaking ??= prisma.adsStrategy.findMany({ where: { channel: 'AMAZON' }, select: { market: true, claudeAutonomy: true } })
  const rows = await memo.speaking
  const speaks = (action: ClaudeActionType) => rows.some((row) => Object.prototype.hasOwnProperty.call(obj(row.claudeAutonomy), action))
  if (!actions.some(speaks)) return null

  const place = new Place()
  const reader = PLACES[toolName]
  if (reader) await reader(place, obj(args), preview == null ? null : obj(preview))
  else place.notPlaced('Nexus cannot tell where this change lands')
  if (place.outside) return null

  // PB-5b — an op of several kinds: each kind where it lands, the strictest of them (on a tie the op's own kind).
  let kept: StrategyNarrowing | null = null
  for (const action of actions) {
    const next = await levelWhere(action, place, rows, memo)
    if (next && (!kept || rank(next.level) < rank(kept.level))) kept = next
  }
  return kept
}

/** One kind's level where a change lands (strategyLevelFor): the strictest of every place, or null when no row speaks. */
async function levelWhere(action: ClaudeActionType, place: Place, rows: ReadonlyArray<{ market: string; claudeAutonomy: unknown }>, memo: StrategyMemo): Promise<StrategyNarrowing | null> {
  const speaking = new Map<string, string>()
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(obj(row.claudeAutonomy), action)) speaking.set(row.market.toUpperCase(), row.market)
  }
  if (!speaking.size) return null

  const view = (market: string) => {
    if (!memo.views.has(market)) memo.views.set(market, openStrategy(market))
    return memo.views.get(market)!
  }
  const found: Array<StrategyNarrowing | null> = []
  const markets = new Set([...place.adGroups.keys(), ...place.campaigns.keys(), ...place.products.keys(), ...place.wide.keys()])
  for (const market of markets) {
    const stored = speaking.get(market)
    if (!stored) continue
    const v = await view(stored)
    const adGroups = [...(place.adGroups.get(market) ?? [])]
    const campaigns = [...(place.campaigns.get(market) ?? [])]
    const products = [...(place.products.get(market) ?? [])]
    if (adGroups.length) for (const e of (await v.forAdGroups(adGroups)).values()) found.push(fromField(action, stored, e.resolved.autonomy.get(action)))
    if (campaigns.length) for (const e of (await v.forCampaigns(campaigns)).values()) found.push(fromField(action, stored, e.resolved.autonomy.get(action)))
    if (products.length) found.push(fromField(action, stored, (await v.forProducts(products)).resolved.autonomy.get(action)))
    const wide = place.wide.get(market)
    if (wide) found.push(strictestIn(v, action, 'market', wide))
  }
  const anywhere = [...(place.products.get('*') ?? [])]
  for (const stored of speaking.values()) {
    if (anywhere.length) found.push(fromField(action, stored, (await (await view(stored)).forProducts(anywhere)).resolved.autonomy.get(action)))
    if (place.nowhere) found.push(strictestIn(await view(stored), action, 'business', place.nowhere))
  }
  // The strictest of every place; on a tie the first found (where it lands before a fallback).
  return found.reduce<StrategyNarrowing | null>((kept, next) => (next && (!kept || rank(next.level) < rank(kept.level)) ? next : kept), null)
}

/** Tests only. */
export const __claudeStrategyTest = {
  treatAs(toolName: string, action: ClaudeActionType) { treatedAs.set(toolName, action) },
  reset() { treatedAs.clear() },
}
