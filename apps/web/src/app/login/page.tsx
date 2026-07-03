'use client'

/**
 * Phase S3 — sign-in page. Standalone (no app chrome). Fetches a CSRF
 * token, posts credentials, and on success refreshes the auth context and
 * routes to ?next (or the dashboard). Cookie-based — nothing is stored
 * client-side except the in-memory CSRF token.
 */

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { installAuthFetch } from '@/lib/auth/install-fetch'
import { setCsrfToken } from '@/lib/auth/csrf-store'
import { useAuth } from '@/lib/auth/AuthProvider'
import { AuthCard } from '../_auth/AuthCard'

function LoginInner() {
  const router = useRouter()
  const params = useSearchParams()
  const { refresh } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [mfaStep, setMfaStep] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    installAuthFetch()
    const base = getBackendUrl()
    try {
      const csrf = await fetch(`${base}/api/auth/csrf`, { credentials: 'include' }).then((r) => r.json())
      setCsrfToken(csrf.csrfToken)
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-nexus-csrf': csrf.csrfToken },
        body: JSON.stringify({ email, password, ...(mfaStep ? { code } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      // Password OK, but this account has 2FA — ask for the code.
      if (res.ok && data.mfaRequired) {
        setMfaStep(true)
        setBusy(false)
        return
      }
      if (!res.ok) {
        setError(data.error || 'Sign in failed.')
        setBusy(false)
        return
      }
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      await refresh()
      const next = params.get('next')
      router.replace(next && next.startsWith('/') ? next : '/dashboard/overview')
    } catch {
      setError('Could not reach the server. Try again.')
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Sign in to Nexus" subtitle={mfaStep ? 'Enter your authentication code.' : 'Enter your credentials to continue.'}>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {!mfaStep ? (
          <>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Email</span>
              <input
                type="email" autoComplete="username" required value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Password</span>
              <input
                type="password" autoComplete="current-password" required value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
          </>
        ) : (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Authentication code</span>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code}
              onChange={(e) => setCode(e.target.value)} placeholder="6-digit code or recovery code"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm tracking-widest outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <span className="mt-1 block text-xs text-slate-500">From your authenticator app, or a one-time recovery code.</span>
          </label>
        )}
        <button
          type="submit" disabled={busy}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? 'Working…' : mfaStep ? 'Verify' : 'Sign in'}
        </button>
        {!mfaStep && (
          <div className="text-center">
            <a href="/forgot-password" className="text-sm text-blue-600 hover:underline">Forgot password?</a>
          </div>
        )}
      </form>
    </AuthCard>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<AuthCard title="Sign in to Nexus" subtitle="Loading…"><div /></AuthCard>}>
      <LoginInner />
    </Suspense>
  )
}
