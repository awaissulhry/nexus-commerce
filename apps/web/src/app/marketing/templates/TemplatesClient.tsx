'use client'

// MC.11.4 — Image template library client.
//
// Renders every curated template with a live Cloudinary preview.
// Operator can paste a custom asset URL to preview against their
// own image. Bulk-apply (MC.11.5) lands as a follow-up button on
// each card; for now the templates are reference + copy-recipe.

import { useState } from 'react'
import Image from 'next/image'
import {
  LayoutTemplate,
  Copy,
  ExternalLink,
  ChevronDown,
  Sparkles,
  AlertTriangle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  IMAGE_TEMPLATES,
  applyImageTemplate,
  type TemplateCategory,
  type ImageTemplate,
} from './_lib/image-templates'

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  product_on_white: 'Product on white',
  lifestyle: 'Lifestyle',
  hero_overlay: 'Hero / overlay',
  comparison: 'Comparison',
  social: 'Social',
}

export default function TemplatesClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [previewSource, setPreviewSource] = useState('')

  const grouped = IMAGE_TEMPLATES.reduce<
    Record<TemplateCategory, ImageTemplate[]>
  >(
    (acc, tpl) => {
      const list = acc[tpl.category]
      if (list) list.push(tpl)
      else acc[tpl.category] = [tpl]
      return acc
    },
    {} as Record<TemplateCategory, ImageTemplate[]>,
  )

  const copyRecipe = async (template: ImageTemplate) => {
    try {
      await navigator.clipboard.writeText(template.baseTransform)
      toast.success(t('templates.recipeCopied'))
    } catch {
      toast.error(t('templates.copyFailed'))
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('templates.title')}
        description={t('templates.description')}
      />

      {/* Preview source */}
      <div className="rounded-md border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
            <LayoutTemplate className="w-3.5 h-3.5 text-slate-400" />
            {t('templates.previewLabel')}
          </span>
          <input
            type="url"
            value={previewSource}
            onChange={(e) => setPreviewSource(e.target.value)}
            placeholder={t('templates.previewPlaceholder')}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
            {t('templates.previewHint')}
          </span>
        </label>
      </div>

      {/* AI deferral note */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
        <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-500" />
        <div>
          <p className="font-medium text-blue-900 dark:text-blue-200">
            {t('templates.aiDeferredTitle')}
          </p>
          <p className="text-blue-800 dark:text-blue-300">
            {t('templates.aiDeferredBody')}
          </p>
        </div>
      </div>

      {(Object.keys(grouped) as TemplateCategory[]).map((category) => (
        <details
          key={category}
          open
          className="rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {CATEGORY_LABEL[category]}
              <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
                ({grouped[category].length})
              </span>
            </p>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </summary>
          <ul className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {grouped[category].map((tpl) => {
              const previewUrl =
                applyImageTemplate(
                  previewSource || tpl.sampleAssetUrl,
                  tpl,
                ) ?? null
              return (
                <li
                  key={tpl.id}
                  className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"
                >
                  <div className="relative aspect-video w-full bg-slate-100 dark:bg-slate-800">
                    {previewUrl ? (
                      <Image
                        src={previewUrl}
                        alt={tpl.name}
                        fill
                        sizes="(min-width: 1024px) 33vw, 100vw"
                        className="object-contain"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                        <AlertTriangle className="w-4 h-4 mr-1" />
                        {t('templates.urlNotCloudinary')}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 p-2.5">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tpl.name}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tpl.description}
                    </p>
                    <p className="text-[11px] italic text-slate-500 dark:text-slate-500">
                      {tpl.bestFor}
                    </p>
                    <div className="flex items-center justify-between">
                      <code className="truncate rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-800 dark:text-slate-300">
                        {tpl.baseTransform.split(',').slice(0, 3).join(',')}…
                      </code>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => copyRecipe(tpl)}
                          aria-label={t('templates.copyRecipeAria')}
                          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        {previewUrl && (
                          <a
                            href={previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t('templates.openExternal')}
                            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </details>
      ))}
    </div>
  )
}
