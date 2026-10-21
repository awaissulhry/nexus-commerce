/**
 * Meta ads changes, step 30 part 2 — webhook subscriptions and alert subscriptions of the business's Meta app and chosen
 * ad account (master rows WH-005, 007–010, 012, 013, 051–054, 056, 057; the receiver is part 1):
 *   set-meta-webhooks                the app's webhook subscription of one object (fields, Nexus's receiver as the
 *                                    callback, include_values; app-wide), the chosen ad account connected to the app, the
 *                                    app installed on or removed from the chosen Page (part 3: installing with the Page's
 *                                    own token, step 36's mode; also the Instagram account's per-account step, WH-013);
 *                                    Instagram / WhatsApp fields only in the App Dashboard
 *   set-meta-alert-subscription      a new alert on the ad account (a new object, a setting changing, a metric crossing a
 *                                    threshold, a milestone), or one switched on / off
 *   remove-meta-alert-subscription   an alert removed (only on the person's explicit ask)
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it replaced. None of them can make the account spend.
 * The Owner may as well set webhooks up in Meta's App Dashboard (Webhooks of the app): meta-webhooks reads the result.
 * Meta's own MCP has no tool for these.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { metaChosenAccount, MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { liveAdAccountApps, liveAlertSubscription, liveAppSubscriptions, livePageApps, livePageInstagram } from '../../marketing/meta-ads/live-webhook-setup.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { metaAppUsers } from '../../marketing/meta-ads/webhook-receiver.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { webhooksDraft, WEBHOOK_ACTIONS, WEBHOOK_OBJECT_NAMES, type WebhooksLive, type WebhooksRecord, type WebhooksRequest } from '../../marketing/meta-ads/change-webhooks.js'
import { alertCreateDraft, alertRemoveDraft, alertStatusDraft, type AlertRecord, type AlertSpecArgs } from '../../marketing/meta-ads/change-alert-subscriptions.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'
import { metaAppIdOf } from '../../cx/token.service.js'
import {
  ALERT_ENTITY_TYPES, ALERT_EVENT_TYPES, ALERT_FILTER_FIELDS, ALERT_FILTER_OPS, ALERT_METRIC_FIELDS, ALERT_MILESTONE_MINIMUMS, ALERT_OBJECT_FIELDS, ALERT_STATUSES,
  META_WEBHOOK_FIELDS, metaWebhookCallback,
} from '../../gateway/meta-webhook-rules.js'

const ADSPEND = FIELDS.financialsAdspendView

/** A builder that turns a refusal of the live reads into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/**
 * Review A1 / D-1 — how many OTHER businesses in Nexus connect the same Meta app (the receiver's own list: their app ids
 * read in their own business; never a name): an app subscription is app-wide. Null when Nexus could not tell.
 */
async function otherBusinessesOf(appId: string): Promise<number | null> {
  const users = await metaAppUsers(appId, { fresh: true }).catch(() => null)
  if (!users || users.unsure) return null
  const me = workspaceIdForQuery()
  return new Set(users.users.map((u) => u.workspaceId).filter((ws) => ws !== me)).size
}

// ── set-meta-webhooks ───────────────────────────────────────────────────────────────────────────────────────────

const ALL_FIELDS = [...new Set(Object.values(META_WEBHOOK_FIELDS).flat())] as [string, ...string[]]

const webhooksRequest = (args: Record<string, unknown>): WebhooksRequest => ({
  action: args.action as WebhooksRequest['action'],
  ...(typeof args.object === 'string' ? { object: args.object } : {}),
  ...(Array.isArray(args.fields) ? { fields: args.fields as string[] } : {}),
  ...(args.exact === true ? { exact: true } : {}),
})

/** Part 3 — a read the draft can do without (the Page's apps, its Instagram link): Meta's or the gateway's words instead. */
const orProblem = (err: unknown): { error: string } => {
  if (err instanceof MetaReadError) return { error: err.message }
  throw err
}

const buildWebhooks = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  const request = webhooksRequest(args)
  const appId = await metaAppIdOf(account.accountId)
  if (!appId) return { refusal: 'No Meta app id and secret are stored for this connection (a person enters them in Settings › Channels › Meta).' }
  const live: WebhooksLive = { appId, adAccountId: account.adAccountId, pageId: null, callback: metaWebhookCallback(appId), otherBusinesses: 0 }
  if (request.action === 'subscribe-app' || request.action === 'unsubscribe-app') {
    live.app = await liveAppSubscriptions(account.accountId, appId)
    live.otherBusinesses = await otherBusinessesOf(appId)
  } else if (request.action === 'connect-ad-account' || request.action === 'disconnect-ad-account') {
    live.adAccount = await liveAdAccountApps(account.accountId, account.adAccountId, appId)
  } else {
    // install-page / remove-page — the CHOSEN Page; its apps are read with the Page's own token (the gateway's, part 3).
    const chosen = await metaChosenAccount(account.accountId)
    live.pageId = chosen.pageId
    if (chosen.pageId) {
      const pageId = chosen.pageId
      live.page = await livePageApps(account.accountId, pageId, appId).catch(orProblem)
      if (request.action === 'install-page' && request.object === 'instagram') {
        live.instagram = await livePageInstagram(account.accountId, pageId).then((linked) => ({ chosen: chosen.instagramId, linked })).catch(orProblem)
      }
    }
  }
  return webhooksDraft(request, live)
})

/** The run's record: what the change replaced and what it set (the draft's own; Meta answers success only). */
function plainFinish(draft: MetaChangeDraft) {
  const before = draft.before as WebhooksRecord | AlertRecord
  return { data: { ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}) }, before: draft.before, after: draft.after }
}

const webhooksUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as WebhooksRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const appId = await metaAppIdOf(account.accountId)
    if (!appId) return null
    if (after.action === 'subscribe-app' || after.action === 'unsubscribe-app') {
      const current = (await liveAppSubscriptions(account.accountId, appId)).find((s) => s.object === after.object)
      // Review A2 — sorted, as the record is: Meta lists fields in any order.
      return { ...after, fields: current ? [...current.fields].sort() : null }
    }
    if (after.action === 'connect-ad-account' || after.action === 'disconnect-ad-account') {
      return { ...after, connected: (await liveAdAccountApps(account.accountId, account.adAccountId, appId)).connected }
    }
    // install-page / remove-page — the app on the Page the change was of (the chosen one; read with its own token).
    const pageId = (await metaChosenAccount(account.accountId)).pageId
    if (!pageId || pageId !== after.pageId) return { ...after, pageId }
    const page = await livePageApps(account.accountId, pageId, appId)
    return { ...after, fields: page.installed ? page.fields : null }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as WebhooksRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier state.'}` }
    return {
      tool: 'set-meta-webhooks',
      args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...before.undo, why: 'undo of an earlier Meta webhook change' },
    }
  },
}

const setMetaWebhooks: AgentTool = {
  name: 'set-meta-webhooks',
  title: 'Set up Meta webhooks',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // No way back: switching an inactive subscription on again, a foreign callback replaced, a subscription of an app another
  // business uses, fields Nexus's receiver does not take, removing the app from a Page whose apps Nexus could not read.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(WEBHOOK_ACTIONS).describe('subscribe-app / unsubscribe-app: the app\'s webhook subscription of one object (app-wide); connect-ad-account / disconnect-ad-account: the chosen ad account delivers its ads notifications to the app (or stops); install-page / remove-page: the app on / off the chosen Facebook Page (installing with the Page\'s own token)'),
    object: z.enum(WEBHOOK_OBJECT_NAMES).optional().describe('subscribe-app, unsubscribe-app: ad_account (ads notifications), application (account status, trigger rules, app alerts), page (leads, comments, messages), catalog (batches, feeds), permissions; instagram and whatsapp_business_account fields are set only in Meta\'s App Dashboard. install-page: none, or instagram — the per-account step of the chosen Instagram account (its linked Page, which must be the chosen Page)'),
    fields: z.array(z.enum(ALL_FIELDS)).min(1).max(40).optional().describe('subscribe-app: the object\'s fields (default: every field Nexus\'s receiver takes for it); unsubscribe-app: only these (default: the whole object); install-page: the Page\'s fields (default: every page field Nexus\'s receiver takes), added to the ones it has'),
    exact: z.boolean().optional().describe('install-page: the Page\'s fields become exactly `fields` (when one must go, the app comes off the Page first and goes on again); default: added to the ones it has'),
    why: metaWhyArg,
  }),
  description:
    'Set up the webhooks of the business\'s Meta app so Meta pushes changes to Nexus\'s receiver (/webhooks/meta/<app id>) '
    + 'instead of Nexus asking: subscribe the app to ONE object\'s fields (ad_account, application, page, catalog, '
    + 'permissions; with the app token, the callback always Nexus\'s own receiver, include_values on; publishing again adds '
    + 'fields, never removes others) or remove them (always naming the object — Meta would otherwise remove every '
    + 'subscription). A subscription is app-wide: when another business in Nexus uses the same Meta app, a subscribe says it '
    + 'changes what that business receives too, and an unsubscribe is refused (the App Dashboard then). Connect the chosen '
    + 'ad account to the app (Meta needs an ADMIN of the ad account: when the system user is not one, Meta refuses and '
    + 'nothing changes) or disconnect it. Install the app on the chosen Facebook Page with its fields (leads, comments, '
    + 'messages …: the Page\'s OWN token, which Nexus reads with the system user — it needs the Manage, Create content or '
    + 'Moderate task on the Page and pages_manage_metadata, pages_show_list; Messenger fields pages_messaging; when it lacks '
    + 'them, Meta refuses and nothing changes), or remove it (the app token; its undo installs the fields it had). '
    + 'install-page with object instagram is the Instagram account\'s per-account step (its linked Page, the chosen one). '
    + 'Instagram and WhatsApp FIELDS are set only in Meta\'s App Dashboard. The App '
    + 'Dashboard is as good a road for all of this (Webhooks of the app, the callback above, the verify token set on the '
    + 'API): meta-webhooks reads the result either way. Meta first verifies the callback (META_WEBHOOK_VERIFY_TOKEN on the '
    + 'API service, never shown). Nothing here spends money. Meta has no check for these changes. Undo puts back what it '
    + 'replaced (a callback that was not Nexus\'s is never written back).'
    + META_CHANGE_RULES,
  undo: webhooksUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildWebhooks(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildWebhooks(args), plainFinish),
}

// ── set-meta-alert-subscription / remove-meta-alert-subscription ────────────────────────────────────────────────

const ALERT_FIELDS = [...new Set([...Object.keys(ALERT_OBJECT_FIELDS), ...ALERT_METRIC_FIELDS, ...Object.keys(ALERT_MILESTONE_MINIMUMS)])] as [string, ...string[]]
const ALERT_OPERATORS = ['GREATER_THAN', 'LESS_THAN', 'IN_RANGE', 'NOT_IN_RANGE', 'EQUAL', 'CONTAIN', 'NOT_CONTAIN', 'IN', 'NOT_IN', 'ANY', 'ALL', 'NONE'] as const
const subscriptionIdArg = z.string().trim().regex(/^\d{1,25}$/, 'a Meta id is digits only').describe('the alert subscription (meta-webhooks view alerts lists them)')

const specOf = (args: Record<string, unknown>): AlertSpecArgs => {
  const { connectionId: _c, why: _w, action: _a, subscriptionId: _s, ...rest } = args
  return rest as unknown as AlertSpecArgs
}

const buildAlert = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.action === 'create') return alertCreateDraft(account.adAccountId, specOf(args))
  const id = typeof args.subscriptionId === 'string' ? args.subscriptionId : ''
  if (!id) return { refusal: 'Name the alert subscription (subscriptionId; meta-webhooks view alerts lists them).' }
  const live = await liveAlertSubscription(account.accountId, account.adAccountId, id)
  if (!live) return { refusal: `Meta has no alert subscription ${id} on ad account ${account.adAccountId} made by this app.` }
  return alertStatusDraft(account.adAccountId, live, args.action === 'enable' ? 'ENABLED' : 'DISABLED')
})

/** A new subscription's id is Meta's answer ({subscription_id}): the record holds it, its undo removes exactly that one. */
function alertFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeDraft['requests'][number]; result: { node: Record<string, unknown> | null } }>) {
  const before = draft.before as AlertRecord
  const after = { ...(draft.after as AlertRecord) }
  if (after.action === 'create') {
    const node = done[0]?.result.node ?? null
    const id = node && (typeof node.subscription_id === 'string' || typeof node.subscription_id === 'number') ? String(node.subscription_id)
      : node && (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : null
    after.subscriptionId = id
    before.undo = id ? { subscriptionId: id, confirmDelete: true } : null
    before.noUndo = id ? [] : ['Meta answered without the new subscription\'s id, so there is no undo (meta-webhooks view alerts shows it).']
  }
  return { data: { subscriptionId: after.subscriptionId, ...(before.noUndo?.length ? { noUndo: before.noUndo } : {}) }, before, after }
}

const alertUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AlertRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account || !after.subscriptionId) return null
    const live = await liveAlertSubscription(account.accountId, account.adAccountId, after.subscriptionId)
    return { ...after, exists: !!live, ...(after.action === 'status' ? { status: live?.status ?? null } : {}) }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AlertRecord & { accountId?: string }
    if (!before.undo) return { refusal: `There is nothing Nexus can put back: ${(before.noUndo ?? []).join(' ') || 'the change recorded no earlier state.'}` }
    const connection = before.accountId ? { connectionId: before.accountId } : {}
    const why = 'undo of an earlier Meta alert subscription change'
    // A new one is removed (remove-meta-alert-subscription); a status goes back and a removed one is made again (set-…).
    if (before.action === 'create') return { tool: 'remove-meta-alert-subscription', args: { ...connection, ...before.undo, why } }
    return { tool: 'set-meta-alert-subscription', args: { ...connection, ...before.undo, why } }
  },
}

const setMetaAlertSubscription: AgentTool = {
  name: 'set-meta-alert-subscription',
  title: 'Set a Meta alert subscription',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  // Its thresholds can be money (budgets, spend, costs, in minor units).
  restrictedFields: { changes: ADSPEND, summary: ADSPEND },
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'enable', 'disable']).describe('create a new alert on the chosen ad account, or switch one on / off'),
    subscriptionId: subscriptionIdArg.optional(),
    eventType: z.enum(ALERT_EVENT_TYPES).optional().describe('create: OBJECT_CREATED (a new campaign, ad set or ad), OBJECT_UPDATED (a setting changes), INSIGHTS_UPDATED (a metric crosses a threshold or range), INSIGHTS_MILESTONE_REACHED (a metric reaches each multiple of a value, lifetime)'),
    entityType: z.enum(ALERT_ENTITY_TYPES).optional().describe('create: CAMPAIGN, ADSET or AD — what the alert watches'),
    field: z.enum(ALERT_FIELDS).optional().describe('create: the setting (OBJECT_UPDATED: name, objective, daily_budget, bid_amount, …) or metric (spent, cpc, ctr, results, website_purchase_roas, …) watched'),
    operator: z.enum(ALERT_OPERATORS).optional().describe('create: GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE (amounts, metrics, times), EQUAL (a milestone, a name), CONTAIN / NOT_CONTAIN (a name), IN / NOT_IN (an objective, goal, …), ANY / ALL / NONE (labels); OBJECT_UPDATED without one fires on any change'),
    thresholdCents: z.array(z.number().int().min(0).max(100_000_000_000)).min(1).max(2).optional().describe('create, money fields (budgets, spend cap, bids, spend, costs): one amount or two (low, high), in minor units of the ad account\'s currency'),
    threshold: z.array(z.number().min(0).max(1_000_000_000_000)).min(1).max(2).optional().describe('create, counts and ratios (clicks, ctr, frequency, ROAS, results …; a milestone): one value or two (low, high)'),
    thresholdTime: z.array(z.string().trim().min(10).max(40)).min(1).max(2).optional().describe('create, times (start_time, stop_time, created_time, updated_time): one or two, ISO 8601'),
    thresholdText: z.string().trim().min(1).max(100).regex(/^[\x20-\x7e]+$/, 'plain text').optional().describe('create, a name: the text it EQUALs or CONTAINs'),
    thresholdList: z.array(z.string().trim().regex(/^[A-Za-z0-9_]{1,60}$/)).min(1).max(20).optional().describe('create, IN / NOT_IN / ANY / ALL / NONE: Meta\'s values (OUTCOME_SALES, …; true / false; label ids)'),
    filters: z.array(z.object({
      field: z.enum(ALERT_FILTER_FIELDS).describe('a setting to narrow by'),
      operator: z.enum(ALERT_FILTER_OPS).describe('EQUAL (one value), IN, NOT_IN'),
      values: z.array(z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,59}$/)).min(1).max(20).describe('Meta\'s values, e.g. OUTCOME_SALES'),
    })).max(19).optional().describe('create: narrow it further (Meta allows 20 filters, the entity type is one)'),
    status: z.enum(ALERT_STATUSES).optional().describe('create: ENABLED (Meta\'s default) or DISABLED'),
    why: metaWhyArg,
  }),
  description:
    'Create an alert subscription on the business\'s chosen Meta ad account — Meta then pushes a notification to Nexus\'s '
    + 'alerts inbox when a new campaign, ad set or ad is made, a setting of one changes (a budget above an amount, a new '
    + 'name …), a metric crosses a threshold or leaves a range (spend today, cost per result, CTR …), or reaches each '
    + 'multiple of a value (every 1,000 impressions, every 10.00 spent) — or switch one on or off. Amounts in minor units of '
    + 'the account currency, times ISO 8601; at most 20 filters (Meta). The alert reaches Nexus only when the app is '
    + 'subscribed to the ad_account field subscriptions and the ad account is connected (set-meta-webhooks, or the App '
    + 'Dashboard). An alert never spends. Meta has no check for it. Undo removes a new one and switches a status back. '
    + 'Meta documents these with a JSON body; Nexus sends the same keys as a form, and Meta\'s answer decides.'
    + META_CHANGE_RULES,
  undo: alertUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildAlert(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildAlert(args), alertFinish),
}

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => guarded(async (account) => {
  if (args.confirmDelete !== true) return { refusal: 'Removing an alert subscription happens only on the person\'s explicit ask: confirmDelete: true.' }
  const id = String(args.subscriptionId ?? '')
  const live = await liveAlertSubscription(account.accountId, account.adAccountId, id)
  if (!live) return { refusal: `Meta has no alert subscription ${id} on ad account ${account.adAccountId} made by this app.` }
  return alertRemoveDraft(account.adAccountId, live)
})

const removeMetaAlertSubscription: AgentTool = {
  name: 'remove-meta-alert-subscription',
  title: 'Remove a Meta alert subscription',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: { changes: ADSPEND, summary: ADSPEND },
  input: z.object({
    connectionId: metaConnectionArg,
    subscriptionId: subscriptionIdArg,
    confirmDelete: z.literal(true).describe('true: the person asked for this removal in so many words'),
    why: metaWhyArg,
  }),
  description:
    'Remove ONE alert subscription of the business\'s chosen Meta ad account (meta-webhooks view alerts lists them), only '
    + 'on the person\'s explicit ask (confirmDelete: true). Meta then stops those notifications. Nothing spends. Meta has '
    + 'no check for it. Undo makes it again with the same conditions (Meta gives it a new id); an alert Nexus cannot write '
    + 'the same way has no undo, and the preview says so.'
    + META_CHANGE_RULES,
  undo: alertUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), plainFinish),
}

export const META_ADS_WEBHOOKS_TOOLS: AgentTool[] = [setMetaWebhooks, setMetaAlertSubscription, removeMetaAlertSubscription]
