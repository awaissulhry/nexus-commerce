'use client'

// MC.8.2 — A+ Content list client.
//
// Table view of every A+ Content document filtered by marketplace +
// status + search. New-document dialog drops the operator into the
// builder (which lands in MC.8.3 — for now the create-then-go-back
// flow just refetches the list).

import { useMemo, useState } from 'react'
import {
  BadgeCheck,
  Plus,
  AlertTriangle,
  Languages,
  Image as ImageIcon,
  Layers,
  RefreshCw,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useRouter } from 'next/navigation'
import {
  APLUS_STATUSES,
  COMMON_MARKETPLACES,
  type AplusContentRow,
  type AplusStatus,
} from './_lib/types'

interface Props {
  items: AplusContentRow[]
  error: string | null
  apiBase: string
}

const STATUS_TONE: Record<AplusStatus, string> = {
  DRAFT:
    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REVIEW:
    'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  APPROVED:
    'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300',
  SUBMITTED:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  PUBLISHED:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  REJECTED:
    'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300',
}

export default function AplusListClient({ items, error, apiBase }: Props) {
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
          (row.brand?.toLowerCase().includes(q) ?? false) ||
          (row.notes?.toLowerCase().includes(q) ?? false)
        if (!matched) return false
      }
      return true
    })
  }, [items, marketplace, status, search])

  const refresh = () => router.refresh()

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('aplus.title')}
        description={t('aplus.description')}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw className="w-4 h-4 mr-1" />
              {t('common.refresh')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t('aplus.createNew')}
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
            <p className="font-medium">{t('aplus.error.listTitle')}</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('aplus.searchPlaceholder')}
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <select
          value={marketplace}
          onChange={(e) => setMarketplace(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          <option value="">{t('aplus.allMarketplaces')}</option>
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
          <option value="">{t('aplus.allStatuses')}</option>
          {APLUS_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center dark:border-slate-700 dark:bg-slate-900">
          <BadgeCheck className="w-8 h-8 text-slate-400" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {items.length === 0
              ? t('aplus.empty.title')
              : t('aplus.emptyFiltered.title')}
          </p>
          <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
            {items.length === 0
              ? t('aplus.empty.body')
              : t('aplus.emptyFiltered.body')}
          </p>
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="w-4 h-4 mr-1" />
                {t('aplus.createFirst')}
              </Button>
              <a
                href="/marketing/templates"
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
              >
                {t('aplus.browseTemplates')}
              </a>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('aplus.col.name')}
                </th>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('aplus.col.marketplace')}
                </th>
                <th className="px-3 py-2 text-left font-semibold">
                  {t('aplus.col.status')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('aplus.col.modules')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('aplus.col.asins')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('aplus.col.locales')}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t('aplus.col.updated')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  onClick={() =>
                    router.push(`/marketing/aplus/${row.id}`)
                  }
                >
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {row.name}
                    </p>
                    {row.brand && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {row.brand}
                      </p>
                    )}
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
                    <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
                      {row._count.asinAttachments}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row._count.localizations > 0 ? (
                      <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                        <Languages className="w-3.5 h-3.5 text-slate-400" />
                        {row._count.localizations}
                      </span>
                    ) : row.masterContentId ? (
                      <span className="text-xs text-slate-400">
                        {t('aplus.translation')}
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

      <CreateAplusDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        apiBase={apiBase}
        onCreated={(id) => {
          setCreateOpen(false)
          toast.success(t('aplus.createdToast'))
          router.push(`/marketing/aplus/${id}`)
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
}

function CreateAplusDialog({ open, onClose, apiBase, onCreated }: CreateProps) {
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
      toast.error(t('aplus.create.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/aplus-content`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          brand: brand.trim() || null,
          marketplace,
          locale: selectedMarketplace?.defaultLocale ?? 'en-US',
        }),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Create failed (${res.status})`)
      }
      const data = (await res.json()) as { content: { id: string } }
      onCreated(data.content.id)
      // Reset form for next time the modal opens.
      setName('')
      setBrand('')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('aplus.create.error'),
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
      title={t('aplus.create.title')}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('aplus.create.nameLabel')}
            </span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('aplus.create.namePlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('aplus.create.brandLabel')}
            </span>
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder={t('aplus.create.brandPlaceholder')}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              {t('aplus.create.brandHint')}
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('aplus.create.marketplaceLabel')}
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
          {busy ? t('aplus.create.creating') : t('aplus.create.cta')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
