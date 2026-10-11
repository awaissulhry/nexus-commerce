/**
 * HARVEST ENGINE — the page's doors to the approval gate: a change set (or an undo) asked as ONE `apply-harvest` request
 * through the gate (requestApproval: the page's door, dry run as this person), optionally approved in the same click
 * through the Approvals page's own path (decideFleetApproval: the 20-second undo window, the code when it raises); and the
 * "Waiting for you" decisions on harvest requests, through the same path. Never a direct write.
 */
import prisma from '../../../db.js'
import { requestApproval } from '../../agents/approval-gate.service.js'
import type { UserPrincipal } from '../../agents/call-tool.js'
import { decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { BRAIN_CAMPAIGN_TOOL, ENGINE_TOOL, HARVEST_TOOLS } from './constants.js'

export interface RequestAnswer {
  changeSetId: string
  status: 'queued' | 'scheduled' | 'runs_by_rule'
  expiresAt: string | null
  executeAfter?: string | null
  approve?: { ok: boolean; code?: string; error?: string }
}

/** Ask for one apply-harvest request (op harvest or undo) as this person; `approve` approves it in the same click. */
export async function requestHarvestTool(args: Record<string, unknown>, person: UserPrincipal, opts: { approve?: boolean; code?: unknown } = {}): Promise<{ data: RequestAnswer } | { error: string; status: 400 | 409 }> {
  const asked = await requestApproval(ENGINE_TOOL, args, person)
  if (!asked.ok || asked.mode !== 'queued' || !asked.approvalId) {
    const error = asked.error ?? 'Not queued: the request answered without a change set.'
    return { error, status: /moved since your review/.test(error) ? 409 : 400 }
  }
  const base: RequestAnswer = {
    changeSetId: asked.approvalId,
    status: asked.rule?.by === 'rule' ? 'runs_by_rule' : 'queued',
    expiresAt: asked.expiresAt?.toISOString() ?? null,
    ...(asked.rule?.by === 'rule' ? { executeAfter: asked.rule.executeAfter } : {}),
  }
  if (opts.approve === true && base.status === 'queued') {
    const why = typeof args.why === 'string' ? args.why : undefined
    const out = await decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: person, code: opts.code, reason: why })
    return { data: { ...base, status: out.ok ? 'scheduled' : 'queued', ...(out.executeAfter ? { executeAfter: out.executeAfter } : {}), approve: { ok: out.ok, ...(out.code ? { code: out.code } : {}), ...(out.error ? { error: out.error } : {}) } } }
  }
  return { data: base }
}

/**
 * Decide harvest requests that wait (the page's "Waiting for you"): only harvest requests (apply-harvest, apply-brain-harvest,
 * the older names, a harvest rule's ask — see M4 below,
 * and the brain's create-ad-campaign for a harvest), each through the Approvals page's own path, as this person.
 */
export async function decideHarvestRequests(decisions: ReadonlyArray<{ approvalId: string; decide: 'approve' | 'reject'; code?: string }>, person: UserPrincipal, reason?: string) {
  const ids = [...new Set(decisions.map((d) => d.approvalId))]
  const rows = await prisma.agentApproval.findMany({ where: { id: { in: ids } }, select: { id: true, toolName: true, agentRun: { select: { agentKey: true } } } })
  const known = new Map(rows.map((r) => [r.id, r]))
  // M4 — a harvest rule's ask (a pending card of promote_to_exact / harvest_and_negate) is decided here too: approve = the
  // rule's card applied as this person (the Suggestions page's own apply), reject = dismissed.
  const askIds = ids.filter((id) => !known.has(id))
  const asks = new Map((askIds.length ? await prisma.adsRuleSuggestion.findMany({ where: { id: { in: askIds } }, select: { id: true, status: true, proposedAction: true } }) : [])
    .filter((a) => ['promote_to_exact', 'harvest_and_negate'].includes(String((a.proposedAction as { type?: unknown } | null)?.type ?? ''))).map((a) => [a.id, a]))
  const results: Array<{ approvalId: string; ok: boolean; status?: string; executeAfter?: string | null; error?: string; code?: string }> = []
  for (const d of decisions) {
    const ask = asks.get(d.approvalId)
    if (ask) {
      if (ask.status !== 'pending') { results.push({ approvalId: d.approvalId, ok: false, error: `This rule's ask is ${ask.status} already.` }); continue }
      const { applySuggestion, dismissSuggestion } = await import('../ads-suggestion-decide.service.js')
      const out = d.decide === 'approve' ? await applySuggestion(d.approvalId, {}, 'operator', { operatorApproved: true }) : await dismissSuggestion(d.approvalId, 'operator')
      // A card the rule's handler passed over stays waiting: said, never counted as applied.
      const done = out.ok && !out.skipped && !out.refused
      results.push({ approvalId: d.approvalId, ok: done, ...(done ? { status: d.decide === 'approve' ? 'applied' : 'dismissed' } : { error: String(out.error ?? 'not decided') }) })
      continue
    }
    const r = known.get(d.approvalId)
    const isHarvest = !!r && HARVEST_TOOLS.includes(r.toolName) && (r.toolName !== BRAIN_CAMPAIGN_TOOL || String(r.agentRun?.agentKey ?? '').startsWith('ads-brain-harvest'))
    if (!isHarvest) { results.push({ approvalId: d.approvalId, ok: false, error: 'No harvest request waits with this id in this business.' }); continue }
    const out = await decideFleetApproval({ id: d.approvalId, decision: d.decide, actor: person, code: d.code, reason })
    results.push({ approvalId: d.approvalId, ok: out.ok, ...(out.ok ? { status: d.decide === 'approve' ? 'scheduled' : 'rejected' } : {}), ...(out.executeAfter ? { executeAfter: out.executeAfter } : {}), ...(out.error ? { error: out.error } : {}), ...(out.code ? { code: out.code } : {}) })
  }
  return { results }
}
