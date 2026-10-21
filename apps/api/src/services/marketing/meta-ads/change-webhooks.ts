/**
 * Meta step 30 part 2 (2026-10-21) — the drafts of set-meta-webhooks: one action per change, built from the live state
 * (live-webhook-setup.ts) without any call of its own. Pure. Part 3: install-page on step 36's Page-token mode.
 *
 *   subscribe-app          POST /<app id>/subscriptions — the app's fields of ONE object (ad_account, application, page,
 *                          catalog, permissions), the callback Nexus's own receiver, include_values=true (WH-005)
 *   unsubscribe-app        DELETE /<app id>/subscriptions?object=…[&fields=…] — never without an object (WH-007)
 *   connect-ad-account     POST /act_<id>/subscribed_apps app_id — the CHOSEN ad account delivers to the app (WH-008)
 *   disconnect-ad-account  DELETE /act_<id>/subscribed_apps?app_id=… (WH-009)
 *   install-page           POST /<page>/subscribed_apps subscribed_fields — the CHOSEN Page, with its own token (part 3:
 *                          step 36's mode, the gateway reads it), standing on the Page's apps read with the same token
 *                          (WH-010). The whole list it wants is sent (the Page's own fields Nexus takes, plus the asked
 *                          ones; by default feed, mention and product_review: no Messenger field, no leadgen). Whether
 *                          Meta replaces the Page's list or adds to it is not documented, and Nexus's own calls cannot
 *                          tell the two apart (every POST it sends holds every Nexus field already on the Page): sending
 *                          the whole list is safe either way. `exact` makes it exactly the asked ones: a removal (the app
 *                          token) and a POST when one must go (the undo's way back); when only the removal happens, the
 *                          app is off the Page until install-page runs again (the run says so; its undo installs the
 *                          earlier fields)
 *   install-page instagram the per-account step of the Instagram account (WH-013): its linked Page — which must be the
 *                          chosen Page, linked to the chosen Instagram account — gets the app with ONE Page field. Meta's
 *                          docs disagree on what this step takes: the v26 Instagram webhooks setup (Facebook Login) POSTs
 *                          the linked Page's /subscribed_apps with subscribed_fields = the Instagram fields chosen in the
 *                          App Dashboard; the page/subscribed_apps reference says subscribed_fields cannot subscribe
 *                          Instagram webhooks and its list names no Instagram field; only Meta's older Instagram guide says
 *                          any Page field. LIVE-PROBES WH-013p decides it. Nexus sends Page fields only (the gateway's
 *                          list): if Meta needs the Instagram field names there, Nexus cannot do this step and the Owner
 *                          does it in the App Dashboard. Nothing here says Meta delivers the Instagram notifications
 *   remove-page            DELETE /<page>/subscribed_apps with the app token (WH-012); its undo installs the fields it had
 *                          again (read with the Page token; when Nexus cannot read them, no undo)
 * App subscriptions are APP-WIDE (review A1, D-1): when another business in Nexus uses the same Meta app, an unsubscribe
 * would stop its notifications too — refused, and a subscribe says it changes what that business receives as well. A
 * Page's install is the Page's own (not app-wide).
 * Instagram and WhatsApp FIELDS are set only in Meta's App Dashboard: answered plainly, nothing sent.
 *
 * Undo puts back what the change replaced, through this same tool: fields it added are removed, a removed subscription
 * is subscribed again (only fields Nexus takes, only to Nexus's own callback), a connection is taken away again and the
 * other way round. What has no way back is said (noUndo). Field lists are kept sorted (Meta lists them in any order).
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { AppSubscriptionState, PageAppState } from './live-webhook-setup.js'
import { META_WEBHOOK_OBJECTS, metaWebhookFieldsOf } from '../../gateway/meta-webhook-rules.js'

export const WEBHOOK_ACTIONS = ['subscribe-app', 'unsubscribe-app', 'connect-ad-account', 'disconnect-ad-account', 'install-page', 'remove-page'] as const
export type WebhookAction = typeof WEBHOOK_ACTIONS[number]
/** What a person can name as the object of an app subscription: Meta's API objects, and the two only its dashboard sets. */
export const WEBHOOK_OBJECT_NAMES = [...META_WEBHOOK_OBJECTS, 'instagram', 'whatsapp_business_account'] as const

export interface WebhooksRequest {
  action: WebhookAction
  object?: string
  fields?: string[]
  /** install-page: the Page's fields become exactly `fields` (default: added to the ones it has). */
  exact?: boolean
}

/** The arguments of set-meta-webhooks that put a change back (its undo): an action and what it names. */
export interface WebhooksUndoArgs { action: WebhookAction; object?: string; fields?: string[]; exact?: boolean }

export interface WebhooksRecord {
  action: WebhookAction
  object?: string | null
  /** Part 3 — the Page an install-page or remove-page is of (the chosen one when it ran). */
  pageId?: string | null
  /** The object's subscribed fields (sorted), or the ad account's connection — as they were / are. A Page: null = the app is not on it. */
  fields?: string[] | null
  connected?: boolean | null
  undo?: WebhooksUndoArgs | null
  noUndo?: string[]
}

export interface WebhooksLive {
  appId: string
  adAccountId: string
  pageId: string | null
  callback: { url: string } | { error: string }
  /** How many OTHER businesses in Nexus connect the same Meta app (never which); null when Nexus could not tell. */
  otherBusinesses: number | null
  app?: AppSubscriptionState[]
  adAccount?: { connected: boolean }
  /** Part 3 — the app on the chosen Page (read with the Page's own token), or why Nexus could not read it. */
  page?: PageAppState | { error: string }
  /** Part 3 (WH-013) — the chosen Instagram account and the one linked to the chosen Page, or why Nexus could not read it. */
  instagram?: { chosen: string | null; linked: string | null } | { error: string }
}

/**
 * Review B-1 — what is not known yet about the Instagram per-account step (LIVE-PROBES WH-013p; Meta's docs disagree, see
 * the header): never a promise that Meta delivers the Instagram account's notifications.
 */
const IG_STEP_UNCONFIRMED = 'whether the app on the linked Page is enough for the Instagram account\'s notifications is not yet confirmed: Meta\'s newer Instagram guide puts the Instagram fields chosen in the App Dashboard on that Page, which Nexus cannot send (it sends Page fields only) — if Meta needs them, the Owner does this step in the App Dashboard'
export const DASHBOARD_ONLY = `Instagram and WhatsApp webhook fields are set only in Meta's App Dashboard (Meta's API does not take them: app/subscriptions): the Owner sets them there (Webhooks of the app, the callback Nexus's receiver). Instagram also needs a per-account step on its linked Facebook Page: set-meta-webhooks install-page with object instagram installs the app on the chosen Page (linked to the chosen Instagram account, with the Page's own token); ${IG_STEP_UNCONFIRMED}. meta-webhooks reads the result.`
/**
 * Review B-5 — who reaches a Page (access-tokens guide, System User Access Tokens): an ADMIN system user has the business's
 * assets by default; an EMPLOYEE system user only the ones assigned to it.
 */
const ASSIGN_PAGE = 'An admin system user reaches the business\'s Pages without being assigned them; an employee system user needs the Page assigned (Meta Business settings › Users › System users › Assign assets).'
/**
 * Part 3 — what Meta needs to install an app on a Page (reference/page/subscribed_apps), in words. Review B-5 — and what
 * the fields ask on top: leadgen the ADVERTISE task and leads_retrieval, ads_management, pages_read_engagement (Lead Ads
 * webhooks guide, "Install Your App"), Messenger fields the MODERATE (or MESSAGING) task and pages_messaging (Messenger
 * Platform webhooks, "Subscribe your Page"; Webhooks for Pages: MESSAGING).
 */
export const PAGE_TOKEN_TASKS = `Meta installs an app on a Page only with the Page's own token: Nexus reads the chosen Page's token with the business's system user (step 36), so the system user needs the Manage, Create content or Moderate task on the Page and its token pages_manage_metadata and pages_show_list; leadgen also asks the Advertise task and leads_retrieval, ads_management and pages_read_engagement, Messenger fields the Moderate (or Messaging) task and pages_messaging. ${ASSIGN_PAGE} Without them Meta gives no Page token or refuses, and nothing changes.`
/** Part 3 — the Page fields that are Messenger's: Meta also needs pages_messaging for them. */
const MESSENGER_FIELDS: ReadonlySet<string> = new Set(['messages', 'message_echoes', 'message_reads', 'message_deliveries', 'message_reactions', 'message_edits', 'messaging_postbacks', 'messaging_referrals', 'messaging_handovers', 'standby', 'messaging_policy_enforcement', 'messaging_integrity', 'messaging_in_thread_lead_form_submit'])
/** Review B-5 — Meta's 200 / 10 on an install (a permission or task missing), in words. */
const PAGE_PERMISSIONS = `Installing the app on a Page needs the Manage, Create content or Moderate task on it for the system user, and pages_manage_metadata and pages_show_list on its token; leadgen also the Advertise task and leads_retrieval, ads_management and pages_read_engagement, Messenger fields the Moderate (or Messaging) task and pages_messaging. ${ASSIGN_PAGE}`
/** Part 3 — Meta refusing the Page's own token (190; review round 2 B-4: 102, the session, the same words). */
const PAGE_TOKEN_REFUSED = 'Meta did not accept the Page\'s own token, which Nexus reads for each change: the system user may have lost its role or task on the chosen Page; the business\'s system-user token itself is not the problem.'
/** Part 3 — Meta's codes an install on a Page may meet (graph-api errors), in plain words. */
export const PAGE_INSTALL_EXPLAIN: Readonly<Record<string, string>> = {
  200: PAGE_PERMISSIONS,
  10: PAGE_PERMISSIONS,
  210: 'Meta took the token as not the Page\'s own: Nexus sends the chosen Page\'s token, read for this change — the system user may have no task on the Page (an employee system user needs the Page assigned: Meta Business settings › Users › System users › Assign assets).',
  190: PAGE_TOKEN_REFUSED,
  102: PAGE_TOKEN_REFUSED,
}
const NO_PAGE = 'This business has no Facebook Page chosen (set-meta-connection chooses one).'
const APP_WIDE = (n: number) => `This subscription is app-wide: ${n === 1 ? 'another business' : `${n} other businesses`} in Nexus use${n === 1 ? 's' : ''} the same Meta app, so this also changes what ${n === 1 ? 'it receives' : 'they receive'} (each still gets only its own ad accounts' and Pages' notifications).`
const APP_WIDE_REFUSAL = 'Another business in Nexus uses this Meta app; an app-wide unsubscribe would stop its notifications too — change it in Meta\'s App Dashboard (Webhooks of the app).'
const APP_WIDE_NO_UNDO = 'another business in Nexus uses this Meta app, so once Nexus subscribes, only Meta\'s App Dashboard can remove it (an app-wide unsubscribe would stop that business\'s notifications too).'
const APP_WIDE_UNKNOWN_NO_UNDO = 'Nexus could not tell whether another business in Nexus uses this Meta app, so once Nexus subscribes, only Meta\'s App Dashboard can remove it.'
/**
 * Re-review 3 — the receiver routes a change that names no business (application dev_alerts and async_requests, every
 * catalog change) only when ONE business uses the app (webhook-receiver.ts routeMetaChanges).
 */
const UNROUTED_WHEN_SHARED = (object: string) => (object === 'catalog'
  ? 'With another business on this Meta app, Nexus\'s receiver routes no catalog notification (they name no business): subscribing catalog reaches nobody in Nexus.'
  : 'With another business on this Meta app, Nexus\'s receiver routes no app-level application notification (dev_alerts, async_requests name no business): those reach nobody in Nexus; ad_account status and trigger rules still reach the business whose ad account they name.')

const sorted = (list: readonly string[]) => [...list].sort()
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const words = (list: readonly string[] | null | undefined) => (list && list.length ? sorted(list).join(', ') : 'none')

function request(fields: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget'> & { step?: number }): MetaChangeRequest {
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...fields }
}

function draft(input: {
  summary: string; lines: Array<[string, unknown, unknown]>; requests: MetaChangeRequest[]; stands: unknown; warnings?: string[]; skipped?: string[]
  before: WebhooksRecord; after: WebhooksRecord
}): MetaChangeDraft {
  const { changes, more } = changeLines(input.lines)
  return {
    summary: input.summary, changes, totals: { requests: input.requests.length, ...(more ? { moreLines: more } : {}) },
    // Re-review 1 — the approver reads what has no way back (as set-meta-ad-set says it).
    warnings: [...(input.warnings ?? []), ...(input.before.noUndo?.length ? [`No undo for: ${input.before.noUndo.join(' ')}`] : [])],
    spendsMoney: [], skipped: input.skipped ?? [], requests: input.requests, stands: input.stands,
    before: input.before, after: input.after,
  }
}

/** The fields asked for one object: the list given (each one Nexus's receiver knows), or the default (all of them). */
function fieldsFor(allowed: readonly string[], object: string, asked: string[] | undefined, defaults: readonly string[] = allowed): string[] | { refusal: string } {
  if (!asked || !asked.length) return sorted(defaults)
  const unknown = asked.filter((f) => !allowed.includes(f))
  if (unknown.length) return { refusal: `Nexus's receiver does not take ${unknown.join(', ')} on ${object}; its fields are ${allowed.join(', ')}.` }
  return sorted([...new Set(asked)])
}

/** The draft of one set-meta-webhooks action, from the live state; a refusal in words. */
export function webhooksDraft(req: WebhooksRequest, live: WebhooksLive): MetaChangeDraft | { refusal: string } {
  // objectKind names the object (a status change's `kind` is left out: change-draft.ts). An app request goes with the app
  // token by its gateway rule (meta-webhook-rules.ts `auth: 'app'`), never at this draft's ask; `via` marks Meta's answer
  // as the result.
  const appPath = { objectId: live.appId, objectKind: 'app' as const, edge: 'subscriptions' as const }
  const accountPath = { objectId: `act_${live.adAccountId}`, objectKind: 'adaccount' as const, edge: 'subscribed_apps' as const }

  if (req.action === 'install-page') return pageInstallDraft(req, live)
  if (req.action === 'remove-page') return pageRemoveDraft(req, live)

  if (req.action === 'subscribe-app' || req.action === 'unsubscribe-app') {
    const object = req.object ?? ''
    if (object === 'instagram' || object === 'whatsapp_business_account') return { refusal: DASHBOARD_ONLY }
    const allowed = metaWebhookFieldsOf(object)
    if (!allowed) return { refusal: `Name the object: ${META_WEBHOOK_OBJECTS.join(', ')}.` }
    const wanted = fieldsFor(allowed, object, req.fields)
    if ('refusal' in wanted) return wanted
    const found = live.app?.find((s) => s.object === object) ?? null
    const current = found ? { ...found, fields: sorted(found.fields) } : null
    const others = live.otherBusinesses
    const stands = { action: req.action, object, otherBusinesses: others, current: current ? { fields: current.fields, active: current.active, nexusCallback: current.nexusCallback } : null }
    if (req.action === 'subscribe-app') {
      if ('error' in live.callback) return { refusal: `Nexus has no callback to give Meta: ${live.callback.error}` }
      const added = wanted.filter((f) => !current?.fields.includes(f))
      if (current && current.nexusCallback && current.active !== false && !added.length) {
        return draft({ summary: `The app already sends ${object} notifications of ${words(wanted)} to Nexus.`, lines: [], requests: [], stands, skipped: [`${object}: ${words(wanted)} already subscribed to Nexus's receiver.`], before: { action: req.action, object, fields: current.fields }, after: { action: req.action, object, fields: current.fields } })
      }
      const warnings: string[] = []
      const noUndo: string[] = []
      if (others === null) warnings.push('Nexus could not tell whether another business in Nexus uses this Meta app: the subscription is app-wide, so it may change what that business receives too.')
      else if (others > 0) warnings.push(APP_WIDE(others))
      if (others !== 0 && (object === 'application' || object === 'catalog')) warnings.push(UNROUTED_WHEN_SHARED(object))
      if (current && !current.nexusCallback) {
        warnings.push(`The app's ${object} subscription now calls ${current.callbackOrigin ?? 'another address'}; this change points it at Nexus's receiver (Meta keeps one callback per object). Nexus never writes another callback back.`)
        noUndo.push(`The earlier callback (${current.callbackOrigin ?? 'another address'}) is not put back: Nexus only ever gives Meta its own.`)
      }
      if (current && current.active === false) warnings.push(`The app's ${object} subscription is inactive; Meta switches it on again with this change.`)
      warnings.push('Meta first sends a verification request to Nexus\'s receiver; the change fails when it is not answered (META_WEBHOOK_VERIFY_TOKEN must be set on the API service). Apps in development mode receive only the App Dashboard\'s test notifications and those of people with a role on the app.')
      // Review A1 / D-1 — an undo is an app-wide unsubscribe: never while another business (or maybe one) uses the app.
      let undo: WebhooksUndoArgs | null = !current ? { action: 'unsubscribe-app', object } : added.length ? { action: 'unsubscribe-app', object, fields: added } : null
      if (undo && others !== 0) { undo = null; noUndo.push(others === null ? APP_WIDE_UNKNOWN_NO_UNDO : `This subscription: ${APP_WIDE_NO_UNDO}`) }
      else if (!undo && !noUndo.length) noUndo.push('Switching an inactive subscription on again has no undo of its own (Meta has no switch to make it inactive).')
      const all = sorted([...new Set([...(current?.fields ?? []), ...wanted])])
      return draft({
        summary: `Subscribe the business's Meta app to ${object} notifications (${words(wanted)}), sent to Nexus's receiver.`,
        lines: [[`App subscription ${object}`, current ? words(current.fields) : 'none', words(all)]],
        requests: [request({ ...appPath, label: `Subscribe the app to ${object}: ${words(wanted)}`, params: { object, callback_url: live.callback.url, fields: wanted.join(','), include_values: 'true' }, undoable: !!undo, operation: 'webhooks.subscribeApp', via: {} })],
        stands, warnings,
        before: { action: req.action, object, fields: current?.fields ?? null, undo, noUndo },
        after: { action: req.action, object, fields: all },
      })
    }
    // unsubscribe-app — app-wide: never while another business uses the app (or Nexus cannot tell).
    if (others === null) return { refusal: 'Nexus could not tell whether another business in Nexus uses this Meta app; an app-wide unsubscribe could stop its notifications too — change it in Meta\'s App Dashboard (Webhooks of the app), or ask again.' }
    if (others > 0) return { refusal: APP_WIDE_REFUSAL }
    if (!current) return draft({ summary: `The app has no ${object} subscription.`, lines: [], requests: [], stands, skipped: [`${object}: no subscription to remove.`], before: { action: req.action, object, fields: null }, after: { action: req.action, object, fields: null } })
    const removing = req.fields?.length ? wanted.filter((f) => current.fields.includes(f)) : current.fields
    if (req.fields?.length && !removing.length) return draft({ summary: `The app's ${object} subscription has none of ${words(wanted)}.`, lines: [], requests: [], stands, skipped: [`${object}: ${words(wanted)} not subscribed.`], before: { action: req.action, object, fields: current.fields }, after: { action: req.action, object, fields: current.fields } })
    const whole = !req.fields?.length || same(removing, current.fields)
    // Review A3 — the undo puts back only fields Nexus takes; any other is named.
    const back = removing.filter((f) => allowed.includes(f))
    const foreignFields = removing.filter((f) => !allowed.includes(f))
    const noUndo = [
      ...(current.nexusCallback ? [] : [`The subscription called ${current.callbackOrigin ?? 'another address'}, not Nexus: Nexus cannot subscribe it back there.`]),
      ...(current.nexusCallback && foreignFields.length ? [`Nexus's receiver does not take ${foreignFields.join(', ')}, so its undo does not subscribe ${foreignFields.length === 1 ? 'it' : 'them'} again.`] : []),
    ]
    const undo: WebhooksUndoArgs | null = current.nexusCallback && back.length ? { action: 'subscribe-app', object, fields: back } : null
    const left = current.fields.filter((f) => !removing.includes(f))
    return draft({
      summary: whole ? `Remove the business's Meta app's ${object} subscription (Nexus no longer gets ${object} notifications).` : `Remove ${words(removing)} from the app's ${object} subscription.`,
      lines: [[`App subscription ${object}`, words(current.fields), whole ? 'none' : words(left)]],
      requests: [request({ ...appPath, label: whole ? `Remove the app's ${object} subscription` : `Remove ${words(removing)} from the app's ${object} subscription`, params: {}, method: 'DELETE', undoable: !!undo, operation: 'webhooks.unsubscribeApp', via: { query: whole ? { object } : { object, fields: removing.join(',') } } })],
      stands, warnings: object === 'ad_account' ? ['Without ad_account fields no ads notification reaches Nexus (alert subscriptions included); the daily read still runs.'] : [],
      before: { action: req.action, object, fields: current.fields, undo, noUndo },
      after: { action: req.action, object, fields: whole ? null : left },
    })
  }

  if (req.action === 'connect-ad-account' || req.action === 'disconnect-ad-account') {
    const connected = live.adAccount?.connected ?? false
    const connect = req.action === 'connect-ad-account'
    const stands = { action: req.action, adAccountId: live.adAccountId, connected }
    if (connected === connect) {
      return draft({ summary: `The app is ${connect ? 'already' : 'not'} connected to ad account ${live.adAccountId}.`, lines: [], requests: [], stands, skipped: [`ad account ${live.adAccountId}: ${connect ? 'already connected' : 'not connected'}.`], before: { action: req.action, connected }, after: { action: req.action, connected } })
    }
    const undo: WebhooksUndoArgs = { action: connect ? 'disconnect-ad-account' : 'connect-ad-account' }
    return draft({
      summary: connect ? `Connect ad account ${live.adAccountId} to the business's Meta app, so its ads notifications are delivered to Nexus.` : `Disconnect ad account ${live.adAccountId} from the business's Meta app (no more ads notifications from it).`,
      lines: [[`Ad account ${live.adAccountId} connected to the app`, connected ? 'yes' : 'no', connect ? 'yes' : 'no']],
      requests: [request({ ...accountPath, label: `${connect ? 'Connect' : 'Disconnect'} ad account ${live.adAccountId} ${connect ? 'to' : 'from'} the app`, params: connect ? { app_id: live.appId } : {}, ...(connect ? {} : { method: 'DELETE' as const, via: { query: { app_id: live.appId } } }), undoable: true, operation: connect ? 'webhooks.connectAdAccount' : 'webhooks.disconnectAdAccount' })],
      stands,
      warnings: connect ? ['Meta needs a token of an ADMIN of the ad account for this (ads-webhooks get started): when the system user is not one, Meta refuses and nothing changes — a person then makes the system user an admin of the ad account in Meta Business settings, or connects it in the App Dashboard.'] : [],
      before: { action: req.action, connected, undo, noUndo: [] },
      after: { action: req.action, connected: connect },
    })
  }

  return { refusal: `Unknown action ${String(req.action)}.` }
}

/** The Page fields Nexus's receiver takes (META_WEBHOOK_FIELDS.page). */
const PAGE_FIELDS: readonly string[] = metaWebhookFieldsOf('page') ?? []
/** Review round 2 B-1 — the Page's lead field: the Advertise task and leads_retrieval on top of the install's own. */
const LEADGEN = 'leadgen'
/**
 * Review B-4 — install-page's default: the Page fields that are NOT Messenger's. Checked on the saved pages: of the 17,
 * MESSENGER_FIELDS' 13 are Messenger fields — 11 in the field table of Meta Webhooks for Messenger Platform (messages,
 * message_echoes, message_reads, message_deliveries, message_reactions, message_edits, messaging_postbacks,
 * messaging_referrals, messaging_handovers, messaging_policy_enforcement, standby), and messaging_integrity and
 * messaging_in_thread_lead_form_submit typed Messenger…Field on the Webhooks reference for Page. They need the MODERATE
 * (or MESSAGING) task and pages_messaging (Messenger Platform webhooks, "Subscribe your Page"), which step 36's token list
 * does not name, and Meta then refuses the WHOLE install. leadgen, feed, mention and product_review are the Page's own
 * fields (Webhooks reference for Page). Review round 2 B-1 — nor leadgen: it needs the ADVERTISE task and leads_retrieval
 * (Lead Ads webhooks, "Install Your App"), and Meta refuses the whole POST naming every field it lacks a permission for
 * (#200): with leadgen in it, a plain install-page would likely install nothing. Messenger fields and leadgen go only
 * when asked by name.
 */
const PAGE_DEFAULT_FIELDS: readonly string[] = PAGE_FIELDS.filter((f) => !MESSENGER_FIELDS.has(f) && f !== LEADGEN)
/**
 * Review B-4 — the ONE Page field install-page instagram installs when the app is not on the Page (the step needs the app
 * on the linked Page, not a field's notifications). leadgen asks the ADVERTISE task and leads_retrieval, ads_management,
 * pages_read_engagement on top (Meta Webhooks for Lead Ads, "Install Your App"); feed, mention and product_review ask
 * nothing beyond the install's own (page/subscribed_apps reference: CREATE_CONTENT, MANAGE or MODERATE, pages_manage_metadata,
 * pages_show_list; the Webhooks reference for Page names no more for them). Of those three, product_review is the quietest
 * ("changes to a page's product review settings"; feed is nearly every change of the Page's feed).
 */
const INSTAGRAM_PAGE_FIELD = 'product_review'
const pagePathOf = (pageId: string) => ({ objectId: pageId, objectKind: 'page' as const, edge: 'subscribed_apps' as const })

/** Part 3 — install-page (WH-010) and its Instagram per-account step (WH-013): the CHOSEN Page, with its own token. */
function pageInstallDraft(req: WebhooksRequest, live: WebhooksLive): MetaChangeDraft | { refusal: string } {
  const pageId = live.pageId
  if (!pageId) return { refusal: NO_PAGE }
  const object = req.object
  if (object !== undefined && object !== 'instagram') return { refusal: 'install-page installs the app on the chosen Facebook Page: it names no object, or instagram (the per-account step of the Instagram account linked to that Page).' }
  // What it stands on and what its undo puts back: the Page's apps, read with the Page's own token (the same the install takes).
  if (!live.page || 'error' in live.page) {
    return { refusal: `Nexus could not read which apps are installed on Page ${pageId}${live.page && 'error' in live.page ? ` (${live.page.error})` : ''}. Installing takes the same Page token, so nothing is sent. ${PAGE_TOKEN_TASKS}` }
  }
  if (object === 'instagram') {
    const ig = live.instagram
    if (!ig || 'error' in ig) return { refusal: `Nexus could not read which Instagram account is linked to Page ${pageId}${ig && 'error' in ig ? ` (${ig.error})` : ''}; nothing is sent.` }
    if (!ig.chosen) return { refusal: 'This business has no Instagram account chosen (set-meta-connection chooses one).' }
    // Review B-6 — no instagram_business_account on the Page: none linked, OR the token cannot see that field (the Page
    // reference: it needs a token of someone able to perform tasks on the Page).
    if (!ig.linked) {
      return { refusal: `Nexus cannot confirm that Page ${pageId} is the Page linked to the chosen Instagram account ${ig.chosen}: Meta names no Instagram account on it — either none is linked, or the token Nexus reads it with cannot see that field (Meta answers instagram_business_account only to a token of someone with a task on the Page). Meta delivers an Instagram account's webhooks only through its linked Page — link them in Meta Business settings, give the system user a task on the Page, or choose the linked Page (set-meta-connection).` }
    }
    if (ig.linked !== ig.chosen) {
      return { refusal: `Page ${pageId} is not the Page linked to the chosen Instagram account ${ig.chosen} (it is linked to ${ig.linked}): Meta delivers an Instagram account's webhooks only through its linked Page — link them in Meta Business settings, or choose that Page (set-meta-connection).` }
    }
  }
  // Review B-4 — by default no Messenger field (they need pages_messaging, and one refused fails the whole install);
  // instagram: ONE Page field.
  const wanted = fieldsFor(PAGE_FIELDS, 'page', req.fields, object === 'instagram' ? [INSTAGRAM_PAGE_FIELD] : PAGE_DEFAULT_FIELDS)
  if ('refusal' in wanted) return wanted
  const current = { installed: live.page.installed, fields: sorted(live.page.fields) }
  const foreign = current.fields.filter((f) => !PAGE_FIELDS.includes(f))
  const target = req.exact ? wanted : sorted([...new Set([...current.fields.filter((f) => PAGE_FIELDS.includes(f)), ...wanted])])
  const record = { action: req.action, ...(object ? { object } : {}), pageId }
  const stands = { ...record, current, exact: req.exact === true }
  if (object === 'instagram' && current.installed && !req.fields?.length) {
    // Review B-1 — the app on the linked Page is all Nexus can do here; it promises no delivery.
    return draft({ summary: `The app is already on Page ${pageId} (${words(current.fields)}), the Page linked to the chosen Instagram account: nothing to change.`, lines: [], requests: [], stands, skipped: [`Page ${pageId}: the app is already on the Page linked to the chosen Instagram account; ${IG_STEP_UNCONFIRMED}.`], before: { ...record, fields: current.fields }, after: { ...record, fields: current.fields } })
  }
  if (current.installed && same(target, current.fields)) {
    return draft({ summary: `The app is already installed on Page ${pageId} with ${words(target)}.`, lines: [], requests: [], stands, skipped: [`Page ${pageId}: ${words(target)} already subscribed.`], before: { ...record, fields: current.fields }, after: { ...record, fields: current.fields } })
  }
  // `exact` with a field to drop: the app comes off first (the app token), then goes on with exactly these (step 2 stands on 1).
  const removeFirst = req.exact === true && current.installed && current.fields.some((f) => !target.includes(f))
  const warnings = [PAGE_TOKEN_TASKS]
  const messenger = target.filter((f) => MESSENGER_FIELDS.has(f))
  if (messenger.length) warnings.push(`${words(messenger)} ${messenger.length === 1 ? 'is a Messenger field' : 'are Messenger fields'}: Meta also needs the Moderate (or Messaging) task on the Page and pages_messaging on the token, and without them refuses the whole install.`)
  // Review round 2 B-1 — leadgen goes only when named (or already on the Page): what it asks on top, said before approval.
  if (target.includes(LEADGEN)) warnings.push('leadgen needs the Advertise task on the Page and leads_retrieval on the token (plus ads_management and pages_read_engagement): without them Meta refuses the whole install, the other fields too.')
  warnings.push('Meta delivers a Page field to Nexus only when the app is subscribed to it as well (set-meta-webhooks subscribe-app object page, or the App Dashboard).')
  if (object === 'instagram') warnings.push(`The Instagram account's own fields (comments, mentions, messages …) are set in the App Dashboard (Webhooks of the app, object instagram). This step installs the app on the linked Page with ${words(target)}; ${IG_STEP_UNCONFIRMED}.`)
  if (removeFirst) {
    warnings.push(`The app comes off Page ${pageId} first and goes on again with ${words(target)}: a notification Meta sends in between reaches nobody.`)
    // Review A-F1 — step 2 stands on step 1, but step 1 can happen alone (Meta's rate limit, no Page token, a refusal).
    warnings.push(`If step 2 does not happen, the app stays off Page ${pageId} — no lead, comment or message notification of the Page reaches Nexus — until install-page runs again.`)
  }
  if (!req.exact && foreign.length) warnings.push(`The app on the Page also has ${words(foreign)}, which Nexus's receiver does not take and so does not send: if Meta replaces the list with this one, ${foreign.length === 1 ? 'it goes' : 'they go'}.`)
  const noUndo: string[] = []
  let undo: WebhooksUndoArgs | null
  if (!current.installed) undo = { action: 'remove-page' }
  else {
    const back = current.fields.filter((f) => PAGE_FIELDS.includes(f))
    undo = back.length ? { action: 'install-page', fields: back, exact: true } : null
    // Review A-F3 — only fields the receiver does not take: there is no undo at all, said as such.
    if (foreign.length) {
      noUndo.push(back.length
        ? `Nexus's receiver does not take ${words(foreign)}, so its undo does not subscribe ${foreign.length === 1 ? 'it' : 'them'} again.`
        : `It has no undo at all: the app had only ${words(foreign)} on the Page, which Nexus's receiver does not take, so Nexus cannot put the Page back as it was.`)
    }
    // Review round 2 B-2 — the undo is install-page `exact` with a field to drop: two steps, the app off and then on with
    // the earlier fields. An Undo on the Claude activity page is approved by its click (change-undo.service.ts): this
    // preview is the only place a person reads what that undo does.
    // A field the receiver does not take (kept off the undo) makes it two steps too, when Meta adds rather than replaces.
    if (undo && (target.some((f) => !back.includes(f)) || foreign.length)) {
      warnings.push(`Its undo takes the app off Page ${pageId} and puts it back with the earlier fields (${words(back)}): if that second step fails, the app stays off the Page — no lead, comment or message notification of the Page reaches Nexus — until install-page runs again.`)
    }
  }
  const install = request({
    ...pagePathOf(pageId), step: removeFirst ? 2 : 1, ...(removeFirst ? { needs: [1] } : {}),
    label: `Install the app on Page ${pageId}: ${words(target)}`, params: { subscribed_fields: target.join(',') },
    undoable: !!undo, operation: 'webhooks.installPage', via: {}, explain: PAGE_INSTALL_EXPLAIN,
  })
  const requests = removeFirst
    ? [request({ ...pagePathOf(pageId), label: `Remove the app from Page ${pageId} (it goes on again in step 2)`, params: {}, method: 'DELETE', undoable: false, operation: 'webhooks.removePage', via: {} }), install]
    : [install]
  return draft({
    summary: object === 'instagram'
      ? `Install the business's Meta app on Page ${pageId}, the Page linked to the chosen Instagram account, with ${words(target)} — that account's per-account step (whether it is enough for its notifications is not yet confirmed).`
      : `Install the business's Meta app on Page ${pageId} with ${words(target)}, so the Page's notifications reach Nexus.`,
    lines: [[`Page ${pageId}: the app`, current.installed ? words(current.fields) : 'not installed', words(target)]],
    requests, stands, warnings,
    before: { ...record, fields: current.installed ? current.fields : null, undo, noUndo },
    after: { ...record, fields: target },
  })
}

/** remove-page (WH-012) — the CHOSEN Page, with the app token; its undo installs the fields it had (read with the Page token). */
function pageRemoveDraft(req: WebhooksRequest, live: WebhooksLive): MetaChangeDraft | { refusal: string } {
  const pageId = live.pageId
  if (!pageId) return { refusal: NO_PAGE }
  const record = { action: req.action, pageId }
  const remove = (undoable: boolean) => request({ ...pagePathOf(pageId), label: `Remove the app from Page ${pageId}`, params: {}, method: 'DELETE', undoable, operation: 'webhooks.removePage', via: {} })
  const summary = `Remove the business's Meta app from Page ${pageId} (no more Page notifications to Nexus).`
  if (!live.page || 'error' in live.page) {
    // The Page's own token was not to be had (or Meta refused the read): the removal still goes with the app token, without an undo.
    const why = live.page && 'error' in live.page ? live.page.error : 'not read'
    return draft({
      summary,
      lines: [[`Page ${pageId}: the app`, 'installed or not (Nexus could not read it)', 'not installed']],
      requests: [remove(false)],
      stands: { ...record, current: null },
      warnings: [`Nexus could not read which apps are installed on the Page (${why}): when the app is not installed, Meta answers and nothing changes.`],
      before: { ...record, fields: null, undo: null, noUndo: [`It has no undo: Nexus could not read the fields the app had on the Page, so it cannot install them back (install-page installs the app again). ${PAGE_TOKEN_TASKS}`] },
      after: { ...record, fields: null },
    })
  }
  const current = { installed: live.page.installed, fields: sorted(live.page.fields) }
  const stands = { ...record, current }
  if (!current.installed) {
    return draft({ summary: `The app is not installed on Page ${pageId}.`, lines: [], requests: [], stands, skipped: [`Page ${pageId}: the app is not installed.`], before: { ...record, fields: null }, after: { ...record, fields: null } })
  }
  const back = current.fields.filter((f) => PAGE_FIELDS.includes(f))
  const foreign = current.fields.filter((f) => !PAGE_FIELDS.includes(f))
  const undo: WebhooksUndoArgs | null = back.length ? { action: 'install-page', fields: back } : null
  const noUndo = foreign.length
    ? [back.length ? `Nexus's receiver does not take ${words(foreign)}, so its undo does not install ${foreign.length === 1 ? 'it' : 'them'} again.` : `The app had only ${words(foreign)} on the Page, which Nexus's receiver does not take: there is nothing Nexus can install back.`]
    : []
  return draft({
    summary,
    lines: [[`Page ${pageId}: the app`, words(current.fields), 'not installed']],
    requests: [remove(!!undo)], stands,
    warnings: ['Without the app on the Page no Page notification (leads, comments, messages) reaches Nexus, nor the Instagram account\'s linked to it.'],
    before: { ...record, fields: current.fields, undo, noUndo },
    after: { ...record, fields: null },
  })
}
