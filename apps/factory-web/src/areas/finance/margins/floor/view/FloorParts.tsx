'use client'

import { Banner } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pctText } from '../../../costing/model'
import { basisKey, DEPTH_NAMESPACE, flagOf, floorPhrase, pointsToFloor, type Floor, type FloorFacts } from '../model'
import '../floor.css'

/**
 * The margin floor's parts on SCR-155 (B-W2b-416; FIN-050; design finance.margins "floor flag (W2b)"): FloorFlag, the orders
 * grid's cell (below / above / not known yet, with the floor under it), and FloorSummary, the profitability DetailModal's
 * line (the floor, where it comes from, what it is judged on, how far from it; the quote approved under it). Both need the
 * margin grain: the caller draws them only then. Both read the page's messages (`finance-margins-depth`).
 */

export function FloorFlag({ row }: { row: FloorFacts }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const flag = flagOf(row)
  const floor = row.floor ?? null
  const phrase = floor ? floorPhrase(floor, locale) : null
  // The grid cell says the floor's percent; where it comes from is in the DetailModal (and the cell's title).
  return (
    <span className="fw-fmf-flag" title={phrase ? t(phrase.key, phrase.params) : undefined}>
      <Pill tone={flag.tone}>{t(flag.key)}</Pill>
      {floor && <span className="fw-fmg-cell-sub">{t('floor.short', { pct: pctText(floor.pct, locale) })}</span>}
    </span>
  )
}

export function FloorSummary({ detail }: { detail: FloorFacts & { readonly final: boolean; readonly estimateMarginPct?: string | null; readonly actualMarginPct?: string | null } }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const floor: Floor | null = detail.floor ?? null
  if (!floor) return null
  const flag = flagOf(detail)
  const phrase = floorPhrase(floor, locale)
  const points = pointsToFloor(detail)
  const distance = points === null ? null : points < 0 ? t('points.under', { points: pctText(String(-points), locale).replace(' %', '') }) : points > 0 ? t('points.over', { points: pctText(String(points), locale).replace(' %', '') }) : t('points.on')
  return (
    <section className="fw-fmg-card" aria-label={t('detail.floorTitle')}>
      <h3 className="fw-fmg-h3">{t('detail.floorTitle')}</h3>
      <p className="fw-fmf-facts">
        <Pill tone={flag.tone}>{t(flag.key)}</Pill>
        <span>{t(phrase.key, phrase.params)}</span>
        <span className="fw-fmg-muted">{t(basisKey(floor))}</span>
        {distance && <span className="fw-fmg-muted">{distance}</span>}
      </p>
      {floor.quotedBelow && <Banner tone="info" title={t('detail.quotedBelow')} />}
    </section>
  )
}
