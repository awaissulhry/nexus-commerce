/**
 * MCP full control A4–A10 (docs/mcp-full-control/sections/01-ads.md §3 "Rules every change tool follows") — what
 * every Amazon ad change tool does the same way, in its dry run (`handler`) and again in `execute`, on top of the A3
 * guards (ads-tool-guards.ts):
 *
 *   run as         an approved request only: `execute` needs the approval it carries out (`ToolContext.approvalId`),
 *                  writes as the person who approved it (`user:<approverId>`), names the request in the audit
 *                  (`Claude request <approvalId>: <why>`), and stamps every write with `changeSetId = approvalId` —
 *                  so delivery (approval-status) and undo find exactly its rows.
 *   live reach     the preview stores where the write would land (live, on which Amazon Ads profile, or sandbox); a
 *                  refusal is not queued. `execute` checks again and refuses when the answer changed (d2 = A: live
 *                  only on a campaign already on the live-write allowlist — the gate's own default-deny).
 *   pre-switch     a request queued before these tools could run carries no stored reach: it is never run (d1 = A),
 *                  and the approval sweep expires it (approval-inbox.service.ts).
 *   stale          `execute` re-runs the dry run and refuses when a starting value the person approved has moved.
 *   SP only        phase 1 changes Sponsored Products campaigns only.
 */
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { boundAutomationsFor, claudeActor, claudeReason, type BoundAutomation, type LiveReach } from './ads-tool-guards.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

// ── Running as an approved request ────────────────────────────────────────────────────────────────

export interface ApprovedRun {
  actor: AdsActor
  reason: string
  changeSetId: string
}

/** The actor, the audit reason and the change set an approved run writes with — or why it may not run. */
export function approvedRun(ctx: ToolContext, why: string): ApprovedRun | { refusal: string } {
  const approvalId = ctx.approvalId?.trim()
  if (!approvalId) return { refusal: 'an ad change runs only as an approved request (no approval was handed to it)' }
  const approver = ctx.userId?.trim()
  if (!approver) return { refusal: 'an approved ad change runs as the person who approved it, and this run names no person' }
  const said = why.trim() || 'no reason given'
  const reason = ctx.via === 'claude'
    ? claudeReason(approvalId, said)
    : `${ctx.via === 'fleet' ? 'Fleet request' : 'Approved request'} ${approvalId}: ${said}`
  return { actor: claudeActor(approver), reason, changeSetId: approvalId }
}

// ── Live reach, stored with the preview ───────────────────────────────────────────────────────────

/** Where an approved write lands, as the preview stores it: never a refusal (a refused request is not queued). */
export type StoredReach = { reach: 'live'; profileId: string } | { reach: 'sandbox' }

export function storedReach(reach: Exclude<LiveReach, { reach: 'refused' }>): StoredReach {
  return reach.reach === 'live' ? { reach: 'live', profileId: reach.profileId } : { reach: 'sandbox' }
}

/** The sentence the approver reads beside the change. */
export function reachNote(reach: StoredReach): string {
  return reach.reach === 'live'
    ? `live: after approval it is sent to Amazon (Amazon Ads profile ${reach.profileId}).`
    : 'sandbox: after approval it is recorded in Nexus only. Amazon ads writes are not live, so nothing reaches Amazon.'
}

/** What to do about a refusal, by the gate's own reason code. */
const UNBLOCK: Record<string, string> = {
  campaign_allowlist: 'Only campaigns on the live-write allowlist take approved changes: ask for set-campaign-live-writes first.',
  authority_pin: 'Someone holds this by hand (a pin): it is lifted in Nexus, not here.',
  automation_halted: 'Ads automation is stopped: it is resumed in the Ads Control Room.',
  entity_bounds: 'The campaign\'s own bid or budget bounds refuse this value: ask for a value inside them.',
  connection: 'No production Amazon Ads connection with writes enabled serves this market.',
  connection_writes: 'Writes are not enabled for this Amazon Ads profile.',
  keyword_protected: 'The term is protected against negation.',
  spend_ceiling: 'A spend ceiling refuses a raise this large today.',
  budget_day_move: 'The budget has already moved as far as allowed today.',
  value_cap: 'The value is above the cap for one write.',
}

/** A refused request, said plainly: not queued, why, and what would unblock it. */
export function reachRefusal(reach: Extract<LiveReach, { reach: 'refused' }>): string {
  return `Not queued: Amazon's write gate refuses it — ${reach.reason}. ${UNBLOCK[reach.deniedAt] ?? ''}`.trim()
}

/** The reach the person approved, from the stored preview; null for a request made before these tools could run. */
export function approvedReachOf(approvedPreview: unknown): StoredReach | null {
  const reach = (approvedPreview as { reach?: unknown } | null | undefined)?.reach as StoredReach | undefined
  if (!reach || typeof reach !== 'object') return null
  if (reach.reach === 'live' && typeof reach.profileId === 'string') return { reach: 'live', profileId: reach.profileId }
  if (reach.reach === 'sandbox') return { reach: 'sandbox' }
  return null
}

/** Refuses a run whose request was made before ad changes could run (d1): it is never run, and the sweep expires it. */
export const PRE_SWITCH_REFUSAL = 'Not run: this request was made before approved ad changes could reach Amazon. Ask for it again; the new request shows where it lands.'

/** The JSON of a value, keys sorted (jsonb re-orders keys), for comparing a stored preview with a fresh one. */
export function canonical(value: unknown): string {
  const plain = JSON.stringify(value ?? null)
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(plain)))
}

/**
 * `execute`'s re-check, on every approve path: the request was made after the switch, the dry run still passes, the
 * write still lands where the person was told, and none of the starting values they approved moved. Null when it may
 * run; otherwise the sentence that refuses it.
 */
export function recheck(ctx: ToolContext, fresh: ToolResult, material: readonly string[]): string | null {
  const approved = approvedReachOf(ctx.approvedPreview)
  if (!approved) return PRE_SWITCH_REFUSAL
  if (!fresh.ok) return `Not run: ${fresh.error ?? 'it is no longer a valid change'}`
  const now = (fresh.preview ?? {}) as Record<string, unknown>
  const before = (ctx.approvedPreview ?? {}) as Record<string, unknown>
  if (canonical(now.reach) !== canonical(approved)) {
    const said = (r: unknown) => ((r as StoredReach | undefined)?.reach === 'live' ? `live (profile ${(r as { profileId: string }).profileId})` : 'sandbox')
    return `Not run: it was approved as ${said(approved)}, and it would now be ${said(now.reach)}.`
  }
  const moved = material.filter((key) => key in before && canonical(before[key]) !== canonical(now[key]))
  if (moved.length) return `Not run: what you approved has moved since — ${moved.join(', ')} changed. Ask for it again with the values as they are now.`
  return null
}

// ── Shared facts ──────────────────────────────────────────────────────────────────────────────────

/** Phase 1 changes Sponsored Products campaigns only (SB negatives are blocked upstream; SD has none). */
export function spOnlyRefusal(campaign: { type?: string | null; adProduct?: string | null; name?: string | null }): string | null {
  const sp = campaign.adProduct ? campaign.adProduct === 'SPONSORED_PRODUCTS' : String(campaign.type ?? '') === 'SP'
  return sp ? null : `${campaign.name ?? 'This campaign'} is not a Sponsored Products campaign; Claude changes Sponsored Products campaigns only for now.`
}

/** The enabled rules and schedules bound to the campaign: they may change it again after this change. */
export async function alsoChangedBy(campaignId: string): Promise<{ automations: BoundAutomation[]; note: string | null }> {
  const automations = (await boundAutomationsFor(campaignId)).slice(0, 10)
  return {
    automations,
    note: automations.length ? `${automations.length} enabled rule${automations.length === 1 ? '' : 's'} or schedule${automations.length === 1 ? '' : 's'} bound to this campaign may change it again.` : null,
  }
}

/**
 * The bid the mutation service will actually write for a requested one: the campaign's max-change-% guardrail
 * (`dynamicBidding.maxBidChangePct`, ads-mutation.service.ts updateAdTargetWithSync), applied to the current bid. The
 * same arithmetic, so the preview shows the value that lands.
 */
export function changeClampedBid(currentBidCents: number, wantedCents: number, dynamicBidding: unknown): number {
  const pct = Number((dynamicBidding as { maxBidChangePct?: unknown } | null)?.maxBidChangePct)
  if (!(currentBidCents > 0) || !Number.isFinite(pct) || pct <= 0) return wantedCents
  const maxUp = Math.round(currentBidCents * (1 + pct / 100))
  const maxDown = Math.round(currentBidCents * (1 - pct / 100))
  return Math.max(5, Math.min(maxUp, Math.max(maxDown, wantedCents)))
}

/** An approved run that could not run, as the gate expects it (ok:false; the request goes back to waiting). */
export const notRun = (error: string): ToolResult => ({ ok: false, error })
