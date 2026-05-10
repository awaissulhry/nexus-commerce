'use client'

// MC.8.6 — localizations panel.
//
// Sits below the builder header strip. Lists the master row + every
// translation sibling, lets the operator switch between them with
// one click, and offers two creation paths:
//   1. Clone empty (creates a new locale with the same module
//      structure but cleared text — operator translates manually)
//   2. AI translate (deferred per the engagement directive — clicks
//      currently surface the toast from MC-AI-DEFERRED.md)
//
// Only renders for the master row; sibling rows show a back-link to
// the master instead.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Languages,
  Plus,
  Sparkles,
  ArrowLeft,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  COMMON_MARKETPLACES,
  type AplusDetail,
  type AplusStatus,
} from '../_lib/types'

interface Props {
  document: AplusDetail
  apiBase: string
}

const STATUS_TONE: Record<AplusStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  REVIEW: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  APPROVED: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300',
  SUBMITTED: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  PUBLISHED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300',
}

export default function LocalizationsPanel({ document, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()
  const [createOpen, setCreateOpen] = useState(false)

  // Sibling row — show a banner pointing back to the master and
  // skip the create UI. Operator manages siblings from the master.
  if (document.masterContentId && document.master) {
    return (
      <div className="rounded-md border border-slate-200 bg-blue-50 px-3 py-2 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-blue-950/30 dark:text-slate-300">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Languages className="w-4 h-4 text-blue-500" />
            <span>
              {t('aplus.localizations.siblingNote', {
                marketplace: document.master.marketplace,
                locale: document.master.locale,
              })}
            </span>
          </div>
          <Link
            href={`/marketing/aplus/${document.master.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <ArrowLeft className="w-3 h-3" />
            {t('aplus.localizations.openMaster')}
          </Link>
        </div>
      </div>
    )
  }

  const haveLocalizations = document.localizations.length > 0

  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
          <Languages className="w-4 h-4 text-slate-400" />
          {t('aplus.localizations.title')}
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
          {t('aplus.localizations.add')}
        </Button>
      </div>

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {/* Master pinned at the top */}
        <LocalizationRow
          marketplace={document.marketplace}
          locale={document.locale}
          status={document.status}
          isMaster
          isCurrent
        />
        {haveLocalizations &&
          document.localizations.map((loc) => (
            <LocalizationRow
              key={loc.id}
              href={`/marketing/aplus/${loc.id}`}
              marketplace={loc.marketplace}
              locale={loc.locale}
              status={loc.status}
              updatedAt={loc.updatedAt}
            />
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
              `${apiBase}/api/aplus-content/${encodeURIComponent(document.id)}/localize`,
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
              content: { id: string }
              alreadyExisted: boolean
            }
            if (data.alreadyExisted)
              toast({
                title: t('aplus.localizations.alreadyExists'),
                tone: 'info',
              })
            else
              toast.success(t('aplus.localizations.created'))
            setCreateOpen(false)
            router.push(`/marketing/aplus/${data.content.id}`)
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : t('aplus.localizations.createError'),
            )
          }
        }}
        onAiTranslate={() => {
          // MC-AI-DEFERRED — surface the deferred-toast pattern.
          toast({
            title: t('aplus.localizations.aiDeferredTitle'),
            description: t('aplus.localizations.aiDeferredBody'),
            tone: 'info',
          })
        }}
      />
    </div>
  )
}

interface RowProps {
  marketplace: string
  locale: string
  status: AplusStatus
  href?: string
  isMaster?: boolean
  isCurrent?: boolean
  updatedAt?: string
}

function LocalizationRow({
  marketplace,
  locale,
  status,
  href,
  isMaster,
  isCurrent,
  updatedAt,
}: RowProps) {
  const { t } = useTranslations()
  const inner = (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        {isMaster && (
          <span className="rounded bg-blue-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-blue-800 dark:bg-blue-500/20 dark:text-blue-300">
            {t('aplus.localizations.masterTag')}
          </span>
        )}
        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {marketplace}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          · {locale}
        </span>
        {isCurrent && (
          <span className="rounded bg-emerald-100 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
            {t('aplus.localizations.viewing')}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[status]}`}
        >
          {status}
        </span>
        {updatedAt && (
          <span className="text-xs text-slate-400">
            {new Date(updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  )
  if (href && !isCurrent) {
    return (
      <li>
        <Link
          href={href}
          className="block hover:bg-slate-50 dark:hover:bg-slate-800/50"
        >
          {inner}
        </Link>
      </li>
    )
  }
  return <li className="bg-slate-50 dark:bg-slate-800/30">{inner}</li>
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
      title={t('aplus.localizations.createTitle')}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t('aplus.localizations.createBody')}
          </p>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('aplus.localizations.marketplaceLabel')}
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
              {t('aplus.localizations.conflictHint')}
            </p>
          )}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">
                {t('aplus.localizations.aiTeaserTitle')}
              </p>
              <p className="opacity-80">
                {t('aplus.localizations.aiTeaserBody')}
              </p>
              <button
                type="button"
                onClick={onAiTranslate}
                disabled={busy}
                className="mt-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900/40"
              >
                <Sparkles className="w-3 h-3" />
                {t('aplus.localizations.aiCta')}
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
          {t('aplus.localizations.cloneCta')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
