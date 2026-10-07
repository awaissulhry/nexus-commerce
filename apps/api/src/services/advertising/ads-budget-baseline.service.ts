/**
 * ADS AUTONOMY W4-7 — BUD.3, restore budgets TO their baseline, moved unchanged out of
 * `POST /advertising/budget-baselines/restore` (advertising.routes.ts) so Claude's restore-budget-baselines runs the
 * same code (budget-pool-route-parity.vitest.test.ts holds the route's answers byte for byte).
 *
 * Explicit ids from the page; per campaign it is a REAL gated write (allowlist, pins, bounds, spend ceilings all bind —
 * a denial reports per row, never silently). Skips: no baseline captured (nothing to restore TO), already at baseline.
 * This is deliberately the only bulk budget RAISE in the product, and it can only raise to a number an operator
 * anchored.
 */
import prisma from '../../db.js'
import type { AdsActor } from './ads-mutation.service.js'

export interface BaselineRestoreRow {
  id: string
  name: string
  outcome: 'restored' | 'skipped' | 'failed'
  why?: string
  fromCents?: number
  toCents?: number
}

/** The route's answer: each campaign found, restored, skipped or failed (a campaign not found is not listed). */
export async function restoreBudgetBaselines(ids: string[], actor: AdsActor) {
  const rows = await prisma.campaign.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, dailyBudget: true, budgetBaselineCents: true },
  })
  const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
  const results: BaselineRestoreRow[] = []
  for (const c of rows) {
    const currentCents = Math.round(Number(c.dailyBudget) * 100)
    if (c.budgetBaselineCents == null) { results.push({ id: c.id, name: c.name, outcome: 'skipped', why: 'no baseline captured' }); continue }
    if (c.budgetBaselineCents === currentCents) { results.push({ id: c.id, name: c.name, outcome: 'skipped', why: 'already at baseline' }); continue }
    try {
      const res = await updateCampaignWithSync({
        campaignId: c.id,
        patch: { dailyBudget: c.budgetBaselineCents / 100 },
        actor,
        reason: `restore to baseline €${(c.budgetBaselineCents / 100).toFixed(2)} (was €${(currentCents / 100).toFixed(2)})`,
      } as never)
      const ok = (res as { ok?: boolean }).ok !== false
      results.push({ id: c.id, name: c.name, outcome: ok ? 'restored' : 'failed', why: (res as { error?: string }).error, fromCents: currentCents, toCents: c.budgetBaselineCents })
    } catch (e) {
      results.push({ id: c.id, name: c.name, outcome: 'failed', why: (e as Error).message, fromCents: currentCents, toCents: c.budgetBaselineCents })
    }
  }
  const restored = results.filter((r) => r.outcome === 'restored').length
  return { ok: true, restored, skipped: results.filter((r) => r.outcome === 'skipped').length, failed: results.filter((r) => r.outcome === 'failed').length, results, note: 'Each write passes the gate; acceptance here means ENQUEUED, and the worker may still refuse it — the change log is the delivery record.' }
}
