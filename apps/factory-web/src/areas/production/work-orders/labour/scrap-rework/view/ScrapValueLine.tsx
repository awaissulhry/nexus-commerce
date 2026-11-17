'use client'

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { moneyText } from '../../../../../finance/costing/model'
import { scrapValueOf, type ScrapReworkModel } from '../model'

/**
 * F-PR-06 (06-tree A.4 Tab 6, O-WO-lab) — Labour & cost's ONE scrap line: the value of what was scrapped and reworked on the work
 * order (B-W2b-411's totals: garments scrapped at an operation or in a rework, material scrapped from stock, rework at its
 * standard minutes), inside the cost section with its grain, and the door to Quality — the work order's one scrap home, where
 * the scrap and its reasons are. Not known when a rework has no cost per minute in force (never 0). Never per person.
 */
export function ScrapValueLine({ model, qualityHref, onRetry }: { model: ScrapReworkModel; qualityHref: string; onRetry?: () => void }) {
  const t = useT('production')
  const locale = useLocale()
  const value = scrapValueOf(model)
  return (
    <Card padded className="fw-fco-card">
      <div className="fw-fco-section-head">
        <span className="fw-pr-inline">
          <b>{t('scrapValue.title')}</b>
          {value.state === 'loading' ? (
            <span className="fw-fco-muted" role="status">
              <Spinner size={12} /> {t('scrapValue.loading')}
            </span>
          ) : value.state === 'failed' ? (
            <>
              <span className="fw-fco-muted">{t('scrapValue.failed')}</span>
              <Button size="sm" onClick={() => onRetry?.()}>
                {t('common.retry')}
              </Button>
            </>
          ) : value.state === 'none' ? (
            <span className="fw-fco-muted">{t('scrapValue.none')}</span>
          ) : value.state === 'unknown' ? (
            <span className="fw-fco-muted">{t('scrapValue.unknown')}</span>
          ) : (
            <span>{moneyText(value.amount, value.currency, locale)}</span>
          )}
        </span>
        <Link className="fw-fco-link" href={qualityHref}>
          {t('scrapValue.toQuality')} <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
    </Card>
  )
}
