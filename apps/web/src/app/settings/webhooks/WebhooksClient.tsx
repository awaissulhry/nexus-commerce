'use client'

/**
 * Settings rebuild — Phase E.4
 *
 * /settings/webhooks — outbound subscription manager.
 *
 *   • Create row at the top (label + URL + event multi-select).
 *     On success, a yellow "save your secret" panel surfaces the
 *     raw HMAC secret exactly once.
 *   • List below: one row per subscription with edit-in-place
 *     active toggle, last-delivery status, Test button, Delete.
 *
 * Real event-triggered delivery is wired later (touches every
 * emitter — out of Phase E scope). The Test button proves the
 * receiver responds + the signature header lands; that's enough
 * to validate the setup.
 */

import { useCallback, useState } from 'react'
import {
  Webhook,
  Plus,
  Loader2,
  AlertCircle,
  Check,
  Copy,
  Trash2,
  Power,
  Send,
  X,
  Clock,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface WebhookRow {
  id: string
  label: string
  url: string
  secretPrefix: string
  events: string[]
  isActive: boolean
  lastFiredAt: string | null
  lastStatus: number | null
  lastError: string | null
  consecutiveFails: number
  createdAt: string
}

const ALL_EVENTS = [
  { value: 'NEW_ORDER', label: 'New order' },
  { value: 'LOW_STOCK', label: 'Low stock' },
  { value: 'RETURN_REQUEST', label: 'Return request' },
  { value: 'SYNC_FAILURE', label: 'Sync failure' },
  { value: 'AI_COMPLETE', label: 'AI job complete' },
] as const

interface Props {
  initial: WebhookRow[]
  initialError: string | null
}

export default function WebhooksClient({ initial, initialError }: Props) {
  const [rows, setRows] = useState(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [createOpen, setCreateOpen] = useState(false)
  const [newSecret, setNewSecret] = useState<{
    webhookId: string
    secret: string
    label: string
  } | null>(null)

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/webhooks`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { webhooks: WebhookRow[] }
      setRows(data.webhooks ?? [])
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  return (
    <div className="max-w-4xl space-y-6">
      <Header onCreateToggle={() => setCreateOpen((o) => !o)} createOpen={createOpen} />

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-md border border-rose-200 bg-rose-50 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {newSecret && (
        <SecretPanel
          label={newSecret.label}
          secret={newSecret.secret}
          onDone={() => setNewSecret(null)}
        />
      )}

      {createOpen && (
        <CreateForm
          onCreated={async (created, secret) => {
            setNewSecret({
              webhookId: created.id,
              secret,
              label: created.label,
            })
            setCreateOpen(false)
            await refetch()
          }}
          onCancel={() => setCreateOpen(false)}
          onError={setError}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState onCreate={() => setCreateOpen(true)} />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <SubscriptionRow
              key={r.id}
              row={r}
              onChange={refetch}
              onError={setError}
            />
          ))}
        </ul>
      )}

      <DeliveryNote />
    </div>
  )
}

function Header({
  onCreateToggle,
  createOpen,
}: {
  onCreateToggle: () => void
  createOpen: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400">
          <Webhook size={16} />
        </div>
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Outbound webhooks
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 max-w-2xl">
            Forward selected events to a URL. Each subscription has a unique
            HMAC secret; we sign every payload with{' '}
            <code className="font-mono text-xs px-1 rounded bg-slate-100 dark:bg-slate-800">
              X-Nexus-Signature: sha256=…
            </code>{' '}
            so your receiver can verify authenticity.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onCreateToggle}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        {createOpen ? <X size={13} /> : <Plus size={13} />}
        {createOpen ? 'Cancel' : 'New webhook'}
      </button>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-950/40 p-10 text-center">
      <Webhook
        size={28}
        className="mx-auto text-slate-300 dark:text-slate-600 mb-3"
      />
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        No webhook subscriptions yet
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
        Create one to forward events (orders, stock alerts, sync failures, AI
        completions) to a URL of your choice.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 mt-4 h-8 px-3 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700"
      >
        <Plus size={13} />
        Create webhook
      </button>
    </div>
  )
}

function DeliveryNote() {
  return (
    <div className="flex items-start gap-2 p-3 rounded-md border border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 text-xs text-slate-600 dark:text-slate-400">
      <Clock size={12} className="mt-0.5 shrink-0" />
      <span>
        Subscription CRUD + test-payload are live. Real event-triggered delivery
        wires into every emitter in a follow-up — until then, only the "Test"
        button fires.
      </span>
    </div>
  )
}

// ─── Create form ─────────────────────────────────────────────────

function CreateForm({
  onCreated,
  onCancel,
  onError,
}: {
  onCreated: (row: WebhookRow, secret: string) => Promise<void>
  onCancel: () => void
  onError: (msg: string) => void
}) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/settings/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, url, events }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      await onCreated(data.webhook, data.secret)
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg p-5 space-y-4"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        New webhook
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="wh-label"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            Label
          </label>
          <input
            id="wh-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Slack #ops bridge"
            maxLength={80}
            required
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        <div>
          <label
            htmlFor="wh-url"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
          >
            URL
          </label>
          <input
            id="wh-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.example.com/nexus"
            required
            className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
          Events
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
          Pick which event-types this subscription receives. Leave all unchecked
          for ALL events.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_EVENTS.map((ev) => {
            const on = events.includes(ev.value)
            return (
              <button
                key={ev.value}
                type="button"
                onClick={() =>
                  setEvents(
                    on ? events.filter((e) => e !== ev.value) : [...events, ev.value],
                  )
                }
                className={cn(
                  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors',
                  on
                    ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                    : 'bg-white text-slate-700 border-slate-300 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 hover:border-slate-400',
                )}
              >
                {on && <Check size={11} />}
                {ev.label}
              </button>
            )
          })}
        </div>
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
          disabled={busy || label.trim().length === 0 || url.trim().length === 0}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-slate-900 dark:bg-slate-800 text-white text-sm font-medium hover:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          Create
        </button>
      </div>
    </form>
  )
}

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
            Save the signing secret for{' '}
            <span className="font-mono">{label}</span>
          </h4>
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
            We never show this again — copy it now and store it where your
            webhook receiver expects to verify signatures.
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
              /* ignore */
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

// ─── Per-subscription row ────────────────────────────────────────

function SubscriptionRow({
  row,
  onChange,
  onError,
}: {
  row: WebhookRow
  onChange: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState<'test' | 'toggle' | 'delete' | null>(null)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    status: number
    error: string | null
    tookMs: number
  } | null>(null)

  const test = async () => {
    setBusy('test')
    setTestResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/webhooks/${row.id}/test`,
        { method: 'POST' },
      )
      const data = await res.json()
      setTestResult(data)
      await onChange()
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggleActive = async () => {
    setBusy('toggle')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/webhooks/${row.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !row.isActive }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await onChange()
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete webhook "${row.label}"?`)) return
    setBusy('delete')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/settings/webhooks/${row.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await onChange()
    } catch (e: any) {
      onError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }

  const eventsLabel =
    row.events.length === 0
      ? 'All events'
      : row.events.length <= 3
        ? row.events.join(', ')
        : `${row.events.slice(0, 3).join(', ')} +${row.events.length - 3}`

  return (
    <li
      className={cn(
        'bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-lg p-4',
        !row.isActive && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {row.label}
            </h4>
            {!row.isActive && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                Paused
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5 truncate">
            {row.url}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
            <span>
              Events: <span className="text-slate-700 dark:text-slate-300">{eventsLabel}</span>
            </span>
            <span className="text-tertiary dark:text-slate-500">·</span>
            <span>
              Secret <code className="font-mono">{row.secretPrefix}…</code>
            </span>
          </div>
          {row.lastFiredAt && (
            <div className="text-xs mt-1 flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center h-4 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                  row.lastStatus && row.lastStatus >= 200 && row.lastStatus < 300
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
                )}
              >
                {row.lastStatus ?? 'ERR'}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                Last fired {new Date(row.lastFiredAt).toLocaleString()}
              </span>
              {row.consecutiveFails > 0 && (
                <span className="text-rose-600 dark:text-rose-400">
                  · {row.consecutiveFails} consecutive fail
                  {row.consecutiveFails === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
          {row.lastError && (
            <div className="text-xs text-rose-600 dark:text-rose-400 mt-1 truncate">
              {row.lastError}
            </div>
          )}
          {testResult && (
            <div
              className={cn(
                'mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs',
                testResult.ok
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
              )}
            >
              {testResult.ok ? <Check size={11} /> : <AlertCircle size={11} />}
              Test → {testResult.status || 'ERR'} · {testResult.tookMs}ms
              {testResult.error && (
                <span className="truncate max-w-xs"> · {testResult.error}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={test}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'test' ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            Test
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={busy !== null}
            className={cn(
              'inline-flex items-center gap-1 h-7 px-2 rounded text-xs border disabled:opacity-50',
              row.isActive
                ? 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                : 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40',
            )}
          >
            {busy === 'toggle' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Power size={11} />
            )}
            {row.isActive ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
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
