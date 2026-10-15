/**
 * Google Ads programme 2, G8b (2026-10-15) — the Google Ads ACCOUNT changes Nexus sends besides GoogleAdsService.Mutate:
 * who may use the account (user access and invitations), its links (Merchant Center, YouTube videos) and its billing
 * (billing setups, account budget proposals). Each is its own Google Ads service method with its own path; the gateway
 * lets through exactly these paths, for ONE customer the business chose, with exactly the body shapes the account tools
 * send (google-ads-account.tools.ts) — nothing broader. Everything else stays refused (GOOGLE_READ_ONLY).
 *
 * Paths: the v25 service protos' HTTP bindings (raw.githubusercontent.com/googleapis/googleapis/master/google/ads/
 * googleads/v25/services/<name>_service.proto, read 2026-10-15), every one `post … body: "*"`:
 *   /v25/customers/{customer_id}/customerUserAccessInvitations:mutate   MutateCustomerUserAccessInvitation (no validate_only)
 *   /v25/customers/{customer_id}/customerUserAccesses:mutate            MutateCustomerUserAccess (no validate_only)
 *   /v25/customers/{customer_id}/productLinks:create                    CreateProductLink (no validate_only)
 *   /v25/customers/{customer_id}/productLinks:remove                    RemoveProductLink (validate_only)
 *   /v25/customers/{customer_id}/productLinkInvitations:update          UpdateProductLinkInvitation (no validate_only)
 *   /v25/customers/{customer_id}/productLinkInvitations:remove          RemoveProductLinkInvitation (no validate_only)
 *   /v25/customers/{customer_id}/dataLinks:create | :update | :remove   DataLinkService (no validate_only)
 *   /v25/customers/{customer_id}/billingSetups:mutate                   MutateBillingSetup (no validate_only)
 *   /v25/customers/{customer_id}/accountBudgetProposals:mutate          MutateAccountBudgetProposal (validate_only)
 * Not here, on purpose: CustomerService.CreateCustomerClient (`customers/{id}:createCustomerClient`, a new account) and
 * ProductLinkInvitationService.CreateProductLinkInvitation (Google Ads cannot invite a Merchant Center account: on
 * ProductLinkInvitation v25 `merchant_center` is OUTPUT_ONLY; the request comes from Merchant Center).
 *
 * Bodies (proto3 JSON, camelCase; the messages checked in reference/rpc/v25/<Message> with curl, 2026-10-15):
 *   CustomerUserAccessInvitationOperation  create { emailAddress, accessRole } | remove "customers/{c}/customerUserAccessInvitations/{id}"
 *   CustomerUserAccessOperation            update { resourceName "customers/{c}/customerUserAccesses/{user_id}", accessRole } + updateMask "access_role" | remove
 *   AccessRole                             ADMIN | STANDARD | READ_ONLY | EMAIL_ONLY
 *   CreateProductLinkRequest               productLink { merchantCenter { merchantCenterId } } (MerchantCenterIdentifier, IMMUTABLE: set on create)
 *   RemoveProductLinkRequest               resourceName "customers/{c}/productLinks/{id}", validateOnly
 *   UpdateProductLinkInvitationRequest     resourceName "customers/{c}/productLinkInvitations/{id}", productLinkInvitationStatus ACCEPTED | REJECTED
 *   RemoveProductLinkInvitationRequest     resourceName
 *   CreateDataLinkRequest                  dataLink { youtubeVideo { channelId ("UC…"), videoId (11 characters) } }
 *   UpdateDataLinkRequest                  resourceName "customers/{c}/dataLinks/{product_link_id}~{data_link_id}", dataLinkStatus
 *                                          REVOKED (a request this account sent) | ENABLED / REJECTED (a creator's request)
 *   BillingSetupOperation                  create { paymentsAccount "customers/{c}/paymentsAccounts/{1234-5678-9012-3456}",
 *                                          startTimeType NOW | startDateTime } | remove "customers/{c}/billingSetups/{id}"
 *   AccountBudgetProposalOperation         create { proposalType CREATE | UPDATE | END | REMOVE, billingSetup, accountBudget, proposedName,
 *                                          proposedStartTimeType NOW | proposedStartDateTime, proposedEndTimeType NOW | FOREVER |
 *                                          proposedEndDateTime, proposedSpendingLimitMicros | proposedSpendingLimitType INFINITE,
 *                                          proposedPurchaseOrderNumber (CREATE only) }
 *                                          + updateMask (UPDATE only) | remove "customers/{c}/accountBudgetProposals/{id}"
 *                                          (REMOVE: "a budget that hasn't started yet", like END only the budget)
 */

const HOST = 'googleads.googleapis.com'

export const GOOGLE_ACCOUNT_CALL_PATHS = [
  'customerUserAccessInvitations:mutate', 'customerUserAccesses:mutate',
  'productLinks:create', 'productLinks:remove', 'productLinkInvitations:update', 'productLinkInvitations:remove',
  'dataLinks:create', 'dataLinks:update', 'dataLinks:remove',
  'billingSetups:mutate', 'accountBudgetProposals:mutate',
] as const
export type GoogleAccountCallPath = typeof GOOGLE_ACCOUNT_CALL_PATHS[number]

/** The two of them Google can check first (their request has validate_only). */
export const GOOGLE_ACCOUNT_CHECKABLE: ReadonlySet<GoogleAccountCallPath> = new Set(['productLinks:remove', 'accountBudgetProposals:mutate'])

export interface GoogleAccountCall { customer: string; path: GoogleAccountCallPath }

const PATH_RE = new RegExp(`^/v\\d+/customers/(\\d{1,20})/(${GOOGLE_ACCOUNT_CALL_PATHS.join('|')})$`)

/** The customer and method of a Google Ads account call Nexus sends, or null when the call is not one. */
export function googleAdsAccountCall(method: string, url: string): GoogleAccountCall | null {
  if (method.toUpperCase() !== 'POST') return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== HOST || parsed.search) return null
  const match = PATH_RE.exec(parsed.pathname)
  return match ? { customer: match[1], path: match[2] as GoogleAccountCallPath } : null
}

export const ACCESS_ROLES = ['ADMIN', 'STANDARD', 'READ_ONLY', 'EMAIL_ONLY'] as const
export type AccessRole = typeof ACCESS_ROLES[number]

/** An e-mail address as Nexus sends it in an invitation (Google checks the rest: AccessInvitationError.INVALID_EMAIL_ADDRESS). */
export const EMAIL_RE = /^[^\s@"<>(),;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
export const YOUTUBE_CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/
export const YOUTUBE_VIDEO_RE = /^[A-Za-z0-9_-]{11}$/
export const PAYMENTS_ACCOUNT_RE = /^\d{4}-\d{4}-\d{4}-\d{4}$/
/** Google's date-time in an account budget proposal or a billing setup (the account's time zone). */
export const GOOGLE_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** The account budget proposal fields an UPDATE may mask (snake_case, AccountBudgetProposal v25). */
export const BUDGET_PROPOSAL_MASK: ReadonlySet<string> = new Set([
  'proposed_name', 'proposed_end_date_time', 'proposed_end_time_type', 'proposed_spending_limit_micros', 'proposed_spending_limit_type',
])

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (o: Json, allowed: readonly string[]): string[] => Object.keys(o).filter((k) => !allowed.includes(k))
const digits = (v: unknown): boolean => (typeof v === 'string' && /^\d{1,20}$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v)

/** "customers/{c}/{collection}/{id}" of THIS customer, the id matching `id`. */
const ownName = (customer: string, collection: string, id: RegExp) => (v: unknown): boolean =>
  typeof v === 'string' && v.startsWith(`customers/${customer}/${collection}/`) && id.test(v.slice(`customers/${customer}/${collection}/`.length))
const ID = /^\d{1,20}$/

function operationOf(body: Json): Json | string {
  const extra = onlyKeys(body, ['operation'])
  if (extra.length) return `it names ${extra.join(', ')} (this method takes one operation and has no check)`
  return isObject(body.operation) ? body.operation : 'it holds no operation'
}

/** Why a body of one account call is refused, or null when it is exactly what the account tools send. */
function problemOf(call: GoogleAccountCall, body: Json): string | null {
  const c = call.customer
  switch (call.path) {
    case 'customerUserAccessInvitations:mutate': {
      const op = operationOf(body)
      if (typeof op === 'string') return op
      const kinds = Object.keys(op)
      if (kinds.length !== 1) return 'the operation is not one create or one remove'
      if (kinds[0] === 'remove') return ownName(c, 'customerUserAccessInvitations', ID)(op.remove) ? null : 'the remove does not name an invitation of this account'
      if (kinds[0] !== 'create' || !isObject(op.create)) return 'the operation is not one create or one remove'
      const create = op.create
      if (onlyKeys(create, ['emailAddress', 'accessRole']).length) return 'the invitation names more than an e-mail address and a role'
      if (typeof create.emailAddress !== 'string' || create.emailAddress.length > 254 || !EMAIL_RE.test(create.emailAddress)) return 'the invitation\'s e-mail address is not one'
      return (ACCESS_ROLES as readonly unknown[]).includes(create.accessRole) ? null : 'the invitation\'s role is not ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY'
    }
    case 'customerUserAccesses:mutate': {
      const op = operationOf(body)
      if (typeof op === 'string') return op
      const userName = ownName(c, 'customerUserAccesses', ID)
      if ('remove' in op) return Object.keys(op).length === 1 && userName(op.remove) ? null : 'the remove does not name one person\'s access to this account'
      if (onlyKeys(op, ['update', 'updateMask']).length || !isObject(op.update)) return 'the operation is not one update or one remove'
      if (op.updateMask !== 'access_role') return 'the update changes more than the role (updateMask access_role)'
      if (onlyKeys(op.update, ['resourceName', 'accessRole']).length) return 'the update names more than the role'
      if (!userName(op.update.resourceName)) return 'the update does not name one person\'s access to this account'
      return (ACCESS_ROLES as readonly unknown[]).includes(op.update.accessRole) ? null : 'the role is not ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY'
    }
    case 'productLinks:create': {
      if (onlyKeys(body, ['productLink']).length || !isObject(body.productLink)) return 'it is not one product link'
      const link = body.productLink
      if (onlyKeys(link, ['merchantCenter']).length || !isObject(link.merchantCenter)) return 'Nexus links a Merchant Center account only'
      if (onlyKeys(link.merchantCenter, ['merchantCenterId']).length || !digits(link.merchantCenter.merchantCenterId)) return 'the Merchant Center id is not one'
      return null
    }
    case 'productLinks:remove': {
      if (onlyKeys(body, ['resourceName', 'validateOnly']).length) return 'it names more than the link to remove'
      if (body.validateOnly !== undefined && typeof body.validateOnly !== 'boolean') return 'validateOnly is not true or false'
      return ownName(c, 'productLinks', ID)(body.resourceName) ? null : 'it does not name a product link of this account'
    }
    case 'productLinkInvitations:update': {
      if (onlyKeys(body, ['resourceName', 'productLinkInvitationStatus']).length) return 'it names more than the invitation and its answer'
      if (!ownName(c, 'productLinkInvitations', ID)(body.resourceName)) return 'it does not name a link invitation of this account'
      return body.productLinkInvitationStatus === 'ACCEPTED' || body.productLinkInvitationStatus === 'REJECTED' ? null : 'the answer is not ACCEPTED or REJECTED'
    }
    case 'productLinkInvitations:remove': {
      if (onlyKeys(body, ['resourceName']).length) return 'it names more than the invitation to remove'
      return ownName(c, 'productLinkInvitations', ID)(body.resourceName) ? null : 'it does not name a link invitation of this account'
    }
    case 'dataLinks:create': {
      if (onlyKeys(body, ['dataLink']).length || !isObject(body.dataLink)) return 'it is not one data link'
      const link = body.dataLink
      if (onlyKeys(link, ['youtubeVideo']).length || !isObject(link.youtubeVideo)) return 'Nexus links a YouTube video only'
      const video = link.youtubeVideo
      if (onlyKeys(video, ['channelId', 'videoId']).length) return 'the video names more than its channel and id'
      return typeof video.channelId === 'string' && YOUTUBE_CHANNEL_RE.test(video.channelId) && typeof video.videoId === 'string' && YOUTUBE_VIDEO_RE.test(video.videoId)
        ? null : 'the YouTube channel or video id is not one'
    }
    case 'dataLinks:update': {
      if (onlyKeys(body, ['resourceName', 'dataLinkStatus']).length) return 'it names more than the link and its status'
      if (!ownName(c, 'dataLinks', /^\d{1,20}~\d{1,20}$/)(body.resourceName)) return 'it does not name a data link of this account'
      return ['REVOKED', 'ENABLED', 'REJECTED'].includes(String(body.dataLinkStatus)) ? null : 'the status is not REVOKED, ENABLED or REJECTED'
    }
    case 'dataLinks:remove': {
      if (onlyKeys(body, ['resourceName']).length) return 'it names more than the link to remove'
      return ownName(c, 'dataLinks', /^\d{1,20}~\d{1,20}$/)(body.resourceName) ? null : 'it does not name a data link of this account'
    }
    case 'billingSetups:mutate': {
      const op = operationOf(body)
      if (typeof op === 'string') return op
      const kinds = Object.keys(op)
      if (kinds.length !== 1) return 'the operation is not one create or one remove'
      if (kinds[0] === 'remove') return ownName(c, 'billingSetups', ID)(op.remove) ? null : 'the remove does not name a billing setup of this account'
      if (kinds[0] !== 'create' || !isObject(op.create)) return 'the operation is not one create or one remove'
      const create = op.create
      if (onlyKeys(create, ['paymentsAccount', 'startTimeType', 'startDateTime']).length) return 'Nexus makes a billing setup for an existing payments account only (paymentsAccount, start)'
      if (!ownName(c, 'paymentsAccounts', PAYMENTS_ACCOUNT_RE)(create.paymentsAccount)) return 'it does not name a payments account of this account'
      const starts = (create.startTimeType === 'NOW' ? 1 : 0) + (typeof create.startDateTime === 'string' && GOOGLE_DATE_TIME_RE.test(create.startDateTime) ? 1 : 0)
      return starts === 1 && Object.keys(create).length === 2 ? null : 'the start is not NOW or one date-time'
    }
    case 'accountBudgetProposals:mutate': {
      if (onlyKeys(body, ['operation', 'validateOnly']).length) return 'it names more than one operation and validateOnly'
      if (body.validateOnly !== undefined && typeof body.validateOnly !== 'boolean') return 'validateOnly is not true or false'
      const op = isObject(body.operation) ? body.operation : null
      if (!op) return 'it holds no operation'
      if ('remove' in op) return Object.keys(op).length === 1 && ownName(c, 'accountBudgetProposals', ID)(op.remove) ? null : 'the remove does not name a proposal of this account'
      if (onlyKeys(op, ['create', 'updateMask']).length || !isObject(op.create)) return 'the operation is not one proposal or one remove'
      return proposalProblem(c, op.create, op.updateMask)
    }
  }
}

function proposalProblem(c: string, p: Json, mask: unknown): string | null {
  const allowed = ['proposalType', 'billingSetup', 'accountBudget', 'proposedName', 'proposedStartTimeType', 'proposedStartDateTime',
    'proposedEndTimeType', 'proposedEndDateTime', 'proposedSpendingLimitMicros', 'proposedSpendingLimitType', 'proposedPurchaseOrderNumber']
  const extra = onlyKeys(p, allowed)
  if (extra.length) return `the proposal names ${extra.join(', ')}`
  const dateTime = (v: unknown) => v === undefined || (typeof v === 'string' && GOOGLE_DATE_TIME_RE.test(v))
  if (!dateTime(p.proposedStartDateTime) || !dateTime(p.proposedEndDateTime)) return 'a date-time is not "YYYY-MM-DD HH:MM:SS"'
  if (p.proposedStartTimeType !== undefined && p.proposedStartTimeType !== 'NOW') return 'the start type is not NOW'
  if (p.proposedEndTimeType !== undefined && p.proposedEndTimeType !== 'NOW' && p.proposedEndTimeType !== 'FOREVER') return 'the end type is not NOW or FOREVER'
  if (p.proposedSpendingLimitType !== undefined && p.proposedSpendingLimitType !== 'INFINITE') return 'the spending limit type is not INFINITE'
  if (p.proposedSpendingLimitMicros !== undefined && !(typeof p.proposedSpendingLimitMicros === 'string' && /^\d{1,18}$/.test(p.proposedSpendingLimitMicros) && Number(p.proposedSpendingLimitMicros) % 10_000 === 0)) {
    return 'the spending limit is not whole cents in micros'
  }
  if (p.proposedSpendingLimitMicros !== undefined && p.proposedSpendingLimitType !== undefined) return 'it names a spending limit and an unlimited one'
  if (p.proposedName !== undefined && !text(p.proposedName, 255)) return 'the budget name is not 1 to 255 characters on one line'
  if (p.proposedPurchaseOrderNumber !== undefined && (p.proposalType !== 'CREATE' || !text(p.proposedPurchaseOrderNumber, 255))) {
    return 'a purchase order number is 1 to 255 characters on one line, on a new budget only'
  }
  const budget = ownName(c, 'accountBudgets', ID)
  switch (p.proposalType) {
    case 'CREATE':
      if (mask !== undefined) return 'a new budget takes no updateMask'
      if (!ownName(c, 'billingSetups', ID)(p.billingSetup) || p.accountBudget !== undefined) return 'a new budget names its billing setup of this account (and no budget)'
      if (!text(p.proposedName, 255)) return 'a new budget has a name'
      if ((p.proposedStartTimeType === undefined) === (p.proposedStartDateTime === undefined)) return 'a new budget has one start'
      if ((p.proposedEndTimeType === undefined) === (p.proposedEndDateTime === undefined)) return 'a new budget has one end'
      if ((p.proposedSpendingLimitMicros === undefined) === (p.proposedSpendingLimitType === undefined)) return 'a new budget has one spending limit'
      return null
    case 'UPDATE': {
      if (!budget(p.accountBudget) || p.billingSetup !== undefined) return 'a change names one account budget of this account'
      if (p.proposedStartTimeType !== undefined || p.proposedStartDateTime !== undefined) return 'a change does not move the start'
      const paths = typeof mask === 'string' ? mask.split(',') : []
      if (!paths.length || paths.some((x) => !BUDGET_PROPOSAL_MASK.has(x))) return 'a change masks only the name, the end and the spending limit'
      return null
    }
    case 'END':
    case 'REMOVE':
      if (mask !== undefined) return `${p.proposalType === 'END' ? 'an end' : 'a removal'} takes no updateMask`
      if (!budget(p.accountBudget) || Object.keys(p).length !== 2) return `${p.proposalType === 'END' ? 'an end' : 'a removal'} names one account budget of this account and nothing else`
      return null
    default:
      return 'the proposal type is not CREATE, UPDATE, END or REMOVE'
  }
}

/**
 * An account call's body as the gateway judges it, or why it is refused. `check` is true only for a body that asks
 * Google to check it (validateOnly true, on the two methods that have it). The parsed body is what is sent.
 */
export function googleAccountCallBodyOf(call: GoogleAccountCall, body: unknown): { check: boolean; body: string } | { refusal: string } {
  if (typeof body !== 'string') return { refusal: 'the body is not JSON text' }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return { refusal: 'the body is not JSON' } }
  if (!isObject(parsed)) return { refusal: 'the body is not a JSON object' }
  if (Object.keys(parsed).some((k) => k.includes('_'))) return { refusal: 'the body names a field in snake_case' }
  const problem = problemOf(call, parsed)
  if (problem) return { refusal: problem }
  return { check: GOOGLE_ACCOUNT_CHECKABLE.has(call.path) && parsed.validateOnly === true, body: JSON.stringify(parsed) }
}

/**
 * GoogleAdsService.Mutate `customerOperation` (G8b): the account's own settings, an UPDATE only (CustomerOperation v25
 * has `update` and `update_mask` and nothing else: "Only updates are supported for customer"; a new account is
 * CustomerService.CreateCustomerClient, which Nexus never calls). Exactly the fields set-google-account-settings writes,
 * checked in reference/rpc/v25/Customer (curl, 2026-10-15): auto_tagging_enabled, tracking_url_template,
 * final_url_suffix ("Only mutable in an update operation"), descriptive_name, call_reporting_setting.{call_reporting_enabled,
 * call_conversion_reporting_enabled, call_conversion_action} and video_brand_safety_suitability (no field behaviour =
 * mutable). Everything else on Customer is Output only or Immutable.
 */
export const CUSTOMER_UPDATE_MASK: ReadonlySet<string> = new Set([
  'auto_tagging_enabled', 'tracking_url_template', 'final_url_suffix', 'descriptive_name',
  'call_reporting_setting.call_reporting_enabled', 'call_reporting_setting.call_conversion_reporting_enabled',
  'call_reporting_setting.call_conversion_action', 'video_brand_safety_suitability',
])
const CUSTOMER_UPDATE_FIELDS = ['resourceName', 'autoTaggingEnabled', 'trackingUrlTemplate', 'finalUrlSuffix', 'descriptiveName', 'callReportingSetting', 'videoBrandSafetySuitability']

/** Why a customerOperation is refused (a create, a remove, another field, another customer), or null. */
export function customerOperationProblem(op: unknown, customer?: string | null): string | null {
  if (!isObject(op)) return 'the customer operation is not an object'
  if (onlyKeys(op, ['update', 'updateMask']).length || !isObject(op.update)) return 'a customer operation is an update of the account\'s settings only (no create, no remove)'
  const update = op.update
  const name = update.resourceName
  if (typeof name !== 'string' || !/^customers\/\d{1,20}$/.test(name) || (customer && name !== `customers/${customer}`)) return 'the customer update does not name this account'
  if (onlyKeys(update, CUSTOMER_UPDATE_FIELDS).length) return 'the customer update names a field Nexus does not change'
  if (update.callReportingSetting !== undefined && (!isObject(update.callReportingSetting) || onlyKeys(update.callReportingSetting, ['callReportingEnabled', 'callConversionReportingEnabled', 'callConversionAction']).length)) {
    return 'the call reporting setting names a field Nexus does not change'
  }
  const paths = typeof op.updateMask === 'string' ? op.updateMask.split(',') : []
  if (!paths.length || paths.some((p) => !CUSTOMER_UPDATE_MASK.has(p))) return 'the customer update masks a field Nexus does not change'
  return null
}
