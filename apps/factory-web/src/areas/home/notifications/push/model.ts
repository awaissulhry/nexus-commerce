import { z } from 'zod'
import { EVENT_KINDS } from '@nexus/factory-domain/notifications/preferences/preferences'
import { PUSH_LIMITS } from '@nexus/factory-domain/notifications/preferences/push'

/**
 * Get urgent items on this phone (B-W2b-388; design home.notifications popup push-enrol, W2b, "⋯ › Push on this device": "What
 * counts as urgent (approvals, andon escalations, mentions), how to add the app to the home screen on iPhone, test push", primary
 * "Turn on push", DS Stepper; PLT-140). On B-W2b-385's routes: GET /notifications/push (available or why not, the VAPID key, my
 * devices, what my push column brings), POST /notifications/push/devices (this browser's subscription; its keys sealed by the
 * API), DELETE …/devices/:id (turned off), POST /notifications/push/test. Pure: what this browser can do, the steps, the label.
 */

export const pushSchema = z.object({
  available: z.boolean(),
  unavailable: z.string().nullable(),
  publicKey: z.string().nullable(),
  devices: z.array(z.object({ id: z.string(), label: z.string(), service: z.string(), lastUsedAt: z.string().nullable(), createdAt: z.string() })),
  maxDevices: z.number().int(),
  urgent: z.array(z.enum(EVENT_KINDS)),
})
export type PushState = z.infer<typeof pushSchema>
export type PushDevice = PushState['devices'][number]

export const testSchema = pushSchema.extend({ results: z.array(z.object({ deviceId: z.string(), outcome: z.enum(['SENT', 'GONE', 'FAILED']) })) })
export type TestAnswer = z.infer<typeof testSchema>

/** What this browser can do about push. */
export type BrowserPush =
  /** Service workers and the Push API are there, on a secure page. */
  | 'ready'
  /** An iPhone or iPad browser tab: push only reaches the app added to the home screen (iOS 16.4 or later). */
  | 'ios-install'
  /** Not over https (or localhost): no service worker. */
  | 'insecure'
  /** This browser has no Push API. */
  | 'unsupported'

export interface BrowserFacts {
  readonly secure: boolean
  readonly serviceWorker: boolean
  readonly pushManager: boolean
  readonly notification: boolean
  /** An iPhone, iPod or iPad (an iPad says "Macintosh" with touch). */
  readonly ios: boolean
  /** Running as the app added to the home screen (display-mode: standalone). */
  readonly standalone: boolean
}

export function browserPush(facts: BrowserFacts): BrowserPush {
  if (!facts.secure) return 'insecure'
  if (facts.serviceWorker && facts.pushManager && facts.notification) return 'ready'
  if (facts.ios && !facts.standalone) return 'ios-install'
  return 'unsupported'
}

/** The facts of the browser the page runs in (all false on the server). */
export function browserFacts(): BrowserFacts {
  if (typeof window === 'undefined') return { secure: false, serviceWorker: false, pushManager: false, notification: false, ios: false, standalone: false }
  const agent = window.navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && window.navigator.maxTouchPoints > 1)
  return {
    secure: window.isSecureContext,
    serviceWorker: 'serviceWorker' in window.navigator,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
    ios,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches === true,
  }
}

/** This device's name as offered (the person may change it): the browser and the system, in plain words. */
export function deviceLabel(agent: string): string {
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS X|Macintosh/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : ''
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : ''
  return [browser, system].filter(Boolean).join(' · ').slice(0, PUSH_LIMITS.label) || 'Browser'
}

/** The steps of the Stepper: what counts as urgent, the home screen on iPhone (only there), turn on, test. */
export type PushStep = 'urgent' | 'install' | 'turnOn' | 'test'

export function pushSteps(browser: BrowserPush): PushStep[] {
  return browser === 'ios-install' ? ['urgent', 'install', 'turnOn', 'test'] : ['urgent', 'turnOn', 'test']
}

/** Why Turn on push is held now (a message key of `home-mywork`), or null. */
export function turnOnHeld(state: { readonly push: PushState | null; readonly browser: BrowserPush; readonly busy: boolean; readonly offline: boolean; readonly label: string; readonly thisDevice: boolean }): string | null {
  if (state.offline) return 'held.offline'
  if (state.busy) return 'held.busy'
  if (!state.push) return 'push.held.reading'
  if (!state.push.available) return 'push.held.unavailable'
  if (state.browser !== 'ready') return `push.held.${state.browser}`
  if (state.thisDevice) return 'push.held.already'
  if (!state.label.trim()) return 'push.held.label'
  if (state.push.devices.length >= state.push.maxDevices) return 'push.held.tooMany'
  return null
}

export interface PushModel {
  readonly push: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: PushState }
  readonly browser: BrowserPush
  /** This browser's device among mine (its push subscription is one of them), or null. */
  readonly thisDevice: string | null
  readonly step: PushStep
  readonly label: string
  /** Why changing is held (offline, a change in flight): a message key, or null. */
  readonly busy: boolean
  readonly offline: boolean
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' | 'info'; readonly params?: Readonly<Record<string, string | number>> } | null
  /** The last test's outcome per device. */
  readonly tested: Readonly<Record<string, 'SENT' | 'GONE' | 'FAILED'>>
}
