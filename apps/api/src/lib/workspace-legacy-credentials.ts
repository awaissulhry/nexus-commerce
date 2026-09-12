import { LEGACY_WORKSPACE_ID, workspaceIdForQuery, WorkspaceError } from './workspace-context.js'

/** Environment credentials were migrated with the original business only. */
export function requireLegacyCredentials(channel: string): void {
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1' && workspaceIdForQuery() !== LEGACY_WORKSPACE_ID) {
    throw new WorkspaceError('channel_connection_required', `${channel} requires a connection for this business profile.`, 409)
  }
}
