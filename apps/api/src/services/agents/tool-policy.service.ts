/**
 * ACP.1 — tool policy resolution: code default ⊕ operator DB override.
 *
 *   effectiveTier    = alwaysAsk ? 'high' : (AgentTool.riskTier ?? code.riskTier)
 *   requiresApproval = alwaysAsk OR tier=='high' OR AgentTool.requiresApproval
 *   enabled          = AgentTool.enabled ?? true
 *
 * The alwaysAsk flag (pricing/publishing/customer-comms/spend/fiscal) is a
 * HARD FLOOR — an operator can make a tool stricter but never downgrade an
 * always-ask tool below approval. Enforced here, not in config.
 */

import prisma from '../../db.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import { getTool, listTools } from './tool-registry.js'
import type { RiskTier } from './tool-types.js'

export interface EffectiveToolPolicy {
  name: string
  category: string
  description: string
  riskTier: RiskTier
  readOnly: boolean
  alwaysAsk: boolean
  enabled: boolean
  requiresApproval: boolean
  rateLimitPerHour: number | null
  dailyBudgetUSD: number | null
}

interface DbPolicy {
  riskTier: string
  enabled: boolean
  requiresApproval: boolean
  rateLimitPerHour: number | null
  dailyBudgetUSD: unknown
}

const cache = new TtlCache<Map<string, DbPolicy>>({
  ttlMs: 60_000,
  maxEntries: 1,
})

async function loadDbPolicies(): Promise<Map<string, DbPolicy>> {
  const hit = cache.get('all')
  if (hit) return hit
  const rows = await prisma.agentTool.findMany()
  const map = new Map<string, DbPolicy>(
    rows.map((r) => [
      r.name,
      {
        riskTier: r.riskTier,
        enabled: r.enabled,
        requiresApproval: r.requiresApproval,
        rateLimitPerHour: r.rateLimitPerHour,
        dailyBudgetUSD: r.dailyBudgetUSD,
      },
    ]),
  )
  cache.set('all', map)
  return map
}

export function bustPolicyCache(): void {
  cache.clear()
}

const isTier = (t: string): t is RiskTier =>
  t === 'low' || t === 'medium' || t === 'high'

export async function resolveToolPolicy(
  name: string,
): Promise<EffectiveToolPolicy | null> {
  const tool = getTool(name)
  if (!tool) return null
  const db = (
    await loadDbPolicies().catch(() => new Map<string, DbPolicy>())
  ).get(name)
  const tier: RiskTier = tool.alwaysAsk
    ? 'high'
    : db && isTier(db.riskTier)
      ? db.riskTier
      : tool.riskTier
  const requiresApproval =
    !!tool.alwaysAsk ||
    tier === 'high' ||
    !!tool.requiresApprovalDefault ||
    (db?.requiresApproval ?? false)
  return {
    name: tool.name,
    category: tool.category,
    description: tool.description,
    riskTier: tier,
    readOnly: tool.readOnly,
    alwaysAsk: !!tool.alwaysAsk,
    enabled: db?.enabled ?? true,
    requiresApproval,
    rateLimitPerHour: db?.rateLimitPerHour ?? null,
    dailyBudgetUSD: db?.dailyBudgetUSD != null ? Number(db.dailyBudgetUSD) : null,
  }
}

export async function listToolPolicies(): Promise<EffectiveToolPolicy[]> {
  const out: EffectiveToolPolicy[] = []
  for (const t of listTools()) {
    const p = await resolveToolPolicy(t.name)
    if (p) out.push(p)
  }
  return out
}

/** Upsert an AgentTool row per code tool — create with code defaults when
 *  absent, never clobber operator edits. Idempotent. */
export async function seedToolPolicies(): Promise<{ created: number }> {
  let created = 0
  for (const t of listTools()) {
    const existing = await prisma.agentTool.findUnique({
      where: { name: t.name },
    })
    if (!existing) {
      await prisma.agentTool.create({
        data: {
          name: t.name,
          riskTier: t.alwaysAsk ? 'high' : t.riskTier,
          enabled: true,
          requiresApproval:
            !!t.alwaysAsk || t.riskTier === 'high' || !!t.requiresApprovalDefault,
        },
      })
      created++
    }
  }
  bustPolicyCache()
  return { created }
}

export interface ToolPolicyPatch {
  riskTier?: string
  enabled?: boolean
  requiresApproval?: boolean
  rateLimitPerHour?: number | null
  dailyBudgetUSD?: number | null
  updatedBy?: string | null
}

/** Operator policy edit — respects the alwaysAsk hard floor. */
export async function setToolPolicy(
  name: string,
  patch: ToolPolicyPatch,
): Promise<{ ok: boolean; error?: string }> {
  const tool = getTool(name)
  if (!tool) return { ok: false, error: 'unknown tool' }
  const data: Record<string, unknown> = {}
  if (patch.riskTier !== undefined) {
    if (!isTier(patch.riskTier)) return { ok: false, error: 'invalid riskTier' }
    if (tool.alwaysAsk && patch.riskTier !== 'high')
      return {
        ok: false,
        error: `${name} is always-ask and cannot be set below 'high'`,
      }
    data.riskTier = patch.riskTier
  }
  if (patch.enabled !== undefined) data.enabled = patch.enabled
  if (patch.requiresApproval !== undefined) {
    if (tool.alwaysAsk && patch.requiresApproval === false)
      return {
        ok: false,
        error: `${name} is always-ask; approval cannot be disabled`,
      }
    data.requiresApproval = patch.requiresApproval
  }
  if (patch.rateLimitPerHour !== undefined)
    data.rateLimitPerHour = patch.rateLimitPerHour
  if (patch.dailyBudgetUSD !== undefined)
    data.dailyBudgetUSD = patch.dailyBudgetUSD
  if (patch.updatedBy !== undefined) data.updatedBy = patch.updatedBy
  await prisma.agentTool.upsert({
    where: { name },
    create: {
      name,
      riskTier: tool.alwaysAsk ? 'high' : tool.riskTier,
      ...data,
    },
    update: data,
  })
  bustPolicyCache()
  return { ok: true }
}
