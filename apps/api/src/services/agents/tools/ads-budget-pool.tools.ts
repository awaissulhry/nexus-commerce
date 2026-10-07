/**
 * ADS AUTONOMY W4-7 (design agent-results/6 §4 "W3-6a") — set-budget-pool: Claude asks for what the Budget Manager's
 * pool drawer does, through its own services (ads-budget-pool.service.ts, moved out of the routes for this; a pool's edit
 * is ads-engine-settings.service.ts patchBudgetPool, the screen's PATCH). A pool shares one daily budget across its
 * campaigns (in any market) and its cron rebalances it by a share, by profit or by aged-stock urgency.
 *
 *   create         a pool, born switched off and in dry run (as the screen makes one), with campaigns when given.
 *   update         its name, description, daily budget, strategy, cool-down or largest shift per rebalance (the screen's
 *                  edit). Switching it on, off or live is turn-up / turn-down-automation (A9): not here.
 *   allocate       campaigns join it (add: each with its share, lowest and highest budget) or leave it (remove); a
 *                  campaign is in one pool at a time. One leaving keeps the budget it has.
 *   delete         the pool and its allocations go; each campaign keeps the budget it has (nothing is given back).
 *   rebalance-now  one rebalance now, ignoring the cool-down (the drawer's Run): a pool in dry run records it and writes
 *                  nothing; a live one writes each campaign's new budget as the approver, every write in the approval's
 *                  change set.
 *
 * What can raise spend, and the approver's code (ads-budget-kit.ts, the money family rule): campaigns joining a live pool
 * (its next rebalance may raise them) and a live rebalance that raises a budget — the code. A pool's values
 * (tune-ad-engine's lever: a bigger budget, another strategy, a larger shift, a shorter cool-down) are listed in `raises`
 * and need no code, as there. A create (born off, in dry run) and a delete raise nothing.
 *
 * Undo: a create is deleted; an update is set back; an allocation is reversed; a delete is created again (a new pool,
 * switched off and in dry run, with its campaigns: reversibility partial); a live rebalance is put back through
 * set-campaign-budget (its list form).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import {
  addPoolAllocation, createBudgetPool, deleteBudgetPool, getBudgetPool, poolsOfCampaigns, rebalanceBudgetPool, removePoolAllocation,
  type PoolStrategy,
} from '../../advertising/ads-budget-pool.service.js'
import { patchBudgetPool } from '../../advertising/ads-engine-settings.service.js'
import { computeRebalance } from '../../advertising/budget-pool-rebalancer.service.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { approvedRun, BY_RULE_WORDS, canonical, notRun, ruleFactsFor, spOnlyRefusal } from './ads-change-kit.js'
import type { KitItem } from './ads-autonomy-kit.js'
import { budgetLimits, budgetReach, budgetReachNote, budgetRecheck, budgetRuleRefusal, budgetStepUp, codeGate, ID, named, plural, WHY } from './ads-budget-kit.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-budget-pool'
const OPS = ['create', 'update', 'allocate', 'delete', 'rebalance-now'] as const
type Op = (typeof OPS)[number]
const STRATEGIES = ['STATIC', 'PROFIT_WEIGHTED', 'URGENCY_WEIGHTED'] as const
const MAX_CAMPAIGNS = 100
const LINES_SHOWN = 20
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 24)
const CENTS = z.coerce.number().int().min(100).max(100_000_000)

const allocationArg = z.object({
  campaignId: ID.describe('the campaign (Nexus id, campaignId in ad-campaigns)'),
  targetSharePct: z.coerce.number().min(0).max(100).optional().describe('its share of the pool in percent (STATIC strategy; 0 when left out)'),
  minDailyBudgetCents: CENTS.optional().describe('the lowest daily budget a rebalance gives it, in minor units of its currency (100 when left out)'),
  maxDailyBudgetCents: CENTS.optional().describe('the highest daily budget a rebalance gives it, in minor units of its currency (none when left out)'),
})

const input = z.object({
  op: z.enum(OPS).describe('create a pool, update its values, allocate campaigns (add / remove), delete it, or rebalance-now'),
  poolId: ID.optional().describe('every op but create: the pool (its Nexus id, from ad-budgets)'),
  name: z.string().trim().min(1).max(120).optional().describe('create: its name (required); update: a new name'),
  description: z.string().trim().max(500).nullable().optional().describe('create / update: what it is for; null clears it'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional().describe('create: the currency of its daily budget (EUR when left out, as the screen)'),
  totalDailyBudgetCents: CENTS.optional().describe('create (required) / update: the daily budget it shares, in minor units of its currency'),
  strategy: z.enum(STRATEGIES).optional().describe('create / update: STATIC (each campaign\'s share), PROFIT_WEIGHTED (towards 30-day profit) or URGENCY_WEIGHTED (towards aged stock)'),
  coolDownMinutes: z.coerce.number().int().min(15).max(10_080).optional().describe('create / update: minutes between two rebalances'),
  maxShiftPerRebalancePct: z.coerce.number().int().min(1).max(100).optional().describe('create / update: the most of the pool one rebalance may move, in percent'),
  add: z.array(allocationArg).max(MAX_CAMPAIGNS).optional().describe(`create / allocate: campaigns that join the pool (a campaign is in one pool at a time), up to ${MAX_CAMPAIGNS}`),
  remove: z.array(ID).max(MAX_CAMPAIGNS).optional().describe(`allocate: campaigns (Nexus ids) that leave the pool, each keeping the budget it has, up to ${MAX_CAMPAIGNS}`),
  why: WHY,
})
type Args = z.infer<typeof input>

const POOL_VALUES = ['name', 'description', 'totalDailyBudgetCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct'] as const
interface PoolValues { name: string; description: string | null; currency: string; totalDailyBudgetCents: number; strategy: string; coolDownMinutes: number; maxShiftPerRebalancePct: number; enabled: boolean; dryRun: boolean }
interface AllocationRow { campaignId: string; targetSharePct: number; minDailyBudgetCents: number; maxDailyBudgetCents: number | null }
/** A pool as a change records it, and as `current` reads it back. */
interface PoolState { poolId: string | null; pool: PoolValues | null; allocations: AllocationRow[] }

async function poolNow(poolId: string | null): Promise<PoolState> {
  const found = poolId ? await getBudgetPool(poolId) : null
  if (!found) return { poolId, pool: null, allocations: [] }
  const p = found.pool
  return {
    poolId,
    pool: { name: p.name, description: p.description, currency: p.currency, totalDailyBudgetCents: p.totalDailyBudgetCents, strategy: p.strategy, coolDownMinutes: p.coolDownMinutes, maxShiftPerRebalancePct: p.maxShiftPerRebalancePct, enabled: p.enabled, dryRun: p.dryRun },
    allocations: p.allocations.filter((a) => a.campaignId).map((a) => ({ campaignId: a.campaignId!, targetSharePct: Number(a.targetSharePct), minDailyBudgetCents: a.minDailyBudgetCents, maxDailyBudgetCents: a.maxDailyBudgetCents }))
      .sort((x, y) => (x.campaignId < y.campaignId ? -1 : 1)),
  }
}

const levelWords = (p: PoolValues) => (!p.enabled ? 'switched off' : p.dryRun ? 'on, in dry run (it records rebalances and writes nothing)' : 'live (its rebalances write budgets at Amazon)')

/** Campaigns that may join a pool: found, Sponsored Products, not archived, with a market (the route's 400). */
async function joiners(add: NonNullable<Args['add']>, poolId: string | null) {
  const ids = add.map((a) => a.campaignId)
  if (new Set(ids).size !== ids.length) return { refusal: 'add names a campaign twice.' }
  const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, type: true, adProduct: true, marketplace: true, status: true, dailyBudget: true, dailyBudgetCurrency: true } }) : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { refusal: `Not queued: campaign ${named(missing)} ${missing.length === 1 ? 'was' : 'were'} not found in this business.` }
  const cannot = ids.map((id) => byId.get(id)!).map((c) => ({ c, why: spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name }) ?? (String(c.status) === 'ARCHIVED' ? 'it is archived' : !c.marketplace ? 'it has no market in Nexus' : null) })).filter((x) => x.why)
  if (cannot.length) return { refusal: `Not queued: ${named(cannot.map((x) => `campaign "${x.c.name}": ${x.why}`))}.` }
  const inPool = await poolsOfCampaigns(ids)
  const taken = ids.filter((id) => inPool.has(id) && inPool.get(id)!.poolId !== poolId).map((id) => `campaign "${byId.get(id)!.name}" is in the pool "${inPool.get(id)!.poolName}"`)
  if (taken.length) return { refusal: `Not queued: ${named(taken)}. A campaign is in one pool at a time: take it out of that pool first (op allocate, remove).` }
  const already = ids.filter((id) => inPool.get(id)?.poolId === poolId && poolId)
  if (already.length) return { refusal: `Not queued: ${named(already.map((id) => `campaign "${byId.get(id)!.name}"`))} ${already.length === 1 ? 'is' : 'are'} in this pool already.` }
  return { rows: ids.map((id) => byId.get(id)!) }
}

interface Planned { result: ToolResult; state?: PoolState }

async function plan(a: Args, ctx: Pick<ToolContext, 'approvalId'>): Promise<Planned> {
  const refuse = (error: string): Planned => ({ result: { ok: false, error } })
  const given = (keys: readonly string[]) => keys.filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const state = a.op === 'create' ? null : a.poolId ? await poolNow(a.poolId) : null
  if (a.op !== 'create') {
    if (!a.poolId) return refuse(`Name the pool to ${a.op === 'rebalance-now' ? 'rebalance' : a.op} (poolId), from ad-budgets.`)
    if (!state?.pool) return refuse(`There is no budget pool ${a.poolId} in this business (not found).`)
  }
  const pool = state?.pool ?? null
  const money = (cents: number, currency = pool?.currency ?? a.currency ?? 'EUR') => amountLabel(cents, currency)
  const extra = (allowed: readonly string[]) => given([...POOL_VALUES, 'currency', 'add', 'remove']).filter((k) => !allowed.includes(k))

  const coded: string[] = []
  const uncoded: string[] = []
  const items: KitItem[] = []
  const markets = new Set<string>()
  let changes: Array<{ label: string; from: string; to: string }> = []
  let lines: Array<Record<string, unknown>> = []
  let writes: Array<{ campaignId: string; marketplace: string | null; toCents: number; label: string }> = []
  let after: PoolValues | null = pool
  let effect = ''
  let nothing: string | null = null

  if (a.op === 'create') {
    const wrong = extra(['name', 'description', 'currency', 'totalDailyBudgetCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct', 'add'])
    if (wrong.length) return refuse(`op create takes no ${wrong.join(', ')}.`)
    if (!a.name || !a.totalDailyBudgetCents) return refuse('A new pool needs a name and its daily budget (totalDailyBudgetCents).')
    const joining = a.add?.length ? await joiners(a.add, null) : { rows: [] }
    if ('refusal' in joining) return refuse(joining.refusal!)
    after = { name: a.name, description: a.description ?? null, currency: a.currency ?? 'EUR', totalDailyBudgetCents: a.totalDailyBudgetCents, strategy: a.strategy ?? 'STATIC', coolDownMinutes: a.coolDownMinutes ?? 60, maxShiftPerRebalancePct: a.maxShiftPerRebalancePct ?? 20, enabled: false, dryRun: true }
    for (const c of joining.rows!) { markets.add(c.marketplace!); items.push({ entity: { kind: 'campaign', id: c.id }, change: { field: 'automation', raises: false }, nexusOnly: true }) }
    lines = joining.rows!.map((c) => ({ campaignId: c.id, label: `campaign "${c.name}"`, does: 'joins' }))
    effect = `Creates the budget pool "${a.name}" (${money(after.totalDailyBudgetCents, after.currency)} a day, ${after.strategy}), switched off and in dry run as the screen makes one${lines.length ? `, with ${plural(lines.length, 'campaign')}` : ''}. It moves no budget until a person switches it on (turn-up-automation).`
  } else if (a.op === 'update') {
    const wrong = extra(['name', 'description', 'totalDailyBudgetCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct'])
    if (wrong.length) return refuse(`op update takes no ${wrong.join(', ')}${wrong.includes('add') || wrong.includes('remove') ? ' (campaigns join or leave with op allocate)' : ''}.`)
    after = { ...pool!, ...Object.fromEntries(given(POOL_VALUES).map((k) => [k, (a as Record<string, unknown>)[k] ?? null])) } as PoolValues
    changes = POOL_VALUES.filter((k) => canonical(pool![k]) !== canonical(after![k])).map((k) => ({
      label: k, from: k === 'totalDailyBudgetCents' ? money(pool![k]) : String(pool![k] ?? 'none'), to: k === 'totalDailyBudgetCents' ? money(after![k]) : String(after![k] ?? 'none'),
    }))
    if (!changes.length) nothing = `the pool "${pool!.name}" is already as asked`
    // tune-ad-engine's own judgement of a pool's values (listed, no code: its lever).
    if (after.totalDailyBudgetCents > pool!.totalDailyBudgetCents) uncoded.push(`the pool's daily budget rises from ${money(pool!.totalDailyBudgetCents)} to ${money(after.totalDailyBudgetCents)}`)
    if (after.strategy !== pool!.strategy) uncoded.push(`a new strategy (${pool!.strategy} → ${after.strategy}) moves budget between the pool's campaigns`)
    if (after.maxShiftPerRebalancePct > pool!.maxShiftPerRebalancePct) uncoded.push(`one rebalance may move more of the pool (${pool!.maxShiftPerRebalancePct}% → ${after.maxShiftPerRebalancePct}%)`)
    if (after.coolDownMinutes < pool!.coolDownMinutes) uncoded.push(`the pool rebalances more often (every ${pool!.coolDownMinutes} → ${after.coolDownMinutes} minutes)`)
    const ids = state!.allocations.map((x) => x.campaignId)
    const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true } }) : []
    for (const r of rows) { if (r.marketplace) markets.add(r.marketplace); items.push({ entity: { kind: 'campaign', id: r.id }, change: { field: 'automation', raises: uncoded.length > 0 }, nexusOnly: true }) }
    effect = `Changes the budget pool "${pool!.name}": ${changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(', ')}. It is ${levelWords(pool!)}: the new values apply from its next rebalance.`
  } else if (a.op === 'allocate') {
    const wrong = extra(['add', 'remove'])
    if (wrong.length) return refuse(`op allocate takes no ${wrong.join(', ')} (a pool's values change with op update).`)
    if (!a.add?.length && !a.remove?.length) return refuse('Name the campaigns that join (add) or leave (remove) the pool.')
    const joining = a.add?.length ? await joiners(a.add, a.poolId!) : { rows: [] }
    if ('refusal' in joining) return refuse(joining.refusal!)
    const leaving = [...new Set(a.remove ?? [])]
    if ((a.add ?? []).some((x) => leaving.includes(x.campaignId))) return refuse('A campaign cannot both join and leave the pool in one request.')
    const notIn = leaving.filter((id) => !state!.allocations.some((x) => x.campaignId === id))
    if (notIn.length) return refuse(`Not queued: campaign ${named(notIn)} ${notIn.length === 1 ? 'is' : 'are'} not in the pool "${pool!.name}".`)
    const leaveRows = leaving.length ? await prisma.campaign.findMany({ where: { id: { in: leaving } }, select: { id: true, name: true, marketplace: true } }) : []
    const live = pool!.enabled && !pool!.dryRun
    for (const c of joining.rows!) {
      markets.add(c.marketplace!)
      const max = a.add!.find((x) => x.campaignId === c.id)!.maxDailyBudgetCents
      if (live) coded.push(`campaign "${c.name}" joins a live pool: its next rebalance may raise its budget from ${amountLabel(Math.round(Number(c.dailyBudget) * 100), campaignCurrency(c))}${max ? ` up to ${amountLabel(max, campaignCurrency(c))}` : ''}`)
      items.push({ entity: { kind: 'campaign', id: c.id }, change: { field: 'automation', raises: live }, nexusOnly: true })
    }
    for (const c of leaveRows) { if (c.marketplace) markets.add(c.marketplace); items.push({ entity: { kind: 'campaign', id: c.id }, change: { field: 'automation', raises: false }, nexusOnly: true }) }
    lines = [
      ...joining.rows!.map((c) => ({ campaignId: c.id, label: `campaign "${c.name}"`, does: 'joins', ...a.add!.find((x) => x.campaignId === c.id) })),
      ...leaving.map((id) => ({ campaignId: id, label: `campaign "${leaveRows.find((r) => r.id === id)?.name ?? id}"`, does: 'leaves (keeps the budget it has)' })),
    ]
    effect = `In the budget pool "${pool!.name}" (${levelWords(pool!)}): ${[joining.rows!.length ? `${plural(joining.rows!.length, 'campaign')} join` : '', leaving.length ? `${plural(leaving.length, 'campaign')} leave, each keeping the budget it has` : ''].filter(Boolean).join('; ')}.`
  } else if (a.op === 'delete') {
    const wrong = extra([])
    if (wrong.length) return refuse(`op delete takes no ${wrong.join(', ')}: it deletes the pool and its allocations.`)
    after = null
    const ids = state!.allocations.map((x) => x.campaignId)
    const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, marketplace: true } }) : []
    for (const r of rows) { if (r.marketplace) markets.add(r.marketplace); items.push({ entity: { kind: 'campaign', id: r.id }, change: { field: 'automation', raises: false }, nexusOnly: true }) }
    effect = `Deletes the budget pool "${pool!.name}" (${levelWords(pool!)}) and its ${plural(ids.length, 'allocation')}: each campaign keeps the budget it has now; nothing is given back.`
  } else {
    const wrong = extra([])
    if (wrong.length) return refuse(`op rebalance-now takes no ${wrong.join(', ')}.`)
    const outcome = await computeRebalance({ poolId: a.poolId!, triggeredBy: 'preview', ignoreCoolDown: true })
    if (outcome.skipped) {
      const why = { disabled: 'it is switched off (turn-up-automation switches it on)', no_allocations: 'it has no campaigns (op allocate adds them)', pool_not_found: 'it was not found', cooldown: 'it is cooling down' }[outcome.skipped]
      return refuse(`Not queued: the pool "${pool!.name}" would not rebalance now: ${why}.`)
    }
    const ids = outcome.proposed.map((x) => x.campaignId).filter((id): id is string => !!id)
    const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, marketplace: true, dailyBudgetCurrency: true } }) : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const moving = outcome.proposed.filter((x) => x.campaignId && x.shiftCents !== 0 && byId.has(x.campaignId))
    lines = moving.map((x) => {
      const c = byId.get(x.campaignId!)!
      return { campaignId: c.id, label: `campaign "${c.name}"`, currency: campaignCurrency(c), fromCents: x.oldBudgetCents, toCents: x.proposedBudgetCents, ...(x.clampedReason ? { clampedBy: x.clampedReason } : {}) }
    })
    if (!moving.length) nothing = `the pool "${pool!.name}" would move no budget now (every campaign is at its share)`
    for (const x of moving) {
      const c = byId.get(x.campaignId!)!
      if (c.marketplace) markets.add(c.marketplace)
      items.push(pool!.dryRun
        ? { entity: { kind: 'campaign', id: c.id }, change: { field: 'automation', raises: false }, nexusOnly: true }
        : { entity: { kind: 'campaign', id: c.id }, change: { field: 'dailyBudget', fromCents: x.oldBudgetCents, toCents: x.proposedBudgetCents } })
      if (!pool!.dryRun && x.proposedBudgetCents > x.oldBudgetCents) coded.push(`campaign "${c.name}": ${amountLabel(x.oldBudgetCents, campaignCurrency(c))} → ${amountLabel(x.proposedBudgetCents, campaignCurrency(c))}`)
    }
    if (!pool!.dryRun) writes = moving.map((x) => ({ campaignId: x.campaignId!, marketplace: byId.get(x.campaignId!)!.marketplace, toCents: x.proposedBudgetCents, label: `campaign "${byId.get(x.campaignId!)!.name}"` }))
    effect = pool!.dryRun
      ? `Rebalances the budget pool "${pool!.name}" now, in dry run: the rebalance is recorded (${plural(moving.length, 'campaign')} would move, ${money(outcome.totalShiftCents)} in all) and nothing is written.`
      : `Rebalances the live budget pool "${pool!.name}" now: ${plural(moving.length, 'campaign')}' daily budgets move (${money(outcome.totalShiftCents)} in all), each written as the approver.`
  }
  if (nothing) return refuse(`Nothing would change: ${nothing}.`)

  const reached = writes.length ? await budgetReach(writes) : { reach: null, gateRefuses: [] }
  if ('refused' in reached) return refuse(`Not queued: ${reached.refused}`)
  const raises = [...coded, ...uncoded]
  const rule = await ruleFactsFor({
    tool: TOOL, limits: POOL_LIMITS, items, approvalId: ctx.approvalId ?? null,
    writes: writes.map((w) => ({ campaignId: w.campaignId, marketplace: w.marketplace, changes: [{ field: 'dailyBudget', valueCents: w.toCents }], label: w.label })),
  })
  const label = `"${pool?.name ?? a.name}"`
  const stepUp = budgetStepUp(a.op === 'rebalance-now' ? `rebalances the live budget pool ${label}, raising budgets` : `adds campaigns to the live budget pool ${label}, which may raise their budgets`, coded.length ? ['Budgets'] : [])
  const later = a.op === 'rebalance-now' ? '' : after && after.enabled && !after.dryRun ? 'Its cron rebalances it at Amazon every 15 minutes, after its cool-down.' : 'It writes nothing at Amazon until a person switches it live (turn-up-automation, A9).'
  return {
    state: state ?? undefined,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: a.op,
        poolId: a.poolId ?? null,
        name: pool?.name ?? a.name,
        markets: [...markets].sort(),
        pool: { from: pool, to: after },
        ...(changes.length ? { changes } : {}),
        ...(lines.length ? { campaigns: lines.slice(0, LINES_SHOWN) } : {}),
        ...(lines.length > LINES_SHOWN ? { moreCampaigns: lines.length - LINES_SHOWN } : {}),
        totals: { campaigns: lines.length, writes: writes.length },
        // tune-ad-engine's own reading of a pool's daily budget, for the business's limit (maxPoolDailyCents).
        poolDailyBudgetCents: after?.totalDailyBudgetCents ?? null,
        raises,
        ...(stepUp ? { stepUp } : {}),
        ...(uncoded.length ? { raisesWithoutCode: 'A pool\'s values are tune-ad-engine\'s lever: they move spend without a code there, so here too.' } : {}),
        // Every starting value the person approves: the pool and its allocations as they are, and what a rebalance moves.
        basis: hash({ state, lines }),
        reach: reached.reach,
        reachNote: budgetReachNote(reached.reach, later),
        effect,
        undoNote: {
          create: 'Undo deletes the pool.',
          update: 'Undo sets the pool\'s values back, through set-budget-pool.',
          allocate: 'Undo reverses it: the campaigns that joined leave, the ones that left join again with their old share and budgets.',
          delete: 'Undo creates the pool again with its values and campaigns: a new pool, switched off and in dry run (turn-up-automation switches it on again); its rebalance history is not brought back.',
          'rebalance-now': pool?.dryRun ? 'A dry run changes no budget: there is nothing to undo.' : 'Undo puts each campaign\'s daily budget back as it was, through set-campaign-budget (its list form).',
        }[a.op as Op],
        ...rule,
      },
    },
  }
}

/** set-budget-pool's limits: nothing by rule by default; a pool's daily budget by rule at most maxPoolDailyCents. */
const POOL_LIMITS = budgetLimits(OPS, {
  maxPoolDailyCents: z.number().int().min(0).max(100_000_000).default(0)
    .describe('the largest daily budget a pool may hold after a change run by rule, in minor units of its currency; 0 = none'),
})

function poolRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const shared = budgetRuleRefusal(preview, limits)
  if (shared) return shared
  const p = (preview ?? {}) as { poolDailyBudgetCents?: unknown; pool?: { to?: { currency?: string } | null; from?: { currency?: string } | null } }
  const cents = p.poolDailyBudgetCents
  const currency = p.pool?.to?.currency ?? p.pool?.from?.currency ?? 'EUR'
  const max = typeof limits.maxPoolDailyCents === 'number' ? limits.maxPoolDailyCents : 0
  if (typeof cents === 'number' && cents > max) return `the pool's daily budget would be ${amountLabel(cents, currency)}, more than the ${amountLabel(max, currency)} this tool's limits let a change run by rule (maxPoolDailyCents); a person decides`
  return null
}

/** What a change of this op records as `after`, and what `current` reads back. */
async function afterOf(before: { op?: Op; poolId?: string | null; campaignIds?: string[] }, poolId: string | null): Promise<unknown> {
  if (before.op === 'rebalance-now') {
    const ids = before.campaignIds ?? []
    const rows = ids.length ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, dailyBudget: true } }) : []
    const byId = new Map(rows.map((r) => [r.id, Math.round(Number(r.dailyBudget) * 100)]))
    return { campaigns: ids.map((campaignId) => ({ campaignId, dailyBudgetCents: byId.get(campaignId) ?? null })) }
  }
  return poolNow(poolId)
}

export const SET_BUDGET_POOL_UNDO: ToolUndo = {
  current(change) {
    const before = (change.before ?? {}) as { op?: Op; campaignIds?: string[] }
    const after = (change.after ?? {}) as { poolId?: string | null }
    return afterOf(before, after.poolId ?? null)
  },
  request(change) {
    const before = (change.before ?? {}) as { op?: Op; state?: PoolState; budgets?: Array<{ campaignId: string; dailyBudgetCents: number }> }
    const after = (change.after ?? {}) as Partial<PoolState>
    const why = 'undo of an earlier budget pool change'
    const s = before.state
    switch (before.op) {
      case 'create':
        return after.poolId ? { tool: TOOL, args: { op: 'delete', poolId: after.poolId, why } } : { refusal: 'This change does not record the pool it created.' }
      case 'update':
        if (!s?.pool || !s.poolId) return { refusal: 'This change does not record the pool it replaced.' }
        return { tool: TOOL, args: { op: 'update', poolId: s.poolId, ...Object.fromEntries(POOL_VALUES.map((k) => [k, s.pool![k]])), why } }
      case 'allocate': {
        if (!s?.poolId) return { refusal: 'This change does not record the pool it changed.' }
        const was = new Set(s.allocations.map((x) => x.campaignId))
        const now = new Set((after.allocations ?? []).map((x) => x.campaignId))
        const add = s.allocations.filter((x) => !now.has(x.campaignId)).map((x) => ({ campaignId: x.campaignId, targetSharePct: x.targetSharePct, minDailyBudgetCents: x.minDailyBudgetCents, ...(x.maxDailyBudgetCents != null ? { maxDailyBudgetCents: x.maxDailyBudgetCents } : {}) }))
        const remove = [...now].filter((id) => !was.has(id))
        return { tool: TOOL, args: { op: 'allocate', poolId: s.poolId, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}), why } }
      }
      case 'delete':
        if (!s?.pool) return { refusal: 'This change does not record the pool it deleted.' }
        return {
          tool: TOOL,
          args: {
            op: 'create', ...Object.fromEntries(POOL_VALUES.map((k) => [k, s.pool![k]])), currency: s.pool.currency,
            ...(s.allocations.length ? { add: s.allocations.map((x) => ({ campaignId: x.campaignId, targetSharePct: x.targetSharePct, minDailyBudgetCents: x.minDailyBudgetCents, ...(x.maxDailyBudgetCents != null ? { maxDailyBudgetCents: x.maxDailyBudgetCents } : {}) })) } : {}),
            why,
          },
        }
      case 'rebalance-now':
        return before.budgets?.length
          ? { tool: 'set-campaign-budget', args: { campaigns: before.budgets.map((b) => ({ campaignId: b.campaignId, dailyBudgetCents: b.dailyBudgetCents })), why } }
          : { refusal: 'This rebalance changed no budget.' }
      default:
        return { refusal: 'This change does not record what it did.' }
    }
  },
}

async function execute(a: Args, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await plan(a, ctx)
  const refusal = budgetRecheck(ctx, fresh.result, ['basis', 'totals'])
  if (refusal) return notRun(refusal)
  const p = fresh.result.preview as { effect: string; reach: unknown; campaigns?: Array<{ campaignId: string; fromCents?: number }> }
  const coded = await codeGate(ctx, fresh.result.preview)
  if (coded) return notRun(coded)
  const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const before = fresh.state ?? null
  const failed: string[] = []
  let poolId = a.poolId ?? null
  let change: ToolChange | undefined
  if (a.op === 'create') {
    const out = await createBudgetPool({ name: a.name!, ...(a.description != null ? { description: a.description } : {}), ...(a.currency ? { currency: a.currency } : {}), totalDailyBudgetCents: a.totalDailyBudgetCents!, ...(a.strategy ? { strategy: a.strategy as PoolStrategy } : {}), ...(a.coolDownMinutes ? { coolDownMinutes: a.coolDownMinutes } : {}), ...(a.maxShiftPerRebalancePct ? { maxShiftPerRebalancePct: a.maxShiftPerRebalancePct } : {}) }, { createdBy: run.actor })
    if ('invalid' in out) return notRun(`Not run: ${out.invalid}.`)
    poolId = out.pool.id
    for (const x of a.add ?? []) {
      const added = await addPoolAllocation(poolId, x)
      if ('error' in added) failed.push(`campaign ${x.campaignId} (${added.error})`)
    }
    change = { before: { op: 'create', poolId: null, changeSetId: run.changeSetId }, after: await poolNow(poolId) }
  } else if (a.op === 'update') {
    const body = Object.fromEntries(POOL_VALUES.filter((k) => (a as Record<string, unknown>)[k] !== undefined).map((k) => [k, (a as Record<string, unknown>)[k]]))
    if (!(await patchBudgetPool(poolId!, body))) return notRun('Not run: the pool is gone. Nothing changed.')
    change = { before: { op: 'update', state: before, changeSetId: run.changeSetId }, after: await poolNow(poolId) }
  } else if (a.op === 'allocate') {
    for (const x of a.add ?? []) {
      const added = await addPoolAllocation(poolId!, x)
      if ('error' in added) failed.push(`campaign ${x.campaignId} (${added.error})`)
    }
    const ids = await poolsOfCampaigns(a.remove ?? [])
    for (const id of a.remove ?? []) {
      const allocation = ids.get(id)
      if (!allocation || allocation.poolId !== poolId || !(await removePoolAllocation(poolId!, allocation.allocationId))) failed.push(`campaign ${id} (not in the pool)`)
    }
    change = { before: { op: 'allocate', state: before, changeSetId: run.changeSetId }, after: await poolNow(poolId) }
  } else if (a.op === 'delete') {
    if (!(await deleteBudgetPool(poolId!))) return notRun('Not run: the pool is gone already. Nothing changed.')
    change = { before: { op: 'delete', state: before, changeSetId: run.changeSetId }, after: await poolNow(poolId) }
  } else {
    const out = await rebalanceBudgetPool(poolId!, { preview: false, actor: run.actor, changeSetId: run.changeSetId, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits })
    if ('skipped' in out) return notRun(`Not run: the pool skipped the rebalance (${out.skipped}). Nothing changed.`)
    const perAllocation = ('applied' in out.outcome ? out.outcome.applied?.perAllocation : undefined) ?? []
    const applied = perAllocation.filter((x) => x.status === 'APPLIED' && x.campaignId)
    for (const x of perAllocation) if (x.status === 'FAILED') failed.push(`campaign ${x.campaignId} (${x.error ?? 'refused'})`)
    const budgets = applied.map((x) => ({ campaignId: x.campaignId!, dailyBudgetCents: out.outcome.proposed.find((pr) => pr.allocationId === x.allocationId)!.oldBudgetCents }))
    if (budgets.length) {
      const record = { op: 'rebalance-now' as const, poolId, campaignIds: budgets.map((b) => b.campaignId) }
      change = { before: { ...record, budgets, changeSetId: run.changeSetId }, after: await afterOf(record, poolId) }
    }
  }
  const now = await poolNow(poolId)
  const data = {
    op: a.op, poolId: a.op === 'delete' ? null : poolId, ...(now.pool ? { pool: now.pool, campaigns: now.allocations.length } : {}),
    reach: p.reach, changeSetId: run.changeSetId,
    note: a.op === 'rebalance-now' && p.reach ? 'Queued for Amazon: each budget is sent after the 5-minute cancel window. approval-status follows them.' : 'Saved in Nexus.',
  }
  if (failed.length) return { ok: false, data, change, error: `Partly run: ${plural(failed.length, 'campaign')} refused — ${named(failed)}. undo-change puts back what ran.` }
  return { ok: true, data, change }
}

const setBudgetPool: AgentTool = {
  name: TOOL,
  title: 'Change a budget pool',
  input,
  requires: [F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  // A live rebalance writes budgets at Amazon now; a live pool's cron writes them later.
  openWorld: true,
  // A deleted pool comes back as a new one, switched off and without its rebalance history.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: POOL_LIMITS,
  withinLimits: poolRefusal,
  undo: SET_BUDGET_POOL_UNDO,
  description:
    'Change an Amazon ads budget pool, as the Budget Manager\'s pool drawer does: one daily budget shared by its '
    + 'campaigns, rebalanced by share, profit or aged-stock urgency. op create (born switched off and in dry run, as the '
    + 'screen makes one; campaigns may join at once with add), update (name, description, daily budget, strategy, '
    + 'cool-down, largest shift), allocate (campaigns join with add — each with its share, lowest and highest budget — or '
    + 'leave with remove, keeping the budget they have; a campaign is in one pool at a time), delete (each campaign keeps '
    + 'its budget) or rebalance-now (one rebalance now, ignoring the cool-down: a pool in dry run only records it; a live '
    + 'one writes each budget as the approver). Switching a pool on, off or live is turn-up / turn-down-automation (A9). '
    + `${BY_RULE_WORDS} (by default nothing runs by rule). Campaigns joining a live pool and a live rebalance that raises a `
    + 'budget are approved with the approver\'s authenticator code (stepUp); a pool\'s values behave as tune-ad-engine '
    + '(listed in raises, no code). The preview shows the pool from → to, each campaign joining, leaving or moving, and '
    + 'where a write lands (live at Amazon or sandbox). Undo reverses it (a deleted pool comes back as a new one, switched off).',
  async handler(args, ctx) {
    return (await plan(args as Args, ctx)).result
  },
  async execute(args, ctx) {
    return execute(args as Args, ctx)
  },
}

export const ADS_BUDGET_POOL_TOOLS: AgentTool[] = [setBudgetPool]
