'use client'

// MC.8.3 — module canvas-preview renderers.
//
// Three module types fully wired in this commit:
//   image_header_with_text    Hero w/ overlay headline (1464×600 box)
//   image_gallery_4           4-up image grid
//   faq                       Q&A accordion stack
//
// Every other module type falls back to the placeholder card (will
// be filled in across MC.8.4 standard + MC.8.5 premium). The
// renderer registry pattern keeps each module's preview self-
// contained — adding one in MC.8.4 is just adding an entry here.

import Image from 'next/image'
import { Image as ImageIcon, MessageSquare } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { ModuleSpec } from '../_lib/modules'

interface Props {
  spec: ModuleSpec
  payload: Record<string, unknown>
}

export default function ModuleRender({ spec, payload }: Props) {
  if (!spec.rendererImplemented) {
    return <PlaceholderRender spec={spec} />
  }
  switch (spec.id) {
    case 'image_header_with_text':
      return <ImageHeaderWithText payload={payload} />
    case 'image_gallery_4':
      return <ImageGallery4 payload={payload} />
    case 'faq':
      return <Faq payload={payload} />
    default:
      return <PlaceholderRender spec={spec} />
  }
}

function PlaceholderRender({ spec }: { spec: ModuleSpec }) {
  const { t } = useTranslations()
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
      <p className="font-medium text-slate-700 dark:text-slate-300">
        {spec.label}
      </p>
      <p>{spec.description}</p>
      <p className="mt-1.5 italic">
        {t('aplus.builder.previewSoon')}
      </p>
    </div>
  )
}

// ── image_header_with_text ────────────────────────────────────

function ImageHeaderWithText({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const imageUrl = resolveAssetUrl(payload.imageAssetId)
  const headline = (payload.headline as string) || ''
  const subhead = (payload.subhead as string) || ''
  return (
    <div
      className="relative aspect-[1464/600] w-full overflow-hidden rounded-md bg-slate-200 dark:bg-slate-800"
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={headline || 'Header image'}
          fill
          sizes="(min-width: 1024px) 800px, 100vw"
          className="object-cover"
          unoptimized
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-400">
          <ImageIcon className="w-8 h-8" />
        </div>
      )}
      {(headline || subhead) && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/70 to-transparent p-3 text-white">
          {headline && (
            <p className="text-base font-semibold leading-tight">
              {headline}
            </p>
          )}
          {subhead && (
            <p className="text-xs leading-snug opacity-90">{subhead}</p>
          )}
        </div>
      )}
      {!imageUrl && !headline && !subhead && (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
          {t('aplus.builder.preview.headerHint')}
        </p>
      )}
    </div>
  )
}

// ── image_gallery_4 ───────────────────────────────────────────

function ImageGallery4({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  interface ImageItem {
    assetId?: string
    url?: string
    alt?: string
  }
  const list: ImageItem[] = Array.isArray(payload.images)
    ? (payload.images as ImageItem[])
    : []
  const slots = Array.from({ length: 4 }, (_, idx) => list[idx] ?? {})
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {slots.map((item, idx) => {
        const url = resolveAssetUrl(item.assetId) ?? item.url ?? null
        return (
          <div
            key={idx}
            className="relative aspect-square overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800"
          >
            {url ? (
              <Image
                src={url}
                alt={item.alt ?? `Gallery ${idx + 1}`}
                fill
                sizes="200px"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-slate-400">
                <ImageIcon className="w-5 h-5" />
              </div>
            )}
          </div>
        )
      })}
      {list.length === 0 && (
        <p className="col-span-2 text-center text-[11px] text-slate-400">
          {t('aplus.builder.preview.galleryHint')}
        </p>
      )}
    </div>
  )
}

// ── faq ───────────────────────────────────────────────────────

function Faq({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useTranslations()
  interface QaItem {
    question?: string
    answer?: string
  }
  const items: QaItem[] = Array.isArray(payload.items)
    ? (payload.items as QaItem[])
    : []
  if (items.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
        {t('aplus.builder.preview.faqHint')}
      </p>
    )
  return (
    <ul className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
      {items.map((qa, idx) => (
        <li key={idx} className="space-y-0.5">
          <p className="flex items-start gap-1 text-xs font-semibold text-slate-900 dark:text-slate-100">
            <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-blue-500" />
            {qa.question || (
              <span className="italic text-slate-400">
                {t('aplus.builder.preview.faqEmptyQuestion')}
              </span>
            )}
          </p>
          {qa.answer && (
            <p className="ml-4 text-xs text-slate-600 dark:text-slate-400">
              {qa.answer}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

// ── helpers ───────────────────────────────────────────────────

function resolveAssetUrl(maybeId: unknown): string | null {
  if (typeof maybeId !== 'string' || !maybeId.trim()) return null
  // Operator may paste either a Cloudinary URL directly or a
  // DigitalAsset id. Accept both; the dedicated DAM picker arrives
  // in MC.8.4 (a small modal that returns the asset URL +
  // dimensions). For now anything that already looks like a URL
  // renders as-is; bare ids show as "missing" until the picker
  // ships.
  if (maybeId.startsWith('http://') || maybeId.startsWith('https://')) {
    return maybeId
  }
  return null
}
