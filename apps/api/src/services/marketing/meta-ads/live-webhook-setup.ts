/**
 * Meta step 30 part 2 (2026-10-21) — the live state the webhook and alert-subscription changes stand on, read through the
 * gateway (GET only; the same reads as meta-webhooks, step 16):
 *   - the app's subscriptions (`GET /<app id>/subscriptions?fields=object,callback_url,fields,active`, the APP token):
 *     per object its fields and whether its callback is Nexus's own receiver — the callback itself never leaves this
 *     file (a path can carry a secret), only "Nexus's" yes / no and its origin;
 *   - the apps connected to the chosen ad account (`GET /act_<id>/subscribed_apps?fields=app_id,app_name`);
 *   - part 3: the apps installed on the chosen Page (`GET /<page>/subscribed_apps?fields=id,subscribed_fields`): Meta
 *     answers it only to the Page's own token, which the gateway reads itself (meta-calls.ts `pageRead`); and the
 *     Instagram account linked to the chosen Page (`GET /<page>?fields=id,instagram_business_account{id}`);
 *   - the ad account's alert subscriptions (`GET /act_<id>/subscriptions[/<id>]`): event, field, value, operator,
 *     filters, status — as Meta writes them (the undo of a removal sends exactly these again).
 */
import { metaCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaWebhookCallback } from '../../gateway/meta-webhook-rules.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import { metaReadOne } from './read-client.js'
import { graphPage, idOf, obj, rowsOf, text, type Row } from './live-partners.js'
import { MetaLiveRefusal } from './live.js'
import { PAGE_INSTALL_EXPLAIN } from './change-webhooks.js'

export interface AppSubscriptionState {
  object: string
  fields: string[]
  active: boolean | null
  /** The callback is exactly Nexus's own receiver for this app. */
  nexusCallback: boolean
  /** The callback's origin (scheme and host) — never its path or query. */
  callbackOrigin: string | null
}

const originOf = (raw: string | null): string | null => {
  if (!raw) return null
  try { return new URL(raw).origin } catch { return null }
}
const namesOf = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((f) => text(f) ?? text(obj(f)?.name)).filter((f): f is string => !!f)

/** The app's webhook subscriptions, per object (the APP token). */
export async function liveAppSubscriptions(connectionId: string, appId: string): Promise<AppSubscriptionState[]> {
  const operation = 'webhooks.setup.app'
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId, operation, path: `${appId}/subscriptions`, query: { fields: 'object,callback_url,fields,active' }, auth: 'app', timeoutMs: 30_000 })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, operation, 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), operation, 1)
  const body = answer.json<Row>()
  if (!body || typeof body !== 'object') throw new MetaReadError(localFailure('Meta answered with something that is not JSON.', 'NOT_JSON'), operation, 1)
  const expected = metaWebhookCallback(appId)
  return rowsOf(body).map((r) => {
    const callback = text(r.callback_url)
    return {
      object: text(r.object) ?? '',
      fields: namesOf(r.fields),
      active: typeof r.active === 'boolean' ? r.active : null,
      nexusCallback: 'url' in expected && callback === expected.url,
      callbackOrigin: originOf(callback),
    }
  }).filter((s) => s.object)
}

/** Is the connection's app connected to the chosen ad account (its `subscribed_apps`)? */
export async function liveAdAccountApps(connectionId: string, adAccountId: string, appId: string): Promise<{ connected: boolean }> {
  const read = await graphPage(connectionId, 'webhooks.setup.adAccountApps', `act_${adAccountId}/subscribed_apps`, { fields: 'app_id,app_name', limit: 100 })
  return { connected: read.rows.some((r) => (idOf(r.app_id) ?? idOf(r.id)) === appId) }
}

/** Part 3 — the connection's app on the chosen Page: installed or not, and with which fields (sorted). */
export interface PageAppState { installed: boolean; fields: string[] }

/**
 * Review A-F5 — the Page's connected apps are read with the chosen Page's OWN token (gateway.ts `pageRead`): Meta refusing
 * THAT token (190, 102; 210, "not the Page's own") says nothing of the business's system-user token. Its failure is not
 * "auth lost" and says the Page token's words (the install's PAGE_INSTALL_EXPLAIN), never errors.ts's "Meta no longer
 * accepts this business's system-user token". Review round 2 B-4 — nor a permission (200, 10) on that read: the Page's
 * task and permissions, never errors.ts's "the ad account is assigned … ads_read". Anything else goes on as it came.
 */
export function pageTokenReadError(err: unknown, pageId: string): unknown {
  if (!(err instanceof MetaReadError) || err.failure.origin !== 'meta') return err
  const base = (err.failure.code ?? '').split('/')[0]
  const words = err.failure.authLost ? PAGE_INSTALL_EXPLAIN['190']
    : base === '210' ? PAGE_INSTALL_EXPLAIN['210']
      : base === '200' || base === '10' || err.failure.permissionDenied ? PAGE_INSTALL_EXPLAIN['200'] : null
  if (!words) return err
  const sentence = `Meta refused the chosen Page's own token for the read of Page ${pageId}'s connected apps${err.failure.code ? ` (${err.failure.code})` : ''}: ${words}`
  return new MetaReadError({ ...err.failure, authLost: false, sentence }, err.operation, err.callsSpent)
}

/**
 * Is the connection's app installed on the chosen Page, and with which fields? (The Page's own token: the gateway's.)
 * Review round 2 A-N1 — one page of Meta's list (100 apps): when Meta has more and the app is not on this one, Nexus
 * cannot tell — refused in words, never read as "not installed".
 */
export async function livePageApps(connectionId: string, pageId: string, appId: string): Promise<PageAppState> {
  const read = await graphPage(connectionId, 'webhooks.setup.pageApps', `${pageId}/subscribed_apps`, { fields: 'id,subscribed_fields', limit: 100 })
    .catch((err: unknown) => { throw pageTokenReadError(err, pageId) })
  const mine = read.rows.find((r) => idOf(r.id) === appId)
  if (!mine && read.nextAfter) throw new MetaLiveRefusal(`Meta lists more apps on Page ${pageId} than one read gives (100), and the business's Meta app is not among the first: Nexus cannot tell whether it is installed there, so nothing is sent. Meta Business settings or the App Dashboard show the Page's apps.`)
  return { installed: !!mine, fields: mine ? namesOf(mine.subscribed_fields).sort() : [] }
}

/** Part 3 (WH-013) — the Instagram professional account linked to the chosen Page, or null (the system-user token). */
export async function livePageInstagram(connectionId: string, pageId: string): Promise<string | null> {
  const { body } = await metaReadOne<Row>({ connectionId }, { operation: 'webhooks.setup.pageInstagram', path: pageId, query: { fields: 'id,instagram_business_account{id}' } })
  return idOf(obj(body.instagram_business_account)?.id)
}

/** One alert subscription as Meta writes it (the values as text, the filters as Meta's list). */
export interface AlertSubscriptionState {
  subscriptionId: string
  eventType: string | null
  field: string | null
  value: string | null
  operator: string | null
  /** As Meta lists them: one value, or a list for IN / NOT_IN. */
  filters: Array<{ field: string; value: string | string[]; operator: string }>
  status: string | null
}

const valueText = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : Array.isArray(v) ? JSON.stringify(v.map((x) => (typeof x === 'number' ? String(x) : x))) : null)

function alertOf(r: Row): AlertSubscriptionState | null {
  const subscriptionId = idOf(r.subscription_id) ?? idOf(r.id)
  if (!subscriptionId) return null
  const filters = (Array.isArray(r.filters) ? r.filters : []).map(obj).filter((f): f is Row => !!f)
    .map((f) => ({ field: text(f.field) ?? '', value: Array.isArray(f.value) ? f.value.map((x) => String(x)) : valueText(f.value) ?? '', operator: text(f.operator) ?? '' }))
  return { subscriptionId, eventType: text(r.event_type), field: text(r.field), value: valueText(r.value), operator: text(r.operator), filters, status: text(r.status) }
}

/** One alert subscription of the chosen ad account, live (null when Meta does not answer it for this account). */
export async function liveAlertSubscription(connectionId: string, adAccountId: string, subscriptionId: string): Promise<AlertSubscriptionState | null> {
  try {
    const { body } = await metaReadOne<Row>({ connectionId }, { operation: 'webhooks.setup.alert', path: `act_${adAccountId}/subscriptions/${subscriptionId}` })
    return alertOf(body)
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.notFound) return null
    throw err
  }
}
