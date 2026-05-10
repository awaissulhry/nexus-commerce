'use client'

// MC.2.3 — sticky bottom bulk action bar.
//
// Pinned to the viewport bottom while at least one asset is selected.
// Centred, capped width, narrow shadow + border so it floats over the
// library without obscuring rows. Actions:
//   - Tag         (deferred to MC.2.1 schema; toast for now)
//   - Move        (deferred to MC.2.2 folders; toast for now)
//   - Download    (downloads each asset URL via <a download> click,
//                  no zip — zip ships in MC.3.2 with proper bulk
//                  upload infrastructure)
//   - Delete      (only fires for digital_asset rows today; product_
//                  image rows go through the master gallery surface
//                  per the existing C.11 separation)
//   - Clear       (drops the selection)

import { useState } from 'react'
import { X, Tag as TagIcon, FolderInput, Download, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import type { LibraryItem } from '../_lib/types'

interface Props {
  selected: LibraryItem[]
  apiBase: string
  onClear: () => void
  onAfterDelete: (deletedIds: string[]) => void
}

export default function BulkActionBar({
  selected,
  apiBase,
  onClear,
  onAfterDelete,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<null | 'delete' | 'download'>(null)

  if (selected.length === 0) return null

  const digitalAssets = selected.filter((i) => i.source === 'digital_asset')
  const productImages = selected.filter((i) => i.source === 'product_image')

  const downloadAll = async () => {
    setBusy('download')
    try {
      // Trigger download for each item. Browsers open at most a few
      // concurrent downloads; chaining via a 250ms gap avoids the
      // dialog-storm and stays within the popup-blocker tolerance.
      for (const item of selected) {
        const a = document.createElement('a')
        a.href = item.url
        a.download = item.label
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        await new Promise((r) => setTimeout(r, 250))
      }
      toast.success(
        t('marketingContent.bulk.downloadKicked', {
          n: selected.length.toString(),
        }),
      )
    } finally {
      setBusy(null)
    }
  }

  const deleteSelected = async () => {
    if (digitalAssets.length === 0) {
      toast({
        title: t('marketingContent.bulk.deleteUnsupportedTitle'),
        description: t('marketingContent.bulk.deleteUnsupportedBody'),
        tone: 'warning',
      })
      return
    }
    const ok = await confirm({
      title: t('marketingContent.bulk.deleteConfirmTitle', {
        n: digitalAssets.length.toString(),
      }),
      description: t('marketingContent.bulk.deleteConfirmBody'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy('delete')
    const deleted: string[] = []
    const failures: string[] = []
    try {
      for (const item of digitalAssets) {
        // Strip "da_" prefix to recover the raw DigitalAsset id.
        const rawId = item.id.startsWith('da_') ? item.id.slice(3) : item.id
        try {
          const res = await fetch(
            `${apiBase}/api/assets/${encodeURIComponent(rawId)}`,
            { method: 'DELETE' },
          )
          if (res.ok) deleted.push(item.id)
          else failures.push(item.label)
        } catch {
          failures.push(item.label)
        }
      }
      if (deleted.length > 0) {
        onAfterDelete(deleted)
        toast.success(
          t('marketingContent.bulk.deleteSuccess', {
            n: deleted.length.toString(),
          }),
        )
      }
      if (failures.length > 0) {
        toast.error(
          t('marketingContent.bulk.deletePartialFailure', {
            n: failures.length.toString(),
          }),
        )
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      role="region"
      aria-label={t('marketingContent.bulk.barLabel')}
      className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4"
    >
      <div className="flex w-full max-w-3xl items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
        <button
          type="button"
          onClick={onClear}
          aria-label={t('marketingContent.bulk.clear')}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X className="w-4 h-4" />
        </button>
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('marketingContent.bulk.selectedCount', {
            n: selected.length.toString(),
          })}
        </p>
        {productImages.length > 0 && (
          <span className="hidden sm:inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
            {t('marketingContent.bulk.includesMasterGallery', {
              n: productImages.length.toString(),
            })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              toast({
                title: t('marketingContent.bulk.tagDeferredTitle'),
                description: t('marketingContent.bulk.tagDeferredBody'),
                tone: 'info',
              })
            }
          >
            <TagIcon className="w-4 h-4" />
            <span className="hidden sm:inline ml-1">
              {t('marketingContent.bulk.tag')}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              toast({
                title: t('marketingContent.bulk.moveDeferredTitle'),
                description: t('marketingContent.bulk.moveDeferredBody'),
                tone: 'info',
              })
            }
          >
            <FolderInput className="w-4 h-4" />
            <span className="hidden sm:inline ml-1">
              {t('marketingContent.bulk.move')}
            </span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={downloadAll}
            disabled={busy !== null}
          >
            {busy === 'download' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span className="hidden sm:inline ml-1">
              {t('marketingContent.bulk.download')}
            </span>
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={deleteSelected}
            disabled={busy !== null}
          >
            {busy === 'delete' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            <span className="hidden sm:inline ml-1">
              {t('marketingContent.bulk.delete')}
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}
