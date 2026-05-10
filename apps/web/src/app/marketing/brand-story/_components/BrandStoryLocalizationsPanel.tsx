'use client'

// MC.9.3 — Brand Story localizations panel.
//
// Mirrors aplus/_components/LocalizationsPanel — same pattern, just
// pointed at the Brand Story endpoints. Sibling rows show a banner
// pointing back to the master; master rows get a "+ Add localization"
// flow that clones modules into a new (marketplace, locale) sibling.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Languages, Plus, Sparkles, ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { COMMON_MARKETPLACES } from '../../aplus/_lib/types'
import {
  type BrandStoryDetail,
  type BrandStoryStatus,
} from '../_lib/types'

interface Props {
  document: BrandStoryDetail
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

export default function BrandStoryLocalizationsPanel({
  document,
  apiBase,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [createOpen, setCreateOpen] = useState(false)

  if (document.masterStoryId && document.master) {
    return (
      <div className="rounded-md border border-slate-200 bg-blue-50 px-3 py-2 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-blue-950/30 dark:text-slate-300">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-blue-500" />
            <span>
              {t('brandStory.localizations.siblingNote', {
                marketplace: document.master.marketplace,
                locale: document.master.locale,
              })}
            </span>
          </div>
          <Link
            href={`/marketing/brand-story/${document.master.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <ArrowLeft className="w-3 h-3" />
            {t('brandStory.localizations.openMaster')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
          <Languages className="w-4 h-4 text-slate-400" />
          {t('brandStory.localizations.title')}
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            ({document.localizations.length + 1})
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="w-4 h-4 mr-1" />
          {t('brandStory.localizations.add')}
        </Button>
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        <li className="bg-slate-50 dark:bg-slate-800/30">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="rounded bg-blue-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-blue-800 dark:bg-blue-500/20 dark:text-blue-300">
                {t('brandStory.localizations.masterTag')}
              </span>
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {document.marketplace}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                · {document.locale}
              </span>
              <span className="rounded bg-emerald-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
                {t('brandStory.localizations.viewing')}
              </span>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[document.status]}`}
            >
              {document.status}
            </span>
          </div>
        </li>
        {document.localizations.map((loc) => (
          <li key={loc.id}>
            <Link
              href={`/marketing/brand-story/${loc.id}`}
              className="block hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {loc.marketplace}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    · {loc.locale}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[loc.status]}`}
                  >
                    {loc.status}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(loc.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <CreateLocalizationDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        sourceMarketplace={document.marketplace}
        existingLocales={[
          document.locale,
          ...document.localizations.map((l) => l.locale),
        ]}
        onCreate={async (marketplace, locale) => {
          try {
            const res = await fetch(
              `${apiBase}/api/brand-stories/${encodeURIComponent(document.id)}/localize`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ marketplace, locale }),
              },
            )
            if (!res.ok) {
              const err = (await res.json().catch(() => ({}))) as { error?: string }
              throw new Error(err.error ?? `Localize failed (${res.status})`)
            }
            const data = (await res.json()) as {
              story: { id: string }
              alreadyExisted: boolean
            }
            if (data.alreadyExisted)
              toast({
                title: t('brandStory.localizations.alreadyExists'),
                tone: 'info',
              })
            else
              toast.success(t('brandStory.localizations.created'))
            setCreateOpen(false)
            router.push(`/marketing/brand-story/${data.story.id}`)
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : t('brandStory.localizations.createError'),
            )
          }
        }}
        onAiTranslate={() => {
          toast({
            title: t('brandStory.localizations.aiDeferredTitle'),
            description: t('brandStory.localizations.aiDeferredBody'),
            tone: 'info',
          })
        }}
      />
    </div>
  )
}

interface CreateProps {
  open: boolean
  onClose: () => void
  sourceMarketplace: string
  existingLocales: string[]
  onCreate: (marketplace: string, locale: string) => Promise<void>
  onAiTranslate: () => void
}

function CreateLocalizationDialog({
  open,
  onClose,
  sourceMarketplace,
  existingLocales,
  onCreate,
  onAiTranslate,
}: CreateProps) {
  const { t } = useTranslations()
  const [marketplace, setMarketplace] = useState(
    COMMON_MARKETPLACES.find((m) => m.value !== sourceMarketplace)?.value ??
      'AMAZON_DE',
  )
  const [busy, setBusy] = useState(false)
  const selected = COMMON_MARKETPLACES.find((m) => m.value === marketplace)
  const conflict = selected
    ? existingLocales.includes(selected.defaultLocale)
    : false

  const submit = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await onCreate(marketplace, selected.defaultLocale)
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
      title={t('brandStory.localizations.createTitle')}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t('brandStory.localizations.createBody')}
          </p>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandStory.localizations.marketplaceLabel')}
            </span>
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {COMMON_MARKETPLACES.filter(
                (m) => m.value !== sourceMarketplace,
              ).map((m) => {
                const exists = existingLocales.includes(m.defaultLocale)
                return (
                  <option key={m.value} value={m.value} disabled={exists}>
                    {m.label} ({m.defaultLocale})
                    {exists ? ' — already exists' : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {conflict && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('brandStory.localizations.conflictHint')}
            </p>
          )}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">
                {t('brandStory.localizations.aiTeaserTitle')}
              </p>
              <p className="opacity-80">
                {t('brandStory.localizations.aiTeaserBody')}
              </p>
              <button
                type="button"
                onClick={onAiTranslate}
                disabled={busy}
                className="mt-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900/40"
              >
                <Sparkles className="w-3 h-3" />
                {t('brandStory.localizations.aiCta')}
              </button>
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || conflict || !selected}
        >
          {busy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
          {t('brandStory.localizations.cloneCta')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
