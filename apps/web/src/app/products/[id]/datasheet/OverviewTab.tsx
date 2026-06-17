/**
 * ATM.7 — Overview tab.
 *
 * This is the first real content the operator sees after the
 * header health pulse. Two sections today:
 *
 *   1. Drift panel — consolidated list of fields where the
 *      ChannelListing.masterX mirror has diverged from the current
 *      Product master. That's the "we pushed value X to the channel
 *      but the master has since moved to Y" signal — staleness or
 *      Seller-Central-side edits, whichever interpretation fits.
 *      VR.4 surfaces drift for identifiers; ATM.7 generalises to
 *      title / description / price / quantity / bullets.
 *
 *   2. (Future) Quick-jump rollups — links to the most-impacted
 *      tabs (Variants, Channels, Pricing) when their signals
 *      warrant attention. Wired in subsequent phases as those
 *      tabs gain more depth.
 *
 * Resolution actions (Adopt channel as master / Push master to
 * channel) defer to ATM.7b. Each writes to a different surface
 * (Product table update vs OutboundSyncQueue + publish pipeline)
 * and warrants its own confirmation + audit UX rather than being
 * lumped in here.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react'
import { prettyChannelMarketplace } from '@/lib/marketplace-code'
import type { getServerT } from '@/lib/i18n/server'
import LaunchReadiness from './LaunchReadiness'

interface OverviewTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

interface MasterShape {
  name: string | null
  description: string | null
  basePrice: number | null
  totalStock: number
  bulletPoints: string[]
}

interface ListingMirrorShape {
  id: string
  channel: string
  marketplace: string
  masterTitle: string | null
  masterDescription: string | null
  masterPrice: number | null
  masterQuantity: number | null
  masterBulletPoints: string[]
  lastSyncedAt: Date | null
}

interface FieldDrift {
  field: 'title' | 'description' | 'price' | 'quantity' | 'bullets'
  fieldLabelKey: string
  masterPreview: string
  affectedListings: Array<{
    listingId: string
    channel: string
    marketplace: string
    label: string
    channelPreview: string
    lastSyncedAt: Date | null
  }>
}

export default async function OverviewTab({
  productId,
  locale,
  t,
}: OverviewTabProps) {
  const [master, listings] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id: productId },
        select: {
          name: true,
          description: true,
          basePrice: true,
          totalStock: true,
          bulletPoints: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.7] master fetch failed', e)
        return null
      }),
    prisma.channelListing
      .findMany({
        where: { productId },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        select: {
          id: true,
          channel: true,
          marketplace: true,
          masterTitle: true,
          masterDescription: true,
          masterPrice: true,
          masterQuantity: true,
          masterBulletPoints: true,
          lastSyncedAt: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.7] channelListings fetch failed', e)
        return [] as never[]
      }),
  ])

  if (master == null) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.overview.fetchFailed')}
      </div>
    )
  }

  const masterShape: MasterShape = {
    name: master.name,
    description: master.description,
    basePrice: master.basePrice == null ? null : Number(master.basePrice),
    totalStock: master.totalStock,
    bulletPoints: master.bulletPoints,
  }

  const drifts = computeDrifts(masterShape, listings as ListingMirrorShape[])

  return (
    <div className="space-y-4">
      {/* ATM.13 — Launch readiness checklist, cross-tab signal
          rollup. Mounted above drift because launch readiness is
          the prime "what should I be doing first?" question. */}
      <LaunchReadiness productId={productId} t={t} />
      <DriftSection drifts={drifts} locale={locale} t={t} />
    </div>
  )
}

/**
 * Walks each (listing, field) pair and flags drift when the mirror
 * doesn't match the current master. Returns one FieldDrift per
 * field that has any drift, with the per-listing rollup inside.
 */
function computeDrifts(
  master: MasterShape,
  listings: ListingMirrorShape[],
): FieldDrift[] {
  const out: FieldDrift[] = []

  const truncate = (s: string | null | undefined, max = 60) => {
    if (!s) return ''
    if (s.length <= max) return s
    return s.slice(0, max - 1) + '…'
  }

  const titleDrifts = listings
    .filter((l) => (l.masterTitle ?? '') !== (master.name ?? ''))
    .map((l) => ({
      listingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      channelPreview: truncate(l.masterTitle ?? '', 80),
      lastSyncedAt: l.lastSyncedAt,
    }))
  if (titleDrifts.length > 0) {
    out.push({
      field: 'title',
      fieldLabelKey: 'products.col.name',
      masterPreview: truncate(master.name ?? '', 80),
      affectedListings: titleDrifts,
    })
  }

  const descDrifts = listings
    .filter(
      (l) => (l.masterDescription ?? '') !== (master.description ?? ''),
    )
    .map((l) => ({
      listingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      channelPreview: truncate(l.masterDescription ?? '', 100),
      lastSyncedAt: l.lastSyncedAt,
    }))
  if (descDrifts.length > 0) {
    out.push({
      field: 'description',
      fieldLabelKey: 'products.col.description',
      masterPreview: truncate(master.description ?? '', 100),
      affectedListings: descDrifts,
    })
  }

  const priceDrifts = listings
    .filter((l) => {
      const a = l.masterPrice == null ? null : Number(l.masterPrice)
      return a !== master.basePrice
    })
    .map((l) => ({
      listingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      channelPreview:
        l.masterPrice == null ? '—' : `€${Number(l.masterPrice).toFixed(2)}`,
      lastSyncedAt: l.lastSyncedAt,
    }))
  if (priceDrifts.length > 0) {
    out.push({
      field: 'price',
      fieldLabelKey: 'products.col.price',
      masterPreview:
        master.basePrice == null ? '—' : `€${master.basePrice.toFixed(2)}`,
      affectedListings: priceDrifts,
    })
  }

  const qtyDrifts = listings
    .filter((l) => (l.masterQuantity ?? 0) !== master.totalStock)
    .map((l) => ({
      listingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      channelPreview: String(l.masterQuantity ?? 0),
      lastSyncedAt: l.lastSyncedAt,
    }))
  if (qtyDrifts.length > 0) {
    out.push({
      field: 'quantity',
      fieldLabelKey: 'products.col.stock',
      masterPreview: String(master.totalStock),
      affectedListings: qtyDrifts,
    })
  }

  const bulletDrifts = listings
    .filter((l) => !arraysEqual(l.masterBulletPoints, master.bulletPoints))
    .map((l) => ({
      listingId: l.id,
      channel: l.channel,
      marketplace: l.marketplace,
      label: prettyChannelMarketplace(l.channel, l.marketplace),
      channelPreview: `${l.masterBulletPoints.length}× — ${truncate(
        l.masterBulletPoints[0] ?? '',
        50,
      )}`,
      lastSyncedAt: l.lastSyncedAt,
    }))
  if (bulletDrifts.length > 0) {
    out.push({
      field: 'bullets',
      fieldLabelKey: 'products.datasheet.section.bullets',
      masterPreview: `${master.bulletPoints.length}× — ${truncate(
        master.bulletPoints[0] ?? '',
        50,
      )}`,
      affectedListings: bulletDrifts,
    })
  }

  return out
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function DriftSection({
  drifts,
  locale,
  t,
}: {
  drifts: FieldDrift[]
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (drifts.length === 0) {
    return (
      <div className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/30 rounded p-4 flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-200">
        <CheckCircle2 className="w-4 h-4" />
        <span>{t('products.datasheetHub.overview.noDrift')}</span>
      </div>
    )
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relSync = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 60) return rtf.format(diffSec, 'second')
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    return rtf.format(Math.round(diffSec / 86400), 'day')
  }

  const totalListings = new Set(
    drifts.flatMap((d) => d.affectedListings.map((l) => l.listingId)),
  ).size

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <span>{t('products.datasheetHub.overview.drift.title')}</span>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {t('products.datasheetHub.overview.drift.summary', {
            fields: drifts.length,
            listings: totalListings,
          })}
        </div>
      </div>

      <div className="space-y-2">
        {drifts.map((d) => (
          <details
            key={d.field}
            className="border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-slate-900 rounded"
          >
            <summary className="cursor-pointer select-none px-3 py-2 flex items-center gap-3 flex-wrap hover:bg-amber-50/30 dark:hover:bg-amber-950/20">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {t(d.fieldLabelKey)}
              </span>
              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 tabular-nums">
                {t(
                  d.affectedListings.length === 1
                    ? 'products.datasheetHub.overview.drift.affected.one'
                    : 'products.datasheetHub.overview.drift.affected.other',
                  { count: d.affectedListings.length },
                )}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1 min-w-0">
                {t('products.datasheetHub.overview.drift.masterIs', {
                  value: d.masterPreview,
                })}
              </span>
            </summary>
            <div className="border-t border-default dark:border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/40 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <tr className="text-left">
                    <th className="py-1.5 px-3 font-medium">
                      {t('products.datasheetHub.overview.drift.col.channel')}
                    </th>
                    <th className="py-1.5 px-3 font-medium">
                      {t('products.datasheetHub.overview.drift.col.channelValue')}
                    </th>
                    <th className="py-1.5 px-3 font-medium text-right">
                      {t('products.datasheetHub.overview.drift.col.lastSync')}
                    </th>
                    <th className="py-1.5 px-2 w-6"></th>
                  </tr>
                </thead>
                <tbody>
                  {d.affectedListings.map((l) => (
                    <tr
                      key={l.listingId}
                      className="border-t border-subtle dark:border-slate-800"
                    >
                      <td className="py-1.5 px-3 align-middle text-slate-700 dark:text-slate-200">
                        {l.label}
                      </td>
                      <td className="py-1.5 px-3 align-middle text-slate-600 dark:text-slate-300">
                        {l.channelPreview || (
                          <span className="text-tertiary italic">
                            {t(
                              'products.datasheetHub.overview.drift.channelEmpty',
                            )}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 align-middle text-right text-slate-500 dark:text-slate-400 tabular-nums">
                        {relSync(l.lastSyncedAt) ?? '—'}
                      </td>
                      <td className="py-1.5 px-2 align-middle">
                        <Link
                          href={`/sync-logs/live?listingId=${l.listingId}`}
                          className="inline-flex items-center justify-center w-5 h-5 rounded text-tertiary hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title={t(
                            'products.datasheetHub.overview.drift.openLog',
                          )}
                          aria-label={t(
                            'products.datasheetHub.overview.drift.openLog',
                          )}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>

      <div className="text-[10px] text-slate-500 dark:text-slate-400 italic">
        {t('products.datasheetHub.overview.drift.actionsComingNote')}
      </div>
    </div>
  )
}
