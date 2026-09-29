/**
 * MCP.6 — Connected apps: the Claude connections that reach Nexus, and ending them. One section,
 * two places: a person's own (/settings/security) and a business's, for whoever manages its
 * sessions (Team & Access). The routes are apps/api/src/routes/oauth-grants.routes.ts.
 *
 * The installed fetch (lib/auth/install-fetch.ts) adds the session, the CSRF token and the
 * business from the page URL, so these calls carry nothing of their own.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type ConnectedAppsScope = 'mine' | 'business'

export interface ConnectedApp {
  id: string
  appName: string
  /** Where the app returns after sign-in (claude.ai, localhost…). */
  appHosts: string[]
  businessId: string
  businessName: string
  scopes: Array<'nexus.read' | 'nexus.write'>
  createdAt: string
  lastUsedAt: string | null
  /** The business view only. `active` is false once the person has left the business. */
  person?: { name: string | null; email: string; active: boolean }
}

const PATHS: Record<ConnectedAppsScope, string> = {
  mine: '/api/settings/connected-apps',
  business: '/api/connected-apps',
}

type Request = (input: string, init?: RequestInit) => Promise<Response>

export type LoadResult =
  | { kind: 'ok'; enabled: boolean; grants: ConnectedApp[] }
  /** The viewer may not manage this business's connections: the section is not theirs to see. */
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }

export type RevokeResult = { kind: 'revoked' } | { kind: 'gone' } | { kind: 'error'; message: string }

async function body(response: Response): Promise<{ error?: unknown; code?: unknown; enabled?: unknown; grants?: unknown }> {
  return response.json().catch(() => ({}))
}

const sentence = (data: { error?: unknown }, fallback: string) =>
  typeof data.error === 'string' && data.error.trim() ? data.error : fallback

export async function loadConnectedApps(scope: ConnectedAppsScope, request: Request = fetch): Promise<LoadResult> {
  let response: Response
  try {
    response = await request(`${getBackendUrl()}${PATHS[scope]}`, { cache: 'no-store' })
  } catch {
    return { kind: 'error', message: 'Connected apps could not be loaded. Check your connection and try again.' }
  }
  const data = await body(response)
  if (response.status === 403 && data.code === 'forbidden') return { kind: 'forbidden' }
  if (!response.ok || !Array.isArray(data.grants)) {
    return { kind: 'error', message: sentence(data, `Connected apps could not be loaded (HTTP ${response.status}).`) }
  }
  return { kind: 'ok', enabled: data.enabled === true, grants: data.grants as ConnectedApp[] }
}

export async function revokeConnectedApp(scope: ConnectedAppsScope, id: string, request: Request = fetch): Promise<RevokeResult> {
  let response: Response
  try {
    response = await request(`${getBackendUrl()}${PATHS[scope]}/${encodeURIComponent(id)}/revoke`, { method: 'POST' })
  } catch {
    return { kind: 'error', message: 'The connection could not be revoked. Check your connection and try again.' }
  }
  if (response.ok) return { kind: 'revoked' }
  // Not found: it ended elsewhere (another tab, an admin, the app itself). Gone either way.
  if (response.status === 404) return { kind: 'gone' }
  return { kind: 'error', message: sentence(await body(response), `The connection could not be revoked (HTTP ${response.status}).`) }
}

export interface ConnectedAppsState {
  load: 'loading' | 'ready' | 'hidden' | 'failed'
  enabled: boolean
  grants: ConnectedApp[]
  loadError: string | null
  /** The connection the revoke dialog is asking about. */
  confirming: ConnectedApp | null
  revoking: boolean
  revokeError: string | null
  /** What the last revoke did, said once the row has gone. */
  notice: string | null
}

export type ConnectedAppsAction =
  | { type: 'reload' }
  | { type: 'loaded'; result: LoadResult }
  | { type: 'ask'; grant: ConnectedApp }
  | { type: 'cancel' }
  | { type: 'revoking' }
  | { type: 'revoked'; result: RevokeResult }

export const initialConnectedApps: ConnectedAppsState = {
  load: 'loading', enabled: false, grants: [], loadError: null, confirming: null, revoking: false, revokeError: null, notice: null,
}

export function connectedAppsReducer(state: ConnectedAppsState, action: ConnectedAppsAction): ConnectedAppsState {
  switch (action.type) {
    case 'reload':
      return { ...state, load: 'loading', loadError: null }
    case 'loaded': {
      const { result } = action
      if (result.kind === 'forbidden') return { ...initialConnectedApps, load: 'hidden' }
      if (result.kind === 'error') return { ...state, load: 'failed', loadError: result.message }
      return { ...state, load: 'ready', enabled: result.enabled, grants: result.grants, loadError: null }
    }
    case 'ask':
      return { ...state, confirming: action.grant, revokeError: null, notice: null }
    case 'cancel':
      return state.revoking ? state : { ...state, confirming: null, revokeError: null }
    case 'revoking':
      return state.confirming ? { ...state, revoking: true, revokeError: null } : state
    case 'revoked': {
      const grant = state.confirming
      if (!grant) return state
      const { result } = action
      if (result.kind === 'error') return { ...state, revoking: false, revokeError: result.message }
      return {
        ...state,
        grants: state.grants.filter((row) => row.id !== grant.id),
        confirming: null,
        revoking: false,
        revokeError: null,
        notice: result.kind === 'revoked'
          ? `${grant.appName} no longer has access to ${grant.businessName}.`
          : `That connection had already ended. ${grant.appName} has no access to ${grant.businessName}.`,
      }
    }
  }
}

/** Shown when Claude can connect at all, when there is something to end, or when there is news. */
export function sectionVisible(state: ConnectedAppsState): boolean {
  if (state.load === 'failed') return true
  return state.load === 'ready' && (state.enabled || state.grants.length > 0 || state.notice !== null)
}

/** Changes wait for the approval of the person who connected the app: "you" on their own page. */
export function accessWords(scopes: ConnectedApp['scopes'], scope: ConnectedAppsScope): string {
  if (scopes.includes('nexus.write')) return `Reads, and asks for changes ${scope === 'mine' ? 'you' : 'they'} approve`
  if (scopes.includes('nexus.read')) return 'Reads only'
  return 'No access'
}

export function personWords(person: NonNullable<ConnectedApp['person']>): string {
  return person.name ?? person.email
}

export const COPY: Record<ConnectedAppsScope, { description: string; empty: string }> = {
  mine: {
    description: 'Apps you allowed to work in Nexus as you. Each connection reaches one business, with your permissions there.',
    empty: 'When you connect Claude to a business, the connection is listed here, and you can end it at any time.',
  },
  business: {
    description: 'Apps that people connected to this business. Each works with the permissions of the person who connected it.',
    empty: 'When someone connects Claude to this business, the connection is listed here.',
  },
}

/** What ending this connection does, said before it is done. */
export function consequence(scope: ConnectedAppsScope, grant: ConnectedApp): string {
  if (scope === 'business' && grant.person) {
    const again = grant.person.active ? ` ${personWords(grant.person)} can connect it again later if their role still allows it.` : ''
    return `${grant.appName} will lose access to this business at once.${again}`
  }
  return `${grant.appName} will lose access to ${grant.businessName} at once. To use it there again, connect it again.`
}
