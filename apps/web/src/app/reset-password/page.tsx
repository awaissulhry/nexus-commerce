'use client'

/** Phase S3 — set a new password from a reset link (?token). */

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { AuthCard } from '../_auth/AuthCard'

function ResetInner() {
  const router = useRouter()
  const token = useSearchParams().get('token') ?? ''
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/auth/password/reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Could not reset password.')
        setBusy(false)
        return
      }
      router.replace('/login?reset=1')
    } catch {
      setError('Could not reach the server. Try again.')
      setBusy(false)
    }
  }

  if (!token) {
    return <AuthCard title="Invalid link" subtitle="This reset link is missing its token."><a href="/forgot-password" className="block w-full rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white">Request a new link</a></AuthCard>
  }

  return (
    <AuthCard title="Set a new password" subtitle="Choose a strong password (12+ characters).">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">New password</span>
          <input type="password" required autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
        </label>
        <button type="submit" disabled={busy} className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </AuthCard>
  )
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<AuthCard title="Set a new password" subtitle="Loading…"><div /></AuthCard>}><ResetInner /></Suspense>
}
