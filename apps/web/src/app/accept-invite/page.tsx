'use client'

/** Phase S3 — accept an invitation (?token): preview it, set a password,
 *  and get auto-signed-in. */

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { installAuthFetch } from '@/lib/auth/install-fetch'
import { setCsrfToken } from '@/lib/auth/csrf-store'
import { useAuth } from '@/lib/auth/AuthProvider'
import { AuthCard } from '../_auth/AuthCard'

function AcceptInner() {
  const router = useRouter()
  const { refresh } = useAuth()
  const token = useSearchParams().get('token') ?? ''
  const [preview, setPreview] = useState<{ email: string; roleName: string } | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) {
      setInvalid(true)
      return
    }
    const base = getBackendUrl()
    fetch(`${base}/api/auth/invitations/accept/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPreview({ email: d.email, roleName: d.roleName }))
      .catch(() => setInvalid(true))
  }, [token])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    installAuthFetch()
    try {
      const res = await fetch(`${getBackendUrl()}/api/auth/invitations/accept`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, displayName }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Could not accept the invitation.')
        setBusy(false)
        return
      }
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      await refresh()
      router.replace('/dashboard/overview')
    } catch {
      setError('Could not reach the server. Try again.')
      setBusy(false)
    }
  }

  if (invalid) {
    return <AuthCard title="Invalid invitation" subtitle="This invite is invalid or has expired."><a href="/login" className="block w-full rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white">Go to sign in</a></AuthCard>
  }
  if (!preview) {
    return <AuthCard title="Accept invitation" subtitle="Loading…"><div /></AuthCard>
  }

  return (
    <AuthCard title="Accept your invitation" subtitle={`Joining as ${preview.roleName} · ${preview.email}`}>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Your name</span>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Password</span>
          <input type="password" required autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
        </label>
        <button type="submit" disabled={busy} className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? 'Setting up…' : 'Accept & sign in'}
        </button>
      </form>
    </AuthCard>
  )
}

export default function AcceptInvitePage() {
  return <Suspense fallback={<AuthCard title="Accept invitation" subtitle="Loading…"><div /></AuthCard>}><AcceptInner /></Suspense>
}
