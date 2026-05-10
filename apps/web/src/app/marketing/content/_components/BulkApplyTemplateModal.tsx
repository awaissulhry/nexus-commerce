'use client'

// MC.11.5 — Bulk-apply template against selected assets.
//
// Operator picks N assets in the DAM library, opens this modal,
// chooses an image template (MC.11.4), and gets back N rendered
// Cloudinary URLs that can be copied or downloaded individually.
//
// AI auto-generate from template (lifestyle synthesis, color
// swap) is deferred to MC.4/MC.5 per docs/MC-AI-DEFERRED.md. The
// "Generate with AI" button in the modal stubs to a toast.

import { useState } from 'react'
import Image from 'next/image'
import {
  Sparkles,
  Copy,
  Download,
  Check,
  AlertTriangle,
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  IMAGE_TEMPLATES,
  applyImageTemplate,
  type ImageTemplate,
} from '../../templates/_lib/image-templates'
import type { LibraryItem } from '../_lib/types'

interface Props {
  open: boolean
  onClose: () => void
  selected: LibraryItem[]
}

export default function BulkApplyTemplateModal({
  open,
  onClose,
  selected,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [templateId, setTemplateId] = useState<string>(
    IMAGE_TEMPLATES[0]?.id ?? '',
  )

  const template: ImageTemplate | null =
    IMAGE_TEMPLATES.find((tpl) => tpl.id === templateId) ?? null

  // Per-asset rendered URLs. Cloudinary-only assets get a real
  // transformed URL; non-cloudinary assets fall back to null +
  // surface a "skipped" pill in the preview row.
  const renderedRows = selected.map((item) => ({
    item,
    renderedUrl: template ? applyImageTemplate(item.url, template) : null,
  }))

  const cloudinaryCount = renderedRows.filter(
    (r) => r.renderedUrl !== null,
  ).length

  const copyAll = async () => {
    const lines = renderedRows
      .filter((r) => r.renderedUrl)
      .map(
        (r) =>
          `${r.item.label}\t${r.renderedUrl}`,
      )
    if (lines.length === 0) {
      toast.error(t('bulkTemplate.noCloudinaryUrls'))
      return
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success(
        t('bulkTemplate.copiedAll', { n: lines.length.toString() }),
      )
    } catch {
      toast.error(t('bulkTemplate.copyFailed'))
    }
  }

  const downloadAll = () => {
    let kicked = 0
    for (const row of renderedRows) {
      if (!row.renderedUrl) continue
      const a = document.createElement('a')
      a.href = row.renderedUrl
      a.download = `${row.item.label}.jpg`
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      kicked++
    }
    if (kicked > 0)
      toast.success(t('bulkTemplate.downloadKicked', { n: kicked.toString() }))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('bulkTemplate.title', { n: selected.length.toString() })}
      size="2xl"
    >
      <ModalBody>
        <div className="space-y-3">
          {/* AI deferral note */}
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-900/20">
            <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
            <div className="flex-1">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                {t('bulkTemplate.aiDeferredTitle')}
              </p>
              <p className="text-amber-800 dark:text-amber-300">
                {t('bulkTemplate.aiDeferredBody')}
              </p>
              <button
                type="button"
                onClick={() =>
                  toast({
                    title: t('bulkTemplate.aiCtaToastTitle'),
                    description: t('bulkTemplate.aiCtaToastBody'),
                    tone: 'info',
                  })
                }
                className="mt-1 inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900/40"
              >
                <Sparkles className="w-3 h-3" />
                {t('bulkTemplate.aiCta')}
              </button>
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('bulkTemplate.templateLabel')}
            </span>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {IMAGE_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} — {tpl.description}
                </option>
              ))}
            </select>
            {template && (
              <p className="mt-1 text-[11px] italic text-slate-500 dark:text-slate-400">
                {template.bestFor}
              </p>
            )}
          </label>

          {/* Per-asset preview grid */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('bulkTemplate.previewLabel', {
                n: cloudinaryCount.toString(),
                total: selected.length.toString(),
              })}
            </p>
            <ul className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-3">
              {renderedRows.map((row) => (
                <li
                  key={row.item.id}
                  className="overflow-hidden rounded border border-slate-200 dark:border-slate-700"
                >
                  <div className="relative aspect-square w-full bg-slate-100 dark:bg-slate-800">
                    {row.renderedUrl ? (
                      <Image
                        src={row.renderedUrl}
                        alt={row.item.label}
                        fill
                        sizes="33vw"
                        className="object-contain"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] text-slate-500">
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        {t('bulkTemplate.skippedNonCloudinary')}
                      </div>
                    )}
                  </div>
                  <p className="truncate px-1.5 py-1 text-[11px] text-slate-700 dark:text-slate-300">
                    {row.item.label}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
        <Button
          variant="secondary"
          onClick={copyAll}
          disabled={cloudinaryCount === 0}
        >
          <Copy className="w-4 h-4 mr-1" />
          {t('bulkTemplate.copyUrls')}
        </Button>
        <Button
          variant="primary"
          onClick={downloadAll}
          disabled={cloudinaryCount === 0}
        >
          <Download className="w-4 h-4 mr-1" />
          {t('bulkTemplate.downloadAll', {
            n: cloudinaryCount.toString(),
          })}
        </Button>
        {cloudinaryCount === selected.length && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
            <Check className="w-3 h-3" />
            {t('bulkTemplate.allReady')}
          </span>
        )}
      </ModalFooter>
    </Modal>
  )
}
