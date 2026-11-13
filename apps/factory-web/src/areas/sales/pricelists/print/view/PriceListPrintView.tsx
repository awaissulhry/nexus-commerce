'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { percent, unitPrice } from '../../../quotes/model'
import { sizeOrder } from '../../../quotes/record/price-depth/model'
import type { PriceListDetail, VersionAnswer } from '../../api'
import type { VersionRules } from '../../depth/api'
import { sortedBreaks } from '../../depth/model'
import { sortedEntries, type PriceListAbilities } from '../../model'
import { PriceListsMessages, useDay, useDepthWords, useValidity, useWords } from '../../parts'
import '../../depth/depth.css'

/** SCR-420 — a price list on paper or as a PDF (design tab:pricelists.pdf): one view model, nothing fetched. */
export interface PriceListPrintModel {
  person: string
  at: string
  company: string
  can: PriceListAbilities
  /** The record's Prices tab (the strip's way back). */
  back: string
  list: PriceListDetail | null
  prices: VersionAnswer | null
  rules: VersionRules | null
  /** A `pricelists` message key of the read that failed. */
  problem: string | null
}

/**
 * The price list for a customer or a fair (design tab:pricelists.pdf): the list, its version and days, its currency and
 * whether its documents show the discount on top; then every price with its own days, the quantity breaks and the size
 * surcharges. Prices only with the price grain (held in words otherwise); never a cost or a margin.
 */
export function PriceListPrintView({ model }: { model: PriceListPrintModel }) {
  return (
    <PriceListsMessages>
      <Print model={model} />
    </PriceListsMessages>
  )
}

function Print({ model }: { model: PriceListPrintModel }) {
  const t = useDepthWords()
  const w = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const validity = useValidity()
  const { list, prices, rules } = model
  const version = prices?.version ?? null
  const currency = list?.currency ?? 'EUR'
  const ready = !!list && !!prices && !!rules
  const filters = list
    ? [
        { label: t('print.version'), value: version ? t(version.status === 'DRAFT' ? 'print.versionDraft' : 'print.versionActive', { revision: version.revision }) : '—' },
        { label: t('print.days'), value: version ? validity(version.validFrom, version.validTo) : '—' },
        { label: t('print.currency'), value: currency },
        { label: t('print.kind'), value: w(`kind.${list.kind}`) },
      ]
    : null
  const surchargeSizes = rules ? sizeOrder(rules.sizeSurcharges.map((row) => row.size)) : []
  const surchargeWho = rules ? [...new Map(rules.sizeSurcharges.map((row) => [row.styleId ?? '*', row.style])).entries()] : []
  const surchargeText = (styleId: string, size: string) => {
    const row = rules?.sizeSurcharges.find((entry) => (entry.styleId ?? '*') === styleId && entry.size === size)
    if (!row) return '—'
    return row.amount ? `+ ${unitPrice(row.amount, currency, locale)}` : row.pct ? `+ ${percent(row.pct, locale)}` : '—'
  }
  return (
    <PrintView
      title={list ? t('print.title', { code: list.code, name: list.name }) : t('print.titleNone')}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      labels={ds.printView}
    >
      {!model.can.view ? (
        <EmptyState title={w('noAccess.title')} description={w('noAccess.body')} />
      ) : !model.can.price ? (
        <EmptyState title={t('print.noPriceTitle')} description={t('held.noPrice')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {w(model.problem)}
        </Banner>
      ) : !ready ? (
        list && !prices ? (
          <p>{t('print.noVersion')}</p>
        ) : (
          <p className="fw-pl-hint" role="status">
            <Spinner size={14} /> {w('record.loading')}
          </p>
        )
      ) : (
        <>
          <p className="fw-pld-print-note">{t(rules!.list.showDiscount ? 'print.showsDiscount' : 'print.netOnly')}</p>
          <PrintSection title={t('print.prices', { count: prices!.entries.length })}>
            {prices!.entries.length === 0 ? (
              <p>{w('prices.empty.title')}</p>
            ) : (
              <SummaryTable
                label={t('print.prices', { count: prices!.entries.length })}
                widths={['30%', '22%', '28%']}
                columns={[w('prices.col.style'), w('prices.col.colour'), t('days.col'), w('prices.col.price')]}
                align={[undefined, undefined, undefined, 'right']}
                rows={sortedEntries(prices!.entries).map((entry) => ({
                  id: entry.id,
                  cells: [`${entry.style.code} · ${entry.style.name}`, entry.colourway ? `${entry.colourway.code} · ${entry.colourway.name}` : w('prices.everyColour'), entry.validFrom || entry.validTo ? validity(entry.validFrom, entry.validTo) : t('days.always'), unitPrice(entry.unitPrice, currency, locale)],
                }))}
              />
            )}
          </PrintSection>
          <PrintSection title={t('breaks.title')}>
            {rules!.breaks.length === 0 ? (
              <p>{t('breaks.empty')}</p>
            ) : (
              <SummaryTable
                label={t('breaks.title')}
                widths={['40%']}
                columns={[t('breaks.col.price'), t('breaks.col.from'), t('breaks.col.unitPrice'), t('breaks.col.discount')]}
                align={[undefined, 'right', 'right', 'right']}
                rows={sortedBreaks(rules!.breaks).map((row) => ({
                  id: row.id,
                  cells: [
                    row.entry ? `${row.entry.style.code} · ${row.entry.colourway ? row.entry.colourway.code : t('breaks.everyColour')}${row.entry.validFrom || row.entry.validTo ? ` (${t('breaks.days', { from: day(row.entry.validFrom), to: day(row.entry.validTo) })})` : ''}` : t('breaks.everyPrice'),
                    t('breaks.pieces', { count: row.minQuantity }),
                    row.unitPrice ? unitPrice(row.unitPrice, currency, locale) : '—',
                    row.discountPct ? percent(row.discountPct, locale) : '—',
                  ],
                }))}
              />
            )}
          </PrintSection>
          <PrintSection title={t('surcharges.title')}>
            {surchargeSizes.length === 0 ? (
              <p>{t('surcharges.empty')}</p>
            ) : (
              <SummaryTable
                label={t('surcharges.title')}
                widths={['30%']}
                columns={[t('surcharges.col.who'), ...surchargeSizes]}
                align={[undefined, ...surchargeSizes.map(() => 'right' as const)]}
                rows={surchargeWho.map(([styleId, style]) => ({ id: styleId, cells: [style ? `${style.code} · ${style.name}` : t('surcharges.everyStyle'), ...surchargeSizes.map((size) => surchargeText(styleId, size))] }))}
              />
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
