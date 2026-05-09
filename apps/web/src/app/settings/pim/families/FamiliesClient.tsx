'use client'

/**
 * W2.9 — Product families admin (Akeneo cornerstone UI).
 *
 * List view + create + delete. Inline edit of label + description.
 * Reparent + attribute attach/detach lives in W2.11 (the
 * /settings/pim/families/:id editor page).
 *
 * The list shows: code, label, description, parent (chip), counts
 * (attrs / products / children). Sort: parents first (root families
 * with no parent on top), then alpha by label.
 *
 * Create is a small inline form with code + label + optional parent
 * picker. Delete confirms via useConfirm (cascades:
 * childFamilies.parentFamilyId → SET NULL, Product.familyId → SET
 * NULL, FamilyAttribute → CASCADE — surface this in the confirm
 * message so the operator knows what they're triggering).
 */

import { useCallback, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  Folder,
  Plus,
  Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

export interface FamilyRow {
  id: string
  code: string
  label: string
  description: string | null
  parentFamilyId: string | null
  createdAt: string
  updatedAt: string
  _count?: {
    products: number
    familyAttributes: number
    childFamilies: number
  }
}

interface Props {
  initial: FamilyRow[]
  initialError: string | null
}

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export default function FamiliesClient({ initial, initialError }: Props) {
  const [families, setFamilies] = useState<FamilyRow[]>(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // family id being mutated
  const confirm = useConfirm()
  const { toast } = useToast()
  const { t } = useTranslations()

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/families`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { families?: FamilyRow[] }
      setFamilies(data.families ?? [])
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    }
  }, [])

  const onDelete = useCallback(
    async (f: FamilyRow) => {
      const childCount = f._count?.childFamilies ?? 0
      const productCount = f._count?.products ?? 0
      const ok = await confirm({
        title: `Delete family "${f.label}"?`,
        description: [
          childCount > 0
            ? `${childCount} child famil${childCount === 1 ? 'y' : 'ies'} will become root families (parent unset).`
            : null,
          productCount > 0
            ? `${productCount} product${productCount === 1 ? '' : 's'} will be detached (familyId → null) but keep their data.`
            : null,
          `${f._count?.familyAttributes ?? 0} attribute attachment${f._count?.familyAttributes === 1 ? '' : 's'} will be removed.`,
        ]
          .filter(Boolean)
          .join(' '),
        confirmLabel: 'Delete',
        tone: 'danger',
      })
      if (!ok) return
      setBusy(f.id)
      try {
        const res = await fetch(`${getBackendUrl()}/api/families/${f.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        toast.success(`Deleted family "${f.label}"`)
        refresh()
      } catch (e: any) {
        toast.error(`Delete failed: ${e?.message ?? String(e)}`)
      } finally {
        setBusy(null)
      }
    },
    [confirm, refresh, toast],
  )

  const parentLookup = new Map(families.map((f) => [f.id, f]))

  // Roots first (parentFamilyId === null), then alpha by label.
  const sorted = [...families].sort((a, b) => {
    const aRoot = a.parentFamilyId === null
    const bRoot = b.parentFamilyId === null
    if (aRoot !== bRoot) return aRoot ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  return (
    <div className="space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          {t(
            families.length === 1
              ? 'pim.families.count.one'
              : 'pim.families.count.other',
            { count: families.length },
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="w-3 h-3" />}
          onClick={() => setCreating(true)}
        >
          {t('pim.families.new')}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-12 text-center">
          <Folder className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <div className="text-md text-slate-700 dark:text-slate-300">
            {t('pim.families.empty.title')}
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            {t('pim.families.empty.body')}
          </div>
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-left">
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.families.col.code')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.families.col.label')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300">{t('pim.families.col.parent')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.families.col.attrs')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.families.col.products')}</th>
                <th className="px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 text-right">{t('pim.families.col.children')}</th>
                <th className="px-3 py-2 w-8" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => {
                const parent = f.parentFamilyId
                  ? parentLookup.get(f.parentFamilyId)
                  : null
                return (
                  <tr
                    key={f.id}
                    className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  >
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                      <Link
                        href={`/settings/pim/families/${f.id}`}
                        className="hover:underline inline-flex items-center gap-1"
                      >
                        {f.code}
                        <ChevronRight className="w-3 h-3 text-slate-400" />
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-900 dark:text-slate-100">
                      {f.label}
                      {f.description && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-md">
                          {f.description}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                      {parent ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 rounded text-slate-700 dark:text-slate-300">
                          {parent.label}
                        </span>
                      ) : (
                        <span className="text-slate-400 dark:text-slate-500 italic text-sm">
                          {t('pim.families.parent.root')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {f._count?.familyAttributes ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {f._count?.products ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {f._count?.childFamilies ?? 0}
                    </td>
                    <td className="px-1 py-2">
                      <IconButton
                        aria-label={`Delete family ${f.label}`}
                        size="sm"
                        tone="danger"
                        disabled={busy === f.id}
                        onClick={() => onDelete(f)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateFamilyModal
          allFamilies={families}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

function CreateFamilyModal({
  allFamilies,
  onClose,
  onCreated,
}: {
  allFamilies: FamilyRow[]
  onClose: () => void
  onCreated: () => void
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [parentFamilyId, setParentFamilyId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  const codeValid = !code || CODE_PATTERN.test(code)
  const canSubmit =
    code.length > 0 && CODE_PATTERN.test(code) && label.trim().length > 0

  const submit = async () => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/families`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          label: label.trim(),
          description: description.trim() || null,
          parentFamilyId: parentFamilyId || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(`Created family "${label}"`)
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
      title="New product family"
      description="Akeneo-style template. Pick a stable code (snake_case), a display label, optionally inherit from a parent."
    >
      <div className="p-5 space-y-4">
        <div className="space-y-1">
          <label
            htmlFor="family-code"
            className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block"
          >
            Code <span className="text-rose-500">*</span>
          </label>
          <input
            id="family-code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            placeholder="motorcycle_jacket"
            autoFocus
            className={`w-full h-9 px-2 text-base font-mono border rounded ${codeValid ? 'border-slate-200 dark:border-slate-800' : 'border-rose-300 dark:border-rose-700'} dark:bg-slate-900 dark:text-slate-100`}
          />
          {!codeValid && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              Must be lowercase snake_case (start with a letter, then
              letters / digits / underscores).
            </p>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Stable identifier referenced by FamilyAttribute and product
            values. Cannot be changed after creation.
          </p>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="family-label"
            className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block"
          >
            Label <span className="text-rose-500">*</span>
          </label>
          <input
            id="family-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Motorcycle Jacket"
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="family-desc"
            className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block"
          >
            Description
          </label>
          <textarea
            id="family-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional short description for the operator UI."
            className="w-full px-2 py-1.5 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="family-parent"
            className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block"
          >
            Parent family
          </label>
          <select
            id="family-parent"
            value={parentFamilyId}
            onChange={(e) => setParentFamilyId(e.target.value)}
            className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="">— root (no parent) —</option>
            {allFamilies.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} ({f.code})
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Children inherit ALL parent attributes (Akeneo-strict
            additive). Children can ADD more but never remove or
            downgrade parent's required-vs-optional / channels.
          </p>
        </div>
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{err}</span>
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
          Create family
        </Button>
      </ModalFooter>
    </Modal>
  )
}
