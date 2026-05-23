/**
 * ATM.13 — Launch readiness checklist.
 *
 * Mounted on the Overview tab beside the drift panel. Consolidates
 * signals from across the hub's other tabs into a single per-market
 * "is this SKU ready to launch here?" scorecard.
 *
 * For each active marketplace, walks these checks:
 *
 *   master_images   Master gallery carries ≥1 image
 *   required_lang   ProductTranslation exists + reviewed for the
 *                   market's primary consumer language (or 'en'
 *                   when the master is the primary)
 *   ce_or_ukca      CE valid for EU markets / UKCA valid for UK
 *                   (matches ATM.10 logic)
 *   gpsr_address    BrandSettings carries an EU-establishable
 *                   responsible-person address (EU + UK markets)
 *   hs_code         Master HS code declared (for customs)
 *   listing_active  ChannelListing is published AND status=ACTIVE
 *
 * Each row shows: market label · ✓/✗ per check · overall READY /
 * NOT READY chip. Operators get the launch go/no-go in one row
 * per market.
 *
 * Saved views / preset selection (other VR.13 scope items) are
 * skipped: the hub is single-SKU detail, those concepts belong
 * to /products grid. Bulk pricing changes defer to their own
 * phase since the write path needs preview-diff + audit.
 */

import { prisma } from '@nexus/database'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Rocket,
  XCircle,
} from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

interface LaunchReadinessProps {
  productId: string
  t: Awaited<ReturnType<typeof getServerT>>
}

const MARKETPLACE_TO_LANG: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', NL: 'nl',
  BE: 'nl', PL: 'pl', CZ: 'cs', SE: 'sv', UK: 'en',
  TR: 'tr', EG: 'ar', AE: 'ar', SA: 'ar', IN: 'en',
  US: 'en', CA: 'en', MX: 'es', BR: 'pt',
  JP: 'ja', AU: 'en', SG: 'en',
}

// Compact subset of the ATM.10 market profile — just the launch-
// blocking subset.
const MARKET_CE: Record<string, 'ce' | 'ukca' | 'none'> = {
  IT: 'ce', DE: 'ce', FR: 'ce', ES: 'ce', NL: 'ce',
  BE: 'ce', PL: 'ce', CZ: 'ce', SE: 'ce',
  UK: 'ukca',
  TR: 'ce', AE: 'ce', SA: 'ce', EG: 'ce',
}
const MARKET_REQUIRES_GPSR = new Set([
  'IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'PL', 'CZ', 'SE', 'UK',
])

interface CheckResult {
  key: string
  labelKey: string
  pass: boolean
  /** Operator-facing detail when failing. */
  detail?: string
}

interface MarketRow {
  key: string
  channel: string
  marketplace: string
  label: string
  checks: CheckResult[]
  ready: boolean
}

export default async function LaunchReadiness({
  productId,
  t,
}: LaunchReadinessProps) {
  const [master, translations, certs, listings, brand] =
    await Promise.all([
      prisma.product
        .findUnique({
          where: { id: productId },
          select: {
            hsCode: true,
            _count: { select: { images: true } },
          },
        })
        .catch(() => null),
      prisma.productTranslation
        .findMany({
          where: { productId },
          select: {
            language: true,
            name: true,
            description: true,
            reviewedAt: true,
            source: true,
          },
        })
        .catch(() => [] as never[]),
      prisma.productCertificate
        .findMany({
          where: { productId },
          select: { certType: true, expiresAt: true },
        })
        .catch(() => [] as never[]),
      prisma.channelListing
        .findMany({
          where: { productId },
          select: {
            channel: true,
            marketplace: true,
            isPublished: true,
            listingStatus: true,
          },
          distinct: ['channel', 'marketplace'],
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        })
        .catch(() => [] as never[]),
      prisma.brandSettings
        .findFirst({
          select: { companyName: true, addressLines: true, piva: true },
        })
        .catch(() => null),
    ])

  if (listings.length === 0) {
    // No markets to launch on — render nothing rather than a noisy
    // empty card.
    return null
  }

  const hasMasterImages = (master?._count.images ?? 0) > 0
  const hasHsCode = !!master?.hsCode
  const hasResponsiblePerson =
    !!brand?.companyName ||
    (brand?.addressLines?.length ?? 0) > 0 ||
    !!brand?.piva

  const certByType = new Map(certs.map((c) => [c.certType, c]))
  const hasValidCe = (() => {
    const c = certByType.get('CE')
    if (!c) return false
    if (c.expiresAt && c.expiresAt.getTime() < Date.now()) return false
    return true
  })()
  const hasValidUkca = (() => {
    const c = certByType.get('UKCA')
    if (!c) return false
    if (c.expiresAt && c.expiresAt.getTime() < Date.now()) return false
    return true
  })()

  const langByLang = new Map(translations.map((tr) => [tr.language, tr]))
  const hasReadyTranslation = (lang: string): boolean => {
    if (lang === 'en') return true // master IS English-first
    const tr = langByLang.get(lang)
    if (!tr) return false
    if (
      tr.source &&
      (tr.source === 'ai-gemini' || tr.source === 'ai-anthropic') &&
      tr.reviewedAt == null
    ) {
      return false // AI-unreviewed doesn't ship
    }
    return !!(tr.name && tr.name.trim().length > 0)
  }

  const rows: MarketRow[] = listings.map((l) => {
    const checks: CheckResult[] = []

    // Listing active
    const listingOk = l.isPublished && l.listingStatus === 'ACTIVE'
    checks.push({
      key: 'listing_active',
      labelKey: 'products.datasheetHub.launch.check.listingActive',
      pass: listingOk,
      detail: listingOk
        ? undefined
        : `${l.isPublished ? l.listingStatus : 'unpublished'}`,
    })

    // Master images
    checks.push({
      key: 'master_images',
      labelKey: 'products.datasheetHub.launch.check.masterImages',
      pass: hasMasterImages,
    })

    // Required language translation
    const lang = MARKETPLACE_TO_LANG[l.marketplace]
    if (lang) {
      checks.push({
        key: 'translation',
        labelKey: 'products.datasheetHub.launch.check.translation',
        pass: hasReadyTranslation(lang),
        detail: lang,
      })
    }

    // CE or UKCA based on market
    const certKind = MARKET_CE[l.marketplace]
    if (certKind === 'ce') {
      checks.push({
        key: 'ce',
        labelKey: 'products.datasheetHub.launch.check.ce',
        pass: hasValidCe,
      })
    } else if (certKind === 'ukca') {
      checks.push({
        key: 'ukca',
        labelKey: 'products.datasheetHub.launch.check.ukca',
        pass: hasValidUkca,
      })
    }

    // GPSR
    if (MARKET_REQUIRES_GPSR.has(l.marketplace)) {
      checks.push({
        key: 'gpsr',
        labelKey: 'products.datasheetHub.launch.check.gpsr',
        pass: hasResponsiblePerson,
      })
    }

    // HS code
    checks.push({
      key: 'hsCode',
      labelKey: 'products.datasheetHub.launch.check.hsCode',
      pass: hasHsCode,
    })

    const ready = checks.every((c) => c.pass)
    return {
      key: `${l.channel}|${l.marketplace}`,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      checks,
      ready,
    }
  })

  const readyCount = rows.filter((r) => r.ready).length
  const notReady = rows.length - readyCount

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
          <Rocket className="w-4 h-4 text-blue-500" />
          <span>{t('products.datasheetHub.launch.title')}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {t('products.datasheetHub.launch.summary.ready', {
              count: readyCount,
            })}
          </span>
          {notReady > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.launch.summary.notReady', {
                count: notReady,
              })}
            </span>
          )}
        </div>
      </div>

      <div className="border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="py-2 px-3 font-medium sticky left-0 z-10 bg-slate-50 dark:bg-slate-800/40 min-w-[140px]">
                {t('products.datasheetHub.launch.col.market')}
              </th>
              <th className="py-2 px-3 font-medium text-center">
                {t('products.datasheetHub.launch.col.checks')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.launch.col.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
              >
                <td className="py-2 px-3 sticky left-0 z-10 bg-white dark:bg-slate-900 align-middle text-slate-900 dark:text-slate-100 font-medium">
                  {r.label}
                </td>
                <td className="py-2 px-3 align-middle">
                  <div className="flex flex-wrap items-center gap-1">
                    {r.checks.map((c) => (
                      <span
                        key={c.key}
                        className={
                          'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] ' +
                          (c.pass
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                            : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300')
                        }
                        title={
                          c.detail
                            ? `${t(c.labelKey)} · ${c.detail}`
                            : t(c.labelKey)
                        }
                      >
                        {c.pass ? (
                          <Check className="w-2.5 h-2.5" />
                        ) : (
                          <XCircle className="w-2.5 h-2.5" />
                        )}
                        <span>{t(c.labelKey)}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="py-2 px-3 align-middle">
                  <span
                    className={
                      'inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ' +
                      (r.ready
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300')
                    }
                  >
                    {r.ready
                      ? t('products.datasheetHub.launch.overall.ready')
                      : t('products.datasheetHub.launch.overall.notReady')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
