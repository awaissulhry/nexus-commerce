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
 */
export async function syncRuleCampaignBinding(
  ruleId: string,
  actions: unknown,
  actor?: string | null,
): Promise<BindingSyncResult> {
  const want = builderBudgetCampaignIds(actions)
  if (want == null) return EMPTY

  const unique = [...new Set(want)]
  const known = unique.length
    ? await prisma.campaign.findMany({ where: { id: { in: unique } }, select: { id: true } })
    : []
  const okIds = new Set(known.map((c) => c.id))
  const skipped = unique.filter((id) => !okIds.has(id))

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
