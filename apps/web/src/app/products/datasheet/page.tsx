/**
 * DS.7 — Multi-SKU line sheet.
 *
 * Renders a printable B2B catalog page from `?ids=A,B,C`. Layout:
 *
 *   page 1   ── branded cover (logo + title + generated date + n
 *              SKUs + audience-mode chip)
 *   page 2…  ── SKU cards arranged 2 cols × 3 rows = 6 per A4 page.
 *
 * Each card: hero image (square) + SKU + localized name + price +
 * GTIN/UPC/EAN with embedded Code128. Optional PPE Cat badge if the
 * SKU is regulated PPE under Directive 2016/425 (Xavia helmets =
 * Cat III).
 *
 * Reuses the DS.1 print stylesheet (body[data-print-datasheet]), the
 * DS.3 Barcode128 + pretty marketplace helpers, and the DS.6 mode
 * resolution (querystring → cookie → 'b2b' default). The route is
 * intentionally a sibling of /products/[id]/datasheet rather than a
 * sub-route so the URL stays short for ad-hoc share links.
 *
 * Limits: caps at 60 SKUs (10 A4 pages). Anything above is a strong
 * smell that the operator wants a saved-view filter applied
 * server-side, not a 200-URL querystring.
 */

import { prisma } from '@nexus/database'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import PrintButtonClient from '../[id]/datasheet/PrintButtonClient'
import PrintBodyFlag from '../[id]/datasheet/PrintBodyFlag'
import DatasheetModePicker from '../[id]/datasheet/DatasheetModePicker'
import { Barcode128 } from '@/components/ui/Barcode128'
import { getServerLocale, getServerT } from '@/lib/i18n/server'

export const dynamic = 'force-dynamic'

const MAX_IDS = 60

type AudienceMode = 'b2b' | 'internal' | 'public'
const DEFAULT_MODE: AudienceMode = 'b2b'

function parseMode(v: string | string[] | undefined): AudienceMode | null {
  if (typeof v !== 'string') return null
  return v === 'b2b' || v === 'internal' || v === 'public' ? v : null
}

function parseIds(v: string | string[] | undefined): string[] {
  if (typeof v !== 'string') return []
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS)
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ProductLineSheetPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const ids = parseIds(sp.ids)
  const title = typeof sp.title === 'string' ? sp.title.trim().slice(0, 80) : ''
  const locale = await getServerLocale()
  const t = await getServerT()

  const cookieStore = await cookies()
  const mode: AudienceMode =
    parseMode(sp.mode) ??
    parseMode(cookieStore.get('nexus:datasheet-mode')?.value) ??
    DEFAULT_MODE
  const showPrice = true
  const showInternalMeta = mode === 'internal'

  // Empty-ids state: render an explanatory empty stub instead of
  // throwing. Operators arriving here from a stale bookmark see a
  // useful message + a path back.
  if (ids.length === 0) {
    return (
      <div className="bg-slate-50 dark:bg-slate-950 min-h-screen p-6">
        <div className="max-w-3xl mx-auto bg-white rounded p-6 dark:bg-slate-900">
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('products.lineSheet.empty.title')}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
            {t('products.lineSheet.empty.body')}
          </p>
          <Link
            href="/products"
            className="inline-flex items-center gap-1.5 mt-4 h-8 px-3 text-md text-slate-700 border border-slate-300 rounded-md hover:bg-slate-100 dark:text-slate-200 dark:border-slate-700"
          >
            <ArrowLeft className="w-4 h-4" />{' '}
            {t('products.lineSheet.empty.back')}
          </Link>
        </div>
      </div>
    )
  }

  const [products, brand] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        basePrice: true,
        gtin: true,
        upc: true,
        ean: true,
        ppeCategory: true,
        images: {
          select: { url: true, alt: true, type: true, sortOrder: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          take: 4,
        },
        translations: {
          select: { language: true, name: true },
        },
      },
    }),
    prisma.brandSettings.findFirst({
      select: { companyName: true, logoUrl: true, addressLines: true },
    }),
  ])

  // Preserve operator's input order — Prisma `IN` returns rows in DB
  // order, which is the operator's worst-case "alphabetical by SKU"
  // accident. We want the URL order, since that's what the saved
  // view / picker handed us.
  const productsById = new Map(products.map((p) => [p.id, p]))
  const orderedProducts = ids
    .map((id) => productsById.get(id))
    .filter((p): p is NonNullable<typeof p> => p != null)

  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const generatedAt = new Date().toLocaleDateString(dateLocale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const fmtCurrency = (v: number) =>
    new Intl.NumberFormat(dateLocale, {
      style: 'currency',
      currency: 'EUR',
    }).format(v)

  const heroFor = (p: (typeof orderedProducts)[number]) => {
    // Same ranking as DS.2 — MAIN wins, SWATCH/DIAGRAM sink.
    const ranked = [...p.images].sort((a, b) => {
      const aMain = a.type === 'MAIN'
      const bMain = b.type === 'MAIN'
      if (aMain !== bMain) return aMain ? -1 : 1
      const aSink = a.type === 'SWATCH' || a.type === 'DIAGRAM'
      const bSink = b.type === 'SWATCH' || b.type === 'DIAGRAM'
      if (aSink !== bSink) return aSink ? 1 : -1
      return 0
    })
    return ranked[0] ?? null
  }

  const displayNameFor = (p: (typeof orderedProducts)[number]) => {
    const tr = p.translations.find((x) => x.language === locale)
    return tr?.name?.trim() || p.name
  }

  const modeChipLabel = t(`products.datasheet.mode.${mode}.label`)
  const ppeLabel = (cat: string | null) => {
    if (cat === 'CAT_I') return t('products.datasheet.ppe.catI')
    if (cat === 'CAT_II') return t('products.datasheet.ppe.catII')
    if (cat === 'CAT_III') return t('products.datasheet.ppe.catIII')
    return null
  }

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-screen print:bg-white">
      <PrintBodyFlag />
      <div className="print:hidden sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between gap-3 dark:bg-slate-900 dark:border-slate-800">
        <Link
          href="/products"
          className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 hover:bg-slate-100 rounded-md dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="w-4 h-4" />{' '}
          {t('products.lineSheet.back')}
        </Link>
        <DatasheetModePicker current={mode} />
        <PrintButtonClient sku={`line-sheet-${orderedProducts.length}sku`} />
      </div>

      <article
        data-print-region="datasheet"
        className="max-w-3xl mx-auto bg-white p-8 my-6 print:my-0 print:p-0 print:max-w-none print:bg-white dark:bg-slate-900 print:dark:bg-white"
      >
        {/* ── Cover page ────────────────────────────────────────── */}
        <section className="min-h-[60vh] flex flex-col items-center justify-center text-center print:min-h-[24cm] print:break-after-page">
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brand.logoUrl}
              alt={brand.companyName ?? ''}
              className="w-32 h-32 object-contain mb-6"
            />
          ) : null}
          {brand?.companyName && (
            <div className="text-sm uppercase tracking-wider text-slate-500 mb-2">
              {brand.companyName}
            </div>
          )}
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-100">
            {title || t('products.lineSheet.coverTitle')}
          </h1>
          <div className="mt-4 text-sm text-slate-600 dark:text-slate-300">
            {t(
              orderedProducts.length === 1
                ? 'products.lineSheet.coverCount.one'
                : 'products.lineSheet.coverCount.other',
              { count: orderedProducts.length },
            )}
          </div>
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {generatedAt}
          </div>
          <div className="mt-6 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200">
            <span className="uppercase tracking-wider text-slate-500">
              {t('products.datasheet.mode.aria')}
            </span>
            <span className="font-medium">{modeChipLabel}</span>
          </div>
          {brand?.addressLines && brand.addressLines.length > 0 && (
            <div className="mt-8 text-xs text-slate-500 dark:text-slate-400 leading-tight">
              {brand.addressLines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </section>

        {/* ── SKU card grid ─────────────────────────────────────── */}
        <section className="grid grid-cols-1 md:grid-cols-2 print:grid-cols-2 gap-3 mt-6 print:mt-0">
          {orderedProducts.map((p) => {
            const hero = heroFor(p)
            const dispName = displayNameFor(p)
            const identifier = p.gtin ?? p.upc ?? p.ean ?? null
            const ppe = ppeLabel(p.ppeCategory)
            return (
              <div
                key={p.id}
                className="border border-slate-200 rounded p-3 flex gap-3 print:break-inside-avoid"
              >
                <div className="w-20 h-20 flex-shrink-0 border border-slate-200 rounded overflow-hidden bg-slate-50">
                  {hero ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={hero.url}
                      alt={hero.alt ?? dispName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="font-mono text-xs text-slate-500 truncate">
                      {p.sku}
                    </div>
                    {showPrice && (
                      <div className="text-sm font-semibold text-slate-900 tabular-nums flex-shrink-0">
                        {fmtCurrency(Number(p.basePrice))}
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-medium text-slate-900 line-clamp-2 leading-tight mt-0.5">
                    {dispName}
                  </div>
                  {p.brand && showInternalMeta && (
                    <div className="text-xs text-slate-500 mt-0.5">
                      {p.brand}
                    </div>
                  )}
                  {(identifier || ppe) && (
                    <div className="mt-1.5 flex items-end justify-between gap-2">
                      <div className="min-w-0">
                        {identifier && (
                          <Barcode128
                            value={identifier}
                            maxWidthPx={160}
                            height={28}
                            showText={true}
                          />
                        )}
                      </div>
                      {ppe && (
                        <span
                          className="flex-shrink-0 px-1.5 py-0.5 border border-slate-300 rounded text-[10px] text-slate-700"
                          title={ppe}
                        >
                          {p.ppeCategory?.replace('CAT_', 'Cat ')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </section>

        {/* Missing-IDs note: when the URL listed SKUs that have since
            been hard-deleted, surface that explicitly rather than
            silently shrinking the page. */}
        {orderedProducts.length < ids.length && (
          <div className="mt-4 text-xs text-amber-700 print:break-inside-avoid">
            {t('products.lineSheet.missing', {
              count: ids.length - orderedProducts.length,
            })}
          </div>
        )}
      </article>
    </div>
  )
}
