import { isKnownReason, type FixPlace } from '@nexus/factory-domain/integration-health/errors'
import type { ErrorItem, ErrorView, TestAnswer } from './api'

/**
 * The error queue on screen (B-W2b-415; PLT-201; design admin.connections sec:errors, pop:error-item), pure: what failed and
 * why in words (keys of `admin-integration-health.json`, prefix `aih.`), where a failed call is fixed, what a bulk action
 * reaches, the dismiss reason. A code the page has no words for is shown as the code (data), never as a message key.
 */

/**
 * Operations the page names in words (`aih.op.<area>.<action>`), by area: any other shows its code. Kept by area (never as one
 * dotted literal) so the Connections pages' key scanners do not read an operation as one of their own keys.
 */
const KNOWN_BY_AREA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  mail: ['send', 'get_identity', 'create_identity', 'fetch_inbound'],
  sdi: ['send_invoice', 'send', 'status'],
  parcel: ['create', 'track'],
  vat: ['check'],
  files: ['put', 'read', 'delete', 'scan'],
  webhook: ['process'],
})

/** Every operation the page names in words. */
export const KNOWN_OPERATIONS: readonly string[] = Object.freeze(Object.entries(KNOWN_BY_AREA).flatMap(([area, actions]) => actions.map((action) => [area, action].join('.'))))

const isKnownOperation = (operation: string): boolean => {
  const [area, ...rest] = operation.split('.')
  return (KNOWN_BY_AREA[area ?? ''] ?? []).includes(rest.join('.'))
}

export function operationWords(item: Pick<ErrorItem, 'source' | 'operation' | 'reasonCode'>): { key: string; params: Record<string, string> } {
  if (isKnownOperation(item.operation)) return { key: `aih.op.${item.operation}`, params: {} }
  if (item.source === 'OUTBOX') return { key: item.reasonCode === 'publish_failed' ? 'aih.op.event' : 'aih.op.job', params: { code: item.operation } }
  return { key: 'aih.op.other', params: { code: item.operation } }
}

export function reasonWords(code: string): { key: string; params: Record<string, string> } {
  return isKnownReason(code) ? { key: `aih.reason.${code}`, params: {} } : { key: 'aih.reason.other', params: { code } }
}

/** The service in words: the provider's name (the Connections page's words), or "the factory" for an event or a job. */
export const serviceKey = (item: Pick<ErrorItem, 'provider'>): string => (item.provider ? `conn.provider.${item.provider}.name` : 'aih.service.factory')

export const STATE_TONE: Readonly<Record<ErrorItem['state'], 'danger' | 'info' | 'neutral'>> = { OPEN: 'danger', RETRIED: 'info', DISMISSED: 'neutral' }

/** The state in words: Waiting, Sent again (by you / it went through), Dismissed. */
export function stateKey(item: Pick<ErrorItem, 'state' | 'retriedBySystem'>): string {
  if (item.state === 'RETRIED') return item.retriedBySystem ? 'aih.state.wentThrough' : 'aih.state.RETRIED'
  return `aih.state.${item.state}`
}

/** Where a failed call is fixed and sent again ("Edit and retry"): an Office path under the company's prefix. */
export const FIX_PATHS: Readonly<Record<FixPlace, string>> = {
  invoices: '/finance/invoices',
  shipments: '/warehouse/shipments',
  mail: '/admin/connections#delivery',
  customers: '/sales/customers',
  files: '/admin/connections',
  rates: '/finance/settings',
}

export const fixHref = (prefix: string, place: FixPlace): string => `${prefix}${FIX_PATHS[place]}`

/** Why Retry is held, in words (null: it may). */
export const retryHeldKey = (item: Pick<ErrorItem, 'retry'>): string | null => (item.retry.held ? `aih.held.retry.${item.retry.held}` : null)
export const dismissHeldKey = (item: Pick<ErrorItem, 'dismiss'>): string | null => (item.dismiss.held ? `aih.held.dismiss.${item.dismiss.held}` : null)

/** What a bulk action reaches among the ticked items: those it applies to, and the others counted by why. */
export function bulkReach(items: readonly ErrorItem[], action: 'retry' | 'dismiss'): { applies: ErrorItem[]; left: Array<{ key: string; count: number }> } {
  const applies: ErrorItem[] = []
  const left = new Map<string, number>()
  for (const item of items) {
    const held = action === 'retry' ? item.retry.held : item.dismiss.held
    if (held === null) applies.push(item)
    else left.set(held, (left.get(held) ?? 0) + 1)
  }
  return { applies, left: [...left].map(([code, count]) => ({ key: `aih.bulk.left.${action}.${code}`, count })) }
}

/** The bulk button's held words when none of the ticked items can take it. */
export function bulkHeldKey(items: readonly ErrorItem[], action: 'retry' | 'dismiss', canManage: boolean): string | null {
  if (!canManage) return 'aih.held.retry.NO_RIGHT'
  if (items.length === 0) return 'aih.bulk.noneTicked'
  return bulkReach(items, action).applies.length === 0 ? `aih.bulk.none.${action}` : null
}

export const DISMISS_MIN = 3
export const DISMISS_MAX = 500

/** The dismiss reason's problem (a key), or null. */
export function dismissProblem(reason: string): string | null {
  const text = reason.trim()
  if (text === '') return 'aih.dismiss.required'
  if (text.length < DISMISS_MIN) return 'aih.dismiss.short'
  if (text.length > DISMISS_MAX) return 'aih.dismiss.long'
  return null
}

/** The views of the queue (a segmented control); the count shown beside each. */
export const VIEW_ORDER: readonly ErrorView[] = ['open', 'retried', 'dismissed', 'all']

export function viewCount(view: ErrorView, counts: { open: number; retried: number; dismissed: number } | null): number | null {
  if (!counts) return null
  return view === 'all' ? counts.open + counts.retried + counts.dismissed : counts[view]
}

/** A test answer in words: what happened, and the tone. */
export function testWords(answer: TestAnswer): { key: string; tone: 'success' | 'warning' | 'danger'; params: Record<string, string | number> } {
  if (answer.outcome === 'OK') return { key: answer.fake ? 'aih.test.okFake' : 'aih.test.ok', tone: 'success', params: { ms: answer.durationMs } }
  const reason = answer.reason ?? 'provider_error'
  if (answer.outcome === 'REFUSED') return { key: isKnownRefusal(reason) ? `aih.test.refused.${reason}` : 'aih.test.refused.other', tone: 'warning', params: { code: reason } }
  return { key: reason === 'timeout' ? 'aih.test.failed.timeout' : 'aih.test.failed.other', tone: 'danger', params: { code: reason } }
}

const REFUSALS = ['account_paused', 'account_disabled', 'circuit_open', 'rate_limited', 'gateway_unavailable', 'fake_in_production'] as const
const isKnownRefusal = (code: string): boolean => (REFUSALS as readonly string[]).includes(code)

/** Why Test or Reconnect is held for an account, a key (null: it may run). */
export function testHeldKey(account: { status: 'ACTIVE' | 'PAUSED' | 'DISABLED'; mode: 'LIVE' | 'SANDBOX' | 'FAKE'; provider: string }, reconnect: boolean, canManage: boolean): string | null {
  if (!canManage) return 'aih.test.held.right'
  if (account.status === 'DISABLED') return 'aih.test.held.disabled'
  if (reconnect && account.status === 'PAUSED') return 'aih.test.held.paused'
  if (account.mode !== 'FAKE' && account.provider !== 'ECB') return 'aih.test.held.noProbe'
  return null
}
