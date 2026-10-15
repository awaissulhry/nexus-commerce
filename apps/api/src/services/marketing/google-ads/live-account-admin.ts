/**
 * Google Ads programme 2, G8b (2026-10-15) — the live reads the account tools stand on (google-ads-account.tools.ts):
 * the account's own settings, who may use it, its Merchant Center and YouTube links, and its billing. The queries are
 * G1's (live-account.ts) where they fit, read STRICTLY here: a change stands on all of them, so a part Google refuses
 * is a refusal of the change (GoogleAdsReadError), never a default.
 *
 * Checked on 2026-10-15 in Google's v25 field reference (curl of developers.google.com/google-ads/api/fields/v25/
 * <resource>, parsed): every field selected below is Selectable; the one WHERE (account_budget_proposal.status) is
 * Filterable on its own resource, and no other resource is filtered on. Added to G1's settings query:
 * customer.call_reporting_setting.call_reporting_enabled, .call_conversion_reporting_enabled, .call_conversion_action
 * (RESOURCE_NAME) and customer.video_brand_safety_suitability (ENUM BrandSafetySuitability: EXPANDED_INVENTORY |
 * STANDARD_INVENTORY | LIMITED_INVENTORY). Added to G1's account budget query:
 * account_budget.pending_proposal.account_budget_proposal. account_budget_proposal: id, status (ENUM PENDING |
 * APPROVED_HELD | APPROVED | CANCELLED | REJECTED), proposal_type (CREATE | UPDATE | END | REMOVE), account_budget,
 * billing_setup, proposed_name, proposed_spending_limit_micros, proposed_spending_limit_type, creation_date_time,
 * proposed_end_date_time (DATE), proposed_end_time_type (ENUM TimeType FOREVER | NOW) — all Selectable (review fixes,
 * 2026-10-15, curl of fields/v25/account_budget_proposal).
 *
 * Two reads that are not GAQL:
 *   - the Merchant Center accounts THIS business chose in Nexus (GoogleAccountLink product MERCHANT, read through the
 *     workspace-scoped client: only this business's rows). A Merchant Center id never crosses businesses (Owner's rule),
 *     so the link tool links or accepts only one of these.
 *   - the payments accounts this Google Ads account may use for a billing setup: PaymentsAccountService
 *     .ListPaymentsAccounts, `GET /v25/customers/{customer_id}/paymentsAccounts` (googleapis v25
 *     payments_account_service.proto; answer ListPaymentsAccountsResponse { payments_accounts[] PaymentsAccount
 *     { payments_account_id "A 16 digit ID", name, currency_code, … } }, reference/rpc/v25, curl 2026-10-15). A GET is a
 *     read on the gateway already (googleCallKind): no new path. Google does not allow this service at the Explorer access
 *     level (docs/api-policy/access-levels): a refusal is a refusal of the billing setup, said plainly.
 */
import prisma from '../../../db.js'
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure } from './errors.js'
import { customerIdDigits } from './mappers.js'
import { markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import {
  ACCOUNT_BUDGETS_QUERY, ACCOUNT_SETTINGS_QUERY, accountSettingsOf, BILLING_SETUPS_QUERY, DATA_LINKS_QUERY, PRODUCT_LINK_INVITATIONS_QUERY,
  PRODUCT_LINKS_QUERY, USER_ACCESS_QUERY, USER_INVITATIONS_QUERY, type LiveAccountSettings,
} from './live-account.js'
import { centsOfMicros, idOf } from './live.js'
import { customerResource, liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const ADMIN_SETTINGS_QUERY = ACCOUNT_SETTINGS_QUERY.replace(/ FROM customer$/,
  ', customer.call_reporting_setting.call_reporting_enabled, customer.call_reporting_setting.call_conversion_reporting_enabled, '
  + 'customer.call_reporting_setting.call_conversion_action, customer.video_brand_safety_suitability FROM customer')

export interface LiveAdminSettings extends LiveAccountSettings {
  callReporting: boolean
  callConversionReporting: boolean
  /** The account's call conversion action (its id), or null: Google's default. */
  callConversionActionId: string | null
  videoBrandSafety: string | null
}

export function adminSettingsOf(row: Json): LiveAdminSettings {
  const call = row.customer?.callReportingSetting ?? {}
  return {
    ...accountSettingsOf(row),
    callReporting: call.callReportingEnabled === true,
    callConversionReporting: call.callConversionReportingEnabled === true,
    callConversionActionId: idOf(call.callConversionAction),
    videoBrandSafety: str(row.customer?.videoBrandSafetySuitability),
  }
}

export async function liveAdminSettings(target: GoogleAdsTarget): Promise<LiveAdminSettings | null> {
  const rows = await liveRows<Json>(target, ADMIN_SETTINGS_QUERY, 'ads.search.live.account-admin')
  return rows[0] ? adminSettingsOf(rows[0]) : null
}

// ── users ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveUserAccess { userId: string; email: string | null; role: string | null; since: string | null }
export interface LiveInvitation { invitationId: string; email: string | null; role: string | null; status: string | null; sentAt: string | null }
export interface LiveAccessState {
  users: LiveUserAccess[]
  invitations: LiveInvitation[]
  /** The Google login Nexus signs in with (its connection's e-mail), or null when Nexus does not know it. */
  nexusLogin: string | null
}

/** The e-mail of the Google login this connection signed in with (ChannelConnection.identity.username), or null. */
export async function nexusGoogleLogin(connectionId: string): Promise<string | null> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { identity: true } })
  const identity = (row?.identity ?? null) as { username?: unknown } | null
  const email = typeof identity?.username === 'string' ? identity.username.trim() : ''
  return email.includes('@') ? email : null
}

export async function liveAccessState(target: GoogleAdsTarget): Promise<LiveAccessState> {
  const users = (await liveRows<Json>(target, USER_ACCESS_QUERY, 'ads.search.live.users')).flatMap((r) => {
    const u = r.customerUserAccess ?? {}
    const userId = str(u.userId)
    return userId ? [{ userId, email: str(u.emailAddress), role: str(u.accessRole), since: str(u.accessCreationDateTime) }] : []
  })
  const invitations = (await liveRows<Json>(target, USER_INVITATIONS_QUERY, 'ads.search.live.invitations')).flatMap((r) => {
    const i = r.customerUserAccessInvitation ?? {}
    const invitationId = str(i.invitationId)
    return invitationId ? [{ invitationId, email: str(i.emailAddress), role: str(i.accessRole), status: str(i.invitationStatus), sentAt: str(i.creationDateTime) }] : []
  })
  return { users, invitations, nexusLogin: await nexusGoogleLogin(target.connectionId) }
}

// ── links ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveMerchantLink { linkId: string; merchantCenterId: string }
export interface LiveLinkInvitation { invitationId: string; type: string | null; status: string | null; merchantCenterId: string | null }
/** A YouTube video link; `linkId` is `{product_link_id}~{data_link_id}` (DataLink's resource name ends with it). */
export interface LiveVideoLink { linkId: string; status: string | null; channelId: string | null; videoId: string | null }
export interface LiveLinkState {
  merchantLinks: LiveMerchantLink[]; invitations: LiveLinkInvitation[]; videos: LiveVideoLink[]
  /** The Merchant Center account ids THIS business chose in Nexus (Settings › Channels › Google), sorted. */
  chosenMerchantCenterIds: string[]
}

/** The Merchant Center accounts this business chose in Nexus (its GoogleAccountLink rows, product MERCHANT). */
export async function chosenMerchantCenterIds(): Promise<string[]> {
  const rows = await prisma.googleAccountLink.findMany({ where: { product: 'MERCHANT' }, select: { externalId: true } })
  return [...new Set(rows.map((r) => r.externalId.trim()).filter((id) => /^\d{1,20}$/.test(id)))].sort()
}

export async function liveLinkState(target: GoogleAdsTarget): Promise<LiveLinkState> {
  const merchantLinks = (await liveRows<Json>(target, PRODUCT_LINKS_QUERY, 'ads.search.live.product-links')).flatMap((r) => {
    const l = r.productLink ?? {}
    const linkId = str(l.productLinkId)
    const merchantCenterId = str(l.merchantCenter?.merchantCenterId)
    return linkId && merchantCenterId && str(l.type) === 'MERCHANT_CENTER' ? [{ linkId, merchantCenterId }] : []
  })
  const invitations = (await liveRows<Json>(target, PRODUCT_LINK_INVITATIONS_QUERY, 'ads.search.live.link-invitations')).flatMap((r) => {
    const i = r.productLinkInvitation ?? {}
    const invitationId = str(i.productLinkInvitationId)
    return invitationId ? [{ invitationId, type: str(i.type), status: str(i.status), merchantCenterId: str(i.merchantCenter?.merchantCenterId) }] : []
  })
  const videos = (await liveRows<Json>(target, DATA_LINKS_QUERY, 'ads.search.live.data-links')).flatMap((r) => {
    const d = r.dataLink ?? {}
    const product = str(d.productLinkId)
    const data = str(d.dataLinkId)
    return product && data && str(d.type) === 'VIDEO'
      ? [{ linkId: `${product}~${data}`, status: str(d.status), channelId: str(d.youtubeVideo?.channelId), videoId: str(d.youtubeVideo?.videoId) }]
      : []
  })
  return { merchantLinks, invitations, videos, chosenMerchantCenterIds: await chosenMerchantCenterIds() }
}

// ── billing ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const ADMIN_ACCOUNT_BUDGETS_QUERY = ACCOUNT_BUDGETS_QUERY.replace(/ FROM account_budget$/, ', account_budget.pending_proposal.account_budget_proposal FROM account_budget')

export const PENDING_PROPOSALS_QUERY =
  'SELECT account_budget_proposal.id, account_budget_proposal.status, account_budget_proposal.proposal_type, ' +
  'account_budget_proposal.account_budget, account_budget_proposal.billing_setup, account_budget_proposal.proposed_name, ' +
  'account_budget_proposal.proposed_spending_limit_micros, account_budget_proposal.proposed_spending_limit_type, ' +
  'account_budget_proposal.creation_date_time, account_budget_proposal.proposed_end_date_time, account_budget_proposal.proposed_end_time_type ' +
  "FROM account_budget_proposal WHERE account_budget_proposal.status = 'PENDING'"

export interface LiveBillingSetup {
  billingSetupId: string; status: string | null; paymentsAccountId: string | null; paymentsAccountName: string | null; start: string | null; end: string | null
}
export interface LiveAccountBudget {
  accountBudgetId: string; name: string | null; status: string | null; billingSetupId: string | null
  start: string | null; end: string | null; endType: string | null
  /** null with spendingLimitType INFINITE: no limit. */
  spendingLimitCents: number | null; spendingLimitType: string | null; amountServedCents: number | null
  pending: { proposalId: string | null; type: string | null } | null
}
export interface LiveBudgetProposal {
  proposalId: string; status: string | null; type: string | null; accountBudgetId: string | null; billingSetupId: string | null
  name: string | null; spendingLimitCents: number | null; spendingLimitType: string | null; createdAt: string | null
  /** The proposed end: a date-time, or endType FOREVER / NOW; both null when the proposal does not change it. */
  end: string | null; endType: string | null
}
export interface LiveBillingState { setups: LiveBillingSetup[]; budgets: LiveAccountBudget[]; proposals: LiveBudgetProposal[] }

export async function liveBillingState(target: GoogleAdsTarget): Promise<LiveBillingState> {
  const setups = (await liveRows<Json>(target, BILLING_SETUPS_QUERY, 'ads.search.live.billing-setups')).flatMap((r) => {
    const b = r.billingSetup ?? {}
    const billingSetupId = str(b.id)
    if (!billingSetupId) return []
    const p = b.paymentsAccountInfo ?? {}
    return [{ billingSetupId, status: str(b.status), paymentsAccountId: str(p.paymentsAccountId) ?? idOf(b.paymentsAccount), paymentsAccountName: str(p.paymentsAccountName), start: str(b.startDateTime), end: str(b.endDateTime) }]
  })
  const budgets = (await liveRows<Json>(target, ADMIN_ACCOUNT_BUDGETS_QUERY, 'ads.search.live.account-budgets')).flatMap((r) => {
    const a = r.accountBudget ?? {}
    const accountBudgetId = str(a.id)
    if (!accountBudgetId) return []
    const p = a.pendingProposal
    return [{
      accountBudgetId, name: str(a.name), status: str(a.status), billingSetupId: idOf(a.billingSetup),
      start: str(a.approvedStartDateTime), end: str(a.approvedEndDateTime), endType: str(a.approvedEndTimeType),
      spendingLimitCents: centsOfMicros(a.approvedSpendingLimitMicros), spendingLimitType: str(a.approvedSpendingLimitType),
      amountServedCents: centsOfMicros(a.amountServedMicros),
      pending: p ? { proposalId: idOf(p.accountBudgetProposal), type: str(p.proposalType) } : null,
    }]
  })
  const proposals = (await liveRows<Json>(target, PENDING_PROPOSALS_QUERY, 'ads.search.live.budget-proposals')).flatMap((r) => {
    const p = r.accountBudgetProposal ?? {}
    const proposalId = str(p.id)
    return proposalId ? [{
      proposalId, status: str(p.status), type: str(p.proposalType), accountBudgetId: idOf(p.accountBudget), billingSetupId: idOf(p.billingSetup),
      name: str(p.proposedName), spendingLimitCents: centsOfMicros(p.proposedSpendingLimitMicros), spendingLimitType: str(p.proposedSpendingLimitType),
      createdAt: str(p.creationDateTime), end: str(p.proposedEndDateTime), endType: str(p.proposedEndTimeType),
    }] : []
  })
  return { setups, budgets, proposals }
}

// ── payments accounts ────────────────────────────────────────────────────────────────────────────────────────────

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
/** A payments account id as Google writes it in one place or another ("1234-5678-9012-3456" or 16 digits): digits only. */
export const paymentsDigits = (id: string | null | undefined): string => (id ?? '').replace(/\D/g, '')

export const PAYMENTS_NOT_LISTED = 'Google did not let Nexus list the payments accounts this Google Ads account may use, so Nexus cannot check that the '
  + 'payments account belongs to it and makes no billing setup. At the Explorer access level Google does not allow PaymentsAccountService (nor '
  + 'billing setups) through the API (developers.google.com/google-ads/api/docs/api-policy/access-levels); do it in Google Ads › Billing › Settings.'

/**
 * The payments accounts this Google Ads account may use for a billing setup (ids as Google writes them). ONE GET through
 * the gateway, one operation of the account's allowance; read STRICTLY: a refusal rejects (GoogleAdsReadError), never [].
 */
export async function livePaymentsAccounts(target: GoogleAdsTarget): Promise<Array<{ paymentsAccountId: string; name: string | null }>> {
  const operation = 'ads.paymentsAccounts.list'
  const customer = customerResource(target)
  const customerId = customer.slice('customers/'.length)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  const reservation = await reserveOps(customerId, 1, new Date(), 'write')
  if (!reservation.ok) throw new GoogleAdsReadError(localFailure(reservation.sentence, reservation.reason ?? 'OPS_REFUSED'), operation)
  let reached = false
  let failure: GoogleAdsFailure
  try {
    const response = await googleCall({
      connectionId: target.connectionId, operation, method: 'GET', url: `${GOOGLE_ADS_API_BASE}/${customer}/paymentsAccounts`,
      loginCustomerId: login, maxTransientRetries: 0, max429Retries: 0, timeoutMs: 30_000,
    })
    reached = true
    const text = await response.text()
    if (response.ok) {
      let parsed: { paymentsAccounts?: unknown } = {}
      try { parsed = text ? JSON.parse(text) : {} } catch { throw new GoogleAdsReadError(localFailure('Google Ads answered with something Nexus cannot read.', 'UNREADABLE_ANSWER'), operation, 1) }
      const list = Array.isArray(parsed.paymentsAccounts) ? parsed.paymentsAccounts as Json[] : []
      return list.flatMap((a) => {
        const id = str(a?.paymentsAccountId) ?? idOf(a?.resourceName)
        return id ? [{ paymentsAccountId: id, name: str(a?.name) }] : []
      })
    }
    failure = parseGoogleAdsFailure(response.status, text, response.headers)
  } catch (err) {
    if (err instanceof GoogleAdsReadError) throw err
    if (isRefusal(err)) failure = failureFromGatewayRefusal(err)
    else if (isNoAnswer(err)) { reached = true; failure = failureFromNoAnswer(err) } else throw err
  } finally {
    if (!reached) await releaseOps(customerId, 1, reservation.reservedAt, 'write').catch(() => undefined)
  }
  if (failure.quotaExhausted) await markQuotaExhausted()
  const shown = failure.permissionDenied ? { ...failure, sentence: `${PAYMENTS_NOT_LISTED} (Google: ${failure.errors[0]?.code ?? failure.status ?? `HTTP ${failure.httpStatus}`}.)` } : failure
  throw new GoogleAdsReadError(shown, operation, reached ? 1 : 0)
}
