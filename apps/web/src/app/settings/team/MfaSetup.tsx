'use client'

/**
 * Phase S5 — self-service 2FA enrolment for the CURRENT user.
 * Enrol (QR → verify → recovery codes), regenerate codes, or disable.
 * Calls /api/auth/2fa/* (operates on the signed-in user).
 */

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

const api = () => getBackendUrl()
async function jpost(path: string, body?: unknown) {
  const r = await fetch(`${api()}${path}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { ok: r.ok, data: await r.json().catch(() => ({})) as any }
}

export default function MfaSetup() {
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesRemaining: number } | null>(null)
  const [enrolling, setEnrolling] = useState<{ qrDataUrl: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { const r = await fetch(`${api()}/api/auth/2fa/status`, { credentials: 'include' }); if (r.ok) setStatus(await r.json()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { void load() }, [load])

  const start = async () => { setErr(null); setBusy(true); const { ok, data } = await jpost('/api/auth/2fa/enroll/start'); setBusy(false); if (ok) setEnrolling({ qrDataUrl: data.qrDataUrl, secret: data.secret }); else setErr(data.error || 'Could not start enrolment') }
  const verify = async () => { setErr(null); setBusy(true); const { ok, data } = await jpost('/api/auth/2fa/enroll/verify', { code }); setBusy(false); if (ok) { setCodes(data.recoveryCodes); setEnrolling(null); setCode(''); void load() } else setErr(data.error || 'Code did not match') }
  const disable = async () => { const pw = prompt('Confirm your password to disable 2FA:'); if (pw == null) return; const { ok, data } = await jpost('/api/auth/2fa/disable', { password: pw }); if (ok) { setCodes(null); void load() } else setErr(data.error || 'Could not disable') }
  const regen = async () => { const pw = prompt('Confirm your password to regenerate recovery codes:'); if (pw == null) return; const { ok, data } = await jpost('/api/auth/2fa/recovery-codes', { password: pw }); if (ok) setCodes(data.recoveryCodes); else setErr(data.error || 'Could not regenerate') }

  return (
    <div className="mb-6 rounded-lg border border-default p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Your two-factor authentication</h2>
          <p className="text-xs text-slate-500">{status?.enabled ? `On · ${status.recoveryCodesRemaining} recovery codes left` : 'Add a second factor to protect your account.'}</p>
        </div>
        {status && !status.enabled && !enrolling && <button onClick={start} disabled={busy} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">Set up 2FA</button>}
        {status?.enabled && <div className="flex gap-2"><button onClick={regen} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">New recovery codes</button><button onClick={disable} className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600">Disable</button></div>}
      </div>

      {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      {enrolling && (
        <div className="mt-4 flex flex-wrap items-start gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrolling.qrDataUrl} alt="2FA QR code" width={160} height={160} className="rounded border border-default" />
          <div className="flex-1">
            <p className="text-sm text-slate-600">Scan with your authenticator app, or enter the key manually:</p>
            <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">{enrolling.secret}</code>
            <label className="mt-3 block"><span className="mb-1 block text-sm font-medium text-slate-700">Enter the 6-digit code</span><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" className="w-40 rounded-md border border-slate-300 px-3 py-2 text-sm tracking-widest" /></label>
            <div className="mt-3 flex gap-2"><button onClick={verify} disabled={busy || code.length < 6} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">Verify &amp; enable</button><button onClick={() => setEnrolling(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button></div>
          </div>
        </div>
      )}

      {codes && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">Save your recovery codes</p>
          <p className="text-xs text-amber-700">Each works once if you lose your device. They won't be shown again.</p>
          <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-slate-800 sm:grid-cols-5">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <button onClick={() => setCodes(null)} className="mt-2 text-xs text-blue-600 hover:underline">I've saved them</button>
        </div>
      )}
    </div>
  )
}
