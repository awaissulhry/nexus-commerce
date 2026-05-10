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
import { Image as ImageIcon, MessageSquare, Check, Minus } from 'lucide-react'
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
    case 'standard_image_text':
      return <StandardImageText payload={payload} />
    case 'single_image_sidebar':
      return <SingleImageSidebar payload={payload} />
    case 'multiple_image_text_panels':
      return <MultipleImageTextPanels payload={payload} />
    case 'comparison_chart_3col':
      return <ComparisonChart payload={payload} columns={3} />
    case 'comparison_chart_4col':
      return <ComparisonChart payload={payload} columns={4} />
    case 'bulleted_list_with_images':
      return <BulletedListWithImages payload={payload} />
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

// ── standard_image_text ───────────────────────────────────────

function StandardImageText({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const url = resolveAssetUrl(payload.imageAssetId)
  const headline = (payload.headline as string) || ''
  const body = (payload.body as string) || ''
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="relative aspect-square overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
        {url ? (
          <Image
            src={url}
            alt={headline || 'Image'}
            fill
            sizes="120px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            <ImageIcon className="w-5 h-5" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {headline ? (
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {headline}
          </p>
        ) : (
          <p className="text-xs italic text-slate-400">
            {t('aplus.builder.preview.headlineHint')}
          </p>
        )}
        {body ? (
          <p className="line-clamp-4 text-xs text-slate-600 dark:text-slate-400">
            {body}
          </p>
        ) : (
          <p className="text-xs italic text-slate-400">
            {t('aplus.builder.preview.bodyHint')}
          </p>
        )}
      </div>
    </div>
  )
}

// ── single_image_sidebar ──────────────────────────────────────

function SingleImageSidebar({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const url = resolveAssetUrl(payload.imageAssetId)
  const headline = (payload.sidebarHeadline as string) || ''
  const items: string[] = Array.isArray(payload.sidebarItems)
    ? (payload.sidebarItems as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : []
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="relative aspect-square overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
        {url ? (
          <Image
            src={url}
            alt={headline || 'Image'}
            fill
            sizes="(min-width: 1024px) 400px, 100vw"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-400">
            <ImageIcon className="w-6 h-6" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {headline ||
            <span className="italic text-slate-400">
              {t('aplus.builder.preview.sidebarHeadlineHint')}
            </span>}
        </p>
        {items.length === 0 ? (
          <p className="text-xs italic text-slate-400">
            {t('aplus.builder.preview.sidebarItemsHint')}
          </p>
        ) : (
          <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-400">
            {items.map((item, idx) => (
              <li key={idx} className="flex items-start gap-1">
                <Check className="w-3 h-3 flex-shrink-0 mt-0.5 text-emerald-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── multiple_image_text_panels ────────────────────────────────

interface PanelItem {
  assetId?: string
  url?: string
  headline?: string
  body?: string
}

function MultipleImageTextPanels({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const panels: PanelItem[] = Array.isArray(payload.panels)
    ? (payload.panels as PanelItem[])
    : []
  if (panels.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-400 dark:border-slate-700 dark:bg-slate-800/50">
        {t('aplus.builder.preview.panelsHint')}
      </p>
    )
  // Layout uses up to 4 columns at lg, falling to 2 below — matches
  // Amazon's responsive A+ render in the listing page.
  return (
    <div
      className="grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, minmax(0, 1fr))`,
      }}
    >
      {panels.slice(0, 4).map((panel, idx) => {
        const url = resolveAssetUrl(panel.assetId) ?? panel.url ?? null
        return (
          <div
            key={idx}
            className="space-y-1 rounded-md border border-slate-200 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="relative aspect-square overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
              {url ? (
                <Image
                  src={url}
                  alt={panel.headline ?? `Panel ${idx + 1}`}
                  fill
                  sizes="200px"
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-400">
                  <ImageIcon className="w-4 h-4" />
                </div>
              )}
            </div>
            <p className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
              {panel.headline ?? '—'}
            </p>
            {panel.body && (
              <p className="line-clamp-2 text-[11px] text-slate-600 dark:text-slate-400">
                {panel.body}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── comparison_chart (3col / 4col) ────────────────────────────

function ComparisonChart({
  payload,
  columns,
}: {
  payload: Record<string, unknown>
  columns: 3 | 4
}) {
  const { t } = useTranslations()
  const asins: string[] = Array.isArray(payload.asins)
    ? (payload.asins as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : []
  const attributes: string[] = Array.isArray(payload.attributes)
    ? (payload.attributes as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : []
  if (asins.length === 0 && attributes.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-400 dark:border-slate-700 dark:bg-slate-800/50">
        {t('aplus.builder.preview.comparisonHint')}
      </p>
    )
  // Pad to the required column count so the grid renders even when
  // the operator hasn't entered every ASIN yet.
  const cols = [...asins.slice(0, columns)]
  while (cols.length < columns) cols.push('')
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          <tr>
            <th className="px-2 py-1 text-left font-semibold">
              {t('aplus.builder.preview.comparisonAttribute')}
            </th>
            {cols.map((asin, idx) => (
              <th
                key={idx}
                className="px-2 py-1 text-left font-mono text-[11px]"
              >
                {asin || (
                  <span className="italic text-slate-400">
                    ASIN {idx + 1}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(attributes.length ? attributes : ['—']).map((attr, rowIdx) => (
            <tr
              key={rowIdx}
              className="border-t border-slate-100 dark:border-slate-800"
            >
              <td className="px-2 py-1 font-medium text-slate-700 dark:text-slate-300">
                {attr || (
                  <span className="italic text-slate-400">
                    {t('aplus.builder.preview.comparisonAttrPlaceholder')}
                  </span>
                )}
              </td>
              {cols.map((_, colIdx) => (
                <td
                  key={colIdx}
                  className="px-2 py-1 text-slate-500 dark:text-slate-400"
                >
                  <Minus className="w-3 h-3" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── bulleted_list_with_images ─────────────────────────────────

function BulletedListWithImages({
  payload,
}: {
  payload: Record<string, unknown>
}) {
  const { t } = useTranslations()
  const items: PanelItem[] = Array.isArray(payload.items)
    ? (payload.items as PanelItem[])
    : []
  if (items.length === 0)
    return (
      <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-400 dark:border-slate-700 dark:bg-slate-800/50">
        {t('aplus.builder.preview.bulletedHint')}
      </p>
    )
  return (
    <ul className="space-y-1.5 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      {items.slice(0, 6).map((item, idx) => {
        const url = resolveAssetUrl(item.assetId) ?? item.url ?? null
        return (
          <li key={idx} className="flex items-start gap-2">
            <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
              {url ? (
                <Image
                  src={url}
                  alt={item.headline ?? `Item ${idx + 1}`}
                  fill
                  sizes="40px"
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-400">
                  <ImageIcon className="w-4 h-4" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                {item.headline ?? `Item ${idx + 1}`}
              </p>
              {item.body && (
                <p className="line-clamp-2 text-[11px] text-slate-600 dark:text-slate-400">
                  {item.body}
                </p>
              )}
            </div>
          </li>
        )
      })}
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
