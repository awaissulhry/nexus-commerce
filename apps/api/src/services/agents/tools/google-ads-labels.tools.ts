/**
 * Google Ads changes, G5 (2026-10-15, Owner's brief "full control of Google Ads through Nexus") — labels. Every tool here
 * is a Nexus change: a preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs
 * as that person (google-ads-kit.ts). Never by rule.
 *
 *   set-google-labels      make labels, change a label's name / description / colour, put labels on campaigns, ad groups,
 *                          ads and keywords and take them off — one request; undo puts it back (a label it made stays)
 *   remove-google-labels   remove labels for good — only when the person asked for that removal; never undone
 *
 * A label changes nothing that serves: nothing here spends money.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder } from './google-ads-kit.js'
import {
  LABEL_COLOR, LABEL_DESCRIPTION_MAX, LABEL_NAME_MAX, labelChangeDraft, labelRecordAfterRun, labelRemoveDraft, NEW_LABEL,
  type LabelChangeRecord, type LabelChangeRequest,
} from '../../marketing/google-ads/change-labels.js'
import { LABEL_TARGET_KINDS, liveLabelLinks, liveLabels, type LabelTargetKind } from '../../marketing/google-ads/live-labels.js'
import { liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveStatuses } from '../../marketing/google-ads/live-campaigns.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

const kindArg = z.enum(['campaign', 'ad-group', 'ad', 'keyword']).describe('what the label goes on: campaign, ad-group, ad or keyword')
const itemIdArg = z.string().trim().regex(/^\d{1,20}(~\d{1,20})?$/)
  .describe('the item\'s id (google-ads-live): a campaign or ad group id; an ad adGroupId~adId; a keyword adGroupId~criterionId')
const nameArg = z.string().trim().min(1).max(LABEL_NAME_MAX).describe(`the label's name (1 to ${LABEL_NAME_MAX} characters, unique in the account)`)
const descriptionArg = z.string().max(LABEL_DESCRIPTION_MAX).describe(`a short description (at most ${LABEL_DESCRIPTION_MAX} characters; '' clears it)`)
const colorArg = z.union([z.literal(''), z.string().trim().regex(LABEL_COLOR)]).describe('the background colour, #rrggbb or #rgb (\'\' clears it)')

// ── set-google-labels ───────────────────────────────────────────────────────────────────────────────────────────

const labelRequest = (args: Record<string, unknown>): LabelChangeRequest => ({
  create: args.create as LabelChangeRequest['create'],
  edit: args.edit as LabelChangeRequest['edit'],
  attach: args.attach as LabelChangeRequest['attach'],
  detach: args.detach as LabelChangeRequest['detach'],
})

const buildLabels = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = labelRequest(args)
  const attach = request.attach ?? []
  const detach = request.detach ?? []
  const labels = await liveLabels(account.target)
  const named = [...(request.edit ?? []).map((e) => e.labelId), ...attach.map((a) => a.labelId), ...detach.map((d) => d.labelId)]
  const known = new Set(labels.map((l) => l.labelId))
  const involved = named.filter((id): id is string => !!id && known.has(id))
  const kinds = LABEL_TARGET_KINDS.filter((k) => [...attach, ...detach].some((x) => x.kind === k))
  const links = await liveLabelLinks(account.target, involved, kinds)
  const onKind = (k: LabelTargetKind) => attach.filter((a) => a.kind === k).map((a) => a.id)
  const campaigns = onKind('campaign').length ? await liveCampaigns(account.target) : []
  const ask = { adGroups: onKind('ad-group').filter((id) => /^\d+$/.test(id)), keywords: onKind('keyword'), ads: onKind('ad') }
  const items = ask.adGroups.length + ask.keywords.length + ask.ads.length ? await liveStatuses(account.target, ask) : []
  return labelChangeDraft(customerResource(account.target), request, { labels, links, campaigns, items })
}

const labelsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LabelChangeRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const labels = await liveLabels(account.target)
    const byId = new Map(labels.map((l) => [l.labelId, l]))
    const linkIds = [...after.attached, ...after.detached].map((l) => l.labelId).filter((id) => byId.has(id))
    const kinds = LABEL_TARGET_KINDS.filter((k) => [...after.attached, ...after.detached].some((x) => x.kind === k))
    const links = new Set((await liveLabelLinks(account.target, linkIds, kinds)).map((l) => `${l.labelId}|${l.kind}|${l.id}`))
    const has = (l: { labelId: string; kind: string; id: string }) => links.has(`${l.labelId}|${l.kind}|${l.id}`)
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      created: after.created.filter((c) => byId.has(c.labelId)),
      edited: after.edited.filter((e) => {
        const now = byId.get(e.labelId)
        return !!now && now.name === e.name && (now.description ?? null) === e.description && (now.color ?? '').toLowerCase() === (e.color ?? '').toLowerCase()
      }),
      attached: after.attached.filter(has),
      detached: after.detached.filter((l) => !has(l)),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Partial<LabelChangeRecord> & { accountId?: string }
    const after = (change.after ?? {}) as Partial<LabelChangeRecord> & { accountId?: string }
    const edited = before.edited ?? []
    const attached = after.attached ?? []
    const detached = after.detached ?? []
    if ([...attached, ...detached].some((l) => l.labelId.startsWith(NEW_LABEL))) return { refusal: 'This change does not record the id of a label it made.' }
    if (!edited.length && !attached.length && !detached.length) {
      return { refusal: 'This change only made labels: there is nothing to put back (a label changes nothing by itself; remove-google-labels removes it).' }
    }
    const accountId = after.accountId ?? before.accountId
    return {
      tool: 'set-google-labels',
      args: {
        ...(accountId ? { accountId } : {}),
        ...(edited.length ? { edit: edited.map((e) => ({ labelId: e.labelId, name: e.name, description: e.description ?? '', color: e.color ?? '' })) } : {}),
        ...(attached.length ? { detach: attached } : {}),
        ...(detached.length ? { attach: detached.map((l) => ({ labelId: l.labelId, kind: l.kind, id: l.id })) } : {}),
        why: `undo of an earlier label change${(after.created ?? []).length ? ' (the labels it made stay)' : ''}`,
      },
    }
  },
}

const setGoogleLabels: AgentTool = {
  ...common,
  name: 'set-google-labels',
  title: 'Change Google Ads labels',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    create: z.array(z.object({ name: nameArg, description: descriptionArg.optional(), color: colorArg.optional() })).max(20).optional()
      .describe('new labels (attach can put them on items in the same request, by newLabel)'),
    edit: z.array(z.object({ labelId: googleIdArg('the label'), name: nameArg.optional(), description: descriptionArg.optional(), color: colorArg.optional() })).max(20).optional()
      .describe('a new name, description or colour of existing labels'),
    attach: z.array(z.object({
      labelId: googleIdArg('an existing label').optional(),
      newLabel: z.string().trim().min(1).max(LABEL_NAME_MAX).optional().describe('or: the name of a label of create'),
      kind: kindArg,
      id: itemIdArg,
    })).max(250).optional().describe('labels to put on items (already there: skipped)'),
    detach: z.array(z.object({ labelId: googleIdArg('the label'), kind: kindArg, id: itemIdArg })).max(250).optional()
      .describe('labels to take off items'),
    why: googleWhyArg,
  }),
  description:
    'Google Ads labels of the business\'s chosen account: make labels (create), change a label\'s name, description or '
    + 'colour (edit), and put labels on campaigns, ad groups, ads and keywords or take them off (attach, detach) — all in '
    + 'one request. A label changes nothing that serves (nothing here spends money); a rule or script in Google Ads that '
    + 'picks items by label would act on them. A label cannot go on a negative keyword. Undo puts names, colours and '
    + 'links back (a label it made stays). To delete a label use remove-google-labels.' + GOOGLE_CHANGE_RULES,
  undo: labelsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildLabels(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildLabels(args), (draft, responses) => {
    const after = labelRecordAfterRun(draft.after as LabelChangeRecord, responses)
    return { data: { created: after.created, attached: after.attached.length, detached: after.detached.length }, before: draft.before, after }
  }),
}

// ── remove-google-labels ────────────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const labelIds = (args.labelIds as string[] | undefined) ?? []
  const labels = await liveLabels(account.target)
  const known = labelIds.filter((id) => labels.some((l) => l.labelId === id))
  const links = await liveLabelLinks(account.target, known, LABEL_TARGET_KINDS)
  return labelRemoveDraft(customerResource(account.target), labelIds, { labels, links })
}

const removeGoogleLabels: AgentTool = {
  ...common,
  name: 'remove-google-labels',
  title: 'Remove Google Ads labels (for good)',
  reversibility: 'none',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    labelIds: z.array(googleIdArg('a label')).min(1).max(50).describe('the labels to remove'),
    confirmRemove: z.literal(true).describe('true: the person asked for exactly this removal'),
    why: googleWhyArg,
  }),
  description:
    'REMOVE (delete) labels of the business\'s chosen Google Ads account. Use it ONLY when the person asked for that '
    + 'removal (confirmRemove true). The preview says what carries each label: it comes off them. Nothing that serves '
    + 'changes. A removal cannot be undone (a new label with the same name is another label).' + GOOGLE_CHANGE_RULES,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRemove(args), (draft) => ({ data: { removed: (draft.after as { removed: unknown[] }).removed }, before: draft.before, after: draft.after })),
}

export const GOOGLE_ADS_LABELS_TOOLS: AgentTool[] = [setGoogleLabels, removeGoogleLabels]
