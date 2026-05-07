'use client'

import { useCallback, useState } from 'react'
import {
  AlertCircle,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface TerminologyItem {
  id: string
  brand: string | null
  marketplace: string
  language: string
  preferred: string
  avoid: string[]
  context: string | null
  createdAt: string
  updatedAt: string
}

interface Props {
  initial: TerminologyItem[]
  initialError: string | null
}

interface DraftItem {
  id?: string
  brand: string
  marketplace: string
  language: string
  preferred: string
  avoidText: string
  context: string
}

const EMPTY_DRAFT: DraftItem = {
  brand: '',
  marketplace: 'IT',
  language: 'it',
  preferred: '',
  avoidText: '',
  context: '',
}

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK', 'US', 'NL', 'SE', 'PL', 'CA', 'MX']

export default function TerminologyClient({ initial, initialError }: Props) {
  const askConfirm = useConfirm()
  const [items, setItems] = useState(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<DraftItem | null>(null)

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/terminology`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { items?: TerminologyItem[] }
      setItems(data.items ?? [])
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [])

  const openAdd = () => setEditor({ ...EMPTY_DRAFT })
  const openEdit = (it: TerminologyItem) =>
    setEditor({
      id: it.id,
      brand: it.brand ?? '',
      marketplace: it.marketplace,
      language: it.language,
      preferred: it.preferred,
      avoidText: it.avoid.join(', '),
      context: it.context ?? '',
    })

  const save = async () => {
    if (!editor) return
    const preferred = editor.preferred.trim()
    if (!preferred) {
      setError('Preferred term is required')
      return
    }
    const body = {
      brand: editor.brand.trim() || null,
      marketplace: editor.marketplace,
      language: editor.language,
      preferred,
      avoid: editor.avoidText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      context: editor.context.trim() || null,
    }
    const url = editor.id
      ? `${getBackendUrl()}/api/terminology/${editor.id}`
      : `${getBackendUrl()}/api/terminology`
    const method = editor.id ? 'PATCH' : 'POST'
    setBusyId(editor.id ?? '__new__')
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setEditor(null)
      await refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusyId(null)
    }
  }

  const del = async (it: TerminologyItem) => {
    if (!(await askConfirm({ title: `Delete "${it.preferred}" preference?`, description: `For ${it.brand ?? 'all brands'} / ${it.marketplace}.`, confirmLabel: 'Delete', tone: 'danger' }))) return
    setBusyId(it.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/terminology/${it.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await refetch()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-base text-slate-500">
          {items.length.toLocaleString()} preference
          {items.length === 1 ? '' : 's'}
        </p>
        <Button variant="primary" size="sm" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Add preference
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-base text-red-900 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-700 hover:text-red-900"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center">
          <p className="text-lg text-slate-700 mb-2">
            No terminology preferences configured yet.
          </p>
          <p className="text-base text-slate-500 mb-4">
            Add a preference to steer AI-generated titles, bullets, and
            descriptions toward (or away from) specific words.
          </p>
          <Button variant="primary" size="sm" onClick={openAdd}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add your first preference
          </Button>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <table className="w-full text-md">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <Th>Brand</Th>
                <Th>Market</Th>
                <Th>Lang</Th>
                <Th>Preferred</Th>
                <Th>Avoid</Th>
                <Th>Context</Th>
                <Th className="w-[80px]"></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.id}
                  className="border-b border-slate-100 last:border-b-0"
                >
                  <Td>
                    {it.brand ? (
                      it.brand
                    ) : (
                      <span className="italic text-slate-400">All brands</span>
                    )}
                  </Td>
                  <Td>{it.marketplace}</Td>
                  <Td>{it.language}</Td>
                  <Td className="font-medium text-slate-900">{it.preferred}</Td>
                  <Td>
                    {it.avoid.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className="text-slate-700">
                        {it.avoid.join(', ')}
                      </span>
                    )}
                  </Td>
                  <Td className="text-slate-600">
                    {it.context ?? <span className="text-slate-400">—</span>}
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <IconButton
                        title="Edit"
                        onClick={() => openEdit(it)}
                        disabled={busyId === it.id}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </IconButton>
                      <IconButton
                        title="Delete"
                        onClick={() => del(it)}
                        disabled={busyId === it.id}
                        danger
                      >
                        {busyId === it.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </IconButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <Modal
          editor={editor}
          setEditor={setEditor}
          onSave={save}
          saving={busyId === '__new__' || (!!editor.id && busyId === editor.id)}
        />
      )}
    </div>
  )
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <th
      className={cn(
        'text-left px-3 py-2 text-sm font-semibold uppercase tracking-wide text-slate-500',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return <td className={cn('px-3 py-2 align-middle', className)}>{children}</td>
}

function IconButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded border text-slate-500',
        danger
          ? 'border-slate-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200'
          : 'border-slate-200 hover:bg-slate-50 hover:text-slate-900',
        disabled && 'opacity-50 cursor-default',
      )}
    >
      {children}
    </button>
  )
}

function Modal({
  editor,
  setEditor,
  onSave,
  saving,
}: {
  editor: DraftItem
  setEditor: (next: DraftItem | null) => void
  onSave: () => void
  saving: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 backdrop-blur-sm"
      onClick={() => !saving && setEditor(null)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[480px] max-w-[92vw] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-900">
            {editor.id ? 'Edit preference' : 'Add preference'}
          </h3>
          <button
            type="button"
            onClick={() => !saving && setEditor(null)}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <Field
            label="Brand"
            help='Leave empty for "applies to all brands in the marketplace".'
          >
            <input
              type="text"
              value={editor.brand}
              onChange={(e) =>
                setEditor({ ...editor, brand: e.target.value })
              }
              className={inputCls}
              placeholder="e.g. Xavia Racing"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Marketplace">
              <select
                value={editor.marketplace}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    marketplace: e.target.value,
                    // Cheap heuristic — most marketplaces map 1:1 to a
                    // language code. User can override the language box.
                    language: e.target.value.toLowerCase(),
                  })
                }
                className={inputCls}
              >
                {MARKETPLACES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <input
                type="text"
                value={editor.language}
                onChange={(e) =>
                  setEditor({ ...editor, language: e.target.value })
                }
                className={inputCls}
                placeholder="it / de / fr / en / …"
              />
            </Field>
          </div>

          <Field label="Preferred term *" help="The word the AI should use.">
            <input
              type="text"
              value={editor.preferred}
              onChange={(e) =>
                setEditor({ ...editor, preferred: e.target.value })
              }
              className={inputCls}
              placeholder="Giacca"
              autoFocus
            />
          </Field>

          <Field
            label="Avoid"
            help="Comma-separated. Words the AI keeps producing that are wrong."
          >
            <input
              type="text"
              value={editor.avoidText}
              onChange={(e) =>
                setEditor({ ...editor, avoidText: e.target.value })
              }
              className={inputCls}
              placeholder="Giubbotto, Bomber"
            />
          </Field>

          <Field
            label="Context"
            help="Optional — when this preference applies (e.g. 'motorcycle jacket', 'summer mesh')."
          >
            <input
              type="text"
              value={editor.context}
              onChange={(e) =>
                setEditor({ ...editor, context: e.target.value })
              }
              className={inputCls}
              placeholder="motorcycle jacket"
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !saving && setEditor(null)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={saving || !editor.preferred.trim()}
          >
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-1">
        {label}
      </div>
      {children}
      {help && <div className="text-sm text-slate-500 mt-1">{help}</div>}
    </label>
  )
}

const inputCls =
  'w-full h-8 px-2 text-md border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
