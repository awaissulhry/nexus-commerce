/**
 * G.2 — FX rate cache + fetcher.
 *
 * Single source of truth for currency conversion in the pricing engine.
 *
 *   getFxRate(from, to, asOf)  — cached lookup; falls back to most-recent
 *                                 rate when today's hasn't been fetched.
 *   refreshFxRates()           — daily cron pulls latest rates from
 *                                 frankfurter.app (free, ECB-backed,
 *                                 no auth required).
 *
 * Master prices on Nexus are stored in EUR by convention. We seed the
 * common conversions used by Xavia (EUR → GBP, USD, SEK, PLN, CAD, JPY,
 * AUD, MXN, NOK, CHF, DKK). frankfurter.app supports ~30 currencies; we
 * pull the ones that match active Marketplace.currency rows.
 *
 * Manual override: rows with `source = 'manual'` take precedence over
 * frankfurter rows on the same `asOf`. Lets the seller lock UK at a
 * fixed rate while EUR/GBP shifts.
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

const FRANKFURTER_BASE = 'https://api.frankfurter.app'
const FETCH_TIMEOUT_MS = 8_000

// Master currency convention. Override via env if Xavia's primary
// changes (unlikely — Italian seller, EUR-priced catalog).
const MASTER_CURRENCY = process.env.NEXUS_MASTER_CURRENCY ?? 'EUR'

/**
 * Look up the exchange rate from `from` to `to` as of `asOf`. Falls back
 * to the most-recent rate when today's hasn't been fetched (e.g. weekend,
 * frankfurter outage). Returns 1.0 when from === to.
 *
 * Manual overrides win — `source = 'manual'` rows take precedence over
 * frankfurter rows on the same asOf date.
 */
export async function getFxRate(
  prisma: PrismaClient,
  from: string,
  to: string,
  asOf: Date = new Date(),
): Promise<number> {
  if (from === to) return 1
  const day = startOfDay(asOf)

  // Try exact day first; manual overrides have first-match by ordering.
  const exact = await prisma.fxRate.findFirst({
    where: { fromCurrency: from, toCurrency: to, asOf: day },
    orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
    // 'asc' on source puts 'frankfurter' before 'manual'... we want
    // manual first. Reverse:
  })

  // Re-do in correct order — manual first.
  const exactPreferred = await prisma.fxRate.findFirst({
    where: { fromCurrency: from, toCurrency: to, asOf: day },
    orderBy: { source: 'desc' }, // 'manual' > 'frankfurter' alphabetically (m > f) — coincidentally correct
  })

  if (exactPreferred) return Number(exactPreferred.rate)
  if (exact) return Number(exact.rate)

  // Fallback to most-recent rate. Common case: weekend, holiday, or
  // before today's cron run.
  const latest = await prisma.fxRate.findFirst({
    where: { fromCurrency: from, toCurrency: to, asOf: { lte: day } },
    orderBy: [{ asOf: 'desc' }, { source: 'desc' }],
  })
  if (latest) return Number(latest.rate)

  // No rate at all. Caller's warning system surfaces this.
  return 1
}

/**
 * Pull today's rates from frankfurter.app for every Marketplace.currency
 * that's not the master currency. Idempotent: re-running on the same day
 * upserts. Manual overrides are preserved (different source).
 *
 * frankfurter.app docs: https://www.frankfurter.app/docs/
 */
export async function refreshFxRates(prisma: PrismaClient): Promise<{
  fetched: number
  pairsWritten: number
  durationMs: number
  errors: string[]
}> {
  const startedAt = Date.now()
  const errors: string[] = []

  const marketplaces = await prisma.marketplace.findMany({
    where: { isActive: true },
    select: { currency: true },
    distinct: ['currency'],
  })
  const targetCurrencies = [
    ...new Set(
      marketplaces
        .map((m) => m.currency)
        .filter((c) => c !== MASTER_CURRENCY),
    ),
  ]
  if (targetCurrencies.length === 0) {
    return { fetched: 0, pairsWritten: 0, durationMs: Date.now() - startedAt, errors }
  }

  const today = startOfDay(new Date())

  // frankfurter.app supports comma-separated 'to' currencies in one call.
  // Single GET handles every pair.
  const url = new URL(`${FRANKFURTER_BASE}/latest`)
  url.searchParams.set('from', MASTER_CURRENCY)
  url.searchParams.set('to', targetCurrencies.join(','))

  let payload: { rates?: Record<string, number>; date?: string } | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url.toString(), { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) {
      errors.push(`frankfurter HTTP ${res.status}`)
    } else {
      payload = (await res.json()) as { rates?: Record<string, number>; date?: string }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  if (!payload?.rates) {
    return {
      fetched: 0,
      pairsWritten: 0,
      durationMs: Date.now() - startedAt,
      errors,
    }
  }

  // Upsert each pair. The `asOf` we use is today (UTC day boundary), even
  // when frankfurter returns yesterday's date — the cache key is "when we
  // observed it", not "when ECB published it".
  let pairsWritten = 0
  for (const [toCurrency, rate] of Object.entries(payload.rates)) {
    if (!Number.isFinite(rate) || rate <= 0) continue
    await prisma.fxRate.upsert({
      where: {
        fromCurrency_toCurrency_asOf: {
          fromCurrency: MASTER_CURRENCY,
          toCurrency,
          asOf: today,
        },
      },
      create: {
        fromCurrency: MASTER_CURRENCY,
        toCurrency,
        rate: rate.toFixed(8),
        asOf: today,
        source: 'frankfurter',
      },
      update: {
        rate: rate.toFixed(8),
      },
    })
    pairsWritten++
  }

  const durationMs = Date.now() - startedAt
  logger.info('G.2 FX rate refresh complete', {
    masterCurrency: MASTER_CURRENCY,
    fetched: Object.keys(payload.rates).length,
    pairsWritten,
    durationMs,
  })

  return {
    fetched: Object.keys(payload.rates).length,
    pairsWritten,
    durationMs,
    errors,
  }
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(0, 0, 0, 0)
  return out
}
