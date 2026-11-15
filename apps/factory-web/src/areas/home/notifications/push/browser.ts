import { fromBase64Url } from '@nexus/factory-domain/notifications/preferences/push'
import { PUSH_WORKER_PATH } from '../../../../sw/push'

/**
 * The browser's half of push (B-W2b-388): the office's service worker (src/sw/push.ts at `/push-sw.js`), the person's permission
 * and this browser's push subscription. Every call is the browser's own; nothing here talks to the API. The id of this browser's
 * device among mine is kept in this browser (a per-person convenience: lost, the next Turn on finds the device again by its
 * subscription, which the API answers as the same device).
 */

const DEVICE_KEY = 'factory_push_device'

async function registration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) throw new Error('push-browser')
  await navigator.serviceWorker.register(PUSH_WORKER_PATH, { scope: '/' })
  return navigator.serviceWorker.ready
}

/** This browser's push subscription, or null (none yet, or no worker). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  const found = await navigator.serviceWorker.getRegistration('/')
  return found ? found.pushManager.getSubscription() : null
}

/** Asks the person's permission and subscribes this browser with the server's key; refused: Error('push-denied'). */
export async function subscribe(publicKey: string): Promise<{ readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }> {
  if (typeof Notification === 'undefined') throw new Error('push-browser')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('push-denied')
  const key = fromBase64Url(publicKey)
  if (!key) throw new Error('push-browser')
  const worker = await registration()
  const subscription = (await worker.pushManager.getSubscription()) ?? (await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }))
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('push-browser')
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

/** Stops this browser's subscription (after the API turned the device off). */
export async function unsubscribe(): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription) await subscription.unsubscribe()
}

export function storedDevice(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_KEY)
  } catch {
    return null
  }
}

export function storeDevice(deviceId: string | null): void {
  try {
    if (deviceId) window.localStorage.setItem(DEVICE_KEY, deviceId)
    else window.localStorage.removeItem(DEVICE_KEY)
  } catch {
    // A private window keeps nothing: the next Turn on finds the device again.
  }
}
