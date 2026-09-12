'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Banner, Card, Field } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useAuth } from '@/lib/auth/AuthProvider'
import { installAuthFetch } from '@/lib/auth/install-fetch'
import { setCsrfToken } from '@/lib/auth/csrf-store'
import '../profiles/profiles.css'

type Preview = { email: string; name: string; roleNames: string[]; expiresAt: string; signInRequired: boolean }
const STORAGE_KEY = 'nexus.pending-workspace-invitation'
export default function AcceptWorkspaceInvitation() {
  const { status, user } = useAuth()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const token = useRef('')
  const inFlight = useRef(false)
  useEffect(() => {
    installAuthFetch()
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? new URLSearchParams(window.location.search).get('token')
    try { token.current = fragment ?? sessionStorage.getItem(STORAGE_KEY) ?? ''; if (fragment) { sessionStorage.setItem(STORAGE_KEY, fragment); history.replaceState(null, '', window.location.pathname) } }
    catch { token.current = fragment ?? '' }
    let alive = true
    fetch(`${getBackendUrl()}/api/auth/workspace-invitations/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.current }) }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); if (alive) setPreview(data) }).catch(err => { if (alive) setError(err.message ?? 'This invitation could not be opened.') })
    return () => { alive = false }
  }, [])
  const matching = status === 'authed' && user?.email.toLowerCase() === preview?.email.toLowerCase()
  async function accept(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try {
      const csrf = await fetch(`${getBackendUrl()}/api/auth/csrf`).then(response => response.json())
      setCsrfToken(csrf.csrfToken)
      const response = await fetch(`${getBackendUrl()}/api/auth/workspace-invitations/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.current, displayName, password }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'The invitation could not be accepted.')
      try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* private browsing */ }
      window.location.assign(`/w/${data.workspaceId}/dashboard/overview`)
    } catch (err) { setError(err instanceof Error ? err.message : 'The invitation could not be accepted.'); setBusy(false); inFlight.current = false }
  }
  return <div className="business-profiles"><Card header={preview ? `Join ${preview.name}` : 'Business invitation'} description={preview ? `${preview.email} · ${preview.roleNames.join(' · ')}` : undefined}>
    <form onSubmit={accept} className="business-profile-form">
      {error && <Banner tone="danger">{error}</Banner>}
      {!preview && !error && <p role="status">Opening invitation…</p>}
      {preview && status !== 'loading' && <>
        {!matching && status === 'authed' ? <><p>This invitation is for {preview.email}. Switch your login to continue.</p><Button disabled={busy} onClick={async () => { setBusy(true); const response = await fetch(`${getBackendUrl()}/api/auth/logout`, { method: 'POST' }); if (response.ok) window.location.assign('/accept-workspace-invite'); else { setError('Sign out could not be completed. Try again.'); setBusy(false) } }}>Use the invited login</Button></> : !matching && preview.signInRequired ? <><p>Sign in as {preview.email} to join this business profile.</p><Button variant="primary" asChild><a href="/login?next=%2Faccept-workspace-invite">Sign in to accept</a></Button></> : <>
          {!matching && <><Field label="Your name" required><Input required minLength={2} maxLength={100} autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={busy} /></Field><Field label="Create a password" required hint="Use at least 12 characters and an uncommon passphrase."><Input type="password" required minLength={12} maxLength={512} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></Field></>}
          <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Joining…' : 'Accept invitation'}</Button>
        </>}
      </>}
    </form>
  </Card></div>
}
