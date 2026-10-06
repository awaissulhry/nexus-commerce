/**
 * R13 (MCP full control, part 06 §3) — a guardrail change for Claude's set-ad-guardrail: a spend ceiling, a bid policy
 * or a protected term, set or removed, through the guardrail service (R4) and its audit rows.
 *
 * Every change is judged TIGHTEN or LOOSEN (part 06 §3, "brakes are not down"):
 *   tighten  a new ceiling or a lower cap; a new bid ceiling or a lower one, a lower floor; a new protected term
 *   loosen   a higher cap, a cap cleared, anything switched off or removed; a higher bid ceiling, a higher (or new)
 *            bid floor, which forces bids up
 * A tightening is inside set-ad-guardrail's limits; a loosening needs a person unless the business's limits allow it
 * (allowLoosen, off by default). The write gate reads the rows
 * at its next decision (ads-write-gate.ts): nothing else needs to move.
 */
import type { AdBidPolicy, AdSpendCeiling } from '@prisma/client'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { isRefused } from '../automation/service-outcome.js'

export type GuardrailKind = 'spend-ceiling' | 'bid-policy' | 'protected-term'
export type GuardrailOp = 'set' | 'remove'

export interface GuardrailInput {
  kind: GuardrailKind
  op: GuardrailOp
  grain?: string
  scopeId?: string
  label?: string
  dailyCapCents?: number | null
  minBidCents?: number | null
  maxBidCents?: number | null
  enabled?: boolean
  note?: string | null
  term?: string
  matchType?: string
  marketplace?: string | null
  campaignId?: string | null
}

/** A guardrail as set-ad-guardrail records it (before / after) and its undo restores it. */
export interface GuardrailState {
  kind: GuardrailKind
  key: { grain?: string; scopeId?: string; term?: string; marketplace?: string | null; campaignId?: string | null }
  row: Record<string, unknown> | null
}

export interface GuardrailPlan {
  action: 'set-ad-guardrail'
  kind: GuardrailKind
  op: GuardrailOp
  direction: 'tighten' | 'loosen'
  why: string
  label: string
  changes: Record<string, { from: unknown; to: unknown }>
  basis: string | null
  effect: string
}

const pick = (row: Record<string, unknown> | null, keys: string[]) => (row ? Object.fromEntries(keys.map((k) => [k, row[k] ?? null])) : null)
const CEILING_KEYS = ['label', 'dailyCapCents', 'enabled', 'note']
const POLICY_KEYS = ['label', 'minBidCents', 'maxBidCents', 'enabled', 'note']

/** The name of a scope, checked to exist in this business. */
async function scopeLabel(grain: string, scopeId: string): Promise<string | null> {
  if (grain === 'CAMPAIGN') return (await prisma.campaign.findUnique({ where: { id: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'MARKET') return (await prisma.campaign.findFirst({ where: { marketplace: scopeId }, select: { id: true } })) ? `market ${scopeId}` : null
  if (grain === 'PORTFOLIO') return (await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: scopeId }, select: { name: true } }))?.name ?? null
  if (grain === 'LINE') return (await prisma.product.findUnique({ where: { id: scopeId }, select: { sku: true } }))?.sku ?? null
  return null
}

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null, keys: string[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of keys) {
    const from = before ? before[k] ?? null : null
    const to = after ? after[k] ?? null : null
    if (JSON.stringify(from) !== JSON.stringify(to)) out[k] = { from, to }
  }
  return out
}

const TERM_KEYS = ['term', 'matchType', 'marketplace', 'campaignId']

/** A guardrail row as a change records it (and its undo compares): its settings only. */
export function guardrailState(kind: GuardrailKind, row: Record<string, unknown> | null): Record<string, unknown> | null {
  return pick(row, kind === 'protected-term' ? TERM_KEYS : kind === 'spend-ceiling' ? CEILING_KEYS : POLICY_KEYS)
}

/** Read the guardrail a key names, now (the whole row). */
export async function readGuardrail(kind: GuardrailKind, key: GuardrailState['key']): Promise<Record<string, unknown> | null> {
  if (kind === 'protected-term') {
    const { normaliseTerm } = await import('./ads-write-gate.js')
    const row = await prisma.adKeywordProtection.findFirst({ where: { mode: 'WHITELIST', term: normaliseTerm(key.term ?? ''), marketplace: key.marketplace ?? null, campaignId: key.campaignId ?? null } })
    return row ? (row as unknown as Record<string, unknown>) : null
  }
  const where = { grain_scopeId: workspaceKey({ grain: key.grain ?? '', scopeId: key.scopeId ?? '' }) }
  const row: AdSpendCeiling | AdBidPolicy | null = kind === 'spend-ceiling' ? await prisma.adSpendCeiling.findUnique({ where }) : await prisma.adBidPolicy.findUnique({ where })
  return row ? (row as unknown as Record<string, unknown>) : null
}

export async function planGuardrail(input: GuardrailInput): Promise<{ ok: true; plan: GuardrailPlan; before: GuardrailState; after: GuardrailState } | { ok: false; error: string }> {
  if (input.kind === 'protected-term') {
    if (!input.term?.trim()) return { ok: false, error: 'term: the term to protect from negation' }
    if (input.campaignId && !(await prisma.campaign.findUnique({ where: { id: input.campaignId }, select: { id: true } }))) return { ok: false, error: `campaignId ${input.campaignId}: not found in this business.` }
    const key = { term: input.term, marketplace: input.marketplace ?? null, campaignId: input.campaignId ?? null }
    const existing = await readGuardrail('protected-term', key)
    if (input.op === 'remove' && !existing) return { ok: false, error: `“${input.term}” is not a protected term here (not found).` }
    if (input.op === 'set' && existing) return { ok: false, error: `“${existing.term}” is already protected.` }
    const { normaliseTerm } = await import('./ads-write-gate.js')
    const after = input.op === 'set' ? { term: normaliseTerm(input.term), matchType: input.matchType ? input.matchType.trim().toUpperCase() : null, marketplace: key.marketplace, campaignId: key.campaignId } : null
    const tighten = input.op === 'set'
    return {
      ok: true,
      before: { kind: 'protected-term', key, row: guardrailState('protected-term', existing) },
      after: { kind: 'protected-term', key, row: after },
      plan: {
        action: 'set-ad-guardrail', kind: 'protected-term', op: input.op, direction: tighten ? 'tighten' : 'loosen',
        why: tighten ? 'a new protected term: no rule may negate it' : 'removing a protected term lets rules negate it again',
        label: `“${input.term}”`, changes: { protected: { from: !!existing, to: tighten } }, basis: null,
        effect: tighten ? `Protects “${input.term}” from negation${key.marketplace ? ` in ${key.marketplace}` : ''}.` : `Removes the protection of “${input.term}”.`,
      },
    }
  }

  const ceiling = input.kind === 'spend-ceiling'
  const grains = ceiling ? ['CAMPAIGN', 'LINE', 'PORTFOLIO', 'MARKET'] : ['LINE', 'PORTFOLIO', 'MARKET']
  // A spend ceiling binds a campaign unless another grain is named.
  if (ceiling && !input.grain) input = { ...input, grain: 'CAMPAIGN' }
  if (!input.grain || !grains.includes(input.grain)) return { ok: false, error: `grain: one of ${grains.join(', ')}${ceiling ? '' : ' (a campaign\'s own bid bounds are its Campaign columns)'}` }
  if (!input.scopeId) return { ok: false, error: 'scopeId: the campaign id, product line id, portfolio id or market it binds' }
  const scopeName = await scopeLabel(input.grain, input.scopeId)
  if (!scopeName) return { ok: false, error: `${input.grain} ${input.scopeId}: not found in this business.` }
  const key = { grain: input.grain, scopeId: input.scopeId }
  const existing = await readGuardrail(input.kind, key)
  const keys = ceiling ? CEILING_KEYS : POLICY_KEYS
  if (input.op === 'remove') {
    if (!existing) return { ok: false, error: `There is no ${input.kind} on ${input.grain} ${scopeName} (not found).` }
    return {
      ok: true,
      before: { kind: input.kind, key, row: guardrailState(input.kind, existing) }, after: { kind: input.kind, key, row: null },
      plan: { action: 'set-ad-guardrail', kind: input.kind, op: 'remove', direction: 'loosen', why: 'removing a guardrail lets spend or bids go further', label: String(existing.label), changes: diff(pick(existing, keys), null, keys), basis: (existing.updatedAt as Date).toISOString(), effect: `Removes the ${input.kind} on ${input.grain} ${scopeName}.` },
    }
  }
  const prev = existing ?? {}
  const next: Record<string, unknown> = {
    label: (input.label ?? (prev.label as string | undefined) ?? scopeName).trim(),
    enabled: input.enabled ?? (prev.enabled as boolean | undefined) ?? true,
    note: input.note !== undefined ? input.note : (prev.note ?? null),
  }
  let loosen: string | null = null
  if (ceiling) {
    next.dailyCapCents = input.dailyCapCents !== undefined ? input.dailyCapCents : (prev.dailyCapCents ?? null)
    if (next.dailyCapCents != null && (!Number.isInteger(next.dailyCapCents) || (next.dailyCapCents as number) < 0)) return { ok: false, error: 'dailyCapCents: a whole number of cents, 0 or more, or null' }
    const was = existing && existing.enabled ? (existing.dailyCapCents as number | null) : null
    const now = next.enabled ? (next.dailyCapCents as number | null) : null
    if (now == null && was != null) loosen = 'the daily cap is cleared or switched off'
    else if (was != null && now != null && now > was) loosen = `the daily cap rises from ${was}¢ to ${now}¢`
  } else {
    next.minBidCents = input.minBidCents !== undefined ? input.minBidCents : (prev.minBidCents ?? null)
    next.maxBidCents = input.maxBidCents !== undefined ? input.maxBidCents : (prev.maxBidCents ?? null)
    for (const k of ['minBidCents', 'maxBidCents']) if (next[k] != null && (!Number.isInteger(next[k]) || (next[k] as number) < 2)) return { ok: false, error: `${k}: at least 2 cents, or null` }
    if (next.minBidCents != null && next.maxBidCents != null && (next.minBidCents as number) > (next.maxBidCents as number)) return { ok: false, error: `minBidCents (${next.minBidCents}¢) is above maxBidCents (${next.maxBidCents}¢)` }
    const on = (r: Record<string, unknown> | null) => (r && r.enabled !== false ? r : null)
    const was = on(existing), now = on(next)
    const wasMax = (was?.maxBidCents as number | null) ?? null, nowMax = (now?.maxBidCents as number | null) ?? null
    const wasMin = (was?.minBidCents as number | null) ?? null, nowMin = (now?.minBidCents as number | null) ?? null
    if (wasMax != null && (nowMax == null || nowMax > wasMax)) loosen = nowMax == null ? 'the bid ceiling is cleared or switched off' : `the bid ceiling rises from ${wasMax}¢ to ${nowMax}¢`
    else if (nowMin != null && (wasMin == null || nowMin > wasMin)) loosen = `a bid floor of ${nowMin}¢ forces bids up`
  }
  const changes = diff(pick(existing, keys), next, keys)
  if (!Object.keys(changes).length) return { ok: false, error: `The ${input.kind} on ${input.grain} ${scopeName} already holds these values.` }
  return {
    ok: true,
    before: { kind: input.kind, key, row: existing ? pick(existing, keys) : null },
    after: { kind: input.kind, key, row: next },
    plan: {
      action: 'set-ad-guardrail', kind: input.kind, op: 'set', direction: loosen ? 'loosen' : 'tighten',
      why: loosen ?? 'it holds spend or bids tighter', label: String(next.label), changes, basis: existing ? (existing.updatedAt as Date).toISOString() : null,
      effect: `${existing ? 'Changes' : 'Sets'} the ${input.kind} on ${input.grain} ${scopeName}. The write gate applies it at its next decision.`
        + (ceiling ? ' It caps the budget increases authorised in a day in that scope (a raise past it is refused); it does not cap what Amazon spends, bid raises or placement raises.' : ''),
    },
  }
}

export async function applyGuardrail(input: GuardrailInput, actorUserId: string | null): Promise<{ ok: true; plan: GuardrailPlan; before: GuardrailState; after: GuardrailState } | { ok: false; error: string }> {
  const planned = await planGuardrail(input)
  if ('error' in planned) return planned
  const svc = await import('./ads-guardrail.service.js')
  const actor = `user:${actorUserId ?? 'anonymous'}`
  const row = planned.after.row
  const key = planned.after.key
  let out: { ok: boolean; status?: number; body?: Record<string, unknown> }
  if (input.kind === 'protected-term') {
    out = input.op === 'set'
      ? await svc.addKeywordProtection({ mode: 'WHITELIST', term: input.term, matchType: input.matchType, marketplace: key.marketplace, campaignId: key.campaignId, reason: input.note ?? 'protected by Claude' }, actor)
      : await svc.removeKeywordProtection(String((await readGuardrail('protected-term', key))!.id), actor)
  } else if (input.op === 'remove') {
    out = input.kind === 'spend-ceiling' ? await svc.deleteSpendCeiling(key, actor) : await svc.deleteBidPolicy(key, actor)
  } else {
    out = input.kind === 'spend-ceiling'
      ? await svc.setSpendCeiling({ grain: key.grain, scopeId: key.scopeId, label: String(row!.label), dailyCapCents: row!.dailyCapCents as number | null, enabled: row!.enabled as boolean, note: row!.note as string | null }, actor)
      : await svc.setBidPolicy({ grain: key.grain, scopeId: key.scopeId, label: String(row!.label), minBidCents: row!.minBidCents as number | null, maxBidCents: row!.maxBidCents as number | null, enabled: row!.enabled as boolean, note: row!.note as string | null }, actor)
  }
  if (isRefused(out as never)) return { ok: false, error: `Not set — ${String((out as { body: Record<string, unknown> }).body.error)}` }
  return planned
}
