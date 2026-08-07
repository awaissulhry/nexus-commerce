/**
 * NAF.AC.4 — scope, enforced. The charter's marketplace scope stops being
 * decoration here: candidate rows carry an external campaign id, so the
 * campaigns they belong to decide whether the worker is allowed to see
 * them.
 *
 * House rule from this series: a control that is not enforced must not be
 * rendered. This is the enforcement.
 *
 * Rows whose campaign cannot be resolved are DROPPED under an active
 * scope (we cannot prove they belong) and counted — never silently
 * dropped, per the no-silent-caps rule.
 */
import prisma from '../../../db.js'

export interface ScopeFilterResult<T> {
  kept: T[]
  droppedOutOfScope: number
  unresolved: number
}

export async function filterToMarketplace<T extends { externalCampaignId?: string }>(
  rows: T[],
  marketplace: string | undefined,
): Promise<ScopeFilterResult<T>> {
  if (!marketplace || rows.length === 0) {
    return { kept: rows, droppedOutOfScope: 0, unresolved: 0 }
  }
  const ids = [
    ...new Set(rows.map((r) => r.externalCampaignId).filter((v): v is string => !!v)),
  ]
  const campaigns = ids.length
    ? await prisma.campaign.findMany({
        where: { externalCampaignId: { in: ids } },
        select: { externalCampaignId: true, marketplace: true },
      })
    : []
  const byExternal = new Map(campaigns.map((c) => [c.externalCampaignId!, c.marketplace]))

  const kept: T[] = []
  let droppedOutOfScope = 0
  let unresolved = 0
  for (const row of rows) {
    const mk = row.externalCampaignId ? byExternal.get(row.externalCampaignId) : undefined
    if (mk === undefined) {
      unresolved++
      continue
    }
    if (mk === marketplace) kept.push(row)
    else droppedOutOfScope++
  }
  return { kept, droppedOutOfScope, unresolved }
}

/** The single marketplace a charter is scoped to, if exactly one. */
export function singleMarketplace(scope: string[] | undefined): string | undefined {
  return scope && scope.length === 1 ? scope[0] : undefined
}

/**
 * NAF.SB.AS — campaign scope, enforced. The assignment half of the same
 * house rule: `AgentCharter.scopeCampaignIds` has been stored, accepted at
 * worker-create and RENDERED as "N named campaigns" since W.8 while binding
 * nothing. This is the enforcement that stops it being a lie.
 *
 * Cheaper than the marketplace filter above, not harder: candidate rows
 * already carry `externalCampaignId` (ads-harvest.service.ts:61), so this
 * needs no database read at all and is synchronous.
 *
 * FAIL CLOSED. An empty `externalCampaignIds` array means "narrowed to
 * nothing", and returns nothing — it must NEVER fall through to
 * account-wide. A scope that resolves to zero campaigns and then shows the
 * whole account is the worst bug this feature can have: the row would say
 * one campaign while the worker read all 220. `undefined` (no campaign
 * scope at all) is the only value that means "everything".
 */
export function filterToCampaigns<T extends { externalCampaignId?: string }>(
  rows: T[],
  externalCampaignIds: string[] | undefined,
): ScopeFilterResult<T> {
  if (externalCampaignIds === undefined) {
    return { kept: rows, droppedOutOfScope: 0, unresolved: 0 }
  }
  const allow = new Set(externalCampaignIds)
  const kept: T[] = []
  let droppedOutOfScope = 0
  let unresolved = 0
  for (const row of rows) {
    if (!row.externalCampaignId) {
      // Cannot prove it belongs — dropped and counted, never silently kept.
      unresolved++
      continue
    }
    if (allow.has(row.externalCampaignId)) kept.push(row)
    else droppedOutOfScope++
  }
  return { kept, droppedOutOfScope, unresolved }
}
