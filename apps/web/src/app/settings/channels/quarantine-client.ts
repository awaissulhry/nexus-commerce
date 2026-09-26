import { getBackendUrl } from '@/lib/backend-url'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'

export interface QuarantineScope { connectionId: string; workspaceId?: string | null }
export interface QuarantineNotice {
  id: string
  externalId: string
  topic: string
  environment: string
  receivedAt: string
  lastReceivedAt: string
  deliveries: number
  reason: string
}
export interface QuarantinePage { items: QuarantineNotice[]; nextCursor: string | null }
export class QuarantineRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

function requestScope(scope: QuarantineScope) {
  if (WORKSPACES_ENABLED && !scope.workspaceId) throw new Error('Choose a business profile before recovering notices.')
  if (!scope.connectionId) throw new Error('Choose an eBay account before recovering notices.')
  const headers: Record<string, string> = WORKSPACES_ENABLED && scope.workspaceId ? { 'x-nexus-workspace-id': scope.workspaceId } : {}
  return { base: `${getBackendUrl()}/api/cx/connections/${encodeURIComponent(scope.connectionId)}/ebay-quarantine`, headers }
}
async function responseBody(response: Response) {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error : 'The request could not be confirmed. Refresh before trying again.'
    throw new QuarantineRequestError(message, response.status)
  }
  return body
}

export async function readQuarantinePage(scope: QuarantineScope, after: string | null, signal: AbortSignal): Promise<QuarantinePage> {
  const { base, headers } = requestScope(scope)
  const query = new URLSearchParams({ take: '20' }); if (after) query.set('after', after)
  const body = await responseBody(await fetch(`${base}?${query}`, { headers, credentials: 'include', cache: 'no-store', signal }))
  if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items) || body.items.length > 50
    || !('nextCursor' in body) || (body.nextCursor !== null && typeof body.nextCursor !== 'string')
    || !body.items.every(row => row && typeof row === 'object' && ['id', 'externalId', 'topic', 'environment', 'receivedAt', 'lastReceivedAt', 'reason']
      .every(key => typeof row[key] === 'string') && row.id && row.externalId && row.topic === 'AUTHORIZATION_REVOCATION'
      && ['production', 'sandbox'].includes(row.environment) && Number.isFinite(Date.parse(row.receivedAt))
      && Number.isFinite(Date.parse(row.lastReceivedAt)) && Number.isSafeInteger(row.deliveries) && row.deliveries > 0)) {
    throw new Error('The matching notices could not be verified. Refresh before assigning any notice.')
  }
  return body as QuarantinePage
}

export async function assignQuarantineNotice(scope: QuarantineScope, noticeId: string, signal: AbortSignal): Promise<string> {
  const { base, headers } = requestScope(scope)
  const body = await responseBody(await fetch(`${base}/${encodeURIComponent(noticeId)}/adopt`, { method: 'POST', headers, credentials: 'include', signal }))
  if (!body || typeof body !== 'object' || !('assigned' in body) || body.assigned !== true
    || !('receiptId' in body) || typeof body.receiptId !== 'string' || !body.receiptId) {
    throw new Error('Assignment could not be confirmed. Refresh before trying again.')
  }
  return body.receiptId
}
