'use client'

/**
 * W2.11 — Per-family editor.
 *
 * Three sections:
 *   1. Header   — family identity. Inline-edit label + description
 *                 + reparent.
 *   2. Own      — attributes directly attached to this family.
 *                 Add / remove / toggle required / edit channels.
 *   3. Inherited — read-only preview of attributes resolved from
 *                  ancestors (W2.4 service). Useful to see the full
 *                  picture without leaving the page.
 *
 * Channel editor is a comma-tag input — operator types channel
 * codes (AMAZON, EBAY, SHOPIFY) separated by commas. Empty list =
 * required everywhere (when required=true). Future commits add a
 * dropdown picker driven by ChannelConnection.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowUpRight,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

export interface FamilyDetail {
  id: string
  code: string
  label: string
  description: string | null
  parentFamilyId: string | null
  parentFamily: { id: string; code: string; label: string } | null
  childFamilies: Array<{ id: string; code: string; label: string }>
  familyAttributes: Array<{
    id: string
    attributeId: string
    required: boolean
    channels: string[]
    sortOrder: number
    attribute: {
      id: string
      code: string
      label: string
      type: string
      groupId: string
    }
  }>
  _count: { products: number }
}

export interface AttributeRow {
  id: string
  code: string
  label: string
  type: string
  groupId: string
  group?: { id: string; code: string; label: string }
}

export interface EffectiveAttribute {
  attributeId: string
  required: boolean
  channels: string[]
  sortOrder: number
  source: 'self' | string
}

interface Props {
  family: FamilyDetail
  attributePool: AttributeRow[]
  initialEffective: EffectiveAttribute[]
  initialError: string | null
}

export default function FamilyEditorClient({
  family: initialFamily,
  attributePool,
  initialEffective,
  initialError,
}: Props) {
  const [family, setFamily] = useState<FamilyDetail>(initialFamily)
  const [effective, setEffective] = useState<EffectiveAttribute[]>(initialEffective)
  const [error, setError] = useState<string | null>(initialError)
  const [adding, setAdding] = useState(false)
  const [reparentOpen, setReparentOpen] = useState(false)
  const confirm = useConfirm()
  const { toast } = useToast()

  const refresh = useCallback(async () => {
    try {
      const [f, e] = await Promise.all([
        fetch(`${getBackendUrl()}/api/families/${family.id}`, {
          cache: 'no-store',
        }),
        fetch(`${getBackendUrl()}/api/families/${family.id}/effective`, {
          cache: 'no-store',
        }),
      ])
      if (f.ok) setFamily(((await f.json()).family ?? family) as FamilyDetail)
      if (e.ok)
        setEffective(
          ((await e.json()).attributes ?? []) as EffectiveAttribute[],
        )
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [family])

  const onRemoveAttr = useCallback(
    async (faId: string, attrLabel: string) => {
      const ok = await confirm({
        title: `Detach attribute "${attrLabel}"?`,
        description:
          'Removing the family→attribute link does NOT delete stored values on Products. They become orphaned (no family declares them) but stay readable.',
        confirmLabel: 'Detach',
        tone: 'danger',
      })
      if (!ok) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/family-attributes/${faId}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(`Detached "${attrLabel}"`)
        refresh()
      } catch (e: any) {
        toast.error(`Detach failed: ${e?.message ?? String(e)}`)
      }
    },
    [confirm, refresh, toast],
  )

  const onToggleRequired = useCallback(
    async (faId: string, current: boolean) => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/family-attributes/${faId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ required: !current }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        refresh()
      } catch (e: any) {
        toast.error(`Update failed: ${e?.message ?? String(e)}`)
      }
    },
    [refresh, toast],
  )

  const onUpdateChannels = useCallback(
    async (faId: string, channels: string[]) => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/family-attributes/${faId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channels }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        refresh()
      } catch (e: any) {
        toast.error(`Update failed: ${e?.message ?? String(e)}`)
      }
    },
    [refresh, toast],
  )

  // W5.2 — drag-drop reorder handler. Receives the new ordered list
  // of FamilyAttribute ids, fires N parallel PATCH calls with new
  // sortOrder values (0, 10, 20, ...). The 10-step gap leaves room
  // for future inserts without immediate re-renumbering. Refresh
  // pulls the canonical order back from the server.
  const onReorder = useCallback(
    async (orderedIds: string[]) => {
      try {
        await Promise.all(
          orderedIds.map((id, idx) =>
            fetch(`${getBackendUrl()}/api/family-attributes/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sortOrder: idx * 10 }),
            }).then((r) => {
              if (!r.ok) throw new Error(`reorder HTTP ${r.status}`)
            }),
          ),
        )
        refresh()
      } catch (e: any) {
        toast.error(`Reorder failed: ${e?.message ?? String(e)}`)
        // Refresh to revert the optimistic UI to server truth.
        refresh()
      }
    },
    [refresh, toast],
  )

  // attributeIds already attached or inherited — exclude from picker.
  const usedAttrIds = new Set([
    ...family.familyAttributes.map((fa) => fa.attributeId),
    ...effective
      .filter((e) => e.source !== 'self')
      .map((e) => e.attributeId),
  ])
  const inheritedOnly = effective.filter((e) => e.source !== 'self')

  return (
    <div className="space-y-6">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Header card */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {family.code}
          </span>
          {family.parentFamily ? (
            <Link
              href={`/settings/pim/families/${family.parentFamily.id}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              parent: {family.parentFamily.label}
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          ) : (
            <span className="px-1.5 py-0.5 text-xs bg-slate-50 dark:bg-slate-900 rounded text-slate-500 dark:text-slate-400 italic border border-slate-200 dark:border-slate-800">
              root family
            </span>
          )}
          <span className="text-sm text-slate-500 dark:text-slate-400">
            · {family._count.products} product{family._count.products === 1 ? '' : 's'} attached
          </span>
          {/* W5.7 — Reparent button. Opens a small modal with a
              parent picker; server-side cycle detection handles
              the safety net. */}
          <button
            type="button"
            onClick={() => setReparentOpen(true)}
            className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
          >
            edit parent
          </button>
        </div>
        {family.childFamilies.length > 0 && (
          <div className="text-sm text-slate-600 dark:text-slate-400 inline-flex items-center gap-1.5 flex-wrap">
            <span className="text-slate-500 dark:text-slate-500">children:</span>
            {family.childFamilies.map((c) => (
              <Link
                key={c.id}
                href={`/settings/pim/families/${c.id}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                {c.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Own attributes */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
        <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Own attributes ({family.familyAttributes.length})
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3 h-3" />}
            onClick={() => setAdding(true)}
            disabled={attributePool.length === 0}
          >
            Add attribute
          </Button>
        </div>
        {family.familyAttributes.length === 0 ? (
          <div className="p-6 text-center text-base text-slate-500 dark:text-slate-400">
            No attributes attached directly to this family yet.
            {inheritedOnly.length > 0 &&
              ` ${inheritedOnly.length} inherited from ancestors.`}
          </div>
        ) : (
          <SortableAttributesTable
            familyAttributes={family.familyAttributes}
            onToggleRequired={onToggleRequired}
            onUpdateChannels={onUpdateChannels}
            onRemoveAttr={onRemoveAttr}
            onReorder={onReorder}
          />
        )}
      </div>

      {/* Inherited preview */}
      {inheritedOnly.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-900/40">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              Inherited from ancestors ({inheritedOnly.length}) · read-only
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Akeneo-strict: this family inherits these whether you like it or not. To change them, edit the ancestor.
            </div>
          </div>
          <table className="w-full text-base">
            <thead className="bg-slate-100/60 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Attribute</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Required</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Channels</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Source</th>
              </tr>
            </thead>
            <tbody>
              {inheritedOnly.map((e) => {
                const attr = attributePool.find((a) => a.id === e.attributeId)
                return (
                  <tr
                    key={e.attributeId}
                    className="border-t border-slate-200/60 dark:border-slate-800"
                  >
                    <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
                      {attr ? attr.label : <span className="font-mono text-xs">{e.attributeId}</span>}
                      {attr && (
                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
                          {attr.code} · {attr.type}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                      {e.required ? 'Required' : 'Optional'}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400 text-sm">
                      {e.channels.length === 0 ? 'all' : e.channels.join(', ')}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/settings/pim/families/${e.source}`}
                        className="text-sm text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-0.5"
                      >
                        {e.source}
                        <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddAttributeModal
          familyId={family.id}
          attributePool={attributePool.filter((a) => !usedAttrIds.has(a.id))}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            refresh()
          }}
        />
      )}
      {reparentOpen && (
        <ReparentModal
          familyId={family.id}
          familyLabel={family.label}
          currentParentId={family.parentFamilyId}
          onClose={() => setReparentOpen(false)}
          onUpdated={() => {
            setReparentOpen(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// ── Add attribute modal ──────────────────────────────────────────

function AddAttributeModal({
  familyId,
  attributePool,
  onClose,
  onAdded,
}: {
  familyId: string
  attributePool: AttributeRow[]
  onClose: () => void
  onAdded: () => void
}) {
  const [attributeId, setAttributeId] = useState(attributePool[0]?.id ?? '')
  const [required, setRequired] = useState(false)
  const [channelsRaw, setChannelsRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const channels = channelsRaw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
      const res = await fetch(
        `${getBackendUrl()}/api/families/${familyId}/attributes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attributeId, required, channels }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success('Attached')
      onAdded()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (attributePool.length === 0) {
    return (
      <Modal
        open={true}
        onClose={onClose}
        size="md"
        title="No attributes available to attach"
      >
        <div className="p-5 text-base text-slate-700 dark:text-slate-300 space-y-3">
          <p>
            All attributes are either already attached to this family or
            inherited from an ancestor. Akeneo-strict additive: a child
            can never re-declare what an ancestor already locked in.
          </p>
          <p>
            Create a new attribute under{' '}
            <Link
              href="/settings/pim/attributes"
              className="text-blue-700 dark:text-blue-300 hover:underline"
            >
              Attributes
            </Link>{' '}
            first if you need a new one.
          </p>
        </div>
        <ModalFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </ModalFooter>
      </Modal>
    )
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title="Attach attribute"
    >
      <div className="p-5 space-y-4">
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Attribute
          </label>
          <select
            value={attributeId}
            onChange={(e) => setAttributeId(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            autoFocus
          >
            {attributePool.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.code} · {a.type})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-base text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required
          </label>
          <p className="text-sm text-slate-500 dark:text-slate-400 ml-6 mt-1">
            When required, products must fill this before publishing.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Channels (comma-separated)
          </label>
          <input
            type="text"
            value={channelsRaw}
            onChange={(e) => setChannelsRaw(e.target.value)}
            placeholder="AMAZON, EBAY, SHOPIFY"
            disabled={!required}
            className="w-full h-9 px-2 text-base font-mono border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100 disabled:opacity-50"
          />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Empty = required on every channel. Listed = required only on those channels. Only meaningful when "Required" is checked.
          </p>
        </div>
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!attributeId}
          loading={submitting}
        >
          Attach
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Inline channels chip-input ──────────────────────────────────

function ChannelsTagInput({
  value,
  disabled,
  onChange,
}: {
  value: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          setDraft(value.join(', '))
          setEditing(true)
        }}
        disabled={disabled}
        className="text-base text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 disabled:opacity-50 inline-flex items-center gap-1 font-mono text-sm"
      >
        {value.length === 0 ? (
          <span className="italic text-slate-400 dark:text-slate-500">all</span>
        ) : (
          value.join(', ')
        )}
      </button>
    )
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
        if (next.join(',') !== value.join(',')) onChange(next)
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
      }}
      autoFocus
      className="w-full h-7 px-1.5 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded dark:bg-slate-900 dark:text-slate-100"
    />
  )
}

// ── W5.7 — Reparent modal ──────────────────────────────────────

function ReparentModal({
  familyId,
  familyLabel,
  currentParentId,
  onClose,
  onUpdated,
}: {
  familyId: string
  familyLabel: string
  currentParentId: string | null
  onClose: () => void
  onUpdated: () => void
}) {
  const [families, setFamilies] = useState<
    Array<{ id: string; code: string; label: string; parentFamilyId: string | null }>
  >([])
  const [parentId, setParentId] = useState<string>(currentParentId ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  // Load all families for the picker. The server-side
  // PATCH /families/:id walks the candidate's chain to detect a
  // would-be cycle, so we don't need to filter descendants here —
  // a 409 surfaces with an actionable error if the operator tries.
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/families`, { cache: 'no-store' })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        if (cancelled) return
        const list = (data.families ?? []).filter(
          (f: { id: string }) => f.id !== familyId,
        )
        list.sort((a: { label: string }, b: { label: string }) =>
          a.label.localeCompare(b.label),
        )
        setFamilies(list)
      })
      .catch((e) => !cancelled && setErr(e?.message ?? String(e)))
    return () => {
      cancelled = true
    }
  }, [familyId])

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/families/${familyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentFamilyId: parentId || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(
        parentId
          ? `Reparented "${familyLabel}"`
          : `Promoted "${familyLabel}" to root`,
      )
      onUpdated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const dirty = (parentId || null) !== currentParentId

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title={`Edit parent for "${familyLabel}"`}
      description="Inheritance is Akeneo-strict additive — moving the parent changes which attributes this family inherits. The server walks the candidate chain to refuse cycles + surfaces a 409 if the proposed parent would create one."
    >
      <div className="p-5 space-y-3">
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Parent family
          </label>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            autoFocus
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">— root (no parent) —</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} ({f.code})
              </option>
            ))}
          </select>
        </div>
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={submitting || !dirty}
          loading={submitting}
        >
          {parentId ? 'Reparent' : 'Promote to root'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── W5.2 — drag-drop reorder ────────────────────────────────────

function SortableAttributesTable({
  familyAttributes,
  onToggleRequired,
  onUpdateChannels,
  onRemoveAttr,
  onReorder,
}: {
  familyAttributes: FamilyDetail['familyAttributes']
  onToggleRequired: (faId: string, current: boolean) => void
  onUpdateChannels: (faId: string, channels: string[]) => void
  onRemoveAttr: (faId: string, label: string) => void
  onReorder: (orderedIds: string[]) => void
}) {
  // Optimistic local order — DnD updates this immediately on drop;
  // the server PATCHes happen in the background and refresh fixes
  // any drift.
  const [localOrder, setLocalOrder] = useState<string[]>(() =>
    familyAttributes
      .slice()
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.attribute.label.localeCompare(b.attribute.label),
      )
      .map((fa) => fa.id),
  )

  // When the parent refreshes (server truth changes), reset the
  // local order. Sync via a stable string key so we don't reset
  // mid-drag — the effect only fires when the server's key
  // actually differs from what we're currently displaying.
  const serverKey = familyAttributes
    .slice()
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.attribute.label.localeCompare(b.attribute.label),
    )
    .map((fa) => fa.id)
    .join(',')
  useEffect(() => {
    setLocalOrder(serverKey.split(','))
  }, [serverKey])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = localOrder.indexOf(String(active.id))
    const newIdx = localOrder.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    const next = arrayMove(localOrder, oldIdx, newIdx)
    setLocalOrder(next)
    onReorder(next)
  }

  // Resolve ids back to FA records, preserving local order.
  const byId = new Map(familyAttributes.map((fa) => [fa.id, fa]))
  const ordered = localOrder
    .map((id) => byId.get(id))
    .filter((fa): fa is (typeof familyAttributes)[number] => !!fa)

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <table className="w-full text-base">
        <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <tr className="text-left">
            <th className="px-1 w-7" aria-label="Drag handle" />
            <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Code</th>
            <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Label</th>
            <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Type</th>
            <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Required</th>
            <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Channels</th>
            <th className="px-3 py-2 w-8" aria-label="Actions" />
          </tr>
        </thead>
        <SortableContext
          items={localOrder}
          strategy={verticalListSortingStrategy}
        >
          <tbody>
            {ordered.map((fa) => (
              <SortableAttributeRow
                key={fa.id}
                fa={fa}
                onToggleRequired={onToggleRequired}
                onUpdateChannels={onUpdateChannels}
                onRemoveAttr={onRemoveAttr}
              />
            ))}
          </tbody>
        </SortableContext>
      </table>
    </DndContext>
  )
}

function SortableAttributeRow({
  fa,
  onToggleRequired,
  onUpdateChannels,
  onRemoveAttr,
}: {
  fa: FamilyDetail['familyAttributes'][number]
  onToggleRequired: (faId: string, current: boolean) => void
  onUpdateChannels: (faId: string, channels: string[]) => void
  onRemoveAttr: (faId: string, label: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: fa.id })

  return (
    <tr
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="border-t border-slate-100 dark:border-slate-800"
    >
      <td className="px-1 py-2 text-center align-middle">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${fa.attribute.label}`}
          className="inline-flex items-center justify-center h-7 w-5 text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      </td>
      <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
        {fa.attribute.code}
      </td>
      <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
        {fa.attribute.label}
      </td>
      <td className="px-3 py-2 text-sm text-slate-600 dark:text-slate-400">
        {fa.attribute.type}
      </td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-1.5 text-base text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={fa.required}
            onChange={() => onToggleRequired(fa.id, fa.required)}
          />
          {fa.required ? 'Required' : 'Optional'}
        </label>
      </td>
      <td className="px-3 py-2">
        <ChannelsTagInput
          value={fa.channels}
          disabled={!fa.required}
          onChange={(next) => onUpdateChannels(fa.id, next)}
        />
      </td>
      <td className="px-1 py-2">
        <IconButton
          aria-label={`Remove attribute ${fa.attribute.label}`}
          size="sm"
          tone="danger"
          onClick={() => onRemoveAttr(fa.id, fa.attribute.label)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </IconButton>
      </td>
    </tr>
  )
}
