import { paramsFor, sentenceOf, type DigestLocale } from '../rules'
import type { Grain } from '../../auth/grains/grains'

/**
 * Push to phones (B-W2b-385; PLT-140 "Web push to installed web apps on Android and iPhone home-screen apps (iOS 16.4+),
 * VAPID keys as secrets, no cost"; PLT-152 "a worker's push never shows a price"; design home.notifications popup
 * push-enrol "Get urgent items on this phone"), pure. A person turns push on per device (notify-depth.prisma
 * PushSubscription: the browser's endpoint and its keys, sealed); apps/factory-api platform/notifications/push encrypts each
 * message for its device (RFC 8291, aes128gcm) and signs it with the server's VAPID key (RFC 8292).
 *
 * Only the office has push (the table is office only): a floor worker's tablet never gets one. Each message is written FOR its
 * reader at the moment it is sent: the notification's own params (made for them at the fan-out) cut again to the grains they
 * hold now (`paramsFor`), so a price reaches only a phone whose person may see prices.
 */

export const PUSH_LIMITS = Object.freeze({
  label: 100,
  endpoint: 2048,
  /** Live devices one person keeps (a phone, a tablet, a laptop or two). */
  devicesPerPerson: 10,
  /** How long a push service keeps a message for a device that is off (seconds). */
  ttlSeconds: 24 * 60 * 60,
  /** The longest text a push carries (a push service takes about 4 KB of encrypted payload). */
  body: 240,
})

/**
 * The push services the browsers use (Chrome and Android: FCM; Firefox: Mozilla autopush; Safari and iPhone home-screen
 * apps: Apple; Edge: Windows). The server sends to these only: an endpoint elsewhere would make it call any address.
 */
const PUSH_SERVICES: readonly RegExp[] = Object.freeze([
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
])

/** What is wrong with a push endpoint the browser gave (null: nothing). */
export function endpointProblem(endpoint: string): string | null {
  if (endpoint.length > PUSH_LIMITS.endpoint || /\s/.test(endpoint)) return 'This is not a push address a browser gives.'
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'This is not a push address a browser gives.'
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return 'A push address is an https address of a push service.'
  if (!PUSH_SERVICES.some((service) => service.test(url.hostname))) return 'This browser’s push service is not one the factory sends to (Chrome, Firefox, Safari, Edge).'
  return null
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/

/** base64url to bytes (a browser's subscription keys), or null when it is not base64url. Pure (no Buffer: the web may use it). */
export function fromBase64Url(value: string): Uint8Array | null {
  if (!B64URL.test(value)) return null
  const plain = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  if (plain.length % 4 === 1) return null
  try {
    const text = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4))
    return Uint8Array.from(text, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/** What is wrong with the browser's subscription keys (null: nothing): p256dh a P-256 public key, auth 16 bytes. */
export function keysProblem(keys: { readonly p256dh: string; readonly auth: string }): string | null {
  const p256dh = fromBase64Url(keys.p256dh)
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04) return 'The browser’s push key is not a P-256 public key.'
  const auth = fromBase64Url(keys.auth)
  if (!auth || auth.length !== 16) return 'The browser’s push secret is not 16 bytes.'
  return null
}

/** What is wrong with the name a person gives a device (null: nothing). */
export function labelProblem(label: string): string | null {
  const trimmed = label.trim()
  if (trimmed.length === 0 || trimmed.length > PUSH_LIMITS.label || /[\r\n]/.test(label)) return `Name the device in 1 to ${PUSH_LIMITS.label} characters on one line ("Phone", "Office laptop").`
  return null
}

/** What a push carries (JSON, encrypted for the device): the service worker of the factory web shows it. */
export interface PushMessage {
  readonly v: 1
  readonly title: string
  readonly body: string
  /** The page it opens, under the web's origin (`/w/<company>/home/notifications?open=<id>`). */
  readonly url: string
  /** Pushes of one record replace each other on the device (one line per record, not a pile). */
  readonly tag: string
  readonly notificationId: string | null
}

const clip = (text: string): string => (text.length <= PUSH_LIMITS.body ? text : `${text.slice(0, PUSH_LIMITS.body - 1)}…`)

/** The page of a notification in the office: Home › Notifications, opened at it. */
export const notificationPage = (companyCode: string, notificationId: string): string => `/w/${encodeURIComponent(companyCode)}/home/notifications?open=${encodeURIComponent(notificationId)}`

/**
 * One notification's push, written for its reader now: its sentence in their language from its params cut to the grains they
 * hold (PLT-152), the record's label as the title.
 */
export function pushMessageOf(
  notification: { readonly id: string; readonly messageKey: string; readonly params: unknown; readonly recordType: string; readonly recordId: string; readonly recordLabel: string; readonly actorId: string | null },
  reader: { readonly locale: DigestLocale; readonly grains: ReadonlySet<Grain> },
  names: ReadonlyMap<string, string>,
  url: string,
): PushMessage {
  const params = paramsFor(notification.params, reader.grains)
  return { v: 1, title: clip(notification.recordLabel), body: clip(sentenceOf({ ...notification, params }, names, reader.locale)), url, tag: `${notification.recordType}:${notification.recordId}`, notificationId: notification.id }
}

/** The test push of "Get urgent items on this phone". */
export function testPushOf(locale: DigestLocale, url: string): PushMessage {
  return locale === 'it'
    ? { v: 1, title: 'Notifiche attive', body: 'Su questo dispositivo arriveranno le cose urgenti: approvazioni, avvisi e menzioni.', url, tag: 'push-test', notificationId: null }
    : { v: 1, title: 'Push is on', body: 'Urgent items will reach this device: approvals, alerts and mentions.', url, tag: 'push-test', notificationId: null }
}

/** What a push service's answer means: taken, the subscription is gone (turn it off), or a failure to log. */
export type PushOutcome = 'SENT' | 'GONE' | 'FAILED'
export function pushOutcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'SENT'
  if (status === 404 || status === 410) return 'GONE'
  return 'FAILED'
}
