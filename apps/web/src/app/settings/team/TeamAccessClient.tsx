'use client'

/**
 * Phase S4 — Team & Access console.
 *
 * Owner/Admin surface to manage members, roles, permissions, and
 * invitations. Reads /api/team/* + /api/auth/invitations (credentialed via
 * the S3 fetch wrapper). Owner-supremacy guardrails are enforced server-side
 * (the API 409s); this UI surfaces the reason and confirms destructive acts.
 */

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { usePermission } from '@/lib/auth/AuthProvider'
import MfaSetup from './MfaSetup'

interface Role {
  id: string; key: string; name: string; description: string
  permissions: string[]; isSystem: boolean; isOwner: boolean; requireMfa: boolean; memberCount: number
}
interface UserRow {
  id: string; email: string; displayName: string; status: string
  lastLoginAt: string | null; mfaEnabled: boolean
  roles: { key: string; name: string }[]
}
interface Invite {
  id: string; email: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null
  role: { key: string; name: string }
}
interface CatalogGroup { module: string; label: string; layer: 'page' | 'feature' | 'field'; items: { key: string; label: string }[] }

const api = () => getBackendUrl()

async function jget<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`${api()}${path}`, { credentials: 'include', cache: 'no-store' }); return r.ok ? await r.json() : null } catch { return null }
}
async function jsend(path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${api()}${path}`, {
      method, credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const d = await r.json().catch(() => ({}))
    return { ok: r.ok, error: d?.error }
  } catch { return { ok: false, error: 'Network error' } }
}

const badge = (tone: 'green' | 'slate' | 'amber' | 'blue') =>
  ({ green: 'bg-green-50 text-green-700 border-green-200', slate: 'bg-slate-100 text-slate-600 border-default', amber: 'bg-amber-50 text-amber-700 border-amber-200', blue: 'bg-blue-50 text-blue-700 border-blue-200' }[tone])

export default function TeamAccessClient() {
  const canManage = usePermission('users.manage')
  const [tab, setTab] = useState<'users' | 'roles' | 'invites'>('users')
  const [users, setUsers] = useState<UserRow[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [catalog, setCatalog] = useState<CatalogGroup[]>([])
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [editRole, setEditRole] = useState<Role | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)

  const flash = (tone: 'ok' | 'err', text: string) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 5000) }

  const reload = useCallback(async () => {
    const [u, r, i, c] = await Promise.all([
      jget<{ users: UserRow[] }>('/api/team/users'),
      jget<{ roles: Role[] }>('/api/team/roles'),
      jget<{ invitations: Invite[] }>('/api/auth/invitations'),
      jget<{ groups: CatalogGroup[] }>('/api/team/roles/catalog'),
    ])
    if (u) setUsers(u.users); if (r) setRoles(r.roles); if (i) setInvites(i.invitations); if (c) setCatalog(c.groups)
  }, [])
  useEffect(() => { if (canManage) void reload() }, [canManage, reload])

  const act = async (path: string, method: string, body: unknown, okText: string) => {
    const res = await jsend(path, method, body)
    if (res.ok) { flash('ok', okText); await reload() } else { flash('err', res.error || 'Action failed') }
  }

  if (!canManage) {
    return <div className="mx-auto max-w-xl py-16 text-center"><h1 className="text-lg font-semibold text-slate-900">Access denied</h1><p className="mt-2 text-sm text-slate-500">You need the Manage users permission to view Team &amp; Access.</p></div>
  }

  const pendingInvites = invites.filter((i) => !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > new Date())

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Team &amp; Access</h1>
        <p className="mt-1 text-sm text-slate-500">Manage who has access, what they can do, and pending invitations.</p>
      </header>

      <MfaSetup />

      {msg && (
        <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${msg.tone === 'ok' ? badge('green') : 'border-red-200 bg-red-50 text-red-700'}`} role="alert">{msg.text}</div>
      )}

      <div className="mb-5 flex gap-1 border-b border-default">
        {([['users', `Members (${users.length})`], ['roles', `Roles (${roles.length})`], ['invites', `Invitations (${pendingInvites.length})`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{label}</button>
        ))}
      </div>

      {tab === 'users' && (
        <section>
          <div className="mb-3 flex justify-end">
            <button onClick={() => setInviteOpen(true)} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">Invite member</button>
          </div>
          <div className="overflow-hidden rounded-lg border border-default">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-2.5">Member</th><th className="px-4 py-2.5">Roles</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Last login</th><th className="px-4 py-2.5"></th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{u.displayName || u.email}</div><div className="text-xs text-slate-500">{u.email}{u.mfaEnabled && <span className="ml-2 text-green-600">· 2FA</span>}</div></td>
                    <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{u.roles.length ? u.roles.map((r) => <span key={r.key} className={`rounded border px-1.5 py-0.5 text-xs ${r.key === 'OWNER' ? badge('blue') : badge('slate')}`}>{r.name}</span>) : <span className="text-xs text-tertiary">No role</span>}</div></td>
                    <td className="px-4 py-3"><span className={`rounded border px-1.5 py-0.5 text-xs ${u.status === 'active' ? badge('green') : badge('amber')}`}>{u.status}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <UserActions user={u} roles={roles} onAssign={(rk) => act(`/api/team/users/${u.id}/roles`, 'POST', { roleKey: rk }, 'Role assigned')} onRemove={(rk) => act(`/api/team/users/${u.id}/roles/${rk}`, 'DELETE', undefined, 'Role removed')} onDeactivate={() => { if (confirm(`Deactivate ${u.email}? Their sessions end immediately.`)) act(`/api/team/users/${u.id}/deactivate`, 'POST', {}, 'User deactivated') }} onReactivate={() => act(`/api/team/users/${u.id}/reactivate`, 'POST', {}, 'User reactivated')} onSignout={() => act(`/api/team/users/${u.id}/force-signout`, 'POST', {}, 'Signed out everywhere')} onResetMfa={() => { if (confirm(`Reset 2FA for ${u.email}? They'll need to set it up again.`)) act(`/api/team/users/${u.id}/reset-mfa`, 'POST', {}, '2FA reset') }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'roles' && (
        <section className="space-y-3">
          <div className="flex justify-end">
            <button onClick={() => setEditRole({ id: '', key: '', name: '', description: '', permissions: [], isSystem: false, isOwner: false, requireMfa: false, memberCount: 0 })} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">New role</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.map((r) => (
              <div key={r.id} className="rounded-lg border border-default p-4">
                <div className="flex items-start justify-between">
                  <div><div className="flex items-center gap-2"><span className="font-medium text-slate-900">{r.name}</span>{r.isOwner && <span className={`rounded border px-1.5 py-0.5 text-xs ${badge('blue')}`}>System · locked</span>}{r.isSystem && !r.isOwner && <span className={`rounded border px-1.5 py-0.5 text-xs ${badge('slate')}`}>System</span>}</div><p className="mt-1 text-xs text-slate-500">{r.description}</p></div>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>{r.isOwner ? 'All permissions' : `${r.permissions.length} permissions`} · {r.memberCount} member{r.memberCount === 1 ? '' : 's'}</span>
                  <div className="flex gap-2">
                    <button onClick={() => setEditRole(r)} className="text-blue-600 hover:underline">{r.isOwner ? 'View' : 'Edit'}</button>
                    {!r.isSystem && <button onClick={() => { if (confirm(`Delete role "${r.name}"?`)) act(`/api/team/roles/${r.id}`, 'DELETE', undefined, 'Role deleted') }} className="text-red-600 hover:underline">Delete</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'invites' && (
        <section>
          <div className="overflow-hidden rounded-lg border border-default">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Email</th><th className="px-4 py-2.5">Role</th><th className="px-4 py-2.5">Expires</th><th className="px-4 py-2.5"></th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {pendingInvites.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-tertiary">No pending invitations.</td></tr>}
                {pendingInvites.map((i) => (
                  <tr key={i.id}><td className="px-4 py-3 text-slate-900">{i.email}</td><td className="px-4 py-3 text-slate-600">{i.role.name}</td><td className="px-4 py-3 text-xs text-slate-500">{new Date(i.expiresAt).toLocaleString()}</td><td className="px-4 py-3 text-right"><button onClick={() => { if (confirm(`Revoke the invitation for ${i.email}?`)) act(`/api/auth/invitations/${i.id}/revoke`, 'POST', {}, 'Invitation revoked') }} className="text-red-600 hover:underline">Revoke</button></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {inviteOpen && <InviteModal roles={roles.filter((r) => !r.isOwner || true)} onClose={() => setInviteOpen(false)} onDone={(link) => { setInviteOpen(false); flash('ok', link ? 'Invitation created — link copied to clipboard.' : 'Invitation created.'); void reload() }} />}
      {editRole && <RoleEditor role={editRole} catalog={catalog} onClose={() => setEditRole(null)} onSaved={() => { setEditRole(null); flash('ok', 'Role saved.'); void reload() }} onError={(e) => flash('err', e)} />}
    </div>
  )
}

function UserActions({ user, roles, onAssign, onRemove, onDeactivate, onReactivate, onSignout, onResetMfa }: { user: UserRow; roles: Role[]; onAssign: (rk: string) => void; onRemove: (rk: string) => void; onDeactivate: () => void; onReactivate: () => void; onSignout: () => void; onResetMfa: () => void }) {
  const [open, setOpen] = useState(false)
  const assignable = roles.filter((r) => !user.roles.some((ur) => ur.key === r.key))
  return (
    <div className="relative inline-block text-left">
      <button onClick={() => setOpen((o) => !o)} className="rounded border border-default px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">Manage ▾</button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-default bg-white py-1 text-sm shadow-lg" onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-1 text-xs font-medium uppercase text-tertiary">Assign role</div>
          {assignable.length ? assignable.map((r) => <button key={r.key} onClick={() => { onAssign(r.key); setOpen(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-slate-50">{r.name}</button>) : <div className="px-3 py-1 text-xs text-tertiary">All roles assigned</div>}
          {user.roles.length > 0 && <><div className="mt-1 border-t border-subtle px-3 py-1 text-xs font-medium uppercase text-tertiary">Remove role</div>{user.roles.map((r) => <button key={r.key} onClick={() => { onRemove(r.key); setOpen(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-slate-50">{r.name}</button>)}</>}
          <div className="mt-1 border-t border-subtle" />
          <button onClick={() => { onSignout(); setOpen(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-slate-50">Force sign-out</button>
          {user.mfaEnabled && <button onClick={() => { onResetMfa(); setOpen(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-slate-50">Reset 2FA</button>}
          {user.status === 'active' ? <button onClick={() => { onDeactivate(); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50">Deactivate</button> : <button onClick={() => { onReactivate(); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-green-700 hover:bg-green-50">Reactivate</button>}
        </div>
      )}
    </div>
  )
}

function InviteModal({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: (link: boolean) => void }) {
  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${api()}/api/auth/invitations`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, roleKey }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(d?.error || 'Failed to create invitation'); setBusy(false); return }
      let copied = false
      if (d.link) { try { await navigator.clipboard.writeText(d.link); copied = true } catch { /* ignore */ } }
      onDone(copied)
    } catch { setErr('Network error'); setBusy(false) }
  }
  return (
    <Modal title="Invite a member" onClose={onClose}>
      {err && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      <label className="mb-3 block"><span className="mb-1 block text-sm font-medium text-slate-700">Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" /></label>
      <label className="mb-4 block"><span className="mb-1 block text-sm font-medium text-slate-700">Role</span><select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
      <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button><button disabled={busy || !email || !roleKey} onClick={submit} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Sending…' : 'Send invite'}</button></div>
    </Modal>
  )
}

function RoleEditor({ role, catalog, onClose, onSaved, onError }: { role: Role; catalog: CatalogGroup[]; onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const isNew = role.id === ''
  const readOnly = role.isOwner
  const [name, setName] = useState(role.name)
  const [description, setDescription] = useState(role.description)
  const [perms, setPerms] = useState<Set<string>>(new Set(role.permissions))
  const [busy, setBusy] = useState(false)
  const toggle = (k: string) => setPerms((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })
  const save = async () => {
    setBusy(true)
    const body = { name, description, permissions: [...perms] }
    const res = isNew
      ? await jsend('/api/team/roles', 'POST', body)
      : await jsend(`/api/team/roles/${role.id}`, 'PATCH', body)
    setBusy(false)
    if (res.ok) onSaved(); else onError(res.error || 'Save failed')
  }
  return (
    <Modal title={isNew ? 'New role' : role.isOwner ? `${role.name} (system)` : `Edit ${role.name}`} onClose={onClose} wide>
      {readOnly && <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">The Owner role holds every permission implicitly and is system-protected — it can't be edited.</div>}
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Name</span><input disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50" /></label>
        <label className="block"><span className="mb-1 block text-sm font-medium text-slate-700">Description</span><input disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50" /></label>
      </div>
      <div className="mt-4 max-h-[50vh] space-y-4 overflow-auto pr-1">
        {catalog.map((g) => (
          <div key={g.layer + g.label}>
            <div className="mb-1.5 flex items-center gap-2"><span className="text-xs font-semibold uppercase text-slate-500">{g.label}</span>{g.layer === 'field' && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${badge('amber')}`}>Financial data</span>}</div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {g.items.map((it) => (
                <label key={it.key} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-sm ${perms.has(it.key) ? 'border-blue-200 bg-blue-50' : 'border-default'} ${readOnly ? 'opacity-60' : 'cursor-pointer'}`}>
                  <input type="checkbox" disabled={readOnly} checked={readOnly ? true : perms.has(it.key)} onChange={() => toggle(it.key)} />
                  <span className="text-slate-700">{it.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!readOnly && <div className="mt-4 flex justify-end gap-2"><button onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button><button disabled={busy || !name} onClick={save} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Saving…' : 'Save role'}</button></div>}
    </Modal>
  )
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-xl bg-white p-5 shadow-xl`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-base font-semibold text-slate-900">{title}</h2><button onClick={onClose} className="text-tertiary hover:text-slate-600">✕</button></div>
        {children}
      </div>
    </div>
  )
}
