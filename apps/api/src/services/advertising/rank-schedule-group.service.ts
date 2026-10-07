/**
 * ADS AUTONOMY W4-1 — one rank-schedule group (an hourly bid plan on the Hourly Bids page) changed WITHOUT its member
 * list: renamed, switched on or off, or a field of the group row set. This is the lightweight PATCH
 * /advertising/rank-schedule-groups/:id (no `campaignIds`), moved here unchanged so the screen and Claude's
 * set-hourly-bid-plan (op rename, op switch) take one path, never a second. The route parses, calls this and answers
 * with `answer` exactly as before (rank-schedule-group-route-parity.vitest.test.ts holds it byte for byte).
 *
 *   rename   trimmed; refused (409) when another plan in the same scope (portfolio, or none) already has the name — the
 *            duplicate DPS.1 removed would come back by hand otherwise (saveRankScheduleGroup adopts by name).
 *   switch   the members follow the group's `enabled`; switched off, the plan gives back what it floored on every member
 *            once they say paused (2a, rank-release.service.ts releaseGroupMembers).
 *   version  RD.P7 — a version row when something meaningful changed (the comparison saveRankScheduleGroup uses), so the
 *            history answers who switched it and when; a failed snapshot warns and never fails the write.
 *
 * NOT for the windows or the members: this path updates the group row only, and the members' own rows (what the
 * rank-defend engine reads) keep their old hours. Those go through saveRankScheduleGroup (ads-create.service.ts).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import { targetValuesOf, type TargetValues } from './hourly-plan-week.js'

/** The group fields the lightweight PATCH sets, as the route always took them. */
const LIGHT_FIELDS = ['name', 'windows', 'defaultTargetKey', 'targetOverrides', 'enabled', 'marketplace', 'portfolioId', 'timezone'] as const

/**
 * PATCH /advertising/rank-schedule-groups/:id without `campaignIds`. `changedBy`: who the version row names (the route:
 * the `x-actor-id` header as `user:<id>`, else `user:anonymous`). W4-1 — `opts.changeSetId`: a Claude request's switch-off
 * names its approval on every write of the give-back (absent for the screen).
 */
export async function patchRankScheduleGroup(id: string, b: Record<string, unknown>, changedBy: string, opts: { changeSetId?: string | null } = {}): Promise<ServiceOutcome<unknown>> {
  const data: Record<string, unknown> = {}
  for (const k of LIGHT_FIELDS) if (b[k] !== undefined) data[k] = b[k]
  if (!Object.keys(data).length) return refused(400, { error: 'nothing to update' })
  // RDX/B2 — a rename must not manufacture the duplicate DPS.1 spent a phase eliminating.
  // saveRankScheduleGroup adopts an existing (name, portfolioId) group rather than minting a
  // rival, but this lightweight PATCH bypasses that path entirely — so without this guard,
  // renaming "IT AIRMESH 2" to "IT AIRMESH" would recreate the exact collision by hand.
  if (typeof data.name === 'string') {
    const nm = String(data.name).trim()
    if (!nm) return refused(400, { error: 'name is required' })
    data.name = nm
    const self = await prisma.rankScheduleGroup.findUnique({ where: { id }, select: { portfolioId: true } })
    const twin = await prisma.rankScheduleGroup.findFirst({
      where: { name: nm, portfolioId: self?.portfolioId ?? null, NOT: { id } },
      select: { id: true },
    })
    if (twin) return refused(409, { error: `Another schedule in this scope is already called "${nm}".` })
  }
  try {
    const g = await prisma.rankScheduleGroup.update({ where: { id }, data })
    if (b.enabled !== undefined) await prisma.adSchedule.updateMany({ where: { groupId: id }, data: { enabled: !!b.enabled } })
    // 2a (review 3.2) — pausing gives back what the group floored on every member, once the members say paused.
    let release: unknown
    if (b.enabled === false) {
      const { releaseGroupMembers } = await import('./rank-release.service.js')
      release = await releaseGroupMembers(id, 'its rank schedule was paused', { changeSetId: opts.changeSetId ?? null })
    }
    /**
     * RD.P7 — the most consequential click on the page (Enable/Pause) took this lightweight
     * path and wrote NO version, so the history could not answer "who paused this and when".
     * Snapshot with the same meaningful-change comparison saveRankScheduleGroup uses; a
     * failed snapshot warns and never fails the write it describes.
     */
    try {
      const members = await prisma.adSchedule.count({ where: { groupId: id } })
      const last = await prisma.rankScheduleVersion.findFirst({ where: { groupId: id }, orderBy: { createdAt: 'desc' }, select: { name: true, windows: true, defaultTargetKey: true, campaignCount: true, enabled: true } })
      const changed = !last
        || last.name !== g.name
        || (last.defaultTargetKey ?? null) !== (g.defaultTargetKey ?? null)
        || last.campaignCount !== members
        || last.enabled !== g.enabled
        || JSON.stringify(last.windows) !== JSON.stringify(g.windows)
      if (changed) {
        await prisma.rankScheduleVersion.create({
          data: { groupId: id, name: g.name, windows: g.windows as never, defaultTargetKey: g.defaultTargetKey ?? null, campaignCount: members, enabled: g.enabled, changedBy },
        })
      }
    } catch (e) { logger.warn('[RD.P7] version snapshot failed on lightweight PATCH', { id, error: (e as Error).message }) }
    return done(release ? { ...g, release } : g)
  } catch (e) { return refused(500, { error: (e as Error)?.message }) }
}

// ── W4-1 — the plans as Claude reads them (ad-hourly-plans) and set-hourly-bid-plan decides on them ───────────────────

/** Claude's change tool for hourly bid plans: its recorded changes say which plans Claude changed last. */
export const HOURLY_PLAN_TOOL = 'set-hourly-bid-plan'

/** One plan as it stands: the group row and what its members hold (the rows the engine reads). */
export interface PlanState {
  planId: string
  name: string
  enabled: boolean
  timezone: string
  marketplace: string | null
  portfolioId: string | null
  windows: unknown[]
  defaultTargetKey: string | null
  /** Member campaign ids, sorted. */
  members: string[]
  /** Each member's own target values (campaignId → targetKey → values), only the members that hold any. */
  overrides: Record<string, Record<string, Record<string, unknown>>>
  updatedAt: string
}

/** The keys of PlanState: what a recorded change is compared on (a later save by anyone moves `updatedAt`). */
export const PLAN_STATE_KEYS: ReadonlyArray<keyof PlanState> = ['planId', 'name', 'enabled', 'timezone', 'marketplace', 'portfolioId', 'windows', 'defaultTargetKey', 'members', 'overrides', 'updatedAt']

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** The plans named (all when `planIds` is absent), as they stand. */
export async function readPlanStates(planIds?: readonly string[]): Promise<PlanState[]> {
  const groups = await prisma.rankScheduleGroup.findMany({ where: planIds ? { id: { in: [...planIds] } } : {}, orderBy: { name: 'asc' } })
  if (!groups.length) return []
  const members = await prisma.adSchedule.findMany({ where: { groupId: { in: groups.map((g) => g.id) } }, select: { groupId: true, campaignId: true, targetOverrides: true } })
  return groups.map((g) => {
    const mine = members.filter((m) => m.groupId === g.id).sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0))
    const overrides: PlanState['overrides'] = {}
    for (const m of mine) {
      const o = objOf(m.targetOverrides)
      if (Object.keys(o).length) overrides[m.campaignId] = o as Record<string, Record<string, unknown>>
    }
    return {
      planId: g.id, name: g.name, enabled: g.enabled, timezone: g.timezone, marketplace: g.marketplace ?? null, portfolioId: g.portfolioId ?? null,
      windows: Array.isArray(g.windows) ? (g.windows as unknown[]) : [], defaultTargetKey: g.defaultTargetKey ?? null,
      members: mine.map((m) => m.campaignId), overrides, updatedAt: g.updatedAt.toISOString(),
    }
  })
}

/** A plan's state, the PlanState keys only (a recorded change's `after` carries more). */
export function stateOnly(value: unknown): Partial<PlanState> {
  const v = objOf(value)
  return Object.fromEntries(PLAN_STATE_KEYS.filter((k) => k in v).map((k) => [k, v[k]])) as Partial<PlanState>
}

/** Who a plan is: the playbook's, Claude's (Claude made it and only Claude requests changed it since), or a person's. */
export type PlanOwner =
  | { by: 'playbook'; playbookId: string; key: string; words: string }
  | { by: 'claude'; approvalId: string; at: string; approvedBy: string | null; words: string }
  | { by: 'person'; who: string | null; at: string | null; words: string }

/** The JSON of a value, keys sorted (jsonb re-orders keys). */
function sorted(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}

type ClaudeChange = { approvalId: string; executedAt: Date; executedByUserId: string | null; before: unknown; after: unknown }

/**
 * Pure — is this plan Claude's? Only when ALL hold, else it is a person's for good (the Owner's plans are his, W4-1):
 *   · a set-hourly-bid-plan `create` made it (the first change recorded for it);
 *   · each later Claude change started from exactly what the one before it left (a save by anyone else in between — the
 *     screen, a template, a restore, a campaign's values edited on its schedule — breaks the chain);
 *   · every version row of the plan is one a Claude change wrote;
 *   · what stands now is what the last Claude change left.
 * `changes`: the plan's set-hourly-bid-plan changes, oldest first.
 */
export function claudeOwnsPlan(state: PlanState, changes: readonly ClaudeChange[], versionIds: readonly string[]): boolean {
  const chain = changes.filter((c) => objOf(c.after).deleted !== true)
  if (!chain.length || objOf(chain[0].after).op !== 'create') return false
  for (let i = 1; i < chain.length; i++) {
    if (sorted(stateOnly(chain[i].before)) !== sorted(stateOnly(chain[i - 1].after))) return false
  }
  const written = new Set(chain.map((c) => objOf(c.after).versionId).filter((v): v is string => typeof v === 'string'))
  if (versionIds.some((id) => !written.has(id))) return false
  return sorted(stateOnly(chain[chain.length - 1].after)) === sorted(stateOnly(state))
}

/**
 * Whose each plan is. A plan the ads playbook built (an AdsPlaybookLink rankGroup) is the playbook's. A plan is Claude's
 * only as claudeOwnsPlan says: Claude made it, and nothing but Claude requests changed it since. Every other plan is a
 * person's, for good — one approved Claude change never makes a person's plan Claude's. Who made or last changed it
 * comes from its newest version row (the screen's saves may name no one).
 */
export async function planOwners(states: readonly PlanState[]): Promise<Map<string, PlanOwner>> {
  const out = new Map<string, PlanOwner>()
  if (!states.length) return out
  const ids = states.map((s) => s.planId)
  const [links, changes, versions] = await Promise.all([
    prisma.adsPlaybookLink.findMany({ where: { kind: 'rankGroup', refId: { in: ids } }, select: { refId: true, key: true, playbookId: true } }),
    prisma.agentChange.findMany({
      where: { toolName: HOURLY_PLAN_TOOL, OR: ids.map((id) => ({ after: { path: ['planId'], equals: id } })) },
      orderBy: { executedAt: 'asc' },
      select: { approvalId: true, executedAt: true, executedByUserId: true, before: true, after: true },
    }),
    prisma.rankScheduleVersion.findMany({ where: { groupId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { id: true, groupId: true, changedBy: true, createdAt: true } }),
  ])
  const books = links.length ? await prisma.adsPlaybook.findMany({ where: { id: { in: [...new Set(links.map((l) => l.playbookId))] } }, select: { id: true, label: true, market: true } }) : []
  const groups = await prisma.rankScheduleGroup.findMany({ where: { id: { in: ids } }, select: { id: true, createdBy: true, createdAt: true } })
  const made = new Map(groups.map((g) => [g.id, g]))
  for (const s of states) {
    const link = links.find((l) => l.refId === s.planId)
    if (link) {
      const book = books.find((b) => b.id === link.playbookId)
      out.set(s.planId, { by: 'playbook', playbookId: link.playbookId, key: link.key, words: `the ads playbook's hourly plan (${link.key}${book ? `, ${book.label} in ${book.market}` : ''})` })
      continue
    }
    const mine = changes.filter((c) => objOf(c.after).planId === s.planId)
    const own = versions.filter((v) => v.groupId === s.planId)
    if (claudeOwnsPlan(s, mine, own.map((v) => v.id))) {
      const last = mine[mine.length - 1]
      out.set(s.planId, {
        by: 'claude', approvalId: last.approvalId, at: last.executedAt.toISOString(), approvedBy: last.executedByUserId ?? null,
        words: `made by a Claude request and changed only by Claude requests since; the last (${last.approvalId}) approved by ${last.executedByUserId ? `user:${last.executedByUserId}` : 'the business\'s rule'} on ${last.executedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      })
      continue
    }
    const v = own[0]
    const who = v?.changedBy ?? made.get(s.planId)?.createdBy ?? null
    const at = (v?.createdAt ?? made.get(s.planId)?.createdAt ?? null)?.toISOString() ?? null
    // The newest version a Claude change wrote is said as Claude's request (its changedBy is the approver).
    const byClaude = v ? mine.find((c) => objOf(c.after).versionId === v.id) : undefined
    const name = byClaude ? `a Claude request (${byClaude.approvalId})`
      : !who ? 'a person (not named)' : who === 'user:anonymous' ? 'a person on the Hourly Bids page (not named)' : who.startsWith('user:') ? `a person (${who})` : who
    const claudeToo = mine.length ? '; Claude requests changed it too, which never makes it Claude\'s' : ''
    out.set(s.planId, { by: 'person', who, at, words: `a person's plan — last changed by ${name}${at ? ` on ${at.slice(0, 16).replace('T', ' ')} UTC` : ''}${claudeToo}` })
  }
  return out
}

/**
 * The hourly plan a rank-defend row belongs to (automation-detail, turn-up / turn-down-automation): a member schedule's
 * plan, or the plan itself when the id is a plan's. Null: neither (a product rank plan, a schedule of its own).
 */
export async function hourlyPlanOfRow(rowId: string): Promise<{ planId: string; name: string; enabled: boolean } | null> {
  const direct = await prisma.rankScheduleGroup.findUnique({ where: { id: rowId }, select: { id: true, name: true, enabled: true } })
  if (direct) return { planId: direct.id, name: direct.name, enabled: direct.enabled }
  const schedule = await prisma.adSchedule.findUnique({ where: { id: rowId }, select: { groupId: true } })
  if (!schedule?.groupId) return null
  const group = await prisma.rankScheduleGroup.findUnique({ where: { id: schedule.groupId }, select: { id: true, name: true, enabled: true } })
  return group ? { planId: group.id, name: group.name, enabled: group.enabled } : null
}

/** The rank targets' values (the Hourly Bids library), and the same with one campaign's own values on top. */
export interface TargetLibrary {
  /** Every rank target by key, as the library holds it. */
  values: Map<string, TargetValues>
  /** The values with a campaign's own target values applied, exactly as the engine applies them. */
  withOverrides: (overrides: unknown) => Map<string, TargetValues>
}

/** The library, read once (the engine's spec, ad-rank-defend.job.ts toSpec / applyTargetOverrides). */
export async function targetLibrary(): Promise<TargetLibrary> {
  const { toSpec, applyTargetOverrides } = await import('../../jobs/ad-rank-defend.job.js')
  const rows = await prisma.rankTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
  const specs = rows.map((r) => ({ name: r.name, spec: toSpec(r as never) }))
  const values = new Map(specs.map(({ name, spec }) => [spec.key, targetValuesOf(spec, name)]))
  return {
    values,
    withOverrides(overrides) {
      const map = objOf(overrides)
      if (!Object.keys(map).length) return values
      return new Map(specs.map(({ name, spec }) => [spec.key, targetValuesOf(applyTargetOverrides(spec, map as never), name)]))
    },
  }
}

/** Is the rank engine running for this business now, and what that means for a plan change, in words. */
export async function rankEngineNow(): Promise<{ on: boolean; words: string }> {
  try {
    const { engineEnv, engineMode } = await import('../automation/engine-switch.service.js')
    const env = await engineEnv('rank-defend')
    if (env.ceiling === 'OFF') return { on: false, words: `the hourly bid engine does not run on this server (${env.reason ?? 'its server switch is off'}), so nothing of it reaches Amazon until it does` }
    const mode = await engineMode('rank-defend', env.ceiling)
    if (mode.mode === 'OFF') return { on: false, words: `the hourly bid engine is switched off for this business${mode.note ? ` (${mode.note})` : ''}, so nothing of it reaches Amazon until it is switched on` }
    return { on: true, words: 'the hourly bid engine applies it at Amazon from its next run (every 15 minutes), each write through Amazon\'s write gate' }
  } catch (e) {
    logger.warn('[W4-1] rank engine switch unreadable', { error: (e as Error).message })
    return { on: false, words: 'whether the hourly bid engine runs could not be read just now' }
  }
}

// ── W4-1 — the plan reads Claude's tools need, kept inside advertising (scripts/check-context-boundary.mjs) ────────────

/**
 * Who holds each campaign now: an hourly plan (its group), or a schedule of its own (planId null), with the campaign's own
 * target values on that schedule — the screen's builder keeps them when it takes the campaign in (RankPlanBody).
 */
export async function campaignHolders(campaignIds: readonly string[]): Promise<Map<string, { scheduleId: string; planId: string | null; planName: string | null; enabled: boolean; targetOverrides: Record<string, Record<string, unknown>> }>> {
  const rows = campaignIds.length
    ? await prisma.adSchedule.findMany({ where: { campaignId: { in: [...new Set(campaignIds)] } }, select: { id: true, campaignId: true, groupId: true, enabled: true, targetOverrides: true, group: { select: { name: true } } } })
    : []
  return new Map(rows.map((r) => [r.campaignId, {
    scheduleId: r.id, planId: r.groupId ?? null, planName: r.group?.name ?? null, enabled: r.enabled,
    targetOverrides: objOf(r.targetOverrides) as Record<string, Record<string, unknown>>,
  }]))
}

/** A plan's member schedules (the rows the engine runs), with what each holds now. */
export async function planSchedules(planId: string) {
  return prisma.adSchedule.findMany({ where: { groupId: planId }, select: { id: true, campaignId: true, enabled: true, lastApplied: true, lastEvaluatedAt: true } })
}

/** Another plan of this name in the same scope (a portfolio, or none), or null. */
export async function planNamedAlready(name: string, portfolioId: string | null, notId?: string): Promise<{ id: string } | null> {
  return prisma.rankScheduleGroup.findFirst({ where: { name, portfolioId: portfolioId ?? null, ...(notId ? { NOT: { id: notId } } : {}) }, select: { id: true } })
}

/** The newest version row of a plan written at or after `since` (the one a change just wrote), or null. */
export async function versionSince(planId: string, since: Date): Promise<{ id: string } | null> {
  return prisma.rankScheduleVersion.findFirst({ where: { groupId: planId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, select: { id: true } })
}

/** A plan's dated events still to end, and its last versions. */
export async function planHistory(planId: string, now: Date) {
  const [events, versions] = await Promise.all([
    prisma.rankScheduleEvent.findMany({ where: { groupId: planId, endsAt: { gt: now } }, orderBy: { startsAt: 'asc' }, take: 10, select: { name: true, startsAt: true, endsAt: true, enabled: true } }),
    prisma.rankScheduleVersion.findMany({ where: { groupId: planId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, createdAt: true, changedBy: true, enabled: true, campaignCount: true, name: true } }),
  ])
  return { events, versions }
}

/**
 * The campaigns an enabled product rank plan governed on its last run (read off `lastSummary`, as the schedules list
 * reads them): the rank engine lets such a plan win over a schedule on the same campaign.
 */
export async function productPlanCampaigns(): Promise<Set<string>> {
  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } })
  const out = new Set<string>()
  for (const p of plans) for (const d of (objOf(p.lastSummary).decisions as Array<{ campaignId?: string }> | undefined) ?? []) if (d?.campaignId) out.add(d.campaignId)
  return out
}
