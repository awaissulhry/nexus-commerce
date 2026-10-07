/**
 * R13 (MCP full control, part 06 §3) — a guardrail change for Claude's set-ad-guardrail: a spend ceiling, a bid policy
 * or a protected term, set or removed, through the guardrail service (R4) and its audit rows.
 *
 * Every change is judged TIGHTEN or LOOSEN (part 06 §3, "brakes are not down"):
 *   tighten  a new ceiling or a lower cap; a new bid ceiling or a lower one, a lower floor; a new protected term
 *   loosen   a higher cap, a cap cleared, anything switched off or removed; a higher bid ceiling, a higher (or new)
 *            bid floor, which forces bids up
 * A tightening is inside set-ad-guardrail's limits; a loosening needs a person unless the business's limits allow it
 * (allowLoosen, off by default). The write gate reads the rows
 * at its next decision (ads-write-gate.ts): nothing else needs to move.
 *
 * ADS AUTONOMY W3-2 — a campaign's OWN guardrails, through the code its screens use (campaign-guardrail.service.ts,
 * campaign-settings.service.ts setCpcCeiling), judged the same way:
 *   campaign-bid-bounds     judged on the bounds IN FORCE before and after (effectiveBidBounds) as well as the campaign's
 *                           own values: loosen when either the highest bid rises or is lifted, or the lowest bid rises or
 *                           appears (it forces bids up). A campaign's own column takes the place of the bid policies
 *                           (line, portfolio, market) on its side, so a new campaign ceiling above a market policy's is a
 *                           loosening, and so is clearing a campaign floor below a policy's.
 *   campaign-budget-bounds  tighten: a new or lower highest budget, a lower or cleared lowest budget, a baseline that
 *                           anchors lower; loosen: a higher or cleared highest budget, a new or higher lowest budget
 *                           (cut rules may not go below it), a baseline that anchors higher (relative budget rules and a
 *                           restore to baseline start from it; without one they start from today's budget)
 *   bid-change-cap          tighten: a new or lower largest bid change; loosen: a higher or cleared one
 *   cpc-ceiling             tighten: switched on, a lower multiple; loosen: switched off, a higher multiple
 *   pin                     setting AND lifting a pin are loosenings (lead decision, W3-2 review): a pin stops every
 *                           automatic write of its part, cuts included (ads-authority-pins.ts; only a stop with low bids
 *                           passes a bids pin), so it can hold spend up; lifting lets engines write it again
 * The ads strategy (W1) stays the outer band: the write gate adds its band to the campaign's bounds (or, on a side the
 * campaign leaves empty, the bid policy's) and the stricter one binds — the lower highest bid, the higher lowest bid
 * (effectiveBidBounds); the step clamp takes the lower largest change (ads-strategy/bids.ts stepClamp). So a campaign
 * guardrail can only narrow the strategy, never widen it — while it CAN widen a bid policy, which it replaces on its side.
 * The preview says which number binds after the change and whose it is (`inForce`). The strategy has no budget bounds,
 * CPC ceiling or pins of its own: those bind beside its monthly cap and bid band.
 */
import type { AdBidPolicy, AdSpendCeiling } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { isRefused } from '../automation/service-outcome.js'

/** W3-2 — the guardrails a campaign holds itself (its columns and settings), keyed by its Nexus id. */
export const CAMPAIGN_GUARDRAIL_KINDS = ['campaign-bid-bounds', 'campaign-budget-bounds', 'bid-change-cap', 'cpc-ceiling', 'pin'] as const
export type CampaignGuardrailKind = (typeof CAMPAIGN_GUARDRAIL_KINDS)[number]
export type GuardrailKind = 'spend-ceiling' | 'bid-policy' | 'protected-term' | CampaignGuardrailKind
export type GuardrailOp = 'set' | 'remove'

export const isCampaignKind = (kind: string): kind is CampaignGuardrailKind => (CAMPAIGN_GUARDRAIL_KINDS as readonly string[]).includes(kind)

export interface GuardrailInput {
  kind: GuardrailKind
  op: GuardrailOp
  grain?: string
  scopeId?: string
  label?: string
  dailyCapCents?: number | null
  minBidCents?: number | null
  maxBidCents?: number | null
  enabled?: boolean
  note?: string | null
  term?: string
  matchType?: string
  marketplace?: string | null
  campaignId?: string | null
  // W3-2 — a campaign's own guardrails (campaign-bid-bounds also takes minBidCents / maxBidCents, cpc-ceiling `enabled`,
  // pin `note`).
  minBudgetCents?: number | null
  maxBudgetCents?: number | null
  budgetBaselineCents?: number | null
  maxBidChangePct?: number | null
  cpcMultiple?: number
  pinBids?: boolean
  pinBudget?: boolean
  pinPlacement?: boolean
}

/** A guardrail as set-ad-guardrail records it (before / after) and its undo restores it. */
export interface GuardrailState {
  kind: GuardrailKind
  key: { grain?: string; scopeId?: string; term?: string; marketplace?: string | null; campaignId?: string | null }
  row: Record<string, unknown> | null
}

export interface GuardrailPlan {
  action: 'set-ad-guardrail'
  kind: GuardrailKind
  op: GuardrailOp
  direction: 'tighten' | 'loosen'
  why: string
  label: string
  changes: Record<string, { from: unknown; to: unknown }>
  basis: string | null
  effect: string
  /** W3-2 (a campaign's own guardrail) — each way it loosens, in words; empty when it only tightens. */
  raises?: string[]
  /** W3-2 — the campaign and its market (the limits `campaignIds` and `markets` read them; nothing reaches Amazon). */
  campaignId?: string
  market?: string | null
  /** W3-2 — bid bounds and the largest change: the number that binds after the change, and whose it is. */
  inForce?: Record<string, { value: number | null; from: string | null }>
}

const pick = (row: Record<string, unknown> | null, keys: string[]) => (row ? Object.fromEntries(keys.map((k) => [k, row[k] ?? null])) : null)
const CEILING_KEYS = ['label', 'dailyCapCents', 'enabled', 'note']
const POLICY_KEYS = ['label', 'minBidCents', 'maxBidCents', 'enabled', 'note']

/** The name of a scope, checked to exist in this business. */
async function scopeLabel(grain: string, scopeId: string): Promise<string | null> {
  if (grain === 'CAMPAIGN') return (await prisma.campaign.findUnique({ where: { id: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'MARKET') return (await prisma.campaign.findFirst({ where: { marketplace: scopeId }, select: { id: true } })) ? `market ${scopeId}` : null
  if (grain === 'PORTFOLIO') return (await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'LINE') return (await prisma.product.findUnique({ where: { id: scopeId }, select: { sku: true } }))?.sku ?? null
  return null
}

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null, keys: string[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of keys) {
    const from = before ? before[k] ?? null : null
    const to = after ? after[k] ?? null : null
    if (JSON.stringify(from) !== JSON.stringify(to)) out[k] = { from, to }
  }
  return out
}

const TERM_KEYS = ['term', 'matchType', 'marketplace', 'campaignId']

/** W3-2 — what each campaign kind holds, named as set-ad-guardrail takes it (so an undo sets it back as it was). */
export const CAMPAIGN_KEYS: Readonly<Record<CampaignGuardrailKind, readonly string[]>> = {
  'campaign-bid-bounds': ['minBidCents', 'maxBidCents'],
  'campaign-budget-bounds': ['minBudgetCents', 'maxBudgetCents', 'budgetBaselineCents'],
  'bid-change-cap': ['maxBidChangePct'],
  'cpc-ceiling': ['enabled', 'cpcMultiple'],
  pin: ['pinBids', 'pinBudget', 'pinPlacement', 'note'],
}

const CAMPAIGN_SELECT = {
  id: true, name: true, marketplace: true, portfolioId: true, dailyBudget: true, dailyBudgetCurrency: true,
  minBidCents: true, maxBidCents: true, minBudgetCents: true, maxBudgetCents: true, budgetBaselineCents: true,
  dynamicBidding: true, pinBids: true, pinBudget: true, pinPlacement: true, pinNote: true,
} as const

type GuardedCampaign = NonNullable<Awaited<ReturnType<typeof readCampaign>>>

function readCampaign(campaignId: string) {
  return prisma.campaign.findUnique({ where: { id: campaignId }, select: CAMPAIGN_SELECT })
}

/** A campaign kind's values as the gate and the clamps read them (a largest change of 0 or none is none; the CPC ceiling 1.5 × when no multiple is stored). */
function campaignState(kind: CampaignGuardrailKind, c: GuardedCampaign): Record<string, unknown> {
  const settings = (c.dynamicBidding ?? {}) as { maxBidChangePct?: unknown; cpcCeiling?: { enabled?: unknown; multiple?: unknown } }
  const pct = Number(settings.maxBidChangePct)
  const all: Record<string, unknown> = {
    minBidCents: c.minBidCents, maxBidCents: c.maxBidCents,
    minBudgetCents: c.minBudgetCents, maxBudgetCents: c.maxBudgetCents, budgetBaselineCents: c.budgetBaselineCents,
    maxBidChangePct: Number.isFinite(pct) && pct > 0 ? pct : null,
    enabled: settings.cpcCeiling?.enabled === true,
    cpcMultiple: Number(settings.cpcCeiling?.multiple ?? 1.5),
    pinBids: c.pinBids, pinBudget: c.pinBudget, pinPlacement: c.pinPlacement, note: c.pinNote,
  }
  return pick(all, [...CAMPAIGN_KEYS[kind]])!
}

/** A guardrail row as a change records it (and its undo compares): its settings only. */
export function guardrailState(kind: GuardrailKind, row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (isCampaignKind(kind)) return pick(row, [...CAMPAIGN_KEYS[kind]])
  return pick(row, kind === 'protected-term' ? TERM_KEYS : kind === 'spend-ceiling' ? CEILING_KEYS : POLICY_KEYS)
}

/** Read the guardrail a key names, now (the whole row; a campaign kind: its values). */
export async function readGuardrail(kind: GuardrailKind, key: GuardrailState['key']): Promise<Record<string, unknown> | null> {
  if (isCampaignKind(kind)) {
    const campaign = key.campaignId ? await readCampaign(key.campaignId) : null
    return campaign ? campaignState(kind, campaign) : null
  }
  if (kind === 'protected-term') {
    const { normaliseTerm } = await import('./ads-write-gate.js')
    const row = await prisma.adKeywordProtection.findFirst({ where: { mode: 'WHITELIST', term: normaliseTerm(key.term ?? ''), marketplace: key.marketplace ?? null, campaignId: key.campaignId ?? null } })
    return row ? (row as unknown as Record<string, unknown>) : null
  }
  const where = { grain_scopeId: workspaceKey({ grain: key.grain ?? '', scopeId: key.scopeId ?? '' }) }
  const row: AdSpendCeiling | AdBidPolicy | null = kind === 'spend-ceiling' ? await prisma.adSpendCeiling.findUnique({ where }) : await prisma.adBidPolicy.findUnique({ where })
  return row ? (row as unknown as Record<string, unknown>) : null
}

// ── W3-2 — a campaign's own guardrails ─────────────────────────────────────────────────────────────

type Planned = { ok: true; plan: GuardrailPlan; before: GuardrailState; after: GuardrailState }
type Refusal = { ok: false; error: string }

const bidWords = (cents: unknown) => `${cents}¢`
const moneyWords = (cents: unknown, currency: string) => `${currency} ${(Number(cents) / 100).toFixed(2)}`
const PIN_PARTS = [['pinBids', 'bids'], ['pinBudget', 'budget'], ['pinPlacement', 'placement adjustments']] as const

/** The pin note as the pins service stores it: trimmed, at most 280 characters, none when empty. */
const pinNoteOf = (note: string | null | undefined) => (note?.trim() ? note.trim().slice(0, 280) : null)

/** A campaign kind's values after the change (an argument not given keeps what is there; `remove` clears the kind), or why not. */
async function nextCampaignState(input: GuardrailInput, kind: CampaignGuardrailKind, prev: Record<string, unknown>, campaign: GuardedCampaign): Promise<Record<string, unknown> | Refusal> {
  const remove = input.op === 'remove'
  switch (kind) {
    case 'campaign-bid-bounds': {
      if (remove) return { minBidCents: null, maxBidCents: null }
      if (input.minBidCents === undefined && input.maxBidCents === undefined) return { ok: false, error: 'minBidCents or maxBidCents: the lowest or highest bid in cents, or null to clear it' }
      const { validateGuardrails } = await import('./ads-guardrails.js')
      const v = validateGuardrails({ minBidCents: input.minBidCents, maxBidCents: input.maxBidCents }, [{ name: campaign.name, minBidCents: campaign.minBidCents, maxBidCents: campaign.maxBidCents }])
      if (!v.ok) return { ok: false, error: v.error ?? 'not valid bid bounds' }
      return { ...prev, ...v.data }
    }
    case 'campaign-budget-bounds': {
      if (remove) return { minBudgetCents: null, maxBudgetCents: null, budgetBaselineCents: null }
      if (input.minBudgetCents === undefined && input.maxBudgetCents === undefined && input.budgetBaselineCents === undefined) {
        return { ok: false, error: 'minBudgetCents, maxBudgetCents or budgetBaselineCents: a daily budget in cents (at least 100), or null to clear it' }
      }
      const { campaignBudgetBounds } = await import('./campaign-guardrail.service.js')
      const checked = campaignBudgetBounds(input, campaign)
      return 'error' in checked ? { ok: false, error: checked.error } : checked.data
    }
    case 'bid-change-cap':
      if (remove) return { maxBidChangePct: null }
      if (input.maxBidChangePct === undefined) return { ok: false, error: 'maxBidChangePct: the most one change may move a keyword or target bid, in % (above 0, at most 500), or null to clear it' }
      return { maxBidChangePct: input.maxBidChangePct }
    case 'cpc-ceiling': {
      if (remove) return { enabled: false, cpcMultiple: prev.cpcMultiple }
      const { clampCpcMultiple } = await import('./campaign-settings.service.js')
      return { enabled: input.enabled ?? true, cpcMultiple: input.cpcMultiple !== undefined ? clampCpcMultiple(input.cpcMultiple) : prev.cpcMultiple }
    }
    case 'pin': {
      if (remove) return { pinBids: false, pinBudget: false, pinPlacement: false, note: null }
      if (PIN_PARTS.every(([key]) => input[key] === undefined) && input.note === undefined) {
        return { ok: false, error: 'pinBids, pinBudget or pinPlacement: true pins that part, false lifts the pin (note: why, kept on the campaign)' }
      }
      const next: Record<string, unknown> = { ...prev }
      for (const [key] of PIN_PARTS) if (input[key] !== undefined) next[key] = !!input[key]
      if (input.note !== undefined) next.note = pinNoteOf(input.note)
      // As the pins service does: a campaign with nothing pinned keeps no note.
      if (!PIN_PARTS.some(([key]) => next[key])) next.note = null
      return next
    }
  }
}

/** The bid bounds in force on a campaign (its own, else the bid policies; with the strategy's band), before and after. */
interface BoundsInForce {
  before: { max: { value: number; source: string } | null; min: { value: number; source: string } | null }
  after: { max: { value: number; source: string } | null; min: { value: number; source: string } | null }
}

/** Each way the change loosens, in words (empty: it only tightens). */
function campaignRaises(kind: CampaignGuardrailKind, prev: Record<string, unknown>, next: Record<string, unknown>, campaign: GuardedCampaign, currency: string, bounds?: BoundsInForce): string[] {
  const raises: string[] = []
  const n = (row: Record<string, unknown>, key: string) => (row[key] == null ? null : Number(row[key]))
  if (kind === 'campaign-bid-bounds') {
    // In force first (a campaign value replaces a bid policy's on its side), then the campaign's own value, which binds
    // the day the stricter number above it goes.
    const was = bounds?.before ?? { max: null, min: null }, now = bounds?.after ?? { max: null, min: null }
    const at = (b: { value: number; source: string }) => `${bidWords(b.value)} (${b.source})`
    // The campaign's own value binds the day the stricter number in force goes: said when another number binds now.
    const forNow = (own: number | null, side: { value: number; source: string } | null) => (side && side.value !== own ? `; ${at(side)} binds for now` : '')
    const wasMax = n(prev, 'maxBidCents'), nowMax = n(next, 'maxBidCents'), wasMin = n(prev, 'minBidCents'), nowMin = n(next, 'minBidCents')
    if (was.max && !now.max) raises.push(`the highest bid in force, ${at(was.max)}, is lifted: no highest bid binds after the change`)
    else if (was.max && now.max && now.max.value > was.max.value) raises.push(`the highest bid in force rises from ${at(was.max)} to ${at(now.max)}`)
    else if (wasMax != null && nowMax == null) raises.push(`the campaign's own highest bid (${bidWords(wasMax)}) is cleared${forNow(null, now.max)}`)
    else if (wasMax != null && nowMax != null && nowMax > wasMax) raises.push(`the campaign's own highest bid rises from ${bidWords(wasMax)} to ${bidWords(nowMax)}${forNow(nowMax, now.max)}`)
    if (now.min && (!was.min || now.min.value > was.min.value)) raises.push(`the lowest bid in force ${was.min ? `rises from ${at(was.min)} to` : 'becomes'} ${at(now.min)} and forces bids up`)
    else if (nowMin != null && (wasMin == null || nowMin > wasMin)) raises.push(`the campaign's own lowest bid ${wasMin == null ? 'becomes' : `rises from ${bidWords(wasMin)} to`} ${bidWords(nowMin)}${forNow(nowMin, now.min)}`)
  } else if (kind === 'campaign-budget-bounds') {
    const wasMax = n(prev, 'maxBudgetCents'), nowMax = n(next, 'maxBudgetCents'), wasMin = n(prev, 'minBudgetCents'), nowMin = n(next, 'minBudgetCents')
    if (wasMax != null && nowMax == null) raises.push(`the highest daily budget (${moneyWords(wasMax, currency)}) is cleared`)
    else if (wasMax != null && nowMax != null && nowMax > wasMax) raises.push(`the highest daily budget rises from ${moneyWords(wasMax, currency)} to ${moneyWords(nowMax, currency)}`)
    if (nowMin != null && (wasMin == null || nowMin > wasMin)) raises.push(`a lowest daily budget of ${moneyWords(nowMin, currency)} stops budget cuts below it`)
    // A relative budget rule (and a restore to baseline) starts from the baseline, else from today's budget.
    const today = Math.round(Number(campaign.dailyBudget ?? 0) * 100)
    const anchorBefore = n(prev, 'budgetBaselineCents') ?? today, anchorAfter = n(next, 'budgetBaselineCents') ?? today
    if (anchorAfter > anchorBefore) raises.push(`relative budget rules and a restore to baseline start from ${moneyWords(anchorAfter, currency)} instead of ${moneyWords(anchorBefore, currency)}`)
  } else if (kind === 'bid-change-cap') {
    const was = n(prev, 'maxBidChangePct'), now = n(next, 'maxBidChangePct')
    if (was != null && now == null) raises.push(`the largest bid change (${was} %) is cleared`)
    else if (was != null && now != null && now > was) raises.push(`the largest bid change rises from ${was} % to ${now} %`)
  } else if (kind === 'cpc-ceiling') {
    const reach = (row: Record<string, unknown>) => (row.enabled ? Number(row.cpcMultiple) : Infinity)
    if (reach(next) > reach(prev)) raises.push(next.enabled ? `the CPC ceiling rises from ${prev.cpcMultiple}× to ${next.cpcMultiple}× the average cost per click` : `the CPC ceiling (${prev.cpcMultiple}×) is switched off`)
  } else {
    for (const [key, part] of PIN_PARTS) {
      if (prev[key] && !next[key]) raises.push(`the ${part} pin is lifted: engines, rules and schedules may write the campaign's ${part} again`)
      if (!prev[key] && next[key]) raises.push(`a ${part} pin stops every automatic write of the campaign's ${part}, cuts included${key === 'pinBids' ? ' (only a stop with low bids passes it)' : ''}`)
    }
  }
  return raises
}

const TIGHTEN_WHY: Record<CampaignGuardrailKind, string> = {
  'campaign-bid-bounds': 'it holds the campaign\'s bids tighter',
  'campaign-budget-bounds': 'it holds the campaign\'s budget tighter',
  'bid-change-cap': 'a keyword or target bid moves by less in one change',
  'cpc-ceiling': 'bids asked for are held closer to a target\'s average cost per click',
  pin: 'only the pin note changes',
}

/** The bid bounds the write gate holds the campaign to with its values now and with the change (one strategy read). */
async function boundsInForce(campaign: GuardedCampaign, prev: Record<string, unknown>, next: Record<string, unknown>): Promise<BoundsInForce> {
  const { effectiveBidBounds } = await import('./ads-write-gate.js')
  const withValues = (row: Record<string, unknown>) => ({ ...campaign, minBidCents: row.minBidCents as number | null, maxBidCents: row.maxBidCents as number | null })
  const before = await effectiveBidBounds({ campaignId: campaign.id, campaign: withValues(prev) })
  const after = await effectiveBidBounds({ campaignId: campaign.id, campaign: withValues(next), strategy: before.strategy })
  return { before: { max: before.max, min: before.min }, after: { max: after.max, min: after.min } }
}

/** What binds after the change, and whose number it is: the strategy narrows a campaign guardrail, never the other way round. */
async function inForceAfter(kind: CampaignGuardrailKind, next: Record<string, unknown>, campaign: GuardedCampaign, bounds?: BoundsInForce): Promise<GuardrailPlan['inForce']> {
  if (kind === 'campaign-bid-bounds' && bounds) {
    const { max, min } = bounds.after
    return { minBidCents: { value: min?.value ?? null, from: min?.source ?? null }, maxBidCents: { value: max?.value ?? null, from: max?.source ?? null } }
  }
  if (kind === 'bid-change-cap') {
    const { bidLimitsFor, strategyWords } = await import('./ads-strategy/bids.js')
    const strategy = (await bidLimitsFor({ marketplace: campaign.marketplace, campaignId: campaign.id })).maxChangePct
    const own = next.maxBidChangePct as number | null
    if (strategy && (own == null || strategy.value < own)) return { maxBidChangePct: { value: strategy.value, from: strategyWords(strategy.source) } }
    return { maxBidChangePct: { value: own, from: own == null ? null : 'the campaign\'s own largest bid change' } }
  }
  return undefined
}

function campaignEffect(kind: CampaignGuardrailKind, label: string, next: Record<string, unknown>, inForce: GuardrailPlan['inForce'], currency: string): string {
  const v = (key: string, words: (x: unknown) => string) => (next[key] == null ? 'none' : words(next[key]))
  const held = (side: { value: number | null; from: string | null } | undefined) => (side?.value == null ? 'none' : `${bidWords(side.value)} (${side.from})`)
  const tail = ' Recorded in Nexus only: nothing is sent to Amazon.'
  switch (kind) {
    case 'campaign-bid-bounds':
      return `Bid bounds of ${label}: lowest ${v('minBidCents', bidWords)}, highest ${v('maxBidCents', bidWords)}. The write gate refuses a bid outside them at its next decision `
        + '(an engine, a rule, a schedule or a change run by rule; a person\'s own edit past them, or a Claude request he approves after the warning, is sent when he confirms). '
        + 'On the side it sets, the campaign\'s own bound takes the place of a bid policy (line, portfolio or market); the ads strategy\'s band binds beside it, the stricter number winning. '
        + `After this change bids are held to lowest ${held(inForce?.minBidCents)}, highest ${held(inForce?.maxBidCents)}.${tail}`
    case 'campaign-budget-bounds':
      return `Budget bounds of ${label}: lowest ${v('minBudgetCents', (x) => moneyWords(x, currency))}, highest ${v('maxBudgetCents', (x) => moneyWords(x, currency))}, baseline ${v('budgetBaselineCents', (x) => moneyWords(x, currency))}. `
        + 'The write gate refuses a daily budget outside the bounds; relative budget rules and a restore to baseline start from the baseline. The ads strategy\'s monthly cap and the spend ceilings bind beside them.' + tail
    case 'bid-change-cap': {
      const side = inForce?.maxBidChangePct
      return `Largest bid change of ${label}: ${v('maxBidChangePct', (x) => `${x} %`)}. A keyword or target bid an engine, a rule or a Claude bid request run by rule moves is stepped to it (never a person's own edit; a Claude bid request a person approves is warned on the card and sent as asked); an ad group's default bid is not stepped. `
        + `The ads strategy's largest change binds beside it, the lower one winning: after this change ${side?.value == null ? 'no largest change applies' : `${side.value} % (${side.from})`}.${tail}`
    }
    case 'cpc-ceiling':
      return next.enabled
        ? `CPC ceiling of ${label}: on, ${next.cpcMultiple}× a target's average cost per click. Bids asked for by Claude's bid tools are held to it, and on the bid screens a bid above it waits for the person's confirmation (a target with no clicks has no ceiling); the engines' own bid writes do not read it.${tail}`
        : `CPC ceiling of ${label}: off.${tail}`
    case 'pin': {
      const pinned = PIN_PARTS.filter(([key]) => next[key]).map(([, part]) => part)
      return `Pins of ${label}: ${pinned.length ? pinned.join(', ') : 'none'}. The write gate refuses every automatic write of a pinned part, cuts included (engines, rules, schedules, a change run by rule; only a stop with low bids passes a bids pin); a person's own edit, or a request a person approved, still goes.${tail}`
    }
  }
}

async function planCampaignGuardrail(input: GuardrailInput, kind: CampaignGuardrailKind): Promise<Planned | Refusal> {
  if (!input.campaignId) return { ok: false, error: 'campaignId: the Nexus id of the campaign (ad-campaigns lists it)' }
  const campaign = await readCampaign(input.campaignId)
  if (!campaign) return { ok: false, error: `campaignId ${input.campaignId}: not found in this business.` }
  const label = `campaign "${campaign.name}"`
  const prev = campaignState(kind, campaign)
  const next = await nextCampaignState(input, kind, prev, campaign)
  if ('error' in next) return next as Refusal
  const keys = [...CAMPAIGN_KEYS[kind]]
  const changes = diff(prev, next, keys)
  if (!Object.keys(changes).length) {
    return { ok: false, error: input.op === 'remove' ? `There is no ${kind} on ${label} (not found).` : `The ${kind} of ${label} already holds these values.` }
  }
  const currency = campaign.dailyBudgetCurrency?.trim() || 'EUR'
  const bounds = kind === 'campaign-bid-bounds' ? await boundsInForce(campaign, prev, next) : undefined
  const raises = campaignRaises(kind, prev, next, campaign, currency, bounds)
  const inForce = await inForceAfter(kind, next, campaign, bounds)
  const { strategyMarket } = await import('./ads-strategy/bids.js')
  const key = { campaignId: campaign.id }
  return {
    ok: true,
    before: { kind, key, row: prev },
    after: { kind, key, row: next },
    plan: {
      action: 'set-ad-guardrail', kind, op: input.op, direction: raises.length ? 'loosen' : 'tighten',
      why: raises.length ? raises.join('; ') : TIGHTEN_WHY[kind], label, changes,
      // The values it starts from: any of them moving makes the approved change a different one.
      basis: JSON.stringify(prev),
      effect: campaignEffect(kind, label, next, inForce, currency),
      raises, campaignId: campaign.id, market: strategyMarket(campaign.marketplace) ?? campaign.marketplace ?? null,
      ...(inForce ? { inForce } : {}),
    },
  }
}

async function applyCampaignGuardrail(planned: Planned, actor: string): Promise<{ ok: boolean; status?: number; body?: Record<string, unknown> }> {
  const kind = planned.plan.kind as CampaignGuardrailKind
  const id = planned.after.key.campaignId as string
  const next = planned.after.row as Record<string, unknown>
  const changed = Object.keys(planned.plan.changes)
  const svc = await import('./campaign-guardrail.service.js')
  if (kind === 'cpc-ceiling') {
    const { setCpcCeiling } = await import('./campaign-settings.service.js')
    const r = await setCpcCeiling(id, { enabled: next.enabled as boolean, multiple: next.cpcMultiple as number })
    return r.error ? { ok: false, status: r.status ?? 400, body: { error: r.error } } : { ok: true }
  }
  if (kind === 'pin') {
    return svc.setCampaignPins(id, Object.fromEntries(changed.map((k) => [k === 'note' ? 'pinNote' : k, next[k]])), actor)
  }
  return svc.setCampaignGuardrails(id, Object.fromEntries(changed.map((k) => [k, next[k]])), actor)
}

export async function planGuardrail(input: GuardrailInput): Promise<{ ok: true; plan: GuardrailPlan; before: GuardrailState; after: GuardrailState } | { ok: false; error: string }> {
  if (isCampaignKind(input.kind)) return planCampaignGuardrail(input, input.kind)
  if (input.kind === 'protected-term') {
    if (!input.term?.trim()) return { ok: false, error: 'term: the term to protect from negation' }
    if (input.campaignId && !(await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { id: true } }))) return { ok: false, error: `campaignId ${input.campaignId}: not found in this business.` }
    const key = { term: input.term, marketplace: input.marketplace ?? null, campaignId: input.campaignId ?? null }
    const existing = await readGuardrail('protected-term', key)
    if (input.op === 'remove' && !existing) return { ok: false, error: `“${input.term}” is not a protected term here (not found).` }
    if (input.op === 'set' && existing) return { ok: false, error: `“${existing.term}” is already protected.` }
    const { normaliseTerm } = await import('./ads-write-gate.js')
    const after = input.op === 'set' ? { term: normaliseTerm(input.term), matchType: input.matchType ? input.matchType.trim().toUpperCase() : null, marketplace: key.marketplace, campaignId: key.campaignId } : null
    const tighten = input.op === 'set'
    return {
      ok: true,
      before: { kind: 'protected-term', key, row: guardrailState('protected-term', existing) },
      after: { kind: 'protected-term', key, row: after },
      plan: {
        action: 'set-ad-guardrail', kind: 'protected-term', op: input.op, direction: tighten ? 'tighten' : 'loosen',
        why: tighten ? 'a new protected term: no rule may negate it' : 'removing a protected term lets rules negate it again',
        label: `“${input.term}”`, changes: { protected: { from: !!existing, to: tighten } }, basis: null,
        effect: tighten ? `Protects “${input.term}” from negation${key.marketplace ? ` in ${key.marketplace}` : ''}.` : `Removes the protection of “${input.term}”.`,
      },
    }
  }

  const ceiling = input.kind === 'spend-ceiling'
  const grains = ceiling ? ['CAMPAIGN', 'LINE', 'PORTFOLIO', 'MARKET'] : ['LINE', 'PORTFOLIO', 'MARKET']
  // A spend ceiling binds a campaign unless another grain is named.
  if (ceiling && !input.grain) input = { ...input, grain: 'CAMPAIGN' }
  if (!input.grain || !grains.includes(input.grain)) return { ok: false, error: `grain: one of ${grains.join(', ')}${ceiling ? '' : ' (a campaign\'s own bid bounds are its Campaign columns)'}` }
  if (!input.scopeId) return { ok: false, error: 'scopeId: the campaign id, product line id, portfolio id or market it binds' }
  const scopeName = await scopeLabel(input.grain, input.scopeId)
  if (!scopeName) return { ok: false, error: `${input.grain} ${input.scopeId}: not found in this business.` }
  const key = { grain: input.grain, scopeId: input.scopeId }
  const existing = await readGuardrail(input.kind, key)
  const keys = ceiling ? CEILING_KEYS : POLICY_KEYS
  if (input.op === 'remove') {
    if (!existing) return { ok: false, error: `There is no ${input.kind} on ${input.grain} ${scopeName} (not found).` }
    return {
      ok: true,
      before: { kind: input.kind, key, row: guardrailState(input.kind, existing) }, after: { kind: input.kind, key, row: null },
      plan: { action: 'set-ad-guardrail', kind: input.kind, op: 'remove', direction: 'loosen', why: 'removing a guardrail lets spend or bids go further', label: String(existing.label), changes: diff(pick(existing, keys), null, keys), basis: (existing.updatedAt as Date).toISOString(), effect: `Removes the ${input.kind} on ${input.grain} ${scopeName}.` },
    }
  }
  const prev = existing ?? {}
  const next: Record<string, unknown> = {
    label: (input.label ?? (prev.label as string | undefined) ?? scopeName).trim(),
    enabled: input.enabled ?? (prev.enabled as boolean | undefined) ?? true,
    note: input.note !== undefined ? input.note : (prev.note ?? null),
  }
  let loosen: string | null = null
  if (ceiling) {
    next.dailyCapCents = input.dailyCapCents !== undefined ? input.dailyCapCents : (prev.dailyCapCents ?? null)
    if (next.dailyCapCents != null && (!Number.isInteger(next.dailyCapCents) || (next.dailyCapCents as number) < 0)) return { ok: false, error: 'dailyCapCents: a whole number of cents, 0 or more, or null' }
    const was = existing && existing.enabled ? (existing.dailyCapCents as number | null) : null
    const now = next.enabled ? (next.dailyCapCents as number | null) : null
    if (now == null && was != null) loosen = 'the daily cap is cleared or switched off'
    else if (was != null && now != null && now > was) loosen = `the daily cap rises from ${was}¢ to ${now}¢`
  } else {
    next.minBidCents = input.minBidCents !== undefined ? input.minBidCents : (prev.minBidCents ?? null)
    next.maxBidCents = input.maxBidCents !== undefined ? input.maxBidCents : (prev.maxBidCents ?? null)
    for (const k of ['minBidCents', 'maxBidCents']) if (next[k] != null && (!Number.isInteger(next[k]) || (next[k] as number) < 2)) return { ok: false, error: `${k}: at least 2 cents, or null` }
    if (next.minBidCents != null && next.maxBidCents != null && (next.minBidCents as number) > (next.maxBidCents as number)) return { ok: false, error: `minBidCents (${next.minBidCents}¢) is above maxBidCents (${next.maxBidCents}¢)` }
    const on = (r: Record<string, unknown> | null) => (r && r.enabled !== false ? r : null)
    const was = on(existing), now = on(next)
    const wasMax = (was?.maxBidCents as number | null) ?? null, nowMax = (now?.maxBidCents as number | null) ?? null
    const wasMin = (was?.minBidCents as number | null) ?? null, nowMin = (now?.minBidCents as number | null) ?? null
    if (wasMax != null && (nowMax == null || nowMax > wasMax)) loosen = nowMax == null ? 'the bid ceiling is cleared or switched off' : `the bid ceiling rises from ${wasMax}¢ to ${nowMax}¢`
    else if (nowMin != null && (wasMin == null || nowMin > wasMin)) loosen = `a bid floor of ${nowMin}¢ forces bids up`
  }
  const changes = diff(pick(existing, keys), next, keys)
  if (!Object.keys(changes).length) return { ok: false, error: `The ${input.kind} on ${input.grain} ${scopeName} already holds these values.` }
  return {
    ok: true,
    before: { kind: input.kind, key, row: existing ? pick(existing, keys) : null },
    after: { kind: input.kind, key, row: next },
    plan: {
      action: 'set-ad-guardrail', kind: input.kind, op: 'set', direction: loosen ? 'loosen' : 'tighten',
      why: loosen ?? 'it holds spend or bids tighter', label: String(next.label), changes, basis: existing ? (existing.updatedAt as Date).toISOString() : null,
      effect: `${existing ? 'Changes' : 'Sets'} the ${input.kind} on ${input.grain} ${scopeName}. The write gate applies it at its next decision.`
        + (ceiling ? ' It caps the budget increases authorised in a day in that scope (a raise past it is refused); it does not cap what Amazon spends, bid raises or placement raises.' : ''),
    },
  }
}

export async function applyGuardrail(input: GuardrailInput, actorUserId: string | null): Promise<{ ok: true; plan: GuardrailPlan; before: GuardrailState; after: GuardrailState } | { ok: false; error: string }> {
  const planned = await planGuardrail(input)
  if ('error' in planned) return planned
  const svc = await import('./ads-guardrail.service.js')
  const actor = `user:${actorUserId ?? 'anonymous'}`
  const row = planned.after.row
  const key = planned.after.key
  let out: { ok: boolean; status?: number; body?: Record<string, unknown> }
  if (isCampaignKind(input.kind)) {
    out = await applyCampaignGuardrail(planned, actor)
  } else if (input.kind === 'protected-term') {
    out = input.op === 'set'
      ? await svc.addKeywordProtection({ mode: 'WHITELIST', term: input.term, matchType: input.matchType, marketplace: key.marketplace, campaignId: key.campaignId, reason: input.note ?? 'protected by Claude' }, actor)
      : await svc.removeKeywordProtection(String((await readGuardrail('protected-term', key))!.id), actor)
  } else if (input.op === 'remove') {
    out = input.kind === 'spend-ceiling' ? await svc.deleteSpendCeiling(key, actor) : await svc.deleteBidPolicy(key, actor)
  } else {
    out = input.kind === 'spend-ceiling'
      ? await svc.setSpendCeiling({ grain: key.grain, scopeId: key.scopeId, label: String(row!.label), dailyCapCents: row!.dailyCapCents as number | null, enabled: row!.enabled as boolean, note: row!.note as string | null }, actor)
      : await svc.setBidPolicy({ grain: key.grain, scopeId: key.scopeId, label: String(row!.label), minBidCents: row!.minBidCents as number | null, maxBidCents: row!.maxBidCents as number | null, enabled: row!.enabled as boolean, note: row!.note as string | null }, actor)
  }
  if (isRefused(out as never)) return { ok: false, error: `Not set — ${String((out as { body: Record<string, unknown> }).body.error)}` }
  return planned
}
