/**
 * R15 (MCP full control, part 06) — the fleet's steering, moved unchanged out of agent-fleet.routes.ts so steer-fleet
 * steers through the same code (the same cap, the same AUTO gate, the same control audit):
 *   PATCH /agent/fleet/charters/:key         → patchCharter
 *   POST  /agent/fleet/charters/:key/pause   → pauseCharter
 *   POST  /agent/fleet/charters/:key/resume  → resumeCharter
 *   POST  /agent/fleet/run/:key              → runCharterNow
 * The routes answer byte for byte as before (automation-fleet-route-parity.vitest.test.ts). `actor` is new and
 * optional: the routes pass none, so the audit row says 'operator' as it always did; steer-fleet names the person.
 */
import prisma from '../../db.js'
import { isAiKillSwitchOn } from '../ai/providers/index.js'
import { AUTONOMY_LEVELS, isAutonomyLevel } from '../advertising/ads-autonomy.js'
import { executeCharter } from './agent-executor.js'
import { isAutoPromotionAllowed } from './promotion.service.js'
import { bustCharterCache, FLEET_CHARTERS, listCharters } from './charter-registry.js'
import { recordControlChange } from './control-audit.service.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export interface CharterPatch {
  enabled?: boolean
  autonomyLevel?: string
  // AC.4 — policy the operator may TIGHTEN (the code value is the ceiling)
  dailyBudgetUSD?: number
  maxTokensPerRun?: number
  maxFindingsPerRun?: number
  modelProvider?: string | null
  modelName?: string | null
  // AC.5 / AC.4 — tool policy and scope
  toolNames?: string[]
  scopeMarketplaces?: string[]
}

// NAF.D — the operator's charter policy control (dial #4, cap #5).
// The cap is enforced HERE, server-side: a request above the code
// charter's autonomyCap is refused, not clamped — the operator should
// know the ceiling exists, not silently get less than they asked.
export async function patchCharter(key: string, body: CharterPatch | undefined, actor?: string | null): Promise<ServiceOutcome<{ ok: true; charters: Awaited<ReturnType<typeof listCharters>> }>> {
  const def = FLEET_CHARTERS[key]
  if (!def) return refused(404, { error: `unknown charter: ${key}` })
  const before = (await listCharters()).find((c) => c.key === key)
  const data: Record<string, unknown> = {}
  if (body?.enabled !== undefined) data.enabled = !!body.enabled
  // AC.4 — numbers are stored as given; the registry clamps them DOWN
  // against the code ceiling on every read, so a too-generous value can
  // never take effect.
  const nums: Array<['dailyBudgetUSD' | 'maxTokensPerRun' | 'maxFindingsPerRun', number | undefined]> = [
    ['dailyBudgetUSD', body?.dailyBudgetUSD],
    ['maxTokensPerRun', body?.maxTokensPerRun],
    ['maxFindingsPerRun', body?.maxFindingsPerRun],
  ]
  for (const [field, value] of nums) {
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      return refused(400, { error: `${field} must be a positive number` })
    }
    data[field] = value
  }
  if (body?.modelProvider !== undefined) {
    data.modelProviderOverride = body.modelProvider || null
  }
  if (body?.modelName !== undefined) {
    data.modelNameOverride = body.modelName || null
  }
  if (body?.toolNames !== undefined) {
    const unknownTools = body.toolNames.filter((t) => !def.toolNames.includes(t))
    if (unknownTools.length > 0) {
      return refused(400, {
        error: `these tools are not in this worker's code charter and cannot be granted: ${unknownTools.join(', ')}`,
      })
    }
    data.toolNames = body.toolNames
  }
  if (body?.scopeMarketplaces !== undefined) {
    // Only a SINGLE-marketplace scope is enforced end-to-end today, and
    // this series' rule is that an unenforced control is never offered.
    if (body.scopeMarketplaces.length > 1) {
      return refused(400, {
        error:
          'only one marketplace can be scoped today — multi-market scope is not enforced yet, so it is refused rather than ignored',
      })
    }
    data.scopeMarketplaces = body.scopeMarketplaces
  }
  if (body?.autonomyLevel !== undefined) {
    const level = body.autonomyLevel
    if (!isAutonomyLevel(level)) {
      return refused(400, { error: `invalid autonomyLevel "${level}"` })
    }
    const capIdx = AUTONOMY_LEVELS.indexOf(def.autonomyCap)
    if (AUTONOMY_LEVELS.indexOf(level) > capIdx) {
      return refused(400, {
        error: `autonomyLevel ${level} exceeds this charter's cap (${def.autonomyCap})`,
      })
    }
    // NAF.E — the promotion gate is server-side (spec acceptance): AUTO
    // requires an eligible latest scorecard. The PATCH itself is the
    // operator sign-off; eligibility is the earned half.
    if (level === 'AUTO' && !(await isAutoPromotionAllowed(key))) {
      return refused(403, {
        error:
          `${key} has not earned AUTO — the latest scorecard is not promotion-eligible ` +
          `(Part 7: 30 days + acceptance ≥70% + calibration ≤0.15 + zero rollbacks)`,
      })
    }
    data.autonomyLevel = level
  }
  if (Object.keys(data).length === 0) {
    return refused(400, { error: 'nothing to update' })
  }
  const updated = await prisma.agentCharter.updateMany({
    where: { key, version: def.version },
    data,
  })
  if (updated.count === 0) {
    return refused(404, { error: `charter ${key} v${def.version} not seeded — POST /agent/fleet/charters/seed first` })
  }
  bustCharterCache()
  await recordControlChange({
    charterKey: key,
    action:
      body?.autonomyLevel !== undefined
        ? 'dial'
        : body?.enabled !== undefined
          ? 'enable'
          : body?.toolNames !== undefined
            ? 'tools'
            : body?.scopeMarketplaces !== undefined
              ? 'scope'
              : 'policy',
    from: before
      ? {
          enabled: before.enabled,
          autonomyLevel: before.autonomyLevel,
          dailyBudgetUSD: before.dailyBudgetUSD,
          maxTokensPerRun: before.maxTokensPerRun,
          maxFindingsPerRun: before.maxFindingsPerRun,
          toolNames: before.toolNames,
          scopeMarketplaces: before.scopeMarketplaces,
        }
      : null,
    to: data,
    ...(actor ? { actor } : {}),
  })
  return done({ ok: true as const, charters: await listCharters() })
}

// AC.6 — pause with an expiry; resume clears it.
export async function pauseCharter(key: string, untilRaw: string | undefined, reason: string | undefined, actor?: string | null): Promise<ServiceOutcome<{ ok: true; pausedUntil: Date }>> {
  if (!FLEET_CHARTERS[key]) return refused(404, { error: `unknown charter: ${key}` })
  const until = untilRaw ? new Date(untilRaw) : null
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    return refused(400, { error: 'until must be a future date — a pause always expires' })
  }
  await prisma.agentCharter.updateMany({
    where: { key },
    data: { pausedUntil: until, pausedReason: reason?.trim() || null },
  })
  bustCharterCache()
  await recordControlChange({
    charterKey: key,
    action: 'pause',
    to: { until: until.toISOString() },
    note: reason ?? null,
    ...(actor ? { actor } : {}),
  })
  return done({ ok: true as const, pausedUntil: until })
}

export async function resumeCharter(key: string, actor?: string | null): Promise<ServiceOutcome<{ ok: true }>> {
  if (!FLEET_CHARTERS[key]) return refused(404, { error: `unknown charter: ${key}` })
  await prisma.agentCharter.updateMany({
    where: { key },
    data: { pausedUntil: null, pausedReason: null },
  })
  bustCharterCache()
  await recordControlChange({ charterKey: key, action: 'resume', ...(actor ? { actor } : {}) })
  return done({ ok: true as const })
}

/** A run now, as the operator's Run button: the OFF / pause gate is bypassed; the kill switch, the halt and both day budgets bind. */
export async function runCharterNow(key: string, userId?: string | null): Promise<ServiceOutcome<Awaited<ReturnType<typeof executeCharter>>>> {
  if (isAiKillSwitchOn()) return refused(503, { error: 'AI is temporarily disabled (kill switch).' })
  if (!FLEET_CHARTERS[key]) return refused(404, { error: `unknown charter: ${key}` })
  const result = await executeCharter(key, {
    trigger: 'manual',
    mode: 'ask',
    ignoreEnabled: true,
    ...(userId ? { userId } : {}),
  })
  if (!result.ok && result.error) return refused(500, result as unknown as Record<string, unknown>)
  return done(result)
}
