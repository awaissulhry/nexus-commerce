'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, FlaskConical } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Pill, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { crViHref } from '../model'
import type { WarehouseSettingsActions, WarehouseSettingsModel } from '../view-model'
import { CardFailed, NS, SourceWords } from './parts'

/**
 * sec:ws-crvi — Cr VI evidence rule (design: a panel, read-only words + a link): which evidence counts for a leather lot's
 * hexavalent chromium — a report per lot, or a supplier report covering the article and period — as it is in force for this
 * company (or every company), and where it is changed: Compliance › Rules & markets. No second editor here.
 */
export function CrViPanel({ model, actions }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions }) {
  const t = useT(NS)
  const content = (): ReactNode => {
    if (!model.crVi) return <p className="fw-whs-held">{t('held.noCrViView')}</p>
    if (model.crVi.problem) return <CardFailed title={t('crvi.failed')} problem={model.crVi.problem} onRetry={actions?.onRetryCrVi} />
    if (!model.crVi.value) return <Skeleton height={72} />
    const rule = model.crVi.value
    return (
      <div className="fw-whs-inforce-row">
        <Pill tone="info">{t(`crvi.rule.${rule.crViEvidenceRule}`)}</Pill>
        <SourceWords source={rule.source} scope={model.address.scope} />
        {rule.source === 'DEFAULT' && <span className="fw-whs-sub">{t('crvi.isDefault')}</span>}
      </div>
    )
  }
  return (
    <Card header={t('crvi.title')} description={t('crvi.description')} headingLevel={2} className="fw-whs-card fw-whs-wide">
      <div className="fw-whs-panel">
        <FlaskConical size={18} aria-hidden className="fw-whs-panel-icon" />
        <div className="fw-whs-stack">
          {content()}
          <p className="fw-whs-hint">{t('crvi.why')}</p>
          <Link className="fw-whs-link" href={crViHref(model.prefix)}>
            {t('crvi.link')} <ExternalLink size={12} aria-hidden />
          </Link>
        </div>
      </div>
    </Card>
  )
}
