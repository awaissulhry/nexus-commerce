'use client'

/**
 * Settings rebuild — Phase C.6 + C.7
 *
 * /settings/security — 2FA enroll/disable + recovery codes + active
 * sessions + login history.
 *
 * 2FA flow:
 *   1. Click "Enable 2FA" → POST /api/settings/2fa/enroll/start
 *      returns { secret, otpauth, qrDataUrl }
 *   2. Operator scans the QR in their authenticator app
 *   3. Enters the 6-digit code → POST /api/settings/2fa/enroll/verify
 *      returns { recoveryCodes: 10 strings } — shown ONCE
 *   4. Operator downloads / prints the codes; we don't store the
 *      plaintext anywhere
 *
 * Disable requires the current password as a step-up check.
 *
 * Sessions + login history are read-only until Phase I wires the
 * session middleware. Empty states explain the gap honestly.
 */

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Loader2,
  Copy,
  Download,
  AlertCircle,
  Check,
  RefreshCw,
  LogOut,
  History,
  Eye,
  EyeOff,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface TwoFactorStatus {
  enabled: boolean
  enrolledAt: string | null
  recoveryCodesRemaining: number
}

interface SessionRow {
  id: string
  tokenPrefix: string
  userAgent: string | null
  ipAddress: string | null
  ipCity: string | null
  ipCountry: string | null
  createdAt: string
  lastSeenAt: string
  revokedAt: string | null
}

interface LoginEventRow {
  id: string
  outcome: string
  userAgent: string | null
  ipAddress: string | null
  ipCity: string | null
  ipCountry: string | null
  emailTried: string | null
  createdAt: string
}

interface Props {
  twoFactor: TwoFactorStatus
  sessions: SessionRow[]
  loginEvents: LoginEventRow[]
  initialError: string | null
}

export default function SecurityClient({
  twoFactor,
  sessions,
  loginEvents,
  initialError,
}: Props) {
  return (
    <div className="max-w-3xl space-y-6">
      {initialError && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{initialError}</span>
        </div>
      )}
      <TwoFactorSection initial={twoFactor} />
      <SessionsSection initial={sessions} />
      <LoginHistorySection initial={loginEvents} />
    </div>
  )
}

// ─── 2FA section ─────────────────────────────────────────────────

type EnrollState =
  | { kind: 'idle' }
  | {
      kind: 'qr'
      secret: string
      otpauth: string
      qrDataUrl: string
    }
  | { kind: 'codes'; codes: string[] }

function TwoFactorSection({ initial }: { initial: TwoFactorStatus }) {
  const router = useRouter()
  const [status, setStatus] = useState<TwoFactorStatus>(initial)
  const [enroll, setEnroll] = useState<EnrollState>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [code, setCode] = useState('')
  const [disablePw, setDisablePw] = useState('')
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const [showPw, setShowPw] = useState(false)

  const startEnroll = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/2fa/enroll/start`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setEnroll({
        kind: 'qr',
        secret: data.secret,
        otpauth: data.otpauth,
        qrDataUrl: data.qrDataUrl,
      })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const verifyEnroll = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/2fa/enroll/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code.trim() }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { recoveryCodes: string[] }
      setEnroll({ kind: 'codes', codes: data.recoveryCodes })
      setStatus({
        enabled: true,
        enrolledAt: new Date().toISOString(),
        recoveryCodesRemaining: data.recoveryCodes.length,
      })
      setCode('')
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [code, router])

  const regenerateCodes = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/2fa/recovery-codes/regenerate`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { recoveryCodes: string[] }
      setEnroll({ kind: 'codes', codes: data.recoveryCodes })
      setStatus((s) => ({ ...s, recoveryCodesRemaining: data.recoveryCodes.length }))
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [router])

  const disable = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/2fa/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePw }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setStatus({ enabled: false, enrolledAt: null, recoveryCodesRemaining: 0 })
      setDisablePw('')
      setShowDisableConfirm(false)
      setEnroll({ kind: 'idle' })
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [disablePw, router])

  // ── Render variants ───────────────────────────────────────────
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div
          className={cn(
            'shrink-0 w-8 h-8 rounded-md flex items-center justify-center',
            status.enabled
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
          )}
        >
          {status.enabled ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Two-factor authentication
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {status.enabled
              ? `Enabled${status.enrolledAt ? ' · since ' + new Date(status.enrolledAt).toLocaleDateString() : ''}`
              : 'Off — anyone with your password can sign in.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 mb-4">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {enroll.kind === 'codes' && (
        <RecoveryCodesPanel codes={enroll.codes} onDone={() => setEnroll({ kind: 'idle' })} />
      )}

      {enroll.kind === 'qr' && (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enroll.qrDataUrl}
              alt="2FA QR code"
              className="w-40 h-40 bg-white rounded border border-slate-200 dark:border-slate-700 shrink-0"
            />
            <div className="flex-1 min-w-0 space-y-2">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                Scan the QR with your authenticator (Google Authenticator,
                1Password, Authy, etc.), then enter the 6-digit code below.
              </p>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">
                  Or enter this secret manually
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <code className="px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 font-mono text-xs select-all break-all">
                    {enroll.secret}
                  </code>
                  <CopyButton text={enroll.secret} />
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 max-w-xs">
              <label
                htmlFor="totp-verify"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                6-digit code
              </label>
              <input
                id="totp-verify"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                className="w-full px-3 py-2 text-base font-mono tabular-nums border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="button"
              onClick={verifyEnroll}
              disabled={busy || code.length !== 6}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              Verify & enable
            </button>
            <button
              type="button"
              onClick={() => setEnroll({ kind: 'idle' })}
              disabled={busy}
              className="inline-flex items-center h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {enroll.kind === 'idle' && !status.enabled && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Adds a second layer of verification on every login. Use any
            TOTP-compatible app (Google Authenticator, 1Password, Authy,
            Bitwarden).
          </p>
          <button
            type="button"
            onClick={startEnroll}
            disabled={busy}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            <Smartphone size={13} />
            Enable 2FA
          </button>
        </div>
      )}

      {enroll.kind === 'idle' && status.enabled && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-600 dark:text-slate-400">
              {status.recoveryCodesRemaining} recovery code
              {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
            </span>
            <button
              type="button"
              onClick={regenerateCodes}
              disabled={busy}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Regenerate codes
            </button>
          </div>

          {!showDisableConfirm ? (
            <button
              type="button"
              onClick={() => setShowDisableConfirm(true)}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-rose-300 text-rose-700 dark:text-rose-300 dark:border-rose-800 text-sm font-medium hover:bg-rose-50 dark:hover:bg-rose-950/40"
            >
              <ShieldOff size={13} />
              Disable 2FA
            </button>
          ) : (
            <div className="rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-3 space-y-2">
              <div className="text-sm text-rose-800 dark:text-rose-300">
                Confirm with your password to disable 2FA.
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-xs">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={disablePw}
                    onChange={(e) => setDisablePw(e.target.value)}
                    autoComplete="current-password"
                    placeholder="Current password"
                    className="w-full pr-10 px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-rose-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={disable}
                  disabled={busy || disablePw.length === 0}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50"
                >
                  {busy && <Loader2 size={13} className="animate-spin" />}
                  Disable
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDisableConfirm(false)
                    setDisablePw('')
                  }}
                  disabled={busy}
                  className="inline-flex items-center h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function RecoveryCodesPanel({
  codes,
  onDone,
}: {
  codes: string[]
  onDone: () => void
}) {
  const text = codes.join('\n')
  const download = () => {
    const blob = new Blob([text + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nexus-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertCircle
          size={14}
          className="mt-0.5 text-amber-700 dark:text-amber-400 shrink-0"
        />
        <div>
          <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Save these recovery codes
          </h4>
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
            Each code can be used once if you lose access to your authenticator.
            We never show them again — copy or download them now.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {codes.map((c, i) => (
          <code
            key={i}
            className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 font-mono text-sm select-all tabular-nums text-slate-800 dark:text-slate-200"
          >
            {c}
          </code>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <CopyButton text={text} label="Copy all" />
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900 hover:bg-amber-100 dark:hover:bg-amber-950/60"
        >
          <Download size={12} /> Download .txt
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-1 h-7 px-3 rounded text-xs font-medium bg-amber-700 text-white hover:bg-amber-800"
        >
          <Check size={12} /> I've saved them
        </button>
      </div>
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* ignore — old browsers; the field is also select-all'able. */
        }
      }}
      className="inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label ?? (copied ? 'Copied' : 'Copy')}
    </button>
  )
}

// ─── Sessions ────────────────────────────────────────────────────

function SessionsSection({ initial }: { initial: SessionRow[] }) {
  const router = useRouter()
  const [rows, setRows] = useState(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const revoke = async (id: string) => {
    setError(null)
    setBusy(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/sessions/${id}/revoke`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setRows((r) =>
        r.map((s) =>
          s.id === id ? { ...s, revokedAt: new Date().toISOString() } : s,
        ),
      )
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const revokeAll = async () => {
    if (!window.confirm('Sign out of every device except this one?')) return
    setError(null)
    setBusy('all')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/sessions/revoke-all`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRows((r) =>
        r.map((s) => ({ ...s, revokedAt: s.revokedAt ?? new Date().toISOString() })),
      )
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const active = rows.filter((r) => !r.revokedAt)

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start justify-between gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Active sessions
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {active.length} active · {rows.length - active.length} revoked
          </p>
        </div>
        {active.length > 0 && (
          <button
            type="button"
            onClick={revokeAll}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <LogOut size={13} />
            Log out everywhere
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300 mb-3">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No tracked sessions yet"
          body="Sessions appear here once the auth middleware lands in Phase I. The data model is plumbed end-to-end so when login wires up, this list populates automatically."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <li
              key={s.id}
              className={cn(
                'flex items-start justify-between gap-3 p-3 rounded border',
                s.revokedAt
                  ? 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 opacity-70'
                  : 'border-slate-200 dark:border-slate-800',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-slate-900 dark:text-slate-100 font-medium truncate">
                  {s.userAgent ?? 'Unknown device'}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {[s.ipCity, s.ipCountry].filter(Boolean).join(', ') ||
                    s.ipAddress ||
                    '—'}{' '}
                  · last seen {new Date(s.lastSeenAt).toLocaleString()}
                </div>
              </div>
              {s.revokedAt ? (
                <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
                  revoked {new Date(s.revokedAt).toLocaleDateString()}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => revoke(s.id)}
                  disabled={busy === s.id || busy === 'all'}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy === s.id && <Loader2 size={11} className="animate-spin" />}
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── Login history ───────────────────────────────────────────────

const OUTCOME_STYLE: Record<string, string> = {
  success:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  bad_password:
    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
  totp_failed:
    'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
  recovery_code_used:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  locked:
    'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
}

function LoginHistorySection({ initial }: { initial: LoginEventRow[] }) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <History size={14} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Login history
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Last 30 attempts — success or failure, with IP and device.
          </p>
        </div>
      </div>

      {initial.length === 0 ? (
        <EmptyState
          title="No login attempts logged yet"
          body="Login attempts appear here once the auth middleware lands in Phase I. The LoginEvent table is plumbed; the writer is what's pending."
        />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {initial.map((e) => (
            <li key={e.id} className="py-2.5 flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide border',
                  OUTCOME_STYLE[e.outcome] ?? OUTCOME_STYLE.locked,
                )}
              >
                {e.outcome.replace(/_/g, ' ')}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-slate-900 dark:text-slate-100 truncate">
                  {e.userAgent ?? 'Unknown device'}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {[e.ipCity, e.ipCountry].filter(Boolean).join(', ') ||
                    e.ipAddress ||
                    '—'}{' '}
                  · {new Date(e.createdAt).toLocaleString()}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-950/40 p-6 text-center">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {title}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
        {body}
      </p>
    </div>
  )
}
