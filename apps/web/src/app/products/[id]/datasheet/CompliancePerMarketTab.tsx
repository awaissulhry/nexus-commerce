/**
 * ATM.10 — Compliance × market grid.
 *
 * One card per active marketplace, showing the per-market
 * regulatory readiness for THIS product. Where VR.7 surfaces
 * per-variant compliance differences, ATM.10 surfaces per-market:
 * "this jacket sells in 7 markets; is each market's compliance
 * box ticked?"
 *
 * Each card:
 *   - Market label (Amazon Italy / eBay Germany / …)
 *   - Overall readiness chip (READY / WARN / BLOCKED)
 *   - Per-requirement rows: CE marking, UKCA marking (UK only),
 *     GPSR responsible person (EU + UK), HS code declared,
 *     hazmat compliance acceptance, restricted-product flag
 *   - Expiring-soon certificate warning when applicable
 *
 * Market rules are hard-coded constants reflecting EU + UK + key
 * non-EU practice as of 2026. Operators amend
 * /settings/pim/families when their category needs a different
 * requirement set; this view shows the rules currently in effect.
 *
 * Source data:
 *   - Product master compliance fields (hsCode, countryOfOrigin,
 *     ppeCategory, hazmatClass)
 *   - ProductCertificate rows (CE / UKCA / EN-13595 / REACH)
 *   - BrandSettings address (used as GPSR responsible person when
 *     the brand is EU-based — Xavia)
 *   - Active ChannelListings for the marketplace list
 */

import { prisma } from '@nexus/database'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'

interface CompliancePerMarketTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

// Per-marketplace requirements profile.
//   ce         CE marking expected (EU + EFTA + Turkey + most of
//              MENA accept CE for imported goods)
//   ukca       UKCA marking expected (UK-only, replaced CE on
//              GB market in 2024)
//   gpsr       Operator must be able to name an EU-established
//              responsible person (GPSR Art. 16; EU markets)
//   hsCodeReq  HS / HTS code expected on customs declaration
const MARKET_PROFILE: Record<
  string,
  { ce: boolean; ukca: boolean; gpsr: boolean; hsCodeReq: boolean }
> = {
  IT: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  DE: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  FR: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  ES: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  NL: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  BE: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  PL: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  CZ: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  SE: { ce: true, ukca: false, gpsr: true, hsCodeReq: true },
  UK: { ce: false, ukca: true, gpsr: true, hsCodeReq: true },
  TR: { ce: true, ukca: false, gpsr: false, hsCodeReq: true },
  AE: { ce: true, ukca: false, gpsr: false, hsCodeReq: true },
  SA: { ce: true, ukca: false, gpsr: false, hsCodeReq: true },
  US: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  CA: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  MX: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  BR: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  JP: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  AU: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  SG: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  IN: { ce: false, ukca: false, gpsr: false, hsCodeReq: true },
  EG: { ce: true, ukca: false, gpsr: false, hsCodeReq: true },
  GLOBAL: { ce: false, ukca: false, gpsr: false, hsCodeReq: false },
  DEFAULT: { ce: false, ukca: false, gpsr: false, hsCodeReq: false },
}

const SOON_MS = 90 * 24 * 60 * 60 * 1000

export default async function CompliancePerMarketTab({
  productId,
  // locale is accepted for parity with other tab signatures + future
  // localised date/percent formatting; not yet read.
  locale: _locale,
  t,
}: CompliancePerMarketTabProps) {
  const [master, certs, listings, brand] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id: productId },
        select: {
          hsCode: true,
          countryOfOrigin: true,
          ppeCategory: true,
          hazmatClass: true,
          hazmatUnNumber: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.10] master fetch failed', e)
        return null
      }),
    prisma.productCertificate
      .findMany({
        where: { productId },
        select: {
          certType: true,
          certNumber: true,
          expiresAt: true,
          issuingBody: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.10] certificates fetch failed', e)
        return [] as never[]
      }),
    prisma.channelListing
      .findMany({
        where: {
          productId,
          isPublished: true,
          listingStatus: 'ACTIVE',
        },
        select: { channel: true, marketplace: true },
        distinct: ['channel', 'marketplace'],
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
      })
      .catch((e: unknown) => {
        console.error('[atm.10] listings fetch failed', e)
        return [] as never[]
      }),
    prisma.brandSettings
      .findFirst({
        select: {
          companyName: true,
          addressLines: true,
          piva: true,
        },
      })
      .catch(() => null),
  ])

  if (master == null) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.compliancePerMarket.fetchFailed')}
      </div>
    )
  }

  if (listings.length === 0) {
    return (
      <div className="border border-default dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
        <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-slate-300" />
        <div className="font-medium text-slate-700 dark:text-slate-300">
          {t('products.datasheetHub.compliancePerMarket.empty.title')}
        </div>
        <p className="text-xs mt-1">
          {t('products.datasheetHub.compliancePerMarket.empty.body')}
        </p>
      </div>
    )
  }

  // Index certs by type for fast lookup.
  const certByType = new Map(certs.map((c) => [c.certType, c]))
  const hasValidCe = (() => {
    const ce = certByType.get('CE')
    if (!ce) return false
    if (ce.expiresAt && ce.expiresAt.getTime() < Date.now()) return false
    return true
  })()
  const hasValidUkca = (() => {
    const u = certByType.get('UKCA')
    if (!u) return false
    if (u.expiresAt && u.expiresAt.getTime() < Date.now()) return false
    return true
  })()

  // Expiring-soon flag: any cert within 90 days of expiring.
  const expiringSoonCerts = certs.filter(
    (c) =>
      c.expiresAt != null &&
      c.expiresAt.getTime() > Date.now() &&
      c.expiresAt.getTime() - Date.now() < SOON_MS,
  )

  const hasResponsiblePerson =
    !!brand?.companyName ||
    (brand?.addressLines?.length ?? 0) > 0 ||
    !!brand?.piva

  // Aggregate cards.
  const cards = listings.map((l) => {
    const profile =
      MARKET_PROFILE[l.marketplace] ?? MARKET_PROFILE.DEFAULT
    const items: Array<{
      key: string
      labelKey: string
      status: 'ok' | 'warn' | 'fail'
      detail?: string
    }> = []

    if (profile.ce) {
      items.push({
        key: 'ce',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.ce',
        status: hasValidCe ? 'ok' : 'fail',
        detail: hasValidCe
          ? undefined
          : t('products.datasheetHub.compliancePerMarket.detail.noCe'),
      })
    }
    if (profile.ukca) {
      items.push({
        key: 'ukca',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.ukca',
        status: hasValidUkca ? 'ok' : 'fail',
        detail: hasValidUkca
          ? undefined
          : t('products.datasheetHub.compliancePerMarket.detail.noUkca'),
      })
    }
    if (profile.gpsr) {
      items.push({
        key: 'gpsr',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.gpsr',
        status: hasResponsiblePerson ? 'ok' : 'fail',
        detail: hasResponsiblePerson
          ? undefined
          : t('products.datasheetHub.compliancePerMarket.detail.noGpsr'),
      })
    }
    if (profile.hsCodeReq) {
      items.push({
        key: 'hs',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.hsCode',
        status: master.hsCode ? 'ok' : 'warn',
        detail: master.hsCode ?? undefined,
      })
    }
    // PPE — always present in EU + UK as an attribute; not a
    // blocker, just informational.
    if (master.ppeCategory && (profile.ce || profile.ukca)) {
      items.push({
        key: 'ppe',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.ppe',
        status: 'ok',
        detail: master.ppeCategory,
      })
    }
    // Hazmat — flag warn when class > 0 on EU air-shipment routes;
    // surface always when present.
    if (master.hazmatClass || master.hazmatUnNumber) {
      items.push({
        key: 'hazmat',
        labelKey: 'products.datasheetHub.compliancePerMarket.req.hazmat',
        status: 'warn',
        detail: [master.hazmatUnNumber, master.hazmatClass]
          .filter(Boolean)
          .join(' · '),
      })
    }

    // Overall card status: any 'fail' → BLOCKED, any 'warn' → WARN,
    // else READY. When the market has zero requirements (e.g.
    // Shopify GLOBAL with default profile), READY by default.
    const overall: 'ready' | 'warn' | 'blocked' = items.some(
      (i) => i.status === 'fail',
    )
      ? 'blocked'
      : items.some((i) => i.status === 'warn')
        ? 'warn'
        : 'ready'

    return {
      key: `${l.channel}|${l.marketplace}`,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      items,
      overall,
    }
  })

  // Summary tally.
  const ready = cards.filter((c) => c.overall === 'ready').length
  const warn = cards.filter((c) => c.overall === 'warn').length
  const blocked = cards.filter((c) => c.overall === 'blocked').length

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap text-xs">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.compliancePerMarket.title', {
            count: cards.length,
          })}
        </div>
        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {t('products.datasheetHub.compliancePerMarket.summary.ready', {
              count: ready,
            })}
          </span>
          {warn > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t('products.datasheetHub.compliancePerMarket.summary.warn', {
                count: warn,
              })}
            </span>
          )}
          {blocked > 0 && (
            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
              <XCircle className="w-3 h-3" />
              {t('products.datasheetHub.compliancePerMarket.summary.blocked', {
                count: blocked,
              })}
            </span>
          )}
          {expiringSoonCerts.length > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {t(
                'products.datasheetHub.compliancePerMarket.summary.expiringSoon',
                { count: expiringSoonCerts.length },
              )}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => (
          <div
            key={c.key}
            className="border border-default dark:border-slate-800 rounded bg-white dark:bg-slate-900 p-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                {c.label}
              </div>
              <OverallChip overall={c.overall} t={t} />
            </div>
            <ul className="space-y-1 text-xs">
              {c.items.length === 0 ? (
                <li className="text-tertiary italic">
                  {t(
                    'products.datasheetHub.compliancePerMarket.noRequirements',
                  )}
                </li>
              ) : (
                c.items.map((it) => (
                  <li
                    key={it.key}
                    className="flex items-start gap-1.5"
                  >
                    <StatusIcon status={it.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-700 dark:text-slate-200">
                        {t(it.labelKey)}
                      </div>
                      {it.detail && (
                        <div
                          className={
                            it.status === 'fail'
                              ? 'text-red-600 dark:text-red-400 text-[10px]'
                              : 'text-slate-500 dark:text-slate-400 text-[10px]'
                          }
                        >
                          {it.detail}
                        </div>
                      )}
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>

      {!hasResponsiblePerson && (
        <div className="text-[10px] text-amber-700 dark:text-amber-400 italic">
          {t('products.datasheetHub.compliancePerMarket.gpsrSetupHint')}
        </div>
      )}
    </div>
  )
}

function OverallChip({
  overall,
  t,
}: {
  overall: 'ready' | 'warn' | 'blocked'
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  const cls =
    overall === 'ready'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
      : overall === 'warn'
        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${cls}`}
    >
      {t(`products.datasheetHub.compliancePerMarket.overall.${overall}`)}
    </span>
  )
}

function StatusIcon({ status }: { status: 'ok' | 'warn' | 'fail' }) {
  if (status === 'ok')
    return <Check className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" />
  if (status === 'warn')
    return (
      <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
    )
  return <XCircle className="w-3 h-3 text-red-500 flex-shrink-0 mt-0.5" />
}
