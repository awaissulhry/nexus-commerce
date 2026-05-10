'use client'

// MC.9.1 — Brand Story list view.
//
// Same shape as the A+ Content list page (AplusListClient) so the
// operator's mental model carries: filter by marketplace + status +
// search, table with status pill + module/locale counts, "New Brand
// Story" CTA. Differs from A+ Content in three places:
//   - Brand is a hard requirement at create time (one Brand Story
//     per brand+marketplace+locale; uniqueness enforced server-side)
//   - No ASIN attachments column (Brand Story is brand-level)
//   - Sidebar nav entry under Marketing → Brand Story

import { useMemo, useState } from 'react'
import {
  BookOpen,
  Plus,
  AlertTriangle,
  Languages,
  Layers,
  RefreshCw,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { COMMON_MARKETPLACES } from '../aplus/_lib/types'
import {
  BRAND_STORY_STATUSES,
  type BrandStoryRow,
  type BrandStoryStatus,
} from './_lib/types'

interface Props {
  items: BrandStoryRow[]
  error: string | null
  apiBase: string
}

const STATUS_TONE: Record<BrandStoryStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REVIEW: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  APPROVED: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300',
  SUBMITTED: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  PUBLISHED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300',
}

export default function BrandStoryListClient({
  items,
  error,
  apiBase,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [marketplace, setMarketplace] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const visible = useMemo(() => {
    return items.filter((row) => {
      if (marketplace && row.marketplace !== marketplace) return false
      if (status && row.status !== status) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const matched =
          row.name.toLowerCase().includes(q) ||
          row.brand.toLowerCase().includes(q) ||
          (row.notes?.toLowerCase().includes(q) ?? false)
        if (!matched) return false
      }
      return true
    })
  }, [items, marketplace, status, search])

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('brandStory.title')}
        description={t('brandStory.description')}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => router.refresh()}>
              <RefreshCw className="w-4 h-4 mr-1" />
              {t('common.refresh')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('brandStory.createNew')}
            </Button>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">{t('brandStory.error.listTitle')}</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('brandStory.searchPlaceholder')}
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <select
          value={marketplace}
          onChange={(e) => setMarketplace(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          <option value="">{t('brandStory.allMarketplaces')}</option>
          {COMMON_MARKETPLACES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          <option value="">{t('brandStory.allStatuses')}</option>
          {BRAND_STORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
          <BookOpen className="w-8 h-8 text-slate-400" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {items.length === 0
              ? t('brandStory.empty.title')
              : t('brandStory.emptyFiltered.title')}
          </p>
          <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
            {items.length === 0
              ? t('brandStory.empty.body')
              : t('brandStory.emptyFiltered.body')}
          </p>
          {items.length === 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('brandStory.createFirst')}
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('brandStory.col.name')}
                </th>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('brandStory.col.brand')}
                </th>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('brandStory.col.marketplace')}
                </th>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('brandStory.col.status')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('brandStory.col.modules')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('brandStory.col.locales')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('brandStory.col.updated')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  onClick={() => router.push(`/marketing/brand-story/${row.id}`)}
                >
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {row.name}
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                    {row.brand}
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                    {row.marketplace}
                    <span className="ml-1 text-xs text-slate-400">
                      · {row.locale}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[row.status]}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <Layers className="w-3.5 h-3.5 text-slate-400" />
                      {row._count.modules}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row._count.localizations > 0 ? (
                      <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                        <Languages className="w-3.5 h-3.5 text-slate-400" />
                        {row._count.localizations}
                      </span>
                    ) : row.masterStoryId ? (
                      <span className="text-xs text-slate-400">
                        {t('brandStory.translation')}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-500 dark:text-slate-400">
                    {new Date(row.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateBrandStoryDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        apiBase={apiBase}
        onCreated={(id) => {
          setCreateOpen(false)
          toast.success(t('brandStory.createdToast'))
          router.push(`/marketing/brand-story/${id}`)
        }}
        onConflict={(existingId) => {
          setCreateOpen(false)
          toast({
            title: t('brandStory.create.conflictTitle'),
            description: t('brandStory.create.conflictBody'),
            tone: 'info',
          })
          if (existingId) router.push(`/marketing/brand-story/${existingId}`)
        }}
      />
    </div>
  )
}

interface CreateProps {
  open: boolean
  onClose: () => void
  apiBase: string
  onCreated: (id: string) => void
  onConflict: (existingId: string | null) => void
}

function CreateBrandStoryDialog({
  open,
  onClose,
  apiBase,
  onCreated,
  onConflict,
}: CreateProps) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [brand, setBrand] = useState('')
  const [marketplace, setMarketplace] = useState('AMAZON_IT')
  const [busy, setBusy] = useState(false)

  const selectedMarketplace = COMMON_MARKETPLACES.find(
    (m) => m.value === marketplace,
  )

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t('brandStory.create.nameRequired'))
      return
    }
    if (!brand.trim()) {
      toast.error(t('brandStory.create.brandRequired'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/brand-stories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          brand: brand.trim(),
          marketplace,
          locale: selectedMarketplace?.defaultLocale ?? 'en-US',
        }),
      })
      if (res.status === 409) {
        const errBody = (await res.json().catch(() => ({}))) as {
          existingId?: string | null
        }
        onConflict(errBody.existingId ?? null)
        return
      }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Create failed (${res.status})`)
      }
      const data = (await res.json()) as { story: { id: string } }
      onCreated(data.story.id)
      setName('')
      setBrand('')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('brandStory.create.error'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={t('brandStory.create.title')}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandStory.create.nameLabel')}
            </span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('brandStory.create.namePlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandStory.create.brandLabel')}
            </span>
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder={t('brandStory.create.brandPlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              {t('brandStory.create.brandHint')}
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandStory.create.marketplaceLabel')}
            </span>
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {COMMON_MARKETPLACES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} ({m.defaultLocale})
                </option>
              ))}
            </select>
          </label>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? t('brandStory.create.creating') : t('brandStory.create.cta')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
