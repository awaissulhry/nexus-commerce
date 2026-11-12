'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { marketsHref, NOT_SOLD_NAMESPACE, soldInWords, standingNoteKey, type MarketStanding } from '../not-sold'

/**
 * The cell pop-up's note on where the style is sold (B-W2b-288, FU2:02): a market it is not sold in asks nothing ("Not sold
 * there", not a gap); a style that names no market is asked everywhere. Both say where the markets are picked (the style's
 * Overview), when the person may open it.
 */
export function NotSoldNote({ standing, styleId, marketCodes, market, prefix, stylesView, built, name }: { standing: MarketStanding; styleId: string; marketCodes: readonly string[]; market: string; prefix: string; stylesView: boolean; built: ReadonlySet<string>; name: (code: string) => string }) {
  const w = useT(NOT_SOLD_NAMESPACE)
  const key = standingNoteKey(standing)
  if (!key) return null
  const href = marketsHref(styleId, prefix, stylesView, built)
  const soldIn = soldInWords(marketCodes, name)
  const words = w(key, { market, markets: soldIn ?? '—' })
  if (standing === 'NOT_SOLD_THERE') {
    return (
      <Banner tone="info" title={w('notSold.cell.title', { market })}>
        <p className="fw-cs-hint">{words}</p>
        {href ? (
          <Link className="fw-cs-link" href={href}>
            {w('notSold.cell.change')}
          </Link>
        ) : (
          <span className="fw-cs-muted">{w('notSold.cell.changeHeld')}</span>
        )}
      </Banner>
    )
  }
  return (
    <p className="fw-cs-hint">
      {words}{' '}
      {href ? (
        <Link className="fw-cs-link" href={href}>
          {w('notSold.cell.change')}
        </Link>
      ) : null}
    </p>
  )
}
