/**
 * Phase S4 — Settings › Team & Access console.
 * Thin server shell; the client component drives everything (users, roles,
 * invitations) against the /api/team + /api/auth/invitations endpoints.
 */
import TeamAccessClient from './TeamAccessClient'
import WorkspaceTeamClient from './WorkspaceTeamClient'

export const dynamic = 'force-dynamic'

export default function SettingsTeamPage() {
  return process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1' ? <WorkspaceTeamClient /> : <TeamAccessClient />
}
