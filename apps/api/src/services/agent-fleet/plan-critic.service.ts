/**
 * NAF.C — the critic's DETERMINISTIC pre-checks (plan C-D3). Code first,
 * model second: everything here is computed without an LLM, handed to the
 * plan-critic model as evidence, and enforced again by the council when
 * queueing — the model may ADD blocks, never remove one.
 *
 * The per-item mechanism is deliberate: each plan item runs through its
 * own registered tool HANDLER (the dry-run preview). The handler already
 * encodes protected-terms, authority-pin, existing-negative and floor
 * denials — so the critic, the approval preview, and any future executor
 * share ONE denial surface and cannot drift (the two-vocabularies lesson).
 *
 * Self-competition stays ADVISORY in Phase C (a bounded same-term query;
 * the structural graph check is Phase H) — the model weighs it; code does
 * not block on it yet.
 */
import type { PlanItemT } from '@nexus/shared/agent-fleet'
import prisma from '../../db.js'
import { getTool } from '../agents/tool-registry.js'
import { computeGraphAdvisories } from './graph-critic-checks.js'
import { foldPlanBlast } from './plan-blast.js'
import type { BlastInput, BlastVerdict } from '../ads-core/blast-radius-guard.js'

const FLEET_TOOL_NAMES = [
  'create-negative-keyword',
  'graduate-keyword',
  'set-target-bid',
] as const

export interface ForcedBlock {
  findingId: string
  check: string
  reason: string
}

export interface PreCheckResult {
  forcedBlocks: ForcedBlock[]
  advisories: Array<{ check: string; findingId?: string; note: string }>
  itemPreviews: Array<{ findingId: string; tool: string; preview: unknown }>
  blast: { input: BlastInput; verdict: BlastVerdict }
}

export async function runPreChecks(plan: {
  items: PlanItemT[]
  conflicts: unknown[]
}): Promise<PreCheckResult> {
  const forcedBlocks: ForcedBlock[] = []
  const advisories: PreCheckResult['advisories'] = []
  const itemPreviews: PreCheckResult['itemPreviews'] = []

  // 1 — every referenced finding must exist and be open (evidence integrity).
  const findingIds = [...new Set(plan.items.map((i) => i.findingId))]
  const findings = await prisma.agentFinding.findMany({
    where: { id: { in: findingIds } },
    select: { id: true, status: true, expiresAt: true, dataVintage: true },
  })
  const byId = new Map(findings.map((f) => [f.id, f]))
  for (const item of plan.items) {
    const f = byId.get(item.findingId)
    if (!f) {
      forcedBlocks.push({
        findingId: item.findingId,
        check: 'evidence_sufficient',
        reason: `finding ${item.findingId} does not exist`,
      })
    } else if (f.status !== 'open' || f.expiresAt < new Date()) {
      forcedBlocks.push({
        findingId: item.findingId,
        check: 'data_fresh',
        reason: `finding ${item.findingId} is ${f.status !== 'open' ? f.status : 'expired'}`,
      })
    }
  }

  // 2 — no double-counting: an entity with a PENDING fleet approval is
  // already awaiting the operator; proposing it again is noise.
  const pending = await prisma.agentApproval.findMany({
    where: { status: 'pending', toolName: { in: [...FLEET_TOOL_NAMES] } },
    select: { toolName: true, args: true },
  })
  const pendingKeys = new Set(
    pending.map((p) => `${p.toolName}:${JSON.stringify(p.args)}`),
  )
  for (const item of plan.items) {
    if (pendingKeys.has(`${item.tool}:${JSON.stringify(item.args)}`)) {
      forcedBlocks.push({
        findingId: item.findingId,
        check: 'no_double_counting',
        reason: 'an identical proposal is already pending operator approval',
      })
    }
  }

  // 3 — each item through its own tool's dry-run handler: protected terms,
  // pins, existing negatives, floors — the shared denial surface.
  for (const item of plan.items) {
    const tool = getTool(item.tool)
    if (!tool || !(FLEET_TOOL_NAMES as readonly string[]).includes(item.tool)) {
      forcedBlocks.push({
        findingId: item.findingId,
        check: 'respects_pins',
        reason: `unknown or non-fleet tool "${item.tool}"`,
      })
      continue
    }
    const res = await tool.handler(item.args as Record<string, unknown>, {})
    if (!res.ok) {
      const reason = res.error ?? 'tool dry-run denied'
      const check = /whitelisted|protected/i.test(reason)
        ? 'respects_protected_terms'
        : /pin/i.test(reason)
          ? 'respects_pins'
          : /already/i.test(reason)
            ? 'no_double_counting'
            : 'blast_radius_ok'
      forcedBlocks.push({ findingId: item.findingId, check, reason })
    } else {
      itemPreviews.push({ findingId: item.findingId, tool: item.tool, preview: res.preview })
    }
  }

  // 4 — blast radius over the whole plan (unattended thresholds).
  const blast = foldPlanBlast(plan.items, {
    conflictsCount: plan.conflicts.length,
    totalCandidates: Math.max(plan.items.length, findingIds.length * 4),
  })
  if (!blast.verdict.proceed) {
    for (const b of blast.verdict.breaches) {
      forcedBlocks.push({
        findingId: '*',
        check: 'blast_radius_ok',
        reason: b.message,
      })
    }
  }

  // 5 — self-competition ADVISORY: a graduation whose exact term already
  // has enabled positive targeting elsewhere (bounded query; H makes this
  // structural and blocking).
  for (const item of plan.items) {
    if (item.tool !== 'graduate-keyword') continue
    const query = String((item.args as Record<string, unknown>).query ?? '')
    if (!query) continue
    const clashes = await prisma.adTarget.findMany({
      where: {
        isNegative: false,
        status: 'ENABLED',
        kind: 'KEYWORD',
        expressionValue: { equals: query, mode: 'insensitive' },
      },
      select: { adGroup: { select: { campaign: { select: { name: true } } } } },
      take: 3,
    })
    if (clashes.length > 0) {
      advisories.push({
        check: 'no_self_competition',
        findingId: item.findingId,
        note: `"${query}" already has enabled positive targeting in: ${clashes.map((c) => c.adGroup.campaign.name).join(', ')} — weigh cross-campaign contention`,
      })
    }
  }

  // 6 — NAF.H structural checks: what the entity graph knows that literal
  // term matching cannot see (cannibalization without term overlap, spend
  // against an empty pool). Advisory — the graph derives nightly and may
  // lag a day; an unreadable/empty graph contributes nothing.
  const graphAdvisories = await computeGraphAdvisories(plan.items).catch(() => [])
  advisories.push(...graphAdvisories)

  return { forcedBlocks, advisories, itemPreviews, blast }
}
