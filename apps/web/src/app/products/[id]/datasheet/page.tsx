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
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import PrintButtonClient from './PrintButtonClient'
import PrintBodyFlag from './PrintBodyFlag'
import DatasheetQR from './DatasheetQR'
import DatasheetModePicker from './DatasheetModePicker'
import DatasheetLocalePicker from './DatasheetLocalePicker'
import DatasheetPaperPicker from './DatasheetPaperPicker'
import { Barcode128 } from '@/components/ui/Barcode128'
import {
  amazonTld,
  prettyChannelMarketplace,
} from '@/lib/marketplace-code'
import { getServerLocale, getServerT } from '@/lib/i18n/server'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// DS.6 — Three audience presets. Each one drives a different
// visibility map for fields below. The default is B2B because that
// is the most common print: a distributor / wholesaler asking for
// a spec sheet. Internal is for ops review (stock, cost, IDs all
// visible); Public is for a printed catalog handed to a retail
// customer (no internal identifiers, no inventory). Mode is read
// from the `?mode=` query, then a `nexus:datasheet-mode` cookie
// the client picker writes, then this default.
type AudienceMode = 'b2b' | 'internal' | 'public'
const DEFAULT_MODE: AudienceMode = 'b2b'

function parseMode(v: string | string[] | undefined): AudienceMode | null {
  if (typeof v !== 'string') return null
  return v === 'b2b' || v === 'internal' || v === 'public' ? v : null
}

// DS.8 — Paper sizes the @page rule supports. A4 is the EU + Italian
// default; Letter for US distributors; A5 for compact pocket spec
// cards / counter handouts. Dimensions in mm match the CSS @page
// `size` keyword so we can interpolate directly.
type Paper = 'a4' | 'letter' | 'a5'
const PAPER_SIZES: Record<Paper, string> = {
  a4: 'A4',
  letter: 'Letter',
  a5: 'A5',
}
function parsePaper(v: string | string[] | undefined): Paper | null {
  if (typeof v !== 'string') return null
  return v === 'a4' || v === 'letter' || v === 'a5' ? v : null
}

// DS.8 — Per-view locale override. Operators sometimes need to PRINT
// in a language other than the one they READ the app in (Italian
// operator generating an English handout). `?locale=` wins over the
// app-wide cookie. Only en + it ship today; new locales added here
// must also exist in the i18n catalogs + the dateLocale switch below.
type Locale = 'en' | 'it'
function parseLocale(v: string | string[] | undefined): Locale | null {
  if (typeof v !== 'string') return null
  return v === 'en' || v === 'it' ? v : null
}

export default async function ProductDatasheetPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params
  const sp = await searchParams
  // DS.8 — Per-view locale override. ?locale= wins over the cookie
  // so the operator can print in a different language than they
  // browse in.
  const localeOverride = parseLocale(sp.locale)
  const locale = localeOverride ?? (await getServerLocale())
  const t = await getServerT(locale)

  // DS.6 — Audience mode resolution: querystring wins, then the
  // cookie the picker writes on change, then the b2b default.
  const cookieStore = await cookies()
  const mode: AudienceMode =
    parseMode(sp.mode) ??
    parseMode(cookieStore.get('nexus:datasheet-mode')?.value) ??
    DEFAULT_MODE
  // DS.8 — Paper size: querystring > cookie > A4 default.
  const paper: Paper =
    parsePaper(sp.paper) ??
    parsePaper(cookieStore.get('nexus:datasheet-paper')?.value) ??
    'a4'
  const showStock = mode === 'internal'
  const showInternalIds = mode !== 'public'
  const showInternalMeta = mode === 'internal' // family, workflow, fulfillment, low-stock
  const showChannelCoverage = mode !== 'public'
  const showKeywords = mode === 'internal'

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
      // DS.8 — version stamp + last-update timestamp shown in the
      // footer so a B2B distributor knows whether the printed copy
      // is current. version bumps on every PATCH (NN.1 optimistic
      // concurrency).
      version: true,
      updatedAt: true,
      fulfillmentMethod: true,
      totalStock: true,
      lowStockThreshold: true,
      isParent: true,
      // DS.4 — EU compliance master data (H.16 + W7.1 schema fields).
      // All nullable; the compliance section auto-hides when nothing
      // resolves so non-PPE catalogs don't get an empty box.
      hsCode: true,
      countryOfOrigin: true,
      ppeCategory: true,
      hazmatClass: true,
      hazmatUnNumber: true,
      family: { select: { label: true, code: true } },
      workflowStage: {
        select: { label: true, workflow: { select: { label: true } } },
      },
      // DS.2 — pull sortOrder so the hero-first ranking can honor
      // the operator's drag-drop order. Fetch up to 8 so the JS
      // pass can drop SWATCH/DIAGRAM and still fill hero + 4
      // thumbnails comfortably.
      images: {
        select: { url: true, alt: true, type: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 8,
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
      // DS.4 — compliance certificates (CE, EN_13595, REACH, …).
      // Sorted with currently-valid certs first so a B2B handout
      // never leads with an expired CE marking.
      certificates: {
        select: {
          certType: true,
          certNumber: true,
          standard: true,
          issuingBody: true,
          issuedAt: true,
          expiresAt: true,
        },
        orderBy: [{ expiresAt: 'desc' }, { issuedAt: 'desc' }],
        take: 6,
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

  // DS.9 — BrandKit tagline + review aggregate run in parallel with
  // BrandSettings. BrandKit is keyed by Product.brand (e.g. "Xavia").
  // Review aggregate hits the per-product index and is cheap; the
  // _avg/_count call is one round-trip.
  const [brand, brandKit, reviewStats] = await Promise.all([
    prisma.brandSettings.findFirst({
      // DS.4 — pull address + VAT fields so the compliance block can
      // render the EU Responsible Person (GPSR Art. 16). For Xavia,
      // they're an Italian-established brand so BrandSettings IS the
      // responsible person.
      select: {
        companyName: true,
        logoUrl: true,
        addressLines: true,
        piva: true,
        taxId: true,
        contactEmail: true,
      },
    }),
    product.brand
      ? prisma.brandKit.findUnique({
          where: { brand: product.brand },
          select: { tagline: true },
        })
      : Promise.resolve(null),
    prisma.review.aggregate({
      where: { productId: product.id, rating: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ])

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

  // DS.8 — Locale-aware currency formatting via Intl. en-GB renders
  // €1,234.56, it-IT renders €1.234,56 — both correct for their
  // audiences. Prior code hard-coded the dot decimal which read
  // wrong to Italian B2B buyers.
  const currencyLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const currencyFormatter = new Intl.NumberFormat(currencyLocale, {
    style: 'currency',
    currency: 'EUR',
  })
  const fmtCurrency = (v: number | null) =>
    v == null ? '—' : currencyFormatter.format(v)
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
  // DS.3 — Code128 needs an actual code value; the em-dash sentinel
  // would otherwise render as a single-character barcode. Only show
  // the bars when there's a real identifier to encode.
  const identifierForBarcode =
    product.gtin ?? product.upc ?? product.ean ?? null
  const categoryAttrs =
    (product.categoryAttributes as Record<string, unknown> | null) ?? {}

  // DS.3 — Resolve a customer-facing URL for the header QR. Prefer
  // Amazon (Xavia's primary surface), then eBay, then the brand-
  // configured catalog URL, then null. The marketplace TLD is picked
  // from the first ACTIVE Amazon listing so the QR lands on the
  // right country page rather than always sending Italian buyers to
  // amazon.com.
  let qrUrl: string | null = null
  if (product.amazonAsin) {
    const firstAmazon = product.channelListings.find(
      (l) => l.channel === 'AMAZON',
    )
    const tld = firstAmazon ? amazonTld(firstAmazon.marketplace) : 'it'
    qrUrl = `https://www.amazon.${tld}/dp/${product.amazonAsin}`
  } else if (product.ebayItemId) {
    qrUrl = `https://www.ebay.com/itm/${product.ebayItemId}`
  }

  // W5.48 — locale-aware date format. en-GB for EN, it-IT for IT.
  // Falls back to en-GB for any future locale until we have a
  // mapping table.
  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const generatedAt = new Date().toLocaleDateString(dateLocale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  // W5.48 + DS.3 — channel coverage by marketplace, deduped. DS.3
  // upgrades the raw "AMAZON·IT" string to a pretty "Amazon Italy"
  // label so the strip reads as a sentence on a B2B handout.
  const coveragePairs = Array.from(
    new Map(
      product.channelListings.map((l) => [
        `${l.channel}|${l.marketplace ?? ''}`,
        prettyChannelMarketplace(l.channel, l.marketplace),
      ]),
    ).values(),
  ).sort()

  // DS.2 — Hero-first image ranking. The original F.6/W5.48 code
  // grabbed the 6 oldest uploads by createdAt, which on a real Xavia
  // SKU means the hero is whatever happened to land first in the
  // upload queue (often a swatch or detail shot, rarely the MAIN).
  //
  // Ranking pass (stable):
  //   1. type === 'MAIN' wins — Amazon-grade MAIN shot is the hero.
  //   2. SWATCH and DIAGRAM sink to the bottom — color chips and
  //      size charts shouldn't anchor a B2B handout. They stay
  //      eligible as thumbnails if nothing better exists.
  //   3. Within a bucket, sortOrder asc (drag-drop wins), then
  //      createdAt asc (the previous deterministic fallback).
  //
  // The DB query already pulls sortOrder asc + createdAt asc so the
  // base order is stable; this pass only re-buckets by type.
  const rankedImages = [...product.images].sort((a, b) => {
    const aMain = a.type === 'MAIN'
    const bMain = b.type === 'MAIN'
    if (aMain !== bMain) return aMain ? -1 : 1
    const aSink = a.type === 'SWATCH' || a.type === 'DIAGRAM'
    const bSink = b.type === 'SWATCH' || b.type === 'DIAGRAM'
    if (aSink !== bSink) return aSink ? 1 : -1
    return 0 // preserve DB order
  })
  const heroImage = rankedImages[0] ?? null
  const thumbImages = rankedImages.slice(1, 5)

  // DS.8 — Translation coverage chip. When the operator's print
  // locale != 'en' (master), check how many translatable fields
  // (name, description, bullets, keywords) the translation row
  // actually covers. The chip surfaces this so an Italian operator
  // catches a half-translated SKU before sending it to a buyer.
  type CoverageState = 'full' | 'partial' | 'none' | 'master'
  const translationCoverage: CoverageState = (() => {
    if (locale === 'en') return 'master' // master is English-first
    if (!translation) return 'none'
    let covered = 0
    let total = 0
    if (product.name) {
      total++
      if (translation.name?.trim()) covered++
    }
    if (product.description) {
      total++
      if (translation.description?.trim()) covered++
    }
    if ((product.bulletPoints as string[] | null)?.length) {
      total++
      if (translation.bulletPoints && translation.bulletPoints.length > 0)
        covered++
    }
    if ((product.keywords as string[] | null)?.length) {
      total++
      if (translation.keywords && translation.keywords.length > 0) covered++
    }
    if (total === 0) return 'full' // nothing to translate
    if (covered === total) return 'full'
    if (covered === 0) return 'none'
    return 'partial'
  })()

  // DS.8 — Version stamp for the footer. NN.1 bumps `version` on
  // every PATCH; pairing it with the last-update timestamp gives a
  // B2B reader two ways to spot a stale handout.
  const versionTime = product.updatedAt.toLocaleString(currencyLocale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
  const versionStamp = `v${product.version} · ${versionTime}`

  const isDraft = product.status === 'DRAFT'

  // DS.9 — Brand-voice tagline + customer review aggregate. Tagline
  // comes from BrandKit (operator-owned brand identity); rating
  // averages across ALL channels' reviews already ingested by the
  // SR.* series. Both render only when present — empty product gets
  // no awkward "★ — · 0 reviews" stub.
  const tagline = brandKit?.tagline?.trim() || null
  const avgRating = reviewStats._avg.rating
  const reviewCount = reviewStats._count._all
  const showReviewBadge = avgRating != null && reviewCount > 0
  const ratingFormatted = avgRating
    ? new Intl.NumberFormat(currencyLocale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(avgRating)
    : null

  // DS.4 — Compliance & customs block. Pulls together the H.16 +
  // W7.1 master-data fields (HS code, country of origin, PPE,
  // hazmat), the cert list, and the BrandSettings responsible-
  // person address (GPSR Art. 16). Auto-hide when nothing
  // resolves — non-PPE catalogs shouldn't see an empty section.
  const countryDisplay = (() => {
    if (!product.countryOfOrigin) return null
    try {
      const regionNames = new Intl.DisplayNames(
        [locale === 'it' ? 'it' : 'en'],
        { type: 'region' },
      )
      return (
        regionNames.of(product.countryOfOrigin.toUpperCase()) ??
        product.countryOfOrigin
      )
    } catch {
      return product.countryOfOrigin
    }
  })()
  const ppeLabel =
    product.ppeCategory === 'CAT_I'
      ? t('products.datasheet.ppe.catI')
      : product.ppeCategory === 'CAT_II'
        ? t('products.datasheet.ppe.catII')
        : product.ppeCategory === 'CAT_III'
          ? t('products.datasheet.ppe.catIII')
          : null
  const hazmatLabel = (() => {
    if (!product.hazmatClass && !product.hazmatUnNumber) return null
    const parts = []
    if (product.hazmatUnNumber) parts.push(product.hazmatUnNumber)
    if (product.hazmatClass) parts.push(`Class ${product.hazmatClass}`)
    return parts.join(' · ')
  })()
  const hasResponsiblePerson =
    !!brand?.companyName ||
    (brand?.addressLines?.length ?? 0) > 0 ||
    !!brand?.piva ||
    !!brand?.taxId
  const hasComplianceBlock =
    !!product.hsCode ||
    !!countryDisplay ||
    !!ppeLabel ||
    !!hazmatLabel ||
    product.certificates.length > 0 ||
    hasResponsiblePerson

  return (
    <div className="bg-slate-50 dark:bg-slate-950 min-h-screen print:bg-white">
      {/* DS.1 — Flip body[data-print-datasheet] on mount so the
          scoped @media print stylesheet in globals.css fires. The
          flag stays attached for as long as this page is mounted;
          navigating away triggers cleanup so subsequent prints on
          other pages aren't accidentally datasheet-scoped. */}
      <PrintBodyFlag />
      {/* DS.8 — Inline @page rule for the chosen paper size. @page
          can't be expressed as a Tailwind print: utility, so we
          write the rule directly. Margins stay at 14mm to match
          DS.1. */}
      <style>{`@page { size: ${PAPER_SIZES[paper]}; margin: 14mm; }`}</style>
      {/* Toolbar — Tailwind print:hidden replaces the F.6 .no-print
          class which had no CSS rule and was a no-op (the original
          toolbar printed). */}
      <div className="print:hidden sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between gap-3 dark:bg-slate-900 dark:border-slate-800">
        <Link
          href={`/products/${product.id}/edit`}
          className="inline-flex items-center gap-1.5 h-8 px-3 text-md text-slate-700 hover:bg-slate-100 rounded-md dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="w-4 h-4" /> {t('products.datasheet.back')}
        </Link>
        {/* DS.6 — audience-mode picker; DS.8 — locale + paper pickers.
            Stacked into a single flex group so the toolbar stays one
            line at desktop width; wraps on narrow viewports. */}
        <div className="flex items-center gap-2 flex-wrap">
          <DatasheetModePicker current={mode} />
          <DatasheetLocalePicker current={locale} />
          <DatasheetPaperPicker current={paper} />
        </div>
        <PrintButtonClient sku={product.sku} />
      </div>

      <article
        data-print-region="datasheet"
        className="relative max-w-3xl mx-auto bg-white p-8 my-6 print:my-0 print:p-0 print:max-w-none print:bg-white dark:bg-slate-900 print:dark:bg-white"
      >
        {/* DS.8 — DRAFT watermark. Big diagonal red text behind the
            content when product.status === 'DRAFT'. Marked
            aria-hidden because the chip below the title already
            announces the same fact to screen readers. */}
        {isDraft && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center select-none print:opacity-30 opacity-15"
          >
            <span
              className="font-semibold tracking-widest text-red-600"
              style={{
                fontSize: '8rem',
                transform: 'rotate(-30deg)',
              }}
            >
              {t('products.datasheet.draftWatermark')}
            </span>
          </div>
        )}
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
              {/* DS.9 — Brand-voice tagline. Italic, one-line — sits
                  immediately under the product name where a reader's
                  eye naturally lands next. Hidden when BrandKit has
                  no tagline for this brand. */}
              {tagline && (
                <div className="text-sm italic text-slate-600 truncate mt-0.5">
                  {tagline}
                </div>
              )}
              {/* DS.9 — Aggregate review badge. Shown when the SR.*
                  ingest pipeline has at least one rated review for
                  this SKU. Filled star + one-decimal rating + count;
                  the count is the most-asked-for proof-of-popularity
                  on a B2B handout. */}
              {showReviewBadge && (
                <div className="text-sm text-slate-700 mt-0.5 inline-flex items-center gap-1">
                  <span className="text-amber-500" aria-hidden>
                    ★
                  </span>
                  <span className="font-medium tabular-nums">
                    {ratingFormatted}
                  </span>
                  <span className="text-slate-500">·</span>
                  <span className="text-slate-500">
                    {t(
                      reviewCount === 1
                        ? 'products.datasheet.reviews.one'
                        : 'products.datasheet.reviews.other',
                      { count: reviewCount },
                    )}
                  </span>
                </div>
              )}
              <div className="text-sm font-mono text-slate-600 flex items-center gap-2 flex-wrap mt-1">
                <span>
                  {product.sku}
                  {product.brand ? ` · ${product.brand}` : ''}
                </span>
                {/* DS.8 — DRAFT chip mirrors the watermark with
                    screen-reader-friendly text. */}
                {isDraft && (
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-red-100 text-red-700 font-semibold">
                    {t('products.datasheet.draftWatermark')}
                  </span>
                )}
                {/* DS.8 — Translation-coverage chip. Visible only when
                    the print locale is non-master (it). Hides on EN
                    since master content IS English. */}
                {translationCoverage !== 'master' && (
                  <span
                    className={
                      'inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium ' +
                      (translationCoverage === 'full'
                        ? 'bg-emerald-100 text-emerald-700'
                        : translationCoverage === 'partial'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-slate-200 text-slate-700')
                    }
                  >
                    {t(
                      `products.datasheet.translation.${translationCoverage}`,
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* DS.3 — QR + generated-stamp stack. QR links to the live
              customer-facing listing (Amazon → eBay → null) so a B2B
              buyer can scan the handout and land on the product page
              in the marketplace it's actually published on. When no
              identifier is available the slot collapses to just the
              date — never the empty box from a missing QR. */}
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {qrUrl && <DatasheetQR url={qrUrl} size={84} />}
            <div className="text-right text-xs text-slate-500">
              <div className="uppercase tracking-wider">
                {t('products.datasheet.generated')}
              </div>
              <div>{generatedAt}</div>
            </div>
          </div>
        </header>

        {/* W5.48 — Channel coverage strip. Sits between header + body
            so the operator can see at a glance "this is live on Amazon
            IT and eBay DE" before scanning specs.
            DS.6 — Suppressed in public mode (a retail catalog handout
            shouldn't enumerate every marketplace we operate on). */}
        {showChannelCoverage && (
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
                    className="inline-block px-1.5 py-0.5 border border-slate-300 rounded text-[10px] text-slate-700"
                  >
                    {p}
                  </span>
                ))}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 print:grid-cols-2">
          {/* DS.2 — Image gallery: hero (large) + up to 4 thumbnails
              in a 2×2 grid. The hero gets a 4:3 frame so it lands at
              comparable visual weight to the spec table on its right;
              thumbnails stay square so the grid reads cleanly even
              when image counts vary. */}
          <div>
            {heroImage ? (
              <div className="space-y-2">
                <div className="aspect-[4/3] border border-slate-200 rounded overflow-hidden bg-slate-50 print:break-inside-avoid">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={heroImage.url}
                    alt={heroImage.alt ?? displayName}
                    className="w-full h-full object-cover"
                  />
                </div>
                {thumbImages.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {thumbImages.map((img, i) => (
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
                )}
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
                {/* DS.3 — Identifier row with embedded Code128 barcode.
                    The barcode is the highest-value scannable on a
                    warehouse handout (GTIN/EAN), so we drop the bars
                    immediately under the value text rather than burying
                    them in a separate section. Width is capped so a
                    13-digit EAN doesn't stretch past the right column. */}
                <tr>
                  <td className="py-1.5 pr-3 text-slate-500 font-medium align-top w-32">
                    {t('products.datasheet.specs.identifier')}
                  </td>
                  <td className="py-1.5 text-slate-900">
                    <div className="font-mono">{identifier}</div>
                    {identifierForBarcode && (
                      <div className="mt-1">
                        <Barcode128
                          value={identifierForBarcode}
                          maxWidthPx={200}
                          height={40}
                          showText={false}
                        />
                      </div>
                    )}
                  </td>
                </tr>
                <SpecRow
                  label={t('products.col.brand')}
                  value={product.brand ?? '—'}
                />
                {/* DS.6 — Manufacturer is internal info on a public
                    handout (we don't expose factory relationships to
                    retail buyers), but it IS relevant for B2B sourcing
                    + internal review. */}
                {product.manufacturer && mode !== 'public' && (
                  <SpecRow
                    label={t('products.datasheet.specs.manufacturer')}
                    value={product.manufacturer}
                  />
                )}
                <SpecRow
                  label={t('products.col.price')}
                  value={fmtCurrency(Number(product.basePrice))}
                />
                {/* DS.6 — Stock visibility: internal only. B2B buyers
                    don't need our inventory levels; public catalogs
                    definitely don't. */}
                {showStock && (
                  <SpecRow
                    label={t('products.col.stock')}
                    value={String(product.totalStock)}
                  />
                )}
                {showInternalMeta && product.lowStockThreshold > 0 && (
                  <SpecRow
                    label={t('products.datasheet.specs.lowStockAt')}
                    value={String(product.lowStockThreshold)}
                  />
                )}
                {showInternalMeta && product.fulfillmentMethod && (
                  <SpecRow
                    label={t('products.col.fulfillment')}
                    value={product.fulfillmentMethod}
                  />
                )}
                {showInternalMeta && product.family && (
                  <SpecRow
                    label={t('products.col.family')}
                    value={`${product.family.label} (${product.family.code})`}
                  />
                )}
                {showInternalMeta && product.workflowStage && (
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
                {/* DS.6 — Channel identifiers hidden in public mode.
                    They're useful for a B2B buyer who wants to verify
                    the listing exists, but a retail catalog shouldn't
                    leak our marketplace operating presence. */}
                {showInternalIds && product.amazonAsin && (
                  <SpecRow
                    label={t('products.datasheet.specs.amazonAsin')}
                    value={product.amazonAsin}
                  />
                )}
                {showInternalIds && product.ebayItemId && (
                  <SpecRow
                    label={t('products.datasheet.specs.ebayId')}
                    value={product.ebayItemId}
                  />
                )}
                {showInternalIds && product.shopifyProductId && (
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
                  <th
                    className={`py-1.5 pr-3 font-semibold text-slate-600 text-right ${showStock ? '' : 'pr-0'}`}
                  >
                    {t('products.datasheet.section.variations.col.price')}
                  </th>
                  {/* DS.6 — Per-variant stock follows the same rule as
                      the master Stock spec row: internal mode only. */}
                  {showStock && (
                    <th className="py-1.5 font-semibold text-slate-600 text-right">
                      {t('products.datasheet.section.variations.col.stock')}
                    </th>
                  )}
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
                    <td
                      className={`py-1.5 text-right tabular-nums text-slate-900 ${showStock ? 'pr-3' : ''}`}
                    >
                      {fmtCurrency(Number(c.basePrice))}
                    </td>
                    {showStock && (
                      <td className="py-1.5 text-right tabular-nums text-slate-900">
                        {c.totalStock}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* DS.4 — Compliance & customs. Sits between Variations and
            Attributes because: it's a structured block (table-shaped,
            not key/value soup like Attributes), and a B2B reader
            scanning top-to-bottom expects regulated-product data
            before catalog metadata. Auto-hides on non-PPE catalogs. */}
        {hasComplianceBlock && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t('products.datasheet.section.compliance')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              {/* Left: customs + safety pillars */}
              <table className="w-full border-collapse">
                <tbody className="[&>tr]:border-b [&>tr]:border-slate-100">
                  {countryDisplay && (
                    <SpecRow
                      label={t('products.datasheet.specs.countryOfOrigin')}
                      value={countryDisplay}
                    />
                  )}
                  {product.hsCode && (
                    <SpecRow
                      label={t('products.datasheet.specs.hsCode')}
                      value={product.hsCode}
                    />
                  )}
                  {ppeLabel && (
                    <SpecRow
                      label={t('products.datasheet.specs.ppeCategory')}
                      value={ppeLabel}
                    />
                  )}
                  {hazmatLabel && (
                    <SpecRow
                      label={t('products.datasheet.specs.hazmat')}
                      value={hazmatLabel}
                    />
                  )}
                </tbody>
              </table>
              {/* Right: EU responsible person + certificates */}
              <div className="space-y-3">
                {hasResponsiblePerson && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
                      {t('products.datasheet.compliance.responsiblePerson')}
                    </div>
                    <div className="text-slate-900 leading-tight">
                      {brand?.companyName && <div>{brand.companyName}</div>}
                      {brand?.addressLines?.map((line, i) => (
                        <div key={i} className="text-slate-700">
                          {line}
                        </div>
                      ))}
                      {brand?.piva && (
                        <div className="text-slate-700 font-mono text-xs mt-0.5">
                          P.IVA {brand.piva}
                        </div>
                      )}
                      {!brand?.piva && brand?.taxId && (
                        <div className="text-slate-700 font-mono text-xs mt-0.5">
                          {brand.taxId}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {product.certificates.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
                      {t('products.datasheet.compliance.certificates')}
                    </div>
                    <ul className="space-y-1">
                      {product.certificates.map((c, i) => {
                        const expired =
                          c.expiresAt != null && c.expiresAt < new Date()
                        return (
                          <li key={i} className="text-slate-700">
                            <span className="font-medium text-slate-900">
                              {c.certType.replace(/_/g, ' ')}
                            </span>
                            {c.standard && (
                              <span className="ml-1 text-slate-600">
                                · {c.standard}
                              </span>
                            )}
                            {c.certNumber && (
                              <span className="ml-1 font-mono text-xs text-slate-500">
                                #{c.certNumber}
                              </span>
                            )}
                            {c.issuingBody && (
                              <div className="text-xs text-slate-500 ml-0">
                                {c.issuingBody}
                                {expired && (
                                  <span className="ml-2 text-red-600 font-medium">
                                    {t('products.datasheet.compliance.expired')}
                                  </span>
                                )}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </div>
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

        {/* DS.6 — Keywords are SEO/listing optimisation data; useful
            for internal review (operator catches missing localisation
            etc.) but not for B2B or public handouts. */}
        {showKeywords && displayKeywords.length > 0 && (
          <section className="mt-6 print:break-inside-avoid">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
              {t('products.datasheet.section.keywords')}
            </div>
            <div className="text-sm text-slate-600 italic">
              {displayKeywords.join(', ')}
            </div>
          </section>
        )}

        <footer className="mt-8 pt-4 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between gap-4">
          <div>{brand?.companyName ?? ''}</div>
          {/* DS.8 — Version stamp. Reader can verify they have the
              current revision by matching this against the master
              catalog. Tracks NN.1 optimistic-concurrency bumps. */}
          <div className="font-mono text-[10px] text-slate-400">
            {versionStamp}
          </div>
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
