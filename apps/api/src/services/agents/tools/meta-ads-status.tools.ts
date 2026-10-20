/**
 * Meta ads changes, step 17 (write base) — set-meta-status: pause, switch on or archive campaigns, ad sets and ads of the
 * business's chosen Meta ad account (master rows CMP-047–049, AS-033–035, AD-039–041). A Nexus change like every other
 * Meta change (meta-ads-kit.ts): a preview from the live state (Meta checks the campaign requests, validate_only), an
 * approvalId, a person approves it, it runs as that person request by request, and undo puts back what it changed.
 *
 * Deleting is not here: it is its own tool (master step 22), only on the person's explicit ask.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { statusDraft, type StatusRecord, type StatusRequest } from '../../marketing/meta-ads/change-status.js'
import { liveStatusObjects } from '../../marketing/meta-ads/live-status.js'
import { recordStatusReadBack } from '../../marketing/meta-ads/store.js'

const STATUSES = ['PAUSED', 'ACTIVE', 'ARCHIVED'] as const
const statusArg = z.enum(STATUSES)

const statusRequest = (args: Record<string, unknown>): StatusRequest => ({ items: (args.items as StatusRequest['items']) ?? [], status: args.status as StatusRequest['status'] })

const buildStatus = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const request = statusRequest(args)
  return statusDraft(request, await liveStatusObjects(account.target, request.items))
}

/** Undo: the statuses it replaced go back where both were live (PAUSED ⇄ ACTIVE); an archive stays (Meta cannot undo one). */
const statusUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as StatusRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const items = after.items ?? []
    const live = await liveStatusObjects(account.target, items.map((i) => ({ kind: i.kind, id: i.id })))
    return {
      items: items.map((i) => ({ kind: i.kind, id: i.id, status: live.objects.get(`${i.kind}:${i.id}`)?.status ?? null })),
      accountId: account.accountId,
      adAccountId: account.adAccountId,
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as StatusRecord & { accountId?: string }
    const after = (change.after ?? {}) as StatusRecord
    const wrote = new Map((after.items ?? []).map((i) => [`${i.kind}:${i.id}`, i.status]))
    const live = (s: string | null | undefined) => s === 'ACTIVE' || s === 'PAUSED'
    const back = (before.items ?? []).filter((i) => live(i.status) && live(wrote.get(`${i.kind}:${i.id}`)))
    const archived = (before.items ?? []).length - back.length
    if (!back.length) {
      return { refusal: 'This change archived what it changed: Meta lets an archived campaign, ad set or ad only be deleted, never switched on or paused again, so there is nothing to put back.' }
    }
    return {
      tool: 'set-meta-status',
      args: {
        ...(before.accountId ? { connectionId: before.accountId } : {}),
        items: back.map((i) => ({ kind: i.kind, id: i.id, status: i.status as 'ACTIVE' | 'PAUSED' })),
        why: `undo of an earlier Meta status change${archived ? ` (what it archived stays archived: Meta cannot switch an archived item on again)` : ''}`,
      },
    }
  },
}

const setMetaStatus: AgentTool = {
  name: 'set-meta-status',
  title: 'Pause, switch on or archive Meta ads',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Pausing and switching on are undone in full; an archive cannot be (Meta: archived → only deleted).
  reversibility: 'partial',
  consequencesFor: (args) => {
    const items = Array.isArray(args.items) ? (args.items as Array<{ status?: string }>) : []
    const statuses = items.map((i) => i.status ?? (args.status as string | undefined))
    return statuses.length && statuses.every((s) => s === 'PAUSED' || s === 'ACTIVE') ? { reversibility: 'full' } : null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    items: z.array(z.object({
      kind: z.enum(['campaign', 'adset', 'ad']).describe('campaign, adset or ad'),
      id: metaIdArg('its id'),
      status: statusArg.optional().describe('its status from now: PAUSED, ACTIVE (switch on) or ARCHIVED (for good); default: the request\'s status'),
    })).min(1).max(20).describe('what to pause, switch on or archive (at most 20: Meta\'s Limited access tier takes about 20 changes per 5 minutes)'),
    status: statusArg.optional().describe('the status for every item that names none'),
    why: metaWhyArg,
  }),
  description:
    'Pause, switch on (ACTIVE) or archive campaigns, ad sets and ads of the business\'s chosen Meta ad account, by their '
    + 'Meta ids (meta-ads-live or meta-ads-overview shows them; the kind must be right — Meta confirms it). One request per '
    + 'object, in order: pauses and archives first, then what is switched on, ads before ad sets before campaigns. Pausing '
    + 'is a safe step (a paused campaign\'s ad sets and ads stop with it, and come back when it is switched on again). '
    + 'SWITCHING ON is the person\'s decision and always marked SPENDS MONEY — the line says when a parent is still off, so '
    + 'nothing spends yet. ARCHIVING is for good: Meta lets an archived item only be deleted afterwards, never switched on '
    + 'again, and a campaign\'s ad sets and ads are archived with it. A deleted item, a rejected ad (switching on), an ad set '
    + 'past its end time (switching on) and an ad in a sequenced ad set (pause, archive) are refused in Meta\'s words. No '
    + 'status change sends an ad back to review. Deleting is not here. Undo puts back the statuses it replaced (an archive '
    + 'stays); Meta takes a change of the same object only 30 s after the last one, so Nexus waits that out.'
    + META_CHANGE_RULES,
  undo: statusUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildStatus(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildStatus(args), (draft, done) => {
    const before = draft.before as StatusRecord
    const wanted = new Set(done.map(({ request }) => `${request.kind}:${request.objectId}`))
    const readBack = new Map(done.map(({ request, result }) => [`${request.kind}:${request.objectId}`, typeof result.node?.status === 'string' ? result.node.status : request.params.status]))
    const items = before.items.filter((i) => wanted.has(`${i.kind}:${i.id}`))
    return {
      data: { items: items.map((i) => ({ kind: i.kind, id: i.id, from: i.status, to: readBack.get(`${i.kind}:${i.id}`) ?? null })) },
      before: { items },
      after: { items: items.map((i) => ({ kind: i.kind, id: i.id, status: readBack.get(`${i.kind}:${i.id}`) ?? null })) },
    }
  }, async (account, done) => {
    const rows = await recordStatusReadBack(account.adAccountId, done.map(({ request, result }) => ({
      kind: request.kind,
      id: request.objectId,
      status: typeof result.node?.status === 'string' ? result.node.status : request.params.status,
      effectiveStatus: typeof result.node?.effective_status === 'string' ? result.node.effective_status : null,
    })))
    return rows
      ? 'Nexus\'s Meta pages show the new status now (read back from Meta); the ad sets and ads below a changed campaign or ad set show theirs after the next daily read (meta-ads-live shows them now).'
      : 'Nexus has not read these objects yet: they appear after the next daily read (meta-ads-live shows them now).'
  }),
}

export const META_ADS_STATUS_TOOLS: AgentTool[] = [setMetaStatus]
