/**
 * ATM.9 — Translations × language matrix.
 *
 * One row per language. Columns are the four translatable master
 * fields (name / description / bullets / keywords). Each cell
 * shows coverage:
 *
 *   filled    value set + at least char-count chip
 *   master    inherits master (English-first); only shows for 'en'
 *   missing   no value — operator-actionable gap
 *
 * Source badges per row: manual / ai-gemini / ai-anthropic / channel-
 * auto-translated. AI-sourced rows that haven't been reviewedAt get
 * a sticky amber chip — content shouldn't ship to a customer
 * without operator review.
 *
 * Required-language detection: walks active ChannelListings, maps
 * each marketplace code to its dominant consumer language via
 * MARKETPLACE_TO_LANG, and surfaces those plus any languages that
 * already have a translation row. A language is "required" when
 * a market needs it; "extra" when only the translation exists
 * (operator pre-translated speculatively); both render in the
 * matrix but required rows get a flag.
 *
 * Reuses the existing list-wizard / brand-voice substrate via deep-
 * link to the variant's edit page for inline translation work.
 * Inline-edit lives on the edit page; this tab is for the audit
 * "are we ready to launch in DE next week?" view.
 */

import { prisma } from '@nexus/database'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  XCircle,
} from 'lucide-react'
import type { getServerT } from '@/lib/i18n/server'

interface TranslationsTabProps {
  productId: string
  locale: 'en' | 'it'
  t: Awaited<ReturnType<typeof getServerT>>
}

// Marketplace → consumer language. Multi-language markets (BE/CH)
// pick the dominant marketplace tongue; operators can add the
// secondary language manually.
const MARKETPLACE_TO_LANG: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', NL: 'nl',
  BE: 'nl', PL: 'pl', CZ: 'cs', SE: 'sv', UK: 'en',
  TR: 'tr', EG: 'ar', AE: 'ar', SA: 'ar', IN: 'en',
  US: 'en', CA: 'en', MX: 'es', BR: 'pt',
  JP: 'ja', AU: 'en', SG: 'en',
}

export default async function TranslationsTab({
  productId,
  locale,
  t,
}: TranslationsTabProps) {
  const [master, translations, listings] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id: productId },
        select: {
          name: true,
          description: true,
          bulletPoints: true,
          keywords: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.9] master fetch failed', e)
        return null
      }),
    prisma.productTranslation
      .findMany({
        where: { productId },
        orderBy: { language: 'asc' },
        select: {
          id: true,
          language: true,
          name: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          source: true,
          sourceModel: true,
          reviewedAt: true,
          updatedAt: true,
        },
      })
      .catch((e: unknown) => {
        console.error('[atm.9] translations fetch failed', e)
        return [] as never[]
      }),
    prisma.channelListing
      .findMany({
        where: {
          productId,
          isPublished: true,
          listingStatus: 'ACTIVE',
        },
        select: { marketplace: true },
        distinct: ['marketplace'],
      })
      .catch((e: unknown) => {
        console.error('[atm.9] active listings fetch failed', e)
        return [] as never[]
      }),
  ])

  if (master == null) {
    return (
      <div className="border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 rounded p-4 text-sm text-amber-800 dark:text-amber-200">
        {t('products.datasheetHub.translations.fetchFailed')}
      </div>
    )
  }

  // Languages that active markets need.
  const requiredLangs = new Set<string>()
  for (const l of listings) {
    const lang = MARKETPLACE_TO_LANG[l.marketplace]
    if (lang) requiredLangs.add(lang)
  }
  // Master is English-first; always include en even when no UK/US
  // market is active so the operator sees the "source" row.
  requiredLangs.add('en')

  // All languages we'll display = required ∪ any translation that
  // exists (operators sometimes pre-translate before launching the
  // matching market).
  const allLangs = new Set<string>(requiredLangs)
  for (const tr of translations) allLangs.add(tr.language)
  const orderedLangs = [...allLangs].sort((a, b) => {
    // 'en' (master) first, then required languages by name, then
    // extras by name.
    if (a === 'en') return -1
    if (b === 'en') return 1
    const aReq = requiredLangs.has(a)
    const bReq = requiredLangs.has(b)
    if (aReq !== bReq) return aReq ? -1 : 1
    return a.localeCompare(b)
  })

  // Translation row lookup.
  const trByLang = new Map(translations.map((tr) => [tr.language, tr]))

  // Locale display names — "en" → "English" / "Inglese".
  const langDisplay = (() => {
    try {
      return new Intl.DisplayNames([locale === 'it' ? 'it' : 'en'], {
        type: 'language',
      })
    } catch {
      return null
    }
  })()
  const fmtLang = (code: string): string =>
    langDisplay?.of(code) ?? code.toUpperCase()

  // Aggregate coverage stats for the summary line.
  const totalRows = orderedLangs.length
  let fullyCovered = 0
  let unreviewedAi = 0
  let missingRequired = 0
  for (const code of orderedLangs) {
    if (code === 'en') {
      fullyCovered++ // master is implicitly covered
      continue
    }
    const tr = trByLang.get(code)
    if (!tr) {
      if (requiredLangs.has(code)) missingRequired++
      continue
    }
    const filled = countFilled(tr)
    if (filled === 4) fullyCovered++
    if (
      tr.source &&
      (tr.source === 'ai-gemini' || tr.source === 'ai-anthropic') &&
      tr.reviewedAt == null
    ) {
      unreviewedAi++
    }
  }

  const numLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const rtf = new Intl.RelativeTimeFormat(numLocale, { numeric: 'auto' })
  const relAge = (d: Date | null) => {
    if (!d) return null
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000)
    const abs = Math.abs(diffSec)
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour')
    return rtf.format(Math.round(diffSec / 86400), 'day')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('products.datasheetHub.translations.title', {
            count: totalRows,
          })}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {t('products.datasheetHub.translations.summary.complete', {
              count: fullyCovered,
            })}
          </span>
          {missingRequired > 0 && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
              <XCircle className="w-3 h-3" />
              {t('products.datasheetHub.translations.summary.missing', {
                count: missingRequired,
              })}
            </span>
          )}
          {unreviewedAi > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <Sparkles className="w-3 h-3" />
              {t('products.datasheetHub.translations.summary.aiUnreviewed', {
                count: unreviewedAi,
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
                {t('products.datasheetHub.translations.col.language')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.col.name')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.col.description')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.section.bullets')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheet.section.keywords')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.translations.col.source')}
              </th>
              <th className="py-2 px-3 font-medium">
                {t('products.datasheetHub.translations.col.updated')}
              </th>
            </tr>
          </thead>
          <tbody>
            {orderedLangs.map((code) => {
              if (code === 'en') {
                return (
                  <tr
                    key={code}
                    className="border-b border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30"
                  >
                    <td className="py-2 px-3 sticky left-0 z-10 bg-slate-50/60 dark:bg-slate-800/30 align-middle">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {fmtLang(code)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        {t('products.datasheetHub.translations.masterLabel')}
                      </div>
                    </td>
                    <FieldCell value={master.name} t={t} />
                    <FieldCell value={master.description} t={t} />
                    <FieldCell
                      value={
                        master.bulletPoints.length > 0
                          ? master.bulletPoints[0]
                          : null
                      }
                      count={master.bulletPoints.length}
                      t={t}
                    />
                    <FieldCell
                      value={
                        master.keywords.length > 0 ? master.keywords[0] : null
                      }
                      count={master.keywords.length}
                      t={t}
                    />
                    <td className="py-2 px-3 align-middle text-slate-400 italic">
                      {t('products.datasheetHub.translations.source.master')}
                    </td>
                    <td className="py-2 px-3 align-middle text-slate-400">
                      —
                    </td>
                  </tr>
                )
              }
              const tr = trByLang.get(code)
              const isRequired = requiredLangs.has(code)
              return (
                <tr
                  key={code}
                  className="border-b border-slate-100 dark:border-slate-800 last:border-b-0"
                >
                  <td className="py-2 px-3 sticky left-0 z-10 bg-white dark:bg-slate-900 align-middle">
                    <div className="text-slate-900 dark:text-slate-100 font-medium">
                      {fmtLang(code)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <span className="font-mono">{code}</span>
                      {isRequired ? (
                        <span className="text-blue-600 dark:text-blue-400">
                          ·{' '}
                          {t(
                            'products.datasheetHub.translations.requiredFlag',
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-400">
                          ·{' '}
                          {t('products.datasheetHub.translations.extraFlag')}
                        </span>
                      )}
                    </div>
                  </td>
                  {tr ? (
                    <>
                      <FieldCell value={tr.name} t={t} />
                      <FieldCell value={tr.description} t={t} />
                      <FieldCell
                        value={
                          tr.bulletPoints.length > 0
                            ? tr.bulletPoints[0]
                            : null
                        }
                        count={tr.bulletPoints.length}
                        t={t}
                      />
                      <FieldCell
                        value={
                          tr.keywords.length > 0 ? tr.keywords[0] : null
                        }
                        count={tr.keywords.length}
                        t={t}
                      />
                      <td className="py-2 px-3 align-middle">
                        <SourceChip
                          source={tr.source}
                          sourceModel={tr.sourceModel}
                          reviewedAt={tr.reviewedAt}
                          t={t}
                        />
                      </td>
                      <td className="py-2 px-3 align-middle text-slate-500 dark:text-slate-400">
                        {relAge(tr.updatedAt) ?? '—'}
                      </td>
                    </>
                  ) : (
                    <td
                      colSpan={6}
                      className="py-2 px-3 align-middle text-amber-700 dark:text-amber-400 italic"
                    >
                      <span className="inline-flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {t(
                          isRequired
                            ? 'products.datasheetHub.translations.missingRequired'
                            : 'products.datasheetHub.translations.missingExtra',
                          { language: fmtLang(code) },
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <div className="italic">
          {t('products.datasheetHub.translations.editNote')}
        </div>
        <Link
          href={`/products/${productId}/edit`}
          className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:underline"
        >
          {t('products.datasheetHub.translations.openEditor')}
        </Link>
      </div>
    </div>
  )
}

function countFilled(tr: {
  name: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
}): number {
  let n = 0
  if (tr.name && tr.name.trim().length > 0) n++
  if (tr.description && tr.description.trim().length > 0) n++
  if (tr.bulletPoints.length > 0) n++
  if (tr.keywords.length > 0) n++
  return n
}

function FieldCell({
  value,
  count,
  t,
}: {
  value: string | null
  count?: number
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (!value || value.trim().length === 0) {
    return (
      <td className="py-2 px-3 align-middle">
        <span className="inline-flex items-center gap-1 text-slate-400">
          <XCircle className="w-3 h-3" />
          <span className="text-[10px]">
            {t('products.datasheetHub.translations.empty')}
          </span>
        </span>
      </td>
    )
  }
  const truncated =
    value.length > 60 ? value.slice(0, 59) + '…' : value
  return (
    <td className="py-2 px-3 align-middle">
      <div className="flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
        <span className="text-slate-700 dark:text-slate-200 truncate max-w-xs">
          {truncated}
        </span>
        {count != null && count > 1 && (
          <span className="text-[10px] text-slate-500 font-mono flex-shrink-0">
            ×{count}
          </span>
        )}
      </div>
    </td>
  )
}

function SourceChip({
  source,
  sourceModel,
  reviewedAt,
  t,
}: {
  source: string | null
  sourceModel: string | null
  reviewedAt: Date | null
  t: Awaited<ReturnType<typeof getServerT>>
}) {
  if (!source) {
    return (
      <span className="text-slate-300 dark:text-slate-600 text-[10px]">
        —
      </span>
    )
  }
  const isAi = source === 'ai-gemini' || source === 'ai-anthropic'
  const unreviewed = isAi && reviewedAt == null
  if (unreviewed) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px] font-medium"
        title={
          sourceModel
            ? t('products.datasheetHub.translations.unreviewedAiTip', {
                model: sourceModel,
              })
            : t('products.datasheetHub.translations.unreviewedAiTipNoModel')
        }
      >
        <Sparkles className="w-3 h-3" />
        {source.replace('ai-', '')}
        <span className="opacity-70">
          ·{' '}
          {t('products.datasheetHub.translations.unreviewedShort')}
        </span>
      </span>
    )
  }
  return (
    <span className="inline-block px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px]">
      {source}
    </span>
  )
}
