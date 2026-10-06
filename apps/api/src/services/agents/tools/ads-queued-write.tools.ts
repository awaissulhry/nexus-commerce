/**
 * ADS AUTONOMY W3-2 — cancel-queued-ad-write: Claude asks to cancel an Amazon ad write Nexus queued and has not sent
 * yet (inside its grace window), as the staged-changes tray's Discard does (ads-queued-write.service.ts). A brake:
 * nothing reaches Amazon, and a cancel never makes a write.
 *
 *   names        its preview names every write it cancels (field from → to, on what, queued by whom, the change set,
 *                whether that is a Claude request, when the window ends) and every one it cannot (sent, being sent,
 *                window over), with why; a lowering it cancels is said too (today's value stays)
 *   limits       allowCancelOthers (off by default): by the business's rule Claude cancels only writes a Claude request
 *                queued; a write a person, a rule or an engine queued waits for a person
 *   re-check     execute re-runs the plan: a write that moved or left the queue since makes it stale (approval gate)
 *   undo         when it cancelled ALL of one request (not a change plan), undo asks for that request again, through its
 *                own tool and approval; otherwise the writes are asked for again with their own tools
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolUndo } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

interface CancelChange {
  before: { writes: Array<{ queueId: string; label: string }>; request: { approvalId: string; tool: string; args: Record<string, unknown> } | null }
  after: { cancelled: string[] }
}

/** C2 — a cancel is put back by asking for the cancelled request again, when it cancelled all of one. */
export const CANCEL_UNDO: ToolUndo = {
  async current(change) {
    const { stillCancelled } = await import('../../advertising/ads-queued-write.service.js')
    return { cancelled: await stillCancelled((change.after as CancelChange['after']).cancelled ?? []) }
  },
  request(change) {
    const before = change.before as CancelChange['before']
    if (before.request) return { tool: before.request.tool, args: before.request.args }
    return { refusal: 'The cancelled writes were not the whole of one Claude request: ask for each again with its own tool (set-target-bid, bulk-ad-bid-change, set-campaign-budget, …).' }
  },
}

const cancelQueuedAdWrite: AgentTool = {
  name: 'cancel-queued-ad-write',
  title: 'Cancel a queued ad write',
  category: 'advertising',
  description:
    'Cancel an Amazon ad write Nexus queued and has not sent yet — a bid, a budget, a status, a placement — while it ' +
    'waits in its grace window (about 5 minutes after it was queued), as the staged changes\' Discard does: one write by ' +
    'outboundQueueId, or every write of one request still waiting by changeSetId (a Claude request\'s approval id, as ' +
    'approval-status names it). Nexus only: nothing reaches Amazon, and Nexus puts each field back where it still holds ' +
    'the cancelled value. The preview names every write it cancels (from → to, on what, who queued it, when its window ' +
    'ends) and every one it cannot (sent, being sent, window over). Cancelling a lowering keeps today\'s bid, budget or ' +
    'status, and the preview says so. Waits for a person to approve it in Nexus, unless the business lets Claude run it ' +
    'by its rule inside its limits — by default only for writes a Claude request queued, never one a person, a rule or ' +
    'an engine queued. Approved after the window, a write already sent is not cancelled.',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: z.object({
    allowCancelOthers: z.boolean().default(false).describe('let Claude cancel, by rule, a write a person, a rule or an engine queued (not only its own requests); never by default'),
  }),
  withinLimits(preview, limits) {
    const p = preview as { writes?: Array<{ label?: string; byClaude?: boolean; queuedBy?: string }> } | null
    if (!Array.isArray(p?.writes) || !p.writes.length) return 'there is no preview of the writes this cancels to check'
    const others = p.writes.filter((w) => w.byClaude !== true)
    if (others.length && !limits.allowCancelOthers) {
      return `it cancels ${others.length === 1 ? 'a write' : `${others.length} writes`} not queued by a Claude request (${others.slice(0, 3).map((w) => `${w.label}, by ${w.queuedBy}`).join('; ')}): a person decides`
    }
    return null
  },
  undo: CANCEL_UNDO,
  input: z.object({
    outboundQueueId: ID.optional().describe('the queued write to cancel (its outbound queue row id)'),
    changeSetId: ID.optional().describe('cancel every write of this request still waiting (a Claude request\'s approval id); with outboundQueueId, only that write, when it is of this request'),
    why: z.string().trim().min(3).max(300).describe('why, in a sentence: shown to the person who approves it'),
  }),
  async handler(args) {
    const { planCancelQueuedWrites } = await import('../../advertising/ads-queued-write.service.js')
    const planned = await planCancelQueuedWrites({ outboundQueueId: args.outboundQueueId as string | undefined, changeSetId: args.changeSetId as string | undefined })
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: planned.plan }
  },
  async execute(args) {
    const { cancelQueuedWrites, planCancelQueuedWrites } = await import('../../advertising/ads-queued-write.service.js')
    const planned = await planCancelQueuedWrites({ outboundQueueId: args.outboundQueueId as string | undefined, changeSetId: args.changeSetId as string | undefined })
    if ('error' in planned) return { ok: false, error: `Not cancelled — ${planned.error}` }
    const out = await cancelQueuedWrites(planned.plan.writes)
    if (!out.cancelled.length) return { ok: false, error: `Not cancelled — ${out.failed.map((f) => `${f.label}: ${f.why}`).join('; ')}.` }
    // The undo asks for the request again only when every write of it was cancelled here.
    const whole = !out.failed.length ? planned.source : null
    return {
      ok: true,
      data: { cancelled: out.cancelled, ...(out.failed.length ? { notCancelled: out.failed } : {}), effect: 'Nothing was sent to Amazon for the cancelled writes.' },
      change: {
        before: { writes: planned.plan.writes.map((w) => ({ queueId: w.queueId, label: w.label })), request: whole ? { approvalId: whole.approvalId, tool: whole.tool, args: whole.args } : null },
        after: { cancelled: out.cancelled.map((c) => c.queueId) },
      },
    }
  },
}

export const ADS_QUEUED_WRITE_TOOLS: AgentTool[] = [cancelQueuedAdWrite]
