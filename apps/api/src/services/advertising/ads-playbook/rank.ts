/**
 * ADS PLAYBOOK PB-8 — the playbook's rank roles compiled into hourly bid plans (design report 9 §3.6, §5.2; PB-5 spec
 * §4): ONE RankScheduleGroup per rank role (performance, research) with an EXPLICIT member list — this product's linked
 * campaigns of that role, never a portfolio scope — saved through the Hourly Bids page's own writer
 * (ads-create.service.ts saveRankScheduleGroup). The engine is unchanged: rank-defend runs the members' AdSchedule rows.
 *
 *   build / adopt  each role's group is created SWITCHED OFF, its member schedules too: nothing runs until START. A group
 *                  the playbook made already (its AdsPlaybookLink rankGroup, origin built) only follows the slots — a
 *                  campaign gone leaves it, a new one joins it while it is off (one that is on takes a new campaign only
 *                  at START) — and keeps its name, hours, baseline and on/off as they are.
 *   start / stop   START switches the playbook's groups on as the product's phase says (the strategy's goal: a role the
 *                  phase runs `off` stays off, `light` gets the role's light plan), its members the slots' campaigns again;
 *                  a phase that cannot be read switches nothing on. STOP switches them off.
 *   phase          `applyRankPhase` (PB-9 calls it; `previewRankPhase` is its preview): off / on / light per role; on and
 *                  light write the hours from the playbook; before START a group is never switched on.
 *
 * THE OWNER'S HOURLY PLANS ARE HIS OWN. The group writer re-binds every member's schedule to the group it saves and
 * overwrites its hours (design risk 6), and saved without an id it takes over a group of the same name. So a role is
 * REFUSED by name, and nothing of it is written, when one of its campaigns
 *   · has an hourly plan the playbook did not make — a member of another group, or a schedule of its own (on or off);
 *   · sits in a portfolio another group covers (a portfolio-scoped group pulls it in on its next save);
 *   · is held by an enabled product rank plan of this product;
 *   · still carries bids an earlier hourly plan left (a floor, a base-bid change): a plan saved switched off gives those
 *     back by itself, and on a live campaign only a person does that (Owner, 2026-10-04);
 * or when a group the playbook did not make already has the name it would get. Adopting the Owner's groups is a
 * production step on his word, never this compiler's.
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
import type { ArtifactCompiler, ArtifactContext, ArtifactLink, ArtifactPreviewLine } from './artifacts.js'
import type { Phase, RankRole } from './doc.js'

export const RANK_GROUP_KIND = 'rankGroup' as const
const ROLES: readonly RankRole[] = ['performance', 'research']
const ROLE_WORD: Record<RankRole, string> = { performance: 'Performance', research: 'Research' }

/** The artifact key of a role's group ('rank:performance'). */
export const rankKey = (role: RankRole) => `rank:${role}`
const roleOfKey = (key: string): RankRole | null => ROLES.find((r) => rankKey(r) === key) ?? null

/** The name a role's group is created with (a group the playbook made keeps whatever name it has since). */
export const rankGroupName = (nameToken: string, market: string, role: RankRole) => `${nameToken} | ${market} | Playbook ${ROLE_WORD[role]}`

/** A phase's rank state per role (doc.ts PHASE.rank). */
export type RankPhaseStates = Partial<Record<RankRole, 'off' | 'on' | 'light'>>

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

/** What a compile or a switch decides on, read once (no writes). */
export interface RankFacts {
  owned: Map<RankRole, OwnedRankGroup>
  campaigns: Map<string, { id: string; name: string; status: string }>
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
    ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, portfolioId: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
    : []
  const campaigns = new Map(rows.map((c) => [c.id, { id: c.id, name: c.name, status: String(c.status) }]))
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
    // 3 — an enabled product rank plan of this product (it holds the family's campaigns but those it excludes).
    const product = await prisma.product.findUnique({ where: { id: ctx.productId }, select: { parentId: true } })
    const family = [ctx.productId, ...(product?.parentId ? [product.parentId] : [])]
    const plans = await prisma.productRankPlan.findMany({ where: { enabled: true, marketplace: ctx.market, productId: { in: family } }, select: { excludeCampaignIds: true } })
    for (const p of plans) {
      const excluded = new Set(arr(p.excludeCampaignIds).map(String))
      for (const id of slotIds) if (!excluded.has(id)) hold(id, 'the product rank plan of this product')
    }
  }

  // 4 — bids an earlier hourly plan left on a campaign that joins a group now.
  const leftovers = new Map<string, string>()
  const joining = slotIds.filter((id) => !inOwned.has(id))
  if (joining.length) {
    const { isRankOwnedFloor } = await import('../rank-release.service.js')
    for (const c of rows) {
      if (joining.includes(c.id) && c.bidsSuppressedAt && isRankOwnedFloor(c.bidsSuppressedBy)) leftovers.set(c.id, 'bids an earlier hourly plan left at the floor')
    }
    const [g, t] = await Promise.all([
      prisma.adGroup.findMany({ where: { campaignId: { in: joining }, baseBidFromCents: { not: null } }, select: { campaignId: true } }),
      prisma.adTarget.findMany({ where: { adGroup: { campaignId: { in: joining } }, baseBidFromCents: { not: null } }, select: { adGroup: { select: { campaignId: true } } } }),
    ])
    for (const id of [...g.map((x) => x.campaignId), ...t.map((x) => x.adGroup.campaignId)]) if (!leftovers.has(id)) leftovers.set(id, 'a base-bid change an earlier hourly plan made')
  }

  const names = ROLES.map((r) => rankGroupName(ctx.nameToken, ctx.market, r))
  const twins = new Set((await prisma.rankScheduleGroup.findMany({ where: { name: { in: names }, portfolioId: null, ...(ownedIds.size ? { id: { notIn: [...ownedIds] } } : {}) }, select: { name: true } })).map((g) => g.name))
  const { MARKET_TIME_ZONE } = await import('../ads-market-time.js')
  return { owned, campaigns, heldBy, leftovers, twins, marketTimezone: MARKET_TIME_ZONE[ctx.market.toUpperCase()] ?? null }
}

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

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))

/**
 * The compile of a build or an adopt (pure): per role with a plan, create its group switched off, or make the group the
 * playbook made follow the slots, or keep it — or refuse the role, by name. A group that is on takes no campaign in until
 * START (joining it now would start hourly bids on a campaign nobody started); one that leaves it leaves at once.
 * `pending` (a build's preview): the role's slots no campaign plays yet, named as the ones the build adds.
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
      const next = [...members.filter((id) => now.includes(id)), ...joins]
      const waitWords = waits.length ? `${quoted(waits.map(nameOf))} join${waits.length === 1 ? 's' : ''} it at the next START (it is on: joining now would start hourly bids on ${waits.length === 1 ? 'it' : 'them'})` : ''
      if (!joins.length && !removed.length) {
        const holds = next.length ? `holds its ${plural(next.length, `${role} campaign`)} already` : 'holds no campaign'
        steps.push({ role, key, does: 'keep', refId: owned.groupId, summary: `The playbook's hourly plan "${name}" ${holds}${later}: unchanged${waitWords ? `; ${waitWords}` : ''}.` })
        continue
      }
      const targetOverrides: Record<string, unknown> = Object.fromEntries(Object.entries(owned.targetOverrides).filter(([id]) => next.includes(id)))
      for (const id of joins) if (overrideOf.has(id)) targetOverrides[id] = overrideOf.get(id)
      steps.push({
        role, key, does: 'update', refId: owned.groupId,
        summary: `The playbook's hourly plan "${name}" follows its ${role} slots: `
          + [
            joins.length ? `${quoted(joins.map(nameOf))} join${joins.length === 1 ? 's' : ''} it` : '',
            removed.length ? `${quoted(removed.map(nameOf))} leave${removed.length === 1 ? 's' : ''} it${owned.enabled ? ' (what it floored on them is given back)' : ''}` : '',
            waitWords,
          ].filter(Boolean).join('; ')
          + `${later}. Its name, hours, baseline and on/off (${owned.enabled ? 'on' : 'off'}) stay as they are.`,
        save: {
          id: owned.groupId, name: owned.name, marketplace: owned.marketplace ?? ctx.market, timezone: owned.timezone, windows: owned.windows,
          defaultTargetKey: owned.defaultTargetKey, targetOverrides, enabled: owned.enabled, campaignIds: next, portfolioId: null, userId: ctx.actor,
        },
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
      expect: { members, enabled: false, windows: plan.windows, defaultTargetKey: plan.baseline },
    })
  }
  return steps
}

/** What a switch asks of one role's group: on or off, and (optionally) the hours of the playbook's full or light plan. */
export interface RankSwitch { enabled: boolean; plan?: 'full' | 'light' }

/**
 * A switch of the groups the playbook made (pure): START, STOP, a phase. A role with no group yet is named (a build or an
 * adopt compiles it). `follow` (START): a group switched on takes its members from the slots again (the campaigns that
 * waited join), refused by name as a compile is. Switching on is refused for a group a campaign of which another plan
 * holds now; switching off never is.
 */
export function planSwitch(ctx: ArtifactContext, facts: RankFacts, desired: Partial<Record<RankRole, RankSwitch>>, opts: { follow?: boolean } = {}): RankStep[] {
  const steps: RankStep[] = []
  const nameOf = (id: string) => facts.campaigns.get(id)?.name ?? id
  for (const role of ROLES) {
    const want = desired[role]
    if (!want) continue
    const key = rankKey(role)
    const owned = facts.owned.get(role)
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
    if (want.enabled && opts.follow && ctx.doc.rank.roles[role]) {
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
      steps.push({ role, key, does: 'keep', refId: owned.groupId, summary: `The playbook's hourly plan "${owned.name}" is ${owned.enabled ? 'on' : 'off'} already.` })
      continue
    }
    const joined = members.filter((id) => !now.includes(id))
    const left = now.filter((id) => !members.includes(id))
    const hours = rewrites ? `, with the hours of the playbook's ${want.plan === 'light' ? 'light ' : ''}${role} plan (${plural(windows.length, 'window')}; hours set on Hourly Bids since are replaced)` : ''
    const moved = [joined.length ? `${quoted(joined.map(nameOf))} join${joined.length === 1 ? 's' : ''} it` : '', left.length ? `${quoted(left.map(nameOf))} leave${left.length === 1 ? 's' : ''} it` : ''].filter(Boolean).join('; ')
    steps.push({
      role, key, refId: owned.groupId,
      does: want.enabled !== owned.enabled ? (want.enabled ? 'enable' : 'disable') : 'update',
      summary: (want.enabled !== owned.enabled
        ? `${want.enabled ? 'Switches on' : 'Switches off'} the playbook's hourly plan "${owned.name}" (${plural(members.length, 'campaign')})`
        : `The playbook's hourly plan "${owned.name}" (${plural(members.length, 'campaign')}) stays ${want.enabled ? 'on' : 'off'}`)
        + `${hours}${moved ? `; ${moved}` : ''}${!want.enabled && owned.enabled ? '; what it floored on them is given back' : ''}.`,
      save: {
        id: owned.groupId, name: owned.name, marketplace: owned.marketplace ?? ctx.market, timezone: owned.timezone, windows, defaultTargetKey: baseline,
        targetOverrides, enabled: want.enabled, campaignIds: members, portfolioId: null, userId: ctx.actor,
      },
      expect: { members, enabled: want.enabled, windows, defaultTargetKey: baseline },
    })
  }
  return steps
}

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

/** Run the steps: each save through the Hourly Bids writer, then read back. A role that fails never stops the next. */
async function runSteps(steps: RankStep[]): Promise<{ links: ArtifactLink[]; changed: string[]; errors: string[] }> {
  const links: ArtifactLink[] = []
  const changed: string[] = []
  const errors: string[] = []
  const saving = steps.filter((s) => s.save)
  const { saveRankScheduleGroup } = saving.length ? await import('../ads-create.service.js') : { saveRankScheduleGroup: null }
  for (const step of steps) {
    if (step.refused) { errors.push(step.summary); continue }
    if (!step.save) { if (step.refId && step.does === 'keep') links.push({ key: step.key, refId: step.refId }); continue }
    try {
      const saved = await saveRankScheduleGroup!(step.save)
      links.push({ key: step.key, refId: saved.id })
      changed.push(step.summary)
      errors.push(...await readBack(saved.id, step.expect!, step.save.name))
      if (saved.release && (saved.release.restored || saved.release.deferred || saved.release.failed)) {
        logger.info('[PB-8] a playbook hourly plan gave bids back', { groupId: saved.id, restored: saved.release.restored, deferred: saved.release.deferred, failed: saved.release.failed })
      }
    } catch (e) {
      errors.push(`the ${step.role} hourly plan "${step.save.name}" was not saved: ${(e as Error).message.slice(0, 200)}`)
    }
  }
  return { links, changed, errors }
}

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

/** START: each role as the phase runs it (no phase, or a role it does not name: on, with the hours it has). */
const startSwitches = (rank: RankPhaseStates): Partial<Record<RankRole, RankSwitch>> =>
  Object.fromEntries(ROLES.map((r) => [r, rank[r] === 'off' ? { enabled: false } : rank[r] === 'light' ? { enabled: true, plan: 'light' as const } : { enabled: true }]))
const allOff = (): Partial<Record<RankRole, RankSwitch>> => Object.fromEntries(ROLES.map((r) => [r, { enabled: false }]))

/** A phase's switches: off; on / light with the playbook's hours — switched on only once the playbook runs (START). */
const phaseSwitches = (rank: RankPhaseStates, running: boolean): Partial<Record<RankRole, RankSwitch>> =>
  Object.fromEntries(ROLES.filter((r) => rank[r]).map((r) => [r, rank[r] === 'off' ? { enabled: false } : { enabled: running, plan: rank[r] === 'light' ? 'light' as const : 'full' as const }]))

const linesOf = (steps: RankStep[]): ArtifactPreviewLine[] =>
  steps.map((s) => ({ kind: RANK_GROUP_KIND, key: s.key, does: s.does, summary: s.summary, ...(s.refId ? { refId: s.refId } : {}) }))

async function isRunning(playbookId: string): Promise<boolean> {
  return (await prisma.adsPlaybook.findUnique({ where: { id: playbookId }, select: { state: true } }))?.state === 'RUNNING'
}

/** PB-9: what a phase switch does to the playbook's hourly plans (no writes). Before START, on and light keep them off. */
export async function previewRankPhase(ctx: ArtifactContext, rank: RankPhaseStates): Promise<ArtifactPreviewLine[]> {
  const running = await isRunning(ctx.playbookId)
  const steps = planSwitch(ctx, await loadRankFacts(ctx), phaseSwitches(rank, running))
  return linesOf(steps).map((l) => (running || l.does === 'disable' || l.does === 'keep' || l.does === 'report' ? l : { ...l, summary: `${l.summary} Kept off until START.` }))
}

/** PB-9: switch the playbook's hourly plans to a phase's rank states (off / on / light per role); read back. */
export async function applyRankPhase(ctx: ArtifactContext, rank: RankPhaseStates): Promise<{ changed: string[]; errors: string[] }> {
  const steps = planSwitch(ctx, await loadRankFacts(ctx), phaseSwitches(rank, await isRunning(ctx.playbookId)))
  const { changed, errors } = await runSteps(steps)
  return { changed, errors }
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
    return linesOf(planSwitch(ctx, facts, startSwitches(phase.rank), { follow: true }))
  },
  async compile(ctx) {
    if (ctx.mode !== 'build' && ctx.mode !== 'adopt') return { links: [], errors: [] }
    const { links, errors } = await runSteps(planCompile(ctx, await loadRankFacts(ctx)))
    return { links, errors }
  },
  async setEnabled(ctx, _links, enabled) {
    if (!enabled) return runSteps(planSwitch(ctx, await loadRankFacts(ctx), allOff())).then(({ changed, errors }) => ({ changed, errors }))
    // START fails closed: a phase that cannot be read switches nothing on.
    const phase = await phaseRank(ctx)
    if ('error' in phase) return { changed: [], errors: [phase.error] }
    const { changed, errors } = await runSteps(planSwitch(ctx, await loadRankFacts(ctx), startSwitches(phase.rank), { follow: true }))
    return { changed, errors }
  },
}
