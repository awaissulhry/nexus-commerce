/**
 * RC6.4 — engine logic check. POST /automation-rules/:id/test evaluates a rule
 * against a SUPPLIED context and returns { result: { matched, actionResults } }
 * (the server forces dry-run, so nothing changes). To answer "does this rule
 * fire as intended?" we synthesise a context that satisfies the rule's own
 * conditions, then ask the engine. This is a real evaluation that catches a
 * malformed operator / threshold before the rule ever goes live — it is NOT a
 * scan of current campaigns (the engine has no stateless live-scan endpoint).
 */

import { getBackendUrl } from '@/lib/backend-url'

interface Leaf { field: string; op: string; value?: unknown }

function leavesOf(payload: unknown): Leaf[] {
  if (payload == null) return []
  if (Array.isArray(payload)) return payload as Leaf[]
  const p = payload as { kind?: string; children?: unknown[]; child?: unknown; field?: string; op?: string; value?: unknown }
  if (p.kind === 'leaf') return p.field && p.op ? [{ field: p.field, op: p.op, value: p.value }] : []
  if (p.kind === 'and') return (p.children ?? []).flatMap(leavesOf)
  if (p.kind === 'or') return p.children?.length ? leavesOf(p.children[0]) : []   // satisfy the first OR branch
  if (p.kind === 'not') return []                                                 // a negation can't be trivially satisfied
  if (p.field && p.op) return [{ field: p.field, op: p.op, value: p.value }]
  return []
}

function satisfy(op: string, value: unknown): number {
  const v = typeof value === 'number' ? value : 0
  switch (op) {
    case 'gt': return v + 1
    case 'lt': return v - 1
    case 'ne': return v + 1
    case 'exists': return v || 1
    default: return v          // gte / lte / eq → the boundary value satisfies
  }
}

function setPath(obj: Record<string, unknown>, path: string, val: unknown) {
  const ks = path.split('.')
  let o = obj
  for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = (o[ks[i]] as Record<string, unknown>) ?? {}; o = o[ks[i]] as Record<string, unknown> }
  o[ks[ks.length - 1]] = val
}

/** A context that satisfies the rule's conditions (best-effort; first OR branch). */
export function syntheticContext(payload: unknown): Record<string, unknown> {
  const ctx: Record<string, unknown> = { campaign: { id: 'sample', name: 'Sample campaign', externalCampaignId: 'sample' }, marketplace: 'TEST' }
  for (const leaf of leavesOf(payload)) setPath(ctx, leaf.field, satisfy(leaf.op, leaf.value))
  return ctx
}

export interface LogicCheck { matched: boolean | null }

/** Ask the engine whether the rule fires on a matching entity (server dry-run). */
export async function checkRuleLogic(ruleId: string, conditions: unknown): Promise<LogicCheck> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${ruleId}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: syntheticContext(conditions) }),
    }).then((x) => x.json()).catch(() => null)
    const matched = r?.result?.matched
    return { matched: typeof matched === 'boolean' ? matched : null }
  } catch { return { matched: null } }
}
