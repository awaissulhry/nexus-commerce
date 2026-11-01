'use client'

import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { MARGINS_NAMESPACE, orderProfitabilityHref } from '../../../../../finance/margins/model'
import { MarginLines, MarginMeter, MarginStrip, Waterfall } from '../../../../../finance/margins/view/parts'
import type { MarginTabModel } from '../model'

/**
 * Margin (design sales.orders rec:"Sales order" order.margin, read-only): Margin, quoted → now (MetricStrip + MarginMeter:
 * quoted %, current estimate %, actual so far %, the difference € in tone with the cost grain), Where the margin went
 * (Waterfall: quoted margin → each part's difference → current margin; a step opens Finance › Standard vs actual; needs
 * the cost grain too) and By line (line, net, cost estimate, cost actual, margin %; each column by its grain). The rest of
 * the order stays usable when the read fails (Try again). Without costing.view or the margin grain it says why.
 */
export function MarginTab({ margin, prefix, orderId, onRetry }: { margin: MarginTabModel | undefined; prefix: string; orderId: string; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[MARGINS_NAMESPACE]}>
      <Margin margin={margin} prefix={prefix} orderId={orderId} onRetry={onRetry} />
    </WithMessages>
  )
}

function Margin({ margin, prefix, orderId, onRetry }: { margin: MarginTabModel | undefined; prefix: string; orderId: string; onRetry?: () => void }) {
  const t = useT(MARGINS_NAMESPACE)
  const can = margin?.can
  if (!can?.view) {
    return (
      <Card padded>
        <EmptyState title={t('marginTab.noView.title')} description={t('marginTab.noView.body')} />
      </Card>
    )
  }
  if (!can.margin) {
    return (
      <Card padded>
        <EmptyState title={t('marginTab.noGrain.title')} description={t('marginTab.noGrain.body')} />
      </Card>
    )
  }
  const part = margin?.part ?? null
  if (!part || (!part.value && !part.problem)) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-fmg-muted" role="status">
          <Spinner size={14} /> {t('marginTab.loading')}
        </p>
      </Card>
    )
  }
  if (!part.value) {
    return (
      <Card padded>
        <EmptyState
          title={t('marginTab.failed')}
          description={t(part.problem ?? 'problem.internal')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const detail = part.value
  return (
    <div className="fw-fmg-detail">
      <Card padded className="fw-fmg-card">
        <div className="fw-fmg-section-head">
          <h2 className="fw-fmg-h2">{t('marginTab.title')}</h2>
          <Link className="fw-fmg-link" href={orderProfitabilityHref(prefix, orderId)}>
            {t('marginTab.inFinance')}
          </Link>
        </div>
        <MarginStrip detail={detail} can={can} />
        <MarginMeter quoted={detail.quotedMarginPct} now={detail.estimateMarginPct} allowed={can.margin} />
        <p className="fw-fmg-muted">{detail.provisional ? t('detail.provisional') : t('detail.method')}</p>
      </Card>
      <Card padded className="fw-fmg-card">
        <h3 className="fw-fmg-h3">{t('waterfall.title')}</h3>
        <Waterfall detail={detail} can={can} prefix={prefix} />
      </Card>
      <Card padded className="fw-fmg-card">
        <h3 className="fw-fmg-h3">{t('lines.title')}</h3>
        <MarginLines detail={detail} can={can} />
      </Card>
    </div>
  )
}
