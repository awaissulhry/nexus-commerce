/**
 * Meta step 30 part 2 (2026-10-21) — the live state the webhook and alert-subscription changes stand on, read through the
 * gateway (GET only; the same reads as meta-webhooks, step 16):
 *   - the app's subscriptions (`GET /<app id>/subscriptions?fields=object,callback_url,fields,active`, the APP token):
 *     per object its fields and whether its callback is Nexus's own receiver — the callback itself never leaves this
 *     file (a path can carry a secret), only "Nexus's" yes / no and its origin;
 *   - the apps connected to the chosen ad account (`GET /act_<id>/subscribed_apps?fields=app_id,app_name`);
 *   - the apps installed on the chosen Page (`GET /<page>/subscribed_apps?fields=id,name,subscribed_fields`: Meta answers
 *     it to a Page token only, so it can be refused — the change then says it could not read the Page's apps);
 *   - the ad account's alert subscriptions (`GET /act_<id>/subscriptions[/<id>]`): event, field, value, operator,
 *     filters, status — as Meta writes them (the undo of a removal sends exactly these again).
 */
import { metaCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaWebhookCallback } from '../../gateway/meta-webhook-rules.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import { metaReadOne } from './read-client.js'
import { graphPage, idOf, obj, rowsOf, text, type Row } from './live-partners.js'

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

/** Is the connection's app connected to the chosen ad account (its `subscribed_apps`)? And how many other apps are. */
export async function liveAdAccountApps(connectionId: string, adAccountId: string, appId: string): Promise<{ connected: boolean; otherApps: number }> {
  const read = await graphPage(connectionId, 'webhooks.setup.adAccountApps', `act_${adAccountId}/subscribed_apps`, { fields: 'app_id,app_name', limit: 100 })
  const ids = read.rows.map((r) => idOf(r.app_id) ?? idOf(r.id))
  return { connected: ids.includes(appId), otherApps: ids.filter((id) => id && id !== appId).length }
}

/** The fields the connection's app is installed with on the chosen Page (null: not installed). Meta may refuse the read. */
export async function livePageApp(connectionId: string, pageId: string, appId: string): Promise<{ fields: string[] | null }> {
  const read = await graphPage(connectionId, 'webhooks.setup.pageApps', `${pageId}/subscribed_apps`, { fields: 'id,name,subscribed_fields', limit: 100 })
  const mine = read.rows.find((r) => idOf(r.id) === appId)
  return { fields: mine ? namesOf(mine.subscribed_fields) : null }
}

/** One alert subscription as Meta writes it (the values as text, the filters as Meta's list). */
export interface AlertSubscriptionState {
  subscriptionId: string
  eventType: string | null
  field: string | null
  value: string | null
  operator: string | null
  filters: Array<{ field: string; value: string; operator: string }>
  status: string | null
}

const valueText = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : Array.isArray(v) ? JSON.stringify(v.map((x) => (typeof x === 'number' ? String(x) : x))) : null)

function alertOf(r: Row): AlertSubscriptionState | null {
  const subscriptionId = idOf(r.subscription_id) ?? idOf(r.id)
  if (!subscriptionId) return null
  const filters = (Array.isArray(r.filters) ? r.filters : []).map(obj).filter((f): f is Row => !!f)
    .map((f) => ({ field: text(f.field) ?? '', value: valueText(f.value) ?? '', operator: text(f.operator) ?? '' }))
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
