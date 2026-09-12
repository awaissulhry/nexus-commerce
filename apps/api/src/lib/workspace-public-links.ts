import { workspaceContext, workspaceIdForQuery, LEGACY_WORKSPACE_ID, WorkspaceError } from './workspace-context.js'

/** The complete prefixed token is stored or authenticated by the issuing feature. */
export function scopePublicToken(token: string): string {
  const id = workspaceIdForQuery()
  return !id || id === LEGACY_WORKSPACE_ID ? token : `w.${id}.${token}`
}
export function publicTokenWorkspace(token: unknown): string {
  if (typeof token !== 'string' || token.length > 1000) throw new WorkspaceError('invalid_link', 'This link is invalid.', 404)
  if (!token.startsWith('w.')) return LEGACY_WORKSPACE_ID
  const match = /^w\.([a-zA-Z0-9_-]{8,100})\.(.+)$/.exec(token)
  if (!match) throw new WorkspaceError('invalid_link', 'This link is invalid.', 404)
  return match[1]
}
export function publicLinkSalt(): string {
  const id = workspaceContext()?.workspaceId
  return id && id !== LEGACY_WORKSPACE_ID ? `${id}:` : ''
}
