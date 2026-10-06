/**
 * ADS PLAYBOOK PB-8 — the playbook's rank roles compiled into hourly bid plans (design report 9 §3.6, §5.2; PB-5 spec
 * §4): ONE RankScheduleGroup per rank role (performance, research) with an EXPLICIT member list — this product's linked
 * campaigns of that role, never a portfolio scope — saved through the Hourly Bids page's own writer
 * (ads-create.service.ts saveRankScheduleGroup). The engine is unchanged: rank-defend runs the members' AdSchedule rows.
 *
 *   build / adopt  each role's group is created SWITCHED OFF, its member schedules too: nothing runs until START. A group
 *                  the playbook made already (its AdsPlaybookLink rankGroup, origin built) only follows the slots — a
 *                  campaign gone leaves it, a new one joins it while it is off (one that is on takes a new campaign only
 *                  at START) — and keeps its name, hours, baseline and on/off as they are. An adopt changes Nexus only:
 *                  a campaign it unbinds from a plan that is on stays in it until STOP.
 *   start / stop   START switches the playbook's groups on as the product's phase says (the strategy's goal: a role the
 *                  phase runs `off` stays off, `light` gets the role's light plan), its members the slots' campaigns again.
 *                  With no phase set only research goes on: performance needs a goal. A phase that cannot be read
 *                  switches nothing on. STOP switches them off.
 *   phase          `applyRankPhase` (PB-9 calls it; `previewRankPhase` is its preview, `rankOffEffect` counts what a role
 *                  switched off does to bids): off / on / light per role; before START a group is never switched on.
 *
 * SWITCHED OFF, NOTHING RISES. A plan saved off (or a campaign taken out of one) gives back by itself what rank set
 * (ads-create.service.ts → rank-release.service.ts): the floor of a Min-bid window, a base-bid change. Inside a Min-bid
 * window that lifts bids from 2¢ to full, and STOP's own floor cannot stop it (suppressCampaignBids is a no-op on a
 * campaign already floored). So before such a save the rank-owned floors are handed over to the person who switches it
 * off (`Campaign.bidsSuppressedBy`: the bids stay at the floor, remembered; START gives them back), and a base-bid change
 * that rank made DOWNWARD is kept where it is (its baseline let go, so the give-back cannot raise it). A change rank
 * made upward goes back to its baseline (lower). Placements stay as last set (Owner S6) and the summary names the top of
 * search. `floors: 'giveBack'` (a phase that means it, PB-9) lets the give-back run: a raise, and `rankOffEffect` says so.
 *
 * THE OWNER'S HOURLY PLANS ARE HIS OWN. The group writer re-binds every member's schedule to the group it saves and
 * overwrites its hours (design risk 6), and saved without an id it takes over a group of the same name. So a role is
 * REFUSED by name, and nothing of it is written, when one of its campaigns
 *   · has an hourly plan the playbook did not make — a member of another group, or a schedule of its own (on or off);
 *   · sits in a portfolio another group covers (a portfolio-scoped group pulls it in on its next save);
 *   · is governed by an enabled product rank plan, resolved as the rank engine resolves it (any product's: by the
 *     family's ASINs in its market, minus the campaigns it excludes) — the plan wins over a schedule there;
 *   · still carries bids an earlier hourly plan left (a floor, a base-bid change): a plan saved switched off gives those
 *     back by itself, and on a live campaign only a person does that (Owner, 2026-10-04);
 * or when a group the playbook did not make already has the name it would get. Just before each save it is checked
 * again: a group is created first and then saved by its id (never by name), an update saves only a group the
 * playbook's link still names, and a campaign another plan took meanwhile is never re-bound. Adopting the Owner's
 * groups is a production step on his word, never this compiler's.
 *
 * ONE OWNER PER CAMPAIGN: once its group is on, auto-bid leaves the campaign alone (ads-auto-bid.service.ts
 * autoBidHolders: an enabled schedule is "an hourly plan holds"); switched off it holds nothing, and the campaign is the
 * other engines' as before (a campaign the playbook built is off the live-write allowlist until START anyway).
 *
 * Every save is read back (on/off, members, hours); a difference is an error of the op. The links a caller hands in are
 * read again from the database (a preview is handed none). Static imports stay db, logger and types: artifacts.ts reads
 * `rankGroupCompiler` while it loads, inside the tool registry's import cycle.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import type { RankScheduleGroupInput } from '../ads-create.service.js'
import type { ArtifactCompiler, ArtifactContext, ArtifactExpectation, ArtifactLink, ArtifactPreviewLine } from './artifacts.js'
import type { Phase, RankRole } from './doc.js'

export const RANK_GROUP_KIND = 'rankGroup' as const
const ROLES: readonly RankRole[] = ['performance', 'research']
const ROLE_WORD: Record<RankRole, string> = { performance: 'Performance', research: 'Research' }
/** The rank engine's own floor owners (rank-release.service.ts RANK_OWNER_PREFIXES), and a legacy floor with none. */
const RANK_FLOOR_PREFIXES = ['automation:rank-defend-', 'automation:rank-plan-', 'automation:dayparting-'] as const
const isRankFloor = (by: string | null | undefined) => by == null || by === '' || RANK_FLOOR_PREFIXES.some((p) => by.startsWith(p))

/** The artifact key of a role's group ('rank:performance'). */
export const rankKey = (role: RankRole) => `rank:${role}`
const roleOfKey = (key: string): RankRole | null => ROLES.find((r) => rankKey(r) === key) ?? null

/** The name a role's group is created with (a group the playbook made keeps whatever name it has since). */
export const rankGroupName = (nameToken: string, market: string, role: RankRole) => `${nameToken} | ${market} | Playbook ${ROLE_WORD[role]}`

/** A phase's rank state per role (doc.ts PHASE.rank). */
export type RankPhaseStates = Partial<Record<RankRole, 'off' | 'on' | 'light'>>

/** What a plan switched off does with what rank set: keep it (hand the floors over) or give it back (a raise). */
export type RankFloors = 'keep' | 'giveBack'

/** A group this playbook made, as it stands now. */
export interface OwnedRankGroup {
  role: RankRole
  groupId: string
  name: string
  enabled: boolean
  windows: unknown[]
  defaultTargetKey: string | null
  targetOverrides: Record<string, unknown>
  timezone: string
  marketplace: string | null
  /** Its members now: the AdSchedule rows bound to it. */
  members: Array<{ campaignId: string; enabled: boolean }>
}

/** What a campaign holds that a plan switched off would give back, and its top-of-search placement. */
export interface RankBidState {
  /** Floored, and by whom (null = not floored). */
  floorBy: string | null
  floored: boolean
  /** Bids remembered under the floor. */
  flooredBids: number
  /** Base-bid changes rank made: going back to the baseline would raise (rank lowered) or lower (rank raised) them. */
  deltaUp: number
  deltaDown: number
  /** Top-of-search placement %, as last set. */
  topPct: number
}

/** What a compile or a switch decides on, read once (no writes). */
export interface RankFacts {
  owned: Map<RankRole, OwnedRankGroup>
  campaigns: Map<string, { id: string; name: string; status: string }>
  bids: Map<string, RankBidState>
  /** A slot campaign an hourly plan the playbook did not make holds, and which one (words). */
  heldBy: Map<string, string>
  /** A slot campaign still carrying bids an earlier hourly plan left (words). */
  leftovers: Map<string, string>
  /** Names of groups the playbook did not make (a create under one would take it over). */
  twins: Set<string>
  /** The market's own time zone (ads-market-time.ts), when a role names none. */
  marketTimezone: string | null
}

/** One role's step: what it does, in words, and the save it makes (none for a keep or a report). */
export interface RankStep {
  role: RankRole
  key: string
  does: ArtifactPreviewLine['does']
  summary: string
  refId?: string
  /** A refusal: nothing of the role is written, and the op names it as an error. */
  refused?: boolean
  save?: RankScheduleGroupInput
  /** A switch: the group keeps the members it has when it is saved (read again just before). */
  liveMembers?: boolean
  /** What happens to what rank set on a campaign the save switches off or takes out (default keep). */
  floors?: RankFloors
  /** What the saved group must read back as. */
  expect?: { members: string[]; enabled: boolean; windows: unknown[]; defaultTargetKey: string | null }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
/** Key order free: PostgreSQL's jsonb gives an object's keys back in its own order. */
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null))
const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(', ')
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** Each campaign's floor, remembered bids, base-bid changes and top-of-search placement (no writes). */
async function loadBidStates(ids: string[], rows: Array<{ id: string; bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null; dynamicBidding: unknown }>): Promise<Map<string, RankBidState>> {
  const out = new Map<string, RankBidState>()
  if (!ids.length) return out
  for (const c of rows) {
    const top = (obj(c.dynamicBidding).placementBidding as Array<{ placement?: string; percentage?: number }> | undefined)?.find((p) => p?.placement === 'PLACEMENT_TOP')?.percentage
    out.set(c.id, { floorBy: c.bidsSuppressedAt ? (c.bidsSuppressedBy ?? null) : null, floored: !!c.bidsSuppressedAt, flooredBids: 0, deltaUp: 0, deltaDown: 0, topPct: typeof top === 'number' ? top : 0 })
  }
  const [groups, targets] = await Promise.all([
    prisma.adGroup.findMany({ where: { campaignId: { in: ids }, OR: [{ suppressedFromBidCents: { not: null } }, { baseBidFromCents: { not: null } }] }, select: { campaignId: true, bidsSuppressedAt: true, defaultBidCents: true, suppressedFromBidCents: true, baseBidFromCents: true } }),
    prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: ids } }, OR: [{ suppressedFromBidCents: { not: null } }, { baseBidFromCents: { not: null } }] }, select: { bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true, adGroup: { select: { campaignId: true, bidsSuppressedAt: true } } } }),
  ])
  const bump = (campaignId: string, groupFloored: boolean, remembered: number | null, base: number | null, current: number) => {
    const s = out.get(campaignId)
    if (!s) return
    if (remembered != null) s.flooredBids++
    // revertBaseBidDelta leaves an ad group floored on its own alone.
    if (base != null && !groupFloored) { if (base > current) s.deltaUp++; else if (base < current) s.deltaDown++ }
  }
  for (const g of groups) bump(g.campaignId, !!g.bidsSuppressedAt, g.suppressedFromBidCents, g.baseBidFromCents, g.defaultBidCents)
  for (const t of targets) bump(t.adGroup.campaignId, !!t.adGroup.bidsSuppressedAt, t.suppressedFromBidCents, t.baseBidFromCents, t.bidCents)
  return out
}

/** Read what the playbook owns and what holds its slot campaigns. */
export async function loadRankFacts(ctx: ArtifactContext): Promise<RankFacts> {
  const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: ctx.playbookId, kind: RANK_GROUP_KIND, origin: 'built' }, select: { key: true, refId: true } })
  const byRole = new Map<RankRole, string>()
  for (const l of links) { const role = roleOfKey(l.key); if (role) byRole.set(role, l.refId) }
  const linkedIds = [...byRole.values()]
  const [groups, bound] = linkedIds.length
    ? await Promise.all([
      prisma.rankScheduleGroup.findMany({ where: { id: { in: linkedIds } }, select: { id: true, name: true, enabled: true, windows: true, defaultTargetKey: true, targetOverrides: true, timezone: true, marketplace: true } }),
      prisma.adSchedule.findMany({ where: { groupId: { in: linkedIds } }, select: { campaignId: true, groupId: true, enabled: true } }),
    ])
    : [[], []]
  // A link whose group is gone (deleted on Hourly Bids) owns nothing: the role is compiled again.
  const owned = new Map<RankRole, OwnedRankGroup>()
  for (const [role, id] of byRole) {
    const g = groups.find((x) => x.id === id)
    if (!g) continue
    owned.set(role, {
      role, groupId: g.id, name: g.name, enabled: g.enabled, windows: arr(g.windows), defaultTargetKey: g.defaultTargetKey ?? null,
      targetOverrides: obj(g.targetOverrides), timezone: g.timezone, marketplace: g.marketplace ?? null,
      members: bound.filter((s) => s.groupId === id).map((s) => ({ campaignId: s.campaignId, enabled: s.enabled })),
    })
  }
  const ownedIds = new Set([...owned.values()].map((g) => g.groupId))
  const inOwned = new Set([...owned.values()].flatMap((g) => g.members.map((m) => m.campaignId)))

  const slotIds = [...new Set(ctx.slots.map((s) => s.campaignId))]
  const ids = [...new Set([...slotIds, ...inOwned])]
  const rows = ids.length
    ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, portfolioId: true, bidsSuppressedAt: true, bidsSuppressedBy: true, dynamicBidding: true } })
    : []
  const campaigns = new Map(rows.map((c) => [c.id, { id: c.id, name: c.name, status: String(c.status) }]))
  const bids = await loadBidStates(ids, rows)
  const heldBy = new Map<string, string>()
  const hold = (id: string, why: string) => { if (!heldBy.has(id)) heldBy.set(id, why) }

  if (slotIds.length) {
    // 1 — an hourly plan of its own, or a member of a group the playbook did not make (on or off: a save re-binds it).
    const schedules = await prisma.adSchedule.findMany({ where: { campaignId: { in: slotIds } }, select: { campaignId: true, name: true, groupId: true, group: { select: { name: true } } } })
    for (const s of schedules) {
      if (s.groupId && ownedIds.has(s.groupId)) continue
      hold(s.campaignId, s.group ? `the hourly plan "${s.group.name}"` : `its own hourly plan "${s.name}"`)
    }
    // 2 — a portfolio another group covers.
    const portfolioOf = new Map(rows.filter((c) => slotIds.includes(c.id) && c.portfolioId).map((c) => [c.id, c.portfolioId as string]))
    const portfolios = [...new Set(portfolioOf.values())]
    if (portfolios.length) {
      const scoped = await prisma.rankScheduleGroup.findMany({ where: { portfolioId: { in: portfolios }, ...(ownedIds.size ? { id: { notIn: [...ownedIds] } } : {}) }, select: { name: true, portfolioId: true } })
      for (const [id, pf] of portfolioOf) {
        const g = scoped.find((x) => x.portfolioId === pf)
        if (g) hold(id, `the hourly plan "${g.name}", which covers its portfolio`)
      }
    }
    // 3 — every enabled product rank plan, its campaigns resolved as the rank engine resolves them each run
    // (ad-rank-defend.job.ts rankDefendTick: resolveProductFamily by the family's ASINs in the plan's market, minus its
    // excluded campaigns; a plan over its maxCampaigns is not run). A plan that cannot be read holds every campaign.
    const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { productId: true, marketplace: true, excludeCampaignIds: true, maxCampaigns: true } })
    if (plans.length) {
      const { resolveProductFamily } = await import('../ads-dayparting-refresh.service.js')
      const slotSet = new Set(slotIds)
      for (const plan of plans) {
        try {
          const family = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
          const excluded = new Set(arr(plan.excludeCampaignIds).map(String))
          const governed = (family.campaigns ?? []).filter((c) => !excluded.has(c.id))
          if (plan.maxCampaigns != null && governed.length > plan.maxCampaigns) continue
          const words = `the product rank plan of ${family.parentName ? `"${family.parentName}"` : 'a product'}`
          for (const c of governed) if (slotSet.has(c.id)) hold(c.id, words)
        } catch {
          for (const id of slotIds) hold(id, 'a product rank plan whose campaigns could not be read just now')
        }
      }
    }
  }

  // 4 — bids an earlier hourly plan left on a campaign that joins a group now.
  const leftovers = new Map<string, string>()
  for (const id of slotIds) {
    const s = bids.get(id)
    if (!s || inOwned.has(id)) continue
    if (s.floored && isRankFloor(s.floorBy)) leftovers.set(id, 'bids an earlier hourly plan left at the floor')
    else if (s.deltaUp || s.deltaDown) leftovers.set(id, 'a base-bid change an earlier hourly plan made')
  }

  const names = ROLES.map((r) => rankGroupName(ctx.nameToken, ctx.market, r))
  const twins = new Set((await prisma.rankScheduleGroup.findMany({ where: { name: { in: names }, portfolioId: null, ...(ownedIds.size ? { id: { notIn: [...ownedIds] } } : {}) }, select: { name: true } })).map((g) => g.name))
  const { MARKET_TIME_ZONE } = await import('../ads-market-time.js')
  return { owned, campaigns, bids, heldBy, leftovers, twins, marketTimezone: MARKET_TIME_ZONE[ctx.market.toUpperCase()] ?? null }
}

// ── What a plan switched off does to bids (pure) ─────────────────────────────────────────────────────────────────────

/** What switching rank off on these campaigns does to their bids, by its real effect. */
export interface RankOffEffect {
  /** raise: a bid goes up (floors given back, or a base-bid change rank made downward undone); lower; same. */
  direction: 'raise' | 'lower' | 'same'
  /** Floored by rank: they stay at the floor, handed to whoever switches it off (keep). */
  heldAtFloor: Array<{ campaignId: string; name: string; bids: number }>
  /** Floored by rank: their remembered bids come back (giveBack) — a raise. */
  givenBack: Array<{ campaignId: string; name: string; bids: number }>
  /** Base-bid changes rank made downward: kept where they are (keep), or raised to their baseline (giveBack). */
  keptDown: number
  raisedBack: number
  /** Base-bid changes rank made upward: back to their baseline (lower). */
  loweredBack: number
  /** Top of search stays as last set (Owner S6): the ones above 0 %. */
  topOfSearch: Array<{ campaignId: string; name: string; pct: number }>
  /** The effect in words, for a summary. */
  words: string
}

/** The effect of switching rank off on these campaigns (pure; rank-release.service.ts decides the same way). */
export function classifyRankOff(facts: Pick<RankFacts, 'bids' | 'campaigns'>, campaignIds: readonly string[], floors: RankFloors = 'keep'): RankOffEffect {
  const e: RankOffEffect = { direction: 'same', heldAtFloor: [], givenBack: [], keptDown: 0, raisedBack: 0, loweredBack: 0, topOfSearch: [], words: '' }
  const nameOf = (id: string) => facts.campaigns.get(id)?.name ?? id
  for (const id of new Set(campaignIds)) {
    const s = facts.bids.get(id)
    if (!s) continue
    if (s.topPct > 0) e.topOfSearch.push({ campaignId: id, name: nameOf(id), pct: s.topPct })
    // A floor someone else set holds the campaign: the give-back leaves it, and its base-bid changes, alone.
    if (s.floored && !isRankFloor(s.floorBy)) continue
    if (s.floored && floors === 'keep') { e.heldAtFloor.push({ campaignId: id, name: nameOf(id), bids: s.flooredBids }); continue }
    if (s.floored) e.givenBack.push({ campaignId: id, name: nameOf(id), bids: s.flooredBids })
    if (floors === 'keep') e.keptDown += s.deltaUp
    else e.raisedBack += s.deltaUp
    e.loweredBack += s.deltaDown
  }
  e.direction = e.givenBack.length || e.raisedBack ? 'raise' : e.loweredBack ? 'lower' : 'same'
  const parts = [
    e.heldAtFloor.length ? `${quoted(e.heldAtFloor.map((c) => c.name))} stay${e.heldAtFloor.length === 1 ? 's' : ''} at the floor rank set (kept as the approver's floor; START gives the bids back)` : '',
    e.givenBack.length ? `${quoted(e.givenBack.map((c) => c.name))} get${e.givenBack.length === 1 ? 's' : ''} the bids rank floored back (a raise)` : '',
    e.keptDown ? `${plural(e.keptDown, 'bid')} rank lowered stay${e.keptDown === 1 ? 's' : ''} where ${e.keptDown === 1 ? 'it is' : 'they are'}` : '',
    e.raisedBack ? `${plural(e.raisedBack, 'bid')} rank lowered go${e.raisedBack === 1 ? 'es' : ''} back up to ${e.raisedBack === 1 ? 'its' : 'their'} earlier bid (a raise)` : '',
    e.loweredBack ? `${plural(e.loweredBack, 'bid')} rank raised go${e.loweredBack === 1 ? 'es' : ''} back down to ${e.loweredBack === 1 ? 'its' : 'their'} earlier bid` : '',
    `top of search stays as last set${e.topOfSearch.length ? ` (${e.topOfSearch.map((t) => `"${t.name}" ${t.pct}%`).join(', ')})` : ''}`,
  ]
  e.words = parts.filter(Boolean).join('; ')
  return e
}

/** PB-9: what switching these roles' plans off does to bids now (no writes); an off plan does nothing more. */
export async function rankOffEffect(ctx: ArtifactContext, roles: readonly RankRole[], floors: RankFloors = 'keep'): Promise<RankOffEffect> {
  const facts = await loadRankFacts(ctx)
  const ids = roles.flatMap((r) => { const g = facts.owned.get(r); return g?.enabled ? g.members.map((m) => m.campaignId) : [] })
  return classifyRankOff(facts, ids, floors)
}

// ── The plans ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A role's members from the slots — this product's linked, non-archived campaigns of the role — or why it is refused. */
function roleMembers(ctx: ArtifactContext, facts: RankFacts, role: RankRole): { members: string[]; overrideOf: Map<string, unknown>; refusal: string | null } {
  const nameOf = (id: string) => facts.campaigns.get(id)?.name ?? id
  const inOwned = new Set([...facts.owned.values()].flatMap((g) => g.members.map((m) => m.campaignId)))
  const plan = ctx.doc.rank.roles[role]
  // In the playbook's slot order, so every answer names its campaigns the same way.
  const order = new Map(ctx.doc.structure.slots.map((s, i) => [s.key, i]))
  const live = ctx.slots
    .filter((s) => s.rankRole === role && facts.campaigns.has(s.campaignId) && facts.campaigns.get(s.campaignId)!.status !== 'ARCHIVED')
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
  const members = [...new Set(live.map((s) => s.campaignId))]
  // The playbook's per-slot RankTarget overrides, by campaign (AdSchedule.targetOverrides).
  const overrideOf = new Map(live.filter((s) => plan?.slotOverrides?.[s.key]).map((s) => [s.campaignId, plan!.slotOverrides![s.key] as unknown]))
  const held = members.filter((id) => facts.heldBy.has(id))
  if (held.length) return { members, overrideOf, refusal: `${held.map((id) => `"${nameOf(id)}" is held by ${facts.heldBy.get(id)} — adopt it first`).join('; ')}. That plan is not touched.` }
  const left = members.filter((id) => facts.leftovers.has(id) && !inOwned.has(id))
  if (left.length) return { members, overrideOf, refusal: `${left.map((id) => `"${nameOf(id)}" still carries ${facts.leftovers.get(id)}`).join('; ')}: a person gives those bids back on the Hourly Bids list first (a plan saved switched off would give them back by itself).` }
  return { members, overrideOf, refusal: null }
}

/**
 * The compile of a build or an adopt (pure): per role with a plan, create its group switched off, or make the group the
 * playbook made follow the slots, or keep it — or refuse the role, by name. A group that is on takes no campaign in until
 * START (joining it now would start hourly bids on a campaign nobody started). In a build a campaign gone leaves at once
 * (what rank set on it kept: classifyRankOff); in an adopt, which changes Nexus only, it leaves a plan that is on only at
 * STOP. `pending` (a build's preview): the role's slots no campaign plays yet, named as the ones the build adds.
 */
export function planCompile(ctx: ArtifactContext, facts: RankFacts, opts: { pending?: boolean } = {}): RankStep[] {
  const steps: RankStep[] = []
  const linkedKeys = new Set(ctx.slots.map((s) => s.key))
  const nameOf = (id: string) => facts.campaigns.get(id)?.name ?? id
  for (const role of ROLES) {
    const key = rankKey(role)
    const plan = ctx.doc.rank.roles[role]
    const owned = facts.owned.get(role)
    if (!plan) {
      if (owned) steps.push({ role, key, does: 'report', refId: owned.groupId, summary: `The playbook has no ${role} plan any more: its hourly plan "${owned.name}" is left as it is.` })
      continue
    }
    const { members, overrideOf, refusal } = roleMembers(ctx, facts, role)
    const pending = opts.pending ? ctx.doc.structure.slots.filter((s) => s.rankRole === role && !linkedKeys.has(s.key)).map((s) => s.key) : []
    if (!members.length && !pending.length && !owned) continue
    const name = owned?.name ?? rankGroupName(ctx.nameToken, ctx.market, role)
    const refuse = (why: string) => steps.push({ role, key, does: 'report', refused: true, ...(owned ? { refId: owned.groupId } : {}), summary: `The ${role} campaigns get no hourly plan: ${why} Nothing of this role is written.` })
    if (refusal) { refuse(refusal); continue }
    const later = pending.length ? `, and the campaigns this build makes for ${pending.join(', ')}` : ''

    if (owned) {
      const now = owned.members.map((m) => m.campaignId)
      const added = members.filter((id) => !now.includes(id))
      const removed = now.filter((id) => !members.includes(id))
      const joins = owned.enabled ? [] : added
      const waits = owned.enabled ? added : []
      const waitWords = waits.length ? `${quoted(waits.map(nameOf))} join${waits.length === 1 ? 's' : ''} it at the next START (it is on: joining now would start hourly bids on ${waits.length === 1 ? 'it' : 'them'})` : ''
      // An adopt changes Nexus only: taking a campaign out of a plan that is on would change its bids at Amazon.
      if (ctx.mode === 'adopt' && owned.enabled && removed.length) {
        steps.push({
          role, key, does: 'report', refId: owned.groupId,
          summary: `The playbook's hourly plan "${name}" is on: ${quoted(removed.map(nameOf))} leave${removed.length === 1 ? 's' : ''} it at STOP — taking ${removed.length === 1 ? 'it' : 'them'} out now would change ${removed.length === 1 ? 'its' : 'their'} bids at Amazon, and an adopt changes Nexus only. Nothing of this plan is saved${waitWords ? `; ${waitWords}` : ''}.`,
        })
        continue
      }
      const next = [...members.filter((id) => now.includes(id)), ...joins]
      if (!joins.length && !removed.length) {
        const holds = next.length ? `holds its ${plural(next.length, `${role} campaign`)} already` : 'holds no campaign'
        steps.push({ role, key, does: 'keep', refId: owned.groupId, summary: `The playbook's hourly plan "${name}" ${holds}${later}: unchanged${waitWords ? `; ${waitWords}` : ''}.` })
        continue
      }
      const targetOverrides: Record<string, unknown> = Object.fromEntries(Object.entries(owned.targetOverrides).filter(([id]) => next.includes(id)))
      for (const id of joins) if (overrideOf.has(id)) targetOverrides[id] = overrideOf.get(id)
      const leaving = removed.length ? classifyRankOff(facts, owned.enabled ? removed : [], 'keep') : null
      steps.push({
        role, key, does: 'update', refId: owned.groupId,
        summary: `The playbook's hourly plan "${name}" follows its ${role} slots: `
          + [
            joins.length ? `${quoted(joins.map(nameOf))} join${joins.length === 1 ? 's' : ''} it` : '',
            removed.length ? `${quoted(removed.map(nameOf))} leave${removed.length === 1 ? 's' : ''} it${owned.enabled && leaving ? ` (${leaving.words})` : ''}` : '',
            waitWords,
          ].filter(Boolean).join('; ')
          + `${later}. Its name, hours, baseline and on/off (${owned.enabled ? 'on' : 'off'}) stay as they are.`,
        save: {
          id: owned.groupId, name: owned.name, marketplace: owned.marketplace ?? ctx.market, timezone: owned.timezone, windows: owned.windows,
          defaultTargetKey: owned.defaultTargetKey, targetOverrides, enabled: owned.enabled, campaignIds: next, portfolioId: null, userId: ctx.actor,
        },
        floors: 'keep',
        expect: { members: next, enabled: owned.enabled, windows: owned.windows, defaultTargetKey: owned.defaultTargetKey },
      })
      continue
    }
    const timezone = plan.timezone ?? facts.marketTimezone
    if (!timezone) { refuse(`no time zone is known for ${ctx.market}: set rank.roles.${role}.timezone in the playbook.`); continue }
    if (facts.twins.has(name)) { refuse(`an hourly plan named "${name}" exists already and is not this playbook's — it is not touched (rename it, or adopt it first).`); continue }
    const shape = `${plural(plan.windows.length, 'window')}, ${plan.baseline ? `"${plan.baseline}" outside them` : 'nothing outside them'}, ${timezone}`
    if (!members.length) {
      steps.push({ role, key, does: 'create', summary: `Creates the hourly plan "${name}" for the campaigns this build makes for ${pending.join(', ')} (${shape}), switched OFF with its campaigns: nothing runs until START.` })
      continue
    }
    steps.push({
      role, key, does: 'create',
      summary: `Creates the hourly plan "${name}" for the ${role} campaigns ${quoted(members.map(nameOf))}${later} (${shape}), switched OFF with its campaigns: nothing runs until START.`,
      save: {
        name, marketplace: ctx.market, timezone, windows: plan.windows, defaultTargetKey: plan.baseline,
        targetOverrides: Object.fromEntries(overrideOf), enabled: false, campaignIds: members, portfolioId: null, userId: ctx.actor,
      },
      floors: 'keep',
      expect: { members, enabled: false, windows: plan.windows, defaultTargetKey: plan.baseline },
    })
  }
  return steps
}

/**
 * What a switch asks of one role's group: on or off, (optionally) the hours of the playbook's full or light plan, what a
 * switch-off does with what rank set (default keep), and a note for the summary.
 */
export interface RankSwitch { enabled: boolean; plan?: 'full' | 'light'; floors?: RankFloors; note?: string }

/**
 * A switch of the groups the playbook made (pure): START, STOP, a phase. A role with no group yet is named (a build or an
 * adopt compiles it). `follow` (START): a group switched on takes its members from the slots again (the campaigns that
 * waited join, one gone leaves), refused by name as a compile is. Switching on is refused for a group a campaign of
 * which another plan holds now; switching off never is.
 */
export function planSwitch(ctx: ArtifactContext, facts: RankFacts, desired: Partial<Record<RankRole, RankSwitch>>, opts: { follow?: boolean } = {}): RankStep[] {
  const steps: RankStep[] = []
  const nameOf = (id: string) => facts.campaigns.get(id)?.name ?? id
  for (const role of ROLES) {
    const want = desired[role]
    if (!want) continue
    const key = rankKey(role)
    const owned = facts.owned.get(role)
    const note = want.note ? `: ${want.note}` : ''
    if (!owned) {
      if (ctx.doc.rank.roles[role] && ctx.slots.some((s) => s.rankRole === role)) steps.push({ role, key, does: 'report', summary: `No hourly plan for the ${role} campaigns yet: a build or an adopt compiles it first.` })
      continue
    }
    const notOn = (why: string) => steps.push({ role, key, does: 'report', refused: true, refId: owned.groupId, summary: `"${owned.name}" is not switched on: ${why}` })
    let windows = owned.windows
    let baseline = owned.defaultTargetKey
    if (want.plan) {
      const p = ctx.doc.rank.roles[role]
      const chosen = want.plan === 'light' ? p?.light : p
      if (!chosen) { steps.push({ role, key, does: 'report', refused: true, refId: owned.groupId, summary: `The playbook has no ${want.plan === 'light' ? 'light ' : ''}${role} plan: "${owned.name}" is left as it is.` }); continue }
      windows = chosen.windows
      baseline = chosen.baseline
    }
    const now = owned.members.map((m) => m.campaignId)
    let members = now
    let targetOverrides = owned.targetOverrides
    const follow = !!(want.enabled && opts.follow && ctx.doc.rank.roles[role])
    if (follow) {
      const m = roleMembers(ctx, facts, role)
      if (m.refusal) { notOn(m.refusal); continue }
      members = m.members
      targetOverrides = Object.fromEntries(Object.entries(owned.targetOverrides).filter(([id]) => members.includes(id)))
      for (const id of members) if (!now.includes(id) && m.overrideOf.has(id)) targetOverrides[id] = m.overrideOf.get(id)
    } else if (want.enabled) {
      const held = now.filter((id) => facts.heldBy.has(id))
      if (held.length) { notOn(`${held.map((id) => `"${nameOf(id)}" is held by ${facts.heldBy.get(id)}`).join('; ')}.`); continue }
    }
    const rewrites = !same(windows, owned.windows) || (baseline ?? null) !== (owned.defaultTargetKey ?? null)
    const flips = want.enabled !== owned.enabled || owned.members.some((m) => m.enabled !== want.enabled)
    const moves = !sameSet(members, now)
    if (!rewrites && !flips && !moves) {
      steps.push({ role, key, does: 'keep', refId: owned.groupId, summary: `The playbook's hourly plan "${owned.name}" is ${owned.enabled ? 'on' : 'off'} already${note}.` })
      continue
    }
    const floors = want.floors ?? 'keep'
    const joined = members.filter((id) => !now.includes(id))
    const left = now.filter((id) => !members.includes(id))
    // What rank set comes into play only where the plan held the campaigns: switched off from on, or taken out of it.
    const off = owned.enabled ? classifyRankOff(facts, want.enabled ? left : now, floors) : null
    const hours = rewrites ? `, with the hours of the playbook's ${want.plan === 'light' ? 'light ' : ''}${role} plan (${plural(windows.length, 'window')}; hours set on Hourly Bids since are replaced)` : ''
    const moved = [joined.length ? `${quoted(joined.map(nameOf))} join${joined.length === 1 ? 's' : ''} it` : '', left.length ? `${quoted(left.map(nameOf))} leave${left.length === 1 ? 's' : ''} it` : ''].filter(Boolean).join('; ')
    steps.push({
      role, key, refId: owned.groupId,
      does: want.enabled !== owned.enabled ? (want.enabled ? 'enable' : 'disable') : 'update',
      summary: (want.enabled !== owned.enabled
        ? `${want.enabled ? 'Switches on' : 'Switches off'} the playbook's hourly plan "${owned.name}" (${plural(members.length, 'campaign')})`
        : `The playbook's hourly plan "${owned.name}" (${plural(members.length, 'campaign')}) stays ${want.enabled ? 'on' : 'off'}`)
        + `${hours}${moved ? `; ${moved}` : ''}${off && (!want.enabled || left.length) ? `; ${off.words}` : ''}${note}.`,
      save: {
        id: owned.groupId, name: owned.name, marketplace: owned.marketplace ?? ctx.market, timezone: owned.timezone, windows, defaultTargetKey: baseline,
        targetOverrides, enabled: want.enabled, campaignIds: members, portfolioId: null, userId: ctx.actor,
      },
      liveMembers: !follow,
      floors,
      expect: { members, enabled: want.enabled, windows, defaultTargetKey: baseline },
    })
  }
  return steps
}

// ── The writes ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A saved group read back: on/off, members, hours, each member's schedule. Problems in words; [] when it reads as saved. */
async function readBack(groupId: string, want: NonNullable<RankStep['expect']>, name: string): Promise<string[]> {
  const g = await prisma.rankScheduleGroup.findUnique({ where: { id: groupId }, select: { enabled: true, windows: true, defaultTargetKey: true } })
  if (!g) return [`read-back: "${name}" is not there after it was saved`]
  const rows = await prisma.adSchedule.findMany({ where: { groupId }, select: { campaignId: true, enabled: true, windows: true } })
  const problems: string[] = []
  if (g.enabled !== want.enabled) problems.push(`"${name}" reads back ${g.enabled ? 'on' : 'off'}, not ${want.enabled ? 'on' : 'off'}`)
  const got = new Set(rows.map((r) => r.campaignId))
  if (got.size !== want.members.length || want.members.some((id) => !got.has(id))) problems.push(`"${name}" reads back with ${plural(got.size, 'campaign')}, not the ${want.members.length} it was saved with`)
  const off = rows.filter((r) => r.enabled !== want.enabled).length
  if (off) problems.push(`${plural(off, 'campaign')} of "${name}" read${off === 1 ? 's' : ''} back ${want.enabled ? 'off' : 'on'}`)
  if (!same(g.windows, want.windows) || (g.defaultTargetKey ?? null) !== (want.defaultTargetKey ?? null) || rows.some((r) => !same(r.windows, want.windows))) problems.push(`the hours of "${name}" read back differently from what was saved`)
  return problems.map((p) => `read-back: ${p}`)
}

/**
 * Before a save that switches campaigns off or takes them out (the writer then gives back what rank set): rank's floors
 * are handed to `actor` — they stay at the floor, remembered, and START gives them back — and a base-bid change rank made
 * downward on a campaign with no floor lets go of its baseline, so the give-back leaves that bid where it is. Nexus only.
 */
async function keepRankBids(campaignIds: string[], actor: string): Promise<{ handed: number; keptDown: number }> {
  if (!campaignIds.length) return { handed: 0, keptDown: 0 }
  const handed = (await prisma.campaign.updateMany({
    where: { id: { in: campaignIds }, bidsSuppressedAt: { not: null }, OR: [{ bidsSuppressedBy: null }, { bidsSuppressedBy: '' }, ...RANK_FLOOR_PREFIXES.map((p) => ({ bidsSuppressedBy: { startsWith: p } }))] },
    data: { bidsSuppressedBy: actor },
  })).count
  const free = (await prisma.campaign.findMany({ where: { id: { in: campaignIds }, bidsSuppressedAt: null }, select: { id: true } })).map((c) => c.id)
  let keptDown = 0
  if (free.length) {
    const [groups, targets] = await Promise.all([
      prisma.adGroup.findMany({ where: { campaignId: { in: free }, bidsSuppressedAt: null, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true, defaultBidCents: true } }),
      prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: free }, bidsSuppressedAt: null }, baseBidFromCents: { not: null } }, select: { id: true, baseBidFromCents: true, bidCents: true } }),
    ])
    const upGroups = groups.filter((g) => (g.baseBidFromCents as number) > g.defaultBidCents).map((g) => g.id)
    const upTargets = targets.filter((t) => (t.baseBidFromCents as number) > t.bidCents).map((t) => t.id)
    if (upGroups.length) keptDown += (await prisma.adGroup.updateMany({ where: { id: { in: upGroups } }, data: { baseBidFromCents: null } })).count
    if (upTargets.length) keptDown += (await prisma.adTarget.updateMany({ where: { id: { in: upTargets } }, data: { baseBidFromCents: null } })).count
  }
  if (handed || keptDown) logger.info('[PB-8] rank bids kept before a playbook hourly plan lets go of them', { campaigns: campaignIds.length, handed, keptDown, actor })
  return { handed, keptDown }
}

/**
 * Run the steps: each save through the Hourly Bids writer, ownership checked again just before it, then read back. A
 * role that fails never stops the next. Exported for the tests.
 */
export async function runRankSteps(ctx: ArtifactContext, facts: RankFacts, steps: RankStep[]): Promise<{ links: ArtifactLink[]; changed: string[]; errors: string[] }> {
  const links: ArtifactLink[] = []
  const changed: string[] = []
  const errors: string[] = []
  const ownedIds = new Set([...facts.owned.values()].map((g) => g.groupId))
  const { saveRankScheduleGroup } = steps.some((s) => s.save) ? await import('../ads-create.service.js') : { saveRankScheduleGroup: null }
  for (const step of steps) {
    if (step.refused) { errors.push(step.summary); continue }
    if (!step.save) { if (step.refId && step.does === 'keep') links.push({ key: step.key, refId: step.refId }); continue }
    const name = step.save.name
    try {
      let id = step.save.id ?? null
      if (id) {
        // Still this playbook's: its link names this group.
        const link = await prisma.adsPlaybookLink.findFirst({ where: { playbookId: ctx.playbookId, kind: RANK_GROUP_KIND, key: step.key, origin: 'built' }, select: { refId: true } })
        if (link?.refId !== id) { errors.push(`the ${step.role} hourly plan "${name}" is no longer this playbook's: not saved`); continue }
      } else {
        // Created first, then saved by its id: the writer never takes over a group of the same name.
        const twin = await prisma.rankScheduleGroup.findFirst({ where: { name, portfolioId: null }, select: { id: true } })
        if (twin) { errors.push(`an hourly plan named "${name}" exists already and is not this playbook's — it is not touched, and the ${step.role} campaigns get no plan`); continue }
        const s = step.save
        id = (await prisma.rankScheduleGroup.create({
          data: { name, marketplace: s.marketplace ?? null, timezone: s.timezone, windows: s.windows as never, defaultTargetKey: s.defaultTargetKey ?? null, targetOverrides: (s.targetOverrides ?? {}) as never, enabled: false, portfolioId: null, createdBy: s.userId ?? null },
          select: { id: true },
        })).id
        ownedIds.add(id)
      }
      const live = (await prisma.adSchedule.findMany({ where: { groupId: id }, select: { campaignId: true } })).map((r) => r.campaignId)
      // A switch keeps the members the group has now; a compile or START saves the slots' campaigns.
      const campaignIds = step.liveMembers ? live : step.save.campaignIds
      const joining = campaignIds.filter((c) => !live.includes(c))
      if (joining.length) {
        const taken = await prisma.adSchedule.findMany({ where: { campaignId: { in: joining }, OR: [{ groupId: null }, { groupId: { notIn: [...ownedIds] } }] }, select: { campaignId: true } })
        if (taken.length) { errors.push(`the ${step.role} hourly plan "${name}" was not saved: ${plural(taken.length, 'campaign')} it would take in another hourly plan holds since this was read`); continue }
      }
      const leaving = live.filter((c) => !campaignIds.includes(c))
      if (step.floors !== 'giveBack') await keepRankBids(step.save.enabled === false ? [...campaignIds, ...leaving] : leaving, ctx.actor)
      const saved = await saveRankScheduleGroup!({ ...step.save, id, campaignIds })
      links.push({ key: step.key, refId: saved.id })
      changed.push(step.summary)
      errors.push(...await readBack(saved.id, { ...step.expect!, members: campaignIds }, name))
      if (saved.release && (saved.release.restored || saved.release.deferred || saved.release.failed)) {
        logger.info('[PB-8] a playbook hourly plan gave bids back', { groupId: saved.id, restored: saved.release.restored, deferred: saved.release.deferred, failed: saved.release.failed })
      }
    } catch (e) {
      errors.push(`the ${step.role} hourly plan "${name}" was not saved: ${(e as Error).message.slice(0, 200)}`)
    }
  }
  return { links, changed, errors }
}

// ── START, STOP, a phase ─────────────────────────────────────────────────────────────────────────────────────────────

/** The product's phase (its strategy's goal) and that phase's rank states; an error when the strategy cannot be read. */
async function phaseRank(ctx: ArtifactContext): Promise<{ phase: string | null; rank: RankPhaseStates } | { error: string }> {
  try {
    const { openStrategy } = await import('../ads-strategy/effective.js')
    const view = await openStrategy(ctx.market)
    const goal = (await view.forProducts([ctx.productId])).resolved.fields.get('goal')?.value
    const phase = typeof goal === 'string' && goal ? goal : null
    return { phase, rank: (phase ? ctx.doc.phases[phase as Phase]?.rank : undefined) ?? {} }
  } catch (e) {
    return { error: `the product's phase could not be read (${(e as Error).message.slice(0, 120)}): its hourly plans stay off` }
  }
}

const NO_PHASE = "no phase is set for this product (its ads strategy's goal), and performance needs one: research goes on alone"

/**
 * START: each role as the phase runs it (a role it does not name: on, with the hours it has). With no phase set only
 * research goes on: performance holds top of search all out and needs a goal.
 */
const startSwitches = (phase: string | null, rank: RankPhaseStates): Partial<Record<RankRole, RankSwitch>> => {
  if (!phase) return { performance: { enabled: false, note: NO_PHASE }, research: { enabled: true } }
  return Object.fromEntries(ROLES.map((r) => [r, rank[r] === 'off' ? { enabled: false } : rank[r] === 'light' ? { enabled: true, plan: 'light' as const } : { enabled: true }]))
}
const allOff = (): Partial<Record<RankRole, RankSwitch>> => Object.fromEntries(ROLES.map((r) => [r, { enabled: false }]))

/** A phase's switches: off; on / light with the playbook's hours — switched on only once the playbook runs (START). */
const phaseSwitches = (rank: RankPhaseStates, running: boolean, floors: RankFloors): Partial<Record<RankRole, RankSwitch>> =>
  Object.fromEntries(ROLES.filter((r) => rank[r]).map((r) => [r, rank[r] === 'off' ? { enabled: false, floors } : { enabled: running, floors, plan: rank[r] === 'light' ? 'light' as const : 'full' as const }]))

const linesOf = (steps: RankStep[]): ArtifactPreviewLine[] =>
  steps.map((s) => ({ kind: RANK_GROUP_KIND, key: s.key, does: s.does, summary: s.summary, ...(s.refId ? { refId: s.refId } : {}) }))

async function isRunning(playbookId: string): Promise<boolean> {
  return (await prisma.adsPlaybook.findUnique({ where: { id: playbookId }, select: { state: true } }))?.state === 'RUNNING'
}

/**
 * PB-9: what a phase switch does to the playbook's hourly plans (no writes). Before START, on and light keep them off.
 * `floors` (default keep): what a role switched off does with what rank set — rankOffEffect counts it.
 */
export async function previewRankPhase(ctx: ArtifactContext, rank: RankPhaseStates, opts: { floors?: RankFloors } = {}): Promise<ArtifactPreviewLine[]> {
  const running = await isRunning(ctx.playbookId)
  const steps = planSwitch(ctx, await loadRankFacts(ctx), phaseSwitches(rank, running, opts.floors ?? 'keep'))
  return linesOf(steps).map((l) => (running || l.does === 'disable' || l.does === 'keep' || l.does === 'report' ? l : { ...l, summary: `${l.summary} Kept off until START.` }))
}

/** PB-9: switch the playbook's hourly plans to a phase's rank states (off / on / light per role); read back. */
export async function applyRankPhase(ctx: ArtifactContext, rank: RankPhaseStates, opts: { floors?: RankFloors } = {}): Promise<{ changed: string[]; errors: string[] }> {
  const facts = await loadRankFacts(ctx)
  const { changed, errors } = await runRankSteps(ctx, facts, planSwitch(ctx, facts, phaseSwitches(rank, await isRunning(ctx.playbookId), opts.floors ?? 'keep')))
  return { changed, errors }
}

const HOURS_NOTE = 'A re-save keeps a plan\'s hours as they are (a person paints them on Hourly Bids): sync never rewrites them. They are set back on Hourly Bids, by a phase switch, or kept as the playbook\'s own (keep).'
const ON_MEMBERS_NOTE = 'The plan is on: a campaign joins it only at START and leaves it only at STOP, so a re-save does not change its members now.'

/**
 * PB-10 — each role's group as the playbook compiles it, against the group the playbook made (drift; no writes): its
 * members (this product's linked campaigns of the role), and its hours and baseline (the phase's plan: full, or light).
 * Only the playbook's own groups are compared. A role a campaign of which the Owner's own hourly plan holds (or another
 * plan, or bids an earlier plan left) is not compared, and each such campaign is named as held: his plans are never
 * drift. `changedBy`: the plan's last version a person saved after the playbook last saved it.
 */
async function rankExpected(ctx: ArtifactContext): Promise<ArtifactExpectation[]> {
  const facts = await loadRankFacts(ctx)
  const phase = await phaseRank(ctx)
  const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: ctx.playbookId, kind: RANK_GROUP_KIND, origin: 'built' }, select: { key: true, updatedAt: true } })
  const savedAt = new Map(links.map((l) => [l.key, l.updatedAt]))
  const out: ArtifactExpectation[] = []
  for (const role of ROLES) {
    const plan = ctx.doc.rank.roles[role]
    if (!plan) continue
    const key = rankKey(role)
    const owned = facts.owned.get(role)
    const { members, refusal } = roleMembers(ctx, facts, role)
    const held = members.filter((id) => facts.heldBy.has(id)).map((id) => ({ campaignId: id, name: facts.campaigns.get(id)?.name ?? id, by: facts.heldBy.get(id)! }))
    if (refusal) {
      out.push({
        key, refId: owned?.groupId ?? null, parts: {},
        unknown: held.length ? `the ${role} plan is not compared: ${plural(held.length, 'campaign')} of it ${held.length === 1 ? 'is' : 'are'} held by an hourly plan the playbook did not make (the Owner's own) — never drift` : `the ${role} plan is not compared: ${refusal}`,
        ...(held.length ? { held } : {}),
      })
      continue
    }
    if (!members.length && !owned) continue
    const parts: ArtifactExpectation['parts'] = {
      members: { expected: [...members].sort(), actual: owned ? owned.members.map((m) => m.campaignId).sort() : null, ...(owned?.enabled ? { resave: false, note: ON_MEMBERS_NOTE } : {}) },
    }
    let changedBy: ArtifactExpectation['changedBy']
    if (owned && !('error' in phase)) {
      const hours = phase.rank[role] === 'light' && plan.light ? plan.light : plan
      parts.windows = { expected: hours.windows, actual: owned.windows, resave: false, note: HOURS_NOTE }
      parts.baseline = { expected: hours.baseline, actual: owned.defaultTargetKey, resave: false, note: HOURS_NOTE }
      const since = savedAt.get(key)
      const v = await prisma.rankScheduleVersion.findFirst({ where: { groupId: owned.groupId, changedBy: { startsWith: 'user:' }, ...(since ? { createdAt: { gt: since } } : {}) }, orderBy: { createdAt: 'desc' }, select: { changedBy: true, createdAt: true } })
      if (v?.changedBy) changedBy = { userId: v.changedBy, at: v.createdAt.toISOString(), action: 'save_rank_schedule_group' }
    }
    out.push({ key, refId: owned?.groupId ?? null, parts, ...(changedBy ? { changedBy } : {}) })
  }
  return out
}

/** The playbook's hourly plans on the artifacts hook (artifacts.ts ARTIFACT_COMPILERS). */
export const rankGroupCompiler: ArtifactCompiler = {
  kind: RANK_GROUP_KIND,
  async preview(ctx) {
    const facts = await loadRankFacts(ctx)
    if (ctx.mode === 'build' || ctx.mode === 'adopt') return linesOf(planCompile(ctx, facts, { pending: ctx.mode === 'build' }))
    if (ctx.mode === 'stop') return linesOf(planSwitch(ctx, facts, allOff()))
    const phase = await phaseRank(ctx)
    if ('error' in phase) return [{ kind: RANK_GROUP_KIND, key: 'rank', does: 'report', summary: `Not switched on: ${phase.error}.` }]
    return linesOf(planSwitch(ctx, facts, startSwitches(phase.phase, phase.rank), { follow: true }))
  },
  async compile(ctx) {
    if (ctx.mode !== 'build' && ctx.mode !== 'adopt') return { links: [], errors: [] }
    const facts = await loadRankFacts(ctx)
    const { links, errors } = await runRankSteps(ctx, facts, planCompile(ctx, facts))
    return { links, errors }
  },
  async setEnabled(ctx, _links, enabled) {
    const facts = await loadRankFacts(ctx)
    if (!enabled) {
      const { changed, errors } = await runRankSteps(ctx, facts, planSwitch(ctx, facts, allOff()))
      return { changed, errors }
    }
    // START fails closed: a phase that cannot be read switches nothing on.
    const phase = await phaseRank(ctx)
    if ('error' in phase) return { changed: [], errors: [phase.error] }
    const { changed, errors } = await runRankSteps(ctx, facts, planSwitch(ctx, facts, startSwitches(phase.phase, phase.rank), { follow: true }))
    return { changed, errors }
  },
  expected: rankExpected,
}
