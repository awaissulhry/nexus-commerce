/**
 * GAP2 phase 2 — subscribe each eBay account to ORDER_CONFIRMATION with that seller's own sign-in.
 *
 * `ORDER_CONFIRMATION` is a USER topic: eBay delivers it for one seller, so the subscription is
 * made with THAT seller's token (scope `commerce.notification.subscription`), on the one
 * application destination the app-level setup creates (`notifications.ts`). Every call here goes
 * through `ebayTransport(connectionId)` with no Authorization header, so the gateway takes the
 * token of exactly that account from the token service; the app token or another seller's token
 * is never used for a seller subscription. The app token is used only to READ eBay's topic
 * catalogue and our destination, when the caller did not pass them.
 *
 * Gates, all before any eBay call:
 * - the Owner's arming: `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` AND `ORDER_CONFIRMATION` named in
 *   `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`. Unarmed, nothing is read and no token is fetched;
 * - the account: active, signed in, and its sign-in records `commerce.notification.subscription`
 *   and a fulfillment scope. Otherwise the result is "reconnect needed" and no call is made;
 * - eBay's catalogue offers the topic as a USER topic with a JSON/HTTPS payload version.
 *
 * Idempotent and never deleting: an enabled subscription on our destination is left alone, a
 * disabled one is enabled, a missing one is created. "Reconnect needed" is only what the account
 * itself shows (a held sign-in, a missing recorded scope). eBay's errorId 195011 ("not authorized
 * for this topic") arrives only AFTER that check passed, so it is `failed`, which turns the nightly
 * run red: pressing Reconnect would not fix it. errorId 195012 / 409 ("subscription already
 * exists") re-reads the seller's list. A stored order notice stays held behind
 * NEXUS_ENABLE_EBAY_ORDER_NOTICES; the 5-minute order poll is unchanged.
 */
import prisma from '../../../../db.js'
import { logger } from '../../../../utils/logger.js'
import { withWorkspace } from '../../../../lib/workspace-context.js'
import { legacyIngress } from '../../../../lib/workspace-ingress.js'
import { isOwnConnection, listActiveConnections } from '../../../connection-resolver.service.js'
import { EBAY_SCOPE_BASE } from './scopes.js'
import {
  EBAY_NOTIFICATION_ARMED_TOPICS, EbayNotificationHttpError, EbayNotificationNotArmedError,
  armedSellerTopics, createdResourceId, describeEbayNotificationError, ebayNotificationConfig, getEbayDestinations,
  getEbaySellerSubscriptions, getEbayTopics, sellerNotificationCall, subscriptionPayloadUsable, usableTopicPayloads,
  type EbayEnvironment, type EbayNotificationSetupResult, type EbaySubscription, type EbayTopic, type NotificationAnswer,
} from './notifications.js'

export const EBAY_ORDER_TOPIC = 'ORDER_CONFIRMATION'
const SUBSCRIBE_SCOPE = `${EBAY_SCOPE_BASE}/commerce.notification.subscription`
const FULFILLMENT_SCOPES = [`${EBAY_SCOPE_BASE}/sell.fulfillment`, `${EBAY_SCOPE_BASE}/sell.fulfillment.readonly`]
/** eBay Notification API 403 "Not authorized for this topic" (createSubscription et al.). */
export const EBAY_MISSING_SCOPE_ERROR_ID = 195011
/** eBay Notification API 409 "Subscription already exists" (createSubscription). */
export const EBAY_SUBSCRIPTION_EXISTS_ERROR_ID = 195012
const SIGN_IN_HELD = ['needs_reauth', 'revoked', 'disconnected']

export type EbaySellerSubscriptionStatus = 'subscribed' | 'created' | 'enabled' | 'reconnect_needed' | 'not_armed' | 'not_offered' | 'failed'

/** What one account's reconcile did. `subscribed` = already there and enabled, nothing written. */
export interface EbaySellerSubscriptionResult {
  connectionId: string
  topicId: string
  status: EbaySellerSubscriptionStatus
  subscriptionId?: string
  reason?: string
}

/** What the status route reports for one account (read only). */
export type EbaySellerSubscriptionState = 'subscribed' | 'not_subscribed' | 'disabled' | 'reconnect_needed' | 'not_armed' | 'not_offered' | 'failed'

/** What the app-level setup knows, so each account does not read it again. */
export interface EbaySellerSubscriptionContext {
  environment: EbayEnvironment
  /** Our ENABLED destination at eBay; null when there is none. */
  destinationId: string | null
  /** eBay's catalogue entry for ORDER_CONFIRMATION; undefined when eBay does not offer it. */
  topic: EbayTopic | undefined
}

type Problem = { status: 'reconnect_needed' | 'failed' | 'not_offered'; reason: string }

const RECONNECT = 'Press Reconnect on this eBay account in Settings → Channels so eBay grants it.'

/** Scopes a grant covers, a full scope implying its `.readonly` twin. */
function coveredScopes(granted: string[]): Set<string> {
  const covered = new Set(granted)
  for (const scope of granted) if (!scope.endsWith('.readonly')) covered.add(`${scope}.readonly`)
  return covered
}

/** The account's own facts, from the database only: no token, no eBay call. */
async function readAccount(connectionId: string): Promise<{ problem: Problem } | { covered: Set<string> }> {
  const row = await prisma.channelConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, channelType: true, isActive: true, authStatus: true, grantedScopes: true },
  })
  if (!row || row.channelType !== 'EBAY') return { problem: { status: 'failed', reason: 'No eBay account with this id in this business. No eBay call was made.' } }
  if (!row.isActive || SIGN_IN_HELD.includes(row.authStatus)) {
    return { problem: { status: 'reconnect_needed', reason: `The account is ${row.isActive ? row.authStatus : 'inactive'}. ${RECONNECT} No eBay call was made.` } }
  }
  const covered = coveredScopes(row.grantedScopes ?? [])
  if (!covered.has(SUBSCRIBE_SCOPE)) {
    return { problem: { status: 'reconnect_needed', reason: `The sign-in does not record the commerce.notification.subscription permission. ${RECONNECT} No eBay call was made.` } }
  }
  if (!FULFILLMENT_SCOPES.some(scope => covered.has(scope))) {
    return { problem: { status: 'reconnect_needed', reason: `The sign-in does not record a sell.fulfillment permission, which the order topic needs. ${RECONNECT} No eBay call was made.` } }
  }
  return { covered }
}

/** eBay's word on the topic: offered, per seller, with a JSON/HTTPS payload this account may receive. */
function topicProblem(topic: EbayTopic | undefined, covered: Set<string>): Problem | null {
  if (!topic) return { status: 'not_offered', reason: `eBay's topic catalogue has no ${EBAY_ORDER_TOPIC} for this application. No seller call was made.` }
  if ((topic.scope ?? '').toUpperCase() !== 'USER') {
    return { status: 'failed', reason: `eBay lists ${EBAY_ORDER_TOPIC} with scope ${topic.scope ?? '(none)'}; only USER topics are subscribed per seller. No seller call was made.` }
  }
  if (!usableTopicPayloads(topic).length) return { status: 'failed', reason: `eBay lists ${EBAY_ORDER_TOPIC} with no usable JSON/HTTPS payload version. No seller call was made.` }
  const needs = topic.authorizationScopes ?? []
  if (needs.length && !needs.some(scope => covered.has(scope))) {
    return { status: 'reconnect_needed', reason: `eBay's catalogue says ${EBAY_ORDER_TOPIC} needs one of: ${needs.join(', ')}; the sign-in records none. ${RECONNECT} No seller call was made.` }
  }
  return null
}

/**
 * eBay's 195011 always comes after `readAccount` found the needed scopes recorded on the sign-in,
 * so it is eBay refusing the topic to this app or account: a failure to look at, not a Reconnect.
 */
function refusedTopic(operation: string): Problem {
  return { status: 'failed', reason: `eBay refused this topic for the app/account (errorId ${EBAY_MISSING_SCOPE_ERROR_ID} on ${operation}) — not a sign-in problem: the sign-in records the permissions the topic needs, so Reconnect will not fix it. Check that the eBay application is allowed ${EBAY_ORDER_TOPIC}.` }
}

/** eBay's answer or a thrown refusal, as a result. Only a held sign-in means "reconnect". */
function problemOf(err: unknown, operation = 'getSubscriptions'): Problem | { status: 'not_armed'; reason: string } {
  if (err instanceof EbayNotificationNotArmedError) return { status: 'not_armed', reason: err.message }
  if (err instanceof EbayNotificationHttpError && err.errorIds.includes(EBAY_MISSING_SCOPE_ERROR_ID)) return refusedTopic(operation)
  // The gateway refuses an account that needs signing in before it fetches a token or sends anything.
  if ((err as { code?: unknown } | null)?.code === 'ACCOUNT_NEEDS_SIGNIN') {
    return { status: 'reconnect_needed', reason: `${err instanceof Error ? err.message : 'The account needs signing in.'} ${RECONNECT}` }
  }
  return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
}

function answerProblem(operation: string, answer: NotificationAnswer<unknown>): Problem {
  if (answer.errorIds.includes(EBAY_MISSING_SCOPE_ERROR_ID)) return refusedTopic(operation)
  return { status: 'failed', reason: describeEbayNotificationError(operation, answer.status, answer.text) }
}

/**
 * eBay's catalogue entry for the topic and our destination, read with the app token (reads only).
 * The nightly job and the admin setup pass what the app-level setup already read instead.
 */
export async function ebaySellerSubscriptionContext(environment: EbayEnvironment = 'production'): Promise<EbaySellerSubscriptionContext> {
  const { endpoint } = ebayNotificationConfig()
  const topics = await getEbayTopics(environment)
  const destinations = endpoint ? await getEbayDestinations(environment) : []
  const ours = destinations.find(d => d.endpoint === endpoint && (d.status ?? '').toUpperCase() === 'ENABLED')
  return { environment, destinationId: ours?.destinationId ?? null, topic: topics.find(t => t.topicId === EBAY_ORDER_TOPIC) }
}

const NO_DESTINATION = 'Our eBay destination is missing or not ENABLED; the application-level setup creates it first. No seller call was made.'

/**
 * Subscribe ONE eBay account to ORDER_CONFIRMATION with that seller's own token.
 * Never throws: every outcome is a plain result.
 */
export async function reconcileEbaySellerSubscriptions(
  connectionId: string,
  options: { context?: EbaySellerSubscriptionContext; environment?: EbayEnvironment } = {},
): Promise<EbaySellerSubscriptionResult> {
  const topicId = EBAY_ORDER_TOPIC
  const result = (status: EbaySellerSubscriptionStatus, extra: { subscriptionId?: string; reason?: string } = {}): EbaySellerSubscriptionResult =>
    ({ connectionId, topicId, status, ...extra })
  // Before anything else: unarmed means no database read of the account, no token, no call.
  if (!armedSellerTopics().includes(topicId)) {
    return result('not_armed', { reason: `${EBAY_NOTIFICATION_ARMED_TOPICS} does not arm ${topicId} (or setup is not armed). No eBay call was made.` })
  }
  try {
    const account = await readAccount(connectionId)
    if ('problem' in account) return result(account.problem.status, { reason: account.problem.reason })
    const context = options.context ?? await ebaySellerSubscriptionContext(options.environment)
    const environment = context.environment
    const blocked = topicProblem(context.topic, account.covered)
    if (blocked) return result(blocked.status, { reason: blocked.reason })
    if (!context.destinationId) return result('failed', { reason: NO_DESTINATION })
    const payloads = usableTopicPayloads(context.topic!)

    /** An existing subscription on OUR destination: keep it, or enable it. */
    const settle = async (existing: EbaySubscription): Promise<EbaySellerSubscriptionResult> => {
      if (!subscriptionPayloadUsable(existing, payloads)) {
        return result('failed', { subscriptionId: existing.subscriptionId, reason: 'The existing subscription payload is not one of the advertised JSON/HTTPS schemas; repair it before enabling.' })
      }
      if ((existing.status ?? '').toUpperCase() === 'ENABLED') return result('subscribed', { subscriptionId: existing.subscriptionId })
      const enable = await sellerNotificationCall(connectionId, environment, 'POST', `/commerce/notification/v1/subscription/${encodeURIComponent(existing.subscriptionId)}/enable`)
      if (enable.status !== 204 && enable.status !== 200) {
        const problem = answerProblem('enableSubscription', enable)
        return result(problem.status, { subscriptionId: existing.subscriptionId, reason: problem.reason })
      }
      logger.warn('[ebay-seller-subscriptions] a disabled order subscription was enabled', { connectionId })
      return result('enabled', { subscriptionId: existing.subscriptionId })
    }
    const ours = (list: EbaySubscription[]) => list.find(s => s.topicId === topicId && s.destinationId === context.destinationId)

    const existing = ours(await getEbaySellerSubscriptions(connectionId, environment))
    if (existing) return await settle(existing)

    const created = await sellerNotificationCall<{ subscriptionId?: string }>(connectionId, environment, 'POST', '/commerce/notification/v1/subscription', {
      topicId, destinationId: context.destinationId, status: 'ENABLED',
      payload: { format: 'JSON', schemaVersion: payloads[0]!.schemaVersion, deliveryProtocol: 'HTTPS' },
    })
    if (created.status === 409 || created.errorIds.includes(EBAY_SUBSCRIPTION_EXISTS_ERROR_ID)) {
      // "Subscription already exists": a concurrent run made it, or the seller holds the topic on
      // another destination of this app. Read the list again instead of failing every night.
      const again = await getEbaySellerSubscriptions(connectionId, environment)
      const mine = ours(again)
      if (mine) return await settle(mine)
      const elsewhere = again.find(s => s.topicId === topicId)
      if (elsewhere) {
        return result('failed', { subscriptionId: elsewhere.subscriptionId, reason: `eBay already holds ${topicId} for this account on another destination (${elsewhere.destinationId ?? 'unknown'}), not on ours (${context.destinationId}); notices go there, not to Nexus. Disabling or deleting it at eBay needs a separate yes; then run the setup again.` })
      }
      return result('failed', { reason: `${describeEbayNotificationError('createSubscription', created.status, created.text)} — eBay says the subscription exists, but the account's list shows none for ${topicId}.` })
    }
    if (created.status !== 201 && created.status !== 200) {
      const problem = answerProblem('createSubscription', created)
      return result(problem.status, { reason: problem.reason })
    }
    const subscriptionId = createdResourceId(created.location, environment, 'subscription') ?? created.body?.subscriptionId
    if (!subscriptionId) return result('failed', { reason: 'eBay created the subscription but returned no usable subscription ID.' })
    logger.warn('[ebay-seller-subscriptions] order subscription created', { connectionId })
    return result('created', { subscriptionId })
  } catch (err) {
    const problem = problemOf(err)
    return result(problem.status, { reason: problem.reason })
  }
}

export interface EbaySellerTestNoticeResult {
  ok: boolean
  topicId: string
  connectionId: string
  subscriptionId?: string
  /** Why nothing was sent to eBay's test endpoint, when nothing was. */
  refused?: 'not_armed' | 'not_own_account' | 'account' | 'no_subscription'
  error?: string
}

/**
 * Ask eBay to send its test notice for ONE seller's ORDER_CONFIRMATION subscription on our
 * destination (`POST /subscription/{id}/test`, 202), with that seller's own token. The notice
 * arrives signed at the receiver like a real one. Only an account of the business this runs in is
 * tested; never the app token for the subscription calls.
 */
export async function sendEbaySellerTestNotice(connectionId: string, environment: EbayEnvironment = 'production'): Promise<EbaySellerTestNoticeResult> {
  const topicId = EBAY_ORDER_TOPIC
  const refuse = (refused: EbaySellerTestNoticeResult['refused'], error: string, subscriptionId?: string): EbaySellerTestNoticeResult =>
    ({ ok: false, topicId, connectionId, refused, error, ...(subscriptionId ? { subscriptionId } : {}) })
  if (!armedSellerTopics().includes(topicId)) return refuse('not_armed', `${EBAY_NOTIFICATION_ARMED_TOPICS} does not arm ${topicId}. No eBay call was made.`)
  try {
    if (!(await ownEbayAccounts()).some(account => account.id === connectionId)) {
      return refuse('not_own_account', "connectionId is not one of this business's own active eBay accounts. No eBay call was made.")
    }
    const account = await readAccount(connectionId)
    if ('problem' in account) return refuse('account', account.problem.reason)
    const context = await ebaySellerSubscriptionContext(environment)
    if (!context.destinationId) return refuse('no_subscription', NO_DESTINATION)
    const subscription = (await getEbaySellerSubscriptions(connectionId, environment))
      .find(s => s.topicId === topicId && s.destinationId === context.destinationId)
    if (!subscription || (subscription.status ?? '').toUpperCase() !== 'ENABLED') {
      return refuse('no_subscription', `This account has no ENABLED ${topicId} subscription on our destination${subscription ? ` (it is ${subscription.status ?? 'of unknown status'})` : ''}. Run the setup first. No test notice was requested.`, subscription?.subscriptionId)
    }
    const res = await sellerNotificationCall(connectionId, environment, 'POST', `/commerce/notification/v1/subscription/${encodeURIComponent(subscription.subscriptionId)}/test`)
    if ([200, 202, 204].includes(res.status)) return { ok: true, topicId, connectionId, subscriptionId: subscription.subscriptionId }
    return { ok: false, topicId, connectionId, subscriptionId: subscription.subscriptionId, error: answerProblem('testSubscription', res).reason }
  } catch (err) {
    const problem = problemOf(err)
    return { ok: false, topicId, connectionId, ...(problem.status === 'not_armed' ? { refused: 'not_armed' as const } : {}), error: problem.reason }
  }
}

/** One account's subscription as eBay holds it, read with that seller's token. Never writes. */
export async function inspectEbaySellerSubscription(
  connectionId: string, context: EbaySellerSubscriptionContext,
): Promise<{ connectionId: string; topicId: string; status: EbaySellerSubscriptionState; reason?: string }> {
  const topicId = EBAY_ORDER_TOPIC
  const state = (status: EbaySellerSubscriptionState, reason?: string) => ({ connectionId, topicId, status, ...(reason ? { reason } : {}) })
  try {
    // Local facts first, so the list of accounts that need Reconnect is there before arming.
    const account = await readAccount(connectionId)
    if ('problem' in account) return state(account.problem.status, account.problem.reason)
    if (!armedSellerTopics().includes(topicId)) return state('not_armed', `${EBAY_NOTIFICATION_ARMED_TOPICS} does not arm ${topicId}. No eBay call was made.`)
    const blocked = topicProblem(context.topic, account.covered)
    if (blocked) return state(blocked.status, blocked.reason)
    if (!context.destinationId) return state('failed', NO_DESTINATION)
    const ours = (await getEbaySellerSubscriptions(connectionId, context.environment))
      .find(s => s.topicId === topicId && s.destinationId === context.destinationId)
    if (!ours) return state('not_subscribed')
    return state((ours.status ?? '').toUpperCase() === 'ENABLED' ? 'subscribed' : 'disabled')
  } catch (err) {
    const problem = problemOf(err)
    return state(problem.status, problem.reason)
  }
}

/**
 * eBay's subscription records name no seller, so "this one is ours" rests on eBay listing, for a
 * seller's token, only that seller's subscriptions. If two accounts ever report the same
 * subscription, that rest is gone: the later one is a failure to look at, never "subscribed".
 */
function refuseSharedSubscription<T extends { connectionId: string; status: string; subscriptionId?: string; reason?: string }>(
  seen: Map<string, string>, result: T,
): T {
  if (!result.subscriptionId) return result
  const owner = seen.get(result.subscriptionId)
  if (owner && owner !== result.connectionId) {
    return { ...result, status: 'failed', reason: `eBay reported the same ${EBAY_ORDER_TOPIC} subscription for two eBay accounts; Nexus cannot tell whose it is. Check it at eBay before relying on order notices.` }
  }
  seen.set(result.subscriptionId, result.connectionId)
  return result
}

/** This business's own active eBay accounts. An account another business shares in is its owner's to subscribe. */
async function ownEbayAccounts(): Promise<Array<{ id: string; signInName: string | null }>> {
  return (await listActiveConnections('EBAY')).filter(isOwnConnection).map(row => ({ id: row.id, signInName: row.ebaySignInName ?? null }))
}

/**
 * Runs `work` in every active business. Not `visitActiveWorkspaces`: the nightly reconcile is a
 * platform cron, whose handler already runs inside the legacy business, and that helper then
 * visits only that one. Same bounded read as the eBay erasure review. Without business profiles
 * it runs once.
 */
async function visitEveryActiveBusiness(work: () => Promise<void>): Promise<void> {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') { await work(); return }
  let after: string | undefined
  do {
    const rows = await legacyIngress(() => prisma.workspace.findMany({
      where: { status: 'active', ...(after ? { id: { gt: after } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: 50,
    }))
    for (const row of rows) await withWorkspace({ workspaceId: row.id, actorUserId: null, membershipId: null, roleKeys: [] }, work)
    after = rows.length === 50 ? rows[rows.length - 1]!.id : undefined
  } while (after)
}

export interface EbaySellerReconcileReport {
  /** Why no account was visited, when none was. */
  skipped?: string
  accounts: Array<EbaySellerSubscriptionResult & { signInName: string | null }>
  /** Businesses whose accounts could not be listed; the others still ran. */
  businessErrors?: string[]
}

/**
 * After the app-level setup: subscribe each active eBay account. `every_business` (the nightly
 * job) visits every active business; `this_business` (the admin route) only the business the
 * request runs in, as request-triggered work keeps its business.
 */
export async function reconcileEbaySellersForSetup(
  setup: EbayNotificationSetupResult, scope: 'every_business' | 'this_business',
): Promise<EbaySellerReconcileReport> {
  if (!armedSellerTopics().includes(EBAY_ORDER_TOPIC)) return { skipped: `${EBAY_NOTIFICATION_ARMED_TOPICS} does not arm ${EBAY_ORDER_TOPIC}; no seller was visited.`, accounts: [] }
  if (!setup.configured || !setup.armed || setup.error || !setup.destinationId) {
    return { skipped: 'The application-level setup did not finish, so no seller was subscribed.', accounts: [] }
  }
  const context: EbaySellerSubscriptionContext = {
    environment: setup.environment, destinationId: setup.destinationId,
    topic: (setup.sellerTopics ?? []).find(topic => topic.topicId === EBAY_ORDER_TOPIC),
  }
  const accounts: EbaySellerReconcileReport['accounts'] = []
  const businessErrors: string[] = []
  const seen = new Map<string, string>()
  const visit = scope === 'every_business' ? visitEveryActiveBusiness : (work: () => Promise<void>) => work()
  await visit(async () => {
    let own: Awaited<ReturnType<typeof ownEbayAccounts>>
    try {
      own = await ownEbayAccounts()
    } catch (err) {
      // One business's read failing must not stop the others; the run still reports it as failed.
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[ebay-seller-subscriptions] could not list the eBay accounts of a business', { error: message })
      businessErrors.push(message.slice(0, 200))
      return
    }
    for (const account of own) {
      accounts.push({ ...refuseSharedSubscription(seen, await reconcileEbaySellerSubscriptions(account.id, { context })), signInName: account.signInName })
    }
  })
  return { accounts, ...(businessErrors.length ? { businessErrors } : {}) }
}

/** The status route: each of this business's eBay accounts, read only. */
export async function ebaySellerSubscriptionStatus(context: EbaySellerSubscriptionContext): Promise<{
  topicId: string; armed: boolean; accounts: Array<{ connectionId: string; signInName: string | null; status: EbaySellerSubscriptionState; reason?: string }>
}> {
  const accounts = []
  for (const account of await ownEbayAccounts()) {
    const { connectionId, status, reason } = await inspectEbaySellerSubscription(account.id, context)
    accounts.push({ connectionId, signInName: account.signInName, status, ...(reason ? { reason } : {}) })
  }
  return { topicId: EBAY_ORDER_TOPIC, armed: armedSellerTopics().includes(EBAY_ORDER_TOPIC), accounts }
}

/** One line for a CronRun or a log: counts per status, never an id. */
export function summariseSellerReport(report: EbaySellerReconcileReport): string {
  if (report.skipped) return `sellers: skipped (${report.skipped})`
  const counts = new Map<string, number>()
  for (const account of report.accounts) counts.set(account.status, (counts.get(account.status) ?? 0) + 1)
  const errors = report.businessErrors?.length ? ` business_errors=${report.businessErrors.length}` : ''
  return `sellers: ${report.accounts.length ? [...counts].map(([status, n]) => `${status}=${n}`).join(' ') : 'no eBay account'}${errors}`
}

/** A seller outcome the nightly run must not report as success. "Reconnect needed" is the Owner's step, not a fault. */
export function sellerReportFailed(report: EbaySellerReconcileReport): boolean {
  return !!report.businessErrors?.length || report.accounts.some(account => account.status === 'failed' || account.status === 'not_offered')
}
