'use client'

/** Phase S3 — request a password reset link. Always shows the same
 *  confirmation (no account enumeration). */

import { useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { AuthCard } from '../_auth/AuthCard'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/auth/password/reset-request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } catch {
      /* ignore — response is uniform anyway */
    }
    setSent(true)
    setBusy(false)
  }

  if (sent) {
    return (
      <AuthCard title="Check your email" subtitle="If an account exists for that address, a reset link is on its way.">
        <a href="/login" className="block w-full rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700">
          Back to sign in
        </a>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link to set a new one.">
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Email</span>
          <input
            type="email" required autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <button type="submit" disabled={busy} className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
        <div className="text-center">
          <a href="/login" className="text-sm text-blue-600 hover:underline">Back to sign in</a>
        </div>
      </form>
    </AuthCard>
  )
}
