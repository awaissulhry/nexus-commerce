/**
 * The office's push service worker (B-W2b-388; design home.notifications popup push-enrol "Get urgent items on this phone";
 * PLT-140): the only service worker of factory-web, served at `/push-sw.js` (src/app/push-sw.js/route.ts) with scope `/`. It
 * shows the pushes B-W2b-385's API sends — JSON `{ v: 1, title, body, url, tag, notificationId }` (factory-domain
 * notifications/preferences/push PushMessage: the words already cut to the reader's grains, no price for whom has none) — and
 * a click opens the push's page of THIS web (any other address opens Home › Notifications). It caches nothing and handles no
 * fetch: the office stays online-only (the floor's offline queue is its own, without a worker).
 *
 * The worker is ONE self-contained function (no import, no outside name): the route sends its source text, so whatever it
 * needs is defined inside it. Called without a scope it hands back its two rules, for the tests.
 */

/** The parts of a service worker's global scope this worker uses (the DOM lib has no worker types here). */
export interface PushWorkerScope {
  addEventListener(type: string, listener: (event: PushWorkerEvent) => void): void
  readonly registration: { showNotification(title: string, options: { readonly body: string; readonly tag?: string; readonly data: { readonly url: string } }): Promise<void> }
  readonly clients: {
    matchAll(options: { readonly type: 'window'; readonly includeUncontrolled: boolean }): Promise<readonly { readonly url: string; focus(): Promise<unknown> }[]>
    openWindow(url: string): Promise<unknown>
    claim(): Promise<void>
  }
  readonly location: { readonly origin: string }
  skipWaiting(): Promise<void>
}

export interface PushWorkerEvent {
  readonly data?: { text(): string } | null
  readonly notification?: { readonly data?: { readonly url?: unknown } | null; close(): void }
  waitUntil?(work: Promise<unknown>): void
}

export interface PushShown {
  readonly title: string
  readonly body: string
  readonly tag: string | undefined
  readonly url: string
}

export interface PushWorkerRules {
  /** A push's text as the worker shows it, or a quiet fallback when it is not one of ours. */
  readonly readMessage: (text: string | null, origin: string) => PushShown
  /** Where a click goes: the push's page on this web's origin, else Home › Notifications' entry. */
  readonly target: (url: unknown, origin: string) => string
}

export function pushWorker(scope: PushWorkerScope | null): PushWorkerRules | undefined {
  const FALLBACK_PATH = '/'
  const target = (url: unknown, origin: string): string => {
    if (typeof url !== 'string' || url === '') return origin + FALLBACK_PATH
    try {
      const resolved = new URL(url, origin)
      return resolved.origin === origin ? resolved.href : origin + FALLBACK_PATH
    } catch {
      return origin + FALLBACK_PATH
    }
  }
  const readMessage = (text: string | null, origin: string): PushShown => {
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    const message = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    const words = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
    const title = message ? words(message.title, 120) : ''
    return {
      title: title || 'Nexus Factory',
      body: message ? words(message.body, 240) : '',
      tag: message && typeof message.tag === 'string' && message.tag !== '' ? message.tag.slice(0, 64) : undefined,
      url: target(message ? message.url : null, origin),
    }
  }
  if (scope === null) return { readMessage, target }

  scope.addEventListener('install', () => {
    void scope.skipWaiting()
  })
  scope.addEventListener('activate', (event) => {
    event.waitUntil?.(scope.clients.claim())
  })
  scope.addEventListener('push', (event) => {
    const shown = readMessage(event.data ? event.data.text() : null, scope.location.origin)
    event.waitUntil?.(scope.registration.showNotification(shown.title, { body: shown.body, ...(shown.tag ? { tag: shown.tag } : {}), data: { url: shown.url } }))
  })
  scope.addEventListener('notificationclick', (event) => {
    const notification = event.notification
    if (!notification) return
    notification.close()
    const url = target(notification.data ? notification.data.url : null, scope.location.origin)
    event.waitUntil?.(
      scope.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
        const same = open.find((client) => client.url === url)
        return same ? same.focus() : scope.clients.openWindow(url)
      }),
    )
  })
  return undefined
}

/** Where the worker is served (its scope is the whole web: the route sends `Service-Worker-Allowed: /`). */
export const PUSH_WORKER_PATH = '/push-sw.js'

/** The worker's source as the route sends it: the one function, run on the worker's own global scope. */
export const PUSH_WORKER_SOURCE = `'use strict';\n(${pushWorker.toString()})(self);\n`
