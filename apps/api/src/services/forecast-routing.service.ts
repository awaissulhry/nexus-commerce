/**
 * R.16 — Forecast model A/B routing service.
 *
 * Champion-challenger pattern. Every active SKU has a champion
 * model assigned (the one whose forecast drives recommendations).
 * A challenger can be rolled out to a percentage of SKUs to
 * compare MAPE before promotion.
 *
 *   rolloutChallenger() — assigns N% of SKUs to a new model
 *   pinSkuToModel()     — operator targets a specific SKU
 *   promoteToChampion() — moves all challenger assignments to champion
 *   getModelsActive()   — UI dashboard data
 *
 * Hash for deterministic % rollout: simple djb2-like polynomial.
 * Same SKU always lands in the same bucket so re-running the
 * rollout doesn't churn cohort membership.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export const DEFAULT_CHAMPION_MODEL_ID = 'HOLT_WINTERS_V1'

// ─── Pure functions ──────────────────────────────────────────────

/**
 * djb2-style polynomial hash, mod 100. Deterministic per SKU.
 * Used to bucket SKUs into cohorts: bucket < cohortPercent → in.
 */
export function hashSkuToCohort(sku: string): number {
  let h = 5381
  for (let i = 0; i < sku.length; i++) {
    h = ((h << 5) + h + sku.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 100
}

export interface CohortBuckets {
  champion: { modelId: string; skuCount: number }
  challengers: Array<{ modelId: string; skuCount: number }>
  control: number  // SKUs with no assignment
}

export function bucketAssignments(rows: Array<{ modelId: string; cohort: string; sku: string }>): CohortBuckets {
  const championBySku = new Map<string, string>()
  const challengerSkus = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.cohort === 'champion') {
      championBySku.set(r.sku, r.modelId)
    } else if (r.cohort === 'challenger') {
      const set = challengerSkus.get(r.modelId) ?? new Set<string>()
      set.add(r.sku)
      challengerSkus.set(r.modelId, set)
    }
  }
  // Roll up champion by modelId
  const championById = new Map<string, number>()
  for (const m of championBySku.values()) {
    championById.set(m, (championById.get(m) ?? 0) + 1)
  }
  // Pick the most-used champion as "the" champion (in normal
  // operation everyone is on the same champion).
  let topChampion = { modelId: DEFAULT_CHAMPION_MODEL_ID, skuCount: 0 }
  for (const [m, n] of championById) {
    if (n > topChampion.skuCount) topChampion = { modelId: m, skuCount: n }
  }
  return {
    champion: topChampion,
    challengers: [...challengerSkus.entries()]
      .map(([modelId, set]) => ({ modelId, skuCount: set.size }))
      .sort((a, b) => b.skuCount - a.skuCount),
    control: 0, // populated by caller using product count
  }
}

// ─── DB helpers ──────────────────────────────────────────────────

/**
 * Roll out a challenger model to a percentage of active SKUs. Idempotent
 * — re-running with the same percent picks the same SKUs (deterministic
 * hash). Caller can shrink/grow the cohort by re-running with a different
 * percent; existing assignments are preserved when percent ≥ before, and
 * pruned when percent < before.
 */
export async function rolloutChallenger(args: {
  challengerModelId: string
  cohortPercent: number    // 0-100
  expiresAt?: Date | null
  assignedBy?: string
}): Promise<{ assigned: number; removed: number; total: number }> {
  const percent = Math.max(0, Math.min(100, Math.round(args.cohortPercent)))
  const products = await prisma.product.findMany({
    where: { isParent: false, status: { not: 'INACTIVE' } },
    select: { sku: true },
  })

  const targetSkus = new Set(
    products
      .filter((p) => hashSkuToCohort(p.sku) < percent)
      .map((p) => p.sku),
  )

  const existing = await prisma.forecastModelAssignment.findMany({
    where: { modelId: args.challengerModelId, cohort: 'challenger' },
    select: { id: true, sku: true },
  })
  const existingSkus = new Set(existing.map((e) => e.sku))

  // Add: targetSkus ∖ existingSkus
  let assigned = 0
  for (const sku of targetSkus) {
    if (existingSkus.has(sku)) continue
    try {
      await prisma.forecastModelAssignment.create({
        data: {
          sku,
          modelId: args.challengerModelId,
          cohort: 'challenger',
          assignedBy: args.assignedBy ?? 'rollout',
          expiresAt: args.expiresAt ?? null,
        },
      })
      assigned++
    } catch (err) {
      // Race or unique violation; ignore
      logger.debug?.('forecast-routing: assign skip', { sku, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Remove: existingSkus ∖ targetSkus
  let removed = 0
  for (const e of existing) {
    if (targetSkus.has(e.sku)) continue
    await prisma.forecastModelAssignment.delete({ where: { id: e.id } })
    removed++
  }

  return { assigned, removed, total: targetSkus.size }
}

/**
 * Pin a single SKU to a specific model. Used to target high-value
 * SKUs into a challenger cohort regardless of the % rollout.
 */
export async function pinSkuToModel(args: {
  sku: string
  modelId: string
  cohort: 'champion' | 'challenger' | 'control'
  assignedBy?: string
}): Promise<void> {
  await prisma.forecastModelAssignment.upsert({
    where: { sku_modelId: { sku: args.sku, modelId: args.modelId } },
    create: {
      sku: args.sku,
      modelId: args.modelId,
      cohort: args.cohort,
      assignedBy: args.assignedBy ?? 'manual',
    },
    update: { cohort: args.cohort, assignedBy: args.assignedBy ?? 'manual' },
  })
}

/**
 * Promote a challenger to champion. Walks every challenger
 * assignment for the given modelId, flips it to 'champion', and
 * retires the previous champion (deletes its assignment rows so
 * future forecast cron only writes for the new champion).
 */
export async function promoteToChampion(args: {
  modelId: string
  retirePreviousChampion?: boolean
}): Promise<{ migrated: number; previousChampionRowsRemoved: number }> {
  const challengers = await prisma.forecastModelAssignment.findMany({
    where: { modelId: args.modelId, cohort: 'challenger' },
    select: { id: true, sku: true },
  })

  // Flip cohort
  let migrated = 0
  for (const a of challengers) {
    await prisma.forecastModelAssignment.update({
      where: { id: a.id },
      data: { cohort: 'champion', assignedBy: 'rollout' },
    })
    migrated++
  }

  // Optionally retire the previous champion's rows
  let removed = 0
  if (args.retirePreviousChampion !== false) {
    const oldChamps = await prisma.forecastModelAssignment.findMany({
      where: { cohort: 'champion', NOT: { modelId: args.modelId } },
      select: { id: true },
    })
    for (const old of oldChamps) {
      await prisma.forecastModelAssignment.delete({ where: { id: old.id } })
      removed++
    }
  }

  return { migrated, previousChampionRowsRemoved: removed }
}

/**
 * Backfill: every SKU without ANY assignment row gets a default
 * champion assignment. Useful at deploy time so the routing logic
 * has a fallback for legacy SKUs.
 */
export async function ensureDefaultChampionAssignments(args: {
  defaultModelId?: string
}): Promise<{ created: number }> {
  const modelId = args.defaultModelId ?? DEFAULT_CHAMPION_MODEL_ID
  const products = await prisma.product.findMany({
    where: { isParent: false, status: { not: 'INACTIVE' } },
    select: { sku: true },
  })
  const existing = await prisma.forecastModelAssignment.findMany({
    where: { cohort: 'champion' },
    select: { sku: true },
  })
  const existingSet = new Set(existing.map((e) => e.sku))

  let created = 0
  for (const p of products) {
    if (existingSet.has(p.sku)) continue
    try {
      await prisma.forecastModelAssignment.create({
        data: { sku: p.sku, modelId, cohort: 'champion', assignedBy: 'cron' },
      })
      created++
    } catch {
      // unique race — ignore
    }
  }
  return { created }
}

export async function getModelsActive() {
  const rows = await prisma.forecastModelAssignment.findMany({
    select: { sku: true, modelId: true, cohort: true },
  })
  const buckets = bucketAssignments(rows)
  // control = active products without any champion assignment
  const productCount = await prisma.product.count({
    where: { isParent: false, status: { not: 'INACTIVE' } },
  })
  buckets.control = Math.max(0, productCount - buckets.champion.skuCount)
  return {
    ...buckets,
    totalActiveSkus: productCount,
    defaultModelId: DEFAULT_CHAMPION_MODEL_ID,
  }
}
