/**
 * Meta step 30 part 2 (2026-10-21) — the drafts of set-meta-webhooks: one action per change, built from the live state
 * (live-webhook-setup.ts) without any call of its own. Pure.
 *
 *   subscribe-app          POST /<app id>/subscriptions — the app's fields of ONE object (ad_account, application, page,
 *                          catalog, permissions), the callback Nexus's own receiver, include_values=true (WH-005)
 *   unsubscribe-app        DELETE /<app id>/subscriptions?object=…[&fields=…] — never without an object (WH-007)
 *   connect-ad-account     POST /act_<id>/subscribed_apps app_id — the CHOSEN ad account delivers to the app (WH-008)
 *   disconnect-ad-account  DELETE /act_<id>/subscribed_apps?app_id=… (WH-009)
 *   install-page           NOT sent (review B1, lane decision D-2): Meta takes POST /<page>/subscribed_apps only with a
 *                          Page access token, and Nexus has no Page-token mode — answered with Meta's documented roads
 *   remove-page            DELETE /<page>/subscribed_apps with the app token (WH-012); no undo (installing is the above)
 * App subscriptions are APP-WIDE (review A1, D-1): when another business in Nexus uses the same Meta app, an unsubscribe
 * would stop its notifications too — refused, and a subscribe says it changes what that business receives as well.
 * Instagram (WH-013) and WhatsApp fields are set only in Meta's App Dashboard: answered plainly, nothing sent.
 *
 * Undo puts back what the change replaced, through this same tool: fields it added are removed, a removed subscription
 * is subscribed again (only fields Nexus takes, only to Nexus's own callback), a connection is taken away again and the
 * other way round. What has no way back is said (noUndo). Field lists are kept sorted (Meta lists them in any order).
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { AppSubscriptionState } from './live-webhook-setup.js'
import { META_WEBHOOK_OBJECTS, metaWebhookFieldsOf } from '../../gateway/meta-webhook-rules.js'

export const WEBHOOK_ACTIONS = ['subscribe-app', 'unsubscribe-app', 'connect-ad-account', 'disconnect-ad-account', 'install-page', 'remove-page'] as const
export type WebhookAction = typeof WEBHOOK_ACTIONS[number]
/** What a person can name as the object of an app subscription: Meta's API objects, and the two only its dashboard sets. */
export const WEBHOOK_OBJECT_NAMES = [...META_WEBHOOK_OBJECTS, 'instagram', 'whatsapp_business_account'] as const

export interface WebhooksRequest {
  action: WebhookAction
  object?: string
  fields?: string[]
}

/** The arguments of set-meta-webhooks that put a change back (its undo): an action and what it names. */
export interface WebhooksUndoArgs { action: WebhookAction; object?: string; fields?: string[] }

export interface WebhooksRecord {
  action: WebhookAction
  object?: string | null
  /** The object's subscribed fields (sorted), or the ad account's connection — as they were / are. */
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
}

export const DASHBOARD_ONLY = 'Instagram and WhatsApp webhook fields are set only in Meta\'s App Dashboard (Meta\'s API does not take them: app/subscriptions): the Owner sets them there (Webhooks of the app, the callback Nexus\'s receiver). Instagram also needs a per-account step Meta takes only with a Page access token — the linked Facebook Page\'s /subscribed_apps with the Instagram fields — which Nexus cannot do yet. meta-webhooks reads the result.'
export const PAGE_INSTALL_ROADS = 'Nexus does not install the app on a Page: Meta takes that (page/subscribed_apps) only with a Page access token of a person with a task on the Page, and Nexus has no Page-token mode yet. Meta\'s documented roads: Meta Business Suite › All Tools › Business Apps (adds the app to the Page), or the Graph API Explorer with a Page token (POST /<page id>/subscribed_apps with the fields). meta-webhooks reads the app subscription; the Page\'s own list Meta answers only to a Page token too.'
const APP_WIDE = (n: number) => `This subscription is app-wide: ${n === 1 ? 'another business' : `${n} other businesses`} in Nexus use${n === 1 ? 's' : ''} the same Meta app, so this also changes what ${n === 1 ? 'it receives' : 'they receive'} (each still gets only its own ad accounts' and Pages' notifications).`
const APP_WIDE_REFUSAL = 'Another business in Nexus uses this Meta app; an app-wide unsubscribe would stop its notifications too — change it in Meta\'s App Dashboard (Webhooks of the app).'

const sorted = (list: readonly string[]) => [...list].sort()
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const words = (list: readonly string[] | null | undefined) => (list && list.length ? sorted(list).join(', ') : 'none')

function request(fields: Omit<MetaChangeRequest, 'step' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget'>): MetaChangeRequest {
  return { step: 1, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, ...fields }
}

function draft(input: {
  summary: string; lines: Array<[string, unknown, unknown]>; requests: MetaChangeRequest[]; stands: unknown; warnings?: string[]; skipped?: string[]
  before: WebhooksRecord; after: WebhooksRecord
}): MetaChangeDraft {
  const { changes, more } = changeLines(input.lines)
  return {
    summary: input.summary, changes, totals: { requests: input.requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: input.warnings ?? [], spendsMoney: [], skipped: input.skipped ?? [], requests: input.requests, stands: input.stands,
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
  // `kind` is a status change's and is not read here: objectKind names the object (change-draft.ts).
  const appPath = { objectId: live.appId, kind: 'campaign' as const, objectKind: 'app' as const, edge: 'subscriptions' as const }
  const accountPath = { objectId: `act_${live.adAccountId}`, kind: 'campaign' as const, objectKind: 'adaccount' as const, edge: 'subscribed_apps' as const }

  if (req.action === 'install-page') return { refusal: PAGE_INSTALL_ROADS }

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
      if (current && !current.nexusCallback) {
        warnings.push(`The app's ${object} subscription now calls ${current.callbackOrigin ?? 'another address'}; this change points it at Nexus's receiver (Meta keeps one callback per object). Nexus never writes another callback back.`)
        noUndo.push(`The earlier callback (${current.callbackOrigin ?? 'another address'}) is not put back: Nexus only ever gives Meta its own.`)
      }
      if (current && current.active === false) warnings.push(`The app's ${object} subscription is inactive; Meta switches it on again with this change.`)
      warnings.push('Meta first sends a verification request to Nexus\'s receiver; the change fails when it is not answered (META_WEBHOOK_VERIFY_TOKEN must be set on the API service). Apps in development mode receive only the App Dashboard\'s test notifications and those of people with a role on the app.')
      // Review A1 / D-1 — an undo is an app-wide unsubscribe: never while another business (or maybe one) uses the app.
      let undo: WebhooksUndoArgs | null = !current ? { action: 'unsubscribe-app', object } : added.length ? { action: 'unsubscribe-app', object, fields: added } : null
      if (undo && others !== 0) { undo = null; noUndo.push(others === null ? 'Nexus could not tell whether another business uses this Meta app, so its undo (an app-wide unsubscribe) is not offered.' : APP_WIDE_REFUSAL) }
      else if (!undo && !noUndo.length) noUndo.push('Switching an inactive subscription on again has no undo of its own (Meta has no switch to make it inactive).')
      const all = sorted([...new Set([...(current?.fields ?? []), ...wanted])])
      return draft({
        summary: `Subscribe the business's Meta app to ${object} notifications (${words(wanted)}), sent to Nexus's receiver.`,
        lines: [[`App subscription ${object}`, current ? words(current.fields) : 'none', words(all)]],
        requests: [request({ ...appPath, label: `Subscribe the app to ${object}: ${words(wanted)}`, params: { object, callback_url: live.callback.url, fields: wanted.join(','), include_values: 'true' }, undoable: !!undo, operation: 'webhooks.subscribeApp', via: { auth: 'app' } })],
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
      requests: [request({ ...appPath, label: whole ? `Remove the app's ${object} subscription` : `Remove ${words(removing)} from the app's ${object} subscription`, params: {}, method: 'DELETE', undoable: !!undo, operation: 'webhooks.unsubscribeApp', via: { auth: 'app', query: whole ? { object } : { object, fields: removing.join(',') } } })],
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

  // remove-page — the CHOSEN Page, with the app token. Nexus cannot read the Page's apps (a Page token) nor install it back.
  if (!live.pageId) return { refusal: 'This business has no Facebook Page chosen (set-meta-connection chooses one).' }
  const pagePath = { objectId: live.pageId, kind: 'campaign' as const, objectKind: 'page' as const, edge: 'subscribed_apps' as const }
  return draft({
    summary: `Remove the business's Meta app from Page ${live.pageId} (no more Page notifications to Nexus).`,
    lines: [[`Page ${live.pageId}: the app`, 'installed or not (Nexus cannot read it)', 'not installed']],
    requests: [request({ ...pagePath, label: `Remove the app from Page ${live.pageId}`, params: {}, method: 'DELETE', undoable: false, operation: 'webhooks.removePage', via: { auth: 'app' } })],
    stands: { action: req.action, pageId: live.pageId },
    warnings: ['Nexus cannot read which apps are installed on the Page (Meta answers that to a Page access token only): when the app is not installed, Meta answers and nothing changes.'],
    before: { action: req.action, fields: null, undo: null, noUndo: [`It has no undo: ${PAGE_INSTALL_ROADS}`] },
    after: { action: req.action, fields: null },
  })
}
