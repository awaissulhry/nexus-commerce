/**
 * W5.48 — printable product datasheet, rebuilt.
 *
 * Single-page, print-optimized view of a product for B2B handouts,
 * factory submissions, supplier RFQs, and "let me print this and
 * review on paper" operator workflows. Browser native Print dialog
 * handles Save-as-PDF on every modern engine; no PDF library or
 * server-side renderer needed.
 *
 * Rebuild scope (vs the F.6 original):
 *   1. Fixes the .no-print bug — the original referenced a class
 *      with no CSS rule, so the toolbar printed. Replaced with
 *      Tailwind's print:hidden variant which actually hides.
 *   2. Full i18n via getServerT() — every label / section header /
 *      tooltip translates with the operator's locale cookie.
 *   3. Locale-aware product copy — when locale=it AND a
 *      ProductTranslation row exists, render translated name /
 *      description / bullets / keywords. Falls back to master
 *      copy otherwise.
 *   4. Locale-aware date formatting — "9 May 2026" in EN,
 *      "9 mag 2026" in IT.
 *   5. Expanded spec table — adds status, fulfillment, family,
 *      workflow stage, low-stock threshold, total stock, channel
 *      identifiers (Amazon/eBay/Shopify) when set.
 *   6. Variations table for parent products — child SKUs + name +
 *      price + stock, capped at 12 rows for one-page-print sanity.
 *   7. Channel coverage strip — "{n} live listings" pill row
 *      showing which marketplaces this product is published on.
 *   8. Cleaner brand fallback — drops the "Product datasheet"
 *      placeholder when no BrandSettings row exists; just shows
 *      the product name.
 *
 * Print CSS: relies on Tailwind's print: variant. .toolbar gets
 * print:hidden, body sections get print:break-inside-avoid so a
 * long description can't split a row across pages.
 */

import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import PrintButtonClient from './PrintButtonClient'
import { getServerLocale, getServerT } from '@/lib/i18n/server'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductDatasheetPage({ params }: PageProps) {
  const { id } = await params
  const locale = await getServerLocale()
  const t = await getServerT()

  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      brand: true,
      manufacturer: true,
      productType: true,
      basePrice: true,
      gtin: true,
      upc: true,
      ean: true,
      amazonAsin: true,
      ebayItemId: true,
      shopifyProductId: true,
      weightValue: true,
      weightUnit: true,
      dimLength: true,
      dimWidth: true,
      dimHeight: true,
      dimUnit: true,
      bulletPoints: true,
      keywords: true,
      categoryAttributes: true,
      status: true,
      fulfillmentMethod: true,
      totalStock: true,
      lowStockThreshold: true,
      isParent: true,
      family: { select: { label: true, code: true } },
      workflowStage: {
        select: { label: true, workflow: { select: { label: true } } },
      },
      images: {
        select: { url: true, alt: true, type: true },
        orderBy: { createdAt: 'asc' },
        take: 6,
      },
      // W5.48 — translated content for the operator's locale
      translations: {
        select: {
          language: true,
          name: true,
          description: true,
          bulletPoints: true,
          keywords: true,
        },
      },
      // W5.48 — channel coverage chip strip
      channelListings: {
        where: { isPublished: true, listingStatus: 'ACTIVE' },
        select: { channel: true, marketplace: true },
      },
      // W5.48 — variations table for parent products
      children: {
        select: {
          id: true,
          sku: true,
          name: true,
          basePrice: true,
          totalStock: true,
        },
        orderBy: { sku: 'asc' },
        take: 12,
      },
      _count: { select: { children: true } },
    },
  })

  if (!product) notFound()

  const brand = await prisma.brandSettings.findFirst({
    select: { companyName: true, logoUrl: true },
  })

  // W5.48 — pick translation matching the operator's locale; fall
  // back to master copy when missing or partial. Master content is
  // always non-null on Product (name is required); translation
  // fields can be null per-field, so we OR them in.
  const translation = product.translations.find((tr) => tr.language === locale)
  const displayName = translation?.name?.trim() || product.name
  const displayDescription =
    translation?.description?.trim() || product.description
  const displayBullets =
    (translation?.bulletPoints && translation.bulletPoints.length > 0
      ? translation.bulletPoints
      : (product.bulletPoints as string[] | null) ?? []) as string[]
  const displayKeywords =
    (translation?.keywords && translation.keywords.length > 0
      ? translation.keywords
      : (product.keywords as string[] | null) ?? []) as string[]

  const fmtCurrency = (v: number | null) =>
    v == null ? '—' : `€${Number(v).toFixed(2)}`
  const fmtDim = () => {
    const { dimLength: l, dimWidth: w, dimHeight: h, dimUnit: u } = product
    if (l == null && w == null && h == null) return '—'
    return `${l ?? '?'} × ${w ?? '?'} × ${h ?? '?'} ${u ?? ''}`.trim()
  }
  const fmtWeight = () => {
    if (product.weightValue == null) return '—'
    return `${product.weightValue} ${product.weightUnit ?? ''}`.trim()
  }
  const identifier = product.gtin ?? product.upc ?? product.ean ?? '—'
  const categoryAttrs =
    (product.categoryAttributes as Record<string, unknown> | null) ?? {}

  // W5.48 — locale-aware date format. en-GB for EN, it-IT for IT.
  // Falls back to en-GB for any future locale until we have a
  // mapping table.
  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const generatedAt = new Date().toLocaleDateString(dateLocale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  // W5.48 — channel coverage by marketplace, deduped.
  const coveragePairs = Array.from(
    new Set(
      product.channelListings.map(
        (l) => `${l.channel}${l.marketplace ? `·${l.marketplace}` : ''}`,
      ),
    ),
  ).sort()

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-screen print:bg-white">
      {/* Toolbar — Tailwind print:hidden replaces the F.6 .no-print
          class which had no CSS rule and was a no-op (the original
          toolbar printed). */}
      <div className="print:hidden sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between dark:bg-slate-900 dark:border-slate-800">
        <Link
          href={`/products/${product.id}/edit`}
          className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 hover:bg-slate-100 rounded-md dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="w-4 h-4" /> {t('products.datasheet.back')}
        </Link>
        <PrintButtonClient />
      </div>

      <article className="max-w-3xl mx-auto bg-white p-8 my-6 print:my-0 print:p-6 print:max-w-none print:bg-white dark:bg-slate-900 print:dark:bg-white">
        <header
          className="border-b-2 pb-4 mb-6 flex items-center justify-between gap-4"
          style={{ borderColor: '#0f172a' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            {brand?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logoUrl}
                alt={brand.companyName ?? ''}
                className="w-12 h-12 object-contain"
              />
            ) : null}
            <div className="min-w-0">
              {brand?.companyName && (
                <div className="text-xs uppercase tracking-wider text-slate-500">
                  {brand.companyName}
                </div>
              )}
              <h1 className="text-xl font-semibold text-slate-900 truncate">
                {displayName}
              </h1>
              <div className="text-sm font-mono text-slate-600">
                {product.sku}
                {product.brand ? ` · ${product.brand}` : ''}
              </div>
            </div>
          </div>
          <div className="text-right text-xs text-slate-500 flex-shrink-0">
            <div className="uppercase tracking-wider">
              {t('products.datasheet.generated')}
            </div>
            <div>{generatedAt}</div>
          </div>
        </header>

        {/* W5.48 — Channel coverage strip. Sits between header + body
            so the operator can see at a glance "this is live on Amazon
            IT and eBay DE" before scanning specs. */}
        <div className="mb-5 flex items-center gap-2 flex-wrap text-xs">
          <span className="uppercase tracking-wider text-slate-500 font-semibold">
            {t('products.datasheet.section.coverage')}
          </span>
          {coveragePairs.length === 0 ? (
            <span className="text-slate-500 italic">
              {t('products.datasheet.coverage.none')}
            </span>
          ) : (
            <>
              <span className="text-slate-700 font-medium">
                {t(
                  coveragePairs.length === 1
                    ? 'products.datasheet.coverage.live.one'
                    : 'products.datasheet.coverage.live.other',
                  { count: coveragePairs.length },
                )}
              </span>
              {coveragePairs.map((p) => (
                <span
                  key={p}
                  className="inline-block px-1.5 py-0.5 border border-slate-300 rounded font-mono text-[10px] text-slate-700"
                >
                  {p}
                </span>
              ))}
            </>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 print:grid-cols-2">
          {/* Image grid */}
          <div>
            {product.images.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {product.images.map((img, i) => (
                  <div
                    key={i}
                    className="aspect-square border border-slate-200 rounded overflow-hidden bg-slate-50 print:break-inside-avoid"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.alt ?? ''}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="border-2 border-dashed border-slate-200 rounded p-8 text-center text-slate-500 text-sm">
                {t('products.datasheet.noImages')}
              </div>
            )}
          </div>

          {/* Spec table — W5.48 expanded with operator-relevant fields */}
          <div className="space-y-4 text-sm">
            <table className="w-full border-collapse print:break-inside-avoid">
              <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                <SpecRow
                  label={t('products.col.productType')}
                  value={product.productType ?? '—'}
                />
                <SpecRow
                  label={t('products.datasheet.specs.identifier')}
                  value={identifier}
                />
                <SpecRow
                  label={t('products.col.brand')}
                  value={product.brand ?? '—'}
                />
                {product.manufacturer && (
                  <SpecRow
                    label={t('products.datasheet.specs.manufacturer')}
                    value={product.manufacturer}
                  />
                )}
                <SpecRow
                  label={t('products.col.price')}
                  value={fmtCurrency(Number(product.basePrice))}
                />
                <SpecRow
                  label={t('products.col.stock')}
                  value={String(product.totalStock)}
                />
                {product.lowStockThreshold > 0 && (
                  <SpecRow
                    label={t('products.datasheet.specs.lowStockAt')}
                    value={String(product.lowStockThreshold)}
                  />
                )}
                {product.fulfillmentMethod && (
                  <SpecRow
                    label={t('products.col.fulfillment')}
                    value={product.fulfillmentMethod}
                  />
                )}
                {product.family && (
                  <SpecRow
                    label={t('products.col.family')}
                    value={`${product.family.label} (${product.family.code})`}
                  />
                )}
                {product.workflowStage && (
                  <SpecRow
                    label={t('products.col.workflowStage')}
                    value={`${product.workflowStage.label} · ${product.workflowStage.workflow.label}`}
                  />
                )}
                <SpecRow
                  label={t('products.datasheet.specs.weight')}
                  value={fmtWeight()}
                />
                <SpecRow
                  label={t('products.datasheet.specs.dimensions')}
                  value={fmtDim()}
                />
                {product.amazonAsin && (
                  <SpecRow
                    label={t('products.datasheet.specs.amazonAsin')}
                    value={product.amazonAsin}
                  />
                )}
                {product.ebayItemId && (
                  <SpecRow
                    label={t('products.datasheet.specs.ebayId')}
                    value={product.ebayItemId}
                  />
                )}
                {product.shopifyProductId && (
                  <SpecRow
                    label={t('products.datasheet.specs.shopifyId')}
                    value={product.shopifyProductId}
                  />
                )}
              </tbody>
            </table>

            {displayBullets.length > 0 && (
              <div className="print:break-inside-avoid">
                <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                  {t('products.datasheet.section.bullets')}
                </div>
                <ul className="list-disc pl-5 space-y-1">
                  {displayBullets.map((b, i) => (
                    <li key={i} className="text-slate-700">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {displayDescription && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t('products.datasheet.section.description')}
            </div>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {displayDescription}
            </p>
          </section>
        )}

        {/* W5.48 — Variations table for parent products. Capped at 12
            rows so a many-variant product still prints in 1-2 pages.
            The Cols match the most-common B2B handout questions:
            "what's the SKU, what does it look like, what's it cost,
            do you have stock?". */}
        {product.isParent && product.children.length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t(
                product._count.children === 1
                  ? 'products.datasheet.section.variations.one'
                  : 'products.datasheet.section.variations.other',
                { count: product._count.children },
              )}
            </div>
            <table className="w-full border-collapse text-sm">
              <thead className="border-b-2 border-slate-200">
                <tr className="text-left">
                  <th className="py-1.5 pr-3 font-semibold text-slate-600">
                    {t('products.datasheet.section.variations.col.sku')}
                  </th>
                  <th className="py-1.5 pr-3 font-semibold text-slate-600">
                    {t('products.datasheet.section.variations.col.name')}
                  </th>
                  <th className="py-1.5 pr-3 font-semibold text-slate-600 text-right">
                    {t('products.datasheet.section.variations.col.price')}
                  </th>
                  <th className="py-1.5 font-semibold text-slate-600 text-right">
                    {t('products.datasheet.section.variations.col.stock')}
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                {product.children.map((c) => (
                  <tr key={c.id}>
                    <td className="py-1.5 pr-3 font-mono text-slate-700">
                      {c.sku}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-900 truncate">
                      {c.name}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-slate-900">
                      {fmtCurrency(Number(c.basePrice))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-slate-900">
                      {c.totalStock}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {Object.keys(categoryAttrs).length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t('products.datasheet.section.attributes')}
            </div>
            <table className="w-full border-collapse text-sm">
              <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                {Object.entries(categoryAttrs).map(([k, v]) => (
                  <SpecRow key={k} label={k} value={String(v ?? '—')} />
                ))}
              </tbody>
            </table>
          </section>
        )}

        {displayKeywords.length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t('products.datasheet.section.keywords')}
            </div>
            <div className="text-sm text-slate-600 italic">
              {displayKeywords.join(', ')}
            </div>
          </section>
        )}

        <footer className="mt-8 pt-4 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
          <div>{brand?.companyName ?? ''}</div>
          <div className="font-mono">{product.sku}</div>
        </footer>
      </article>
    </div>
  )
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="py-1.5 pr-3 text-slate-500 font-medium align-top w-32">
        {label}
      </td>
      <td className="py-1.5 text-slate-900">{value}</td>
    </tr>
  )
}
