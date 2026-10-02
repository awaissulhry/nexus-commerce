/**
 * R14 (MCP full control, part 06) — two engine settings' edits, moved unchanged out of their routes so tune-ad-engine
 * writes through the same code:
 *   · PATCH /advertising/budget-pools/:id  → patchBudgetPool  (the budget pool rebalancer's pool, A9)
 *   · PATCH /advertising/rank-targets/:id  → patchRankTarget  (the rank-defend loop's target, A10)
 * The routes answer byte for byte as before (automation-tune-route-parity.vitest.test.ts).
 */
import type { BudgetPool, RankTarget } from '@prisma/client'
import prisma from '../../db.js'

/** The pool's fields as the route always took them: the body, as sent. null = not found. */
export async function patchBudgetPool(id: string, body: Record<string, unknown>): Promise<BudgetPool | null> {
  const existing = await prisma.budgetPool.findUnique({ where: { id } })
  if (!existing) return null
  return prisma.budgetPool.update({ where: { id }, data: body })
}

export const RANK_TARGET_FIELDS = ['name', 'placement', 'targetISPct', 'acosCapPct', 'maxCpcCents', 'biasPct', 'floorBidCents', 'jumpStartPct', 'stepUpPct', 'stepDownPct', 'maxBiasPct', 'keepClimbing', 'pause', 'allOut', 'color', 'sortOrder', 'bidMode', 'bidValueCents', 'bidDeltaPct'] as const

/** null = not found (any failure of the update, as the route always answered it). */
export async function patchRankTarget(id: string, b: Record<string, unknown>): Promise<RankTarget | null> {
  const data: Record<string, unknown> = {}
  for (const k of RANK_TARGET_FIELDS) if (b[k] !== undefined) data[k] = b[k]
  if (b.lanes !== undefined) data.lanes = Array.isArray(b.lanes) ? b.lanes : [] // BL — [] = clear blend
  try { return await prisma.rankTarget.update({ where: { id }, data }) } catch { return null }
}
