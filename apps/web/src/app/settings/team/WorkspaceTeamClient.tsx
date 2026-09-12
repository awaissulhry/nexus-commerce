'use client'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Banner, Card, Field, Modal } from '@/design-system/components'
import { Button, Checkbox, Input, Select } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { browserWorkspaceId } from '@/lib/workspaces/paths'
import { useProfileScope } from '@/app/_shared/ProfileScope'
import { permissionCatalog } from '@nexus/shared/permissions'
import '../../profiles/profiles.css'

type Role = { id: string; key: string; name: string; description: string; permissions: string[]; isSystem: boolean; version: number }
type Member = { id: string; status: 'active' | 'revoked'; version: number; user: { displayName: string; email: string }; roles: { role: Role }[] }
type Invitation = { id: string; email: string; roleIds: string[]; expiresAt: string }
type Roster = { members: Member[]; roles: Role[]; invitations: Invitation[] }
async function requestTeam(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${getBackendUrl()}/api/workspaces/${browserWorkspaceId()}${path}`, body === undefined ? { cache: 'no-store' } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? 'The team could not be updated.')
  return data
}
export default function WorkspaceTeamClient() {
  const { activeProfile } = useProfileScope()
  const [roster, setRoster] = useState<Roster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Member | 'invite' | null>(null)
  const [invitationLink, setInvitationLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [editingRole, setEditingRole] = useState<Role | 'new' | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try { setRoster(await requestTeam('/members')) }
    catch (err) { setError(err instanceof Error ? err.message : 'The team could not be loaded.') }
  }, [])
  useEffect(() => { void load() }, [load])
  async function revoke(invitation: Invitation) {
    if (revoking) return
    setRevoking(invitation.id)
    try { await requestTeam(`/invitations/${invitation.id}/revoke`, {}); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'The invitation could not be revoked.') }
    finally { setRevoking(null) }
  }
  return <div className="business-profiles">
    <header className="business-profiles-heading"><div><h2>{activeProfile?.name ?? 'Business team'}</h2><p>Roles apply within this business.</p></div><Button variant="primary" disabled={!roster} onClick={() => setEditing('invite')}>Invite member</Button></header>
    {error && <Banner tone="danger" action={<Button onClick={() => { void load() }}>Retry</Button>}>{error}</Banner>}
    {invitationLink && <Card header="Invitation ready" description="Share this private link with the invited person. It expires in 7 days."><div className="business-profile-form"><Field label="Invitation link"><Input readOnly value={invitationLink} onFocus={event => event.target.select()} /></Field><Button onClick={async () => { try { await navigator.clipboard.writeText(invitationLink); setCopied(true) } catch { setError('Select and copy the invitation link above.') } }}>{copied ? 'Copied' : 'Copy invitation link'}</Button></div></Card>}
    {!roster && !error && <p role="status">Loading team…</p>}
    {roster?.members.map(member => <Card key={member.id} header={member.user.displayName || member.user.email} description={`${member.user.email} · ${member.status === 'active' ? member.roles.map(({ role }) => role.name).join(' · ') : 'Access removed'}`} headerAction={<Button onClick={() => setEditing(member)}>Manage access</Button>} />)}
    {!!roster?.invitations.length && <h2>Pending invitations</h2>}
    {roster?.invitations.map(invitation => <Card key={invitation.id} header={invitation.email} description={`Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`} headerAction={<Button variant="danger-outline" disabled={revoking !== null} onClick={() => { void revoke(invitation) }}>{revoking === invitation.id ? 'Revoking…' : 'Revoke invitation'}</Button>} />)}
    {roster && <><div className="business-profiles-heading"><h2>Business roles</h2><Button onClick={() => setEditingRole('new')}>Create role</Button></div>{roster.roles.map(role => <Card key={role.id} header={role.name} description={role.isSystem ? 'Built-in role' : role.description || 'Custom role for this business'} headerAction={!role.isSystem && <Button onClick={() => setEditingRole(role)}>Edit permissions</Button>} />)}</>}
    {editingRole && <RoleEditor role={editingRole} onClose={() => setEditingRole(null)} onSaved={async () => { await load(); setEditingRole(null) }} />}
    {editing && roster && <MemberEditor member={editing} roles={roster.roles} onClose={() => setEditing(null)} onSaved={async data => { if (data?.token) { setInvitationLink(`${window.location.origin}/accept-workspace-invite#token=${encodeURIComponent(data.token)}`); setCopied(false) } await load(); setEditing(null) }} />}
  </div>
}

function RoleEditor({ role, onClose, onSaved }: { role: Role | 'new'; onClose: () => void; onSaved: () => Promise<void> }) {
  const formId = useId()
  const [name, setName] = useState(role === 'new' ? '' : role.name)
  const [description, setDescription] = useState(role === 'new' ? '' : role.description)
  const [permissions, setPermissions] = useState<string[]>(role === 'new' ? [] : role.permissions)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try { await requestTeam(role === 'new' ? '/roles' : `/roles/${role.id}`, { name, description, permissions, ...(role === 'new' ? {} : { version: role.version }) }, role === 'new' ? 'POST' : 'PATCH'); await onSaved() }
    catch (err) { setError(err instanceof Error ? err.message : 'The role could not be saved.'); setBusy(false); inFlight.current = false }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={role === 'new' ? 'Create business role' : `Edit ${role.name}`} size="lg" subtitle="Members receive the combined permissions of their roles within this business." footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Save role'}</Button></>}>
    <form id={formId} onSubmit={submit} className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Role name" required><Input data-autofocus required minLength={2} maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field>
      <Field label="Description"><Input maxLength={500} value={description} onChange={event => setDescription(event.target.value)} disabled={busy} /></Field>
      <Field label="Find permissions" hint={`${permissions.length} selected`}><Input value={query} onChange={event => setQuery(event.target.value)} /></Field>
      {permissionCatalog().map(group => {
        const items = group.items.filter(item => `${group.label} ${item.label} ${item.key}`.toLowerCase().includes(query.toLowerCase()))
        return items.length ? <fieldset key={`${group.layer}:${group.label}`} className="business-profile-form"><legend>{group.label} · {group.layer === 'page' ? 'Pages' : group.layer === 'field' ? 'Data visibility' : 'Actions'}</legend>{items.map(item => <Checkbox key={item.key} label={item.label} checked={permissions.includes(item.key)} disabled={busy} onChange={event => setPermissions(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />)}</fieldset> : null
      })}
    </form>
  </Modal>
}
function MemberEditor({ member, roles, onClose, onSaved }: { member: Member | 'invite'; roles: Role[]; onClose: () => void; onSaved: (data: { token?: string }) => Promise<void> }) {
  const formId = useId()
  const inviting = member === 'invite'
  const [email, setEmail] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>(inviting ? [] : member.roles.map(({ role }) => role.id))
  const [status, setStatus] = useState(inviting ? 'active' : member.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    if (roleIds.length === 0) { setError('Choose at least one role.'); return }
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const data = inviting ? await requestTeam('/invitations', { email, roleIds }) : await requestTeam(`/members/${member.id}`, { roleIds, status, version: member.version }, 'PATCH')
      await onSaved(data)
    } catch (err) { setError(err instanceof Error ? err.message : 'Access could not be saved.'); setBusy(false); inFlight.current = false }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={inviting ? 'Invite a team member' : `Manage ${member.user.displayName || member.user.email}`} subtitle="Permissions apply only to this business profile." footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : inviting ? 'Create invitation' : 'Save access'}</Button></>}>
    <form id={formId} onSubmit={submit} className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      {inviting && <Field label="Email address" required><Input data-autofocus type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={busy} autoComplete="email" /></Field>}
      <fieldset className="business-profile-form"><legend>Business roles</legend>{roles.map(role => <Checkbox key={role.id} label={role.name} checked={roleIds.includes(role.id)} disabled={busy} onChange={event => setRoleIds(current => event.target.checked ? [...current, role.id] : current.filter(id => id !== role.id))} />)}</fieldset>
      {!inviting && <Field label="Access"><Select value={status} disabled={busy} onChange={event => setStatus(event.target.value as 'active' | 'revoked')}><option value="active">Active</option><option value="revoked">Remove access to this profile</option></Select></Field>}
    </form>
  </Modal>
}
