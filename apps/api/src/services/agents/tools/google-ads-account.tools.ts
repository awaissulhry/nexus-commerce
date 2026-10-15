/**
 * Google Ads programme 2, G8b (2026-10-15, Owner's brief "no gap at all") — the Google Ads ACCOUNT itself: its settings,
 * who may use it, its links and its billing. Every tool here is a Nexus change: a preview, an approvalId, a person
 * approves it in Nexus, it runs as that person, never by rule (google-ads-kit.ts).
 *
 *   set-google-account-settings   auto-tagging, the account's tracking template and final URL suffix, its name, call
 *                                 reporting, video brand safety (a customerOperation update; Google checks it first)
 *   set-google-user-access        invite a person, cancel an invitation, change a person's role, remove a person's
 *                                 access (Google cannot check these first; needs users.manage)
 *   set-google-account-links      Merchant Center (link directly, accept / reject / remove its request, unlink) and
 *                                 YouTube videos (request, take back, accept, reject, remove); GA4 answered in words
 *   set-google-billing            a billing setup for an existing payments account, account budgets (propose, change,
 *                                 end, cancel a proposal); a payment card answered in words
 *
 * The user and billing services are not allowed at Google's Explorer access level: Google refuses them then, and the
 * answer says so with Google's own words (account-client.ts) — never a success.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, GOOGLE_UNCHECKED_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import { ACCESS_ROLES } from '../../gateway/google-account-calls.js'
import { ACCOUNT_RESULT, ACCOUNT_REVIEW, checkAccountOperations, sendAccountOperations } from '../../marketing/google-ads/account-client.js'
import { accountSettingsDraft, BRAND_SAFETY, settingsNow, settingsUndoArgs, type AccountSettingsRecord, type AccountSettingsRequest } from '../../marketing/google-ads/change-account-settings.js'
import { NOT_CHECKED_USERS, USER_ACCESS_ACTIONS, userAccessDraft, userAccessNow, userAccessUndo, type UserAccessRecord, type UserAccessRequest } from '../../marketing/google-ads/change-account-users.js'
import { CANNOT, LINK_ACTIONS, linkCheckable, linkDraft, linkNow, linkUndo, NOT_CHECKED_LINKS, type LinkRecord, type LinkRequest } from '../../marketing/google-ads/change-account-links.js'
import { BILLING_ACTIONS, billingCheckable, billingDraft, billingNow, billingUndo, NO_CARD, NOT_CHECKED_BILLING, type BillingRecord, type BillingRequest } from '../../marketing/google-ads/change-account-billing.js'
import { liveAccessState, liveAdminSettings, liveBillingState, liveLinkState } from '../../marketing/google-ads/live-account-admin.js'
import { idOf } from '../../marketing/google-ads/live.js'
import { customerResource, type GoogleMutateResponse } from '../../marketing/google-ads/write-client.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of set-google-billing's previews and answers: its sentences and tables quote spending limits. */
const BILLING_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, summary: ADSPEND, spendingLimitCents: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** An account change of ONE Google method: checked first only when its method has validate_only. */
const accountSender = (notChecked: string, checkable: boolean): GoogleSender => ({
  notChecked,
  send: sendAccountOperations,
  ...(checkable ? { check: checkAccountOperations } : {}),
})

const resultName = (responses: GoogleMutateResponse[]): string | null => responses[0]?.[ACCOUNT_RESULT]?.resourceName ?? null
const reviewName = (responses: GoogleMutateResponse[]): string | null => responses[0]?.[ACCOUNT_REVIEW]?.resourceName ?? null
const REVIEW_SENTENCE = 'Google holds this change for a second administrator\'s approval (multi-party approval): it happens once another '
  + 'administrator of the account approves it in Google Ads.'

/**
 * The sentence the description of a tool ends with when Google can check only SOME of its actions first (links: an
 * unlink; billing: an account budget proposal) — neither GOOGLE_CHANGE_RULES nor GOOGLE_UNCHECKED_CHANGE_RULES is true
 * of all its actions.
 */
export const GOOGLE_PARTLY_CHECKED_RULES =
  ' Nothing changes until a person approves it in Nexus (Approvals); it then runs as that person, never by a rule. '
  + 'Google checks the change first (validate_only) where its method allows it, as said above, so such a change Google '
  + 'would refuse is never queued; for the others the preview says Google did not check it, is built from the live '
  + 'account, and when the approved change runs Nexus reads the account again and sends it only if nothing it stands on '
  + 'moved. The preview says what changes, what can make the account spend more (spendsMoney — the person\'s decision), '
  + 'and the operations it costs. One request; a change sent to Google has no cancel window.'

/** The account's own date, YYYY-MM-DD in its time zone (Google reads every date of a billing change in it). */
export function accountToday(timeZone: string | null, now = new Date()): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) } catch { return now.toISOString().slice(0, 10) }
}

const stamp = (record: object, account: { accountId: string; customerId: string }) => ({ ...record, accountId: account.accountId, customerId: account.customerId })
const accountIdOf = (record: unknown): Record<string, string> => {
  const id = (record as { accountId?: unknown } | null)?.accountId
  return typeof id === 'string' ? { accountId: id } : {}
}

// ── set-google-account-settings ───────────────────────────────────────────────────────────────────────────────────

const settingsRequest = (args: Record<string, unknown>): AccountSettingsRequest => ({
  autoTagging: args.autoTagging as boolean | undefined,
  trackingTemplate: args.trackingTemplate as string | null | undefined,
  finalUrlSuffix: args.finalUrlSuffix as string | null | undefined,
  name: args.name as string | undefined,
  callReporting: args.callReporting as boolean | undefined,
  callConversionReporting: args.callConversionReporting as boolean | undefined,
  callConversionActionId: args.callConversionActionId as string | null | undefined,
  videoBrandSafety: args.videoBrandSafety as AccountSettingsRequest['videoBrandSafety'],
})

const buildSettings = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  accountSettingsDraft(customerResource(account.target), settingsRequest(args), await liveAdminSettings(account.target))

const settingsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AccountSettingsRecord
    const account = await recordAccount(change.after)
    if (!account) return null
    const now = settingsNow(after, await liveAdminSettings(account.target))
    return now ? stamp(now, account) : null
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AccountSettingsRecord
    const args = settingsUndoArgs(before)
    if (!args) return { refusal: 'This change does not record every setting it replaced (an account name or a video brand safety level that was not set cannot be put back).' }
    return { tool: 'set-google-account-settings', args: { ...accountIdOf(change.after), ...args, why: 'undo of an earlier change of the Google Ads account settings' } }
  },
}

const setGoogleAccountSettings: AgentTool = {
  ...common,
  name: 'set-google-account-settings',
  title: 'Change Google Ads account settings',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsConnect],
  input: z.object({
    accountId: googleAccountArg,
    autoTagging: z.boolean().optional().describe('auto-tagging (the gclid on ad clicks); OFF breaks Google Ads conversion tracking (a warning)'),
    trackingTemplate: z.string().trim().max(2048).nullable().optional().describe('the account\'s tracking template (starts with http://, https:// or {lpurl}); "" or null takes it away'),
    finalUrlSuffix: z.string().trim().max(2048).nullable().optional().describe('the account\'s final URL suffix (key=value&key2=value2, no leading ? or &); "" or null takes it away'),
    name: z.string().trim().min(1).max(255).optional().describe('the account\'s name (descriptive name)'),
    callReporting: z.boolean().optional().describe('call reporting (Google tracks calls from ads)'),
    callConversionReporting: z.boolean().optional().describe('call conversion reporting (calls count as conversions)'),
    callConversionActionId: z.string().trim().regex(/^\d{1,20}$/).nullable().optional().describe('the account\'s call conversion action (its id; google-ads-live view conversions); null = Google\'s default'),
    videoBrandSafety: z.enum(BRAND_SAFETY).optional().describe('video brand safety: EXPANDED_INVENTORY, STANDARD_INVENTORY or LIMITED_INVENTORY'),
    why: googleWhyArg,
  }),
  description:
    'Settings of the business\'s chosen Google Ads account itself: auto-tagging, the account-level tracking template and final URL '
    + 'suffix (a campaign, ad group, keyword or ad that sets its own wins), the account\'s name, call reporting (and call conversion '
    + 'reporting and its conversion action), and the video brand safety level. One request, only the settings named. Turning '
    + 'auto-tagging OFF, and any tracking change, come with a warning (conversion tracking). Not changeable through the API: the '
    + 'currency and time zone (fixed), conversion tracking ids, the EU political ads declaration (made in Google Ads). Undo puts the '
    + 'old values back.' + GOOGLE_CHANGE_RULES,
  undo: settingsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSettings(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSettings(args), (draft) => ({
    data: { settings: (draft.after as AccountSettingsRecord).settings },
    before: draft.before,
    after: draft.after,
  })),
}

// ── set-google-user-access ────────────────────────────────────────────────────────────────────────────────────────

const usersRequest = (args: Record<string, unknown>): UserAccessRequest => ({
  action: args.action as UserAccessRequest['action'],
  email: args.email as string | undefined,
  role: args.role as UserAccessRequest['role'],
  invitationId: args.invitationId as string | undefined,
  userId: args.userId as string | undefined,
  confirmRemove: args.confirmRemove as boolean | undefined,
})

const buildUsers = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  userAccessDraft(customerResource(account.target), usersRequest(args), await liveAccessState(account.target))

const usersSender = accountSender(NOT_CHECKED_USERS, false)

const usersUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as UserAccessRecord
    const account = await recordAccount(change.after)
    if (!account) return null
    return stamp(userAccessNow(after, await liveAccessState(account.target)), account)
  },
  request(change: ToolChange) {
    const built = userAccessUndo((change.before ?? {}) as UserAccessRecord, (change.after ?? {}) as UserAccessRecord)
    if ('refusal' in built) return built
    const what = (change.after as UserAccessRecord | null)?.action === 'remove'
      ? 'undo of a removed access: invites the person again (they accept the e-mail)'
      : 'undo of an earlier change of who may use the Google Ads account'
    return { tool: 'set-google-user-access', args: { ...accountIdOf(change.after), ...built.args, why: what } }
  },
}

const setGoogleUserAccess: AgentTool = {
  ...common,
  name: 'set-google-user-access',
  title: 'Change Google Ads user access',
  reversibility: 'partial',
  requires: [F.usersManage, F.adsConnect],
  input: z.object({
    accountId: googleAccountArg,
    action: z.enum(USER_ACCESS_ACTIONS).describe('invite (email + role), cancel-invitation (invitationId), change-role (userId + role), remove (userId + confirmRemove)'),
    email: z.string().trim().max(254).optional().describe('invite: the person\'s e-mail address'),
    role: z.enum(ACCESS_ROLES).optional().describe('invite / change-role: ADMIN (everything, users and billing too), STANDARD (campaigns, not users), READ_ONLY (sees only) or EMAIL_ONLY (e-mails and reports only)'),
    invitationId: googleIdArg('cancel-invitation: the invitation').optional(),
    userId: googleIdArg('change-role / remove: the person\'s user id').optional(),
    confirmRemove: z.boolean().optional().describe('remove: must be true (a removed access cannot be put back; the person can only be invited again)'),
    why: googleWhyArg,
  }),
  description:
    'Who may use the business\'s chosen Google Ads account (google-ads-live view users lists people and invitations): invite a person '
    + 'with a role (Google e-mails them; they accept), cancel a pending invitation, change a person\'s role, or remove a person\'s '
    + 'access (only with confirmRemove: true). A security change: the preview names the person and the role plainly — the person by '
    + 'a masked e-mail address (p***@example.com) and Google\'s user or invitation id, because the preview is kept with the approval; '
    + 'the full address is only in an invitation\'s own request. Nexus '
    + 'never removes or demotes the last administrator, nor the Google login Nexus signs in with. Google may hold a change for a '
    + 'second administrator\'s approval (multi-party approval): the answer says so. At Google\'s Explorer access level Google does not '
    + 'allow user management through the API: it then refuses when the change runs, and the answer says so. Undo: an invitation is '
    + 'cancelled, a cancelled one sent again, a role set back, a removed person invited again (they must accept).' + GOOGLE_UNCHECKED_CHANGE_RULES,
  undo: usersUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildUsers(args), usersSender),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildUsers(args), (draft, responses) => {
    const review = reviewName(responses)
    const made = resultName(responses)
    const after = { ...(draft.after as UserAccessRecord), ...(review ? { review } : {}) }
    if (after.action === 'invite' && made) after.invitationId = idOf(made)
    return {
      data: { done: review ? 'held for a second administrator' : 'done', ...(after.invitationId ? { invitationId: after.invitationId } : {}), ...(review ? { review, note: REVIEW_SENTENCE } : {}) },
      before: draft.before,
      after,
    }
  }, usersSender),
}

// ── set-google-account-links ──────────────────────────────────────────────────────────────────────────────────────

const linksRequest = (args: Record<string, unknown>): LinkRequest => ({
  action: args.action as LinkRequest['action'],
  merchantCenterId: args.merchantCenterId as string | undefined,
  invitationId: args.invitationId as string | undefined,
  confirmUnlink: args.confirmUnlink as boolean | undefined,
  channelId: args.channelId as string | undefined,
  videoId: args.videoId as string | undefined,
  videoLinkId: args.videoLinkId as string | undefined,
})

const buildLinks = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  linkDraft(customerResource(account.target), linksRequest(args), await liveLinkState(account.target))

const linksSender = (args: Record<string, unknown>) => accountSender(NOT_CHECKED_LINKS, linkCheckable(args.action as LinkRequest['action']))

/** Answered in words before any read: what the Google Ads API cannot do. */
const cannotLink = (args: Record<string, unknown>): ToolResult | null => {
  const sentence = CANNOT[args.action as LinkRequest['action']]
  return sentence ? { ok: false, error: sentence } : null
}

const linksUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LinkRecord
    const account = await recordAccount(change.after)
    if (!account) return null
    return stamp(linkNow(after, await liveLinkState(account.target)), account)
  },
  request(change: ToolChange) {
    const built = linkUndo((change.before ?? {}) as LinkRecord, (change.after ?? {}) as LinkRecord)
    if ('refusal' in built) return built
    return { tool: 'set-google-account-links', args: { ...accountIdOf(change.after), ...built.args, why: 'undo of an earlier change of the Google Ads account\'s links' } }
  },
}

const setGoogleAccountLinks: AgentTool = {
  ...common,
  name: 'set-google-account-links',
  title: 'Change the Google Ads account\'s links',
  reversibility: 'partial',
  requires: [F.adsConnect, F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    action: z.enum(LINK_ACTIONS).describe(
      'link-merchant-center / unlink-merchant-center (merchantCenterId; unlink needs confirmUnlink), accept-merchant-request / '
      + 'reject-merchant-request / remove-merchant-request (invitationId), request-video-link (channelId + videoId), revoke-video-request / '
      + 'accept-video-link / reject-video-link / remove-video-link (videoLinkId); request-merchant-link, link-ga4, link-youtube-channel '
      + 'and link-business-profile answer what the Google Ads API (or Nexus\'s Google sign-in) cannot do'),
    merchantCenterId: googleIdArg('the Merchant Center account').optional(),
    invitationId: googleIdArg('the Merchant Center link request (google-ads-live view links)').optional(),
    confirmUnlink: z.boolean().optional().describe('unlink-merchant-center: must be true (its Shopping and Performance Max product ads stop)'),
    channelId: z.string().trim().max(40).optional().describe('request-video-link: the video\'s YouTube channel id ("UC…", 24 characters)'),
    videoId: z.string().trim().max(20).optional().describe('request-video-link: the YouTube video id (11 characters)'),
    videoLinkId: z.string().trim().regex(/^\d{1,20}~\d{1,20}$/).optional().describe('a video link: productLinkId~dataLinkId (google-ads-live view links)'),
    why: googleWhyArg,
  }),
  description:
    'Links of the business\'s chosen Google Ads account (google-ads-live view links shows them): Merchant Center — link an account '
    + 'directly (the Google login Nexus uses must be an administrator of both), accept or reject the link request Merchant Center sent, '
    + 'remove a request, unlink (confirmUnlink: Shopping and Performance Max product ads stop); YouTube — ask a channel to link a video, '
    + 'take a request back, accept or reject a creator\'s request, remove a linked video. Not possible, and answered so in words: '
    + 'SENDING a Merchant Center request (it comes from Merchant Center), Google Analytics 4 (the Analytics Admin API with the '
    + 'analytics.edit permission, which Nexus does not have), a whole YouTube channel (the API links single videos), and a Google '
    + 'Business Profile (a location asset set needing the profile owner\'s business.manage sign-in, which Nexus does not have). Undo: '
    + 'a link is unlinked, an unlink linked again, a video request taken back or made again; a rejected request cannot come back. '
    + 'Google checks an unlink first (validate_only); the other link changes it cannot check first (no validate_only).'
    + GOOGLE_PARTLY_CHECKED_RULES,
  undo: linksUndo,
  handler: async (args, ctx) => cannotLink(args) ?? googleChangePreview(args, ctx, buildLinks(args), linksSender(args)),
  execute: async (args, ctx) => cannotLink(args) ?? runGoogleChange(args, ctx, buildLinks(args), (draft, responses) => {
    const after = { ...(draft.after as LinkRecord) }
    const made = resultName(responses)
    if (after.action === 'request-video-link' && made) after.videoLinkId = idOf(made)
    return { data: { ...(made ? { resource: idOf(made) } : {}) }, before: draft.before, after }
  }, linksSender(args)),
}

// ── set-google-billing ────────────────────────────────────────────────────────────────────────────────────────────

const billingRequest = (args: Record<string, unknown>): BillingRequest => ({
  action: args.action as BillingRequest['action'],
  paymentsAccountId: args.paymentsAccountId as string | undefined,
  billingSetupId: args.billingSetupId as string | undefined,
  accountBudgetId: args.accountBudgetId as string | undefined,
  proposalId: args.proposalId as string | undefined,
  name: args.name as string | undefined,
  spendingLimitCents: args.spendingLimitCents as number | undefined,
  unlimited: args.unlimited as boolean | undefined,
  startDate: args.startDate as string | undefined,
  endDate: args.endDate as string | undefined,
  noEnd: args.noEnd as boolean | undefined,
  confirmEnd: args.confirmEnd as boolean | undefined,
})

const buildBilling = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) =>
  billingDraft(customerResource(account.target), account.currency, accountToday(account.timeZone), billingRequest(args), await liveBillingState(account.target))

const billingSender = (args: Record<string, unknown>) => accountSender(NOT_CHECKED_BILLING, billingCheckable(args.action as BillingRequest['action']))

const noCard = (args: Record<string, unknown>): ToolResult | null => (args.action === 'add-payment-card' ? { ok: false, error: NO_CARD } : null)

const billingUndoSpec: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BillingRecord
    const account = await recordAccount(change.after)
    if (!account) return null
    return stamp(billingNow(after, await liveBillingState(account.target)), account)
  },
  request(change: ToolChange) {
    const built = billingUndo((change.before ?? {}) as BillingRecord, (change.after ?? {}) as BillingRecord)
    if ('refusal' in built) return built
    return { tool: 'set-google-billing', args: { ...accountIdOf(change.after), ...built.args, why: 'undo of an earlier billing change of the Google Ads account' } }
  },
}

const DAY = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date YYYY-MM-DD')

const setGoogleBilling: AgentTool = {
  ...common,
  name: 'set-google-billing',
  title: 'Change Google Ads billing',
  reversibility: 'partial',
  requires: [F.adsBudgetsEdit, F.adsConnect, ADSPEND],
  restrictedFields: BILLING_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    action: z.enum(BILLING_ACTIONS).describe(
      'create-billing-setup (paymentsAccountId, startDate), cancel-billing-setup (billingSetupId), propose-account-budget (name, '
      + 'spendingLimitCents or unlimited, startDate, endDate, billingSetupId), change-account-budget (accountBudgetId + name / '
      + 'spendingLimitCents / unlimited / endDate / noEnd), end-account-budget (accountBudgetId + confirmEnd), cancel-proposal '
      + '(proposalId); add-payment-card answers that no API can'),
    paymentsAccountId: z.string().trim().regex(/^\d{4}-\d{4}-\d{4}-\d{4}$/, 'a payments account id 1234-5678-9012-3456').optional()
      .describe('create-billing-setup: an EXISTING payments account (Google Ads › Billing › Settings), as 1234-5678-9012-3456'),
    billingSetupId: googleIdArg('the billing setup (google-ads-live view billing)').optional(),
    accountBudgetId: googleIdArg('the account budget (google-ads-live view billing)').optional(),
    proposalId: googleIdArg('cancel-proposal: the proposal still waiting for Google\'s review').optional(),
    name: z.string().trim().min(1).max(255).optional().describe('the account budget\'s name'),
    spendingLimitCents: googleCentsArg('the account budget\'s spending limit for its whole run').optional(),
    unlimited: z.boolean().optional().describe('true = no spending limit (SPENDS MONEY)'),
    startDate: DAY.optional().describe('a future start, YYYY-MM-DD in the account\'s time zone; absent = now'),
    endDate: DAY.optional().describe('the last day, YYYY-MM-DD in the account\'s time zone; absent on a new budget = until it is ended'),
    noEnd: z.boolean().optional().describe('change-account-budget: take the end date away (it runs until it is ended)'),
    confirmEnd: z.boolean().optional().describe('end-account-budget: must be true (ALL ads of the account stop)'),
    why: googleWhyArg,
  }),
  description:
    'Billing of the business\'s chosen Google Ads account, as far as the Google Ads API allows (google-ads-live view billing shows it): '
    + 'make a billing setup for an EXISTING payments account or cancel one that has not started; propose a new account budget (a '
    + 'spending limit in cents of the account\'s currency, or unlimited, with a start and an end), change one (name, limit, end), end '
    + 'one (confirmEnd: ALL ads stop), or cancel a proposal before Google reviews it (Google reviews every proposal, usually within an '
    + 'hour). Only for an account on monthly invoicing; at Google\'s Explorer access level Google refuses these services and the '
    + 'answer says so. No API can add a payment card (add-payment-card answers so). A new budget, a higher limit, no limit, a later '
    + 'end and a billing setup are SPENDS MONEY. Undo: a billing setup or a proposal is cancelled (while it waits), a changed budget '
    + 'set back; an ended budget or a cancelled setup cannot come back. Google checks an account budget change first (validate_only); '
    + 'it cannot check a billing setup first (no validate_only).' + GOOGLE_PARTLY_CHECKED_RULES,
  undo: billingUndoSpec,
  handler: async (args, ctx) => noCard(args) ?? googleChangePreview(args, ctx, buildBilling(args), billingSender(args)),
  execute: async (args, ctx) => noCard(args) ?? runGoogleChange(args, ctx, buildBilling(args), (draft, responses) => {
    const after = { ...(draft.after as BillingRecord) }
    const made = resultName(responses)
    if (after.action === 'create-billing-setup' && made) after.billingSetupId = idOf(made)
    if (after.action === 'propose-account-budget' && made) after.proposalId = idOf(made)
    return {
      data: { ...(made ? { resource: idOf(made) } : {}), ...(billingCheckable(after.action) && after.action !== 'cancel-proposal' ? { note: 'Google reviews the proposal before it applies (usually within an hour): google-ads-live view billing shows it.' } : {}) },
      before: draft.before,
      after,
    }
  }, billingSender(args)),
}

export const GOOGLE_ADS_ACCOUNT_TOOLS: AgentTool[] = [setGoogleAccountSettings, setGoogleUserAccess, setGoogleAccountLinks, setGoogleBilling]
