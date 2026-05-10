'use client'

/**
 * BV.3 (list-wizard) — admin surface for BrandVoice prompt-block
 * guidance.
 *
 * Operators write natural-language style instructions ("Terse
 * bullets. No emojis. Technical tone. Imperative voice.") that the
 * matcher in renderBrandVoiceBlock injects into every Step 5 AI
 * call. Sister to /settings/ai's AiPromptsClient — that surface
 * controls WHAT prompts are used; this surface controls the BRAND
 * VOICE bolted onto whichever prompt was picked.
 *
 * Scope keys (brand, marketplace, language) are optional — leave a
 * field blank to apply to "all <something>". The matcher prefers
 * most-specific row + falls back tier-by-tier.
 */

import { useCallback, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  PauseCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'

export interface BrandVoiceRow {
  id: string
  brand: string | null
  marketplace: string | null
  language: string | null
  body: string
  notes: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

interface DraftFields {
  brand: string
  marketplace: string
  language: string
  body: string
  notes: string
}

const EMPTY_DRAFT: DraftFields = {
  brand: '',
  marketplace: '',
  language: '',
  body: '',
  notes: '',
}

export default function AiBrandVoicesClient({
  initialRows,
}: {
  initialRows: BrandVoiceRow[]
}) {
  const { toast } = useToast()
  const confirm = useConfirm()
  const [rows, setRows] = useState<BrandVoiceRow[]>(initialRows)
  const [refreshing, setRefreshing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [createBusy, setCreateBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<DraftFields>(EMPTY_DRAFT)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const setRowBusy = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ai/brand-voices`)
      if (res.ok) {
        const json = await res.json()
        setRows(Array.isArray(json?.rows) ? json.rows : [])
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  const onCreate = useCallback(async () => {
    if (createDraft.body.trim().length === 0) {
      toast({
        tone: 'error',
        title: 'Body is required',
        description: 'Write the brand-voice guidance before saving.',
        durationMs: 4000,
      })
      return
    }
    setCreateBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ai/brand-voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand: createDraft.brand.trim() || null,
          marketplace: createDraft.marketplace.trim() || null,
          language: createDraft.language.trim() || null,
          body: createDraft.body.trim(),
          notes: createDraft.notes.trim() || null,
          isActive: true,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          tone: 'error',
          title: 'Create failed',
          description: json?.error ?? `HTTP ${res.status}`,
          durationMs: 6000,
        })
        return
      }
      if (json?.row) {
        setRows((prev) => [json.row as BrandVoiceRow, ...prev])
      }
      setCreateDraft(EMPTY_DRAFT)
      setCreating(false)
      toast({ tone: 'success', title: 'Brand voice created', durationMs: 3000 })
    } finally {
      setCreateBusy(false)
    }
  }, [createDraft, toast])

  const onSaveEdit = useCallback(
    async (row: BrandVoiceRow) => {
      if (editDraft.body.trim().length === 0) {
        toast({
          tone: 'error',
          title: 'Body cannot be blank',
          durationMs: 4000,
        })
        return
      }
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ai/brand-voices/${row.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              brand: editDraft.brand.trim() || null,
              marketplace: editDraft.marketplace.trim() || null,
              language: editDraft.language.trim() || null,
              body: editDraft.body.trim(),
              notes: editDraft.notes.trim() || null,
            }),
          },
        )
        const json = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'Save failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
          return
        }
        if (json?.row) {
          setRows((prev) =>
            prev.map((r) => (r.id === row.id ? (json.row as BrandVoiceRow) : r)),
          )
        }
        setEditingId(null)
        toast({ tone: 'success', title: 'Saved', durationMs: 3000 })
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [editDraft, setRowBusy, toast],
  )

  const onToggleActive = useCallback(
    async (row: BrandVoiceRow) => {
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ai/brand-voices/${row.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: !row.isActive }),
          },
        )
        const json = await res.json()
        if (res.ok && json?.row) {
          setRows((prev) =>
            prev.map((r) => (r.id === row.id ? (json.row as BrandVoiceRow) : r)),
          )
        }
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [setRowBusy],
  )

  const onDelete = useCallback(
    async (row: BrandVoiceRow) => {
      const ok = await confirm({
        title: 'Delete brand voice?',
        description: `This will hard-delete the brand-voice row${
          row.brand ? ` for brand "${row.brand}"` : ''
        }${row.marketplace ? ` on ${row.marketplace}` : ''}. AI calls fall back to the next-most-specific match.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ai/brand-voices/${row.id}`,
          { method: 'DELETE' },
        )
        if (res.ok) {
          setRows((prev) => prev.filter((r) => r.id !== row.id))
          toast({ tone: 'success', title: 'Deleted', durationMs: 3000 })
        } else {
          const json = await res.json().catch(() => ({}))
          toast({
            tone: 'error',
            title: 'Delete failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
        }
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [confirm, setRowBusy, toast],
  )

  const beginEdit = useCallback((row: BrandVoiceRow) => {
    setEditingId(row.id)
    setEditDraft({
      brand: row.brand ?? '',
      marketplace: row.marketplace ?? '',
      language: row.language ?? '',
      body: row.body,
      notes: row.notes ?? '',
    })
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />
          Brand voices
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3" />
            New brand voice
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh
          </button>
        </div>
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400">
        Operator-authored tone / structure / style guidance bolted onto every
        Step 5 AI prompt. Most-specific match wins (brand + marketplace +
        language → brand → global).
      </div>

      {creating && (
        <DraftForm
          draft={createDraft}
          onChange={setCreateDraft}
          onSubmit={onCreate}
          onCancel={() => {
            setCreating(false)
            setCreateDraft(EMPTY_DRAFT)
          }}
          submitLabel="Create"
          busy={createBusy}
        />
      )}

      {rows.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400 italic">
          No brand voices yet. Add one to inject style guidance into AI
          prompts.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 overflow-hidden">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => {
              const isExpanded = expanded.has(row.id)
              const isBusy = busy.has(row.id)
              const isEditing = editingId === row.id
              return (
                <li key={row.id} className="px-3 py-2">
                  {isEditing ? (
                    <DraftForm
                      draft={editDraft}
                      onChange={setEditDraft}
                      onSubmit={() => void onSaveEdit(row)}
                      onCancel={() => setEditingId(null)}
                      submitLabel="Save"
                      busy={isBusy}
                    />
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => toggleExpand(row.id)}
                        className="flex-1 min-w-0 text-left flex items-start gap-2"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <ActiveBadge active={row.isActive} />
                            {row.brand && (
                              <span className="text-xs text-slate-700 dark:text-slate-300 font-mono">
                                brand={row.brand}
                              </span>
                            )}
                            {row.marketplace && (
                              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                                market={row.marketplace}
                              </span>
                            )}
                            {row.language && (
                              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                                lang={row.language}
                              </span>
                            )}
                            {!row.brand && !row.marketplace && !row.language && (
                              <span className="text-xs text-slate-500 dark:text-slate-400 italic">
                                global (all scopes)
                              </span>
                            )}
                          </div>
                          <div className="text-md text-slate-700 dark:text-slate-300 mt-0.5 line-clamp-1">
                            {row.body}
                          </div>
                        </div>
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => beginEdit(row)}
                          disabled={isBusy}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void onToggleActive(row)}
                          disabled={isBusy}
                          title={row.isActive ? 'Pause this voice' : 'Reactivate'}
                        >
                          {row.isActive ? 'Pause' : 'Resume'}
                        </Button>
                        <button
                          type="button"
                          onClick={() => void onDelete(row)}
                          disabled={isBusy}
                          className="p-1 text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {isExpanded && !isEditing && (
                    <div className="mt-2 pl-6 space-y-1 text-sm">
                      <pre className="whitespace-pre-wrap font-mono text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/40 px-2 py-1.5 rounded text-sm">
                        {row.body}
                      </pre>
                      {row.notes && (
                        <div className="text-slate-500 dark:text-slate-400 italic">
                          Notes: {row.notes}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium inline-flex items-center gap-1">
      <CheckCircle2 className="w-3 h-3" /> Active
    </span>
  ) : (
    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 inline-flex items-center gap-1">
      <PauseCircle className="w-3 h-3" /> Paused
    </span>
  )
}

function DraftForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
}: {
  draft: DraftFields
  onChange: (next: DraftFields) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
  busy: boolean
}) {
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-slate-50 dark:bg-slate-800/40 px-3 py-3 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <input
          type="text"
          placeholder="brand (optional)"
          value={draft.brand}
          onChange={(e) => onChange({ ...draft, brand: e.target.value })}
          className="h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
        />
        <input
          type="text"
          placeholder="marketplace (e.g. IT)"
          value={draft.marketplace}
          onChange={(e) => onChange({ ...draft, marketplace: e.target.value })}
          className="h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
        />
        <input
          type="text"
          placeholder="language (e.g. it)"
          value={draft.language}
          onChange={(e) => onChange({ ...draft, language: e.target.value })}
          className="h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
        />
      </div>
      <textarea
        placeholder="Brand-voice guidance (e.g. &quot;Terse bullets. No emojis. Technical tone. Imperative voice.&quot;)"
        value={draft.body}
        onChange={(e) => onChange({ ...draft, body: e.target.value })}
        rows={4}
        className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 font-mono"
      />
      <textarea
        placeholder="Notes — operator-only memo (never sent to AI)"
        value={draft.notes}
        onChange={(e) => onChange({ ...draft, notes: e.target.value })}
        rows={2}
        className={cn(
          'w-full px-2 py-1.5 text-base border rounded',
          'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900',
        )}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={onSubmit}
          disabled={busy || draft.body.trim().length === 0}
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          {submitLabel}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
