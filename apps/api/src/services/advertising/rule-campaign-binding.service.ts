/**
 * ── BUD-P2 (2026-08-21) — one binding truth for budget rules ──────────────────────────────────
 *
 * Two mechanisms bind a budget rule to campaigns, and before this file they never spoke:
 *
 *   · the **builder's picker** — `actions[0].campaigns: [{id,…}]` on the rule row. `budget_apply`
 *     has honoured it since EA4, so it is what actually restricts the writes.
 *   · the **Apply Rules Budget-Rule column** — `CampaignRuleAssignment` rows (campaign → rule,
 *     many-to-many). D1 made the evaluator refuse an engine-native budget rule on any campaign it
 *     is not assigned to.
 *
 * A builder rule stores `type: 'budget'` (the slug) and the column's catalogue, the evaluator's
 * assignment block and `reachForRules` all tested for `adjust_ad_budget` — so the column could
 * neither show nor bind a builder rule, and reach over-reported it. See the
 * `isEngineBudgetRule` / `builderBudgetCampaignIds` note in `ads-rule-adapter.service.ts`.
 *
 * This service converges the two instead of deleting either. It mirrors in BOTH directions:
 *   · {@link syncRuleCampaignBinding} — builder save → assignment rows, so the column DISPLAYS
 *     what the rule actually governs.
 *   · {@link syncBuilderRuleFromAssignments} — column edit → the rule's own `campaigns`, so a
 *     column edit REACHES the engine (which reads the rule, not the table, for builder rules).
 *
 * 🔴 **Neither direction may fail its caller.** A rule save that succeeded must not be reported as
 * failed because a mirror write lost a race, and a column Apply that committed must not report an
 * error after the fact. Failures log loud (`[ADS-RULE-BINDING]`) and the two sides re-converge on
 * the next save in either direction. The read path is built so that a stale mirror degrades the
 * COLUMN's display, never the engine's behaviour.
 */
import prisma from '../../db.js'
import { Prisma } from '@nexus/database'
import { logger } from '../../utils/logger.js'
import { builderBudgetCampaignIds } from './ads-rule-adapter.service.js'

export interface BindingSyncResult {
  /** false = this rule is not a builder budget rule, so nothing was mirrored. */
  applied: boolean
  created: number
  removed: number
  /** Campaign ids in the rule's picker list that no longer exist — skipped, not fatal. */
  skipped: string[]
}

const EMPTY: BindingSyncResult = { applied: false, created: 0, removed: 0, skipped: [] }

/**
 * Forward mirror: the rule's picker list → `CampaignRuleAssignment` (kind `'budget'`).
 *
 * Replace-by-diff in ONE transaction, so the column never renders a half-written set. Unknown
 * campaign ids are skipped and named rather than allowed to fail at the foreign key — a rule
 * listing a campaign that has since been deleted is a stale rule, not a bad request.
 *
 * `campaigns: []` is a real instruction (H10's "None"): every link for the rule is removed.
 *
 * 4c (review 4.8) — `scopeMarketplace`, when the rule has one, binds only the picks in that market: the tick never
 * evaluates a pick outside it, so a link there would only make Apply Rules show the rule where it can never fire (a
 * save with such picks is refused first; this keeps the column true whatever reaches it). The rule's own list is not
 * rewritten here; such picks are logged, not counted as `skipped` (that means "no longer exists").
 */
export async function syncRuleCampaignBinding(
  ruleId: string,
  actions: unknown,
  actor?: string | null,
  scopeMarketplace?: string | null,
): Promise<BindingSyncResult> {
  const want = builderBudgetCampaignIds(actions)
  if (want == null) return EMPTY

  const unique = [...new Set(want)]
  const known = unique.length
    ? await prisma.campaign.findMany({ where: { id: { in: unique } }, select: { id: true, marketplace: true } })
    : []
  const knownIds = new Set(known.map((c) => c.id))
  const skipped = unique.filter((id) => !knownIds.has(id))
  const outsideMarket = scopeMarketplace ? known.filter((c) => c.marketplace !== scopeMarketplace).map((c) => c.id) : []
  const okIds = new Set([...knownIds].filter((id) => !outsideMarket.includes(id)))
  if (outsideMarket.length) {
    logger.warn('[ADS-RULE-BINDING] picks outside the rule\'s market are not bound', { ruleId, scopeMarketplace, outsideMarket })
  }

  let created = 0
  let removed = 0
  await prisma.$transaction(async (tx) => {
    const have = await tx.campaignRuleAssignment.findMany({
      where: { ruleId, kind: 'budget' },
      select: { id: true, campaignId: true },
    })
    const haveIds = new Set(have.map((h) => h.campaignId))
    const toRemove = have.filter((h) => !okIds.has(h.campaignId)).map((h) => h.id)
    const toAdd = [...okIds].filter((id) => !haveIds.has(id))
    if (toRemove.length) {
      removed = (await tx.campaignRuleAssignment.deleteMany({ where: { id: { in: toRemove } } })).count
    }
    if (toAdd.length) {
      created = (await tx.campaignRuleAssignment.createMany({
        data: toAdd.map((campaignId) => ({ campaignId, ruleId, kind: 'budget', createdBy: actor ?? 'rule-builder' })),
        skipDuplicates: true,
      })).count
    }
  })

  if (skipped.length) {
    logger.warn('[ADS-RULE-BINDING] rule lists campaigns that no longer exist', { ruleId, skipped })
  }
  return { applied: true, created, removed, skipped }
}

/**
 * Inverse mirror: `CampaignRuleAssignment` → the rule's own `actions[0].campaigns`.
 *
 * Called after a column Apply. Only builder budget rules are rewritten; an engine-native rule has
 * no picker list and is already governed by the table it was just written to.
 *
 * The rewritten objects carry the same fields the builder stores (`SchedCampaign` minus the
 * placement extras), so re-opening the rule in the builder shows the column's decision as the
 * picker's contents — one list, two surfaces.
 */
export async function syncBuilderRuleFromAssignments(
  ruleIds: string[],
  actor?: string | null,
): Promise<{ updated: string[] }> {
  const ids = [...new Set(ruleIds)].filter(Boolean)
  if (ids.length === 0) return { updated: [] }

  const rules = await prisma.automationRule.findMany({
    where: { id: { in: ids }, domain: 'advertising' },
    select: { id: true, actions: true },
  })
  const builderRules = rules.filter((r) => builderBudgetCampaignIds(r.actions) != null)
  if (builderRules.length === 0) return { updated: [] }

  const links = await prisma.campaignRuleAssignment.findMany({
    where: { ruleId: { in: builderRules.map((r) => r.id) }, kind: 'budget' },
    select: { ruleId: true, campaignId: true },
  })
  const byRule = new Map<string, string[]>()
  for (const r of builderRules) byRule.set(r.id, [])
  for (const l of links) byRule.get(l.ruleId)?.push(l.campaignId)

  const allCampaignIds = [...new Set(links.map((l) => l.campaignId))]
  const campaigns = allCampaignIds.length
    ? await prisma.campaign.findMany({
      where: { id: { in: allCampaignIds } },
      select: { id: true, name: true, marketplace: true, status: true, targetingType: true, adProduct: true, dailyBudget: true, portfolioId: true },
    })
    : []
  const byId = new Map(campaigns.map((c) => [c.id, c]))

  const updated: string[] = []
  for (const r of builderRules) {
    const wantIds = byRule.get(r.id) ?? []
    const before = builderBudgetCampaignIds(r.actions) ?? []
    // Nothing to write when the two already agree — a column Apply that changed a DIFFERENT rule
    // must not bump every builder rule's updatedAt (see `reference_updatedat_is_a_sync_heartbeat`).
    if (before.length === wantIds.length && before.every((id) => wantIds.includes(id))) continue

    const arr = r.actions as Array<Record<string, unknown>>
    const next = arr.map((a, i) => (i === 0
      ? {
        ...a,
        campaigns: wantIds.map((id) => {
          const c = byId.get(id)
          return {
            id,
            name: c?.name ?? id,
            marketplace: c?.marketplace ?? null,
            status: c?.status ?? null,
            targetingType: c?.targetingType ?? null,
            adProduct: c?.adProduct ?? null,
            dailyBudget: c?.dailyBudget != null ? Number(c.dailyBudget) : null,
            portfolioId: c?.portfolioId ?? null,
          }
        }),
      }
      : a))
    // A typed Json cast, NOT `as never` — that spelling has hidden write failures in this repo
    // before (`reference_as_never_hides_write_failures`), and this write is the whole feature.
    await prisma.automationRule.update({
      where: { id: r.id },
      data: { actions: next as unknown as Prisma.InputJsonValue },
    })
    updated.push(r.id)
  }
  if (updated.length) {
    logger.warn('[ADS-RULE-BINDING] builder budget rules rewritten from column assignments', { updated, actor })
  }
  return { updated }
}

/** The Apply Rules page's one Apply (POST /advertising/campaign-rule-assignments/bulk), as its body arrives. */
export interface CampaignRuleAssignmentsBody { kind?: string; changes?: Array<{ campaignId?: string; ruleIds?: string[] }> }

/**
 * ADS AUTONOMY W4-8 — one rule bound to more campaigns or taken off some (Claude's assign-ad-rules): each campaign's set
 * is read INSIDE the Apply's transaction and only this rule moves in it, so a link another rule gained meanwhile stays.
 */
export interface RuleDelta { ruleId: string; add: string[]; remove: string[] }

/**
 * ── D3 — the global Apply ─────────────────────────────────────────────────────────────────────
 *
 * Commits STAGED assignment changes for many campaigns at once. The operator's study: selecting
 * in the dropdown stages, and one Apply finalises.
 *
 * 🔴 **One transaction.** A per-campaign loop that fails halfway leaves the account in a state
 * nobody chose — half the campaigns governed by the new set and half by the old — and the
 * operator's only evidence would be a toast. Set-replacement per campaign, all or nothing.
 *
 * `ruleIds: []` is a real instruction: unassign everything for that campaign and kind. It is
 * how the study's "None" works, and under assignment-as-reach it means no budget rule may move
 * that campaign at all.
 *
 * ADS AUTONOMY W4-8 — moved unchanged out of `routes/advertising.routes.ts` so Claude's assign-ad-rules runs the same
 * code; the route answers byte for byte as before (campaign-rule-assignment-route-parity.vitest.test.ts).
 */
export async function applyCampaignRuleAssignments(
  b: CampaignRuleAssignmentsBody,
  actor: string,
  delta?: RuleDelta,
): Promise<{ status: 200 | 400; body: Record<string, unknown> }> {
  const kind = b.kind || 'budget'
  // W4-8 — a delta names its campaigns and its one rule; each campaign's set is decided inside the transaction below.
  const changes = delta
    ? [...new Set([...delta.add, ...delta.remove])].map((campaignId) => ({ campaignId, ruleIds: [delta.ruleId] }))
    : (b.changes ?? []).filter((c) => typeof c.campaignId === 'string' && Array.isArray(c.ruleIds))
  if (changes.length === 0) return { status: 400, body: { error: 'changes required' } }

  // Validate BEFORE writing: an unknown campaign or rule id would otherwise fail at the foreign
  // key mid-transaction and report itself as a database error rather than a bad request.
  const campaignIds = [...new Set(changes.map((c) => c.campaignId as string))]
  const ruleIds = [...new Set(changes.flatMap((c) => c.ruleIds as string[]))]
  const [knownCampaigns, knownRules] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true } }),
    ruleIds.length ? prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true } }) : Promise.resolve([]),
  ])
  const okCampaign = new Set(knownCampaigns.map((c) => c.id))
  const okRule = new Set(knownRules.map((r) => r.id))
  const badCampaign = campaignIds.filter((id) => !okCampaign.has(id))
  const badRule = ruleIds.filter((id) => !okRule.has(id))
  if (badCampaign.length || badRule.length) {
    return { status: 400, body: { error: 'unknown id', campaigns: badCampaign.slice(0, 5), rules: badRule.slice(0, 5) } }
  }

  let created = 0
  let removed = 0
  /**
   * BUD-P2 — every rule this Apply TOUCHES, which is not the same as every rule it names.
   * Unchecking a rule everywhere sends `ruleIds: []`, so the rule losing its last campaign
   * appears nowhere in the request body. Collecting the rows we DELETE as well as the ones we
   * add is what lets the inverse mirror below clear that rule's own list — without it, "remove
   * this rule from this campaign" would still have been a no-op for builder rules.
   */
  const affectedRuleIds = new Set<string>(ruleIds)
  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      const have = await tx.campaignRuleAssignment.findMany({
        where: { campaignId: c.campaignId as string, kind },
        select: { id: true, ruleId: true },
      })
      const want = delta ? deltaSet(have.map((h) => h.ruleId), delta, c.campaignId as string) : new Set(c.ruleIds as string[])
      for (const h of have) affectedRuleIds.add(h.ruleId)
      const haveIds = new Set(have.map((h) => h.ruleId))
      const toRemove = have.filter((h) => !want.has(h.ruleId)).map((h) => h.id)
      const toAdd = [...want].filter((id) => !haveIds.has(id))
      if (toRemove.length) {
        const r = await tx.campaignRuleAssignment.deleteMany({ where: { id: { in: toRemove } } })
        removed += r.count
      }
      if (toAdd.length) {
        const r = await tx.campaignRuleAssignment.createMany({
          data: toAdd.map((ruleId) => ({ campaignId: c.campaignId as string, ruleId, kind, createdBy: actor })),
          skipDuplicates: true,
        })
        created += r.count
      }
    }
  })
  /**
   * BUD-P2 — the inverse mirror. A BUILDER budget rule is governed by its own `campaigns` list
   * (that is what `budget_apply` enforces and what the evaluator matches on), so a column edit
   * only REACHES the engine once that list is rewritten from the links just committed. Without
   * this the column moved rows the engine never read — it displayed a binding that did nothing.
   *
   * Outside the transaction on purpose: the assignments are committed and must stay committed;
   * a failure here is a stale rule list to re-converge, not a reason to undo the operator's Apply.
   */
  let rulesRewritten: string[] = []
  if (kind === 'budget' && affectedRuleIds.size > 0) {
    try {
      rulesRewritten = (await syncBuilderRuleFromAssignments([...affectedRuleIds], actor)).updated
    } catch (e) {
      logger.error('[ADS-RULE-BINDING] bulk inverse mirror failed', { ruleIds: [...affectedRuleIds], error: String(e) })
    }
  }
  logger.warn('[ADS-RULE-ASSIGNMENT]', { kind, campaigns: changes.length, created, removed, actor, rulesRewritten: rulesRewritten.length })
  return { status: 200, body: { ok: true, kind, campaigns: changes.length, created, removed, rulesRewritten: rulesRewritten.length } }
}

/** W4-8 — a campaign's rules after a delta: what it holds now, with the one rule added or taken off. */
function deltaSet(have: string[], delta: RuleDelta, campaignId: string): Set<string> {
  const out = new Set(have)
  if (delta.add.includes(campaignId)) out.add(delta.ruleId)
  if (delta.remove.includes(campaignId)) out.delete(delta.ruleId)
  return out
}

/**
 * MCP full control A3 — the read side: what may change one campaign again on its own. The ENABLED advertising rules
 * bound to it through `CampaignRuleAssignment` (every kind, each with the kind it is bound by), and its schedule when
 * enabled. Read-only. Claude's ad change tools name them in a preview: a rule or schedule on the campaign may move a bid
 * or budget again minutes after an approved change.
 */
export async function automationsBoundToCampaign(campaignId: string): Promise<{
  rules: Array<{ id: string; name: string; kind: string }>
  schedules: Array<{ id: string; name: string }>
}> {
  const [links, schedules] = await Promise.all([
    prisma.campaignRuleAssignment.findMany({
      where: { campaignId, rule: { enabled: true, domain: 'advertising' } },
      select: { kind: true, rule: { select: { id: true, name: true } } },
    }),
    prisma.adSchedule.findMany({ where: { campaignId, enabled: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
  ])
  const rules = links
    .map((link) => ({ id: link.rule.id, name: link.rule.name, kind: link.kind }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { rules, schedules }
}
