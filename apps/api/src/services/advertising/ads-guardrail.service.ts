/**
 * R4 (MCP full control, part 06) — the guardrails every ads engine and rule is bound by: per-scope daily spend
 * ceilings (`AdSpendCeiling`, AUTO.A7) and bid bounds at market / portfolio / line grain (`AdBidPolicy`, BID.S5). The
 * gate half lives in ads-write-gate.ts and is inert until a row exists.
 *
 * Moved unchanged out of `routes/advertising-intel.routes.ts` (GET/PUT/DELETE /advertising/spend-ceilings and
 * /advertising/bid-policies) so Claude's guardrail tool (R13) runs the same code. The routes answer byte for byte as
 * before (automation-routes-parity.vitest.test.ts).
 *
 * New here: every set and every delete leaves an `AdvertisingActionLog` row (`set_spend_ceiling`,
 * `delete_spend_ceiling`, `set_bid_policy`, `delete_bid_policy`) with the row before and after and the person who
 * did it. A brake loosened is a spend decision; it now has a name on it. An audit row never fails the change.
 */
import type { AdBidPolicy, AdKeywordProtection, AdSpendCeiling } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export const SPEND_CEILING_GRAINS: readonly string[] = ['CAMPAIGN', 'LINE', 'PORTFOLIO', 'MARKET']
export const BID_POLICY_GRAINS: readonly string[] = ['LINE', 'PORTFOLIO', 'MARKET']

/** What a guardrail row IS, for its audit rows. */
function config(row: AdSpendCeiling | AdBidPolicy | null): Record<string, unknown> {
  if (!row) return {}
  const { workspaceId: _ws, id: _id, createdAt: _c, updatedAt: _u, ...rest } = row as AdSpendCeiling & Partial<AdBidPolicy>
  return rest
}

async function audit(actor: string, actionType: string, entityType: 'SPEND_CEILING' | 'BID_POLICY' | 'KEYWORD_PROTECTION', entityId: string, before: object, after: object, note: string): Promise<void> {
  await prisma.advertisingActionLog.create({
    data: {
      userId: actor, actionType, entityType, entityId,
      payloadBefore: before as object, payloadAfter: after as object, amazonResponseStatus: 'SUCCESS',
      evidence: { metric: 'operator_guardrail', note },
    },
  }).catch((error: unknown) => logger.warn('[ADS-GUARDRAIL-AUDIT] audit row not written', { actionType, entityId, error: String(error) }))
}

// ── Spend ceilings ─────────────────────────────────────────────────────────────────────────────────

export async function listSpendCeilings(): Promise<{ ceilings: AdSpendCeiling[] }> {
  const rows = await prisma.adSpendCeiling.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] })
  return { ceilings: rows }
}

export interface SpendCeilingInput { grain?: string; scopeId?: string; label?: string; dailyCapCents?: number | null; enabled?: boolean; note?: string | null }

export async function setSpendCeiling(b: SpendCeilingInput, actor: string): Promise<ServiceOutcome<{ ceiling: AdSpendCeiling }>> {
  const GRAINS = new Set(SPEND_CEILING_GRAINS)
  if (!b?.grain || !GRAINS.has(b.grain) || !b.scopeId || !b.label?.trim()) {
    return refused(400, { error: 'grain (CAMPAIGN|LINE|PORTFOLIO|MARKET) + scopeId + label required' })
  }
  if (b.dailyCapCents != null && (!Number.isFinite(b.dailyCapCents) || b.dailyCapCents < 0)) {
    return refused(400, { error: 'dailyCapCents must be a non-negative integer, or null for "opened but not set"' })
  }
  const before = await prisma.adSpendCeiling.findUnique({ where: { grain_scopeId: workspaceKey({ grain: b.grain, scopeId: b.scopeId }) } })
  const row = await prisma.adSpendCeiling.upsert({
    where: { grain_scopeId: workspaceKey({ grain: b.grain, scopeId: b.scopeId }) },
    create: { grain: b.grain, scopeId: b.scopeId, label: b.label.trim(), dailyCapCents: b.dailyCapCents ?? null, enabled: b.enabled ?? true, note: b.note ?? null, createdBy: 'operator' },
    update: { label: b.label.trim(), dailyCapCents: b.dailyCapCents ?? null, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.note !== undefined ? { note: b.note } : {}) },
  })
  await audit(actor, 'set_spend_ceiling', 'SPEND_CEILING', row.id, config(before), config(row), `${row.grain} ${row.label}: ${row.dailyCapCents ?? 'not set'}¢/day${row.enabled ? '' : ' (off)'}`)
  return done({ ceiling: row })
}

export async function deleteSpendCeiling(q: { grain?: string; scopeId?: string }, actor: string): Promise<ServiceOutcome<{ ok: true }>> {
  if (!q.grain || !q.scopeId) return refused(400, { error: 'grain + scopeId required' })
  const existing = await prisma.adSpendCeiling.findUnique({ where: { grain_scopeId: workspaceKey({ grain: q.grain, scopeId: q.scopeId }) } })
  if (!existing) return refused(404, { error: 'not_found' })
  await prisma.adSpendCeiling.delete({ where: { id: existing.id } })
  await audit(actor, 'delete_spend_ceiling', 'SPEND_CEILING', existing.id, config(existing), {}, `${existing.grain} ${existing.label}: removed`)
  return done({ ok: true as const })
}

// ── Bid policies ───────────────────────────────────────────────────────────────────────────────────

export async function listBidPolicies(): Promise<{ policies: AdBidPolicy[] }> {
  const rows = await prisma.adBidPolicy.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] })
  return { policies: rows }
}

export interface BidPolicyInput { grain?: string; scopeId?: string; label?: string; minBidCents?: number | null; maxBidCents?: number | null; enabled?: boolean; note?: string | null }

export async function setBidPolicy(b: BidPolicyInput, actor: string): Promise<ServiceOutcome<{ policy: AdBidPolicy }>> {
  const GRAINS = new Set(BID_POLICY_GRAINS)
  if (!b?.grain || !GRAINS.has(b.grain) || !b.scopeId || !b.label?.trim()) {
    return refused(400, { error: 'grain (LINE|PORTFOLIO|MARKET) + scopeId + label required — the CAMPAIGN grain is the Campaign columns, set via the guardrails PATCH' })
  }
  for (const [name, v] of [['minBidCents', b.minBidCents], ['maxBidCents', b.maxBidCents]] as const) {
    if (v != null && (!Number.isFinite(v) || v < 2)) return refused(400, { error: `${name} must be ≥ 2 cents or null` })
  }
  if (b.minBidCents != null && b.maxBidCents != null && b.minBidCents > b.maxBidCents) {
    return refused(400, { error: `minBidCents (${b.minBidCents}¢) is above maxBidCents (${b.maxBidCents}¢)` })
  }
  const before = await prisma.adBidPolicy.findUnique({ where: { grain_scopeId: workspaceKey({ grain: b.grain, scopeId: b.scopeId }) } })
  const row = await prisma.adBidPolicy.upsert({
    where: { grain_scopeId: workspaceKey({ grain: b.grain, scopeId: b.scopeId }) },
    create: { grain: b.grain, scopeId: b.scopeId, label: b.label.trim(), minBidCents: b.minBidCents ?? null, maxBidCents: b.maxBidCents ?? null, enabled: b.enabled ?? true, note: b.note ?? null, createdBy: 'operator' },
    update: { label: b.label.trim(), minBidCents: b.minBidCents ?? null, maxBidCents: b.maxBidCents ?? null, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.note !== undefined ? { note: b.note } : {}) },
  })
  await audit(actor, 'set_bid_policy', 'BID_POLICY', row.id, config(before), config(row), `${row.grain} ${row.label}: ${row.minBidCents ?? '–'}¢…${row.maxBidCents ?? '–'}¢${row.enabled ? '' : ' (off)'}`)
  return done({ policy: row })
}

export async function deleteBidPolicy(q: { grain?: string; scopeId?: string }, actor: string): Promise<ServiceOutcome<{ ok: true }>> {
  if (!q.grain || !q.scopeId) return refused(400, { error: 'grain + scopeId required' })
  const existing = await prisma.adBidPolicy.findUnique({ where: { grain_scopeId: workspaceKey({ grain: q.grain, scopeId: q.scopeId }) } })
  if (!existing) return refused(404, { error: 'not_found' })
  await prisma.adBidPolicy.delete({ where: { id: existing.id } })
  await audit(actor, 'delete_bid_policy', 'BID_POLICY', existing.id, config(existing), {}, `${existing.grain} ${existing.label}: removed`)
  return done({ ok: true as const })
}

// ── Protected terms (AdKeywordProtection): terms no rule may negate ────────────────────────────────────

export interface KeywordProtectionInput {
  mode?: string; term?: string; isPrefix?: boolean; matchType?: string
  marketplace?: string | null; campaignId?: string | null; reason?: string | null
}

/**
 * POST /advertising/keyword-protections — moved unchanged from advertising.routes.ts (R13). New here: an audit row
 * (`add_keyword_protection`), which the route never wrote.
 */
export async function addKeywordProtection(b: KeywordProtectionInput, actor: string): Promise<ServiceOutcome<{ ok: true; item: AdKeywordProtection }>> {
  const mode = b.mode === 'BLACKLIST' ? 'BLACKLIST' : 'WHITELIST'
  const MATCH_TYPES = ['EXACT', 'PREFIX', 'CONTAINS']
  const rawMatch = typeof b.matchType === 'string' ? b.matchType.trim().toUpperCase() : ''
  if (rawMatch && !MATCH_TYPES.includes(rawMatch)) {
    return refused(400, { ok: false, error: `matchType must be one of ${MATCH_TYPES.join('/')}`, code: 'match_type_invalid' })
  }
  // The gate reads `matchType ?? (isPrefix ? 'PREFIX' : 'EXACT')`, so writing null here keeps the
  // old two-way behaviour exactly. Only an explicit choice stores a value.
  const matchType = rawMatch || null
  const { normaliseTerm } = await import('./ads-write-gate.js')
  const term = normaliseTerm(String(b.term ?? ''))
  if (!term) return refused(400, { ok: false, error: 'term required' })
  // Same normalisation the gate matches on, so what an operator types is what binds.
  const existing = await prisma.adKeywordProtection.findFirst({
    where: { mode, term, marketplace: b.marketplace ?? null, campaignId: b.campaignId ?? null },
    select: { id: true, matchType: true, isPrefix: true },
  })
  if (existing) {
    // NEG.5 — say what is already there and how it differs. A protection cannot be edited in
    // place (only deleted and re-added, which loses createdBy/createdAt), so a bare "already
    // protected" left an operator trying to strengthen EXACT → CONTAINS with no way forward and
    // no idea why.
    const had = existing.matchType ?? (existing.isPrefix ? 'PREFIX' : 'EXACT')
    const want = matchType ?? (b.isPrefix ? 'PREFIX' : 'EXACT')
    return refused(409, {
      ok: false,
      id: existing.id,
      error: had === want
        ? `“${term}” is already protected with ${had} matching`
        : `“${term}” is already protected with ${had} matching. A protection cannot be changed in place — delete it and re-add it as ${want}.`,
      code: 'already_protected',
      existingMatchType: had,
    })
  }
  const row = await prisma.adKeywordProtection.create({
    data: {
      mode, term, isPrefix: matchType ? matchType === 'PREFIX' : !!b.isPrefix, matchType,
      marketplace: b.marketplace ?? null, campaignId: b.campaignId ?? null,
      reason: b.reason ?? null, createdBy: actor,
    },
  })
  await audit(actor, 'add_keyword_protection', 'KEYWORD_PROTECTION', row.id, {}, protectionConfig(row), `${row.mode} “${row.term}” added`)
  return done({ ok: true as const, item: row })
}

/** DELETE /advertising/keyword-protections/:id — moved unchanged (R13), now with its audit row. */
export async function removeKeywordProtection(id: string, actor: string): Promise<ServiceOutcome<{ ok: true }>> {
  const row = await prisma.adKeywordProtection.findUnique({ where: { id } })
  if (!row) return refused(404, { ok: false, error: 'not_found' })
  await prisma.adKeywordProtection.delete({ where: { id } })
  await audit(actor, 'remove_keyword_protection', 'KEYWORD_PROTECTION', id, protectionConfig(row), {}, `${row.mode} “${row.term}” removed`)
  return done({ ok: true as const })
}

function protectionConfig(row: AdKeywordProtection): Record<string, unknown> {
  return { mode: row.mode, term: row.term, isPrefix: row.isPrefix, matchType: row.matchType, marketplace: row.marketplace, campaignId: row.campaignId, reason: row.reason }
}
