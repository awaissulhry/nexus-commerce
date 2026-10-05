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
 * disabled one is enabled, a missing one is created. eBay's errorId 195011 (missing scope) stops
 * with "reconnect needed". A stored order notice stays held behind NEXUS_ENABLE_EBAY_ORDER_NOTICES;
 * the 5-minute order poll is unchanged.
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
  type EbayEnvironment, type EbayNotificationSetupResult, type EbayTopic, type NotificationAnswer,
} from './notifications.js'

export const EBAY_ORDER_TOPIC = 'ORDER_CONFIRMATION'
const SUBSCRIBE_SCOPE = `${EBAY_SCOPE_BASE}/commerce.notification.subscription`
const FULFILLMENT_SCOPES = [`${EBAY_SCOPE_BASE}/sell.fulfillment`, `${EBAY_SCOPE_BASE}/sell.fulfillment.readonly`]
/** eBay Notification API: the token lacks the scope the call needs (createSubscription et al.). */
export const EBAY_MISSING_SCOPE_ERROR_ID = 195011
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

/** eBay's answer or a thrown refusal, as a result. 195011 and a held sign-in mean "reconnect". */
function problemOf(err: unknown): Problem | { status: 'not_armed'; reason: string } {
  if (err instanceof EbayNotificationNotArmedError) return { status: 'not_armed', reason: err.message }
  if (err instanceof EbayNotificationHttpError && err.errorIds.includes(EBAY_MISSING_SCOPE_ERROR_ID)) {
    return { status: 'reconnect_needed', reason: `eBay answered errorId ${EBAY_MISSING_SCOPE_ERROR_ID}: this sign-in lacks the permission to subscribe. ${RECONNECT}` }
  }
  // The gateway refuses an account that needs signing in before it fetches a token or sends anything.
  if ((err as { code?: unknown } | null)?.code === 'ACCOUNT_NEEDS_SIGNIN') {
    return { status: 'reconnect_needed', reason: `${err instanceof Error ? err.message : 'The account needs signing in.'} ${RECONNECT}` }
  }
  return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
}

function answerProblem(operation: string, answer: NotificationAnswer<unknown>): Problem {
  if (answer.errorIds.includes(EBAY_MISSING_SCOPE_ERROR_ID)) {
    return { status: 'reconnect_needed', reason: `eBay answered errorId ${EBAY_MISSING_SCOPE_ERROR_ID} to ${operation}: this sign-in lacks the permission to subscribe. ${RECONNECT}` }
  }
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

    const existing = (await getEbaySellerSubscriptions(connectionId, environment))
      .find(s => s.topicId === topicId && s.destinationId === context.destinationId)
    if (existing) {
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

    const created = await sellerNotificationCall<{ subscriptionId?: string }>(connectionId, environment, 'POST', '/commerce/notification/v1/subscription', {
      topicId, destinationId: context.destinationId, status: 'ENABLED',
      payload: { format: 'JSON', schemaVersion: payloads[0]!.schemaVersion, deliveryProtocol: 'HTTPS' },
    })
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
      accounts.push({ ...await reconcileEbaySellerSubscriptions(account.id, { context }), signInName: account.signInName })
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
