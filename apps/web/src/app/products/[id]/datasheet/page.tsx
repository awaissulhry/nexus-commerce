/**
 * F.6 — Printable product datasheet.
 *
 * Single-page, print-optimized view of a product for B2B handouts,
 * factory submissions, and "let me print this and review on paper"
 * operator workflows. The browser's native Print dialog handles
 * Save-as-PDF on every modern engine; no PDF library or server-
 * side renderer needed.
 *
 * Layout:
 *   - Header: brand/logo (if any) + product name + SKU
 *   - Two-column body: image grid (left) + spec table (right)
 *   - Footer: GTIN + IDs + generation timestamp
 *
 * Print CSS:
 *   - .no-print on the toolbar (Print + Back) so they don't appear
 *     in the printed page
 *   - body padding tightened in @media print so the printable area
 *     fills the page
 *   - page-break-inside: avoid on the spec table so a long product
 *     description can't split a row across pages
 */

import { prisma } from '@nexus/database'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import PrintButtonClient from './PrintButtonClient'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductDatasheetPage({ params }: PageProps) {
  const { id } = await params

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
      weightValue: true,
      weightUnit: true,
      dimLength: true,
      dimWidth: true,
      dimHeight: true,
      dimUnit: true,
      bulletPoints: true,
      keywords: true,
      categoryAttributes: true,
      images: {
        select: { url: true, alt: true, type: true },
        orderBy: { createdAt: 'asc' },
        take: 6,
      },
    },
  })

  if (!product) notFound()

  const brand = await prisma.brandSettings.findFirst({
    select: { companyName: true, logoUrl: true },
  })

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
  const bullets = (product.bulletPoints as string[] | null) ?? []
  const keywords = (product.keywords as string[] | null) ?? []
  const categoryAttrs =
    (product.categoryAttributes as Record<string, unknown> | null) ?? {}

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-screen">
      {/* Toolbar — hidden in print */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between dark:bg-slate-900 dark:border-slate-800">
        <Link
          href={`/products/${product.id}/edit`}
          className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 hover:bg-slate-100 rounded-md dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="w-4 h-4" /> Back to product
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
              <img
                src={brand.logoUrl}
                alt={brand.companyName ?? 'Brand'}
                className="w-12 h-12 object-contain"
              />
            ) : null}
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-slate-500">
                {brand?.companyName ?? 'Product datasheet'}
              </div>
              <h1 className="text-xl font-semibold text-slate-900 truncate">
                {product.name}
              </h1>
              <div className="text-sm font-mono text-slate-600">
                {product.sku}
                {product.brand ? ` · ${product.brand}` : ''}
              </div>
            </div>
          </div>
          <div className="text-right text-xs text-slate-500 flex-shrink-0">
            <div className="uppercase tracking-wider">Generated</div>
            <div>
              {new Date().toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </div>
          </div>
        </header>

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
              <div className="border-2 border-dashed border-slate-200 rounded p-8 text-center text-slate-400 text-sm">
                No images
              </div>
            )}
          </div>

          {/* Spec table */}
          <div className="space-y-4 text-sm">
            <table className="w-full border-collapse print:break-inside-avoid">
              <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                <SpecRow label="Type" value={product.productType ?? '—'} />
                <SpecRow label="Brand" value={product.brand ?? '—'} />
                {product.manufacturer ? (
                  <SpecRow label="Manufacturer" value={product.manufacturer} />
                ) : null}
                <SpecRow
                  label="Price"
                  value={fmtCurrency(Number(product.basePrice))}
                />
                <SpecRow label="Identifier" value={identifier} />
                {product.amazonAsin ? (
                  <SpecRow label="Amazon ASIN" value={product.amazonAsin} />
                ) : null}
                <SpecRow label="Weight" value={fmtWeight()} />
                <SpecRow label="Dimensions" value={fmtDim()} />
              </tbody>
            </table>

            {bullets.length > 0 && (
              <div className="print:break-inside-avoid">
                <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                  Key features
                </div>
                <ul className="list-disc pl-5 space-y-1">
                  {bullets.map((b, i) => (
                    <li key={i} className="text-slate-700">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        {product.description && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              Description
            </div>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {product.description}
            </p>
          </section>
        )}

        {Object.keys(categoryAttrs).length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              Attributes
            </div>
            <table className="w-full border-collapse text-sm">
              <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                {Object.entries(categoryAttrs).map(([k, v]) => (
                  <SpecRow
                    key={k}
                    label={k}
                    value={String(v ?? '—')}
                  />
                ))}
              </tbody>
            </table>
          </section>
        )}

        {keywords.length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              Keywords
            </div>
            <div className="text-sm text-slate-600 italic">
              {keywords.join(', ')}
            </div>
          </section>
        )}

        <footer className="mt-8 pt-4 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between">
          <div>{brand?.companyName ?? 'Nexus Commerce'}</div>
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

