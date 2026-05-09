'use client'

/**
 * W2.10 — Attribute admin (groups + attributes + options).
 *
 * Two-column master-detail. Left rail: AttributeGroup list with
 * counts + "New group" CTA. Right pane: attributes filtered to the
 * selected group, with type chips + counts (options / family
 * attachments). Click an attribute → side drawer with options
 * editor (only for select / multiselect).
 *
 * Splitting groups vs attributes vs options into separate pages
 * would be Akeneo's structure, but Salesforce/Airtable density
 * (per the user's feedback_visibility_over_minimalism memory) is
 * one-glance overview. This page packs all three into one screen
 * the operator can scan.
 *
 * What's NOT here yet:
 *   - Validation JSON editor (per-type forms with min/max/pattern
 *     for text/number, etc.) — basic create only stores type +
 *     code + label; W2.10b adds the editor.
 *   - Reference-entity picker for type=reference attributes —
 *     tables for those land in W2.x.
 *   - Inline edit on attribute label/sortOrder — uses a row
 *     "Edit" button → modal for now.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Plus,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface AttributeGroupRow {
  id: string
  code: string
  label: string
  description: string | null
  sortOrder: number
  _count?: { attributes: number }
}

export interface AttributeRow {
  id: string
  code: string
  label: string
  description: string | null
  groupId: string
  type: string
  validation: unknown
  defaultValue: unknown
  localizable: boolean
  scope: string
  sortOrder: number
  group?: { id: string; code: string; label: string }
  _count?: { options: number; familyAttributes: number }
}

interface AttributeOption {
  id: string
  code: string
  label: string
  metadata: unknown
  sortOrder: number
}

interface Props {
  initialGroups: AttributeGroupRow[]
  initialAttributes: AttributeRow[]
  initialError: string | null
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

const ATTRIBUTE_TYPES = [
  { value: 'text', label: 'Text (single-line)' },
  { value: 'textarea', label: 'Text (multi-line)' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'select', label: 'Select (single)' },
  { value: 'multiselect', label: 'Select (multi)' },
  { value: 'date', label: 'Date' },
  { value: 'reference', label: 'Reference entity' },
  { value: 'asset', label: 'Asset (image/file)' },
] as const

const TYPE_TONE: Record<string, string> = {
  text: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  textarea: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  number: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  boolean: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  select: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300',
  multiselect: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300',
  date: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  reference: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  asset: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
}

export default function AttributesClient({
  initialGroups,
  initialAttributes,
  initialError,
}: Props) {
  const [groups, setGroups] = useState<AttributeGroupRow[]>(initialGroups)
  const [attributes, setAttributes] =
    useState<AttributeRow[]>(initialAttributes)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    initialGroups[0]?.id ?? null,
  )
  const [error, setError] = useState<string | null>(initialError)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [creatingAttr, setCreatingAttr] = useState(false)
  const [openOptionsAttr, setOpenOptionsAttr] = useState<AttributeRow | null>(
    null,
  )
  const confirm = useConfirm()
  const { toast } = useToast()
  const { t } = useTranslations()

  const refresh = useCallback(async () => {
    try {
      const [g, a] = await Promise.all([
        fetch(`${getBackendUrl()}/api/attribute-groups`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/attributes`, { cache: 'no-store' }),
      ])
      if (g.ok) setGroups(((await g.json()).groups ?? []) as AttributeGroupRow[])
      if (a.ok)
        setAttributes(((await a.json()).attributes ?? []) as AttributeRow[])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  const filteredAttrs = useMemo(() => {
    if (!selectedGroupId) return attributes
    return attributes.filter((a) => a.groupId === selectedGroupId)
  }, [attributes, selectedGroupId])

  const onDeleteGroup = useCallback(
    async (g: AttributeGroupRow) => {
      const ok = await confirm({
        title: `Delete group "${g.label}"?`,
        description:
          (g._count?.attributes ?? 0) > 0
            ? `This group has ${g._count?.attributes} attribute${g._count?.attributes === 1 ? '' : 's'} attached. The DB will refuse the delete (RESTRICT) — move or delete those first.`
            : 'No attributes attached. Safe to delete.',
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/attribute-groups/${g.id}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(t('pim.toasts.deleted.group', { label: g.label }))
        if (selectedGroupId === g.id) setSelectedGroupId(null)
        refresh()
      } catch (e: any) {
        toast.error(t('pim.toasts.failed.delete', { msg: e?.message ?? String(e) }))
      }
    },
    [confirm, refresh, toast, t, selectedGroupId],
  )

  const onDeleteAttr = useCallback(
    async (a: AttributeRow) => {
      const ok = await confirm({
        title: `Delete attribute "${a.label}"?`,
        description: [
          (a._count?.options ?? 0) > 0
            ? `${a._count?.options} option${a._count?.options === 1 ? '' : 's'} will be deleted (CASCADE).`
            : null,
          (a._count?.familyAttributes ?? 0) > 0
            ? `${a._count?.familyAttributes} family attachment${a._count?.familyAttributes === 1 ? '' : 's'} will be removed.`
            : null,
          'Stored values on Products will be orphaned (not auto-deleted).',
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      try {
        const res = await fetch(`${getBackendUrl()}/api/attributes/${a.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(t('pim.toasts.deleted.attribute', { label: a.label }))
        refresh()
      } catch (e: any) {
        toast.error(t('pim.toasts.failed.delete', { msg: e?.message ?? String(e) }))
      }
    },
    [confirm, refresh, toast, t],
  )

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* Groups rail */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              {t('pim.attributes.groupsRail.title', { count: groups.length })}
            </div>
            <IconButton
              aria-label={t('pim.attributes.groupsRail.newGroup')}
              size="sm"
              tone="info"
              onClick={() => setCreatingGroup(true)}
            >
              <Plus className="w-3 h-3" />
            </IconButton>
          </div>
          {groups.length === 0 ? (
            <div className="px-3 py-6 text-sm text-slate-500 dark:text-slate-400 text-center">
              {t('pim.attributes.groupsRail.empty')}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              <li>
                <button
                  type="button"
                  onClick={() => setSelectedGroupId(null)}
                  className={cn(
                    'w-full text-left px-3 py-2 text-base hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-between',
                    selectedGroupId === null &&
                      'bg-blue-50 dark:bg-blue-950/40',
                  )}
                >
                  <span className="text-slate-700 dark:text-slate-300 italic">
                    {t('pim.attributes.groupsRail.allAttributes')}
                  </span>
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {attributes.length}
                  </span>
                </button>
              </li>
              {groups.map((g) => (
                <li
                  key={g.id}
                  className={cn(
                    'flex items-center',
                    selectedGroupId === g.id && 'bg-blue-50 dark:bg-blue-950/40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedGroupId(g.id)}
                    className="flex-1 text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 min-w-0"
                  >
                    <div className="text-base text-slate-900 dark:text-slate-100 truncate">
                      {g.label}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {g.code} ·{' '}
                      {t(
                        g._count?.attributes === 1
                          ? 'pim.attributes.groupsRail.attrCount.one'
                          : 'pim.attributes.groupsRail.attrCount.other',
                        { count: g._count?.attributes ?? 0 },
                      )}
                    </div>
                  </button>
                  <IconButton
                    aria-label={t('pim.attributes.groupsRail.deleteAria', { label: g.label })}
                    size="sm"
                    tone="danger"
                    onClick={() => onDeleteGroup(g)}
                    className="mr-1"
                  >
                    <Trash2 className="w-3 h-3" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Attributes table */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              {selectedGroupId === null
                ? t('pim.attributes.attrs.titleAll', { count: attributes.length })
                : t('pim.attributes.attrs.titleGroup', {
                    group: groups.find((g) => g.id === selectedGroupId)?.label ?? '',
                    count: filteredAttrs.length,
                  })}
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              onClick={() => setCreatingAttr(true)}
              disabled={groups.length === 0}
              title={
                groups.length === 0
                  ? t('pim.attributes.attrs.newDisabled')
                  : t('pim.attributes.attrs.newEnabled')
              }
            >
              {t('pim.attributes.attrs.new')}
            </Button>
          </div>
          {filteredAttrs.length === 0 ? (
            <div className="p-12 text-center">
              <Tag className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
              <div className="text-md text-slate-700 dark:text-slate-300">
                {groups.length === 0
                  ? t('pim.attributes.attrs.empty.noGroups')
                  : t('pim.attributes.attrs.empty.noAttrs')}
              </div>
            </div>
          ) : (
            <table className="w-full text-base">
              <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-left">
                  <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.attributes.attrs.col.code')}</th>
                  <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.attributes.attrs.col.label')}</th>
                  <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.attributes.attrs.col.type')}</th>
                  {selectedGroupId === null && (
                    <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.attributes.attrs.col.group')}</th>
                  )}
                  <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.attributes.attrs.col.options')}</th>
                  <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.attributes.attrs.col.usedBy')}</th>
                  <th className="px-3 py-2 w-8" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredAttrs.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  >
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                      {a.code}
                    </td>
                    <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
                      {a.label}
                      {(a.localizable || a.scope === 'per_variant') && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 inline-flex items-center gap-2">
                          {a.localizable && <span>· localizable</span>}
                          {a.scope === 'per_variant' && (
                            <span>· per-variant</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium',
                          TYPE_TONE[a.type] ?? TYPE_TONE.text,
                        )}
                      >
                        {a.type}
                      </span>
                    </td>
                    {selectedGroupId === null && (
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-400 text-sm">
                        {a.group?.label ?? '—'}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {a.type === 'select' || a.type === 'multiselect' ? (
                        <button
                          type="button"
                          onClick={() => setOpenOptionsAttr(a)}
                          className="text-blue-700 dark:text-blue-300 hover:underline"
                        >
                          {a._count?.options ?? 0}
                        </button>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500">
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {a._count?.familyAttributes ?? 0}
                    </td>
                    <td className="px-1 py-2">
                      <IconButton
                        aria-label={`Delete attribute ${a.label}`}
                        size="sm"
                        tone="danger"
                        onClick={() => onDeleteAttr(a)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {creatingGroup && (
        <CreateGroupModal
          onClose={() => setCreatingGroup(false)}
          onCreated={() => {
            setCreatingGroup(false)
            refresh()
          }}
        />
      )}
      {creatingAttr && (
        <CreateAttributeModal
          groups={groups}
          defaultGroupId={selectedGroupId ?? groups[0]?.id ?? ''}
          onClose={() => setCreatingAttr(false)}
          onCreated={() => {
            setCreatingAttr(false)
            refresh()
          }}
        />
      )}
      {openOptionsAttr && (
        <OptionsModal
          attribute={openOptionsAttr}
          onClose={() => setOpenOptionsAttr(null)}
          onChanged={() => refresh()}
        />
      )}
    </div>
  )
}

// ── Create group modal ───────────────────────────────────────────

function CreateGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()
  const { t } = useTranslations()

  const codeValid = !code || CODE_PATTERN.test(code)
  const canSubmit = CODE_PATTERN.test(code) && label.trim().length > 0

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/attribute-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label: label.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('pim.toasts.created.group', { label }))
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="md"
      title="New attribute group"
    >
      <div className="p-5 space-y-4">
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Code <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            placeholder="sizing"
            autoFocus
            className={`w-full h-9 px-2 text-base font-mono border rounded ${codeValid ? 'border-slate-200 dark:border-slate-800' : 'border-rose-300 dark:border-rose-700'} dark:bg-slate-900 dark:text-slate-100`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Label <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Sizing & Fit"
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
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
          disabled={!canSubmit}
          loading={submitting}
        >
          Create
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Create attribute modal ───────────────────────────────────────

function CreateAttributeModal({
  groups,
  defaultGroupId,
  onClose,
  onCreated,
}: {
  groups: AttributeGroupRow[]
  defaultGroupId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [groupId, setGroupId] = useState(defaultGroupId)
  const [type, setType] = useState<string>('text')
  const [scope, setScope] = useState<string>('global')
  const [localizable, setLocalizable] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()
  const { t } = useTranslations()

  const codeValid = !code || CODE_PATTERN.test(code)
  const canSubmit =
    CODE_PATTERN.test(code) && label.trim().length > 0 && !!groupId

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          label: label.trim(),
          groupId,
          type,
          scope,
          localizable,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('pim.toasts.created.attribute', { label }))
      onCreated()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title="New attribute"
      description="Validation rules + reference-entity binding land in W2.10b. For now this creates the basic typed field."
    >
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Code <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
              placeholder="ce_certification"
              autoFocus
              className={`w-full h-9 px-2 text-base font-mono border rounded ${codeValid ? 'border-slate-200 dark:border-slate-800' : 'border-rose-300 dark:border-rose-700'} dark:bg-slate-900 dark:text-slate-100`}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Group <span className="text-rose-500">*</span>
            </label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
            Label <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="CE Certification"
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Type
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              {ATTRIBUTE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Scope
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="global">Global (one value per product)</option>
              <option value="per_variant">Per variant</option>
            </select>
          </div>
        </div>
        <div>
          <label className="inline-flex items-center gap-2 text-base text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={localizable}
              onChange={(e) => setLocalizable(e.target.checked)}
            />
            Localizable (per-locale value via ProductTranslation)
          </label>
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
          disabled={!canSubmit}
          loading={submitting}
        >
          Create
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Options modal (select / multiselect attributes only) ─────────

function OptionsModal({
  attribute,
  onClose,
  onChanged,
}: {
  attribute: AttributeRow
  onClose: () => void
  onChanged: () => void
}) {
  const [options, setOptions] = useState<AttributeOption[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()
  const { t } = useTranslations()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/attributes/${attribute.id}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setOptions(data.attribute?.options ?? [])
      setErr(null)
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [attribute.id])

  // Load options when modal mounts.
  useEffect(() => {
    refresh()
  }, [refresh])

  const codeValid = !newCode || CODE_PATTERN.test(newCode)

  const addOption = async () => {
    if (!CODE_PATTERN.test(newCode) || !newLabel.trim()) return
    setSubmitting(true)
    setErr(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/attributes/${attribute.id}/options`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: newCode, label: newLabel.trim() }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setNewCode('')
      setNewLabel('')
      refresh()
      onChanged()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const removeOption = async (id: string) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/attribute-options/${id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      refresh()
      onChanged()
    } catch (e: any) {
      toast.error(t('pim.toasts.failed.delete', { msg: e?.message ?? String(e) }))
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      size="lg"
      title={`Options · ${attribute.label}`}
      description={`Choices presented to operators when filling this ${attribute.type} attribute.`}
    >
      <div className="p-5 space-y-3">
        {loading ? (
          <div className="text-base text-slate-500 dark:text-slate-400">
            Loading options…
          </div>
        ) : options && options.length > 0 ? (
          <ul className="border border-slate-200 dark:border-slate-800 rounded divide-y divide-slate-100 dark:divide-slate-800">
            {options.map((o) => (
              <li
                key={o.id}
                className="px-3 py-2 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-base text-slate-900 dark:text-slate-100">
                    {o.label}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                    {o.code}
                  </div>
                </div>
                <IconButton
                  aria-label={`Remove option ${o.label}`}
                  size="sm"
                  tone="danger"
                  onClick={() => removeOption(o.id)}
                >
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-base text-slate-500 dark:text-slate-400 italic">
            No options yet. Add the first one below.
          </div>
        )}

        <div className="border border-slate-200 dark:border-slate-800 rounded p-3 space-y-2">
          <div className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
            New option
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value.toLowerCase())}
              placeholder="code (e.g. red)"
              className={`w-full h-8 px-2 text-base font-mono border rounded ${codeValid ? 'border-slate-200 dark:border-slate-800' : 'border-rose-300 dark:border-rose-700'} dark:bg-slate-900 dark:text-slate-100`}
            />
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="label (e.g. Red)"
              className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3 h-3" />}
              onClick={addOption}
              disabled={
                submitting ||
                !CODE_PATTERN.test(newCode) ||
                !newLabel.trim()
              }
              loading={submitting}
            >
              Add option
            </Button>
          </div>
        </div>
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  )
}
