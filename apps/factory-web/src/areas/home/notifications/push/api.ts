import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { pushSchema, testSchema, type PushState, type TestAnswer } from './model'

/**
 * Push on this device's calls (B-W2b-388), on B-W2b-385's routes. Problems as `home-mywork` keys (the API's push refusals by their
 * issue path: push/UNAVAILABLE, push/TOO_MANY, body/endpoint, body/keys).
 */

export function fetchPush(api: ApiClient, signal?: AbortSignal): Promise<PushState> {
  return api.get('/notifications/push', { schema: pushSchema, signal })
}

export async function addDevice(api: ApiClient, device: { readonly label: string; readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } }): Promise<PushState & { deviceId: string }> {
  return api.post('/notifications/push/devices', { body: device, schema: pushSchema.extend({ deviceId: pushSchema.shape.devices.element.shape.id }), idempotencyKey: newIdempotencyKey() })
}

export function removeDevice(api: ApiClient, deviceId: string): Promise<PushState> {
  return api.request('DELETE', `/notifications/push/devices/${encodeURIComponent(deviceId)}`, { schema: pushSchema, idempotencyKey: newIdempotencyKey() })
}

export function testPush(api: ApiClient, deviceId: string | null): Promise<TestAnswer> {
  return api.post('/notifications/push/test', { body: deviceId ? { deviceId } : {}, schema: testSchema, idempotencyKey: newIdempotencyKey() })
}

export function pushProblem(error: unknown): string {
  if (error instanceof Error && error.message === 'push-denied') return 'push.problem.denied'
  if (error instanceof Error && error.message === 'push-browser') return 'push.problem.browser'
  if (!isApiError(error)) return 'push.problem.failed'
  const path = error.issues.map(issuePath).find((entry) => entry.startsWith('push/') || entry.startsWith('body/')) ?? ''
  if (path === 'push/UNAVAILABLE') return 'push.held.unavailable'
  if (path === 'push/TOO_MANY') return 'push.held.tooMany'
  if (path === 'body/endpoint' || path === 'body/keys') return 'push.problem.browser'
  if (error.kind === 'unavailable') return 'held.offline'
  if (error.kind === 'conflict') return 'push.problem.none'
  return 'push.problem.failed'
}
