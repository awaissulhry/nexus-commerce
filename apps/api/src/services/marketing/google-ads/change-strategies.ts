/**
 * Google Ads changes, G5 (2026-10-15) — portfolio bid strategies: make one, change its name, targets, bid limits and
 * impression-share goal (one atomic request), and remove one for good (its own request, only when the person asked, and
 * only while no campaign uses it).
 *
 * Google's rules, checked 2026-10-15 in the v25 reference (BiddingStrategy, BiddingStrategyOperation, TargetCpa,
 * TargetRoas, TargetSpend, TargetImpressionShare, MaximizeConversions, MaximizeConversionValue,
 * TargetImpressionShareLocation, BiddingStrategyError) and the guide …/docs/campaigns/bidding/strategy-types:
 *   - a portfolio strategy is made with a name (unique in the account, 1–255) and ONE scheme: TARGET_CPA (target CPA,
 *     required), TARGET_ROAS (target ROAS 0.01–1000, required), TARGET_SPEND = Maximize clicks (max CPC ceiling),
 *     TARGET_IMPRESSION_SHARE (location, fraction in micros — 1 % = 10,000 — and a max CPC ceiling, required),
 *     MAXIMIZE_CONVERSIONS (optional target CPA) and MAXIMIZE_CONVERSION_VALUE (optional target ROAS); TARGET_CPA,
 *     TARGET_ROAS, MAXIMIZE_CONVERSIONS and MAXIMIZE_CONVERSION_VALUE take a max and a min CPC (portfolio only; Google
 *     disregards them for Search with the two Maximize schemes);
 *   - its type cannot change (CANNOT_CHANGE_BIDDING_STRATEGY_TYPE): a different scheme is a new strategy;
 *   - one linked to campaigns cannot be removed (CANNOT_REMOVE_ASSOCIATED_STRATEGY).
 * An update names its fields in the update mask (snake_case, `target_cpa.target_cpa_micros`); a field in the mask but
 * not in the body is CLEARED — that is how a target or a limit is taken off.
 *
 * Money: a strategy no enabled campaign uses spends nothing. On one that enabled campaigns use, a higher target CPA, a
 * lower target ROAS, a higher or removed max CPC, a higher min CPC, a higher impression share or a higher place on the
 * page, and a target taken off, can make the account spend more — SPENDS MONEY, each in words.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents } from './live.js'
import {
  SCHEME_FIELD, type ImpressionShareLocation, type LiveStrategy, type LiveStrategyCampaign, type StrategyScheme, type StrategySettings,
} from './live-strategies.js'
import type { GoogleMutateOperation } from './write-client.js'

export type SettingKey = keyof StrategySettings
const SETTING_KEYS: readonly SettingKey[] = ['targetCpaCents', 'targetRoas', 'maxCpcCents', 'minCpcCents', 'location', 'impressionSharePercent']

/** What each scheme takes, and what it cannot be without. */
const TAKES: Record<StrategyScheme, ReadonlySet<SettingKey>> = {
  TARGET_CPA: new Set(['targetCpaCents', 'maxCpcCents', 'minCpcCents']),
  TARGET_ROAS: new Set(['targetRoas', 'maxCpcCents', 'minCpcCents']),
  MAXIMIZE_CLICKS: new Set(['maxCpcCents']),
  TARGET_IMPRESSION_SHARE: new Set(['location', 'impressionSharePercent', 'maxCpcCents']),
  MAXIMIZE_CONVERSIONS: new Set(['targetCpaCents', 'maxCpcCents', 'minCpcCents']),
  MAXIMIZE_CONVERSION_VALUE: new Set(['targetRoas', 'maxCpcCents', 'minCpcCents']),
}
const NEEDS: Record<StrategyScheme, readonly SettingKey[]> = {
  TARGET_CPA: ['targetCpaCents'],
  TARGET_ROAS: ['targetRoas'],
  MAXIMIZE_CLICKS: [],
  TARGET_IMPRESSION_SHARE: ['location', 'impressionSharePercent', 'maxCpcCents'],
  MAXIMIZE_CONVERSIONS: [],
  MAXIMIZE_CONVERSION_VALUE: [],
}

/** Google's JSON field and update-mask leaf of each setting, and its value as Google takes it. */
const FIELD: Record<SettingKey, { json: string; mask: string; value: (v: number | string) => unknown }> = {
  targetCpaCents: { json: 'targetCpaMicros', mask: 'target_cpa_micros', value: (v) => microsOfCents(Number(v)) },
  targetRoas: { json: 'targetRoas', mask: 'target_roas', value: (v) => Number(v) },
  maxCpcCents: { json: 'cpcBidCeilingMicros', mask: 'cpc_bid_ceiling_micros', value: (v) => microsOfCents(Number(v)) },
  minCpcCents: { json: 'cpcBidFloorMicros', mask: 'cpc_bid_floor_micros', value: (v) => microsOfCents(Number(v)) },
  location: { json: 'location', mask: 'location', value: (v) => v },
  impressionSharePercent: { json: 'locationFractionMicros', mask: 'location_fraction_micros', value: (v) => String(Math.round(Number(v) * 10_000)) },
}

const PLACE: Record<ImpressionShareLocation, number> = { ANYWHERE_ON_PAGE: 0, TOP_OF_PAGE: 1, ABSOLUTE_TOP_OF_PAGE: 2 }
const PLACE_WORDS: Record<ImpressionShareLocation, string> = { ANYWHERE_ON_PAGE: 'anywhere on the page', TOP_OF_PAGE: 'top of the page', ABSOLUTE_TOP_OF_PAGE: 'absolute top of the page' }
const SCHEME_WORDS: Record<StrategyScheme, string> = {
  TARGET_CPA: 'Target CPA', TARGET_ROAS: 'Target ROAS', MAXIMIZE_CLICKS: 'Maximize clicks', TARGET_IMPRESSION_SHARE: 'Target impression share',
  MAXIMIZE_CONVERSIONS: 'Maximize conversions', MAXIMIZE_CONVERSION_VALUE: 'Maximize conversion value',
}

/** Settings a request gives: a value sets it, null takes it off. */
export type SettingsAsk = { [K in SettingKey]?: StrategySettings[K] | null }
export interface StrategyCreate extends SettingsAsk { name: string; scheme: StrategyScheme }
export interface StrategyChange extends SettingsAsk { strategyId: string; name?: string }
export interface StrategyRequest { create?: StrategyCreate; change?: StrategyChange[] }

export interface StrategyLiveState { strategies: LiveStrategy[]; campaigns: LiveStrategyCampaign[] }

/** One strategy's changed fields: the values it replaced (before) or wrote (after). */
export type StrategyFields = { strategyId: string; name?: string } & SettingsAsk
export interface StrategyRecord {
  strategies: StrategyFields[]
  /** A strategy it made (`new` until the run names Google's id). */
  created?: { strategyId: string; name: string; scheme: StrategyScheme }
}

export const NEW_STRATEGY = 'new'
const NEW_STRATEGY_TEMP_ID = -1

function show(key: SettingKey, value: unknown, currency: string): string {
  if (value === null || value === undefined) return '(none)'
  switch (key) {
    case 'targetCpaCents': case 'maxCpcCents': case 'minCpcCents': return money(Number(value), currency)
    case 'targetRoas': return `${Math.round(Number(value) * 100)} %`
    case 'impressionSharePercent': return `${value} %`
    case 'location': return PLACE_WORDS[value as ImpressionShareLocation] ?? String(value)
  }
}
const LABEL: Record<SettingKey, string> = {
  targetCpaCents: 'target CPA', targetRoas: 'target ROAS', maxCpcCents: 'max CPC', minCpcCents: 'min CPC', location: 'place on the page', impressionSharePercent: 'impression share',
}

/** Whether moving a setting from → to can make the strategy bid more. */
function bidsMore(key: SettingKey, from: unknown, to: unknown): boolean {
  switch (key) {
    case 'targetCpaCents': return to === null ? from !== null : from !== null && Number(to) > Number(from)
    case 'targetRoas': return to === null ? from !== null : from !== null && Number(to) < Number(from)
    case 'maxCpcCents': return to === null ? from !== null : from !== null && Number(to) > Number(from)
    case 'minCpcCents': return to !== null && (from === null || Number(to) > Number(from))
    case 'impressionSharePercent': return to !== null && (from === null || Number(to) > Number(from))
    case 'location': return to !== null && (from === null || PLACE[to as ImpressionShareLocation] > PLACE[from as ImpressionShareLocation])
  }
}

function settingsProblem(scheme: StrategyScheme, ask: SettingsAsk, what: string, isCreate: boolean): string | null {
  const given = SETTING_KEYS.filter((k) => ask[k] !== undefined)
  const wrong = given.filter((k) => !TAKES[scheme].has(k))
  if (wrong.length) return `${what}: ${SCHEME_WORDS[scheme]} takes ${[...TAKES[scheme]].map((k) => LABEL[k]).join(', ')} (not ${wrong.map((k) => LABEL[k]).join(', ')}).`
  for (const k of NEEDS[scheme]) {
    if (ask[k] === null || (isCreate && ask[k] === undefined)) return `${what}: ${SCHEME_WORDS[scheme]} needs a ${LABEL[k]}.`
  }
  if (ask.targetRoas !== undefined && ask.targetRoas !== null && (ask.targetRoas < 0.01 || ask.targetRoas > 1000)) return `${what}: a target ROAS is 0.01 to 1000 (3 = 300 %).`
  if (ask.impressionSharePercent !== undefined && ask.impressionSharePercent !== null && (ask.impressionSharePercent <= 0 || ask.impressionSharePercent > 100)) return `${what}: an impression share is above 0 and at most 100 %.`
  return null
}

const strategiesList = (strategies: LiveStrategy[]) => (strategies.length
  ? ` Portfolio bid strategies now: ${strategies.slice(0, 20).map((s) => `"${s.name}" (${s.strategyId}, ${s.scheme ? SCHEME_WORDS[s.scheme] : s.type ?? '?'})`).join(', ')}${strategies.length > 20 ? ' …' : ''}.`
  : ' The account has no portfolio bid strategy yet.')

export function strategyChangeDraft(customer: string, currency: string, request: StrategyRequest, live: StrategyLiveState): GoogleChangeDraft | { refusal: string } {
  const changes = request.change ?? []
  if (!request.create && !changes.length) return { refusal: 'Say what to change: create or change.' }
  const byId = new Map(live.strategies.map((s) => [s.strategyId, s]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const skipped: string[] = []
  const before: StrategyRecord = { strategies: [] }
  const after: StrategyRecord = { strategies: [] }
  const res = (id: string | number) => `${customer}/biddingStrategies/${id}`
  const taken = (name: string, except?: string) => live.strategies.some((s) => s.strategyId !== except && s.name.trim().toLowerCase() === name.trim().toLowerCase())

  if (request.create) {
    const c = request.create
    const name = c.name.trim()
    if (taken(name)) return { refusal: `A bid strategy named "${name}" already exists: Google refuses a second one (names are unique). Use its id, or another name.` }
    const problem = settingsProblem(c.scheme, c, `The new strategy "${name}"`, true)
    if (problem) return { refusal: problem }
    if (c.minCpcCents && c.maxCpcCents && c.minCpcCents > c.maxCpcCents) return { refusal: `The new strategy "${name}": the min CPC is above the max CPC.` }
    const scheme: Record<string, unknown> = {}
    for (const k of SETTING_KEYS) if (c[k] !== undefined && c[k] !== null) scheme[FIELD[k].json] = FIELD[k].value(c[k] as number | string)
    operations.push({ biddingStrategyOperation: { create: { resourceName: res(NEW_STRATEGY_TEMP_ID), name, [SCHEME_FIELD[c.scheme].json]: scheme } } })
    const set = SETTING_KEYS.filter((k) => c[k] !== undefined && c[k] !== null).map((k) => `${LABEL[k]} ${show(k, c[k], currency)}`)
    lines.push([`new portfolio strategy "${name}"`, '(none)', `${SCHEME_WORDS[c.scheme]}${set.length ? `: ${set.join(', ')}` : ''}`])
    after.created = { strategyId: NEW_STRATEGY, name, scheme: c.scheme }
  }

  const seen = new Set<string>()
  for (const ch of changes) {
    if (seen.has(ch.strategyId)) return { refusal: `Bid strategy ${ch.strategyId} is named twice.` }
    seen.add(ch.strategyId)
    const s = byId.get(ch.strategyId)
    if (!s) return { refusal: `Bid strategy ${ch.strategyId} is not a portfolio bid strategy of this account (or it is removed).${strategiesList(live.strategies)}` }
    if (!s.scheme) return { refusal: `"${s.name}" is a ${s.type ?? 'kind of'} strategy Nexus does not change (it changes ${Object.values(SCHEME_WORDS).join(', ')}).` }
    const problem = settingsProblem(s.scheme, ch, `"${s.name}"`, false)
    if (problem) return { refusal: problem }
    const name = ch.name?.trim()
    if (name !== undefined && name !== s.name && taken(name, s.strategyId)) return { refusal: `A bid strategy named "${name}" already exists: Google refuses a second one.` }
    const minAfter = ch.minCpcCents !== undefined ? ch.minCpcCents : s.minCpcCents
    const maxAfter = ch.maxCpcCents !== undefined ? ch.maxCpcCents : s.maxCpcCents
    if (minAfter && maxAfter && minAfter > maxAfter) return { refusal: `"${s.name}": the min CPC would be above the max CPC (${money(minAfter, currency)} > ${money(maxAfter, currency)}).` }
    const mask: string[] = []
    const update: Record<string, unknown> = { resourceName: res(s.strategyId) }
    const part: Record<string, unknown> = {}
    const was: StrategyFields = { strategyId: s.strategyId }
    const now: StrategyFields = { strategyId: s.strategyId }
    if (name !== undefined && name !== s.name) {
      mask.push('name'); update.name = name
      lines.push([`strategy "${s.name}" name`, s.name, name])
      was.name = s.name; now.name = name
    }
    const enabled = live.campaigns.filter((c) => c.strategyId === s.strategyId && c.status === 'ENABLED').length
    const note = enabled === 0 ? ' (no enabled campaign uses it: nothing spends until one does)' : ` (${plural(enabled, 'enabled campaign')} use${enabled === 1 ? 's' : ''} it)`
    for (const k of SETTING_KEYS) {
      const to = ch[k]
      if (to === undefined) continue
      const from = s[k]
      if ((to ?? null) === (from ?? null)) continue
      // A field in the mask but not in the body is cleared: that is how null takes a target or a limit off.
      mask.push(`${SCHEME_FIELD[s.scheme].mask}.${FIELD[k].mask}`)
      if (to !== null) part[FIELD[k].json] = FIELD[k].value(to as number | string)
      lines.push([`strategy "${s.name}" ${LABEL[k]}`, show(k, from, currency), show(k, to, currency)])
      ;(was as Record<string, unknown>)[k] = from ?? null
      ;(now as Record<string, unknown>)[k] = to ?? null
      if (bidsMore(k, from ?? null, to ?? null)) {
        spends.push(`${to === null ? 'Takes the' : k === 'targetRoas' ? 'Lowers the' : 'Raises the'} ${LABEL[k]} of "${s.name}"${to === null ? '' : ` from ${show(k, from, currency)} to ${show(k, to, currency)}`}${to === null ? ' off: Google bids with no such limit' : ''}${note}.`)
      }
    }
    if (!mask.length) { skipped.push(`"${s.name}" already reads so.`); continue }
    if (Object.keys(part).length) update[SCHEME_FIELD[s.scheme].json] = part
    operations.push({ biddingStrategyOperation: { update, updateMask: mask.join(',') } })
    before.strategies.push(was)
    after.strategies.push(now)
  }

  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes: table, more } = changeLines(lines)
  const parts = [request.create && `make the portfolio bid strategy "${request.create.name.trim()}" (${SCHEME_WORDS[request.create.scheme]})`, after.strategies.length && `change ${plural(after.strategies.length, 'portfolio bid strategy', 'portfolio bid strategies')}`].filter(Boolean)
  return {
    summary: `Google Ads bid strategies: ${parts.join('; ')}.`,
    changes: table,
    totals: { operations: operations.length, made: request.create ? 1 : 0, changed: after.strategies.length, ...(more ? { linesNotShown: more } : {}) },
    warnings: request.create ? ['A new portfolio strategy is used by no campaign: it spends nothing until a campaign is put on it (set-google-campaign, bidding PORTFOLIO).'] : [],
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      strategies: live.strategies.filter((s) => seen.has(s.strategyId)).map((s) => ({ ...s, campaigns: live.campaigns.filter((c) => c.strategyId === s.strategyId).map((c) => `${c.campaignId}:${c.status}`) })),
      takenNames: request.create ? live.strategies.map((s) => s.name.trim().toLowerCase()).sort() : [],
    },
    before,
    after,
  }
}

/** The record of a run, with the id Google gave a strategy it made (the first operation's result). */
export function strategyRecordAfterRun(after: StrategyRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): StrategyRecord {
  if (!after.created) return structuredClone(after)
  const name = responses[0]?.biddingStrategyResult?.resourceName
  return { ...structuredClone(after), created: { ...after.created, strategyId: name ? name.slice(name.lastIndexOf('/') + 1) : NEW_STRATEGY } }
}

// ── remove ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function strategyRemoveDraft(customer: string, currency: string, strategyIds: string[], live: StrategyLiveState): GoogleChangeDraft | { refusal: string } {
  if (!strategyIds.length) return { refusal: 'Name at least one bid strategy to remove.' }
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const removed: Array<LiveStrategy> = []
  for (const id of [...new Set(strategyIds)]) {
    const s = live.strategies.find((x) => x.strategyId === id)
    if (!s) return { refusal: `Bid strategy ${id} is not a portfolio bid strategy of this account (or it is already removed).${strategiesList(live.strategies)}` }
    const users = live.campaigns.filter((c) => c.strategyId === id)
    if (users.length || s.campaignCount > 0) {
      return { refusal: `"${s.name}" is used by ${plural(Math.max(users.length, s.campaignCount), 'campaign')}${users.length ? ` (${users.map((c) => `"${c.name}"`).join(', ')})` : ''}: Google refuses to remove a strategy in use. Move them to another bidding first (set-google-campaign).` }
    }
    operations.push({ biddingStrategyOperation: { remove: `${customer}/biddingStrategies/${id}` } })
    const set = SETTING_KEYS.filter((k) => s[k] !== null).map((k) => `${LABEL[k]} ${show(k, s[k], currency)}`)
    lines.push([`portfolio strategy "${s.name}"`, `${s.scheme ? SCHEME_WORDS[s.scheme] : s.type}${set.length ? `: ${set.join(', ')}` : ''}`, 'REMOVED'])
    removed.push(s)
  }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: REMOVE ${plural(removed.length, 'portfolio bid strategy', 'portfolio bid strategies')} for good (${removed.slice(0, 3).map((s) => `"${s.name}"`).join(', ')}${removed.length > 3 ? ' …' : ''}).`,
    changes,
    totals: { operations: operations.length, removed: removed.length, ...(more ? { linesNotShown: more } : {}) },
    warnings: ['A removal cannot be undone: Google cannot bring a removed strategy back (a new one with the same settings is another strategy). No campaign uses these, so nothing that serves changes.'],
    spendsMoney: [],
    skipped: [],
    operations,
    stands: { strategies: removed.map((s) => ({ strategyId: s.strategyId, name: s.name, campaigns: s.campaignCount })) },
    before: { removed: removed.map(({ strategyId, name, type, scheme, ...settings }) => ({ strategyId, name, type, scheme, ...settings })) },
    after: { removed: removed.map((s) => ({ strategyId: s.strategyId })) },
  }
}
