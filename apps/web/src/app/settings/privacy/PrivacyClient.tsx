'use client'

/**
 * Settings rebuild — Phase H.4
 *
 * /settings/privacy. Four cards:
 *
 *   1. Export workspace data — one-click JSON dump + history of past
 *      exports with re-download (server regenerates idempotently;
 *      links auto-expire after 7 days).
 *   2. Data retention — per-data-type retention windows. Orders are
 *      floor-locked at 7y for IT fiscal compliance.
 *   3. Consent log — DPA / TOS / cookie / marketing toggles. Each
 *      change appends a new row (append-only audit).
 *   4. Delete account — dry-run only in this phase. Lists the
 *      cascade preview; honest that real destruction belongs to
 *      Phase I when multi-user auth lands.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  Cookie,
  Download,
  FileDown,
  History,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Slash,
  Trash2,
  AlertTriangle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface ExportRow {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | string
  format: string
  scope: string[]
  bytes: number | null
  expiresAt: string | null
  downloadUrl: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

export interface RetentionState {
  policies: Record<string, number>
  floors: Record<string, number>
  ceilings: Record<string, number>
  defaults: Record<string, number>
}

export interface ConsentLatest {
  [kind: string]: { accepted: boolean; version: string; at: string }
}

interface Props {
  initialExports: ExportRow[]
  initialRetention: RetentionState | null
  initialConsent: ConsentLatest
  initialError: string | null
}

// Canonical consent kinds + their current version. Bump the version
// when the underlying document changes; the consent log will surface
// "you accepted v2026-05 on …" so audits can prove what was current.
const CONSENT_KINDS = [
  {
    kind: 'DPA',
    label: 'Data Processing Agreement',
    description:
      'Required for any business processing personal data on your behalf via this workspace.',
    version: 'v2026-05',
  },
  {
    kind: 'TOS',
    label: 'Terms of service',
    description: 'Updated when material terms change. Re-accept on bump.',
    version: 'v2026-05',
  },
  {
    kind: 'PRIVACY_POLICY',
    label: 'Privacy policy',
    description: 'Acknowledges how we process workspace data.',
    version: 'v2026-05',
  },
  {
    kind: 'COOKIE_ANALYTICS',
    label: 'Analytics cookies',
    description:
      'Anonymised usage telemetry — feature pickup, page-load timings.',
    version: 'v2026-05',
  },
  {
    kind: 'COOKIE_MARKETING',
    label: 'Marketing cookies',
    description: 'Targeting + remarketing pixels. Off by default.',
    version: 'v2026-05',
  },
  {
    kind: 'MARKETING_EMAIL',
    label: 'Marketing emails',
    description: 'Product updates, release notes, the occasional roadmap nudge.',
    version: 'v2026-05',
  },
] as const

const RETENTION_LABELS: Record<string, { label: string; description: string }> = {
  orders: {
    label: 'Orders',
    description: 'Pinned at 7 years minimum by Italian fiscal law.',
  },
  auditLog: {
    label: 'Audit log',
    description: 'Settings changes, bulk-op trail, security events.',
  },
  loginEvents: {
    label: 'Login history',
    description: 'Per-attempt success/failure log with IP + UA.',
  },
  webhookEvents: {
    label: 'Inbound webhook events',
    description: 'Channel-to-Nexus webhook deliveries.',
  },
  stockLogs: {
    label: 'Stock movements',
    description: 'Per-SKU stock-delta ledger.',
  },
  exports: {
    label: 'Export download links',
    description:
      'Auto-expires past this window — re-run the export to refresh.',
  },
}

export default function PrivacyClient({
  initialExports,
  initialRetention,
  initialConsent,
  initialError,
}: Props) {
  const [exports, setExports] = useState(initialExports)
  const [retention, setRetention] = useState(initialRetention)
  const [consent, setConsent] = useState(initialConsent)
  const [error, setError] = useState(initialError)

  const refetchExports = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/privacy/exports`,
        { cache: 'no-store' },
      )
      if (res.ok) setExports((await res.json()).exports ?? [])
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  const refetchConsent = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/privacy/consent`,
        { cache: 'no-store' },
      )
      if (res.ok) setConsent((await res.json()).latest ?? {})
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  return (
    <div className="max-w-3xl space-y-6">
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <ExportCard
        rows={exports}
        onChange={refetchExports}
        onError={setError}
      />
      <RetentionCard
        state={retention}
        onSaved={(next) =>
          setRetention((r) => (r ? { ...r, policies: next } : r))
        }
        onError={setError}
      />
      <ConsentCard
        latest={consent}
        onChange={refetchConsent}
        onError={setError}
      />
      <DeleteAccountCard onError={setError} />
    </div>
  )
}

function Card({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
      <div className="flex items-start gap-3 mb-4 pb-3 border-b border-slate-100 dark:border-slate-800">
        {icon && (
          <div className="shrink-0 w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
            {icon}
          </div>
        )}
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          {description && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}

// ─── Export card ─────────────────────────────────────────────────

function ExportCard({
  rows,
  onChange,
  onError,
}: {
  rows: ExportRow[]
  onChange: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/privacy/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: ['all'], format: 'json' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      await onChange()
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Export workspace data"
      description="GDPR Art. 20 portability — every user-facing table as one JSON file. Sensitive fields (password hashes, key hashes, webhook secrets, 2FA secrets) are stripped before export."
      icon={<FileDown size={14} />}
    >
      <div className="space-y-4">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          <Download size={13} />
          Generate export
        </button>

        {rows.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 mb-1.5 inline-flex items-center gap-1.5">
              <History size={11} /> Recent exports
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded border border-slate-200 dark:border-slate-800">
              {rows.map((r) => (
                <ExportRowItem key={r.id} row={r} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function ExportRowItem({ row }: { row: ExportRow }) {
  const expired =
    row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()
  const statusTone =
    row.status === 'COMPLETED'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : row.status === 'FAILED'
        ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
        : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
  return (
    <li className="px-3 py-2 flex items-center justify-between gap-3 text-sm">
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
            statusTone,
          )}
        >
          {row.status}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {new Date(row.createdAt).toLocaleString()}
        </span>
        {row.bytes != null && (
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            · {formatBytes(row.bytes)}
          </span>
        )}
        {row.error && (
          <span className="text-xs text-rose-600 dark:text-rose-400 truncate">
            · {row.error}
          </span>
        )}
      </div>
      {row.status === 'COMPLETED' && row.downloadUrl && !expired ? (
        <a
          href={`${getBackendUrl()}${row.downloadUrl}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          <Download size={11} /> Download
        </a>
      ) : expired ? (
        <span className="text-xs text-slate-500 dark:text-slate-500 inline-flex items-center gap-1">
          <Slash size={11} /> Link expired
        </span>
      ) : null}
    </li>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ─── Retention card ──────────────────────────────────────────────

function RetentionCard({
  state,
  onSaved,
  onError,
}: {
  state: RetentionState | null
  onSaved: (next: Record<string, number>) => void
  onError: (msg: string) => void
}) {
  const [draft, setDraft] = useState<Record<string, number>>(
    state?.policies ?? {},
  )
  const [busy, setBusy] = useState(false)

  const dirty = useMemo(() => {
    if (!state) return false
    for (const k of Object.keys(draft)) {
      if (draft[k] !== state.policies[k]) return true
    }
    return false
  }, [draft, state])

  const save = async () => {
    if (!state) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/privacy/retention`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies: draft }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      onSaved(data.policies as Record<string, number>)
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    if (state) setDraft(state.defaults)
  }

  if (!state) {
    return (
      <Card title="Data retention" icon={<AlertTriangle size={14} />}>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Retention policy could not be loaded.
        </p>
      </Card>
    )
  }

  return (
    <Card
      title="Data retention"
      description="How long we keep each kind of data. The retention cron sweeps rows past their window. Orders are floor-locked at 7 years for Italian fiscal compliance."
      icon={<History size={14} />}
    >
      <div className="space-y-3">
        {Object.entries(RETENTION_LABELS).map(([key, def]) => {
          const current = draft[key] ?? state.defaults[key]
          const floor = state.floors[key]
          const ceil = state.ceilings[key]
          return (
            <div
              key={key}
              className="grid grid-cols-[1fr_auto_auto] gap-3 items-center"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {def.label}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {def.description}
                </div>
              </div>
              <input
                type="range"
                min={floor}
                max={ceil}
                step={key === 'orders' ? 365 : 30}
                value={current}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))
                }
                className="w-32 sm:w-40 accent-blue-600"
              />
              <span className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300 w-20 text-right">
                {current >= 365
                  ? `${Math.round(current / 365)}y`
                  : `${current}d`}
              </span>
            </div>
          )
        })}
        <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-md text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <RotateCcw size={12} /> Reset to defaults
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="inline-flex items-center gap-2 h-8 px-3 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Save retention
          </button>
        </div>
      </div>
    </Card>
  )
}

// ─── Consent card ────────────────────────────────────────────────

function ConsentCard({
  latest,
  onChange,
  onError,
}: {
  latest: ConsentLatest
  onChange: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const toggle = async (
    kind: string,
    version: string,
    next: boolean,
  ) => {
    setBusy(kind)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/privacy/consent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, version, accepted: next }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      await onChange()
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card
      title="Consent log"
      description="Each toggle appends a new row with the document version + timestamp. Required for GDPR Art. 7 proof-of-consent."
      icon={<Cookie size={14} />}
    >
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {CONSENT_KINDS.map((c) => {
          const state = latest[c.kind]
          const accepted = state?.accepted ?? false
          const versionMismatch = state && state.version !== c.version
          return (
            <li key={c.kind} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {c.label}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {c.description}
                </div>
                {state && (
                  <div
                    className={cn(
                      'text-xs mt-1 inline-flex items-center gap-1.5',
                      versionMismatch
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-slate-500 dark:text-slate-400',
                    )}
                  >
                    {versionMismatch && <AlertTriangle size={11} />}
                    Last: {accepted ? 'accepted' : 'opted-out'} (
                    <span className="font-mono">{state.version}</span>) on{' '}
                    {new Date(state.at).toLocaleDateString()}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => toggle(c.kind, c.version, true)}
                  disabled={busy !== null || (accepted && !versionMismatch)}
                  className={cn(
                    'h-7 px-2 rounded text-xs border',
                    accepted && !versionMismatch
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {busy === c.kind ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : accepted && !versionMismatch ? (
                    <Check size={11} className="inline mr-1" />
                  ) : null}
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => toggle(c.kind, c.version, false)}
                  disabled={busy !== null || (state && !accepted) === true}
                  className={cn(
                    'h-7 px-2 rounded text-xs border',
                    state && !accepted
                      ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  Opt out
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ─── Delete account (dry-run) card ───────────────────────────────

function DeleteAccountCard({ onError }: { onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    wouldDelete: Record<string, number>
    wouldSurvive: string[]
    blockedBy: string[]
  } | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/privacy/delete-account-dry-run`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setPreview(await res.json())
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Delete account"
      description="Phase H ships a dry-run only — see what would be deleted. The destructive action lands when multi-user auth ships in Phase I."
      icon={<ShieldAlert size={14} />}
    >
      <div className="space-y-3">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-rose-300 text-rose-700 dark:text-rose-300 dark:border-rose-800 text-sm font-medium hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          <Trash2 size={13} />
          Run delete dry-run
        </button>

        {preview && (
          <div className="rounded-md border border-slate-200 dark:border-slate-800 p-3 text-sm space-y-3">
            <div>
              <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                Would be deleted
              </div>
              <ul className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(preview.wouldDelete).map(([k, v]) => (
                  <li
                    key={k}
                    className="flex items-center justify-between font-mono"
                  >
                    <span className="text-slate-700 dark:text-slate-300">
                      {k}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                      {v}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {preview.wouldSurvive.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                  Would survive
                </div>
                <ul className="list-disc list-inside text-xs text-slate-700 dark:text-slate-300 space-y-0.5">
                  {preview.wouldSurvive.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.blockedBy.length > 0 && (
              <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-2.5 text-xs text-amber-900 dark:text-amber-300 inline-flex items-start gap-1.5">
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                <span>{preview.blockedBy.join(' · ')}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
