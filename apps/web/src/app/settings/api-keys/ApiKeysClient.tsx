'use client'

/**
 * Settings rebuild — Phase G.4
 *
 * /settings/api-keys — denser, scope-aware key manager.
 *
 *   • Create row at the top: label + scope chip-picker + IP
 *     allowlist + expiry preset. Submit → yellow "save this once"
 *     panel surfaces the raw key.
 *   • List below: one row per key with scope chips, IP allowlist,
 *     expiry countdown, last-used relative time, rotation lineage,
 *     status pill, and inline Rotate / Revoke / Delete buttons.
 *
 * Rotation flow: pick a grace window (default 24h) → server issues
 * a new key with the same scopes/IP/expiry → both old + new
 * validate until the grace ends → after grace, old key returns
 * 'rotated' from the verifier.
 */

import { useMemo, useState, useTransition } from 'react'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import {
  AlertCircle,
  Check,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { CANONICAL_SCOPES, type ScopeDef } from '@/lib/api-key-scopes'
import {
  deleteApiKey,
  generateApiKey,
  revokeApiKey,
  rotateApiKey,
} from './actions'

export interface ApiKeyRow {
  id: string
  label: string
  keyPrefix: string
  createdAt: string
  lastUsed: string | null
  revokedAt: string | null
  scopes: string[]
  ipAllowlist: string[]
  expiresAt: string | null
  rotatedAt: string | null
  rotatedToId: string | null
  rotationGraceUntil: string | null
}

const EXPIRY_PRESETS = [
  { value: null as number | null, label: 'Never' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
] as const

interface Props {
  apiKeys: ApiKeyRow[]
}

export default function ApiKeysClient({ apiKeys }: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newKey, setNewKey] = useState<{ rawKey: string; label: string } | null>(
    null,
  )
  const [topError, setTopError] = useState<string | null>(null)

  // Group scopes for the create form. Same order as the registry.
  const groupedScopes = useMemo<Record<string, ScopeDef[]>>(() => {
    const out: Record<string, ScopeDef[]> = {}
    for (const s of CANONICAL_SCOPES) {
      out[s.group] ??= []
      out[s.group].push(s)
    }
    return out
  }, [])

  return (
    <div className="max-w-4xl space-y-6">
      <Header
        showCreate={showCreate}
        onToggle={() => setShowCreate((s) => !s)}
        keyCount={apiKeys.length}
      />

      {topError && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{topError}</span>
        </div>
      )}

      {newKey && (
        <SecretPanel
          label={newKey.label}
          secret={newKey.rawKey}
          onDone={() => setNewKey(null)}
        />
      )}

      {showCreate && (
        <CreateForm
          grouped={groupedScopes}
          onCreated={(rawKey, label) => {
            setNewKey({ rawKey, label })
            setShowCreate(false)
          }}
          onError={setTopError}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {apiKeys.length === 0 ? (
        <EmptyState onCreate={() => setShowCreate(true)} />
      ) : (
        <ul className="space-y-3">
          {apiKeys.map((k) => (
            <KeyRow
              key={k.id}
              row={k}
              onError={setTopError}
              onRotated={(rawKey, label) => setNewKey({ rawKey, label })}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function Header({
  showCreate,
  onToggle,
  keyCount,
}: {
  showCreate: boolean
  onToggle: () => void
  keyCount: number
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <KeyRound size={16} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            API keys
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 max-w-2xl">
            Personal access tokens for the Nexus API. Each key has its own
            scopes, optional IP allowlist, and optional expiry. Rotate keys on
            a schedule; revoke immediately if a key leaks.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          {keyCount} key{keyCount === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          {showCreate ? <X size={13} /> : <Plus size={13} />}
          {showCreate ? 'Cancel' : 'New key'}
        </button>
      </div>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-950/40 p-10 text-center">
      <KeyRound
        size={28}
        className="mx-auto text-slate-300 dark:text-slate-600 mb-3"
      />
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        No API keys yet
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
        Create one to call the Nexus API from scripts, integrations, or external
        dashboards. Scope each key narrowly — admin keys should rotate
        frequently.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 mt-4 h-8 px-3 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700"
      >
        <Plus size={13} />
        Create API key
      </button>
    </div>
  )
}

// ─── Create form ─────────────────────────────────────────────────

function CreateForm({
  grouped,
  onCreated,
  onError,
  onCancel,
}: {
  grouped: Record<string, ScopeDef[]>
  onCreated: (rawKey: string, label: string) => void
  onError: (msg: string) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [ipAllowlist, setIpAllowlist] = useState<string>('')
  const [expiresInDays, setExpiresInDays] = useState<number | null>(90)
  const [, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)

  const toggleScope = (s: string) =>
    setScopes((curr) =>
      curr.includes(s) ? curr.filter((x) => x !== s) : [...curr, s],
    )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    startTransition(async () => {
      const res = await generateApiKey({
        label,
        scopes,
        ipAllowlist: ipAllowlist
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        expiresInDays,
      })
      setBusy(false)
      if (!res.success) {
        onError(res.error ?? 'Failed to create API key.')
        return
      }
      onCreated(res.rawKey, label)
    })
  }

  return (
    <form
      onSubmit={submit}
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        New API key
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-4">
        <div>
          <label
            htmlFor="key-label"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            Label
          </label>
          <input
            id="key-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Slack bot · production"
            maxLength={80}
            required
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label
            htmlFor="key-expiry"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            Expires
          </label>
          <select
            id="key-expiry"
            value={expiresInDays === null ? '' : String(expiresInDays)}
            onChange={(e) =>
              setExpiresInDays(e.target.value === '' ? null : Number(e.target.value))
            }
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {EXPIRY_PRESETS.map((p) => (
              <option key={p.label} value={p.value === null ? '' : p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Scopes
          </label>
          {scopes.length === 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
              <AlertCircle size={11} /> No scopes — falls back to legacy full
              access
            </span>
          )}
        </div>
        <div className="space-y-3">
          {Object.entries(grouped).map(([group, list]) => (
            <div key={group}>
              <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                {group}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {list.map((s) => {
                  const on = scopes.includes(s.value)
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => toggleScope(s.value)}
                      title={s.description}
                      className={cn(
                        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors',
                        on
                          ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                          : 'bg-white text-slate-700 border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 hover:border-slate-400',
                      )}
                    >
                      {on && <Check size={11} />}
                      <span className="font-mono">{s.value}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label
          htmlFor="key-ip"
          className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
        >
          IP allowlist <span className="text-slate-500 font-normal">(optional)</span>
        </label>
        <textarea
          id="key-ip"
          rows={3}
          value={ipAllowlist}
          onChange={(e) => setIpAllowlist(e.target.value)}
          placeholder={'203.0.113.5\n198.51.100.0/24\n2001:db8::/32'}
          className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
        />
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          One IP or CIDR per line. Empty = any IP.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || label.trim().length === 0}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Create key
        </button>
      </div>
    </form>
  )
}

// ─── Secret panel (shown once after create or rotate) ───────────

function SecretPanel({
  label,
  secret,
  onDone,
}: {
  label: string
  secret: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertCircle
          size={14}
          className="mt-0.5 text-amber-700 dark:text-amber-400 shrink-0"
        />
        <div>
          <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Copy your new API key for <span className="font-mono">{label}</span>
          </h4>
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
            We never show this again — it's hashed at rest. Paste it into your
            integration now.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 px-2 py-1.5 rounded bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 font-mono text-xs select-all break-all text-slate-800 dark:text-slate-200">
          {secret}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              /* ignore — old browsers */
            }
          }}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900 hover:bg-amber-100"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-1 h-7 px-3 rounded text-xs font-medium bg-amber-700 text-white hover:bg-amber-800"
        >
          I've saved it
        </button>
      </div>
    </div>
  )
}

// ─── Per-key row ─────────────────────────────────────────────────

function KeyRow({
  row,
  onError,
  onRotated,
}: {
  row: ApiKeyRow
  onError: (msg: string) => void
  onRotated: (rawKey: string, label: string) => void
}) {
  const askConfirm = useConfirm()
  const [busy, setBusy] = useState<'rotate' | 'revoke' | 'delete' | null>(null)

  const status = useMemo(() => deriveStatus(row), [row])

  const rotate = async () => {
    const proceed = await askConfirm({
      title: `Rotate "${row.label}"?`,
      description:
        'A new key replaces this one. The old key keeps working for 24 hours so integrations can roll the new key.',
      confirmLabel: 'Rotate',
    })
    if (!proceed) return
    setBusy('rotate')
    try {
      const res = await rotateApiKey({ keyId: row.id, graceHours: 24 })
      if (!res.success) {
        onError(res.error ?? 'Rotation failed.')
        return
      }
      onRotated(res.rawKey, row.label + ' (rotated)')
    } finally {
      setBusy(null)
    }
  }

  const revoke = async () => {
    const proceed = await askConfirm({
      title: `Revoke "${row.label}"?`,
      description: 'The key 401s immediately. This cannot be undone.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!proceed) return
    setBusy('revoke')
    try {
      await revokeApiKey(row.id)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    const proceed = await askConfirm({
      title: `Delete "${row.label}"?`,
      description: 'Removes the key row entirely. Audit log entry is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!proceed) return
    setBusy('delete')
    try {
      await deleteApiKey(row.id)
    } finally {
      setBusy(null)
    }
  }

  const expiry = row.expiresAt ? formatRelative(row.expiresAt) : null
  const lastUsed = row.lastUsed ? formatRelative(row.lastUsed) : null
  const inGrace =
    row.rotatedAt &&
    row.rotationGraceUntil &&
    new Date(row.rotationGraceUntil).getTime() > Date.now()

  return (
    <li
      className={cn(
        'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4',
        (row.revokedAt || (row.rotatedAt && !inGrace)) && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {row.label}
            </h4>
            <StatusPill status={status} />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            <code className="font-mono">{row.keyPrefix}</code> · created{' '}
            {formatRelative(row.createdAt).text}
            {lastUsed && (
              <>
                {' '}
                · last used{' '}
                <span className={lastUsed.tone === 'danger' ? 'text-rose-600 dark:text-rose-400' : ''}>
                  {lastUsed.text}
                </span>
              </>
            )}
          </div>
          {row.scopes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {row.scopes.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-mono bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                >
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-2 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
              <Shield size={11} /> Legacy key — full access (no scopes)
            </div>
          )}
          {row.ipAllowlist.length > 0 && (
            <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 flex items-start gap-1.5">
              <Globe size={11} className="mt-0.5 shrink-0" />
              <span className="font-mono">{row.ipAllowlist.join(' · ')}</span>
            </div>
          )}
          {expiry && (
            <div
              className={cn(
                'mt-1 text-xs',
                expiry.tone === 'danger'
                  ? 'text-rose-600 dark:text-rose-400'
                  : expiry.tone === 'warn'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-slate-500 dark:text-slate-400',
              )}
            >
              Expires {expiry.text}
            </div>
          )}
          {inGrace && row.rotationGraceUntil && (
            <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              In rotation grace — old key stops working{' '}
              {formatRelative(row.rotationGraceUntil).text}.
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!row.revokedAt && !row.rotatedAt && (
            <button
              type="button"
              onClick={rotate}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              title="Issue a new key with the same scopes; old key valid for 24h grace"
            >
              {busy === 'rotate' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RefreshCw size={11} />
              )}
              Rotate
            </button>
          )}
          {!row.revokedAt && (
            <button
              type="button"
              onClick={revoke}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
            >
              {busy === 'revoke' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <XCircle size={11} />
              )}
              Revoke
            </button>
          )}
          <button
            type="button"
            onClick={remove}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'delete' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Trash2 size={11} />
            )}
          </button>
        </div>
      </div>
    </li>
  )
}

// ─── helpers ─────────────────────────────────────────────────────

type Status = 'active' | 'expired' | 'revoked' | 'rotated' | 'grace'

function deriveStatus(row: ApiKeyRow): Status {
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    return 'expired'
  }
  if (row.rotatedAt) {
    if (
      row.rotationGraceUntil &&
      new Date(row.rotationGraceUntil).getTime() > Date.now()
    ) {
      return 'grace'
    }
    return 'rotated'
  }
  return 'active'
}

const STATUS_PILL: Record<Status, { label: string; cls: string }> = {
  active: {
    label: 'Active',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  grace: {
    label: 'Rotating',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  rotated: {
    label: 'Rotated',
    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  },
  expired: {
    label: 'Expired',
    cls: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  },
  revoked: {
    label: 'Revoked',
    cls: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  },
}

function StatusPill({ status }: { status: Status }) {
  const s = STATUS_PILL[status]
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
        s.cls,
      )}
    >
      {s.label}
    </span>
  )
}

function formatRelative(iso: string): {
  text: string
  tone: 'ok' | 'warn' | 'danger'
} {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const delta = target - now
  const abs = Math.abs(delta)
  const absMin = Math.floor(abs / 60_000)
  const absHr = Math.floor(abs / 3_600_000)
  const absDay = Math.floor(abs / 86_400_000)
  if (absDay >= 1) {
    return {
      text: new Date(iso).toLocaleDateString(),
      tone: delta < 0 ? 'danger' : 'ok',
    }
  }
  let text: string
  if (delta >= 0) {
    if (absMin < 1) text = 'in < 1m'
    else if (absHr < 1) text = `in ${absMin}m`
    else text = `in ${absHr}h ${absMin % 60}m`
  } else {
    if (absMin < 1) text = 'just now'
    else if (absHr < 1) text = `${absMin}m ago`
    else text = `${absHr}h ${absMin % 60}m ago`
  }
  let tone: 'ok' | 'warn' | 'danger' = 'ok'
  if (delta < 0) tone = 'danger'
  else if (absHr < 1) tone = 'warn'
  return { text, tone }
}
