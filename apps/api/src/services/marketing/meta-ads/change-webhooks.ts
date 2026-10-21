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
 *                          ones), so the Page ends with it whether Meta replaces or adds (LIVE-PROBES WH-010u); `exact`
 *                          makes it exactly the asked ones (the app removed first when one must go: the undo's way back)
 *   install-page instagram the per-account step of the Instagram account (WH-013): its linked Page — which must be the
 *                          chosen Page, linked to the chosen Instagram account — subscribed to any Page field
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

export const DASHBOARD_ONLY = 'Instagram and WhatsApp webhook fields are set only in Meta\'s App Dashboard (Meta\'s API does not take them: app/subscriptions): the Owner sets them there (Webhooks of the app, the callback Nexus\'s receiver). Instagram also needs a per-account step, its linked Facebook Page subscribed to the app: set-meta-webhooks install-page with object instagram does it (the chosen Page, linked to the chosen Instagram account, with the Page\'s own token). meta-webhooks reads the result.'
/** Part 3 — what Meta needs to install an app on a Page (reference/page/subscribed_apps), in words. */
export const PAGE_TOKEN_TASKS = 'Meta installs an app on a Page only with the Page\'s own token: Nexus reads the chosen Page\'s token with the business\'s system user (step 36), so the system user needs the Manage, Create content or Moderate task on the Page (Meta Business settings › Users › System users › Assign assets) and its token pages_manage_metadata and pages_show_list. Without them Meta gives no Page token or refuses, and nothing changes.'
/** Part 3 — the Page fields that are Messenger's: Meta also needs pages_messaging for them. */
const MESSENGER_FIELDS: ReadonlySet<string> = new Set(['messages', 'message_echoes', 'message_reads', 'message_deliveries', 'message_reactions', 'message_edits', 'messaging_postbacks', 'messaging_referrals', 'messaging_handovers', 'standby', 'messaging_policy_enforcement', 'messaging_integrity', 'messaging_in_thread_lead_form_submit'])
/** Part 3 — Meta's codes an install on a Page may meet (graph-api errors), in plain words. */
export const PAGE_INSTALL_EXPLAIN: Readonly<Record<string, string>> = {
  200: 'Installing the app on a Page needs the Manage, Create content or Moderate task on it for the system user (Meta Business settings › Users › System users › Assign assets), and pages_manage_metadata and pages_show_list on its token (Messenger fields also pages_messaging).',
  10: 'Installing the app on a Page needs the Manage, Create content or Moderate task on it for the system user (Meta Business settings › Users › System users › Assign assets), and pages_manage_metadata and pages_show_list on its token (Messenger fields also pages_messaging).',
  210: 'Meta took the token as not the Page\'s own: Nexus sends the chosen Page\'s token, read for this change — the system user may have no task on the Page (Meta Business settings › Users › System users › Assign assets).',
  190: 'Meta did not accept the Page\'s own token, which Nexus reads for each change: the system user may have lost its role or task on the chosen Page; the business\'s system-user token itself is not the problem.',
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

/** The fields asked for one object: the list given (each one Nexus's receiver knows), or all of them. */
function fieldsFor(allowed: readonly string[], object: string, asked: string[] | undefined): string[] | { refusal: string } {
  if (!asked || !asked.length) return sorted(allowed)
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
    if (ig.linked !== ig.chosen) {
      return { refusal: `Page ${pageId} is not the Page linked to the chosen Instagram account ${ig.chosen} (${ig.linked ? `it is linked to ${ig.linked}` : 'it has no Instagram account linked'}): Meta delivers an Instagram account's webhooks only through its linked Page — link them in Meta Business settings, or choose that Page (set-meta-connection).` }
    }
  }
  const wanted = fieldsFor(PAGE_FIELDS, 'page', req.fields)
  if ('refusal' in wanted) return wanted
  const current = { installed: live.page.installed, fields: sorted(live.page.fields) }
  const foreign = current.fields.filter((f) => !PAGE_FIELDS.includes(f))
  const target = req.exact ? wanted : sorted([...new Set([...current.fields.filter((f) => PAGE_FIELDS.includes(f)), ...wanted])])
  const record = { action: req.action, ...(object ? { object } : {}), pageId }
  const stands = { ...record, current, exact: req.exact === true }
  if (object === 'instagram' && current.installed && !req.fields?.length) {
    return draft({ summary: `The app is installed on Page ${pageId} (${words(current.fields)}): the Instagram account's per-account step is done.`, lines: [], requests: [], stands, skipped: [`Page ${pageId}: the app is installed, so Meta delivers the Instagram account's notifications (its fields are set in the App Dashboard).`], before: { ...record, fields: current.fields }, after: { ...record, fields: current.fields } })
  }
  if (current.installed && same(target, current.fields)) {
    return draft({ summary: `The app is already installed on Page ${pageId} with ${words(target)}.`, lines: [], requests: [], stands, skipped: [`Page ${pageId}: ${words(target)} already subscribed.`], before: { ...record, fields: current.fields }, after: { ...record, fields: current.fields } })
  }
  // `exact` with a field to drop: the app comes off first (the app token), then goes on with exactly these (step 2 stands on 1).
  const removeFirst = req.exact === true && current.installed && current.fields.some((f) => !target.includes(f))
  const warnings = [PAGE_TOKEN_TASKS]
  const messenger = target.filter((f) => MESSENGER_FIELDS.has(f))
  if (messenger.length) warnings.push(`${words(messenger)} ${messenger.length === 1 ? 'is a Messenger field' : 'are Messenger fields'}: Meta also needs pages_messaging on the token.`)
  warnings.push('Meta delivers a Page field to Nexus only when the app is subscribed to it as well (set-meta-webhooks subscribe-app object page, or the App Dashboard).')
  if (object === 'instagram') warnings.push('The Instagram account\'s own fields (comments, mentions, messages …) are set in the App Dashboard (Webhooks of the app, object instagram); this step lets Meta deliver them for this account.')
  if (removeFirst) warnings.push(`The app comes off Page ${pageId} first and goes on again with ${words(target)}: a notification Meta sends in between reaches nobody.`)
  if (!req.exact && foreign.length) warnings.push(`The app on the Page also has ${words(foreign)}, which Nexus's receiver does not take and so does not send: if Meta replaces the list with this one (LIVE-PROBES WH-010u), ${foreign.length === 1 ? 'it goes' : 'they go'}.`)
  const noUndo: string[] = []
  let undo: WebhooksUndoArgs | null
  if (!current.installed) undo = { action: 'remove-page' }
  else {
    const back = current.fields.filter((f) => PAGE_FIELDS.includes(f))
    undo = back.length ? { action: 'install-page', fields: back, exact: true } : null
    if (foreign.length) noUndo.push(`Nexus's receiver does not take ${words(foreign)}, so its undo does not subscribe ${foreign.length === 1 ? 'it' : 'them'} again.`)
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
      ? `Install the business's Meta app on Page ${pageId}, the Page linked to the chosen Instagram account, so Meta delivers that account's webhooks (${words(target)}).`
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
